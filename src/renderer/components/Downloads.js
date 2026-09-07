'use strict';

// The rail's downloads button: opens a popover listing the active
// profile's downloads — in-progress ones with a live progress bar
// (§8.21), finished ones with Open/Show-in-folder actions. Unlike
// History.js this DOES get a live push subscription
// (browserAPI.onDownloadsChanged) — a download's whole point of being in
// a list is watching its progress change, not something you'd expect to
// have to reopen the popover to see.

import { showPopover, repositionCurrentPopup } from './ContextMenu.js';

function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

function statusText(entry) {
  if (entry.state === 'progressing') {
    const pct = entry.totalBytes > 0 ? Math.round((entry.receivedBytes / entry.totalBytes) * 100) : null;
    const sizes = entry.totalBytes > 0 ? `${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.totalBytes)}` : formatBytes(entry.receivedBytes);
    return pct === null ? sizes : `${sizes} — ${pct}%`;
  }
  if (entry.state === 'completed') return formatBytes(entry.totalBytes || entry.receivedBytes);
  if (entry.state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

export function createDownloadsButton({ btn }, { onCancel, onRemove, onClear, onOpen, onShowInFolder }) {
  let downloads = [];
  let openPopoverEl = null;

  function renderRows(list) {
    list.innerHTML = '';
    if (downloads.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'downloads-empty';
      empty.textContent = 'No downloads yet.';
      list.appendChild(empty);
      return;
    }

    for (const entry of downloads) {
      const row = document.createElement('div');
      row.className = 'download-row';

      const info = document.createElement('div');
      info.className = 'download-info';

      const name = document.createElement('div');
      name.className = 'download-filename';
      name.textContent = entry.filename;
      name.title = entry.filename;
      info.appendChild(name);

      const status = document.createElement('div');
      status.className = 'download-status';
      status.textContent = statusText(entry);
      info.appendChild(status);

      if (entry.state === 'progressing') {
        const track = document.createElement('div');
        track.className = 'download-progress-track';
        const fill = document.createElement('div');
        fill.className = 'download-progress-fill';
        if (entry.totalBytes > 0) {
          fill.style.width = `${Math.min(100, (entry.receivedBytes / entry.totalBytes) * 100)}%`;
        } else {
          fill.classList.add('indeterminate');
        }
        track.appendChild(fill);
        info.appendChild(track);
      }

      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'download-actions';

      if (entry.state === 'progressing') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'download-action';
        cancelBtn.title = 'Cancel';
        cancelBtn.textContent = '×';
        cancelBtn.addEventListener('click', () => onCancel(entry.id));
        actions.appendChild(cancelBtn);
      } else {
        if (entry.state === 'completed') {
          const openBtn = document.createElement('button');
          openBtn.className = 'download-action';
          openBtn.title = 'Open';
          openBtn.textContent = '↗'; // ↗
          openBtn.addEventListener('click', () => onOpen(entry.id));
          actions.appendChild(openBtn);

          const showBtn = document.createElement('button');
          showBtn.className = 'download-action';
          showBtn.title = 'Show in folder';
          showBtn.textContent = '\u{1F4C1}'; // 📁
          showBtn.addEventListener('click', () => onShowInFolder(entry.id));
          actions.appendChild(showBtn);
        }
        const removeBtn = document.createElement('button');
        removeBtn.className = 'download-action';
        removeBtn.title = 'Remove from list';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => onRemove(entry.id));
        actions.appendChild(removeBtn);
      }

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  function renderPopover(popover) {
    popover.innerHTML = '';
    const list = document.createElement('div');
    list.className = 'downloads-list';
    popover.appendChild(list);
    renderRows(list);

    const footer = document.createElement('div');
    footer.className = 'downloads-footer';
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'downloads-clear';
    clearBtn.textContent = 'Clear finished downloads';
    clearBtn.addEventListener('click', () => onClear());
    footer.appendChild(clearBtn);
    popover.appendChild(footer);
  }

  btn.addEventListener('click', () => {
    const rect = btn.getBoundingClientRect();
    openPopoverEl = showPopover((popover) => renderPopover(popover), { x: rect.right + 8, y: rect.top }, { className: 'downloads-popover' });
  });

  return {
    render(list) {
      downloads = list || [];
      btn.classList.toggle('has-active-download', downloads.some((d) => d.state === 'progressing'));
      if (openPopoverEl && openPopoverEl.isConnected) {
        renderPopover(openPopoverEl);
        // This live update (browserAPI.onDownloadsChanged) doesn't go
        // through showPopover() — a growing download list can change
        // this popover's height with nothing to re-clamp it otherwise
        // (§8.26, same underlying issue as History.js's async fetch).
        repositionCurrentPopup();
      } else {
        openPopoverEl = null;
      }
    },
  };
}
