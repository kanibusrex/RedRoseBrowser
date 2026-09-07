'use strict';

// Popover content (§8.28) for a tab row's right-click context menu.
// `data` (from TabStrip.js's openTabMenu, at the moment it's right-
// clicked) carries the specific tab's own state — pinned/groupId/
// splitWithTabId — plus the other groups it could move to, since none of
// that lives in this popover's own separate webContents.

export function render(root, { tabId, pinned, groupId, splitWithTabId, groups }) {
  const items = [];

  items.push({
    label: pinned ? 'Unpin tab' : 'Pin tab',
    onClick: () => window.browserAPI.pinTab(tabId, !pinned),
  });

  if (groupId) {
    items.push({ label: 'Remove from group', onClick: () => window.browserAPI.setTabGroup(tabId, null) });
  }
  items.push({ label: 'New group from tab', onClick: () => window.browserAPI.createGroup(undefined, undefined, tabId) });
  for (const group of groups || []) {
    if (group.id === groupId) continue;
    items.push({ label: `Move to “${group.name}”`, onClick: () => window.browserAPI.setTabGroup(tabId, group.id) });
  }

  if (splitWithTabId) {
    items.push({ separator: true });
    items.push({ label: 'Close split view', onClick: () => window.browserAPI.unsplitTab(tabId) });
  }

  items.push({ separator: true });
  items.push({ label: 'Close tab', danger: true, onClick: () => window.browserAPI.closeTab(tabId) });

  const menu = document.createElement('div');
  menu.className = 'popup-menu';

  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'popup-sep';
      menu.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'popup-item' + (item.danger ? ' danger' : '');
    btn.type = 'button';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      item.onClick();
      window.browserAPI.closePopover();
    });
    menu.appendChild(btn);
  }

  root.appendChild(menu);
}
