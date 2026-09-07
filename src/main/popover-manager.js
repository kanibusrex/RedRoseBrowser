'use strict';

const { BrowserView } = require('electron');
const path = require('node:path');

const { chromeWindowWebPreferences } = require('./security');
const { MAIN_TO_RENDERER } = require('../shared/ipc-channels');

const POPOVER_HTML_PATH = path.join(__dirname, '..', 'renderer', 'popover.html');

// Kept clear of the window's own edges, same margin
// ContextMenu.js's old positionWithinViewport used.
const MARGIN = 8;

/**
 * Owns the single, on-demand BrowserView used to show any popover —
 * bookmarks, history, downloads, extensions, the profile switcher, tab/
 * group-color context menus, the site-permission prompt — as a genuine
 * overlay on top of the page (§8.28), not a `<div>` in the chrome
 * window's own document. A plain DOM popover always rendered *behind*
 * the active tab's BrowserView (§2.3), which is why §8.27 had every
 * popover detach the page's view first — this replaces that workaround:
 * a small BrowserView, sized to exactly its own content, stacked on top
 * via `setTopBrowserView`, overlays the page in just that region while
 * leaving it fully live everywhere else. Verified directly (see
 * DESIGN.md §8.28) before building on it — Electron has no CSS-driven
 * click-through between stacked views, so this only works because the
 * popover's bounds are exactly its own footprint, never the whole window.
 *
 * One instance per chrome window (popovers are chrome-level UI, not
 * per-profile). Only ever one popover open at a time — showing a new one
 * closes whatever's already open first.
 *
 * Uses `chromeWindowWebPreferences()` (contextIsolation/sandbox/
 * nodeIntegration:false, `chrome-preload.js`) — the same hardened,
 * trusted-content webPreferences the chrome window itself uses, and the
 * same preload, so every popover gets the exact same `window.browserAPI`
 * surface as the chrome window with nothing new to expose.
 */
class PopoverManager {
  constructor(win) {
    this.win = win;
    /** @type {BrowserView|null} */
    this.view = null;
    this._anchor = null;
    this._onClose = null;
  }

  isOpen() {
    return !!this.view;
  }

  // §8.39 — the chrome window marks its rail, sidebar and toolbar
  // `-webkit-app-region: drag` (§8.30's hidden title bar left no title bar
  // to drag the window by, so those surfaces became the drag handle).
  // macOS applies draggable regions at the *window* level, computed from
  // the window's own contents, with no knowledge of any BrowserView
  // stacked on top — so a mouse event landing in one is consumed by
  // AppKit's window-drag machinery and never delivered to any webContents
  // at all, including a popover sitting directly above it. Every popover
  // in this app opens over exactly those surfaces, which made all of them
  // completely unclickable. Dropping the drag regions for as long as a
  // popover is open is what actually fixes it; the window simply can't be
  // dragged by those surfaces while a popover is showing, which is both
  // unnoticeable in practice and what every other app does anyway.
  _setChromeDragRegionsEnabled(enabled) {
    if (this.win.isDestroyed()) return;
    try {
      this.win.webContents.send(MAIN_TO_RENDERER.POPOVER_OPEN_STATE, { popoverOpen: !enabled });
    } catch {
      /* best-effort — a window mid-teardown just keeps its regions */
    }
  }

  currentWebContents() {
    return this.view ? this.view.webContents : null;
  }

