'use strict';

// Popover content (§8.28) for a site-permission prompt (§8.16) — main
// pushes this whenever the active tab's page asks for a "promptable"
// permission (camera/mic, location, notifications) with no remembered
// decision yet. Unlike every other popover here (user-initiated, from a
// rail/toolbar click), this one is main-initiated — PermissionPrompt.js
// just forwards the request as this popover's `data` once it arrives.
//
// If this closes for any *other* reason (clicked outside, Escape, or a
// second popover opened over it), PopoverManager's onClose fallback
// (wired in ipc-handlers.js's POPOVER_SHOW handler) resolves the request
// as "deny, don't remember" on its own — this file only has to handle
// the two explicit buttons.

const PERMISSION_COPY = {
  media: 'use your camera and microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
};

export function render(root, { requestId, origin, permission }) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover permission-popover';

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

  const respond = async (allow) => {
    // Awaited so the explicit answer (which resolves the pending
    // permission request in main) is guaranteed to land before the
    // close that follows — the onClose fallback described above is a
    // no-op once the request's already resolved (resolvePendingPermission
    // is idempotent), but only if this really does arrive first.
    await window.browserAPI.respondToPermission(requestId, allow, true);
    window.browserAPI.closePopover();
  };

  const denyBtn = document.createElement('button');
  denyBtn.type = 'button';
  denyBtn.className = 'permission-btn deny';
  denyBtn.textContent = 'Block';
  denyBtn.addEventListener('click', () => respond(false));
  actions.appendChild(denyBtn);

  const allowBtn = document.createElement('button');
  allowBtn.type = 'button';
  allowBtn.className = 'permission-btn allow';
  allowBtn.textContent = 'Allow';
  allowBtn.addEventListener('click', () => respond(true));
  actions.appendChild(allowBtn);

  popover.appendChild(actions);
  root.appendChild(popover);
}
