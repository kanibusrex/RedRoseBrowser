'use strict';

// Address bar that doubles as a search box (DESIGN.md §1). Purely
// cosmetic lock/info icon reflects https: vs http: — no full security UI.
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

export function createAddressBar({ input, securityIcon, wrap, clearBtn }, { onNavigate }) {
  function updateHasText() {
    wrap.classList.toggle('has-text', input.value.length > 0);
  }

  input.addEventListener('input', updateHasText);

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const value = input.value.trim();
      if (value) onNavigate(value);
      input.blur();
    } else if (event.key === 'Escape') {
      input.blur();
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    updateHasText();
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
