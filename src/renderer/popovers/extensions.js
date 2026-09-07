'use strict';

// Popover content (§8.28) for the rail's extensions button: install a
// Chrome extension from a Web Store URL/ID, and manage the active
// profile's installed set (enable/disable, remove, open popup/options).

function fallbackLetter(name) {
  return ((name || '?').trim()[0] || '?').toUpperCase();
}

export function render(root) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover extensions-popover';
  root.appendChild(popover);

  let extensions = [];
  let installing = false;
  let lastError = '';

  function renderAll() {
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
      renderAll();
      try {
        await window.browserAPI.installExtension(ref);
        lastError = '';
      } catch (err) {
        lastError = err?.message || String(err);
      } finally {
        installing = false;
        renderAll();
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

      // openExtensionPage rejects rather than returning a status (no
      // popup, no options page, extension not found) — unhandled, that
      // rejection is swallowed by the renderer and the click looks like
      // it simply did nothing at all, which is indistinguishable from a
      // dead button and is exactly how §8.33-§8.35's real failures
      // presented. Surface it in the popover's own error slot instead.
      const openPage = async (kind) => {
        try {
          await window.browserAPI.openExtensionPage(ext.id, kind);
        } catch (err) {
          lastError = err?.message || String(err);
          renderAll();
        }
      };

      if (ext.popupUrl) {
        icon.title = 'Open';
        icon.classList.add('ext-icon-clickable');
        icon.addEventListener('click', () => openPage('popup'));
        name.classList.add('ext-name-clickable');
        name.addEventListener('click', () => openPage('popup'));
      }

      if (ext.optionsUrl) {
        const optionsBtn = document.createElement('button');
        optionsBtn.type = 'button';
        optionsBtn.className = 'ext-options';
        optionsBtn.title = 'Options';
        optionsBtn.textContent = '⚙';
        optionsBtn.addEventListener('click', () => openPage('options'));
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
          await window.browserAPI.setExtensionEnabled(ext.id, !ext.enabled);
        } catch (err) {
          lastError = err?.message || String(err);
          renderAll();
        }
      });
      row.appendChild(toggle);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ext-remove';
      removeBtn.title = 'Remove';
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', async () => {
        try {
          await window.browserAPI.removeExtension(ext.id);
        } catch (err) {
          lastError = err?.message || String(err);
          renderAll();
        }
      });
      row.appendChild(removeBtn);

      popover.appendChild(row);
    }
  }

  window.browserAPI.onExtensionsChanged((payload) => {
    extensions = payload.extensions || [];
    renderAll();
  });
  window.browserAPI.listExtensions().then(({ extensions: list }) => {
    extensions = list || [];
    renderAll();
  });
}
