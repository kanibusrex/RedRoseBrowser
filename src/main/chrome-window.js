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
    // Hidden title bar (§8.30) — no title text/bar, but native window
    // controls stay: traffic lights (macOS) float over the content at a
    // custom position nudged clear of the rail's own app-glyph button
    // (styles.css gives the rail extra top padding on macOS to match —
    // see index.js's platform-mac class); on Windows/Linux,
    // titleBarOverlay draws a custom-colored strip with system min/max/
    // close buttons instead, since macOS's "just show the native traffic
    // lights, no title bar" doesn't have an equivalent there. Colors
    // start matching the default theme and are kept in sync with
    // whatever theme is actually active by theme.js, via
    // TITLEBAR_OVERLAY_SET — main has no theme state of its own.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 18, y: 18 } }
      : { titleBarOverlay: { color: '#ffffff', symbolColor: '#1c2740', height: 48 } }),
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
