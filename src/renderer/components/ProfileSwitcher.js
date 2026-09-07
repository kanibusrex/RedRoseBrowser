'use strict';

// The rail glyph doubles as the profile switcher's entry point: opens a
// popover (§8.28) listing profiles, switch/rename/delete/create. The
// popover's own content (src/renderer/popovers/profileSwitcher.js)
// fetches and subscribes to the profile list itself, so this is just the
// trigger.

export function createProfileSwitcher({ glyphBtn }) {
  glyphBtn.addEventListener('click', () => {
    const rect = glyphBtn.getBoundingClientRect();
    window.browserAPI.showPopover('profileSwitcher', { x: rect.right + 8, y: rect.top });
  });
}
