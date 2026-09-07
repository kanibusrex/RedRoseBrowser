'use strict';

const { clipboard } = require('electron');
const { MAIN_TO_RENDERER } = require('../shared/ipc-channels');

/**
 * Chrome-level keyboard shortcuts (§1: Cmd/Ctrl+T, +Shift+T, +W, +L, +F,
 * +Shift+F, +Shift+C, +R, +[ / +], +Tab) — reserved at the browser
 * level, the same way a real browser never lets a page's own JS
 * intercept Cmd+T or Cmd+L. These used to be handled purely in the
 * chrome renderer (index.js) via a plain `window.addEventListener
 * ('keydown', ...)`, which only ever sees a keydown while *that
 * specific document* has OS input focus — not while the active tab's
 * own page does, which is the normal
 * state for most of the time actually spent using the browser (found
 * the hard way — see DESIGN.md §8.32: reported as "Cmd+Shift+F is not
 * enabling focus mode", confirmed with a real webContents.sendInputEvent
 * rather than a synthetic DOM dispatch, which had masked this in every
 * earlier round of testing since it bypasses the native input pipeline
 * entirely).
 *
 * `before-input-event` fixes this the same way menu.js's own
 * attachDevToolsShortcut already relied on for F12/Cmd+Alt+I — but,
 * confirmed the same way, that event is *also* scoped to whichever
 * specific webContents it's attached to, not automatically window-wide.
 * So this has to be attached to *every* webContents that can ever hold
 * focus in the chrome window: the chrome window's own (index.js), and
 * every tab's, wired in one place — TabManager._wireWebContents, right
 * alongside its other per-tab event wiring — as each one is created.
 *
 * Actions that are pure TabManager operations run directly, right here,
 * no round trip; actions that need the chrome renderer's own DOM
 * (focusing the address bar, opening the find bar, focus mode's CSS
 * transition) are pushed to it over MAIN_TO_RENDERER instead, the same
 * as any other main-initiated event (e.g. the permission prompt).
 */
function isMac() {
  return process.platform === 'darwin';
}

/**
 * `getTabManager` is a live accessor, not a fixed reference — for the
 * chrome window's own webContents (wired once in index.js) it has to
 * resolve to *whichever* profile is active at the moment a shortcut
 * fires, since that can change over time. For a specific tab's own
 * webContents (wired once per tab in TabManager itself), the owning
 * TabManager never changes for that tab's lifetime, so callers there
 * just pass a trivial `() => this`.
 */
function attachChromeShortcuts(webContents, chromeWin, getTabManager) {
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const mod = isMac() ? input.meta : input.control;
    if (!mod) return;

    const key = input.key.toLowerCase();
    const tm = getTabManager();
    const notifyRenderer = (channel) => {
      if (!chromeWin.isDestroyed()) chromeWin.webContents.send(channel);
    };

    if (key === 't' && input.shift) {
      event.preventDefault();
      tm.reopenLastClosedTab();
    } else if (key === 't') {
      event.preventDefault();
      tm.createTab();
    } else if (key === 'w') {
      event.preventDefault();
      if (tm.activeTabId) tm.closeTab(tm.activeTabId);
    } else if (key === 'c' && input.shift) {
      // §8.36 — copies straight from here (no round trip needed to
      // decide *what* to copy, unlike +L/+F/+Shift+F above), then tells
      // the renderer anyway so the address bar's own copy button can
      // flash its "copied" feedback even when this fired from the
      // keyboard rather than a click on it.
      event.preventDefault();
      const tab = tm.tabs.get(tm.activeTabId);
      const url = tab && tab.url && tab.url !== 'about:blank' ? tab.url : null;
      if (url) {
        clipboard.writeText(url);
        notifyRenderer(MAIN_TO_RENDERER.SHORTCUT_COPY_URL);
      }
    } else if (key === 'l') {
      event.preventDefault();
      notifyRenderer(MAIN_TO_RENDERER.SHORTCUT_FOCUS_ADDRESS_BAR);
    } else if (key === 'f' && input.shift) {
      event.preventDefault();
      notifyRenderer(MAIN_TO_RENDERER.SHORTCUT_TOGGLE_FOCUS_MODE);
    } else if (key === 'f') {
      event.preventDefault();
      notifyRenderer(MAIN_TO_RENDERER.SHORTCUT_OPEN_FIND_BAR);
    } else if (key === 'r') {
      event.preventDefault();
      if (tm.activeTabId) tm.reload(tm.activeTabId);
    } else if (key === '[') {
      event.preventDefault();
      if (tm.activeTabId) tm.goBack(tm.activeTabId);
    } else if (key === ']') {
      event.preventDefault();
      if (tm.activeTabId) tm.goForward(tm.activeTabId);
    } else if (input.key === 'Tab') {
      // No separate +Shift+Tab case — matches the behavior this
      // replaces, which never special-cased it either.
      event.preventDefault();
      tm.activateNextTab();
    }
  });
}

module.exports = { attachChromeShortcuts };
