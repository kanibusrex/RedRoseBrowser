'use strict';

// A small reusable popup menu (right-click context menus, the group color
// picker, the profile switcher). Renders into a single shared container
// appended to <body> so it can float above everything and closes itself
// on outside click / Escape / picking an item.

let container = null;
let closeCurrent = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.id = 'popup-root';
  document.body.appendChild(container);
  return container;
}

// A BrowserView always paints above the chrome window's own content, so a
// popup that spilled past the sidebar/rail's right edge would render
// invisibly behind the active tab's page. Rather than hiding the page's
// BrowserView for every popup (which blanks the page the user is looking
// at, just to show a small menu), positionWithinViewport() below keeps
// every popup's right edge within the chrome area — every caller in this
// app anchors its popup from inside that area to begin with (a tab row,
// a group's color dot, the rail glyph), so this never has to clip an
// anchor that's genuinely further right.
function getChromeWidth() {
  const styles = getComputedStyle(document.documentElement);
  const railW = parseFloat(styles.getPropertyValue('--rail-w')) || 64;
  const tabPanelW = parseFloat(styles.getPropertyValue('--tab-panel-w')) || 200;
  return railW + tabPanelW;
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
  positionWithinViewport(menu, anchor);
  wireDismiss(menu);
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
  build(popover);

  root.appendChild(popover);
  positionWithinViewport(popover, anchor);
  wireDismiss(popover);
  return popover;
}

export function closePopup() {
  if (closeCurrent) closeCurrent();
}

function positionWithinViewport(el, anchor) {
  // Render first (off-screen concerns aside) so we can measure it, then
  // clamp into the chrome area (never the BrowserView's region — see
  // getChromeWidth above) and the window's bottom edge.
  const { innerHeight } = window;
  const maxRight = getChromeWidth() - 8;
  // The tab panel is user-resizable (§8.11), so the chrome area isn't
  // always at least as wide as .popup-menu's CSS max-width (248px) —
  // cap the popup's own width to whatever's actually available too, not
  // just its position, or a narrowed panel could still let it spill
  // into the BrowserView despite the position clamp below.
  el.style.maxWidth = `${Math.max(140, maxRight - 8)}px`;
  const rect = el.getBoundingClientRect();
  let x = anchor.x;
  let y = anchor.y;
  if (x + rect.width > maxRight) x = Math.max(8, maxRight - rect.width);
  if (y + rect.height > innerHeight - 8) y = Math.max(8, innerHeight - rect.height - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
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
  };
}
