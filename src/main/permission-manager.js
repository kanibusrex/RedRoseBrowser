'use strict';

const crypto = require('node:crypto');

const { MAIN_TO_RENDERER } = require('../shared/ipc-channels');

/**
 * Site permissions (§8.16) — a three-tier policy, replacing the blanket
 * deny-everything `installPermissionHandler` (security.js) used to be for
 * every per-profile session (that function is still what's installed on
 * the chrome window's own default session in index.js, which never shows
 * untrusted page content, so it stays a simple hard-coded backstop there):
 *
 *  - ALWAYS_ALLOW: low-risk, expected-to-just-work capabilities. No
 *    prompt, no persisted decision — same as real browsers, which don't
 *    ask permission for these either.
 *  - PROMPTABLE: the common, privacy-sensitive ones a real browser also
 *    prompts for. Asks once per origin, then remembers the answer
 *    (allow or deny) in PermissionStore so the same site isn't asked
 *    again.
 *  - Everything else: denied outright, no prompt, no exception. Matches
 *    this project's deny-by-default posture (DESIGN.md §7.9) for the
 *    long tail of permissions (display-capture, idle-detection,
 *    midiSysex, window-management, ...) a general-purpose browser has no
 *    pressing reason to ever grant in v1.
 */
const ALWAYS_ALLOW = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
const PROMPTABLE = new Set(['media', 'geolocation', 'notifications']);

// requestId -> { resolve }. Module-level (not per-profile) because a
// request id is a fresh crypto.randomUUID() each time — globally unique
// on its own — and ipc-handlers.js registers exactly one
// PERMISSION_RESPOND handler for the whole app, regardless of which
// profile's session actually issued the request it's resolving.
const pending = new Map();

function originOf(urlLike) {
  try {
    return new URL(urlLike).origin;
  } catch {
    return null;
  }
}

/**
 * Installs the policy above on one profile's session. `tabManager` is
 * that same profile's TabManager — used only to look up whether the
 * requesting webContents is the tab currently on screen (background-tab
 * requests are denied outright, never queued — see below) — and `win` is
 * the chrome window the prompt itself is rendered in.
 */
function installPermissionPolicy(profileSession, { win, tabManager, permissionStore, profileId }) {
  profileSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (ALWAYS_ALLOW.has(permission)) {
      callback(true);
      return;
    }
    if (!PROMPTABLE.has(permission)) {
      callback(false);
      return;
    }

    const origin = originOf((details && details.requestingUrl) || webContents.getURL());
    if (!origin) {
      callback(false);
      return;
    }

    const remembered = permissionStore.get(profileId, origin, permission);
    if (remembered === 'allow') {
      callback(true);
      return;
    }
    if (remembered === 'deny') {
      callback(false);
      return;
    }

    // No remembered decision. Only ever prompt for the tab the user is
    // actually looking at — a background tab (e.g. one still loading, or
    // one the user switched away from) gets denied outright rather than
    // queued, so a page nobody's looking at can't pile up prompts behind
    // whatever the user's doing right now. It's free to ask again if
    // that tab becomes the active one later.
    const requestingTabId = tabManager.getTabIdForWebContents(webContents);
    if (!requestingTabId || requestingTabId !== tabManager.activeTabId) {
      callback(false);
      return;
    }

    if (win.isDestroyed()) {
      callback(false); // no window left to prompt through — fail safe
      return;
    }

    const requestId = crypto.randomUUID();
    pending.set(requestId, {
      resolve: ({ allow, remember }) => {
        if (remember) permissionStore.set(profileId, origin, permission, allow ? 'allow' : 'deny');
        callback(allow);
      },
    });
    win.webContents.send(MAIN_TO_RENDERER.PERMISSION_REQUEST, {
      requestId,
      origin,
      permission,
      tabId: requestingTabId,
    });
  });

  if (typeof profileSession.setPermissionCheckHandler === 'function') {
    // Synchronous — Electron calls this to decide feature availability
    // (e.g. what navigator.permissions.query() reports) with no chance to
    // prompt, so it can only ever consult an already-remembered decision
    // (or the same always-allow set above); it never itself triggers a
    // prompt or writes to the store.
    profileSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      if (ALWAYS_ALLOW.has(permission)) return true;
      if (!PROMPTABLE.has(permission)) return false;
      const origin = originOf(requestingOrigin) || originOf(webContents.getURL());
      return !!origin && permissionStore.get(profileId, origin, permission) === 'allow';
    });
  }
}

// Called from ipc-handlers.js's PERMISSION_RESPOND handler once the user
// has answered the prompt in the chrome renderer (PermissionPrompt.js).
// A requestId with no matching entry (already resolved — e.g. the
// renderer answered twice — or the app restarted since it was issued) is
// silently ignored rather than treated as an error.
function resolvePendingPermission(requestId, { allow, remember } = {}) {
  const entry = pending.get(requestId);
  if (!entry) return;
  pending.delete(requestId);
  entry.resolve({ allow: !!allow, remember: !!remember });
}

module.exports = { installPermissionPolicy, resolvePendingPermission };
