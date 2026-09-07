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
import { initFocusMode } from './components/FocusMode.js';
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
  checkUpdatesBtn: document.getElementById('settings-check-updates'),
});
initTheme({ onOpen: () => generalSettings.populate() });
initSidebarResize(document.getElementById('sidebar-resize-handle'));
const focusMode = initFocusMode({
  chromeRoot: document.getElementById('chrome-root'),
  toggleBtn: document.getElementById('btn-focus-mode'),
});

function isMac() {
  return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
}

document.getElementById('address-kbd').textContent = isMac() ? '⌘L' : 'Ctrl+L';

// Hidden title bar (§8.30) — which native window controls float over the
// content, and where, differs by platform (macOS's traffic lights sit
// top-left, over the rail; Windows/Linux's titleBarOverlay buttons sit
// top-right, over the toolbar), so styles.css needs to know which one to
// clear space for.
document.documentElement.classList.add(isMac() ? 'platform-mac' : 'platform-overlay-titlebar');

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
    // createGroup/setTabGroup used to live here too, but the tab context
    // menu that was their only caller calls window.browserAPI directly
    // now (§8.28 — it's a popover in its own separate webContents; see
    // src/renderer/popovers/tabMenu.js). renameGroup/deleteGroup are
    // still called from right here in TabStrip.js's own DOM (the group
    // header's rename-field commit and its ungroup button), so those two
    // stay.
    groupActions: {
      renameGroup: (groupId, name) => window.browserAPI.renameGroup(groupId, name),
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
// "Home" glyph. §8.28: the popover itself now fetches/subscribes to
// whatever it needs directly (its own separate webContents), so none of
// these trigger functions take injected callbacks or a snapshot to
// render anymore — see each one's own file.
createProfileSwitcher({ glyphBtn });

createBookmarksButton({ btn: document.getElementById('btn-bookmarks') });

createHistoryButton({ btn: document.getElementById('btn-history') });

const downloadsButton = createDownloadsButton({ btn: document.getElementById('btn-downloads') });

createExtensionsButton({ btn: document.getElementById('btn-extensions') });

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

window.browserAPI.onBookmarksChanged(({ bookmarks: list }) => {
  // Still needed here for AddressBar's autocomplete (getBookmarks) and
  // the star button's own pressed state below (renderAll) — §8.28 only
  // moved the *popover's* copy of this list into its own webContents
  // (src/renderer/popovers/bookmarks.js), not this one.
  bookmarks = list || [];
  renderAll();
});

window.browserAPI.onDownloadsChanged(({ downloads }) => {
  downloadsButton.render(downloads);
});

// ---- initial hydrate ----

window.browserAPI.getAllTabs().then(({ tabs, activeTabId, groups }) => {
  state = { tabs, activeTabId, groups: groups || [] };
  renderAll();
});

window.browserAPI.listBookmarks().then(({ bookmarks: list }) => {
  bookmarks = list || [];
  renderAll();
});

window.browserAPI.listDownloads().then(({ downloads }) => {
  downloadsButton.render(downloads);
});

// ---- keyboard shortcuts (§1) ----
// §8.32: moved to main (src/main/chrome-shortcuts.js), wired onto both
// the chrome window's own webContents and every tab's — a plain
// renderer-side keydown listener here only ever saw one of those two
// (whichever currently has OS input focus), which meant every one of
// these silently did nothing the instant the page itself had focus, not
// this document — the normal state for most of the time actually spent
// browsing. Cmd/Ctrl+T/+Shift+T/+W/+R/+[/+]/+Tab are now pure
// TabManager calls with nothing left to do here at all; these three
// still need this document's own DOM, so main pushes them here instead.

window.browserAPI.onShortcutFocusAddressBar(() => {
  // No-op unless focus mode currently has the toolbar hidden — brings
  // it into view first so this doesn't silently focus an invisible
  // field (§8.29).
  focusMode.peekForInteraction();
  addressBar.focus();
});

window.browserAPI.onShortcutOpenFindBar(() => {
  if (state.activeTabId) findBar.open(state.activeTabId);
});

window.browserAPI.onShortcutToggleFocusMode(() => {
  focusMode.toggle();
});
