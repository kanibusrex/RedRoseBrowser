'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, session } = require('electron');

const { TabManager } = require('./tab-manager');
const { BookmarkStore } = require('./bookmark-store');
const { ExtensionManager } = require('./extension-manager');
const { createExtensionsBridge } = require('./chrome-extensions-bridge');
const { AdBlocker } = require('./ad-blocker');
const { installPermissionHandler } = require('./security');
const { loadSidebarWidth, saveSidebarWidth, clampTabPanelWidth } = require('./sidebar-state');

const PROFILES_FILE = () => path.join(app.getPath('userData'), 'profiles.json');

const DEFAULT_PROFILE_COLORS = ['#1E5FA8', '#16794D', '#7A3EA1', '#B23A63', '#0E7C86', '#B5761F'];

/**
 * Owns every profile (workspace) and, per profile, a TabManager whose
 * BrowserViews all share that profile's session partition — cookies,
 * storage, and cache stay fully isolated between profiles, same as real
 * browser profiles, just switched within one window instead of one
 * window per profile (a deliberate v1 scope call — see DESIGN.md §8).
 *
 * Only the active profile's TabManager ever has a BrowserView attached to
 * the window; switching profiles detaches the outgoing one and attaches
 * the incoming one. Background profiles keep their tabs (and BrowserViews)
 * alive in memory, just detached, so switching back is instant and
 * doesn't reload anything.
 */
class ProfileManager {
  constructor(
    win,
    { onTabsChanged, onTabUpdated, onTabLoadFailed, onProfilesChanged, onBookmarksChanged, onExtensionsChanged } = {}
  ) {
    this.win = win;
    this.onTabsChanged = onTabsChanged || (() => {});
    this.onTabUpdated = onTabUpdated || (() => {});
    this.onTabLoadFailed = onTabLoadFailed || (() => {});
    this.onProfilesChanged = onProfilesChanged || (() => {});
    this.onBookmarksChanged = onBookmarksChanged || (() => {});
    this.onExtensionsChanged = onExtensionsChanged || (() => {});

    /** @type {Map<string, { id: string, name: string, color: string }>} */
    this.profiles = new Map();
    /** @type {Map<string, TabManager>} */
    this.tabManagers = new Map();
    /** @type {Map<string, import('electron-chrome-extensions').ElectronChromeExtensions>} */
    this.extensionBridges = new Map();
    this.activeProfileId = null;
    this.bookmarkStore = new BookmarkStore();
    this.extensionManager = new ExtensionManager();
    this.adBlocker = new AdBlocker();
    // The tab panel's width (§8.11) is chrome-level layout shared by
    // every profile's sidebar, not per-profile state — one canonical
    // value here, kept in sync with whichever TabManager is currently
    // showing (see _ensureTabManager and switchProfile).
    this.tabPanelWidth = loadSidebarWidth();
    this._sidebarSaveTimer = null;

    this._loadProfiles();
  }

  // ---- persistence ---------------------------------------------------------

  _loadProfiles() {
    let stored = null;
    try {
      stored = JSON.parse(fs.readFileSync(PROFILES_FILE(), 'utf8'));
    } catch {
      /* first run, or unreadable — fall back to a fresh default profile */
    }

    if (stored && Array.isArray(stored.profiles) && stored.profiles.length > 0) {
      for (const p of stored.profiles) {
        if (p && typeof p.id === 'string' && typeof p.name === 'string') {
          this.profiles.set(p.id, { id: p.id, name: p.name, color: p.color || DEFAULT_PROFILE_COLORS[0] });
        }
      }
      this.activeProfileId =
        stored.activeProfileId && this.profiles.has(stored.activeProfileId)
          ? stored.activeProfileId
          : this.profiles.keys().next().value;
    }

    if (this.profiles.size === 0) {
      const id = crypto.randomUUID();
      this.profiles.set(id, { id, name: 'Person 1', color: DEFAULT_PROFILE_COLORS[0] });
      this.activeProfileId = id;
    }
  }

  _saveProfiles() {
    try {
      fs.mkdirSync(path.dirname(PROFILES_FILE()), { recursive: true });
      fs.writeFileSync(
        PROFILES_FILE(),
        JSON.stringify({ activeProfileId: this.activeProfileId, profiles: Array.from(this.profiles.values()) }, null, 2),
        'utf8'
      );
    } catch {
      /* non-fatal — profile list just won't survive a restart */
    }
  }

  // ---- public state snapshot -------------------------------------------------

