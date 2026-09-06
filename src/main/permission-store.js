'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const PERMISSIONS_FILE = () => path.join(app.getPath('userData'), 'permissions.json');

/**
 * Remembered site-permission decisions (§8.16), scoped per profile and
 * per origin — "allow camera/mic for https://meet.example.com", "block
 * notifications from https://annoying-news-site.com", etc. Same
 * per-profile-keyed JSON file convention as BookmarkStore/SessionStore.
 *
 * Shape on disk: `{ [profileId]: { [origin]: { [permission]: 'allow' |
 * 'deny' } } }`. Only ever holds a decision for a permission that was
 * actually prompted for (§8.16's "promptable" tier) — permissions that
 * are always allowed or always denied by policy never reach this store
 * at all, so it can't grow unbounded with entries that were never a real
 * user choice.
 */
class PermissionStore {
  constructor() {
    this.byProfile = this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(PERMISSIONS_FILE(), 'utf8'));
      if (raw && typeof raw === 'object') return raw;
    } catch {
      /* first run, or unreadable — every site is un-decided, i.e. prompted fresh */
    }
    return {};
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(PERMISSIONS_FILE()), { recursive: true });
      fs.writeFileSync(PERMISSIONS_FILE(), JSON.stringify(this.byProfile, null, 2), 'utf8');
    } catch {
      /* non-fatal — the user would just get re-prompted next time */
    }
  }

  // Returns 'allow', 'deny', or null (no remembered decision — prompt).
  get(profileId, origin, permission) {
    const forOrigin = this.byProfile[profileId]?.[origin];
    return (forOrigin && forOrigin[permission]) || null;
  }

  set(profileId, origin, permission, decision) {
    if (decision !== 'allow' && decision !== 'deny') return;
    if (!this.byProfile[profileId]) this.byProfile[profileId] = {};
    if (!this.byProfile[profileId][origin]) this.byProfile[profileId][origin] = {};
    this.byProfile[profileId][origin][permission] = decision;
    this._save();
  }
}

module.exports = { PermissionStore };
