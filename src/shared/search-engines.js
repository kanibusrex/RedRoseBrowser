'use strict';

/**
 * Fixed list of search engines the settings page (§8.24) lets a profile
 * choose between — CommonJS, required directly by main (navigation.js,
 * settings-store.js) and sent to the renderer over IPC (SETTINGS_GET)
 * rather than duplicated there, since — unlike src/shared/url-utils.js,
 * which the sandboxed chrome preload can't require() at all (see
 * AddressBar.js's own note on that) — this only needs to reach ordinary
 * renderer code (GeneralSettings.js), which gets it as plain IPC-returned
 * data, no duplication needed.
 */
const SEARCH_ENGINES = {
  google: { id: 'google', name: 'Google', url: 'https://www.google.com/search?q=' },
  duckduckgo: { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  bing: { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=' },
};

const DEFAULT_SEARCH_ENGINE_ID = 'google';

function searchEngineUrl(id) {
  return (SEARCH_ENGINES[id] || SEARCH_ENGINES[DEFAULT_SEARCH_ENGINE_ID]).url;
}

module.exports = { SEARCH_ENGINES, DEFAULT_SEARCH_ENGINE_ID, searchEngineUrl };
