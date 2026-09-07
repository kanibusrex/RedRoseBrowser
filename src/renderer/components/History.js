'use strict';

// The rail's history button: opens a popover (§8.28) listing the active
// profile's recent browsing history. The popover's own content
// (src/renderer/popovers/history.js) fetches and searches it directly,
// so this is just the trigger.

export function createHistoryButton({ btn }) {
  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    window.browserAPI.showPopover('history', { x: rect.right + 8, y: rect.top });
  });
}
