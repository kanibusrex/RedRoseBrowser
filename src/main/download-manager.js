'use strict';

const crypto = require('node:crypto');
const { shell } = require('electron');

/**
 * Downloads (§8.21) — a shelf/list on top of Electron's existing default
 * behavior, not a replacement for it. `session.on('will-download', ...)`
 * only lets this app *observe* a download already in progress; it never
 * calls `item.setSavePath()` itself, which is the one thing that would
 * suppress Electron's native Save-As dialog — so v1's "ask where to save
 * every time" behavior (DESIGN.md's original out-of-scope note) is
 * completely unchanged. This just tracks what happens next: progress,
 * the path the user chose, completion/failure — so it can be shown in a
 * list, cancelled mid-flight, reopened, or revealed in the file manager
 * later, none of which was possible before.
 *
 * One instance per profile session (installed in
 * ProfileManager._ensureTabManager, alongside AdBlocker/
 * PermissionManager), since downloads happen per-session the same way
 * permissions do. In-progress downloads live only in this module's own
 * `live` map — DownloadStore only ever receives a finished (completed,
 * cancelled, or interrupted) record.
 */
function installDownloadTracking(profileSession, { profileId, downloadStore, onDownloadsChanged }) {
  /** @type {Map<string, { item: Electron.DownloadItem, record: object }>} */
  const live = new Map();

  const emit = () => onDownloadsChanged({ downloads: list() });

  // Live (in-progress, this session) downloads first, newest first,
  // followed by past finished ones from disk — one flat list so the
  // renderer never has to reconcile two differently-shaped sources. A
  // download that just finished briefly exists in both until `live`
  // drops it (see the 'done' handler below); the id filter keeps it from
  // appearing twice in that window.
  function list() {
    const liveList = Array.from(live.values()).map((entry) => entry.record);
    const persisted = downloadStore.list(profileId);
    const liveIds = new Set(liveList.map((r) => r.id));
    return [...liveList, ...persisted.filter((r) => !liveIds.has(r.id))];
  }

  profileSession.on('will-download', (_event, item) => {
    const id = crypto.randomUUID();
    const record = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      savePath: null,
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      completedAt: null,
    };
    live.set(id, { item, record });
    emit();

    item.on('updated', (_e, state) => {
      // 'progressing' or 'interrupted' (e.g. network loss mid-download,
      // resumable in principle — resume isn't implemented in v1).
      record.state = state;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes();
      record.savePath = item.getSavePath() || record.savePath;
      emit();
    });

    item.once('done', (_e, state) => {
      record.state = state; // 'completed' | 'cancelled' | 'interrupted'
      record.receivedBytes = item.getReceivedBytes();
      record.savePath = item.getSavePath() || record.savePath;
      record.completedAt = Date.now();
      downloadStore.record(profileId, record);
      live.delete(id);
      emit();
    });
  });

  return {
    list,
    cancel(id) {
      const entry = live.get(id);
      if (entry) entry.item.cancel();
    },
    // Removing a still-live download cancels it (its 'done' handler
    // above persists the resulting 'cancelled' record and drops it from
    // `live` on its own) — there's no such thing as removing an active
    // download from the list without stopping it. A finished one is
    // just dropped from the store.
    remove(id) {
      const entry = live.get(id);
      if (entry) {
        entry.item.cancel();
      } else {
        downloadStore.removeEntry(profileId, id);
      }
      return list();
    },
    // Only clears finished downloads — never silently cancels an
    // in-progress one the user didn't ask to stop.
    clear() {
      downloadStore.clear(profileId);
      return list();
    },
    open(id) {
      const record = list().find((r) => r.id === id);
      if (record && record.savePath) shell.openPath(record.savePath);
    },
    showInFolder(id) {
      const record = list().find((r) => r.id === id);
      if (record && record.savePath) shell.showItemInFolder(record.savePath);
    },
  };
}

module.exports = { installDownloadTracking };
