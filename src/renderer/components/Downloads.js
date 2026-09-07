'use strict';

// The rail's downloads button: opens a popover (§8.28) listing the
// active profile's downloads. The popover's own content
// (src/renderer/popovers/downloads.js) fetches the list and subscribes
// to live progress updates itself; this file just wires the trigger and
// keeps the rail button's own "something's downloading" badge current,
// since that's chrome-window DOM the popover has no reason to reach back
// into.

export function createDownloadsButton({ btn }) {
  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    window.browserAPI.showPopover('downloads', { x: rect.right + 8, y: rect.top });
  });

  return {
    render(list) {
      const downloads = list || [];
      btn.classList.toggle('has-active-download', downloads.some((d) => d.state === 'progressing'));
    },
  };
}
