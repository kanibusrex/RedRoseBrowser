'use strict';

// Popover content (§8.28) for a tab group's color-dot button: a palette
// grid, click a swatch to recolor the group.

import { GROUP_COLORS } from '../components/GroupColors.js';

export function render(root, { groupId, currentColor }) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover group-color-popover';

  const grid = document.createElement('div');
  grid.className = 'group-color-grid';
  for (const c of GROUP_COLORS) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'group-color-sw' + (c.name === currentColor ? ' selected' : '');
    sw.style.background = c.hex;
    sw.title = c.name;
    sw.addEventListener('click', () => {
      window.browserAPI.setGroupColor(groupId, c.name);
      window.browserAPI.closePopover();
    });
    grid.appendChild(sw);
  }
  popover.appendChild(grid);

  root.appendChild(popover);
}
