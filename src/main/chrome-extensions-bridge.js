'use strict';

const { ElectronChromeExtensions } = require('electron-chrome-extensions');

/**
 * Electron's own built-in extension support (session.extensions) only
 * implements a bare minimum aimed at DevTools use cases — no chrome.tabs,
 * chrome.windows, chrome.contextMenus, or chrome.webNavigation. Real
 * extensions (ad blockers especially) depend on those, so without this
 * bridge they load but crash or silently no-op (see DESIGN.md §8.8).
 *
 * electron-chrome-extensions fills that gap. It's GPL-3.0 licensed (this
 * project is GPL-3.0 too, specifically because of this dependency — see
 * LICENSE and DESIGN.md §8.8's "Making extensions actually work" section).
 *
 * One instance per profile, tied to that profile's session and TabManager,
 * so chrome.tabs.query() etc. only ever see that profile's own tabs —
 * consistent with every other piece of per-profile isolation in this app.
 */
function createExtensionsBridge({ win, session: profileSession, tabManager }) {
  return new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: profileSession,

    createTab(details) {
      // This callback only ever fires for `chrome.tabs.create()`, an
      // extension-only API — a plain web page cannot reach it at all.
      // MV3 extensions favor it over window.open (unreliable from a
      // service worker) for exactly this "open my settings page in a
      // full tab" pattern (found via 1Password's own settings link,
      // which uses it — §8.13/§8.14's same-extension fixes covered
      // will-navigate and window.open, not this, a third, separate
      // path). A chrome-extension: target here is trusted unconditionally
      // for that reason — only extension code, not page content, can ask
      // for one. Anything else an extension requests (a plain https:
      // URL, say) still goes through the normal scheme/malicious-site
      // check, so a compromised extension can't use this API to reach
      // file:/javascript: or a known-bad site.
      const trusted = typeof details.url === 'string' && details.url.startsWith('chrome-extension://');
      const { tabId } = tabManager.createTab(details.url, { trusted });
      const webContents = tabManager.getWebContents(tabId);
      return [webContents, win];
    },

    selectTab(webContents) {
      const tabId = tabManager.getTabIdForWebContents(webContents);
      if (tabId) tabManager.activateTab(tabId);
    },

    removeTab(webContents) {
      const tabId = tabManager.getTabIdForWebContents(webContents);
      if (tabId) tabManager.closeTab(tabId);
    },
  });
}

module.exports = { createExtensionsBridge };
