'use strict';

const { app, dialog, shell } = require('electron');
const https = require('node:https');

const REPO_OWNER = 'kanibusrex';
const REPO_NAME = 'RedRoseBrowser';
const RELEASES_PAGE_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // every 4 hours while running
const INITIAL_DELAY_MS = 10 * 1000; // let the window paint first

/**
 * Checks GitHub Releases for a newer published version and, on Windows,
 * downloads and installs it in place; on macOS, only offers to open the
 * download page. Never runs in a dev build (`!app.isPackaged`) — an
 * unpackaged checkout has no meaningful "current version" to compare
 * against a release tag, so every check there would be a false positive.
 *
 * The platform split exists because of this project's signing situation
 * (see README's Gatekeeper/SmartScreen caveat, and package.json's
 * `identity: null`): `electron-updater`'s macOS support is Squirrel.Mac,
 * which validates the *running* app's own code signature before it will
 * apply an update at all — an unsigned build fails that check outright,
 * every time, for every user. Rather than wire up a mechanism that can
 * only ever error out on mac, mac gets a lighter, homegrown check
 * instead: ask GitHub's API for the latest published release tag,
 * compare it to `app.getVersion()`, and if it's newer, offer to open the
 * Releases page — the same manual install flow the README already
 * documents. Windows' NSIS installer has no equivalent hard requirement
 * (it can silently re-run an unsigned installer; the only user-facing
 * cost is the same SmartScreen prompt a first-time manual download
 * already shows), so it gets the real thing via `electron-updater`.
 *
 * `checkForUpdates(...)` also does the GitHub-metadata legwork on mac and
 * is exported on its own so the "Check for Updates…" menu item (menu.js)
 * can trigger an explicit, user-visible check (including a "you're up to
 * date" reply) without waiting for the next background interval.
 */
function initAutoUpdater() {
  if (!app.isPackaged) return;

  if (process.platform === 'win32') {
    scheduleChecks(() => checkForUpdatesWindows({ silent: true }));
  } else if (process.platform === 'darwin') {
    scheduleChecks(() => checkForUpdatesMac({ silent: true }));
  }
  // Linux has no CI build target in v1 (see .github/workflows/build.yml)
  // — nothing to check for there yet.
}

function scheduleChecks(check) {
  setTimeout(check, INITIAL_DELAY_MS);
  setInterval(check, CHECK_INTERVAL_MS);
}

/** Manual, user-triggered check — always gives feedback, even "no update". */
function checkForUpdatesNow() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Update checks are disabled in a development build.',
    });
    return;
  }
  if (process.platform === 'win32') checkForUpdatesWindows({ silent: false });
  else if (process.platform === 'darwin') checkForUpdatesMac({ silent: false });
  else {
    dialog.showMessageBox({
      type: 'info',
      message: "There's no update check for this platform yet.",
    });
  }
}

// ---- Windows: real in-place auto-update via electron-updater -------------

let windowsUpdaterWired = false;

function checkForUpdatesWindows({ silent }) {
  const { autoUpdater } = require('electron-updater');

  if (!windowsUpdaterWired) {
    windowsUpdaterWired = true;
    // Never spend the user's bandwidth without asking first — the same
    // "confirm before something outward/hard-to-reverse" instinct this
    // whole project applies everywhere else (e.g. never auto-publishing
    // a GitHub release without an explicit yes).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    autoUpdater.on('update-available', (info) => {
      dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Download', 'Not Now'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update available',
          message: `RedRose Browser ${info.version} is available (you have ${app.getVersion()}).`,
          detail: 'Download it now? It will install the next time you restart the app.',
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.downloadUpdate().catch(() => {});
        });
    });

    autoUpdater.on('update-downloaded', () => {
      dialog
        .showMessageBox({
          type: 'info',
          buttons: ['Restart Now', 'Later'],
          defaultId: 0,
          cancelId: 1,
          title: 'Update ready',
          message: 'RedRose Browser has downloaded an update.',
          detail: 'Restart now to finish installing it, or it will install the next time you quit.',
        })
        .then(({ response }) => {
          if (response === 0) autoUpdater.quitAndInstall();
          else autoUpdater.autoInstallOnAppQuit = true;
        });
    });

    // A background check failing (offline, GitHub briefly down, rate
    // limited) is routine, not an error worth interrupting browsing for
    // — only surface it when the user explicitly asked (see the .catch
    // below).
    autoUpdater.on('error', (err) => {
      console.warn('Auto-update check failed:', err.message);
    });
  }

  autoUpdater
    .checkForUpdates()
    .then((result) => {
      if (silent) return;
      const latest = result && result.updateInfo && result.updateInfo.version;
      if (!latest || compareVersions(latest, app.getVersion()) <= 0) {
        dialog.showMessageBox({
          type: 'info',
          message: "You're up to date.",
          detail: `RedRose Browser ${app.getVersion()}`,
        });
      }
      // If it IS newer, the always-on 'update-available' listener above
      // already shows the download prompt — nothing more to do here.
    })
    .catch((err) => {
      console.warn('Auto-update check failed:', err.message);
      if (!silent) {
        dialog.showMessageBox({
          type: 'error',
          message: 'Could not check for updates.',
          detail: err.message,
        });
      }
    });
}

// ---- macOS: version-check only, never an in-place install ----------------

function checkForUpdatesMac({ silent }) {
  fetchLatestReleaseTag()
    .then((tag) => {
      const latest = tag ? tag.replace(/^v/, '') : null;
      const current = app.getVersion();

      if (latest && compareVersions(latest, current) > 0) {
        return dialog
          .showMessageBox({
            type: 'info',
            buttons: ['Open Releases Page', 'Not Now'],
            defaultId: 0,
            cancelId: 1,
            title: 'Update available',
            message: `RedRose Browser ${latest} is available (you have ${current}).`,
            detail: "This build isn't signed, so it can't install updates automatically — download the new version and replace the app manually.",
          })
          .then(({ response }) => {
            if (response === 0) shell.openExternal(RELEASES_PAGE_URL);
          });
      }

      if (!silent) {
        dialog.showMessageBox({
          type: 'info',
          message: "You're up to date.",
          detail: `RedRose Browser ${current}`,
        });
      }
    })
    .catch((err) => {
      console.warn('Update check failed:', err.message);
      if (!silent) {
        dialog.showMessageBox({
          type: 'error',
          message: 'Could not check for updates.',
          detail: err.message,
        });
      }
    });
}

// GitHub's API only returns a *published* (non-draft, non-prerelease)
// release from this endpoint — exactly the "the maintainer has actually
// finished reviewing and released this" signal this project's own
// draft-then-publish-by-hand workflow (see DESIGN.md / release process)
// is built around. Resolves to `null` (not an error) when there's no
// published release yet, or GitHub is briefly unreachable — either way,
// "nothing to report" rather than a scary dialog.
function fetchLatestReleaseTag() {
  return new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: `/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
        headers: { 'User-Agent': 'RedRose-Browser-Updater' },
        timeout: 10000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve(typeof parsed.tag_name === 'string' ? parsed.tag_name : null);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request to GitHub timed out')));
  });
}

// Plain x.y.z comparator — this project's releases are always simple
// numeric tags (v1.0.0, v1.0.1, ...), so a full semver implementation
// (pre-release/build metadata) isn't needed here.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

module.exports = { initAutoUpdater, checkForUpdatesNow };
