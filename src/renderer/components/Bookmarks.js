'use strict';

// The rail's bookmarks button: opens a popover listing the active
// profile's saved bookmarks (favicon, title, a remove button), click a
// row to open it in a new tab. Scoped per profile — index.js re-renders
// this whenever main pushes a fresh bookmarks:changed (including on
// profile switch, since bookmarks live in ProfileManager per profile).

import { showPopover, closePopup } from './ContextMenu.js';

const ALLOWED_FAVICON_SCHEMES = new Set(['http:', 'https:', 'data:']);

function faviconStyle(el, favicon) {
  el.style.backgroundImage = '';
  if (!favicon) return;
  let parsed;
  try {
    parsed = new URL(favicon);
  } catch {
    return;
  }
  if (!ALLOWED_FAVICON_SCHEMES.has(parsed.protocol)) return;
  if (parsed.protocol === 'data:' && !/^data:image\//i.test(parsed.href)) return;
  el.style.backgroundImage = `url("${parsed.href}")`;
}

export function createBookmarksButton({ btn }, { onOpen, onRemove }) {
  let bookmarks = [];
  let openPopoverEl = null;

  function renderList(popover) {
    popover.innerHTML = '';

    if (bookmarks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bookmarks-empty';
      empty.textContent = 'No bookmarks yet — click the star in the address bar to save a page.';
      popover.appendChild(empty);
      return;
    }

    for (const bm of bookmarks) {
      const row = document.createElement('div');
      row.className = 'bookmark-row';

      const icon = document.createElement('div');
      icon.className = 'bookmark-favicon';
      faviconStyle(icon, bm.favicon);
      row.appendChild(icon);

      const title = document.createElement('span');
      title.className = 'bookmark-title';
      title.textContent = bm.title || bm.url;
      title.title = bm.url;
      title.addEventListener('click', () => {
        onOpen(bm.url);
        closePopup();
      });
      row.appendChild(title);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'bookmark-remove';
      removeBtn.title = 'Remove bookmark';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        onRemove(bm.id);
      });
      row.appendChild(removeBtn);

      popover.appendChild(row);
    }
  }

  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    openPopoverEl = showPopover(
      (popover) => renderList(popover),
      { x: rect.right + 8, y: rect.top },
      { className: 'bookmarks-popover' }
    );
  });

  return {
    render(list) {
      bookmarks = list || [];
      // If the popover is already open (e.g. the user just removed a
      // bookmark from it, or toggled the star while it was open), refresh
      // its contents in place instead of waiting for the next open.
      if (openPopoverEl && openPopoverEl.isConnected) renderList(openPopoverEl);
      else openPopoverEl = null;
    },
  };
}
