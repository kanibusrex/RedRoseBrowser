'use strict';

const { app, Menu } = require('electron');

/**
 * Minimal application menu. Deliberately does not add custom menu items
 * for tab/navigation actions — those keyboard shortcuts (§1: Cmd/Ctrl+T,
 * +W, +L, +R, +[ / +], +Tab) are handled directly in the chrome renderer
 * (src/renderer/index.js) via a keydown listener calling window.browserAPI,
 * since they're pure UI-chrome actions that don't need main-process
 * privilege. This menu only provides the standard OS-level roles (quit,
 * copy/paste/undo, window management) users expect on each platform.
 */
function buildApplicationMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * DevTools stay available for engineering use via a hidden shortcut
 * (no menu entry, per DESIGN.md out-of-scope list) — F12 / Cmd+Alt+I —
 * toggled on whichever BrowserView is currently active.
 */
function attachDevToolsShortcut(chromeWin, profileManager) {
  chromeWin.webContents.on('before-input-event', (_event, input) => {
    const isToggle =
      input.type === 'keyDown' &&
      (input.key === 'F12' || (input.key.toLowerCase() === 'i' && input.alt && (input.meta || input.control)));
    if (!isToggle) return;
    const tabManager = profileManager.getActiveTabManager();
    const tab = tabManager.tabs.get(tabManager.activeTabId);
    if (tab) tab.view.webContents.toggleDevTools();
  });
}

module.exports = { buildApplicationMenu, attachDevToolsShortcut };
