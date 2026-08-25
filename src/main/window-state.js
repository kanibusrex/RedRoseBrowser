'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, screen } = require('electron');

const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 860;
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

function loadWindowState() {
  let stored = null;
  try {
    stored = JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    /* first run, or unreadable — fall back to defaults */
  }

  const width = clamp(numberOr(stored?.width, DEFAULT_WIDTH), MIN_WIDTH, Infinity);
  const height = clamp(numberOr(stored?.height, DEFAULT_HEIGHT), MIN_HEIGHT, Infinity);
  const isMaximized = !!stored?.isMaximized;
  // Distinct from isMaximized — on macOS the traffic-light green button
  // triggers native fullscreen (its own space, hidden menu bar/Dock),
  // which Electron tracks separately via isFullScreen()/setFullScreen(),
  // not the maximize()/isMaximized() pair used on Windows/Linux.
  const isFullScreen = !!stored?.isFullScreen;

  // Only trust a saved x/y if it would actually land on a currently
  // connected display — otherwise (an external monitor since unplugged,
  // a display arrangement that changed) let Electron center the window
  // on the primary display instead of restoring it off-screen.
  const hasPosition = typeof stored?.x === 'number' && typeof stored?.y === 'number';
  const bounds = { x: stored?.x, y: stored?.y, width, height };
  const usePosition = hasPosition && isVisibleOnSomeDisplay(bounds);

  return {
    width,
    height,
    x: usePosition ? bounds.x : undefined,
    y: usePosition ? bounds.y : undefined,
    isMaximized,
    isFullScreen,
  };
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function isVisibleOnSomeDisplay(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    // Require a reasonable chunk of the window (not just one pixel) to
    // overlap the display's work area.
    const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    return overlapX > 100 && overlapY > 100;
  });
}

/**
 * Persists this window's size/position/maximized state to disk (debounced
 * while the user is actively resizing/dragging, plus a final synchronous
 * save on close) so createChromeWindow can restore it on next launch.
 */
function trackWindowState(win) {
  let saveTimer = null;

  function save() {
    if (win.isDestroyed()) return;
    const isMaximized = win.isMaximized();
    const isFullScreen = win.isFullScreen();
    // getNormalBounds() gives the un-maximized/un-fullscreen size and
    // position even while maximized or fullscreen, so restoring out of
    // either state next launch has something sane to fall back to
    // instead of the full-display bounds.
    const bounds = win.getNormalBounds();
    const state = { ...bounds, isMaximized, isFullScreen };
    try {
      fs.mkdirSync(path.dirname(STATE_FILE()), { recursive: true });
      fs.writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2), 'utf8');
    } catch {
      /* non-fatal — window state just won't survive a restart */
    }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
  }

  win.on('resize', scheduleSave);
  win.on('move', scheduleSave);
  win.on('maximize', save);
  win.on('unmaximize', save);
  win.on('enter-full-screen', save);
  win.on('leave-full-screen', save);
  win.on('close', () => {
    clearTimeout(saveTimer);
    save();
  });
}

module.exports = { loadWindowState, trackWindowState };
