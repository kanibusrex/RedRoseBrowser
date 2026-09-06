'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const DOWNLOADS_FILE = () => path.join(app.getPath('userData'), 'downloads.json');

// Same rationale as HISTORY_LIMIT_PER_PROFILE — a sane ceiling for a
// plain JSON file, not an attempt to match a real download manager's
// retention.
const DOWNLOADS_LIMIT_PER_PROFILE = 500;

/**
 * Past downloads (§8.21), scoped per profile — one record per finished
 * (completed, cancelled, or interrupted) download, newest first. Only
 * ever holds *finished* downloads; an in-progress one lives entirely in
 * download-manager.js's own in-memory `live` map until it's done, at
 * which point it's handed here to persist. Same
 * per-profile-keyed-JSON-file convention as bookmarks/history/
 * permissions.
 */
class DownloadStore {
  constructor() {
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DOWNLOADS_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — downloads list just starts empty */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(DOWNLOADS_FILE()), { recursive: true });
      fs.writeFileSync(DOWNLOADS_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — the entry just won't survive a restart */
    }
  }

  list(profileId) {
    return this.byProfile[profileId] || [];
  }

  record(profileId, entry) {
    if (!this.byProfile[profileId]) this.byProfile[profileId] = [];
    const list = this.byProfile[profileId];
    list.unshift(entry);
    if (list.length > DOWNLOADS_LIMIT_PER_PROFILE) list.length = DOWNLOADS_LIMIT_PER_PROFILE;
    this._save();
  }

  removeEntry(profileId, id) {
    const list = this.byProfile[profileId] || [];
    this.byProfile[profileId] = list.filter((e) => e.id !== id);
    this._save();
    return this.byProfile[profileId];
  }

  clear(profileId) {
    this.byProfile[profileId] = [];
    this._save();
    return [];
  }
}

module.exports = { DownloadStore };
