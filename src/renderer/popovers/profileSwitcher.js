'use strict';

// Popover content (§8.28) for the rail glyph's profile switcher: switch
// profile, rename, delete, create a new one.

const PROFILE_COLORS = ['#1E5FA8', '#16794D', '#7A3EA1', '#B23A63', '#0E7C86', '#B5761F'];

export function render(root) {
  const popover = document.createElement('div');
  popover.className = 'popup-menu popup-popover profile-popover';
  root.appendChild(popover);

  let state = { activeProfileId: null, profiles: [] };

  function renderList() {
    popover.innerHTML = '';

    for (const p of state.profiles) {
      const row = document.createElement('div');
      row.className = 'profile-row' + (p.active ? ' active' : '');

      const dot = document.createElement('span');
      dot.className = 'profile-dot';
      dot.style.background = p.color;
      row.appendChild(dot);

      const name = document.createElement('span');
      name.className = 'profile-name';
      name.textContent = p.name;
      name.title = p.name;
      name.addEventListener('click', () => {
        if (!p.active) {
          window.browserAPI.switchProfile(p.id);
          window.browserAPI.closePopover();
        }
      });
      row.appendChild(name);

      if (p.active) {
        const check = document.createElement('span');
        check.className = 'profile-check';
        check.textContent = '✓';
        row.appendChild(check);
      }

      const renameBtn = document.createElement('button');
      renameBtn.className = 'profile-mini-btn';
      renameBtn.title = 'Rename';
      renameBtn.textContent = '✎';
      renameBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        startRename(row, p);
      });
      row.appendChild(renameBtn);

      if (state.profiles.length > 1) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'profile-mini-btn';
        deleteBtn.title = 'Delete profile';
        deleteBtn.textContent = '×';
        deleteBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          window.browserAPI.deleteProfile(p.id);
        });
        row.appendChild(deleteBtn);
      }

      popover.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.className = 'popup-sep';
    popover.appendChild(sep);

    const newRow = document.createElement('div');
    newRow.className = 'profile-new';
    newRow.innerHTML = `
      <input type="text" class="profile-new-input" placeholder="Profile name" maxlength="40" />
      <div class="profile-new-colors"></div>
      <button type="button" class="profile-new-create">Create profile</button>
    `;
    const colorsWrap = newRow.querySelector('.profile-new-colors');
    let chosenColor = PROFILE_COLORS[0];
    PROFILE_COLORS.forEach((hex, i) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'profile-color-sw' + (i === 0 ? ' selected' : '');
      sw.style.background = hex;
      sw.addEventListener('click', () => {
        chosenColor = hex;
        colorsWrap.querySelectorAll('.profile-color-sw').forEach((el) => el.classList.remove('selected'));
        sw.classList.add('selected');
      });
      colorsWrap.appendChild(sw);
    });
    const input = newRow.querySelector('.profile-new-input');
    const createBtn = newRow.querySelector('.profile-new-create');
    const submit = () => {
      const name = input.value.trim();
      if (!name) return;
      window.browserAPI.createProfile(name, chosenColor);
      window.browserAPI.closePopover();
    };
    createBtn.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    popover.appendChild(newRow);
  }

  function startRename(row, profile) {
    row.innerHTML = '';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'profile-rename-input';
    input.value = profile.name;
    input.maxLength = 40;
    row.appendChild(input);
    input.focus();
    input.select();
    const commit = () => {
      const name = input.value.trim();
      if (name && name !== profile.name) window.browserAPI.renameProfile(profile.id, name);
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') commit();
      // Escape falls through to popover.js's global handler (closes the
      // whole popover) — same end result the old closePopup() call here
      // had.
    });
    input.addEventListener('blur', commit);
  }

  window.browserAPI.onProfilesChanged((next) => {
    state = next;
    renderList();
  });
  window.browserAPI.listProfiles().then((next) => {
    state = next;
    renderList();
  });
}