  getProfilesSnapshot() {
    return {
      activeProfileId: this.activeProfileId,
      profiles: Array.from(this.profiles.values()).map((p) => ({ ...p, active: p.id === this.activeProfileId })),
    };
  }

  // ---- lifecycle -------------------------------------------------------------

  /** Creates (if needed) and returns the active profile's TabManager, seeding one blank tab the first time. */
  start() {
    return this._ensureTabManager(this.activeProfileId);
  }

  getActiveTabManager() {
    return this.tabManagers.get(this.activeProfileId) || this.start();
  }

  // Creates a profile's TabManager (with its own isolated session
  // partition) and seeds it with one blank tab, the first time that
  // profile is switched to. Every subsequent call just returns the
  // existing instance, so switching back to a profile is instant and
  // never reloads its tabs.
  _ensureTabManager(profileId) {
    let tm = this.tabManagers.get(profileId);
    if (tm) return tm;

    const partition = `persist:profile-${profileId}`;
    const profileSession = session.fromPartition(partition);
    installPermissionHandler(profileSession);
    this.adBlocker.enableForSession(profileSession);

    tm = new TabManager(this.win, profileSession, {
      tabPanelWidth: this.tabPanelWidth,
      onTabsChanged: (snapshot) => {
        if (profileId === this.activeProfileId) this.onTabsChanged(snapshot);
      },
      onTabUpdated: (payload) => {
        if (profileId === this.activeProfileId) this.onTabUpdated(payload);
      },
      onTabLoadFailed: (payload) => {
        if (profileId === this.activeProfileId) this.onTabLoadFailed(payload);
      },
      // Lazy lookup (not a closed-over reference) because the bridge
      // below is created after `tm`, but createTab() can fire before then
      // (the seed tab a few lines down) or after (chrome.tabs.create).
      onTabCreated: (tab) => {
        const bridge = this.extensionBridges.get(profileId);
        if (bridge) bridge.addTab(tab.view.webContents, this.win);
      },
    });
    this.tabManagers.set(profileId, tm);

    const bridge = createExtensionsBridge({ win: this.win, session: profileSession, tabManager: tm });
    this.extensionBridges.set(profileId, bridge);

    // The seed tab must exist and be registered with the bridge
    // (addTab, via onTabCreated above) BEFORE any extension loads —
    // otherwise an extension's background/service-worker script can
    // start with zero tabs known to chrome.tabs/chrome.windows and get
    // back `undefined` from calls like `chrome.tabs.get()` it makes
    // during its own startup, which some extensions don't handle
    // gracefully (crashes; found while debugging 1Password's extension
    // — see DESIGN.md §8.8.3).
    tm.createTab();

    // Fire-and-forget: extensions register content scripts/background
    // pages that apply to future navigations, so a tab created a beat
    // before this resolves isn't meaningfully exposed — not worth making
    // tab-manager creation (called synchronously all over this file)
    // async for.
    this.extensionManager.loadAllForProfile(profileSession, profileId).catch((err) => {
      console.warn(`Failed to load extensions for profile ${profileId}:`, err.message);
    });

    return tm;
  }

  switchProfile(profileId) {
    if (!this.profiles.has(profileId) || profileId === this.activeProfileId) return;

    const current = this.tabManagers.get(this.activeProfileId);
    if (current) current.hideActiveView();

    this.activeProfileId = profileId;
    const tm = this._ensureTabManager(profileId);
    // A resize while a different profile was active only updated that
    // profile's TabManager (setSidebarWidth) — this one may be stale.
    tm.tabPanelWidth = this.tabPanelWidth;
    tm.showActiveView();

    this._saveProfiles();
    this.onProfilesChanged(this.getProfilesSnapshot());
    this.onTabsChanged(this.getActiveTabManager().getAllTabsSnapshot());
    this.onBookmarksChanged({ bookmarks: this.getBookmarks() });
    this.onExtensionsChanged({ extensions: this.listExtensions() });
  }

  // ---- sidebar width (chrome-level, shared across every profile) --------

  getSidebarWidth() {
    return this.tabPanelWidth;
  }

  // Called continuously while the user drags the resize handle (§8.11),
  // so the live BrowserView reposition happens on every call but the
  // disk write is debounced — same 500ms-after-the-last-change pattern
  // as window-state.js, to avoid hammering disk during a drag.
  setSidebarWidth(width) {
    const clamped = clampTabPanelWidth(width);
    this.tabPanelWidth = clamped;
    const tm = this.tabManagers.get(this.activeProfileId);
    if (tm) tm.setTabPanelWidth(clamped);

    clearTimeout(this._sidebarSaveTimer);
    this._sidebarSaveTimer = setTimeout(() => saveSidebarWidth(clamped), 500);
    return clamped;
  }

