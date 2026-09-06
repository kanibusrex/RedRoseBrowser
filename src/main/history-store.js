'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const HISTORY_FILE = () => path.join(app.getPath('userData'), 'history.json');

// Capped so a long-lived profile's history.json can't grow unboundedly —
// oldest visits are trimmed once a profile exceeds this. Not an attempt to
// match a real browser's months-long retention; just a sane ceiling for a
// plain JSON file (see DESIGN.md §8.20).
const HISTORY_LIMIT_PER_PROFILE = 5000;
const SAVE_DEBOUNCE_MS = 800;

/**
 * Browsing history (§8.20), scoped per profile like bookmarks/sessions/
 * permissions, persisted to history.json. Unlike BookmarkStore (one
 * record per bookmarked URL, toggled on/off) this is append-only and
 * chronological — one entry per real page navigation, newest first, the
 * same "just a list of visits" model DESIGN.md §1 originally deferred.
 *
 * Writes are debounced (unlike bookmarks' immediate save) since a visit
 * is recorded on every real navigation — far more frequent than a
 * bookmark toggle — see `flush()` for the same "don't lose the last
 * debounce window on quit" concern §8.15's session store already has.
 */
class HistoryStore {
  constructor() {
    this.byProfile = this._load();
    this._saveTimer = null;
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — history just starts empty */
    }
    return {};
  }

  _saveNow() {
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE()), { recursive: true });
      fs.writeFileSync(HISTORY_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — history just won't survive a restart */
    }
  }

  _scheduleSave() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveNow(), SAVE_DEBOUNCE_MS);
  }

  /** Flushes a pending debounced save immediately — call before quitting. */
  flush() {
    clearTimeout(this._saveTimer);
    this._saveNow();
  }

  // Newest first (already the storage order — see record()). `query`
  // (optional) is a case-insensitive substring match against title OR
  // url; `limit` (optional) caps how many rows come back, for a popover
  // that doesn't want to render thousands of rows at once.
  list(profileId, { query, limit } = {}) {
    const entries = this.byProfile[profileId] || [];
    let results = entries;
    if (query && query.trim()) {
      const q = query.trim().toLowerCase();
      results = entries.filter((e) => e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q));
    }
    return typeof limit === 'number' ? results.slice(0, limit) : results;
  }

  record(profileId, { url, title, favicon }) {
    if (!this.byProfile[profileId]) this.byProfile[profileId] = [];
    const list = this.byProfile[profileId];
    list.unshift({
      id: crypto.randomUUID(),
      url,
      title: title || url,
      favicon: favicon || null,
      visitedAt: Date.now(),
    });
    if (list.length > HISTORY_LIMIT_PER_PROFILE) list.length = HISTORY_LIMIT_PER_PROFILE;
    this._scheduleSave();
  }

  removeEntry(profileId, id) {
    const list = this.byProfile[profileId] || [];
    this.byProfile[profileId] = list.filter((e) => e.id !== id);
    this._scheduleSave();
    return this.byProfile[profileId];
  }

  clear(profileId) {
    this.byProfile[profileId] = [];
    this._scheduleSave();
    return [];
  }
}

module.exports = { HistoryStore };
