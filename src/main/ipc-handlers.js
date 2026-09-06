'use strict';

const { ipcMain } = require('electron');

const { RENDERER_TO_MAIN, MAIN_TO_RENDERER } = require('../shared/ipc-channels');
const { resolvePendingPermission } = require('./permission-manager');

/**
 * Registers ipcMain.handle listeners for exactly the channels enumerated
 * in DESIGN.md §4.1 — no wildcard/dynamic channel handling (§7.10) — and
 * wires ProfileManager's callbacks to push §4.2 events to the chrome
 * window. Tab/group operations are always dispatched to whichever
 * profile is currently active (`profileManager.getActiveTabManager()`)
 * since that can change between calls as the user switches profiles.
 */
function registerIpcHandlers(chromeWin, profileManager) {
  const send = (channel, payload) => {
    if (chromeWin.isDestroyed()) return;
    chromeWin.webContents.send(channel, payload);
  };

  profileManager.onTabsChanged = (snapshot) => send(MAIN_TO_RENDERER.TABS_CHANGED, snapshot);
  profileManager.onTabUpdated = (payload) => send(MAIN_TO_RENDERER.TAB_UPDATED, payload);
  profileManager.onTabLoadFailed = (payload) => send(MAIN_TO_RENDERER.TAB_LOAD_FAILED, payload);
  profileManager.onProfilesChanged = (snapshot) => send(MAIN_TO_RENDERER.PROFILES_CHANGED, snapshot);
  profileManager.onBookmarksChanged = (payload) => send(MAIN_TO_RENDERER.BOOKMARKS_CHANGED, payload);
  profileManager.onExtensionsChanged = (payload) => send(MAIN_TO_RENDERER.EXTENSIONS_CHANGED, payload);
  profileManager.onFindResult = (payload) => send(MAIN_TO_RENDERER.FIND_RESULT, payload);
  profileManager.onDownloadsChanged = (payload) => send(MAIN_TO_RENDERER.DOWNLOADS_CHANGED, payload);

  const activeTabs = () => profileManager.getActiveTabManager();

  ipcMain.handle(RENDERER_TO_MAIN.TABS_CREATE, (_event, { url } = {}) => {
    return activeTabs().createTab(url);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_CLOSE, (_event, { tabId } = {}) => {
    activeTabs().closeTab(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_ACTIVATE, (_event, { tabId } = {}) => {
    activeTabs().activateTab(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_GO, (_event, { tabId, input } = {}) => {
    activeTabs().navigate(tabId, input);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_BACK, (_event, { tabId } = {}) => {
    activeTabs().goBack(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_FORWARD, (_event, { tabId } = {}) => {
    activeTabs().goForward(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_RELOAD, (_event, { tabId } = {}) => {
    activeTabs().reload(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_STOP, (_event, { tabId } = {}) => {
    activeTabs().stop(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.NAV_HOME, (_event, { tabId } = {}) => {
    activeTabs().goHome(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_GET_ALL, () => {
    return activeTabs().getAllTabsSnapshot();
  });

  // Detach/reattach the active BrowserView around in-chrome modals (e.g.
  // the settings/theme picker), since a BrowserView always paints above
  // the chrome window's own content and would otherwise hide them.
  ipcMain.handle(RENDERER_TO_MAIN.CHROME_OVERLAY_OPEN, () => {
    activeTabs().hideActiveView();
  });

  ipcMain.handle(RENDERER_TO_MAIN.CHROME_OVERLAY_CLOSE, () => {
    activeTabs().showActiveView();
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_PIN, (_event, { tabId, pinned } = {}) => {
    activeTabs().setPinned(tabId, !!pinned);
  });

  ipcMain.handle(RENDERER_TO_MAIN.GROUPS_CREATE, (_event, { name, color, tabId } = {}) => {
    const groupId = activeTabs().createGroup(name, color);
    if (tabId) activeTabs().setTabGroup(tabId, groupId);
    return { groupId };
  });

  ipcMain.handle(RENDERER_TO_MAIN.GROUPS_RENAME, (_event, { groupId, name } = {}) => {
    activeTabs().renameGroup(groupId, name);
  });

  ipcMain.handle(RENDERER_TO_MAIN.GROUPS_SET_COLOR, (_event, { groupId, color } = {}) => {
    activeTabs().setGroupColor(groupId, color);
  });

  ipcMain.handle(RENDERER_TO_MAIN.GROUPS_DELETE, (_event, { groupId } = {}) => {
    activeTabs().deleteGroup(groupId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_SET_GROUP, (_event, { tabId, groupId } = {}) => {
    activeTabs().setTabGroup(tabId, groupId || null);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_SPLIT, (_event, { tabId, otherTabId } = {}) => {
    activeTabs().splitTabs(tabId, otherTabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_UNSPLIT, (_event, { tabId } = {}) => {
    activeTabs().unsplitTab(tabId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_MOVE, (_event, { tabId, targetTabId, position } = {}) => {
    activeTabs().moveTab(tabId, targetTabId, position);
  });

  ipcMain.handle(RENDERER_TO_MAIN.TABS_REOPEN_CLOSED, () => {
    activeTabs().reopenLastClosedTab();
  });

  ipcMain.handle(RENDERER_TO_MAIN.FIND_START, (_event, { tabId, text, options } = {}) => {
    activeTabs().startFind(tabId, text, options || {});
  });

  ipcMain.handle(RENDERER_TO_MAIN.FIND_STOP, (_event, { tabId, action } = {}) => {
    activeTabs().stopFind(tabId, action);
  });

  ipcMain.handle(RENDERER_TO_MAIN.HISTORY_LIST, (_event, { query } = {}) => {
    return { entries: profileManager.getHistory(query) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.HISTORY_REMOVE, (_event, { id } = {}) => {
    return { entries: profileManager.removeHistoryEntry(id) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.HISTORY_CLEAR, () => {
    return { entries: profileManager.clearHistory() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_LIST, () => {
    return { downloads: profileManager.getDownloads() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_CANCEL, (_event, { id } = {}) => {
    profileManager.cancelDownload(id);
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_REMOVE, (_event, { id } = {}) => {
    return { downloads: profileManager.removeDownloadEntry(id) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_CLEAR, () => {
    return { downloads: profileManager.clearDownloads() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_OPEN, (_event, { id } = {}) => {
    profileManager.openDownload(id);
  });

  ipcMain.handle(RENDERER_TO_MAIN.DOWNLOADS_SHOW_IN_FOLDER, (_event, { id } = {}) => {
    profileManager.showDownloadInFolder(id);
  });

  ipcMain.handle(RENDERER_TO_MAIN.SETTINGS_GET, () => {
    return profileManager.getGeneralSettings();
  });

  ipcMain.handle(RENDERER_TO_MAIN.SETTINGS_SET, (_event, partial = {}) => {
    return profileManager.updateGeneralSettings(partial);
  });

  ipcMain.handle(RENDERER_TO_MAIN.ADDRESS_SUGGEST_TOGGLE, (_event, { open } = {}) => {
    activeTabs().setAddressSuggestOpen(!!open);
  });

  ipcMain.handle(RENDERER_TO_MAIN.PROFILES_LIST, () => {
    return profileManager.getProfilesSnapshot();
  });

  ipcMain.handle(RENDERER_TO_MAIN.PROFILES_CREATE, (_event, { name, color } = {}) => {
    return { profileId: profileManager.createProfile(name, color) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.PROFILES_SWITCH, (_event, { profileId } = {}) => {
    profileManager.switchProfile(profileId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.PROFILES_RENAME, (_event, { profileId, name } = {}) => {
    profileManager.renameProfile(profileId, name);
  });

  ipcMain.handle(RENDERER_TO_MAIN.PROFILES_DELETE, (_event, { profileId } = {}) => {
    profileManager.deleteProfile(profileId);
  });

  ipcMain.handle(RENDERER_TO_MAIN.BOOKMARKS_LIST, () => {
    return { bookmarks: profileManager.getBookmarks() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.BOOKMARKS_TOGGLE, (_event, { url, title, favicon } = {}) => {
    return { bookmarks: profileManager.toggleBookmark({ url, title, favicon }) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.BOOKMARKS_REMOVE, (_event, { id } = {}) => {
    return { bookmarks: profileManager.removeBookmark(id) };
  });

  // Errors thrown here (bad URL, download/network failure, invalid
  // package, ...) reject the renderer's invoke() promise with the
  // message intact — the extensions UI shows it directly rather than
  // this needing its own {ok, error} envelope.
  ipcMain.handle(RENDERER_TO_MAIN.EXTENSIONS_LIST, () => {
    return { extensions: profileManager.listExtensions() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.EXTENSIONS_INSTALL, async (_event, { ref } = {}) => {
    const extension = await profileManager.installExtension(ref);
    return { extension };
  });

  ipcMain.handle(RENDERER_TO_MAIN.EXTENSIONS_REMOVE, async (_event, { id } = {}) => {
    return { extensions: await profileManager.removeExtensionById(id) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.EXTENSIONS_SET_ENABLED, async (_event, { id, enabled } = {}) => {
    return { extensions: await profileManager.setExtensionEnabled(id, !!enabled) };
  });

  ipcMain.handle(RENDERER_TO_MAIN.EXTENSIONS_OPEN_PAGE, (_event, { id, kind } = {}) => {
    profileManager.openExtensionPage(id, kind);
  });

  ipcMain.handle(RENDERER_TO_MAIN.SIDEBAR_GET_WIDTH, () => {
    return { width: profileManager.getSidebarWidth() };
  });

  ipcMain.handle(RENDERER_TO_MAIN.SIDEBAR_SET_WIDTH, (_event, { width } = {}) => {
    return { width: profileManager.setSidebarWidth(width) };
  });

  // The other half of the permission-prompt round trip PermissionManager
  // starts by pushing MAIN_TO_RENDERER.PERMISSION_REQUEST (§8.16) — not
  // dispatched through profileManager like everything else above, since
  // it doesn't act on tabs/bookmarks/etc., just resolves a specific
  // pending request by id.
  ipcMain.handle(RENDERER_TO_MAIN.PERMISSION_RESPOND, (_event, { requestId, allow, remember } = {}) => {
    resolvePendingPermission(requestId, { allow, remember });
  });
}

module.exports = { registerIpcHandlers };
