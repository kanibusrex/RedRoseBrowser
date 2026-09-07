'use strict';

const path = require('node:path');
const { app, session } = require('electron');

const { createChromeWindow } = require('./chrome-window');
const { ProfileManager } = require('./profile-manager');
const { PopoverManager } = require('./popover-manager');
const { registerIpcHandlers } = require('./ipc-handlers');
const { buildApplicationMenu, attachDevToolsShortcut } = require('./menu');
const { installPermissionHandler } = require('./security');
const { initAutoUpdater } = require('./updater');
const { attachChromeShortcuts } = require('./chrome-shortcuts');

let chromeWin = null;
let profileManager = null;
let popoverManager = null;

function createAppWindow() {
  chromeWin = createChromeWindow();

  // Deny-by-default permission handler (§7.9) for the chrome window's own
  // (default) session. Each profile's BrowserViews get the same handler
  // installed on their own isolated session partition by ProfileManager.
  installPermissionHandler(session.defaultSession);

  profileManager = new ProfileManager(chromeWin);
  // Chrome-level UI, not per-profile (§8.28) — one popover host for the
  // whole window, same as the tab panel's width.
  popoverManager = new PopoverManager(chromeWin);
  registerIpcHandlers(chromeWin, profileManager, popoverManager);
  attachDevToolsShortcut(chromeWin, profileManager);
  // §8.32 — same shortcuts each tab's own webContents gets wired for
  // (TabManager._wireWebContents), just for the chrome window's own
  // document; together these are what make Cmd/Ctrl+T, +W, +L, ... work
  // regardless of which one currently has focus.
  attachChromeShortcuts(chromeWin.webContents, chromeWin, () => profileManager.getActiveTabManager());

  // §8.40 — Windows/Linux deliver a mouse's back/forward buttons as a
  // window-level app command rather than as DOM mouse events, so they're
  // handled here instead of in a preload (macOS gets neither this event
  // nor any main-process equivalent, which is why the preload path exists
  // at all — the two are complements, not duplicates, and can't both fire
  // on the same platform).
  chromeWin.on('app-command', (event, command) => {
    if (command !== 'browser-backward' && command !== 'browser-forward') return;
    const tm = profileManager.getActiveTabManager();
    if (!tm || !tm.activeTabId) return;
    event.preventDefault();
    if (command === 'browser-backward') tm.goBack(tm.activeTabId);
    else tm.goForward(tm.activeTabId);
  });

  chromeWin.webContents.once('did-finish-load', () => {
    profileManager.start();
  });

  // 'close' (not 'closed') — webContents/TabManagers are still alive here,
  // so this is the last chance to flush any session-restore save (§8.15)
  // or history write (§8.20) still sitting in its own debounce timer.
  // Covers both a real Quit and (on macOS) just closing the window while
  // the app stays running, since either way this is the window that's
  // about to go away.
  chromeWin.on('close', () => {
    if (profileManager) {
      profileManager.flushSessionSaves();
      profileManager.flushHistory();
    }
  });

  chromeWin.on('closed', () => {
    chromeWin = null;
    profileManager = null;
    popoverManager = null;
  });
}

app.whenReady().then(() => {
  // In a packaged build, macOS reads the Dock icon from the app bundle's
  // Info.plist (build/icon.icns via electron-builder) automatically. In
  // dev mode (`electron .`), there is no bundle, so the Dock would
  // otherwise show Electron's own default icon unless set explicitly.
  // Packaged-only bug this must guard against: `build/icon.png` lives
  // inside app.asar once packaged, and dock.setIcon()'s underlying
  // native image loader can't read through the asar archive the way
  // Node's own fs can — it fails there every time.
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  }

  buildApplicationMenu();
  createAppWindow();
  initAutoUpdater();

  app.on('activate', () => {
    if (chromeWin === null) {
      createAppWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Extra belt-and-suspenders enforcement of §7.4/§7.8 at the app level:
// deny any attempt to attach a <webview> tag anywhere (we never use one,
// but this closes the door if something in a page tries to abuse it) and
// keep webSecurity from ever being disabled via a permission/preference.
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
});
