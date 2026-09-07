'use strict';

const { BrowserView } = require('electron');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { pageViewWebPreferences, classifyNavigation } = require('./security');
const { resolveNavigationTarget, attachNavigationPolicy } = require('./navigation');
const { showPageContextMenu } = require('./page-context-menu');
const { attachChromeShortcuts } = require('./chrome-shortcuts');

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
// Find-in-page bar (§8.19) height — must match --find-bar-h in styles.css.
// Unlike TOPBAR_H/PROGRESS_H this is only reserved while a find is active
// (see recomputeBounds/setFindBarOpen), not always-on.
const FIND_BAR_H = 44;
// Address bar autocomplete dropdown (§8.23) height — must match
// --address-suggest-h in styles.css. Fixed regardless of how many
// suggestions are actually showing (0-6), same simplicity trade-off
// FIND_BAR_H makes, to avoid a two-way renderer<->main height sync for
// something whose row count varies with every keystroke.
const ADDRESS_SUGGEST_H = 240;
// Focus mode (§8.29) — while active (and not currently "peeking"), the
// rail/sidebar/toolbar are hidden and the BrowserView fills almost the
// entire window. This one sliver at the very top is deliberately left
// unreserved even then: it's chrome-window DOM the renderer can still
// see mousemove events in, which is what lets hovering the top edge
// bring the chrome back temporarily (FocusMode.js) — if the BrowserView
// covered the *entire* window, there'd be nowhere left for that hover to
// even be detected.
const FOCUS_HOTZONE_H = 6;

const NEW_TAB_URL = 'about:blank';

// Fixed palette for tab groups (independent of the active color theme, so
// group colors stay stable and distinguishable across every theme —
// matches the convention Chrome/Edge use for their own tab groups).
const DEFAULT_GROUP_COLOR = 'grey';
const GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

