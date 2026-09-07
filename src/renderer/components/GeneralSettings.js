'use strict';

// The settings modal's "General" section (§8.24) — search engine, home
// page, and the ad-block toggle. theme.js owns the modal shell itself
// (open/close, the BrowserView hide/show around it); this only owns
// populating and wiring these three fields, called fresh every time the
// modal opens (via theme.js's `onOpen` hook) so it always reflects
// whatever's actually saved rather than a stale snapshot from startup.
// Each field commits immediately on change — no separate Save button,
// same as the theme picker it sits next to.

export function initGeneralSettings({ searchEngineSelect, homePageInput, adBlockCheckbox, checkUpdatesBtn }) {
  async function populate() {
    const { settings, searchEngines } = await window.browserAPI.getGeneralSettings();

    searchEngineSelect.innerHTML = '';
    for (const engine of searchEngines) {
      const opt = document.createElement('option');
      opt.value = engine.id;
      opt.textContent = engine.name;
      searchEngineSelect.appendChild(opt);
    }
    searchEngineSelect.value = settings.searchEngine;

    // null (the bundled SimpleHome default) shows as an empty field,
    // matching its placeholder text.
    homePageInput.value = settings.homePageUrl || '';

    adBlockCheckbox.checked = settings.adBlockEnabled;
  }

  searchEngineSelect.addEventListener('change', () => {
    window.browserAPI.updateGeneralSettings({ searchEngine: searchEngineSelect.value });
  });

  // Commits on blur/Enter, not on every keystroke — an in-progress,
  // not-yet-valid URL shouldn't be saved (and re-validated by main) on
  // every character typed.
  const commitHomePage = () => {
    const value = homePageInput.value.trim();
    window.browserAPI.updateGeneralSettings({ homePageUrl: value || null });
  };
  homePageInput.addEventListener('blur', commitHomePage);
  homePageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      homePageInput.blur(); // triggers commitHomePage via the listener above
    }
  });

  adBlockCheckbox.addEventListener('change', () => {
    window.browserAPI.updateGeneralSettings({ adBlockEnabled: adBlockCheckbox.checked });
  });

  // §8.30 — reachable from the native menu too (all platforms), but
  // Windows/Linux's menu *bar* disappears along with the title bar once
  // it's hidden, and this had no keyboard accelerator to fall back on
  // (unlike Edit's roles). Feedback is a native dialog main shows either
  // way (checkForUpdatesNow, updater.js) — nothing to wire back here.
  checkUpdatesBtn.addEventListener('click', () => window.browserAPI.checkForUpdates());

  return { populate };
}
