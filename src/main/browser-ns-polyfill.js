'use strict';

// Chromium's built-in `browser.*` WebExtension-compat global (used by
// extensions written for cross-browser/Firefox compatibility, e.g.
// `browser.windows.WINDOW_ID_NONE`) only mirrors a SUBSET of `chrome.*`
// in Electron — confirmed empirically: `browser.tabs`/`browser.runtime`
// exist, but `browser.windows`, `browser.storage`, `browser.permissions`,
// and `browser.contextMenus` do not, even though the `chrome.*`
// equivalents work fine (electron-chrome-extensions patches those — see
// chrome-extensions-bridge.js / DESIGN.md §8.8.1). Extensions that
// reference the missing `browser.*` namespaces crash their whole
// background/service-worker script on the first such reference (seen in
// both uBlock Origin Lite and 1Password's extension), before any of the
// rest of their code — including unrelated functionality — ever runs.
//
// A `service-worker`-type `session.registerPreloadScript` was tried
// first (Electron supports that context type explicitly) but doesn't
// work: empirically, `chrome`/`browser` are still `undefined` inside
// it, meaning it runs in a separate realm from the extension's own
// script rather than sharing globals with it. What does work: this
// file's *source* is prepended directly into the extension's own
// background entry file on disk at install time (see
// `_injectBrowserPolyfill` in extension-manager.js) — same realm, same
// timing, so by the time it runs, Chromium's own `chrome`/`browser`
// bindings are already in place (confirmed the rest of the extension's
// code can use them). Deliberately generic — aliases ANY missing
// `browser.X` to the working `chrome.X`, not just the specific
// namespaces found crashing so far, since other extensions may hit
// different gaps.
(function patchBrowserNamespace() {
  if (typeof browser === 'undefined' || typeof chrome === 'undefined') return;
  for (const key of Object.keys(chrome)) {
    if (browser[key] === undefined && chrome[key] !== undefined) {
      try {
        browser[key] = chrome[key];
      } catch {
        /* some chrome.* properties are non-configurable getters — skip those */
      }
    }
  }
})();
