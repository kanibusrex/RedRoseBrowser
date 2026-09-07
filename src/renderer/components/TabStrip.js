'use strict';

// Renders the tab list: pinned tabs (compact, icon-only), grouped tabs
// (under a colored, renamable header), then ungrouped tabs. Plain vanilla
// JS, no framework (DESIGN.md §2.2 / §6).

import { groupColorHex } from './GroupColors.js';

const ALLOWED_FAVICON_SCHEMES = new Set(['http:', 'https:', 'data:']);

// Favicon URLs come from the page itself (page-favicon-updated) — untrusted
// input reaching the trusted chrome renderer. Validate the scheme and set
// backgroundImage via the CSSOM setter (not a hand-built style string /
// setAttribute) so the browser's own CSS-value parser handles escaping,
// rather than reusing it as-is for arbitrary CSS injection.
function applyFavicon(el, favicon) {
  el.style.backgroundImage = '';
  if (!favicon) return;
  let parsed;
  try {
    parsed = new URL(favicon);
  } catch {
    return;
  }
  if (!ALLOWED_FAVICON_SCHEMES.has(parsed.protocol)) return;
  // Sites with no real favicon sometimes report a degenerate empty data
  // URI (e.g. "data:,") via page-favicon-updated rather than omitting the
  // event — that's a valid data: URL but decodes to zero bytes, so it'd
  // otherwise render as a blank/broken image forever.
  if (parsed.protocol === 'data:' && !/^data:image\//i.test(parsed.href)) return;
  el.style.backgroundImage = `url("${parsed.href}")`;
  return true;
}

function fallbackLetter(tab) {
  try {
    const host = tab.url ? new URL(tab.url).hostname : '';
    if (host) return host.replace(/^www\./, '')[0].toUpperCase();
  } catch {
    /* fall through to title */
  }
  return ((tab.title || tab.url || '').trim()[0] || '?').toUpperCase();
}

// Custom MIME type for tab drag-and-drop (§8.12 split view) — namespaced
// so this never accidentally matches a drag originating from anywhere
// else (an OS file drag, a page's own drag source, e.g. SimpleHome's
// shortcut-tile reordering, which is a separate webContents entirely
// and wouldn't reach this listener regardless, but this is defensive).
const TAB_DRAG_MIME = 'application/x-vellum-tab-id';

export function createTabStrip(container, { onActivate, onClose, onNewTab, groupActions, splitActions, reorderActions }) {
  let lastState = { tabs: [], activeTabId: null, groups: [] };

  function faviconOrSpinner(tab, { compact } = {}) {
    if (tab.isLoading) {
      const spinner = document.createElement('div');
      spinner.className = 'tab-spinner';
      return spinner;
    }
    const favicon = document.createElement('div');
    favicon.className = 'tab-favicon';
    const applied = applyFavicon(favicon, tab.favicon);
    // Pinned tabs are icon-only — with no favicon they'd otherwise be
    // completely blank and unidentifiable, so fall back to a letter glyph.
    if (!applied && compact) {
      favicon.classList.add('tab-favicon-fallback');
      favicon.textContent = fallbackLetter(tab);
    }
    return favicon;
  }

  // §8.28: the popover itself (src/renderer/popovers/tabMenu.js) builds
  // the item list and calls window.browserAPI directly — it runs in its
  // own separate webContents, so none of groupActions/onClose (this
  // module's own injected callbacks, all thin browserAPI wrappers
  // anyway — see index.js) would even be reachable from there. Only the
  // specific tab's own state, and the other groups it could move to,
  // need to cross that boundary — passed as `data` since neither lives
  // anywhere main can hand back on its own.
  function openTabMenu(tab, anchor) {
    window.browserAPI.showPopover('tabMenu', anchor, {
      tabId: tab.id,
      pinned: tab.pinned,
      groupId: tab.groupId,
      splitWithTabId: tab.splitWithTabId,
      groups: lastState.groups.map((g) => ({ id: g.id, name: g.name })),
    });
  }

  function buildTabRow(tab, { compact }) {
    const el = document.createElement('div');
    el.className =
      'tab' +
      (tab.id === lastState.activeTabId ? ' active' : '') +
      (compact ? ' tab-pinned' : '') +
      (tab.splitWithTabId ? ' tab-split' : '');
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', String(tab.id === lastState.activeTabId));
    el.title = tab.title || tab.url;

    el.appendChild(faviconOrSpinner(tab, { compact }));

    if (!compact) {
      const title = document.createElement('span');
      title.className = 'tab-title';
      title.textContent = tab.title || tab.url || 'New Tab';
      el.appendChild(title);

      if (tab.splitWithTabId) {
        const splitBtn = document.createElement('button');
        splitBtn.className = 'tab-split-indicator';
        splitBtn.title = 'Split view — click to close';
        splitBtn.setAttribute('aria-label', 'Close split view');
        splitBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>';
        splitBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          splitActions.unsplit(tab.id);
        });
        el.appendChild(splitBtn);
      }

      const closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '×';
      closeBtn.title = 'Close tab';
      closeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        onClose(tab.id);
      });
      el.appendChild(closeBtn);
    }

    el.addEventListener('click', () => onActivate(tab.id));
    el.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openTabMenu(tab, { x: event.clientX, y: event.clientY });
    });

    // Drag tab A onto tab B (§8.12/§8.18): dropping on the middle ~50% of
    // a row splits them side by side; dropping on the top/bottom edge
    // reorders instead — same disambiguation-by-drop-position kanban
    // boards/file trees commonly use for "onto" vs. "between". Both
    // buckets (pinned/unpinned) support reordering; moveTab() itself
    // refuses a drag across buckets, so no need to special-case that here.
    const dropZone = (event) => {
      const rect = el.getBoundingClientRect();
      const frac = (event.clientY - rect.top) / rect.height;
      if (frac < 0.3) return 'before';
      if (frac > 0.7) return 'after';
      return 'split';
    };
    const clearDropClasses = () => el.classList.remove('tab-drop-target', 'tab-drop-before', 'tab-drop-after');

    el.draggable = true;
    el.addEventListener('dragstart', (event) => {
      event.dataTransfer.effectAllowed = 'link';
      event.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
    });
    el.addEventListener('dragover', (event) => {
      if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'link';
      const zone = dropZone(event);
      clearDropClasses();
      el.classList.add(zone === 'split' ? 'tab-drop-target' : `tab-drop-${zone}`);
    });
    el.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer.types.includes(TAB_DRAG_MIME)) return;
      // Just registers this as a valid drop target — dragover (above)
      // fires right after, on every frame while hovering, and is what
      // actually sets the correct zone class (including the first one).
      event.preventDefault();
    });
    el.addEventListener('dragleave', () => {
      clearDropClasses();
    });
    el.addEventListener('drop', (event) => {
      const zone = dropZone(event);
      clearDropClasses();
      const draggedId = event.dataTransfer.getData(TAB_DRAG_MIME);
      if (!draggedId || draggedId === tab.id) return;
      event.preventDefault();
      if (zone === 'split') splitActions.split(draggedId, tab.id);
      else reorderActions.moveTab(draggedId, tab.id, zone);
    });

    return el;
  }

  // §8.28: the swatch grid itself lives in
  // src/renderer/popovers/groupColorPicker.js now — just the group id and
  // its current color name need to cross into that popover's own
  // webContents.
  function openGroupColorPicker(group, anchor) {
    window.browserAPI.showPopover('groupColorPicker', anchor, {
      groupId: group.id,
      currentColor: group.color,
    });
  }

  function buildGroupHeader(group) {
    const header = document.createElement('div');
    header.className = 'group-header';

    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'group-dot';
    dot.style.background = groupColorHex(group.color);
    dot.title = 'Change color';
    dot.addEventListener('click', (event) => {
      const rect = dot.getBoundingClientRect();
      openGroupColorPicker(group, { x: rect.left, y: rect.bottom + 4 });
    });
    header.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = group.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', () => {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'group-rename-input';
      input.value = group.name;
      input.maxLength = 40;
      header.replaceChild(input, name);
      input.focus();
      input.select();
      const commit = () => {
        const value = input.value.trim();
        if (value && value !== group.name) groupActions.renameGroup(group.id, value);
        else header.replaceChild(name, input);
      };
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') header.replaceChild(name, input);
      });
      input.addEventListener('blur', commit);
    });
    header.appendChild(name);

    const ungroupBtn = document.createElement('button');
    ungroupBtn.type = 'button';
    ungroupBtn.className = 'group-ungroup';
    ungroupBtn.title = 'Ungroup';
    ungroupBtn.textContent = '×';
    ungroupBtn.addEventListener('click', () => groupActions.deleteGroup(group.id));
    header.appendChild(ungroupBtn);

    return header;
  }

  function render(state) {
    lastState = state;
    container.innerHTML = '';

    const newTabBtn = document.createElement('button');
    newTabBtn.id = 'new-tab-btn';
    newTabBtn.title = 'New tab';
    newTabBtn.textContent = '+ New Tab';
    newTabBtn.addEventListener('click', () => onNewTab());
    container.appendChild(newTabBtn);

    const pinned = state.tabs.filter((t) => t.pinned);
    const unpinned = state.tabs.filter((t) => !t.pinned);

    if (pinned.length > 0) {
      const pinnedRow = document.createElement('div');
      pinnedRow.className = 'pinned-row';
      for (const tab of pinned) pinnedRow.appendChild(buildTabRow(tab, { compact: true }));
      container.appendChild(pinnedRow);

      const sep = document.createElement('div');
      sep.className = 'tab-list-sep';
      container.appendChild(sep);
    }

    const byGroup = new Map();
    const ungrouped = [];
    for (const tab of unpinned) {
      if (tab.groupId) {
        if (!byGroup.has(tab.groupId)) byGroup.set(tab.groupId, []);
        byGroup.get(tab.groupId).push(tab);
      } else {
        ungrouped.push(tab);
      }
    }

    for (const group of state.groups) {
      const tabs = byGroup.get(group.id);
      if (!tabs || tabs.length === 0) continue;
      const section = document.createElement('div');
      section.className = 'group-section';
      section.appendChild(buildGroupHeader(group));
      for (const tab of tabs) section.appendChild(buildTabRow(tab, { compact: false }));
      container.appendChild(section);
    }

    for (const tab of ungrouped) {
      container.appendChild(buildTabRow(tab, { compact: false }));
    }
  }

  return { render };
}
