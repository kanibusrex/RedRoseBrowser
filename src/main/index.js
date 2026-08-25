'use strict';

const path = require('node:path');
const { app, session } = require('electron');

const { createChromeWindow } = require('./chrome-window');
const { ProfileManager } = require('./profile-manager');
const { registerIpcHandlers } = require('./ipc-handlers');
const { buildApplicationMenu, attachDevToolsShortcut } = require('./menu');
const { installPermissionHandler } = require('./security');

let chromeWin = null;
let profileManager = null;

function createAppWindow() {
  chromeWin = createChromeWindow();

  // Deny-by-default permission handler (§7.9) for the chrome window's own
  // (default) session. Each profile's BrowserViews get the same handler
  // installed on their own isolated session partition by ProfileManager.
  installPermissionHandler(session.defaultSession);

  profileManager = new ProfileManager(chromeWin);
  registerIpcHandlers(chromeWin, profileManager);
  attachDevToolsShortcut(chromeWin, profileManager);

  chromeWin.webContents.once('did-finish-load', () => {
    profileManager.start();
  });

  chromeWin.on('closed', () => {
    chromeWin = null;
    profileManager = null;
  });
}

app.whenReady().then(() => {
  // In a packaged build, macOS reads the Dock icon from the app bundle's
  // Info.plist (build/icon.icns via electron-builder) automatically. In
  // dev mode (`electron .`), there is no bundle, so the Dock would
  // otherwise show Electron's own default icon unless set explicitly.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  }

  buildApplicationMenu();
  createAppWindow();

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
