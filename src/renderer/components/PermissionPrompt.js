'use strict';

// Site-permission prompts (§8.16) — main pushes one of these whenever the
// active tab's page asks for a "promptable" permission (camera/mic,
// location, notifications) with no remembered decision yet
// (permission-manager.js). Unlike every other popover in this app (all
// user-initiated, from a rail/toolbar button), this one originates from
// something a *page* did, so it's driven by an incoming IPC event rather
// than a click handler here.
//
// The popover's own content (src/renderer/popovers/permission.js) does
// the rendering and the explicit Allow/Block handling now (§8.28); this
// just forwards the request as that popover's `data`. The "dismissed
// without an explicit answer" fallback (deny, don't remember) that used
// to be a MutationObserver here watching for this popover's own DOM node
// going away lives in main now instead — PopoverManager's onClose,
// wired up in ipc-handlers.js's POPOVER_SHOW handler — since that's the
// one thing here that has to keep working no matter *how* the popover
// closes, not just through this document's own DOM.

export function initPermissionPrompts({ securityIcon }) {
  window.browserAPI.onPermissionRequest(({ requestId, origin, permission }) => {
    const rect = securityIcon.getBoundingClientRect();
    window.browserAPI.showPopover(
      'permission',
      { x: rect.right - 260, y: rect.bottom + 8 },
      { requestId, origin, permission }
    );
  });
}
