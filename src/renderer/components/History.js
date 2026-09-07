'use strict';

// The rail's history button: opens a popover listing the active
// profile's recent browsing history, newest first, with a search box and
// a "Clear all history" action. Unlike Bookmarks.js/Extensions.js this
// has no live-push subscription (§8.20) — it fetches fresh every time
// it's opened and every time the search box changes, rather than main
// pushing an update on every single navigation.

import { showPopover, closePopup, repositionCurrentPopup } from './ContextMenu.js';

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

function formatVisitedAt(ms) {
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export function createHistoryButton({ btn }, { onQuery, onRemove, onClear }) {
  let currentQuery = '';

  async function renderList(popover) {
    popover.innerHTML = '';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'history-search';
    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = 'Search history';
    searchInput.value = currentQuery;
    searchInput.autocomplete = 'off';
    searchWrap.appendChild(searchInput);
    popover.appendChild(searchWrap);

    const list = document.createElement('div');
    list.className = 'history-list';
    popover.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'history-footer';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'history-clear';
    clearBtn.textContent = 'Clear all history';
    clearBtn.addEventListener('click', () => {
      if (!window.confirm('Clear all history for this profile? This cannot be undone.')) return;
      onClear().then(renderRows);
    });
    footer.appendChild(clearBtn);
    popover.appendChild(footer);

    const renderRows = async () => {
      const entries = await onQuery(currentQuery);
      list.innerHTML = '';
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-empty';
        empty.textContent = currentQuery ? 'No matching history.' : 'No history yet.';
        list.appendChild(empty);
        // Re-clamps this popover's position/height against however tall
        // it actually is now — a search result count (or the initial
        // fetch, both async) changing the popover's height *after* it
        // was first positioned would otherwise leave it positioned for
        // whatever size it happened to be before that content arrived
        // (§8.26 — "the history menu is getting cut off").
        repositionCurrentPopup();
        return;
      }
      for (const entry of entries) {
        const row = document.createElement('div');
        row.className = 'history-row';

        const icon = document.createElement('div');
        icon.className = 'history-favicon';
        faviconStyle(icon, entry.favicon);
        row.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'history-info';
        const title = document.createElement('div');
        title.className = 'history-title';
        title.textContent = entry.title || entry.url;
        title.title = entry.url;
        const meta = document.createElement('div');
        meta.className = 'history-meta';
        meta.textContent = formatVisitedAt(entry.visitedAt);
        info.appendChild(title);
        info.appendChild(meta);
        info.addEventListener('click', () => {
          window.browserAPI.createTab(entry.url);
          closePopup();
        });
        row.appendChild(info);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'history-remove';
        removeBtn.title = 'Remove from history';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          onRemove(entry.id).then(renderRows);
        });
        row.appendChild(removeBtn);

        list.appendChild(row);
      }
      repositionCurrentPopup();
    };

    searchInput.addEventListener('input', () => {
      currentQuery = searchInput.value;
      renderRows();
    });

    await renderRows();
  }

  btn.addEventListener('click', () => {
    currentQuery = '';
    const rect = btn.getBoundingClientRect();
    showPopover((popover) => renderList(popover), { x: rect.right + 8, y: rect.top }, { className: 'history-popover' });
  });
}
