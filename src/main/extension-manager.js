'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { parseExtensionRef, downloadCrx, extractZipFromCrx } = require('./crx-download');
const { safeUnzipBuffer } = require('./safe-unzip');

const REGISTRY_FILE = () => path.join(app.getPath('userData'), 'extensions.json');
const EXTENSIONS_DIR = () => path.join(app.getPath('userData'), 'extensions');

const BROWSER_NS_POLYFILL = fs.readFileSync(path.join(__dirname, 'browser-ns-polyfill.js'), 'utf8');

// Chromium's `browser.*` WebExtension-compat global only mirrors a
// SUBSET of `chrome.*` in Electron (confirmed empirically — see
// DESIGN.md §8.8.3): `browser.tabs`/`browser.runtime` exist,
// `browser.windows`/`browser.storage`/`browser.permissions`/
// `browser.contextMenus` don't. Extensions that reference a missing one
// (uBlock Origin Lite, 1Password's extension both do, at their very
// first line of background code) crash their entire background
// script before anything else runs. A `registerPreloadScript` for the
// session runs too early/in a separate realm to fix this (tried,
// doesn't work — see DESIGN.md §8.8.3) — the only place that reliably
// shares the extension's own JS realm at the right time is the
// extension's own entry file, so the fix is baked directly into the
// downloaded files on disk, once, at install time.
function _injectBrowserPolyfill(dir, manifest) {
  const bg = manifest && manifest.background;
  if (!bg) return;

  try {
    if (typeof bg.service_worker === 'string') {
      // MV3 — single entry file (ES module or classic script; the
      // polyfill IIFE is valid at the top of either).
      const file = path.join(dir, bg.service_worker);
      const content = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, BROWSER_NS_POLYFILL + '\n' + content, 'utf8');
    } else if (Array.isArray(bg.scripts) && bg.scripts.length > 0) {
      // MV2 — prepend to the first script; it runs before the rest.
      const file = path.join(dir, bg.scripts[0]);
      const content = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, BROWSER_NS_POLYFILL + '\n' + content, 'utf8');
    } else if (typeof bg.page === 'string') {
      // MV2 HTML background page — write the polyfill as its own file
      // and inject a <script> for it as the first thing in <head>.
      const polyfillFileName = '__browser_ns_polyfill.js';
      fs.writeFileSync(path.join(dir, polyfillFileName), BROWSER_NS_POLYFILL, 'utf8');
      const htmlFile = path.join(dir, bg.page);
      const html = fs.readFileSync(htmlFile, 'utf8');
      const tag = `<script src="${polyfillFileName}"></script>`;
      const patched = /<head[^>]*>/i.test(html)
        ? html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`)
        : tag + html;
      fs.writeFileSync(htmlFile, patched, 'utf8');
    }
  } catch (err) {
    // Best-effort — an extension with no background, or an unusual
    // background shape we didn't anticipate, just runs unpatched.
    console.warn('Could not inject browser-namespace polyfill:', err.message);
  }
}

/**
 * Installs and tracks Chrome extensions **per profile** (matching every
 * other piece of per-profile state — tabs, bookmarks, cookies), directly
 * from a Chrome Web Store URL/ID. See DESIGN.md §8.8 for the full
 * rationale and the real trade-offs of this approach (no publisher
 * signature verification, no review step, larger attack surface than
 * this app's otherwise-tight sandboxing).
 */
class ExtensionManager {
  constructor() {
    /** @type {Record<string, Array<{id: string, name: string, version: string, description: string, enabled: boolean}>>} */
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(REGISTRY_FILE()), { recursive: true });
      fs.writeFileSync(REGISTRY_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — extension list just won't survive a restart, though
         the unpacked files on disk and the profile's own knowledge of
         them would need a fresh install() to be re-registered */
    }
  }

  // Enriches each stored record with `popupUrl`/`optionsUrl` — computed
  // fresh from the manifest on disk each call (not persisted to
  // extensions.json) so it's always correct, including for extensions
  // installed before this existed. `record.id` (Electron's real loaded
  // id, not `sourceId`) is what a chrome-extension:// URL needs.
  list(profileId) {
    return (this.byProfile[profileId] || []).map((record) => {
      const ui = this._readUiPaths(profileId, record.sourceId);
      return {
        ...record,
        popupUrl: ui.popupPath ? `chrome-extension://${record.id}/${ui.popupPath}` : null,
        optionsUrl: ui.optionsPath ? `chrome-extension://${record.id}/${ui.optionsPath}` : null,
      };
    });
  }

  _readUiPaths(profileId, sourceId) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(this._extensionDir(profileId, sourceId), 'manifest.json'), 'utf8')
      );
      const popupPath = manifest.action?.default_popup || manifest.browser_action?.default_popup || null;
      const optionsPath = manifest.options_ui?.page || manifest.options_page || null;
      return { popupPath, optionsPath };
    } catch {
      return { popupPath: null, optionsPath: null };
    }
  }

  _extensionDir(profileId, extensionId) {
    return path.join(EXTENSIONS_DIR(), profileId, extensionId);
  }

  // Loads every enabled extension this profile has installed into its
  // session — called once when a profile's session/TabManager is first
  // created (see ProfileManager._ensureTabManager).
  async loadAllForProfile(profileSession, profileId) {
    for (const record of this.list(profileId)) {
      if (!record.enabled) continue;
      const dir = this._extensionDir(profileId, record.sourceId);
      try {
        await profileSession.extensions.loadExtension(dir, { allowFileAccess: false });
      } catch (err) {
        console.warn(`Failed to load extension ${record.sourceId} for profile ${profileId}:`, err.message);
      }
    }
  }

  async install(profileSession, profileId, ref) {
    const extensionId = parseExtensionRef(ref);

    if (this.list(profileId).some((e) => e.sourceId === extensionId)) {
      throw new Error('This extension is already installed for this profile.');
    }

    const crx = await downloadCrx(extensionId);
    const zip = extractZipFromCrx(crx);

    const dir = this._extensionDir(profileId, extensionId);
    fs.rmSync(dir, { recursive: true, force: true }); // clear any stale partial install
    await safeUnzipBuffer(zip, dir);

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error("This package doesn't look like a valid Chrome extension (no readable manifest.json).");
    }

    _injectBrowserPolyfill(dir, manifest);

    let loaded;
    try {
      loaded = await profileSession.extensions.loadExtension(dir, { allowFileAccess: false });
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error(`Electron couldn't load this extension: ${err.message}`);
    }

    // `loaded.id` is what Electron actually uses internally for this
    // session (session.extensions.removeExtension, etc.) and is what we
    // expose to the UI/IPC as the extension's id. It is NOT guaranteed to
    // equal `extensionId` (the Chrome-Web-Store id we downloaded by) —
    // Electron only reproduces the real Web Store id when the extension's
    // manifest.json embeds a signing `key` field; many extensions
    // (1Password's, confirmed empirically) don't have one, and get a
    // different, directory-derived id instead. `extensionId` is kept as
    // `sourceId` purely for our own bookkeeping (the directory it's
    // unpacked into, and install-time dedup) — never passed to
    // session.extensions.* calls.
    const record = {
      id: loaded.id,
      sourceId: extensionId,
      name: loaded.name || manifest.name || extensionId,
      version: manifest.version || '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      enabled: true,
    };

    const list = this.byProfile[profileId] || (this.byProfile[profileId] = []);
    list.push(record);
    this._save();
    return record;
  }

  remove(profileSession, profileId, extensionId) {
    const list = this.byProfile[profileId];
    if (!list) return this.list(profileId);
    const idx = list.findIndex((e) => e.id === extensionId);
    if (idx === -1) return this.list(profileId);
    const record = list[idx];

    try {
      profileSession.extensions.removeExtension(record.id);
    } catch {
      /* wasn't loaded (e.g. was already disabled) — fine */
    }
    list.splice(idx, 1);
    this._save();

    fs.rmSync(this._extensionDir(profileId, record.sourceId), { recursive: true, force: true });
    return this.list(profileId);
  }

  async setEnabled(profileSession, profileId, extensionId, enabled) {
    const record = (this.byProfile[profileId] || []).find((e) => e.id === extensionId);
    if (!record || record.enabled === enabled) return this.list(profileId);

    record.enabled = enabled;
    if (enabled) {
      try {
        const loaded = await profileSession.extensions.loadExtension(this._extensionDir(profileId, record.sourceId), {
          allowFileAccess: false,
        });
        record.id = loaded.id; // re-loading can, in principle, reassign the id
      } catch (err) {
        record.enabled = false;
        this._save();
        throw new Error(`Couldn't re-enable extension: ${err.message}`);
      }
    } else {
      try {
        profileSession.extensions.removeExtension(record.id);
      } catch {
        /* fine */
      }
    }
    this._save();
    return this.list(profileId);
  }
}

module.exports = { ExtensionManager };
