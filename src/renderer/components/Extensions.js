'use strict';

// The rail's extensions button: opens a popover to install a Chrome
// extension from a Web Store URL/ID and manage the active profile's
// installed set (enable/disable, remove). Scoped per profile — index.js
// re-renders this on extensions:changed, including on profile switch.

import { showPopover } from './ContextMenu.js';

function fallbackLetter(name) {
  return ((name || '?').trim()[0] || '?').toUpperCase();
}

export function createExtensionsButton({ btn }, { onInstall, onRemove, onSetEnabled, onOpenPage }) {
  let extensions = [];
  let openPopoverEl = null;
  let installing = false;
  let lastError = '';

  function renderList(popover) {
    popover.innerHTML = '';

    const installRow = document.createElement('div');
    installRow.className = 'ext-install';
    installRow.innerHTML = `
      <input type="text" class="ext-install-input" placeholder="Chrome Web Store URL or extension ID" />
      <button type="button" class="ext-install-btn">Install</button>
    `;
    const input = installRow.querySelector('.ext-install-input');
    const installBtn = installRow.querySelector('.ext-install-btn');

    if (installing) {
      installBtn.textContent = 'Installing…';
      installBtn.disabled = true;
      input.disabled = true;
    }

    const submit = async () => {
      const ref = input.value.trim();
      if (!ref || installing) return;
      installing = true;
      lastError = '';
      renderList(popover);
      try {
        await onInstall(ref);
        lastError = '';
      } catch (err) {
        lastError = err?.message || String(err);
      } finally {
        installing = false;
        renderList(popover);
      }
    };

    installBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    popover.appendChild(installRow);

    if (lastError) {
      const err = document.createElement('div');
      err.className = 'ext-error';
      err.textContent = lastError;
      popover.appendChild(err);
    }

    const sep = document.createElement('div');
    sep.className = 'popup-sep';
    popover.appendChild(sep);

    if (extensions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'bookmarks-empty';
      empty.textContent = 'No extensions installed for this profile yet.';
      popover.appendChild(empty);
      return;
    }

    for (const ext of extensions) {
      const row = document.createElement('div');
      row.className = 'ext-row';

      const icon = document.createElement('div');
      icon.className = 'ext-icon';
      icon.textContent = fallbackLetter(ext.name);
      row.appendChild(icon);

      const meta = document.createElement('div');
      meta.className = 'ext-meta';
      const name = document.createElement('span');
      name.className = 'ext-name';
      name.textContent = ext.name;
      name.title = ext.description || ext.name;
      meta.appendChild(name);
      const version = document.createElement('span');
      version.className = 'ext-version';
      version.textContent = ext.version ? `v${ext.version}` : '';
      meta.appendChild(version);
      row.appendChild(meta);

      // The extension's own popup (e.g. 1Password's sign-in UI) is the
      // primary way to actually use most extensions — without this,
      // install/enable/remove is all you could ever do with one.
      // Opened as a regular tab (not a floating popup window) since
      // that reuses all of this app's existing, working tab
      // infrastructure rather than needing a second window subsystem.
      if (ext.popupUrl) {
        icon.title = 'Open';
        icon.classList.add('ext-icon-clickable');
        icon.addEventListener('click', () => onOpenPage(ext.id, 'popup'));
        name.classList.add('ext-name-clickable');
        name.addEventListener('click', () => onOpenPage(ext.id, 'popup'));
      }

      if (ext.optionsUrl) {
        const optionsBtn = document.createElement('button');
        optionsBtn.type = 'button';
        optionsBtn.className = 'ext-options';
        optionsBtn.title = 'Options';
        optionsBtn.textContent = '⚙';
        optionsBtn.addEventListener('click', () => onOpenPage(ext.id, 'options'));
        row.appendChild(optionsBtn);
      }

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ext-toggle' + (ext.enabled ? ' on' : '');
      toggle.title = ext.enabled ? 'Disable' : 'Enable';
      toggle.setAttribute('aria-pressed', String(ext.enabled));
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await onSetEnabled(ext.id, !ext.enabled);
        } catch (err) {
          lastError = err?.message || String(err);
          renderList(popover);
        }
      });
      row.appendChild(toggle);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ext-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => onRemove(ext.id));
      row.appendChild(removeBtn);

      popover.appendChild(row);
    }
  }

  btn.addEventListener('click', () => {
    lastError = '';
    const rect = btn.getBoundingClientRect();
    openPopoverEl = showPopover(
      (popover) => renderList(popover),
      { x: rect.right + 8, y: rect.top },
      { className: 'extensions-popover' }
    );
  });

  return {
    render(list) {
      extensions = list || [];
      if (openPopoverEl && openPopoverEl.isConnected) renderList(openPopoverEl);
      else openPopoverEl = null;
    },
  };
}
