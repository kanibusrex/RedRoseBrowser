'use strict';

// Find-in-page (§8.19), Cmd/Ctrl+F. Reserved as actual layout space above
// the BrowserView (see tab-manager.js's recomputeBounds/startFind/
// stopFind) rather than an overlay on top of it — unlike every other
// popover/modal in this app, the whole point here is to keep the page
// itself visible while searching it, so hiding the BrowserView (this
// app's usual trick for chrome-drawn-on-top-of-the-page UI) isn't an
// option.
//
// Single-instance, chrome-level UI (like the address bar), not per-tab
// state — switching the active tab away from whichever one this was
// opened for closes it rather than silently continuing to search a page
// that's no longer on screen (see onActiveTabChanged).

export function createFindBar({ bar, input, count, prevBtn, nextBtn, closeBtn }) {
  let currentTabId = null;

  function isOpen() {
    return bar.classList.contains('show');
  }

  function open(tabId) {
    if (isOpen() && currentTabId === tabId) {
      // Already open for this tab — Cmd+F again just refocuses/selects,
      // same as real browsers, rather than resetting an in-progress search.
      input.focus();
      input.select();
      return;
    }
    currentTabId = tabId;
    bar.classList.add('show');
    input.value = '';
    count.textContent = '';
    input.focus();
  }

  function close() {
    if (!isOpen()) return;
    const tabId = currentTabId;
    currentTabId = null;
    bar.classList.remove('show');
    count.textContent = '';
    if (tabId) window.browserAPI.stopFind(tabId, 'clearSelection');
  }

  // `findNext: false` (every keystroke) restarts the search fresh;
  // `findNext: true` (Enter, Shift+Enter, the prev/next buttons) just
  // advances within the same search.
  function runSearch({ findNext = false, forward = true } = {}) {
    if (!currentTabId) return;
    const text = input.value;
    if (!text) count.textContent = '';
    window.browserAPI.find(currentTabId, text, { findNext, forward });
  }

  input.addEventListener('input', () => runSearch({ findNext: false }));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Shift+Enter steps backward, same convention as every other
      // find-in-page implementation.
      runSearch({ findNext: true, forward: !event.shiftKey });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  prevBtn.addEventListener('click', () => runSearch({ findNext: true, forward: false }));
  nextBtn.addEventListener('click', () => runSearch({ findNext: true, forward: true }));
  closeBtn.addEventListener('click', close);

  return {
    open,
    close,
    isOpen,
    onActiveTabChanged(newActiveTabId) {
      if (isOpen() && newActiveTabId !== currentTabId) close();
    },
    // Wired to browserAPI.onFindResult in index.js — main pushes one of
    // these per *fresh* search (not on every next/prev step; the count
    // doesn't change within the same search — see tab-manager.js's
    // startFind for why this is a plain match count, not a "3 of 12"
    // position).
    onResult({ tabId, matches }) {
      if (tabId !== currentTabId) return;
      if (!input.value) {
        count.textContent = '';
        return;
      }
      count.textContent = matches === 1 ? '1 match' : `${matches} matches`;
    },
  };
}
