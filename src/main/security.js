'use strict';

const path = require('node:path');
const { isMaliciousUrl } = require('./blocklist');

/**
 * Centralizes the non-negotiable security defaults from DESIGN.md §7.
 * Nothing here should ever be relaxed without a written justification
 * and a second reviewer per the design doc.
 */

const CHROME_PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'chrome-preload.js');
const PAGE_PRELOAD_PATH = path.join(__dirname, '..', 'preload', 'page-preload.js');

// webPreferences for the top-level chrome BrowserWindow (§7.1, §7.2, §7.3).
// Even though it only ever loads trusted local HTML, it gets the same
// hardened defaults as everything else.
function chromeWindowWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: CHROME_PRELOAD_PATH,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
  };
}

// webPreferences for every per-tab BrowserView (§2.3 / §7). Copied verbatim
// from the design doc — do not add capabilities here without updating
// DESIGN.md and getting review. `session` is the owning profile's session
// (see ProfileManager) — every tab in a profile shares that profile's
// session so cookies/storage/cache stay isolated per profile; passing no
// session falls back to Electron's default session (single-profile use).
function pageViewWebPreferences(session) {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    preload: PAGE_PRELOAD_PATH,
    javascript: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    ...(session ? { session } : {}),
  };
}

// Schemes a page-initiated top-level navigation must never be allowed to
// reach (§7.8). Allowlist-by-default would be even stricter, but a
// denylist of privileged/local schemes plus normal http(s)/about is the
// documented policy here.
const BLOCKED_NAVIGATION_SCHEMES = new Set([
  'file:',
  'chrome:',
  'chrome-extension:',
  'devtools:',
  'view-source:',
  'data:', // avoid data: URI top-level nav tricks (still fine as sub-resources)
  'javascript:',
]);

function isNavigationAllowed(targetUrl) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  return !BLOCKED_NAVIGATION_SCHEMES.has(parsed.protocol);
}

// Combines the scheme policy above with the local malicious-hostname
// blocklist (§8.7 / blocklist.js) into one classification, so every
// navigation entry point (address bar, page-initiated navigate/redirect,
// window.open) can both enforce the same policy and show the right
// explanation on the error page (a scheme block and a malicious-site
// block are different situations for the user).
function classifyNavigation(targetUrl) {
  if (!isNavigationAllowed(targetUrl)) return 'scheme';
  if (isMaliciousUrl(targetUrl)) return 'malicious';
  return 'ok';
}

// Deny-by-default permission handler (§7.9) — no UI to prompt the user
// yet in v1, so every permission request (camera, mic, geolocation,
// notifications, etc.) is refused.
function installPermissionHandler(session) {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  if (typeof session.setPermissionCheckHandler === 'function') {
    session.setPermissionCheckHandler(() => false);
  }
}

module.exports = {
  CHROME_PRELOAD_PATH,
  PAGE_PRELOAD_PATH,
  chromeWindowWebPreferences,
  pageViewWebPreferences,
  isNavigationAllowed,
  classifyNavigation,
  installPermissionHandler,
};
