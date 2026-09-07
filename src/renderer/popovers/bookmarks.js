'use strict';

// Popover content (§8.28) for the rail's bookmarks button: the active
// profile's saved bookmarks, click a row to open it, a remove button per
// row. Fetches its own data and subscribes to live updates directly —
// unlike the old Bookmarks.js, nothing is pushed in from the chrome
// window, since this renders in its own separate webContents now.

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

export function render(root) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover bookmarks-popover';
  root.appendChild(popover);

  function renderList(bookmarks) {
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
        window.browserAPI.createTab(bm.url);
        window.browserAPI.closePopover();
      });
      row.appendChild(title);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'bookmark-remove';
      removeBtn.title = 'Remove bookmark';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        window.browserAPI.removeBookmark(bm.id);
      });
      row.appendChild(removeBtn);

      popover.appendChild(row);
    }
  }

  window.browserAPI.onBookmarksChanged(({ bookmarks }) => renderList(bookmarks || []));
  window.browserAPI.listBookmarks().then(({ bookmarks }) => renderList(bookmarks || []));
}
