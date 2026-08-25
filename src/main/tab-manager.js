'use strict';

const { BrowserView } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { pageViewWebPreferences, classifyNavigation } = require('./security');
const { resolveNavigationTarget, attachNavigationPolicy } = require('./navigation');

const ERROR_PAGE_PATH = path.join(__dirname, '..', 'renderer', 'error-page.html');

// Home page / new-tab page (DESIGN.md §8.10) — a bundled copy of
// SimpleHome (github.com — michael's own project), a single self-contained
// HTML file (no build step, no server). Loaded via loadFile like
// error-page.html, not through classifyNavigation — it's app-bundled
// content, not page- or user-supplied. HOME_PAGE_URL is the exact
// file:// URL loadFile() reports back through did-navigate, computed
// with pathToFileURL so spaces/special characters in the install path
// are percent-encoded the same way Electron encodes them — used to
// recognize "we're on the home page" statelessly (works after a
// reload or back/forward, unlike a one-shot flag).
const HOME_PAGE_PATH = path.join(__dirname, '..', 'renderer', 'home', 'index.html');
const HOME_PAGE_URL = pathToFileURL(HOME_PAGE_PATH).href;

// Layout constants — must match src/renderer/styles.css (rail width, tab
// panel width, topbar height) or the BrowserView will occlude/misalign
// under the chrome. Rail (app glyph/name/settings) and tab panel (open
// tabs) run full window height on the left, side by side; topbar (nav
// buttons + address/search bar) runs across the remaining width. See
// DESIGN.md §5. The rail is a fixed width; the tab panel is user-resizable
// (§8.11) — its width lives per-instance (`this.tabPanelWidth`, set via
// the constructor and `setTabPanelWidth`), not as a module constant.
const RAIL_W = 64;
const TOPBAR_H = 48;
// Progress bar height is always reserved in styles.css (not toggled), so it
// must be included here too or the BrowserView occludes it while loading.
const PROGRESS_H = 2;
const CHROME_TOP_H = TOPBAR_H + PROGRESS_H;

const NEW_TAB_URL = 'about:blank';

// Fixed palette for tab groups (independent of the active color theme, so
// group colors stay stable and distinguishable across every theme —
// matches the convention Chrome/Edge use for their own tab groups).
const DEFAULT_GROUP_COLOR = 'grey';
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

/**
 * Owns the ordered list of tabs, which one is active, each tab's nav
 * state, and this profile's tab groups. One instance per profile — see
 * ProfileManager, which owns a session partition per instance so each
 * profile's cookies/storage/cache stay fully isolated. The only place
 * that touches BrowserView APIs directly for page content. Source of
 * truth pushed to the chrome renderer via IPC by ipc-handlers.js (which
 * owns the callbacks passed in here).
 */
class TabManager {
  constructor(win, session, { onTabsChanged, onTabUpdated, onTabLoadFailed, onTabCreated, tabPanelWidth } = {}) {
    this.win = win;
    this.session = session;
    this.onTabsChanged = onTabsChanged || (() => {});
    this.onTabUpdated = onTabUpdated || (() => {});
    this.onTabLoadFailed = onTabLoadFailed || (() => {});
    // Fired after a tab's BrowserView/webContents exists but before any
    // navigation — lets ProfileManager register the tab with this
    // profile's ElectronChromeExtensions bridge (DESIGN.md §8.8) so
    // chrome.tabs/chrome.windows are aware of it from the start.
    this.onTabCreated = onTabCreated || (() => {});
    // The tab panel's current width (§8.11) — every profile shares one
    // visual sidebar, so ProfileManager is the source of truth and keeps
    // whichever TabManager is active in sync (setTabPanelWidth) on every
    // live resize and on profile switch.
    this.tabPanelWidth = tabPanelWidth ?? 200;

    /** @type {Map<string, { id: string, view: BrowserView, url: string, title: string, favicon: string|null, isLoading: boolean, canGoBack: boolean, canGoForward: boolean, pinned: boolean, groupId: string|null }>} */
    this.tabs = new Map();
    this.order = [];
    this.activeTabId = null;

    /** @type {Map<string, { id: string, name: string, color: string }>} */
    this.groups = new Map();

    this.win.on('resize', () => this.recomputeBounds());
  }

  // ---- public state snapshot -------------------------------------------------

  getAllTabsSnapshot() {
    return {
      tabs: this.order.map((id) => this._toTabState(this.tabs.get(id))),
      activeTabId: this.activeTabId,
      groups: Array.from(this.groups.values()),
    };
  }

