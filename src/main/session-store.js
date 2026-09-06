'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const SESSIONS_FILE = () => path.join(app.getPath('userData'), 'sessions.json');

/**
 * Persists each profile's open tabs/groups/pins/splits (§8.15 session
 * restore) so relaunching the app doesn't start from scratch — a
 * deliberate reversal of the original v1 design call to never persist
 * open tabs (see bookmark-store.js's own comment, and DESIGN.md §1), made
 * because users expect a browser to reopen where they left off.
 *
 * Same per-profile-keyed JSON file convention as BookmarkStore, kept as
 * its own file/class rather than folded into it since this is written far
 * more often (every tab change, debounced — see ProfileManager) than
 * bookmarks are, and the shape (a whole session snapshot, not a list of
 * independent records) is different enough to not share the add/remove
 * API BookmarkStore offers.
 *
 * The exact snapshot shape is produced by TabManager.getSessionSnapshot()
 * and consumed by TabManager.restoreSession() — this class only knows how
 * to get one in and out of a JSON file per profile; it doesn't interpret
 * the contents.
 */
class SessionStore {
  constructor() {
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — every profile just starts with one blank tab */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(SESSIONS_FILE()), { recursive: true });
      fs.writeFileSync(SESSIONS_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — session just won't survive a restart */
    }
  }

  // Returns null (rather than an empty/malformed record) for anything that
  // wouldn't actually give TabManager.restoreSession() a tab to seed with,
  // so callers can just do `const saved = store.get(id); if (saved) {...}`.
  get(profileId) {
    const entry = this.byProfile[profileId];
    return entry && Array.isArray(entry.tabs) && entry.tabs.length > 0 ? entry : null;
  }

  set(profileId, sessionSnapshot) {
    this.byProfile[profileId] = sessionSnapshot;
    this._save();
  }

  clear(profileId) {
    delete this.byProfile[profileId];
    this._save();
  }
}

module.exports = { SessionStore };
