'use strict';

// A small reusable popup menu (right-click context menus, the group color
// picker, the profile switcher, bookmarks/history/downloads/extensions).
// Renders into a single shared container appended to <body> so it can
// float above everything and closes itself on outside click / Escape /
// picking an item.
//
// Every popup shown here detaches the active tab's BrowserView for as
// long as it's open (§8.27) — a BrowserView always paints above the
// chrome window's own content (DESIGN.md §2.3), so without this, any
// popup positioned over the page (which every one of these can now be —
// there's no reason a popover should be squeezed into the sidebar just
// because that's where its anchor button happens to live) would render
// invisibly behind it. Goes through ViewOverlay.js's reference count
// (not window.browserAPI.hideActiveView directly) so an overlapping
// popup and permission prompt/settings modal can't make each other
// prematurely re-show the page.

import { pushHideActiveView, popHideActiveView } from './ViewOverlay.js';

let container = null;
let closeCurrent = null;
// { el, anchor } for whatever's currently open — lets
// repositionCurrentPopup() (below) re-run the same position/clamp logic
// later, when a popover's content changes size after it was first shown.
let currentPosition = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'popup-root';
  document.body.appendChild(container);
  return container;
}

/**
 * items: Array<{ label: string, onClick: () => void, danger?: boolean } | { separator: true }>
 * anchor: { x, y } page coordinates for the menu's top-left corner.
 */
export function showContextMenu(items, anchor) {
  closePopup();
  const root = ensureContainer();

  const menu = document.createElement('div');
  menu.className = 'popup-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'popup-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'popup-item' + (item.danger ? ' danger' : '');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      closePopup();
      item.onClick();
    });
    menu.appendChild(btn);
  }

  root.appendChild(menu);
  pushHideActiveView();
  positionWithinViewport(menu, anchor);
  wireDismiss(menu);
  currentPosition = { el: menu, anchor };
}

/**
 * A custom popover content builder (e.g. a color palette or the profile
 * list) instead of a plain item list. `build(container)` fills the popup.
 */
export function showPopover(build, anchor, { className = '' } = {}) {
  closePopup();
  const root = ensureContainer();

  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover' + (className ? ` ${className}` : '');
  const buildResult = build(popover);

  root.appendChild(popover);
  pushHideActiveView();
  positionWithinViewport(popover, anchor);
  wireDismiss(popover);
  currentPosition = { el: popover, anchor };

  // `build` can be async (History.js/Downloads.js await an IPC round
  // trip — HISTORY_LIST/DOWNLOADS_LIST — before their real rows exist in
  // the DOM at all). The synchronous position/clamp above only ever saw
  // whatever was in `popover` before that resolved (just an empty list
  // between a search box and a footer, in History.js's case) — found the
  // hard way (§8.26 — "the history menu is getting cut off"): a popover
  // whose real height only arrives after an await can end up positioned
  // for a size it never actually stays at, running off the bottom of the
  // window once the rows actually render in. Re-running the same
  // position/clamp once that settles is what repositionCurrentPopup()
  // (called here, and by History.js/Downloads.js after their own later
  // re-renders — a search keystroke, a live downloads update) fixes.
  if (buildResult && typeof buildResult.then === 'function') {
    buildResult.then(() => repositionCurrentPopup());
  }

  return popover;
}

// Re-clamps whatever popover is currently open against its original
// anchor — for a caller whose content can change size *after* it's
// already shown (a search keystroke narrowing/widening the result list,
// a live downloads-progress update adding/removing rows), not just the
// one-time async-content case showPopover already handles on its own.
// A no-op if nothing's open, or if what's open isn't the caller's own
// popover anymore (closed/replaced by something else in the meantime).
export function repositionCurrentPopup() {
  if (!currentPosition || !currentPosition.el.isConnected) return;
  positionWithinViewport(currentPosition.el, currentPosition.anchor);
}

export function closePopup() {
  if (closeCurrent) closeCurrent();
}

function positionWithinViewport(el, anchor) {
  // Render first, then clamp fully within the window itself — the active
  // view is hidden for as long as any popup from this module is open
  // (see the file-level comment), so there's no sidebar/BrowserView
  // boundary left to avoid spilling past; the only remaining constraint
  // is the window's own edges.
  const { innerWidth, innerHeight } = window;
  const maxRight = innerWidth - 8;
  el.style.maxWidth = `${Math.max(140, maxRight - 8)}px`;
  const rect = el.getBoundingClientRect();
  let x = anchor.x;
  let y = anchor.y;
  if (x + rect.width > maxRight) x = Math.max(8, maxRight - rect.width);
  if (y + rect.height > innerHeight - 8) y = Math.max(8, innerHeight - rect.height - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;

  // Last-resort height safety net (§8.26 — "the history menu is getting
  // cut off and the whole thing is not displaying"). The y-clamp above
  // only ever *repositions* a popover, never shrinks one — a popover
  // taller than what's left below its (possibly already-clamped-to-the-
  // top) position would render past the bottom of the window with
  // nothing to scroll it back into view. Individual popovers
  // (History.js/Downloads.js) cap their own height via CSS well within
  // ordinary window sizes; this only engages as a fallback for whatever
  // that own cap didn't anticipate (a shorter-than-usual window, near
  // this app's own 480px minimum) — deliberately last-resort rather than
  // the primary mechanism, since it can only scroll a popover as one
  // whole unit, losing any "sticky header/footer within it" a specific
  // popover's own CSS arranged.
  const available = innerHeight - y - 8;
  if (rect.height > available) {
    el.style.maxHeight = `${Math.max(80, available)}px`;
    el.style.overflowY = 'auto';
  }
}

function wireDismiss(menu) {
  const onMouseDown = (event) => {
    if (!menu.contains(event.target)) closePopup();
  };
  const onKeyDown = (event) => {
    if (event.key === 'Escape') closePopup();
  };

  // Defer wiring by a tick so the click/contextmenu that opened this
  // popover doesn't immediately close it via the same mousedown.
  setTimeout(() => {
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKeyDown, true);
  }, 0);

  closeCurrent = () => {
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    menu.remove();
    closeCurrent = null;
    if (currentPosition && currentPosition.el === menu) currentPosition = null;
    popHideActiveView();
  };
}
