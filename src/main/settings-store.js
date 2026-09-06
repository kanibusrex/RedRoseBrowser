'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const { DEFAULT_SEARCH_ENGINE_ID } = require('../shared/search-engines');

const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

// `homePageUrl: null` means "the bundled SimpleHome page" (§8.10) — the
// same one thing controls both the Home button's destination and what a
// blank new tab opens to, matching how this app already conflates those
// two concepts (see DESIGN.md §8.10/§8.24) rather than the two separate
// settings some browsers offer.
const DEFAULTS = Object.freeze({
  searchEngine: DEFAULT_SEARCH_ENGINE_ID,
  homePageUrl: null,
  adBlockEnabled: true,
});

/**
 * General settings (§8.24) — search engine, home page, ad-block toggle
 * — scoped per profile like bookmarks/history/permissions, matching how
 * real browsers scope these per profile too. Same per-profile-JSON-file
 * convention; unlike those stores this is a flat key/value settings
 * object per profile, not a list, so `get`/`set` (not list/record/
 * remove) are the whole API.
 */
class SettingsStore {
  constructor() {
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — every profile just starts on the defaults */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
      fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — settings just won't survive a restart */
    }
  }

  // Always returns a complete object (every key present) — merges
  // whatever's actually stored (which may be empty, or missing a key
  // added in a later version) over DEFAULTS, so callers never need their
  // own fallback logic.
  get(profileId) {
    return { ...DEFAULTS, ...(this.byProfile[profileId] || {}) };
  }

  // Partial update — only the keys present in `partial` change.
  set(profileId, partial) {
    this.byProfile[profileId] = { ...this.get(profileId), ...partial };
    this._save();
    return this.get(profileId);
  }
}

module.exports = { SettingsStore, DEFAULTS };
