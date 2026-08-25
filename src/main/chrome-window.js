'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');

const { chromeWindowWebPreferences } = require('./security');
const { loadWindowState, trackWindowState } = require('./window-state');

const CHROME_INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');

/**
 * Creates the single top-level "chrome" BrowserWindow that hosts the tab
 * strip + toolbar UI. Per DESIGN.md §7.11, this window's renderer content
 * is ALWAYS loaded from local disk via loadFile — never loadURL against a
 * remote origin — because it's the one place with browserAPI access.
 */
function createChromeWindow() {
  const state = loadWindowState();

  const win = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 720,
    minHeight: 480,
    // Matches the chrome UI's own default background (--mist in
    // styles.css) so there's no white/black flash before index.html paints,
    // same convention ScriptureDesk's shell uses with its own brand color.
    backgroundColor: '#eef1f6',
    title: 'RedRose Browser',
    icon: path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: chromeWindowWebPreferences(),
  });

  // Restore maximized/fullscreen state before the window is ever shown,
  // so there's no visible unmaximized-then-maximized flash. Fullscreen
  // (macOS's green-button state) and maximized are distinct and can't
  // both apply, so fullscreen wins if both were somehow set.
  if (state.isFullScreen) win.setFullScreen(true);
  else if (state.isMaximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  trackWindowState(win);

  win.loadFile(CHROME_INDEX_HTML);

  return win;
}

module.exports = { createChromeWindow, CHROME_INDEX_HTML };