  // `anchor` is `{x, y}` in the chrome window's own content coordinates
  // (e.g. a rail button's `getBoundingClientRect()`) — since the popover
  // view attaches to this same window, that's already the right
  // coordinate space for `setBounds()`, no conversion needed. `data` is
  // whatever per-invocation payload the popover's own content needs
  // (a tab id for the tab context menu, the permission request's
  // requestId/origin/permission, ...) — sent on once the view loads.
  //
  // `onClose` (main-process-only — never comes from the renderer, which
  // can't hand a function across IPC) is an optional callback fired the
  // instant this specific popover closes, for whatever reason (an
  // explicit answer that already called closePopover() itself, a blur,
  // or getting superseded by a new popover opening). Only the permission
  // prompt uses this today (ipc-handlers.js's POPOVER_SHOW handler wires
  // it to fall back to "deny, don't remember" — see §8.28 — the same
  // fallback PermissionPrompt.js's own MutationObserver used to apply for
  // every dismissal path in one place before this migration); harmless
  // no-op for every other kind, which never supplies one.
  show({ kind, anchor, data, onClose }) {
    this.close();

    const view = new BrowserView({ webPreferences: chromeWindowWebPreferences() });
    this.view = view;
    this._anchor = anchor;
    this._onClose = onClose || null;

    // Start at a minimal, effectively-invisible size — real bounds are
    // set once the popover's own script measures its actual content and
    // reports back (reportSize, below), avoiding a flash of wrongly
    // sized/positioned content in between.
    view.setBounds({ x: Math.round(anchor.x), y: Math.round(anchor.y), width: 1, height: 1 });
    this.win.addBrowserView(view);
    this.win.setTopBrowserView(view);

    // Before the view can be clicked at all — see _setChromeDragRegionsEnabled.
    this._setChromeDragRegionsEnabled(false);

    // Closes itself the instant it loses focus — covers every "clicked
    // outside" case (the page, a different part of the chrome window)
    // in one signal, without needing a cross-webContents mousedown
    // listener the way the old DOM-based popovers used.
    view.webContents.on('blur', () => this.close(view.webContents));

    // The popover is its own separate document (a different `<html>` than
    // index.html) but shares its stylesheet, and this app's whole theme
    // system (theme.js) works by toggling classes (theme-dark, plus an
    // optional accent variant) on the chrome window's <html> element,
    // persisted only in that document's own localStorage — nothing main
    // already tracks. So a popover asks the chrome window's own document
    // what it's currently wearing and copies that, rather than always
    // rendering in the default (light, "classic") look regardless of what
    // theme the rest of the app is actually in. Best-effort: a failure
    // here (window destroyed mid-request, ...) just leaves the popover in
    // the default theme rather than blocking it from opening at all.
    const themeClass = this.win.isDestroyed()
      ? Promise.resolve('')
      : this.win.webContents.executeJavaScript('document.documentElement.className').catch(() => '');

    Promise.all([view.webContents.loadFile(POPOVER_HTML_PATH, { query: { kind } }), themeClass])
      .then(([, cls]) => {
        if (this.view !== view || view.webContents.isDestroyed()) return; // closed/replaced while loading
        view.webContents.send(MAIN_TO_RENDERER.POPOVER_INIT, { kind, data, themeClass: cls || '' });
        view.webContents.focus();
      })
      .catch(() => {});
  }

  // Called (via IPC) once the popover's own content has rendered and
  // measured itself — the popover's `document.body`'s natural width/
  // height are what it wants; this clamps that against the window and
  // actually positions/sizes the BrowserView to match.
  reportSize(webContents, { width, height }) {
    if (!this.view || this.view.webContents !== webContents || this.win.isDestroyed()) return;
    const [winW, winH] = this.win.getContentSize();

    // Clamp size first (the rare "doesn't fit even in the corner" case —
    // a tiny window), then position within whatever's left.
    const w = Math.max(1, Math.min(Math.ceil(width), winW - 2 * MARGIN));
    const h = Math.max(1, Math.min(Math.ceil(height), winH - 2 * MARGIN));

    let x = this._anchor.x;
    let y = this._anchor.y;
    if (x + w > winW - MARGIN) x = Math.max(MARGIN, winW - MARGIN - w);
    if (y + h > winH - MARGIN) y = Math.max(MARGIN, winH - MARGIN - h);

    this.view.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
  }

  // `webContents`, when given (a request coming from the popover's own
  // script — Escape, an item selection), guards against a stale close
  // from a popover that's already been replaced by a newer one; omitted
  // for an unconditional close (e.g. opening a different popover, or
  // tearing down the window).
  close(webContents) {
    if (webContents && (!this.view || this.view.webContents !== webContents)) return;
    if (!this.view) return;
    const view = this.view;
    const onClose = this._onClose;
    this.view = null;
    this._anchor = null;
    this._onClose = null;
    try {
      this.win.removeBrowserView(view);
    } catch {
      /* already detached */
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      /* best-effort */
    }
    // Nothing is overlaying the chrome's own surfaces any more, so the
    // window goes back to being draggable by them (see
    // _setChromeDragRegionsEnabled).
    this._setChromeDragRegionsEnabled(true);
    // The popover's webContents had keyboard focus (see show()) — hand
    // it back to the chrome window's own document now that it's gone,
    // rather than leaving focus dangling on a destroyed webContents.
    if (!this.win.isDestroyed()) this.win.webContents.focus();
    // Nulled above before this runs, so a close() this callback itself
    // triggers reentrantly (e.g. resolving the permission request also
    // happens to route back through here) sees this.view already gone
    // and no-ops rather than recursing.
    if (onClose) {
      try {
        onClose();
      } catch {
        /* best-effort */
      }
    }
  }
}

module.exports = { PopoverManager };
