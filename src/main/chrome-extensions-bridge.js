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
      const { tabId } = tabManager.createTab(details.url);
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
