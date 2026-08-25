'use strict';

/**
 * Single source of truth for IPC channel names (see DESIGN.md §4).
 * Imported by both main (ipc-handlers.js) and the chrome preload script
 * so channel names can never drift out of sync, and so ipcMain only ever
 * registers this fixed, enumerable set of channels (no wildcards).
 */

// Renderer -> Main (ipcRenderer.invoke / ipcMain.handle)
const RENDERER_TO_MAIN = Object.freeze({
  TABS_CREATE: 'tabs:create',
  TABS_CLOSE: 'tabs:close',
  TABS_ACTIVATE: 'tabs:activate',
  NAV_GO: 'nav:go',
  NAV_BACK: 'nav:back',
  NAV_FORWARD: 'nav:forward',
  NAV_RELOAD: 'nav:reload',
  NAV_HOME: 'nav:home',
  NAV_STOP: 'nav:stop',
  TABS_GET_ALL: 'tabs:getAll',
  CHROME_OVERLAY_OPEN: 'chrome:overlay-open',
  CHROME_OVERLAY_CLOSE: 'chrome:overlay-close',
  TABS_PIN: 'tabs:pin',
  GROUPS_CREATE: 'groups:create',
  GROUPS_RENAME: 'groups:rename',
  GROUPS_SET_COLOR: 'groups:setColor',
  GROUPS_DELETE: 'groups:delete',
  TABS_SET_GROUP: 'tabs:setGroup',
  TABS_SPLIT: 'tabs:split',
  TABS_UNSPLIT: 'tabs:unsplit',
  PROFILES_LIST: 'profiles:list',
  PROFILES_CREATE: 'profiles:create',
  PROFILES_SWITCH: 'profiles:switch',
  PROFILES_RENAME: 'profiles:rename',
  PROFILES_DELETE: 'profiles:delete',
  BOOKMARKS_LIST: 'bookmarks:list',
  BOOKMARKS_TOGGLE: 'bookmarks:toggle',
  BOOKMARKS_REMOVE: 'bookmarks:remove',
  EXTENSIONS_LIST: 'extensions:list',
  EXTENSIONS_INSTALL: 'extensions:install',
  EXTENSIONS_REMOVE: 'extensions:remove',
  EXTENSIONS_SET_ENABLED: 'extensions:setEnabled',
  EXTENSIONS_OPEN_PAGE: 'extensions:openPage',
  SIDEBAR_GET_WIDTH: 'sidebar:getWidth',
  SIDEBAR_SET_WIDTH: 'sidebar:setWidth',
});

// Main -> Renderer (webContents.send / ipcRenderer.on)
const MAIN_TO_RENDERER = Object.freeze({
  TABS_CHANGED: 'tabs:changed',
  TAB_UPDATED: 'tab:updated',
  TAB_LOAD_FAILED: 'tab:load-failed',
  PROFILES_CHANGED: 'profiles:changed',
  BOOKMARKS_CHANGED: 'bookmarks:changed',
  EXTENSIONS_CHANGED: 'extensions:changed',
});

// Flat allowlist of every channel name the chrome preload/main may use.
const ALL_CHANNELS = Object.freeze([
  ...Object.values(RENDERER_TO_MAIN),
  ...Object.values(MAIN_TO_RENDERER),
]);

module.exports = { RENDERER_TO_MAIN, MAIN_TO_RENDERER, ALL_CHANNELS };
