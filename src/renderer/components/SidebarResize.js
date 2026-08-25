'use strict';

// Drag handle between the tab panel and the page content (§8.11).
// Live-previews via the --tab-panel-w CSS custom property while
// dragging — instant, no IPC round-trip needed for the visual side —
// and tells main the new width on every frame so it can reposition the
// active tab's BrowserView to match. Main (ProfileManager) is the
// source of truth for clamping and persisting; these bounds are a local
// copy purely so the live preview doesn't overshoot before main's
// response would otherwise correct it.
const MIN_TAB_PANEL_W = 160;
const MAX_TAB_PANEL_W = 480;

export function initSidebarResize(handleEl) {
  let dragging = false;
  let raf = null;

  function applyWidth(px) {
    const clamped = Math.min(MAX_TAB_PANEL_W, Math.max(MIN_TAB_PANEL_W, px));
    document.documentElement.style.setProperty('--tab-panel-w', `${clamped}px`);
    window.browserAPI.setSidebarWidth(clamped);
  }

  handleEl.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    dragging = true;
    handleEl.classList.add('dragging');
    handleEl.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  handleEl.addEventListener('pointermove', (event) => {
    if (!dragging || raf) return;
    const { clientX } = event;
    raf = requestAnimationFrame(() => {
      raf = null;
      // The tab panel starts right after the rail, so its width is
      // just how far past the rail's right edge the pointer is.
      const railW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--rail-w')) || 64;
      applyWidth(clientX - railW);
    });
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = false;
    handleEl.classList.remove('dragging');
    try {
      handleEl.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };
  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);

  window.browserAPI.getSidebarWidth().then(({ width }) => {
    document.documentElement.style.setProperty('--tab-panel-w', `${width}px`);
  });
}
