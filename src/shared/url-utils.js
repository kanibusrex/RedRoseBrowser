'use strict';

/**
 * Shared URL/search-query resolution logic, used by both:
 *  - src/main/navigation.js (authoritative — decides what actually loads)
 *  - src/renderer/components/AddressBar.js (optimistic UI only, e.g. to
 *    decide whether to show a lock icon before main responds)
 * Keep these two copies in sync manually (per DESIGN.md §3 file layout).
 */

const DEFAULT_SEARCH_URL = 'https://www.google.com/search?q=';

// Schemes we consider "already a URL" without further guessing.
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

// Looks like "host.tld" or "host.tld/path" or "localhost[:port]".
const HOST_LIKE_RE =
  /^(localhost|(\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)(:\d+)?(\/.*)?$/i;

/**
 * Returns true when `input` looks like a navigable URL (has a scheme, or
 * looks like host.tld[/path], or is localhost/an IP), as opposed to a
 * search query.
 */
function isLikelyUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return false;
  if (/\s/.test(trimmed) && !SCHEME_RE.test(trimmed)) return false;
  if (SCHEME_RE.test(trimmed)) return true;
  // Strip a leading path/query before testing host-likeness, e.g. "a b.com" already caught above.
  return HOST_LIKE_RE.test(trimmed);
}

/**
 * Turns raw address-bar input into a final navigable URL string: either
 * the (scheme-normalized) URL itself, or a search-engine query URL.
 */
function normalizeInput(input, searchUrl = DEFAULT_SEARCH_URL) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return 'about:blank';

  if (isLikelyUrl(trimmed)) {
    return SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  return `${searchUrl}${encodeURIComponent(trimmed)}`;
}

module.exports = { DEFAULT_SEARCH_URL, isLikelyUrl, normalizeInput };
