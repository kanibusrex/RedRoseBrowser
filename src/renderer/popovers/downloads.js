'use strict';

// Popover content (§8.28) for the rail's downloads button: in-progress
// downloads with a live progress bar, finished ones with Open/Show-in-
// folder actions. Subscribes to browserAPI.onDownloadsChanged directly —
// a download's whole point of being in this list is watching its
// progress change without needing to reopen the popover.

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
    const sizes =
      entry.totalBytes > 0
        ? `${formatBytes(entry.receivedBytes)} of ${formatBytes(entry.totalBytes)}`
        : formatBytes(entry.receivedBytes);
    return pct === null ? sizes : `${sizes} — ${pct}%`;
  }
  if (entry.state === 'completed') return formatBytes(entry.totalBytes || entry.receivedBytes);
  if (entry.state === 'cancelled') return 'Cancelled';
  return 'Failed';
}

export function render(root) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover downloads-popover';
  root.appendChild(popover);

  const list = document.createElement('div');
  list.className = 'downloads-list';
  popover.appendChild(list);

  const footer = document.createElement('div');
  footer.className = 'downloads-footer';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'downloads-clear';
  clearBtn.textContent = 'Clear finished downloads';
  clearBtn.addEventListener('click', () => window.browserAPI.clearDownloads());
  footer.appendChild(clearBtn);
  popover.appendChild(footer);

  function renderRows(downloads) {
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
        cancelBtn.addEventListener('click', () => window.browserAPI.cancelDownload(entry.id));
        actions.appendChild(cancelBtn);
      } else {
        if (entry.state === 'completed') {
          const openBtn = document.createElement('button');
          openBtn.className = 'download-action';
          openBtn.title = 'Open';
          openBtn.textContent = '↗';
          openBtn.addEventListener('click', () => window.browserAPI.openDownload(entry.id));
          actions.appendChild(openBtn);

          const showBtn = document.createElement('button');
          showBtn.className = 'download-action';
          showBtn.title = 'Show in folder';
          showBtn.textContent = '\u{1F4C1}';
          showBtn.addEventListener('click', () => window.browserAPI.showDownloadInFolder(entry.id));
          actions.appendChild(showBtn);
        }
        const removeBtn = document.createElement('button');
        removeBtn.className = 'download-action';
        removeBtn.title = 'Remove from list';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => window.browserAPI.removeDownloadEntry(entry.id));
        actions.appendChild(removeBtn);
      }

      row.appendChild(actions);
      list.appendChild(row);
    }
  }

  window.browserAPI.onDownloadsChanged(({ downloads }) => renderRows(downloads || []));
  window.browserAPI.listDownloads().then(({ downloads }) => renderRows(downloads || []));
}
