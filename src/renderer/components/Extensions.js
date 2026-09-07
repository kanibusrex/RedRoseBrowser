'use strict';

// The rail's extensions button: opens a popover (§8.28) to install/
// manage the active profile's extensions. The popover's own content
// (src/renderer/popovers/extensions.js) fetches and subscribes to the
// list itself, so this is just the trigger.

export function createExtensionsButton({ btn }) {
  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    window.browserAPI.showPopover('extensions', { x: rect.right + 8, y: rect.top });
  });
}