  // ---- bookmarks (scoped to whichever profile is active right now) -------

  getBookmarks() {
    return this.bookmarkStore.list(this.activeProfileId);
  }

  toggleBookmark(bookmark) {
    const list = this.bookmarkStore.toggle(this.activeProfileId, bookmark);
    this.onBookmarksChanged({ bookmarks: list });
    return list;
  }

  removeBookmark(id) {
    const list = this.bookmarkStore.remove(this.activeProfileId, id);
    this.onBookmarksChanged({ bookmarks: list });
    return list;
  }

  // ---- extensions (scoped to whichever profile is active right now) ------

  listExtensions() {
    return this.extensionManager.list(this.activeProfileId);
  }

  async installExtension(ref) {
    const profileId = this.activeProfileId;
    const profileSession = this.getActiveTabManager().session;
    const record = await this.extensionManager.install(profileSession, profileId, ref);
    this.onExtensionsChanged({ extensions: this.extensionManager.list(profileId) });
    return record;
  }

  async removeExtensionById(extensionId) {
    const profileId = this.activeProfileId;
    const profileSession = this.getActiveTabManager().session;
    const list = this.extensionManager.remove(profileSession, profileId, extensionId);
    this.onExtensionsChanged({ extensions: list });
    return list;
  }

  async setExtensionEnabled(extensionId, enabled) {
    const profileId = this.activeProfileId;
    const profileSession = this.getActiveTabManager().session;
    const list = await this.extensionManager.setEnabled(profileSession, profileId, extensionId, enabled);
    this.onExtensionsChanged({ extensions: list });
    return list;
  }

  // The renderer can only ask to open "extension X's popup/options" —
  // never an arbitrary URL — so this is the one place that resolves
  // that request to an actual chrome-extension:// URL and is trusted
  // to open it. The URL itself comes from extensionManager.list(),
  // which computed it from the manifest this app downloaded and
  // installed, not from anything page- or user-supplied.
  openExtensionPage(extensionId, kind) {
    const record = this.extensionManager.list(this.activeProfileId).find((e) => e.id === extensionId);
    if (!record) throw new Error('Extension not found.');
    const url = kind === 'options' ? record.optionsUrl : record.popupUrl;
    if (!url) throw new Error(kind === 'options' ? "This extension doesn't have an options page." : "This extension doesn't have a popup.");
    this.getActiveTabManager().createTab(url, { trusted: true });
  }

  createProfile(name, color) {
    const id = crypto.randomUUID();
    const chosenColor = color || DEFAULT_PROFILE_COLORS[this.profiles.size % DEFAULT_PROFILE_COLORS.length];
    this.profiles.set(id, { id, name: (name || 'New Profile').trim() || 'New Profile', color: chosenColor });
    this._saveProfiles();
    this.switchProfile(id);
    return id;
  }

  renameProfile(profileId, name) {
    const p = this.profiles.get(profileId);
    if (!p || !name || !name.trim()) return;
    p.name = name.trim();
    this._saveProfiles();
    this.onProfilesChanged(this.getProfilesSnapshot());
  }

  // Profiles are workspaces, not accounts with data to nuke — deleting one
  // only drops it from the switcher and closes its tabs; it does not wipe
  // its session partition's cookies/storage on disk.
  deleteProfile(profileId) {
    if (!this.profiles.has(profileId) || this.profiles.size <= 1) return;

    const wasActive = profileId === this.activeProfileId;
    const tm = this.tabManagers.get(profileId);
    if (tm) {
      tm.destroyAll();
      this.tabManagers.delete(profileId);
    }
    this.profiles.delete(profileId);

    if (wasActive) {
      this.activeProfileId = this.profiles.keys().next().value;
      this._ensureTabManager(this.activeProfileId).showActiveView();
      this.onTabsChanged(this.getActiveTabManager().getAllTabsSnapshot());
      this.onBookmarksChanged({ bookmarks: this.getBookmarks() });
      this.onExtensionsChanged({ extensions: this.listExtensions() });
    }

    this._saveProfiles();
    this.onProfilesChanged(this.getProfilesSnapshot());
  }
}

module.exports = { ProfileManager };
