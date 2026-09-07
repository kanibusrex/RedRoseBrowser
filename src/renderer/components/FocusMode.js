'use strict';

// Focus mode (§8.29): the rail, tab panel, and toolbar slide/fade away,
// leaving just the page. Toggled by the rail's own button (only reachable
// to turn it *on* — the button disappears along with the rest of the
// rail once it's active) and Cmd/Ctrl+Shift+F (index.js), which works
// both ways. Hovering the very top edge of the window "peeks" the chrome
// back temporarily without actually leaving focus mode — it reappears on
// its own a moment after the mouse (and keyboard focus) moves away.
//
// The tricky part isn't the CSS collapse itself (styles.css's
// #chrome-root.focus-hide) — it's that the page is a BrowserView, which
// always paints *above* this document (DESIGN.md §2.3) regardless of
// what this document's own CSS is doing. That means:
//   - entering (hide): the CSS collapse has to *finish* before the
//     BrowserView expands into the freed space — expanding it first
//     would cover the still-visible rail/toolbar instantly, making the
//     "slowly hide away" transition invisible (hidden behind the now-
//     full-size page).
//   - leaving/peeking (reveal): the opposite — the BrowserView has to
//     shrink back *first*, before the CSS reveal starts, or the
//     reappearing chrome would render underneath the still-full-size
//     page and never actually be seen appearing.
// setDesiredHidden() below is the one place that ordering lives; a
// monotonic token guards against a rapid toggle (or a peek starting and
// ending faster than a transition can finish) resolving out of order —
// found by reasoning through exactly that scenario before ever running
// it, not by hitting it live.

const HOTZONE_PX = 6; // must stay well under FOCUS_HOTZONE_H (tab-manager.js)
const HIDE_DELAY_MS = 900;

export function initFocusMode({ chromeRoot, toggleBtn }) {
  const toolbarEl = document.getElementById('toolbar');
  const sidebarEl = document.getElementById('sidebar');

  let focusModeOn = false;
  let peeking = false;
  let desiredHidden = false;
  let syncToken = 0;
  let pointerInChrome = false;
  let hideTimer = null;

  function syncVisual() {
    const myToken = ++syncToken;
    if (desiredHidden) {
      chromeRoot.classList.add('focus-hide');
      const onEnd = (event) => {
        // #toolbar transitions flex-basis/height/opacity together
        // (styles.css) — flex-basis is the one whose duration actually
        // matches the full collapse, so it's the signal to wait for;
        // the shorter opacity transition would fire first and resolve
        // this early, before the layout has actually finished moving.
        if (event.target !== toolbarEl || event.propertyName !== 'flex-basis') return;
        toolbarEl.removeEventListener('transitionend', onEnd);
        if (myToken !== syncToken) return; // superseded by a newer request
        window.browserAPI.setFocusMode(true);
      };
      toolbarEl.addEventListener('transitionend', onEnd);
    } else {
      window.browserAPI.setFocusMode(false).then(() => {
        if (myToken !== syncToken) return; // superseded
        chromeRoot.classList.remove('focus-hide');
      });
    }
  }

  function setDesiredHidden(hidden) {
    if (desiredHidden === hidden) return;
    desiredHidden = hidden;
    syncVisual();
  }

  function chromeHasRealFocus() {
    const el = document.activeElement;
    return !!el && el !== document.body && chromeRoot.contains(el);
  }

  function scheduleHideCheck() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(checkHide, HIDE_DELAY_MS);
  }

  function checkHide() {
    if (!peeking) return;
    // Keep peeking while the mouse is still over the revealed chrome,
    // something in it has real keyboard focus (e.g. Cmd+L was pressed
    // and the user is mid-URL), or a popover/permission prompt opened
    // from it currently holds the window's input focus (§8.28's
    // PopoverManager hands focus back to this document the instant it
    // closes, which is what lets this check resume then instead of
    // hanging hidden-forever behind a focus that never returns).
    if (pointerInChrome || chromeHasRealFocus() || !document.hasFocus()) {
      scheduleHideCheck();
      return;
    }
    endPeek();
  }

  function enterFocusMode() {
    if (focusModeOn) return;
    focusModeOn = true;
    peeking = false;
    clearTimeout(hideTimer);
    setDesiredHidden(true);
  }

  function exitFocusMode() {
    if (!focusModeOn) return;
    focusModeOn = false;
    peeking = false;
    clearTimeout(hideTimer);
    setDesiredHidden(false);
  }

  function toggle() {
    if (focusModeOn) exitFocusMode();
    else enterFocusMode();
  }

  function startPeek() {
    if (!focusModeOn || peeking) return;
    peeking = true;
    setDesiredHidden(false);
    scheduleHideCheck();
  }

  function endPeek() {
    if (!peeking) return;
    peeking = false;
    setDesiredHidden(true);
  }

  // A keyboard shortcut that needs the (currently hidden) toolbar —
  // Cmd/Ctrl+L to focus the address bar is the one case today — should
  // bring it into view rather than silently focusing an invisible field.
  // No-op when not in focus mode, or already peeking.
  function peekForInteraction() {
    startPeek();
  }

  toggleBtn.addEventListener('click', () => toggle());

  window.addEventListener('mousemove', (event) => {
    if (!focusModeOn) return;
    if (!peeking) {
      if (event.clientY <= HOTZONE_PX) startPeek();
      return;
    }
    const inSidebar = event.clientX <= sidebarEl.getBoundingClientRect().right;
    const inToolbar = event.clientY <= toolbarEl.getBoundingClientRect().bottom;
    pointerInChrome = inSidebar || inToolbar;
    if (pointerInChrome) clearTimeout(hideTimer);
    else scheduleHideCheck();
  });

  // The chrome window regaining input focus is exactly the signal that a
  // popover opened from the peeked chrome (bookmarks, the tab menu, ...)
  // just closed (PopoverManager.close() hands focus back here) — worth
  // re-checking right away rather than waiting out whatever's left of a
  // stale timer.
  window.addEventListener('focus', () => {
    if (peeking) scheduleHideCheck();
  });

  return { toggle, peekForInteraction, isOn: () => focusModeOn };
}