  _toTabState(tab) {
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      favicon: tab.favicon,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      pinned: tab.pinned,
      groupId: tab.groupId,
      splitWithTabId: tab.splitWithTabId,
    };
  }

  _emitTabsChanged() {
    this.onTabsChanged(this.getAllTabsSnapshot());
  }

  _emitTabUpdated(tab) {
    this.onTabUpdated({ tab: this._toTabState(tab) });
  }

  // ---- tab lifecycle -----------------------------------------------------

  // `trusted: true` skips the scheme/malicious-host check (§7.8, §8.7)
  // — reserved for URLs this app's own main-process code constructed
  // itself (e.g. ProfileManager.openExtensionPage's chrome-extension://
  // URL, built from a manifest this app downloaded and verified, never
  // from page/user input). Every other caller — the address bar,
  // bookmarks, an extension's own chrome.tabs.create — stays checked.
  createTab(url, { trusted = false } = {}) {
    const id = crypto.randomUUID();
    const view = new BrowserView({ webPreferences: pageViewWebPreferences(this.session) });

    const tab = {
      id,
      view,
      url: url || NEW_TAB_URL,
      title: '',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      pinned: false,
      groupId: null,
      // Split view (§8.12) — bidirectional link to at most one other tab
      // in this same profile. Both tabs' BrowserViews show at once,
      // side by side, whenever either one is on screen.
      splitWithTabId: null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);

    this._wireWebContents(tab);
    this.onTabCreated(tab);

    if (url) {
      const target = resolveNavigationTarget(url);
      const verdict = trusted ? 'ok' : classifyNavigation(target);
      if (verdict === 'ok') {
        view.webContents.loadURL(target).catch(() => {});
      } else {
        this._showBlockedError(tab, target, verdict);
      }
    } else {
      // A new tab with no explicit url (the "+" button, Cmd+T) opens
      // the home page (§8.10) — never resolveNavigationTarget('about:blank')
      // navigated as a search, which is what an earlier version of
      // this did (isLikelyUrl doesn't recognize the schemeless "about:"
      // form, so it fell through to the search branch and ran a Google
      // search for the literal text "about:blank" on every new tab).
      view.webContents.loadFile(HOME_PAGE_PATH).catch(() => {});
    }

    this.activateTab(id);
    this._emitTabsChanged();
    return { tabId: id };
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const idx = this.order.indexOf(tabId);
    const wasActive = this.activeTabId === tabId;
    const partnerId = tab.splitWithTabId;

    // Detach via tab.splitWithTabId (still intact at this point) so a
    // split partner's view comes off screen too, not just this tab's —
    // recomputeBounds only ever fits whatever's *currently* attached,
    // so leaving the partner attached here would leave it sized for a
    // pane split that's about to stop existing.
    if (wasActive) this._detachViewsFor(tabId);

    if (partnerId) {
      const partner = this.tabs.get(partnerId);
      if (partner) partner.splitWithTabId = null;
    }

    this._destroyView(tab.view);

    this.tabs.delete(tabId);
    this.order.splice(idx, 1);
    this._pruneOrphanGroups();

    if (this.order.length === 0) {
      // A profile must never be left with zero tabs — with multiple
      // profiles sharing one window (see ProfileManager), the window
      // itself only closes via an explicit OS close/Quit, not by running
      // out of tabs in whichever profile happens to be active.
      this.activeTabId = null;
      this.createTab();
      return;
    }

    if (wasActive) {
      // Prefer the surviving half of a split pair over an arbitrary
      // neighbor — closing one pane and landing on the other one it was
      // just showing feels more natural than jumping elsewhere.
      const nextId = partnerId && this.tabs.has(partnerId) ? partnerId : this.order[Math.min(idx, this.order.length - 1)];
      this.activateTab(nextId);
    } else {
      this._emitTabsChanged();
    }
  }

  // Full teardown (e.g. profile deletion) — unlike closeTab(), does not
  // reseed a fresh blank tab once empty, since this instance is being
  // discarded entirely.
  destroyAll() {
    if (this.activeTabId) this._detachViewsFor(this.activeTabId);
    for (const tab of this.tabs.values()) this._destroyView(tab.view);
    this.tabs.clear();
    this.order = [];
    this.groups.clear();
    this.activeTabId = null;
  }

  // ---- pinning ---------------------------------------------------------

  setPinned(tabId, pinned) {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.pinned === pinned) return;
    tab.pinned = pinned;

    // Keep pinned tabs contiguous at the front of `order`, preserving
    // relative order within each of the pinned/unpinned groups, so the
    // renderer can trust `order` as the whole sort (pinned first).
    const idx = this.order.indexOf(tabId);
    this.order.splice(idx, 1);
    if (pinned) {
      let insertAt = 0;
      while (insertAt < this.order.length && this.tabs.get(this.order[insertAt]).pinned) insertAt++;
      this.order.splice(insertAt, 0, tabId);
    } else {
      this.order.push(tabId);
    }

    this._emitTabsChanged();
  }

  // ---- groups ------------------------------------------------------------

  createGroup(name, color) {
    const id = crypto.randomUUID();
    this.groups.set(id, { id, name: name || 'New Group', color: color || DEFAULT_GROUP_COLOR });
    return id;
  }

  renameGroup(groupId, name) {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.name = name || group.name;
    this._emitTabsChanged();
  }

  setGroupColor(groupId, color) {
    const group = this.groups.get(groupId);
    if (!group || !color) return;
    group.color = color;
    this._emitTabsChanged();
  }

  setTabGroup(tabId, groupId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (groupId && !this.groups.has(groupId)) return;
    const prevGroupId = tab.groupId;
    tab.groupId = groupId || null;
    if (prevGroupId && prevGroupId !== tab.groupId) this._pruneOrphanGroups();
    this._emitTabsChanged();
  }

  // Deleting a group only ungroups its tabs — it never closes them.
  deleteGroup(groupId) {
    if (!this.groups.has(groupId)) return;
    for (const tab of this.tabs.values()) {
      if (tab.groupId === groupId) tab.groupId = null;
    }
    this.groups.delete(groupId);
    this._emitTabsChanged();
  }

  // ---- lookups used by the extensions bridge (chrome.tabs.*) -------------

  getWebContents(tabId) {
    const tab = this.tabs.get(tabId);
    return tab ? tab.view.webContents : null;
  }

  getTabIdForWebContents(webContents) {
    for (const [id, tab] of this.tabs) {
      if (tab.view.webContents === webContents) return id;
    }
    return null;
  }

  _pruneOrphanGroups() {
    const used = new Set();
    for (const tab of this.tabs.values()) {
      if (tab.groupId) used.add(tab.groupId);
    }
    for (const groupId of this.groups.keys()) {
      if (!used.has(groupId)) this.groups.delete(groupId);
    }
  }

  // ---- split view (§8.12) — helpers shared by activate/hide/show/close ---

  // A tab's own view, plus its split partner's if it has one — the unit
  // that always gets attached/detached together, since both panes of a
  // split are on screen or neither is.
  _viewsForTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return [];
    const views = [tab.view];
    if (tab.splitWithTabId) {
      const partner = this.tabs.get(tab.splitWithTabId);
      if (partner) views.push(partner.view);
    }
    return views;
  }

  _detachViewsFor(tabId) {
    for (const view of this._viewsForTab(tabId)) {
      try {
        this.win.removeBrowserView(view);
      } catch {
        /* already detached */
      }
    }
  }

  _attachViewsFor(tabId) {
    for (const view of this._viewsForTab(tabId)) {
      this.win.addBrowserView(view);
    }
    const tab = this.tabs.get(tabId);
    if (tab) this.win.setTopBrowserView(tab.view);
  }

  activateTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    const prevId = this.activeTabId;
    const prevTab = prevId ? this.tabs.get(prevId) : null;
    // Clicking the *other* half of the split pair already on screen only
    // changes which tab the toolbar/address bar targets — both views are
    // already attached and correctly positioned, so there's nothing to
    // reattach or reposition (doing so anyway would visibly swap the
    // left/right panes for no reason every time you click between them).
    const alreadyShowing = prevTab && (prevId === tabId || prevTab.splitWithTabId === tabId);

    if (!alreadyShowing) {
      if (prevId) this._detachViewsFor(prevId);
      this.activeTabId = tabId;
      this._attachViewsFor(tabId);
      this.recomputeBounds();
    } else {
      this.activeTabId = tabId;
    }
    this._emitTabsChanged();
  }

  // BrowserViews always paint above the window's own web content, so any
  // in-chrome modal (e.g. the settings/theme picker) would be hidden behind
  // whatever page is loaded unless the active view is detached first.
  hideActiveView() {
    if (!this.activeTabId) return;
    this._detachViewsFor(this.activeTabId);
  }

  showActiveView() {
    if (!this.activeTabId) return;
    this._attachViewsFor(this.activeTabId);
    this.recomputeBounds();
  }

  // Called on every live drag of the resize handle (§8.11), so it must
  // stay cheap — just updates the number and repositions the current
  // BrowserView(s); ProfileManager owns clamping and persisting it.
  setTabPanelWidth(width) {
    this.tabPanelWidth = width;
    this.recomputeBounds();
  }

  // ---- split view (§8.12) — creating/breaking the pairing ---------------

  // Links two tabs into a split-view pair — closing or unsplitting
  // either side affects both. Replaces any pairing either tab already
  // had (one partner per tab in v1, no 3+ way splits).
  splitTabs(tabId, otherTabId) {
    if (tabId === otherTabId) return;
    const tab = this.tabs.get(tabId);
    const other = this.tabs.get(otherTabId);
    if (!tab || !other) return;

    this._unlinkSplit(tabId);
    this._unlinkSplit(otherTabId);
    tab.splitWithTabId = otherTabId;
    other.splitWithTabId = tabId;

    if (this.activeTabId === tabId || this.activeTabId === otherTabId) {
      this._attachViewsFor(this.activeTabId);
      this.recomputeBounds();
    }
    this._emitTabsChanged();
  }

  _unlinkSplit(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.splitWithTabId) return;
    const partner = this.tabs.get(tab.splitWithTabId);
    if (partner) partner.splitWithTabId = null;
    tab.splitWithTabId = null;
  }

  unsplitTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab || !tab.splitWithTabId) return;
    const wasShowing = this.activeTabId === tabId || this.activeTabId === tab.splitWithTabId;
    this._unlinkSplit(tabId);
    if (wasShowing) {
      this._attachViewsFor(this.activeTabId);
      this.recomputeBounds();
    }
    this._emitTabsChanged();
  }

  recomputeBounds() {
    if (!this.activeTabId) return;
    const tab = this.tabs.get(this.activeTabId);
    if (!tab) return;
    const sidebarW = RAIL_W + this.tabPanelWidth;
    const [winWidth, winHeight] = this.win.getContentSize();
    const contentX = sidebarW;
    const contentY = CHROME_TOP_H;
    const contentW = Math.max(0, winWidth - sidebarW);
    const contentH = Math.max(0, winHeight - CHROME_TOP_H);

    const partner = tab.splitWithTabId ? this.tabs.get(tab.splitWithTabId) : null;
    if (!partner) {
      tab.view.setBounds({ x: contentX, y: contentY, width: contentW, height: contentH });
      return;
    }

    // Stable left/right by tab-strip order (not by which of the two is
    // currently toolbar-focused) so clicking between a pair's two rows
    // never visually swaps their panes.
    const [leftTab, rightTab] =
      this.order.indexOf(tab.id) < this.order.indexOf(partner.id) ? [tab, partner] : [partner, tab];

    const divider = 4;
    const leftW = Math.max(0, Math.floor((contentW - divider) / 2));
    const rightW = Math.max(0, contentW - leftW - divider);
    leftTab.view.setBounds({ x: contentX, y: contentY, width: leftW, height: contentH });
    rightTab.view.setBounds({ x: contentX + leftW + divider, y: contentY, width: rightW, height: contentH });
  }

  _destroyView(view) {
    try {
      if (!view.webContents.isDestroyed()) {
        // waitForBeforeUnload: false — pages loaded here are untrusted and
        // must not be able to block tab close via a beforeunload handler.
        view.webContents.close({ waitForBeforeUnload: false });
      }
    } catch {
      /* best-effort */
    }
  }

  // ---- navigation ----------------------------------------------------------

  navigate(tabId, input) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const target = resolveNavigationTarget(input);
    const verdict = classifyNavigation(target);
    if (verdict !== 'ok') {
      this._showBlockedError(tab, target, verdict);
      return;
    }
    tab.view.webContents.loadURL(target).catch(() => {});
  }

  // The toolbar Home button (§8.10) — navigates the current tab to the
  // home page, same content a blank new tab opens with.
  goHome(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.webContents.loadFile(HOME_PAGE_PATH).catch(() => {});
  }

  // A blocked navigation — a disallowed scheme (§7.8 — file:, chrome:,
  // javascript:, ...) or a known-malicious host (§8.7's local blocklist)
  // — used to be silently dropped, which reads as "the browser is broken"
  // rather than "this was blocked for your safety". Show the same error
  // page did-fail-load uses, with wording matched to which it was.
  _showBlockedError(tab, target, reason) {
    tab.isLoading = false;
    tab._pendingErrorUrl = target;
    const desc =
      reason === 'malicious'
        ? 'This site is on a known malware/phishing list and was blocked.'
        : 'This address was blocked for your safety.';
    tab.view.webContents
      .loadFile(ERROR_PAGE_PATH, {
        query: { url: target, code: reason === 'malicious' ? '-2' : '0', desc },
      })
      .catch(() => {});
  }

  goBack(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const wc = tab.view.webContents;
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    } else if (wc.canGoBack()) {
      wc.goBack();
    }
  }

  goForward(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const wc = tab.view.webContents;
    if (wc.navigationHistory && typeof wc.navigationHistory.canGoForward === 'function') {
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    } else if (wc.canGoForward()) {
      wc.goForward();
    }
  }

  reload(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.webContents.reload();
  }

  stop(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.webContents.stop();
  }

  // keyboard-shortcut helpers used by menu.js accelerators, operating on
  // whatever the currently active tab is.
  activateNextTab() {
    if (this.order.length < 2 || !this.activeTabId) return;
    const idx = this.order.indexOf(this.activeTabId);
    const next = this.order[(idx + 1) % this.order.length];
    this.activateTab(next);
  }

  // ---- webContents event wiring --------------------------------------------

  _wireWebContents(tab) {
    const wc = tab.view.webContents;

    attachNavigationPolicy(wc, {
      onOpenNewTab: (url) => this.createTab(url),
      onBlocked: (url, reason) => this._showBlockedError(tab, url, reason),
    });

    const updateNavFlags = () => {
      if (wc.navigationHistory && typeof wc.navigationHistory.canGoBack === 'function') {
        tab.canGoBack = wc.navigationHistory.canGoBack();
        tab.canGoForward = wc.navigationHistory.canGoForward();
      } else {
        tab.canGoBack = wc.canGoBack();
        tab.canGoForward = wc.canGoForward();
      }
    };

    wc.on('did-start-loading', () => {
      tab.isLoading = true;
      this._emitTabUpdated(tab);
    });

    wc.on('did-stop-loading', () => {
      tab.isLoading = false;
      updateNavFlags();
      this._emitTabUpdated(tab);
    });

    wc.on('did-navigate', (_event, url) => {
      // If this navigation is us loading the local error page for a
      // failed/blocked load (see did-fail-load below), keep showing the
      // URL the user actually tried to visit — not error-page.html's own
      // file:// path — same as a real browser's address bar during an
      // error interstitial.
      if (tab._pendingErrorUrl && url.startsWith('file://') && url.includes('error-page.html')) {
        tab.url = tab._pendingErrorUrl;
        tab.title = this._hostnameFallback(tab._pendingErrorUrl) + ' — problem loading page';
        tab.favicon = null;
        tab._pendingErrorUrl = null;
        updateNavFlags();
        this._emitTabUpdated(tab);
        return;
      }

      // The home/new-tab page (§8.10) shows as a blank, URL-less state —
      // same as a real browser's New Tab Page — never its own local
      // file:// path. Checked by exact URL match (not a one-shot flag),
      // so this is correct after a reload or back/forward too.
      if (url === HOME_PAGE_URL) {
        tab.url = 'about:blank';
        tab.title = 'New Tab';
        tab.favicon = null;
        updateNavFlags();
        this._emitTabUpdated(tab);
        return;
      }

      tab.url = url;
      // Seed a hostname-based title immediately; page-title-updated will
      // override it once/if the page provides a real <title>.
      tab.title = this._hostnameFallback(url);
      tab.favicon = null;
      updateNavFlags();
      this._emitTabUpdated(tab);
    });

    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url;
      updateNavFlags();
      this._emitTabUpdated(tab);
    });

    wc.on('page-title-updated', (_event, title) => {
      tab.title = title || this._hostnameFallback(tab.url);
      this._emitTabUpdated(tab);
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = (favicons && favicons[0]) || null;
      this._emitTabUpdated(tab);
    });

    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3) return; // aborted by user (e.g. clicked stop/navigated away)
      tab.isLoading = false;
      this._emitTabUpdated(tab);
      this.onTabLoadFailed({ tabId: tab.id, errorCode, errorDescription, validatedURL });

      // Show a real error page instead of leaving a blank tab — matters
      // especially for certificate errors, where silence could read as
      // "the site is just down" rather than "this connection isn't safe".
      tab._pendingErrorUrl = validatedURL;
      wc.loadFile(ERROR_PAGE_PATH, {
        query: { url: validatedURL, code: String(errorCode), desc: errorDescription || '' },
      }).catch(() => {});
    });
  }

  _hostnameFallback(url) {
    try {
      return new URL(url).hostname || url;
    } catch {
      return url || '';
    }
  }
}

module.exports = { TabManager, RAIL_W, TOPBAR_H, CHROME_TOP_H };
