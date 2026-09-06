'use strict';

import { createTabStrip } from './components/TabStrip.js';
import { createToolbar } from './components/Toolbar.js';
import { createAddressBar } from './components/AddressBar.js';
import { createProfileSwitcher } from './components/ProfileSwitcher.js';
import { createBookmarksButton } from './components/Bookmarks.js';
import { createHistoryButton } from './components/History.js';
import { createDownloadsButton } from './components/Downloads.js';
import { createExtensionsButton } from './components/Extensions.js';
import { initSidebarResize } from './components/SidebarResize.js';
import { initPermissionPrompts } from './components/PermissionPrompt.js';
import { createFindBar } from './components/FindBar.js';
import { initGeneralSettings } from './components/GeneralSettings.js';
import { initTheme } from './theme.js';

// This module runs in the chrome renderer: contextIsolation is on and
// nodeIntegration is off (DESIGN.md §2.2), so the ONLY way to reach main
// is window.browserAPI, exposed by src/preload/chrome-preload.js. No
// require('electron'), no Node APIs here.

const generalSettings = initGeneralSettings({
  searchEngineSelect: document.getElementById('settings-search-engine'),
  homePageInput: document.getElementById('settings-home-page'),
  adBlockCheckbox: document.getElementById('settings-adblock'),
});
initTheme({ onOpen: () => generalSettings.populate() });
initSidebarResize(document.getElementById('sidebar-resize-handle'));

