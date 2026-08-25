'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app } = require('electron');

const BOOKMARKS_FILE = () => path.join(app.getPath('userData'), 'bookmarks.json');

/**
 * Bookmarks, scoped per profile (see ProfileManager) and persisted to
 * bookmarks.json in app.getPath('userData') — unlike open tabs (which are
 * deliberately not persisted, see DESIGN.md §1), bookmarks are meant to
 * survive a restart, so they get their own small store independent of
 * TabManager.
 */
class BookmarkStore {
  constructor() {
    /** @type {Record<string, Array<{id: string, url: string, title: string, favicon: string|null}>>} */
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(BOOKMARKS_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — start empty */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(BOOKMARKS_FILE()), { recursive: true });
      fs.writeFileSync(BOOKMARKS_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — bookmarks just won't survive a restart */
    }
  }

  list(profileId) {
    return this.byProfile[profileId] || [];
  }

  isBookmarked(profileId, url) {
    return this.list(profileId).some((b) => b.url === url);
  }

  // Adds a bookmark for the given url, or removes it if one already
  // exists — matches the "star" toggle affordance in the address bar.
  toggle(profileId, { url, title, favicon }) {
    const list = this.byProfile[profileId] || (this.byProfile[profileId] = []);
    const idx = list.findIndex((b) => b.url === url);
    if (idx !== -1) {
      list.splice(idx, 1);
    } else {
      list.unshift({ id: crypto.randomUUID(), url, title: title || url, favicon: favicon || null });
    }
    this._save();
    return this.list(profileId);
  }

  remove(profileId, id) {
    const list = this.byProfile[profileId];
    if (!list) return this.list(profileId);
    const idx = list.findIndex((b) => b.id === id);
    if (idx !== -1) list.splice(idx, 1);
    this._save();
    return this.list(profileId);
  }
}

module.exports = { BookmarkStore };
