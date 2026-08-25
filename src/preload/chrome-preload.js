'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed preload scripts (webPreferences.sandbox: true) can only
// require() 'electron' and a small set of Node built-ins — arbitrary
// relative requires of local project files (e.g. '../shared/ipc-channels')
// fail silently at preload-load time, which then leaves window.browserAPI
// undefined and crashes the renderer. So the channel names are duplicated
// here inline (must be kept in sync with src/shared/ipc-channels.js, same
// pattern already used for url-utils.js in AddressBar.js) rather than
// imported.
const RENDERER_TO_MAIN = {
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
};

const MAIN_TO_RENDERER = {
  TABS_CHANGED: 'tabs:changed',
  TAB_UPDATED: 'tab:updated',
  TAB_LOAD_FAILED: 'tab:load-failed',
  PROFILES_CHANGED: 'profiles:changed',
  BOOKMARKS_CHANGED: 'bookmarks:changed',
  EXTENSIONS_CHANGED: 'extensions:changed',
};

// Allowlist of push-event channels the renderer is permitted to subscribe
// to. subscribe() wraps ipcRenderer.on so the renderer never receives a
// raw ipcRenderer reference and can't listen on arbitrary channels
// (§7.10, §4.3).
const SUBSCRIBABLE_CHANNELS = new Set(Object.values(MAIN_TO_RENDERER));

function subscribe(channel, callback) {
  if (!SUBSCRIBABLE_CHANNELS.has(channel)) {
    throw new Error(`Refusing to subscribe to unlisted channel: ${channel}`);
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('browserAPI', {
  createTab: (url) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_CREATE, { url }),
  closeTab: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_CLOSE, { tabId }),
  activateTab: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_ACTIVATE, { tabId }),
  navigate: (tabId, input) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_GO, { tabId, input }),
  goBack: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_BACK, { tabId }),
  goForward: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_FORWARD, { tabId }),
  reload: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_RELOAD, { tabId }),
  stop: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_STOP, { tabId }),
  goHome: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.NAV_HOME, { tabId }),
  getAllTabs: () => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_GET_ALL, {}),
  hideActiveView: () => ipcRenderer.invoke(RENDERER_TO_MAIN.CHROME_OVERLAY_OPEN),
  showActiveView: () => ipcRenderer.invoke(RENDERER_TO_MAIN.CHROME_OVERLAY_CLOSE),

  pinTab: (tabId, pinned) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_PIN, { tabId, pinned }),
  createGroup: (name, color, tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.GROUPS_CREATE, { name, color, tabId }),
  renameGroup: (groupId, name) => ipcRenderer.invoke(RENDERER_TO_MAIN.GROUPS_RENAME, { groupId, name }),
  setGroupColor: (groupId, color) => ipcRenderer.invoke(RENDERER_TO_MAIN.GROUPS_SET_COLOR, { groupId, color }),
  deleteGroup: (groupId) => ipcRenderer.invoke(RENDERER_TO_MAIN.GROUPS_DELETE, { groupId }),
  setTabGroup: (tabId, groupId) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_SET_GROUP, { tabId, groupId }),
  splitTabs: (tabId, otherTabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_SPLIT, { tabId, otherTabId }),
  unsplitTab: (tabId) => ipcRenderer.invoke(RENDERER_TO_MAIN.TABS_UNSPLIT, { tabId }),

  listProfiles: () => ipcRenderer.invoke(RENDERER_TO_MAIN.PROFILES_LIST),
  createProfile: (name, color) => ipcRenderer.invoke(RENDERER_TO_MAIN.PROFILES_CREATE, { name, color }),
  switchProfile: (profileId) => ipcRenderer.invoke(RENDERER_TO_MAIN.PROFILES_SWITCH, { profileId }),
  renameProfile: (profileId, name) => ipcRenderer.invoke(RENDERER_TO_MAIN.PROFILES_RENAME, { profileId, name }),
  deleteProfile: (profileId) => ipcRenderer.invoke(RENDERER_TO_MAIN.PROFILES_DELETE, { profileId }),

  listBookmarks: () => ipcRenderer.invoke(RENDERER_TO_MAIN.BOOKMARKS_LIST),
  toggleBookmark: (url, title, favicon) => ipcRenderer.invoke(RENDERER_TO_MAIN.BOOKMARKS_TOGGLE, { url, title, favicon }),
  removeBookmark: (id) => ipcRenderer.invoke(RENDERER_TO_MAIN.BOOKMARKS_REMOVE, { id }),

  listExtensions: () => ipcRenderer.invoke(RENDERER_TO_MAIN.EXTENSIONS_LIST),
  installExtension: (ref) => ipcRenderer.invoke(RENDERER_TO_MAIN.EXTENSIONS_INSTALL, { ref }),
  removeExtension: (id) => ipcRenderer.invoke(RENDERER_TO_MAIN.EXTENSIONS_REMOVE, { id }),
  setExtensionEnabled: (id, enabled) => ipcRenderer.invoke(RENDERER_TO_MAIN.EXTENSIONS_SET_ENABLED, { id, enabled }),
  openExtensionPage: (id, kind) => ipcRenderer.invoke(RENDERER_TO_MAIN.EXTENSIONS_OPEN_PAGE, { id, kind }),
  getSidebarWidth: () => ipcRenderer.invoke(RENDERER_TO_MAIN.SIDEBAR_GET_WIDTH),
  setSidebarWidth: (width) => ipcRenderer.invoke(RENDERER_TO_MAIN.SIDEBAR_SET_WIDTH, { width }),

  onTabsChanged: (cb) => subscribe(MAIN_TO_RENDERER.TABS_CHANGED, cb),
  onTabUpdated: (cb) => subscribe(MAIN_TO_RENDERER.TAB_UPDATED, cb),
  onTabLoadFailed: (cb) => subscribe(MAIN_TO_RENDERER.TAB_LOAD_FAILED, cb),
  onProfilesChanged: (cb) => subscribe(MAIN_TO_RENDERER.PROFILES_CHANGED, cb),
  onBookmarksChanged: (cb) => subscribe(MAIN_TO_RENDERER.BOOKMARKS_CHANGED, cb),
  onExtensionsChanged: (cb) => subscribe(MAIN_TO_RENDERER.EXTENSIONS_CHANGED, cb),
});