function isMac() {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

document.getElementById('address-kbd').textContent = isMac() ? '⌘L' : 'Ctrl+L';

let state = { tabs: [], activeTabId: null, groups: [] };
let bookmarks = [];

const glyphBtn = document.getElementById('btnHome');
const starBtn = document.getElementById('btn-star');

function activeTab() {
  return state.tabs.find((t) => t.id === state.activeTabId) || null;
}

function isBookmarkableUrl(url) {
  return !!url && url !== 'about:blank';
}

function renderAll() {
  tabStrip.render(state);
  toolbar.render(activeTab());
  addressBar.render(activeTab());
  glyphBtn.classList.toggle('loading', !!activeTab()?.isLoading);

  const tab = activeTab();
  const bookmarkable = isBookmarkableUrl(tab?.url);
  starBtn.disabled = !bookmarkable;
  const isBookmarked = bookmarkable && bookmarks.some((b) => b.url === tab.url);
  starBtn.classList.toggle('active', isBookmarked);
  starBtn.setAttribute('aria-pressed', String(isBookmarked));
  starBtn.title = isBookmarked ? 'Remove bookmark' : 'Bookmark this page';
}

const tabStrip = createTabStrip(
  document.getElementById('tab-list'),
  {
    onActivate: (tabId) => window.browserAPI.activateTab(tabId),
    onClose: (tabId) => window.browserAPI.closeTab(tabId),
    onNewTab: () => window.browserAPI.createTab(),
    pinActions: {
      setPinned: (tabId, pinned) => window.browserAPI.pinTab(tabId, pinned),
    },
    groupActions: {
      createGroup: (tabId) => window.browserAPI.createGroup(undefined, undefined, tabId),
      setTabGroup: (tabId, groupId) => window.browserAPI.setTabGroup(tabId, groupId),
      renameGroup: (groupId, name) => window.browserAPI.renameGroup(groupId, name),
      setGroupColor: (groupId, color) => window.browserAPI.setGroupColor(groupId, color),
      deleteGroup: (groupId) => window.browserAPI.deleteGroup(groupId),
    },
    splitActions: {
      split: (tabId, otherTabId) => window.browserAPI.splitTabs(tabId, otherTabId),
      unsplit: (tabId) => window.browserAPI.unsplitTab(tabId),
    },
    reorderActions: {
      moveTab: (tabId, targetTabId, position) => window.browserAPI.moveTab(tabId, targetTabId, position),
    },
  }
);

const toolbar = createToolbar(
  {
    backBtn: document.getElementById('btn-back'),
    forwardBtn: document.getElementById('btn-forward'),
    reloadBtn: document.getElementById('btn-reload'),
    homeBtn: document.getElementById('btn-home'),
    progressBar: document.getElementById('progress-bar'),
  },
  {
    onBack: () => state.activeTabId && window.browserAPI.goBack(state.activeTabId),
    onForward: () => state.activeTabId && window.browserAPI.goForward(state.activeTabId),
    onReload: () => state.activeTabId && window.browserAPI.reload(state.activeTabId),
    onStop: () => state.activeTabId && window.browserAPI.stop(state.activeTabId),
    onHome: () => state.activeTabId && window.browserAPI.goHome(state.activeTabId),
  }
);

const addressBar = createAddressBar(
  {
    input: document.getElementById('address-bar'),
    securityIcon: document.getElementById('security-icon'),
    wrap: document.getElementById('address-bar-wrap'),
    clearBtn: document.getElementById('address-clear'),
    suggestionsContainer: document.getElementById('address-suggestions'),
  },
  {
    onNavigate: (value) => state.activeTabId && window.browserAPI.navigate(state.activeTabId, value),
    // Live accessor, not a snapshot — `bookmarks` is reassigned whenever
    // onBookmarksChanged fires (below), so this always reads whatever's
    // current.
    getBookmarks: () => bookmarks,
  }
);

// Site-permission prompts (§8.16) anchor at the same security icon the
// address bar's lock/info glyph lives in.
initPermissionPrompts({ securityIcon: document.getElementById('security-icon') });

const findBar = createFindBar({
  bar: document.getElementById('find-bar'),
  input: document.getElementById('find-input'),
  count: document.getElementById('find-count'),
  prevBtn: document.getElementById('find-prev'),
  nextBtn: document.getElementById('find-next'),
  closeBtn: document.getElementById('find-close'),
});
window.browserAPI.onFindResult((result) => findBar.onResult(result));

// The rail glyph doubles as the profile switcher entry point (click to
// open the switcher popover), same spot ScriptureDesk uses for its
// "Home" glyph.
const profileSwitcher = createProfileSwitcher(
  { glyphBtn },
  {
    onSwitch: (profileId) => window.browserAPI.switchProfile(profileId),
    onCreate: (name, color) => window.browserAPI.createProfile(name, color),
    onRename: (profileId, name) => window.browserAPI.renameProfile(profileId, name),
    onDelete: (profileId) => window.browserAPI.deleteProfile(profileId),
  }
);

const bookmarksButton = createBookmarksButton(
  { btn: document.getElementById('btn-bookmarks') },
  {
    onOpen: (url) => window.browserAPI.createTab(url),
    onRemove: (id) => window.browserAPI.removeBookmark(id),
  }
);

createHistoryButton(
  { btn: document.getElementById('btn-history') },
  {
    onQuery: (query) => window.browserAPI.listHistory(query).then(({ entries }) => entries),
    onRemove: (id) => window.browserAPI.removeHistoryEntry(id),
    onClear: () => window.browserAPI.clearHistory(),
  }
);

const downloadsButton = createDownloadsButton(
  { btn: document.getElementById('btn-downloads') },
  {
    onCancel: (id) => window.browserAPI.cancelDownload(id),
    onRemove: (id) => window.browserAPI.removeDownloadEntry(id),
    onClear: () => window.browserAPI.clearDownloads(),
    onOpen: (id) => window.browserAPI.openDownload(id),
    onShowInFolder: (id) => window.browserAPI.showDownloadInFolder(id),
  }
);

const extensionsButton = createExtensionsButton(
  { btn: document.getElementById('btn-extensions') },
  {
    onInstall: (ref) => window.browserAPI.installExtension(ref),
    onRemove: (id) => window.browserAPI.removeExtension(id),
    onSetEnabled: (id, enabled) => window.browserAPI.setExtensionEnabled(id, enabled),
    onOpenPage: (id, kind) => window.browserAPI.openExtensionPage(id, kind),
  }
);

starBtn.addEventListener('click', () => {
  const tab = activeTab();
  if (!tab || !isBookmarkableUrl(tab.url)) return;
  window.browserAPI.toggleBookmark(tab.url, tab.title, tab.favicon);
});

// ---- subscribe to main-pushed state (§4.2) ----

window.browserAPI.onTabsChanged(({ tabs, activeTabId, groups }) => {
  state = { tabs, activeTabId, groups: groups || [] };
  findBar.onActiveTabChanged(activeTabId);
  renderAll();
});

window.browserAPI.onTabUpdated(({ tab }) => {
  const idx = state.tabs.findIndex((t) => t.id === tab.id);
  if (idx === -1) return;
  const next = state.tabs.slice();
  next[idx] = tab;
  state = { ...state, tabs: next };
  renderAll();
});

window.browserAPI.onTabLoadFailed(({ tabId, errorDescription, validatedURL }) => {
  // v1: minimal inline indication — log only. A dedicated error page is a
  // v1.1 nicety; DESIGN.md just asks for "an inline error state".
  console.warn(`Tab ${tabId} failed to load ${validatedURL}: ${errorDescription}`);
});

window.browserAPI.onProfilesChanged((snapshot) => {
  profileSwitcher.render(snapshot);
});

window.browserAPI.onBookmarksChanged(({ bookmarks: list }) => {
  bookmarks = list || [];
  bookmarksButton.render(bookmarks);
  renderAll();
});

window.browserAPI.onExtensionsChanged(({ extensions }) => {
  extensionsButton.render(extensions);
});

window.browserAPI.onDownloadsChanged(({ downloads }) => {
  downloadsButton.render(downloads);
});

// ---- initial hydrate ----

window.browserAPI.getAllTabs().then(({ tabs, activeTabId, groups }) => {
  state = { tabs, activeTabId, groups: groups || [] };
  renderAll();
});

window.browserAPI.listProfiles().then((snapshot) => {
  profileSwitcher.render(snapshot);
});

window.browserAPI.listBookmarks().then(({ bookmarks: list }) => {
  bookmarks = list || [];
  bookmarksButton.render(bookmarks);
  renderAll();
});

window.browserAPI.listExtensions().then(({ extensions }) => {
  extensionsButton.render(extensions);
});

window.browserAPI.listDownloads().then(({ downloads }) => {
  downloadsButton.render(downloads);
});

// ---- keyboard shortcuts (§1) ----
// Handled here (not main-process accelerators) because these are pure UI
// chrome actions; browserAPI already provides everything they need.

window.addEventListener('keydown', (event) => {
  const mod = isMac() ? event.metaKey : event.ctrlKey;
  if (!mod) return;

  const key = event.key.toLowerCase();

  if (key === 't' && event.shiftKey) {
    event.preventDefault();
    window.browserAPI.reopenLastClosedTab();
  } else if (key === 't') {
    event.preventDefault();
    window.browserAPI.createTab();
  } else if (key === 'w') {
    event.preventDefault();
    if (state.activeTabId) window.browserAPI.closeTab(state.activeTabId);
  } else if (key === 'l') {
    event.preventDefault();
    addressBar.focus();
  } else if (key === 'f') {
    event.preventDefault();
    if (state.activeTabId) findBar.open(state.activeTabId);
  } else if (key === 'r') {
    event.preventDefault();
    if (state.activeTabId) window.browserAPI.reload(state.activeTabId);
  } else if (key === '[') {
    event.preventDefault();
    if (state.activeTabId) window.browserAPI.goBack(state.activeTabId);
  } else if (key === ']') {
    event.preventDefault();
    if (state.activeTabId) window.browserAPI.goForward(state.activeTabId);
  } else if (event.key === 'Tab') {
    event.preventDefault();
    if (state.tabs.length > 1 && state.activeTabId) {
      const idx = state.tabs.findIndex((t) => t.id === state.activeTabId);
      const next = state.tabs[(idx + 1) % state.tabs.length];
      window.browserAPI.activateTab(next.id);
    }
  }
});
