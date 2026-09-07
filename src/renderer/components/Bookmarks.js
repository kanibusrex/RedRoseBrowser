'use strict';

// The rail's bookmarks button: opens a popover (§8.28 — a genuine overlay
// on top of the page, its own small BrowserView, not a `<div>` in this
// document) listing the active profile's saved bookmarks. The popover's
// own content (src/renderer/popovers/bookmarks.js) fetches and
// subscribes to the bookmark list itself, so this is just the trigger.

export function createBookmarksButton({ btn }) {
  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    window.browserAPI.showPopover('bookmarks', { x: rect.right + 8, y: rect.top });
  });
}
