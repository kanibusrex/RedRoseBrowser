'use strict';

// Popover content (§8.28) for the rail's history button: a search box,
// the active profile's matching history entries (newest first), and a
// "Clear all history" action. No live-push subscription, same as the old
// History.js — fetches fresh on open and on every search keystroke.

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

export function render(root) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover history-popover';
  root.appendChild(popover);

  let currentQuery = '';

  const searchWrap = document.createElement('div');
  searchWrap.className = 'history-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search history';
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
    window.browserAPI.clearHistory().then(renderRows);
  });
  footer.appendChild(clearBtn);
  popover.appendChild(footer);

  const renderRows = async () => {
    const { entries } = await window.browserAPI.listHistory(currentQuery);
    list.innerHTML = '';
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = currentQuery ? 'No matching history.' : 'No history yet.';
      list.appendChild(empty);
      // No manual reposition/reportSize call needed here (unlike the old
      // History.js) — popover.js's ResizeObserver on this popover's own
      // element picks up any size change from this async re-render (or
      // the search box's keystrokes below) automatically.
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
        window.browserAPI.closePopover();
      });
      row.appendChild(info);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'history-remove';
      removeBtn.title = 'Remove from history';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        window.browserAPI.removeHistoryEntry(entry.id).then(renderRows);
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    }
  };

  searchInput.addEventListener('input', () => {
    currentQuery = searchInput.value;
    renderRows();
  });

  renderRows();
  searchInput.focus();
}
