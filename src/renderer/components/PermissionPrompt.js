'use strict';

// Site-permission prompts (§8.16) — main pushes one of these whenever the
// active tab's page asks for a "promptable" permission (camera/mic,
// location, notifications) with no remembered decision yet
// (permission-manager.js). Unlike every other popover in this app (all
// user-initiated, from a rail/toolbar button), this one originates from
// something a *page* did, so it's driven by an incoming IPC event rather
// than a click handler here.
//
// The active view being hidden while this is open (so the popover isn't
// painted over by the BrowserView) is handled by ContextMenu.js itself
// now (§8.27) — every popup it shows does this, not just this one.

import { showPopover, closePopup } from './ContextMenu.js';

const PERMISSION_COPY = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
};

export function initPermissionPrompts({ securityIcon }) {
  window.browserAPI.onPermissionRequest((request) => {
    showPrompt(request, securityIcon);
  });
}

function showPrompt({ requestId, origin, permission }, anchorEl) {
  let settled = false;

  const finish = (allow, remember) => {
    if (settled) return;
    settled = true;
    observer.disconnect();
    window.browserAPI.respondToPermission(requestId, allow, remember);
  };

  const rect = anchorEl.getBoundingClientRect();
  const popoverEl = showPopover(
    (popover) => {
      popover.classList.add('permission-popover');

      const originEl = document.createElement('div');
      originEl.className = 'permission-origin';
      originEl.textContent = origin;
      popover.appendChild(originEl);

      const desc = document.createElement('div');
      desc.className = 'permission-desc';
      desc.textContent = `wants to ${PERMISSION_COPY[permission] || permission}.`;
      popover.appendChild(desc);

      const actions = document.createElement('div');
      actions.className = 'permission-actions';

      const denyBtn = document.createElement('button');
      denyBtn.type = 'button';
      denyBtn.className = 'permission-btn deny';
      denyBtn.textContent = 'Block';
      denyBtn.addEventListener('click', () => {
        closePopup();
        finish(false, true);
      });
      actions.appendChild(denyBtn);

      const allowBtn = document.createElement('button');
      allowBtn.type = 'button';
      allowBtn.className = 'permission-btn allow';
      allowBtn.textContent = 'Allow';
      allowBtn.addEventListener('click', () => {
        closePopup();
        finish(true, true);
      });
      actions.appendChild(allowBtn);

      popover.appendChild(actions);
    },
    { x: rect.right - 260, y: rect.bottom + 8 },
    { className: 'permission-popover-wrap' }
  );

  // Dismissed without an explicit choice (clicked outside, Escape, or a
  // second popover/modal opened over it) — treat it as "not now": deny
  // this one request, but don't remember it, so the site can ask again
  // later instead of being silently blocked forever.
  const observer = new MutationObserver(() => {
    if (!popoverEl.isConnected) finish(false, false);
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
