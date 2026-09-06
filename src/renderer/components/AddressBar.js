'use strict';

// Address bar that doubles as a search box (DESIGN.md §1), plus
// autocomplete suggestions from history and bookmarks as you type
// (§8.23). Purely cosmetic lock/info icon reflects https: vs http: — no
// full security UI.
//
// NOTE: src/shared/url-utils.js is written CommonJS (required by main.js
// via `require`); this renderer module is loaded as a native ES module
// (`<script type="module">`) and can't `require()` it directly. Per
// DESIGN.md §3's note on url-utils.js ("if duplicated, keep in sync
// manually"), isLikelyUrl is duplicated here in minimal form for any
// future optimistic-UI use — main's navigation.js remains the sole
// authority on what actually gets loaded.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HOST_LIKE_RE =
  /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(:\d+)?(\/.*)?$/i;

function isLikelyUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed) && !SCHEME_RE.test(trimmed)) return false;
  if (SCHEME_RE.test(trimmed)) return true;
  return HOST_LIKE_RE.test(trimmed);
}

// Same favicon-scheme validation TabStrip.js/Bookmarks.js/History.js each
// already carry their own copy of — untrusted input (a bookmark's or a
// history entry's stored favicon URL) reaching the trusted chrome
// renderer, so the scheme is checked before it's ever used as a CSS
// background-image value.
const ALLOWED_FAVICON_SCHEMES = new Set(['http:', 'https:', 'data:']);
function faviconStyle(el, favicon) {
  el.style.backgroundImage = '';
  if (!favicon) return false;
  let parsed;
  try {
    parsed = new URL(favicon);
  } catch {
    return false;
  }
  if (!ALLOWED_FAVICON_SCHEMES.has(parsed.protocol)) return false;
  if (parsed.protocol === 'data:' && !/^data:image\//i.test(parsed.href)) return false;
  el.style.backgroundImage = `url("${parsed.href}")`;
  return true;
}

const MAX_SUGGESTIONS = 6;
const MAX_BOOKMARK_SUGGESTIONS = 4;
const SUGGEST_DEBOUNCE_MS = 150;

export function createAddressBar({ input, securityIcon, wrap, clearBtn, suggestionsContainer }, { onNavigate, getBookmarks }) {
  let suggestions = [];
  let selectedIndex = -1;
  let debounceTimer = null;

  function updateHasText() {
    wrap.classList.toggle('has-text', input.value.length > 0);
  }

  // Reserves/un-reserves the layout space above the BrowserView
  // (TabManager.setAddressSuggestOpen, §8.23) — kept in sync with
  // whether this container actually has anything in it, never called
  // more than the DOM state actually changes (TabManager's own setter is
  // idempotent too, but no reason to round-trip IPC on every keystroke
  // when the open/closed state itself hasn't changed).
  let reserved = false;
  function setReserved(open) {
    if (reserved === open) return;
    reserved = open;
    window.browserAPI.setAddressSuggestOpen(open);
  }

  function closeSuggestions() {
    suggestions = [];
    selectedIndex = -1;
    suggestionsContainer.innerHTML = '';
    suggestionsContainer.classList.remove('show');
    setReserved(false);
  }

  function renderSuggestions() {
    suggestionsContainer.innerHTML = '';
    if (suggestions.length === 0) {
      suggestionsContainer.classList.remove('show');
      setReserved(false);
      return;
    }

    suggestions.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'address-suggestion' + (i === selectedIndex ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === selectedIndex));

      const icon = document.createElement('div');
      icon.className = 'address-suggestion-icon';
      const applied = s.favicon && faviconStyle(icon, s.favicon);
      if (!applied) icon.textContent = s.type === 'bookmark' ? '\u{2605}' : '\u{1F551}'; // ★ / 🕑
      row.appendChild(icon);

      const title = document.createElement('div');
      title.className = 'address-suggestion-title';
      title.textContent = s.title || s.url;
      row.appendChild(title);

      const url = document.createElement('div');
      url.className = 'address-suggestion-url';
      url.textContent = s.url;
      row.appendChild(url);

      // mousedown (not click) + preventDefault, so picking a suggestion
      // doesn't blur the input first — the browser's default mousedown
      // action would otherwise shift focus away before a click handler
      // ever ran, racing with the blur listener below closing everything
      // out from under this selection.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        onNavigate(s.url);
        closeSuggestions();
        input.blur();
      });

      suggestionsContainer.appendChild(row);
    });

    suggestionsContainer.classList.add('show');
    setReserved(true);
  }

  async function computeSuggestions(query) {
    const q = query.trim();
    if (!q) return [];
    const qLower = q.toLowerCase();

    const bookmarkMatches = (getBookmarks() || [])
      .filter((b) => b.title.toLowerCase().includes(qLower) || b.url.toLowerCase().includes(qLower))
      .slice(0, MAX_BOOKMARK_SUGGESTIONS)
      .map((b) => ({ type: 'bookmark', url: b.url, title: b.title, favicon: b.favicon }));

    let historyMatches = [];
    try {
      const { entries } = await window.browserAPI.listHistory(q);
      const bookmarkUrls = new Set(bookmarkMatches.map((b) => b.url));
      historyMatches = (entries || [])
        .filter((e) => !bookmarkUrls.has(e.url))
        .map((e) => ({ type: 'history', url: e.url, title: e.title, favicon: e.favicon }));
    } catch {
      /* history unavailable for some reason — bookmark matches alone still work */
    }

    return [...bookmarkMatches, ...historyMatches].slice(0, MAX_SUGGESTIONS);
  }

  function scheduleSuggestions() {
    clearTimeout(debounceTimer);
    const query = input.value;
    debounceTimer = setTimeout(async () => {
      // The input may have changed again, been cleared, or lost focus
      // while this was waiting — a stale response shouldn't clobber
      // whatever's current (the newer keystroke's own scheduled call
      // handles that instead).
      if (document.activeElement !== input || input.value !== query) return;
      suggestions = await computeSuggestions(query);
      selectedIndex = -1;
      renderSuggestions();
    }, SUGGEST_DEBOUNCE_MS);
  }

  input.addEventListener('input', () => {
    updateHasText();
    scheduleSuggestions();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && suggestions.length > 0) {
      event.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, suggestions.length - 1);
      renderSuggestions();
    } else if (event.key === 'ArrowUp' && suggestions.length > 0) {
      event.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, -1);
      renderSuggestions();
    } else if (event.key === 'Enter') {
      // A highlighted suggestion (arrow keys) wins over the typed text.
      const chosen = selectedIndex >= 0 ? suggestions[selectedIndex] : null;
      const value = chosen ? chosen.url : input.value.trim();
      if (value) onNavigate(value);
      closeSuggestions();
      input.blur();
    } else if (event.key === 'Escape') {
      if (suggestions.length > 0) closeSuggestions();
      else input.blur();
    }
  });

  // Deferred a tick: a suggestion row's own mousedown already
  // preventDefault()s to dodge this exact blur when *that's* what's
  // happening (see above) — for every other case (clicked elsewhere,
  // tabbed away) this just closes normally.
  input.addEventListener('blur', () => setTimeout(closeSuggestions, 0));

  clearBtn.addEventListener('click', () => {
    input.value = '';
    updateHasText();
    closeSuggestions();
    input.focus();
  });

  function render(tab) {
    // Don't clobber what the user is actively typing.
    if (document.activeElement === input) return;

    const url = tab ? tab.url : '';
    input.value = url && url !== 'about:blank' ? url : '';
    updateHasText();

    let scheme = '';
    try {
      scheme = url ? new URL(url).protocol : '';
    } catch {
      scheme = '';
    }

    if (scheme === 'https:') {
      securityIcon.textContent = '\u{1F512}'; // lock
      securityIcon.title = 'Secure connection';
    } else if (scheme === 'http:') {
      securityIcon.textContent = '\u{24D8}'; // info
      securityIcon.title = 'Not secure';
    } else {
      securityIcon.textContent = '';
      securityIcon.title = '';
    }
  }

  function focusAndSelect() {
    input.focus();
    input.select();
  }

  return { render, focus: focusAndSelect, isLikelyUrl };
}