// Recently-closed tabs (§8.18) — capped so a long session doesn't grow this
// unboundedly; more than this many "undo close" steps back is not a
// realistic use case.
const CLOSED_STACK_LIMIT = 20;

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
  constructor(
    win,
    session,
    {
      onTabsChanged,
      onTabUpdated,
      onTabLoadFailed,
      onTabCreated,
      onFindResult,
      onHistoryVisit,
      tabPanelWidth,
      focusMode,
      getSettings,
    } = {}
  ) {
    this.win = win;
    this.session = session;
    this.onTabsChanged = onTabsChanged || (() => {});
    this.onTabUpdated = onTabUpdated || (() => {});
    this.onTabLoadFailed = onTabLoadFailed || (() => {});
    // Live accessor (not a snapshot) for this profile's general settings
    // (§8.24 — search engine, home page) — ProfileManager owns the
    // actual SettingsStore and can change what this returns at any time
    // (the settings modal), so this is always read fresh, never cached.
    this.getSettings = getSettings || (() => ({ searchEngineUrl: undefined, homePageUrl: null }));
    // Fired after a tab's BrowserView/webContents exists but before any
    // navigation — lets ProfileManager register the tab with this
    // profile's ElectronChromeExtensions bridge (DESIGN.md §8.8) so
    // chrome.tabs/chrome.windows are aware of it from the start.
    this.onTabCreated = onTabCreated || (() => {});
    // Find-in-page (§8.19) match-count updates, pushed to the renderer's
    // find bar — see startFind()'s own doc comment for why this comes
    // from a plain-text scan, not Chromium's found-in-page event.
    this.onFindResult = onFindResult || (() => {});
    // Browsing history (§8.20) — fired once per real page navigation
    // (see _wireWebContents's did-navigate handler), never for the home
    // page or an extension page.
    this.onHistoryVisit = onHistoryVisit || (() => {});
    // The tab panel's current width (§8.11) — every profile shares one
    // visual sidebar, so ProfileManager is the source of truth and keeps
    // whichever TabManager is active in sync (setTabPanelWidth) on every
    // live resize and on profile switch.
    this.tabPanelWidth = tabPanelWidth ?? 200;
    // Whether the find bar (§8.19) is currently reserving space above the
    // BrowserView — chrome-level UI state, like tabPanelWidth, not
    // per-tab; see startFind/stopFind and recomputeBounds.
    this.findBarOpen = false;
    // Same idea for the address bar's autocomplete dropdown (§8.23) —
    // set by the renderer (it alone knows whether it currently has any
    // suggestions to show) via setAddressSuggestOpen.
    this.addressSuggestOpen = false;
    // Focus mode (§8.29) — chrome-level UI state, like tabPanelWidth, and
    // kept in sync across profile switches the same way (ProfileManager
    // owns the canonical value); unlike tabPanelWidth this is never
    // persisted to disk, so it's always false again on a fresh launch.
    this.focusMode = focusMode ?? false;

    /** @type {Map<string, { id: string, view: BrowserView, url: string, title: string, favicon: string|null, isLoading: boolean, canGoBack: boolean, canGoForward: boolean, pinned: boolean, groupId: string|null }>} */
    this.tabs = new Map();
    this.order = [];
    this.activeTabId = null;
    // True only while restoreSession() is running its create loop (§8.15)
    // — makes _runPendingLoad a no-op so the extensions bridge's per-tab
    // activateTab calls during restore don't trigger navigations early.
    this._restoringSession = false;

    /** @type {Map<string, { id: string, name: string, color: string }>} */
    this.groups = new Map();

    // Recently-closed stack (§8.18, Cmd/Ctrl+Shift+T) — most-recent last,
    // capped at CLOSED_STACK_LIMIT. Deliberately session-only, unlike
    // §8.15's session restore: persisting it across a restart would need
    // its own on-disk format and merge logic with session restore's own
    // tab list, for a feature whose whole point is undoing something
    // that just happened a moment ago — not worth the complexity for v1.
    this.closedStack = [];

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

  // ---- session persistence (§8.15) ---------------------------------------

  // Serializes just enough to recreate this profile's tabs/groups/pins/
  // splits on the next launch — called by ProfileManager (debounced) on
  // every tabs-changed event and once more, unconditionally, right before
  // the window closes. Extension pages (chrome-extension://) are
  // deliberately excluded: restoring one before its owning extension has
  // (re)loaded would reproduce the exact zero-tabs-known-to-chrome.tabs
  // race that made the seed tab need to exist *before* extensions load in
  // the first place (see ProfileManager._ensureTabManager and DESIGN.md
  // §8.8.3) — simplest to just never persist them. An extension's
  // popup/options page is one click away via its toolbar icon anyway.
  //
  // Splits are stored as an index into this same filtered/reordered
  // array rather than a tab id, since ids are regenerated on every
  // restore (see restoreSession) and wouldn't mean anything on the next
  // launch.
  getSessionSnapshot() {
    const kept = this.order.filter((id) => !this.tabs.get(id).url.startsWith('chrome-extension://'));
    const indexOf = new Map(kept.map((id, i) => [id, i]));
    const tabs = kept.map((id) => {
      const tab = this.tabs.get(id);
      const splitIndex =
        tab.splitWithTabId && indexOf.has(tab.splitWithTabId) ? indexOf.get(tab.splitWithTabId) : null;
      return {
        // The home/new-tab page always normalizes to the 'about:blank'
        // sentinel (see createTab/did-navigate above) — stored as `null`
        // so restoreSession's `createTab(url)` takes the same "no
        // explicit url -> home page" branch a fresh new tab does, rather
        // than literally re-navigating to about:blank.
        url: tab.url === NEW_TAB_URL ? null : tab.url,
        // Persisted only so a deferred (not-yet-loaded) restored tab shows
        // a real label/icon in the strip before its first activation (§8.15).
        title: tab.title || null,
        favicon: tab.favicon || null,
        pinned: tab.pinned,
        groupId: tab.groupId,
        splitWithIndex: splitIndex,
      };
    });
    const activeIndex = indexOf.has(this.activeTabId) ? indexOf.get(this.activeTabId) : 0;
    return { tabs, groups: Array.from(this.groups.values()), activeIndex };
  }

  // Recreates tabs/groups/pins/splits from a snapshot getSessionSnapshot()
  // produced on a previous run. Returns false (doing nothing) if there's
  // nothing usable to restore, so the caller can fall back to seeding one
  // blank tab exactly as it would on a first launch.
  //
  // Every tab is created with `silent: true` so this doesn't fire one
  // tabs-changed IPC per tab (and, more importantly, doesn't run
  // activateTab's attach/detach BrowserView dance N times) — only the
  // final activateTab() call at the end actually attaches anything.
  restoreSession(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.tabs) || snapshot.tabs.length === 0) return false;

    for (const g of snapshot.groups || []) {
      if (g && typeof g.id === 'string') {
        this.groups.set(g.id, { id: g.id, name: g.name || 'New Group', color: g.color || DEFAULT_GROUP_COLOR });
      }
    }

    // Guards _runPendingLoad for the whole restore: creating each tab
    // fires onTabCreated -> the extensions bridge's addTab -> its
    // setActiveTab -> our activateTab, once per tab, before extensions
    // have loaded. Without this guard those spurious activations would
    // run every tab's pending navigation right here — exactly the
    // eager-load-during-restore behavior (and extension race) this is
    // meant to avoid. ProfileManager runs the active tab's real load
    // once extensions are ready (loadDeferredForActiveTab); the rest
    // load on first user activation.
    this._restoringSession = true;
    try {
      const ids = snapshot.tabs.map(
        (t) => this.createTab(t && t.url, { silent: true, deferLoad: true }).tabId
      );

      snapshot.tabs.forEach((t, i) => {
        if (!t) return;
        const id = ids[i];
        if (t.pinned) this.setPinned(id, true);
        if (t.groupId && this.groups.has(t.groupId)) this.setTabGroup(id, t.groupId);
        // Deferred tabs won't fire page-title-updated / page-favicon-updated
        // until first activated, so seed the strip from the snapshot.
        const tab = this.tabs.get(id);
        if (tab) {
          if (t.title) tab.title = t.title;
          if (t.favicon) tab.favicon = t.favicon;
        }
      });

      // Only link each pair from the lower index so splitTabs() isn't
      // called twice (once from each side) for the same pair.
      snapshot.tabs.forEach((t, i) => {
        if (t && typeof t.splitWithIndex === 'number' && t.splitWithIndex > i && ids[t.splitWithIndex]) {
          this.splitTabs(ids[i], ids[t.splitWithIndex]);
        }
      });

      const activeId = ids[snapshot.activeIndex] || ids[ids.length - 1];
      this.activateTab(activeId);
    } finally {
      this._restoringSession = false;
    }
    this._emitTabsChanged();
    return true;
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
  //
  // `silent: true` skips activating the new tab and emitting a
  // tabs-changed event — used only by restoreSession() below, which
  // creates a whole batch of tabs up front and wants exactly one
  // activate + one emit at the end instead of one per tab.
  createTab(url, { trusted = false, silent = false, deferLoad = false } = {}) {
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
      // Set when this tab is restored (§8.15) with deferLoad — the
      // navigation it should perform the first time it's shown, held here
      // instead of run now. `null` once consumed (see _runPendingLoad).
      pendingLoad: null,
      // Split view (§8.12) — bidirectional link to at most one other tab
      // in this same profile. Both tabs' BrowserViews show at once,
      // side by side, whenever either one is on screen.
      splitWithTabId: null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);

    this._wireWebContents(tab);

    if (url && deferLoad) {
      // Lazy session restore (§8.15): don't navigate now. Two reasons —
      // (1) a restored background/pinned tab shouldn't fetch its page
      // until the user actually looks at it, and (2) navigating here
      // races extension startup: a restored tab whose loadURL fires
      // before an installed extension's webRequest/declarativeNetRequest
      // handlers are registered can deadlock and stay blank forever
      // (reproduced with 1Password installed). The pending navigation
      // runs on first activation (_runPendingLoad), by which point
      // extensions have loaded.
      const target = resolveNavigationTarget(url, this.getSettings().searchEngineUrl);
      tab.pendingLoad = { verdict: trusted ? 'ok' : classifyNavigation(target), target };
    } else if (url) {
      const target = resolveNavigationTarget(url, this.getSettings().searchEngineUrl);
      const verdict = trusted ? 'ok' : classifyNavigation(target);
      if (verdict === 'ok') {
        view.webContents.loadURL(target).catch(() => {});
      } else {
        this._showBlockedError(tab, target, verdict);
      }
    } else if (deferLoad) {
      tab.pendingLoad = { home: true };
    } else {
      // A new tab with no explicit url (the "+" button, Cmd+T) opens
      // the home page (§8.10/§8.24) — never resolveNavigationTarget
      // ('about:blank') navigated as a search, which is what an earlier
      // version of this did (isLikelyUrl doesn't recognize the
      // schemeless "about:" form, so it fell through to the search
      // branch and ran a Google search for the literal text
      // "about:blank" on every new tab).
      this._loadHomePage(view.webContents);
    }

    if (!silent) {
      this.activateTab(id);
      this._emitTabsChanged();
    }

    // Fired last, deliberately — this is what registers the tab with
    // ProfileManager's extensions bridge (electron-chrome-extensions),
    // and that bridge's own addTab() synchronously calls back into our
    // *own* activateTab() the first time it sees a new window (it elects
    // an active tab on the spot; see chrome-extensions-bridge.js's
    // `selectTab`). Firing this only after activateTab() has already run
    // above means that reentrant call finds `this.activeTabId` already
    // equal to `id` and takes activateTab's "already showing" no-op
    // branch, instead of running a second, premature attach cycle before
    // this tab has even started loading.
    //
    // That premature second attach was a real, silent bug, found the
    // hard way (§8.18/§8.19 in DESIGN.md): it corrupted the BrowserView's
    // find-in-page channel for every profile's very first tab (found
    // while implementing §8.19) and was also the source of the
    // MaxListenersExceededWarning on the chrome window investigated
    // separately — both traced back to this exact reentrancy, not two
    // unrelated issues.
    this.onTabCreated(tab);

    return { tabId: id };
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    this._pushClosedStack(tab);

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

  // ---- recently-closed tabs (§8.18) --------------------------------------

  _pushClosedStack(tab) {
    this.closedStack.push({
      // Same "home page normalizes to null" convention as
      // getSessionSnapshot() (§8.15) — reopening takes the same
      // no-explicit-url createTab() branch a fresh new tab does.
      url: tab.url === NEW_TAB_URL ? null : tab.url,
      pinned: tab.pinned,
      groupId: tab.groupId,
    });
    if (this.closedStack.length > CLOSED_STACK_LIMIT) this.closedStack.shift();
  }

  // Cmd/Ctrl+Shift+T — pops the most recently closed tab and recreates it.
  // Calling this repeatedly walks further back through the stack regardless
  // of whether the tab(s) it already reopened are still open, matching how
  // real browsers let you keep pressing the shortcut to step back through
  // several closes in a row.
  reopenLastClosedTab() {
    const entry = this.closedStack.pop();
    if (!entry) return;
    const { tabId } = this.createTab(entry.url);
    if (entry.pinned) this.setPinned(tabId, true);
    if (entry.groupId && this.groups.has(entry.groupId)) this.setTabGroup(tabId, entry.groupId);
  }

  // ---- reordering (§8.18 drag-to-reorder) --------------------------------

  // Moves `tabId` to just before/after `targetTabId` within `order`.
  // Restricted to reordering within the same pinned/unpinned bucket —
  // pinned tabs must stay contiguous at the front (§8.1's invariant,
  // also relied on by setPinned) — a cross-bucket drag is silently a
  // no-op rather than something that needs its own clamping logic. The
  // tab strip's two buckets are visually and spatially separate (a
  // divider between them), so this is never a drag a user would
  // plausibly attempt expecting a reorder anyway.
  moveTab(tabId, targetTabId, position) {
    if (tabId === targetTabId) return;
    const tab = this.tabs.get(tabId);
    const target = this.tabs.get(targetTabId);
    if (!tab || !target || tab.pinned !== target.pinned) return;

    const fromIdx = this.order.indexOf(tabId);
    if (fromIdx === -1) return;
    this.order.splice(fromIdx, 1);

    let toIdx = this.order.indexOf(targetTabId);
    if (toIdx === -1) return; // shouldn't happen — target still exists
    if (position === 'after') toIdx += 1;
    this.order.splice(toIdx, 0, tabId);

    this._emitTabsChanged();
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

  // Runs a tab's deferred session-restore navigation (§8.15) exactly
  // once, the first time it's shown. No-op for any normally-created tab,
  // and suppressed entirely while restoreSession() is mid-flight (see
  // _restoringSession).
  _runPendingLoad(tab) {
    if (this._restoringSession) return;
    const p = tab && tab.pendingLoad;
    if (!p) return;
    tab.pendingLoad = null;
    if (p.home) {
      this._loadHomePage(tab.view.webContents);
    } else if (p.verdict === 'ok') {
      tab.view.webContents.loadURL(p.target).catch(() => {});
    } else {
      this._showBlockedError(tab, p.target, p.verdict);
    }
  }

  // Called by ProfileManager once this profile's extensions have finished
  // loading: runs the deferred navigation for the active tab (and its
  // split partner) so a restored session's foreground tab loads promptly
  // without racing extension request-handler registration. Background
  // tabs stay deferred until first clicked.
  loadDeferredForActiveTab() {
    const tab = this.activeTabId && this.tabs.get(this.activeTabId);
    if (!tab) return;
    this._runPendingLoad(tab);
    if (tab.splitWithTabId) this._runPendingLoad(this.tabs.get(tab.splitWithTabId));
  }

  activateTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    // First time this tab (or its split partner, shown alongside it) is
    // brought forward after a lazy restore, kick off its real load.
    this._runPendingLoad(tab);
    if (tab.splitWithTabId) this._runPendingLoad(this.tabs.get(tab.splitWithTabId));

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

  // Focus mode (§8.29) — called once the renderer's own chrome-collapse
  // (entering) or chrome-reveal (leaving/peeking) is ready for the
  // BrowserView to actually move; see FocusMode.js for why those two
  // directions are sequenced oppositely relative to this call.
  setFocusMode(on) {
    this.focusMode = !!on;
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
    // Focus mode (§8.29): the rail + tab panel collapse to nothing, and
    // the topbar collapses to just FOCUS_HOTZONE_H — a hover target for
    // the renderer, not really "chrome" — rather than CHROME_TOP_H's
    // usual full height. The find bar/address-suggestions dropdown can
    // still be triggered while focused (Cmd+F, Cmd+L) and still need
    // their own space reserved above the BrowserView when they are, same
    // as always — focus mode only changes the *baseline* on top of which
    // those stack.
    const sidebarW = this.focusMode ? 0 : RAIL_W + this.tabPanelWidth;
    const topBaseline = this.focusMode ? FOCUS_HOTZONE_H : CHROME_TOP_H;
    // The find bar (§8.19) and address-suggestions dropdown (§8.23) both
    // live in the chrome renderer's own DOM, in the gap this reserves
    // above the BrowserView — not an overlay on top of it (unlike the
    // permission prompt/settings modal, hiding the page here would
    // defeat the purpose of searching it/distract from typing a URL).
    // Only reserved while actually open, unlike the always-on topbar;
    // stacking both is harmless (and correct) on the rare chance both
    // were somehow open at once.
    const topReserve =
      topBaseline + (this.findBarOpen ? FIND_BAR_H : 0) + (this.addressSuggestOpen ? ADDRESS_SUGGEST_H : 0);
    const [winWidth, winHeight] = this.win.getContentSize();
    const contentX = sidebarW;
    const contentY = topReserve;
    const contentW = Math.max(0, winWidth - sidebarW);
    const contentH = Math.max(0, winHeight - topReserve);

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
    const target = resolveNavigationTarget(input, this.getSettings().searchEngineUrl);
    const verdict = classifyNavigation(target, tab.view.webContents.getURL());
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
    this._loadHomePage(tab.view.webContents);
  }

  // Shared by createTab()'s no-explicit-url branch and goHome() — loads
  // the profile's configured home page (§8.24), which defaults to (and
  // falls back to, if the configured one is somehow invalid/blocked) the
  // bundled SimpleHome page. A custom home page URL is user-supplied
  // (typed into the settings modal) so it's validated exactly like any
  // address-bar input, never trusted outright.
  _loadHomePage(webContents) {
    const { homePageUrl } = this.getSettings();
    if (homePageUrl) {
      const target = resolveNavigationTarget(homePageUrl);
      if (classifyNavigation(target) === 'ok') {
        webContents.loadURL(target).catch(() => {});
        return;
      }
    }
    webContents.loadFile(HOME_PAGE_PATH).catch(() => {});
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

  // §8.40 — resolves a tab from the webContents that sent something, so a
  // mouse back/forward press navigates the tab it actually happened over
  // rather than always the active one (they differ in split view, where
  // both tabs' pages are visible and clickable at once).
  tabIdForWebContents(webContents) {
    for (const [id, tab] of this.tabs) {
      if (tab.view.webContents === webContents) return id;
    }
    return null;
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
    // A restored tab reloaded before it was ever shown is still on
    // about:blank with its real navigation pending — run that instead.
    if (tab.pendingLoad) {
      this._runPendingLoad(tab);
      return;
    }
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

  // ---- find-in-page (§8.19) ------------------------------------------------
  //
  // Uses window.find() via executeJavaScript, NOT Electron's native
  // webContents.findInPage()/'found-in-page' event, despite that being
  // the obvious first choice (and what this originally shipped with).
  // Found the hard way: the instant a tab is registered with
  // ProfileManager's electron-chrome-extensions bridge (§8.8.1) — which
  // every real tab in this app always is — findInPage() stops firing
  // 'found-in-page' entirely. No error, no rejected promise, nothing;
  // the request just vanishes. Bisected extensively — a raw BrowserView
  // with the exact same webPreferences/session/window works fine right
  // up until a tab is handed to that library via its addTab(); a bare
  // preload-script registration alone doesn't reproduce it either — the
  // full ElectronChromeExtensions instance plus an added tab does, every
  // time. That points at something inside the library's own tab-tracking
  // machinery, not this app's code, and not worth vendoring/patching a
  // GPL-3.0 dependency to chase further. window.find() — a legacy but
  // still fully-implemented Window API — runs entirely inside the page's
  // own JS context instead of through whatever internal channel gets
  // broken, and was verified to keep working in that exact broken setup.
  //
  // The trade-off: window.find() only reports "found a match" per call,
  // not a running match index the way found-in-page's activeMatchOrdinal
  // did — so the find bar shows a plain match *count* (a separate
  // plain-text scan, computed once per new search, not on every next/
  // prev step), not a "3 of 12" position. See DESIGN.md §8.19.

  // `findNext: false` (a fresh search — every keystroke in the find bar)
  // recomputes the match count and restarts from the top of the
  // document; `findNext: true` (Enter / the prev-next buttons) just
  // steps to the next-or-previous match of the *same* search text,
  // wrapping around, without re-scanning or re-counting. Reserves the
  // find bar's on-screen space (recomputeBounds) the first time this is
  // called — idempotent on every later keystroke, so typing doesn't
  // thrash the BrowserView's bounds.
  startFind(tabId, text, { forward = true, findNext = false } = {}) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (!this.findBarOpen) {
      this.findBarOpen = true;
      this.recomputeBounds();
    }
    const wc = tab.view.webContents;

    if (!text) {
      this._clearFindSelection(wc);
      this.onFindResult({ tabId, matches: 0 });
      return;
    }

    const countStep = findNext ? Promise.resolve(null) : this._countMatches(wc, text);
    countStep
      .then((matches) => {
        if (matches !== null) {
          this.onFindResult({ tabId, matches });
          // A fresh search must start from the top of the document, not
          // wherever a previous search's selection happened to land —
          // window.find() otherwise continues from the current selection.
          return this._clearFindSelection(wc).then(() => matches);
        }
        return matches;
      })
      .then(() => {
        // Args: (searchText, caseSensitive, backwards, wrapAround,
        // wholeWord, searchInFrames, showDialog).
        return wc.executeJavaScript(`window.find(${JSON.stringify(text)}, false, ${!forward}, true, false, true, false)`);
      })
      .catch(() => {});
  }

  // Closes the find bar's reserved space and, by default, clears the
  // page's own selection highlight window.find() leaves behind (Escape /
  // closing the bar). `action` mirrors the old stopFindInPage-based
  // API's options for the caller's sake: 'clearSelection' (default) or
  // 'keepSelection' (not currently used by the UI, kept for completeness).
  stopFind(tabId, action = 'clearSelection') {
    if (this.findBarOpen) {
      this.findBarOpen = false;
      this.recomputeBounds();
    }
    const tab = this.tabs.get(tabId);
    if (tab && action === 'clearSelection') this._clearFindSelection(tab.view.webContents);
  }

  // Plain case-insensitive substring count over the rendered text —
  // deliberately simple (not DOM/whitespace-aware the way a real find
  // engine is), just enough to show the find bar a meaningful number.
  // Errors (e.g. a page with no accessible `document.body` yet) resolve
  // to 0 rather than rejecting into the caller's .catch.
  _countMatches(wc, text) {
    const needle = JSON.stringify(text.toLowerCase());
    return wc
      .executeJavaScript(
        `(() => {
           const haystack = document.body.innerText.toLowerCase();
           const needle = ${needle};
           if (!needle) return 0;
           let count = 0;
           let pos = 0;
           while ((pos = haystack.indexOf(needle, pos)) !== -1) {
             count++;
             pos += needle.length;
           }
           return count;
         })()`
      )
      .catch(() => 0);
  }

  _clearFindSelection(wc) {
    return wc.executeJavaScript('window.getSelection().removeAllRanges()').catch(() => {});
  }

  // ---- address bar autocomplete (§8.23) -------------------------------------

  // Toggled by AddressBar.js — it alone knows whether it currently has
  // any suggestions to show (main has no visibility into what's typed
  // until it's actually navigated to); idempotent, cheap to call on
  // every keystroke.
  setAddressSuggestOpen(open) {
    if (this.addressSuggestOpen === open) return;
    this.addressSuggestOpen = open;
    this.recomputeBounds();
  }

  // ---- webContents event wiring --------------------------------------------

  _wireWebContents(tab) {
    const wc = tab.view.webContents;

    // Chrome-level shortcuts (§1) reserved at the browser level — a page
    // never gets first dibs on Cmd/Ctrl+T, +W, +L, ... (§8.32). The
    // owning TabManager for a given tab never changes across its
    // lifetime, so `() => this` is already correct here — no "whichever
    // profile is active" lookup needed the way the chrome window's own
    // wiring (index.js) does.
    attachChromeShortcuts(wc, this.win, () => this);

    attachNavigationPolicy(wc, {
      // attachNavigationPolicy only ever calls this once its own
      // classifyNavigation(url, sourceUrl) already came back 'ok' —
      // including the same-extension chrome-extension: exception (§8.13)
      // — so createTab() here must not silently re-run that check with
      // no source context, or a same-extension link that opens as a new
      // tab (target="_blank"/window.open, e.g. 1Password's settings
      // link) gets blocked anyway despite already being verified safe.
      onOpenNewTab: (url) => this.createTab(url, { trusted: true }),
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

      // Browsing history (§8.20) — extension pages aren't "browsing" in
      // the sense a history list means, so they're excluded the same way
      // §8.15's session restore excludes them. Deliberately delayed:
      // page-title-updated (usually milliseconds behind, for any page
      // with a real <title> tag in its initial HTML) hasn't necessarily
      // fired yet at did-navigate time, and recording the hostname-
      // fallback title into history permanently would be a worse
      // trade-off than a short delay. Re-checks tab.url still matches
      // in case the user already navigated away by the time this fires
      // — that newer navigation's own delayed call records its own entry.
      if (!url.startsWith('chrome-extension://')) {
        setTimeout(() => {
          if (tab.url === url) this.onHistoryVisit({ url: tab.url, title: tab.title, favicon: tab.favicon });
        }, 300);
      }
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

    // Right-click menu on page content (§8.22) — without this,
    // 'context-menu' fires but nothing shows at all; Electron doesn't
    // build one on its own.
    wc.on('context-menu', (_event, params) => {
      showPageContextMenu({
        webContents: wc,
        win: this.win,
        params,
        tabManager: this,
        tabId: tab.id,
        searchEngineUrl: this.getSettings().searchEngineUrl,
      });
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
