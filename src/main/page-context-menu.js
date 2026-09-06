'use strict';

const { Menu, clipboard } = require('electron');

const { resolveNavigationTarget } = require('./navigation');

/**
 * The page-content right-click menu (§8.22) — previously nonexistent:
 * right-clicking anywhere on a page did nothing at all, no menu, since
 * Electron's `context-menu` webContents event fires but shows nothing on
 * its own unless something builds and pops a `Menu`. This is that
 * something, wired from `TabManager._wireWebContents`.
 *
 * "Inspect Element" is included here deliberately, despite DESIGN.md §1
 * keeping dev tools out of the application menu bar ("dev tools can stay
 * available via a hidden shortcut for engineering use, just no menu
 * entry") — that scope call was about the app's own chrome menu, not a
 * page's own right-click menu, where Inspect Element is a normal,
 * expected browser affordance for regular users and engineering use
 * alike, not an internal-only tool.
 *
 * Every action here operates on data Electron's own `context-menu` event
 * already vetted as belonging to this exact click (`params.linkURL`,
 * `params.srcURL`, ...) — the one thing still treated as untrusted,
 * page-supplied input is a link/image URL actually being *navigated to*,
 * which goes through `createTab()`'s normal (untrusted) path exactly like
 * any other address-bar/page-initiated navigation.
 */
// Split out from showPageContextMenu() so tests can inspect the plain
// template (labels, enabled states, click behavior) without ever
// triggering Menu.buildFromTemplate/.popup(), which would show a real,
// blocking native menu.
function buildPageContextMenuTemplate({ webContents, params, tabManager, tabId, searchEngineUrl }) {
  const items = [];

  if (params.linkURL) {
    items.push({
      label: 'Open Link in New Tab',
      click: () => tabManager.createTab(params.linkURL),
    });
    items.push({
      label: 'Copy Link Address',
      click: () => clipboard.writeText(params.linkURL),
    });
    items.push({ type: 'separator' });
  }

  if (params.mediaType === 'image' && params.srcURL) {
    items.push({
      label: 'Open Image in New Tab',
      click: () => tabManager.createTab(params.srcURL),
    });
    items.push({
      label: 'Copy Image',
      click: () => webContents.copyImageAt(params.x, params.y),
    });
    items.push({
      label: 'Copy Image Address',
      click: () => clipboard.writeText(params.srcURL),
    });
    items.push({
      // Reuses the exact same session.downloadURL() -> 'will-download'
      // path a normal download does — download-manager.js (§8.21) tracks
      // this identically to a link the user clicked to download.
      label: 'Save Image As…',
      click: () => webContents.downloadURL(params.srcURL),
    });
    items.push({ type: 'separator' });
  }

  if (params.isEditable) {
    items.push({ label: 'Cut', enabled: params.editFlags.canCut, click: () => webContents.cut() });
    items.push({ label: 'Copy', enabled: params.editFlags.canCopy, click: () => webContents.copy() });
    items.push({ label: 'Paste', enabled: params.editFlags.canPaste, click: () => webContents.paste() });
    items.push({ label: 'Select All', enabled: params.editFlags.canSelectAll, click: () => webContents.selectAll() });
    items.push({ type: 'separator' });
  } else if (params.selectionText) {
    items.push({ label: 'Copy', click: () => webContents.copy() });
    const query = params.selectionText.trim();
    if (query) {
      const label = query.length > 40 ? `${query.slice(0, 40)}…` : query;
      items.push({
        label: `Search for “${label}”`,
        // The search URL is built here from this app's own trusted
        // search-engine template (§8.24), not passed through as raw page
        // content — trusted the same way openExtensionPage's app-
        // constructed URLs are, not because the selected *text* itself
        // is trusted (encodeURIComponent inside resolveNavigationTarget
        // neutralizes it either way).
        click: () => tabManager.createTab(resolveNavigationTarget(query, searchEngineUrl), { trusted: true }),
      });
    }
    items.push({ type: 'separator' });
  }

  if (!params.isEditable) {
    // Same navigationHistory-with-fallback feature detection
    // TabManager's own goBack/goForward already use, kept in sync here
    // rather than reused directly since this only needs the booleans,
    // not the actual navigation call.
    const canGoBack =
      webContents.navigationHistory && typeof webContents.navigationHistory.canGoBack === 'function'
        ? webContents.navigationHistory.canGoBack()
        : webContents.canGoBack();
    const canGoForward =
      webContents.navigationHistory && typeof webContents.navigationHistory.canGoForward === 'function'
        ? webContents.navigationHistory.canGoForward()
        : webContents.canGoForward();
    items.push({ label: 'Back', enabled: canGoBack, click: () => tabManager.goBack(tabId) });
    items.push({ label: 'Forward', enabled: canGoForward, click: () => tabManager.goForward(tabId) });
    items.push({ label: 'Reload', click: () => tabManager.reload(tabId) });
    items.push({ type: 'separator' });
  }

  items.push({
    label: 'Inspect Element',
    click: () => webContents.inspectElement(params.x, params.y),
  });

  return items;
}

function showPageContextMenu({ webContents, win, params, tabManager, tabId, searchEngineUrl }) {
  const items = buildPageContextMenuTemplate({ webContents, params, tabManager, tabId, searchEngineUrl });
  Menu.buildFromTemplate(items).popup({ window: win });
}

module.exports = { showPageContextMenu, buildPageContextMenuTemplate };
