'use strict';

// Theme system ported from ScriptureDesk (same theme ids/names/colors and
// switching logic) so this app's palette and picker match that app family.
// Applies CSS classes on <html> (see styles.css for the variable blocks)
// and persists the chosen theme in localStorage.

const STORAGE_KEY = 'browser-theme';

const THEMES = [
  { id: 'classic', name: 'Classic', dark: false, cls: '', sw: { bg: '#FFFFFF', ac: '#1E5FA8', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'slate', name: 'Indigo Slate', dark: false, cls: 'theme-slate', sw: { bg: '#FFFFFF', ac: '#4841D6', tx: '#1C2740', ln: '#E2E3EF' } },
  { id: 'evergreen', name: 'Evergreen', dark: false, cls: 'theme-evergreen', sw: { bg: '#FFFFFF', ac: '#16794D', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'teal', name: 'Teal', dark: false, cls: 'theme-teal', sw: { bg: '#FFFFFF', ac: '#0E7C86', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'plum', name: 'Plum', dark: false, cls: 'theme-plum', sw: { bg: '#FFFFFF', ac: '#7A3EA1', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'rose', name: 'Rose', dark: false, cls: 'theme-rose', sw: { bg: '#FFFFFF', ac: '#B23A63', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'sandstone', name: 'Sandstone', dark: false, cls: 'theme-sandstone', sw: { bg: '#FBF8F3', ac: '#B5761F', tx: '#2A2519', ln: '#E7DECB' } },
  { id: 'sky', name: 'Sky', dark: false, cls: 'theme-sky', sw: { bg: '#FFFFFF', ac: '#0288D1', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'coral', name: 'Coral', dark: false, cls: 'theme-coral', sw: { bg: '#FFFFFF', ac: '#E05141', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'emerald', name: 'Emerald', dark: false, cls: 'theme-emerald', sw: { bg: '#FFFFFF', ac: '#059669', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'orchid', name: 'Orchid', dark: false, cls: 'theme-orchid', sw: { bg: '#FFFFFF', ac: '#C42B8E', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'lagoon', name: 'Lagoon', dark: false, cls: 'theme-grad theme-lagoon', sw: { bg: '#FFFFFF', ac: 'linear-gradient(135deg,#0E9AA7,#3FB0E5)', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'blossom', name: 'Blossom', dark: false, cls: 'theme-grad theme-blossom', sw: { bg: '#FFFFFF', ac: 'linear-gradient(135deg,#E85C9A,#9B5DE5)', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'cosmic', name: 'Cosmic', dark: false, cls: 'theme-grad theme-cosmic', sw: { bg: '#FFFFFF', ac: 'linear-gradient(135deg,#4338CA,#C026D3)', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'volcano', name: 'Volcano', dark: false, cls: 'theme-grad theme-volcano', sw: { bg: '#FFFFFF', ac: 'linear-gradient(135deg,#E01E37,#7A12C9)', tx: '#1C2740', ln: '#E4E8EF' } },
  { id: 'midnight', name: 'Midnight', dark: true, cls: '', sw: { bg: '#141C28', ac: '#4E93DA', tx: '#E4EAF1', ln: '#26313F' } },
  { id: 'carbon', name: 'Carbon', dark: true, cls: 'theme-carbon', sw: { bg: '#17181C', ac: '#5B9BE0', tx: '#E7E8EA', ln: '#2A2C31' } },
  { id: 'ocean', name: 'Ocean', dark: true, cls: 'theme-ocean', sw: { bg: '#0F1E24', ac: '#35B0C0', tx: '#DFEEF1', ln: '#21343B' } },
  { id: 'forest', name: 'Deep Forest', dark: true, cls: 'theme-forest', sw: { bg: '#10201A', ac: '#4FB488', tx: '#E1EEE7', ln: '#22362D' } },
  { id: 'nightshade', name: 'Nightshade', dark: true, cls: 'theme-nightshade', sw: { bg: '#191426', ac: '#A986E6', tx: '#E9E3F3', ln: '#322944' } },
  { id: 'ember', name: 'Ember', dark: true, cls: 'theme-ember', sw: { bg: '#201814', ac: '#E0A24E', tx: '#F0E7DD', ln: '#3A2E24' } },
  { id: 'crimson', name: 'Crimson', dark: true, cls: 'theme-crimson', sw: { bg: '#1E1E20', ac: '#E5544B', tx: '#EAEAEC', ln: '#34343A' } },
  { id: 'harbor', name: 'Harbor', dark: true, cls: 'theme-harbor', sw: { bg: '#14202E', ac: '#F08A3C', tx: '#E4ECF3', ln: '#26374A' } },
  { id: 'fuchsia', name: 'Fuchsia', dark: true, cls: 'theme-fuchsia', sw: { bg: '#201421', ac: '#E572C0', tx: '#F1E4EF', ln: '#35263A' } },
  { id: 'mint', name: 'Mint', dark: true, cls: 'theme-mint', sw: { bg: '#10201C', ac: '#3FC79B', tx: '#E0EEE9', ln: '#22362F' } },
  { id: 'indigo', name: 'Indigo', dark: true, cls: 'theme-indigo', sw: { bg: '#16182B', ac: '#7C83F5', tx: '#E6E8F5', ln: '#292C46' } },
  { id: 'aurora', name: 'Aurora', dark: true, cls: 'theme-grad theme-aurora', sw: { bg: '#0E1C1E', ac: 'linear-gradient(135deg,#43E97B,#38F9D7,#4F8FF5)', tx: '#DFEFEC', ln: '#1E3336' } },
  { id: 'sunset', name: 'Sunset', dark: true, cls: 'theme-grad theme-sunset', sw: { bg: '#221619', ac: 'linear-gradient(135deg,#FF8A5B,#FF5FA2)', tx: '#F2E6E9', ln: '#3A2830' } },
  { id: 'nebula', name: 'Nebula', dark: true, cls: 'theme-grad theme-nebula', sw: { bg: '#171129', ac: 'linear-gradient(135deg,#C04CFF,#7C4DFF,#4D8CFF)', tx: '#EAE4F6', ln: '#2E2447' } },
  { id: 'vapor', name: 'Vapor', dark: true, cls: 'theme-grad theme-vapor', sw: { bg: '#151622', ac: 'linear-gradient(135deg,#FF6AD5,#8A6DFF,#6AE0FF)', tx: '#E9E9F5', ln: '#292B3D' } },
];

const VARIANT_CLASSES = [
  'theme-slate', 'theme-evergreen', 'theme-teal', 'theme-plum', 'theme-rose',
  'theme-sandstone', 'theme-sky', 'theme-coral', 'theme-emerald', 'theme-orchid',
  'theme-carbon', 'theme-ocean', 'theme-forest', 'theme-nightshade', 'theme-ember',
  'theme-crimson', 'theme-harbor', 'theme-fuchsia', 'theme-mint', 'theme-indigo',
  'theme-grad', 'theme-lagoon', 'theme-blossom', 'theme-aurora', 'theme-sunset',
  'theme-cosmic', 'theme-volcano', 'theme-nebula', 'theme-vapor',
];

function themeById(id) {
  return THEMES.find((t) => t.id === id) || null;
}

function isDark() {
  return document.documentElement.classList.contains('theme-dark');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initTheme() {
  let currentThemeId = 'classic';
  let lastLightId = 'classic';
  let lastDarkId = 'midnight';

  function applyThemeId(id) {
    const t = themeById(id) || THEMES[0];
    const e = document.documentElement;
    e.classList.remove('theme-dark');
    VARIANT_CLASSES.forEach((c) => e.classList.remove(c));
    if (t.dark) e.classList.add('theme-dark');
    if (t.cls) t.cls.split(' ').forEach((c) => c && e.classList.add(c));
    currentThemeId = t.id;
    if (t.dark) lastDarkId = t.id;
    else lastLightId = t.id;
  }

  function persist(id) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* localStorage unavailable (e.g. disabled); theme still applies for this session */
    }
  }

  function setTheme(id) {
    applyThemeId(id);
    persist(id);
    renderThemePicker();
  }

  function toggleTheme() {
    setTheme(isDark() ? lastLightId : lastDarkId);
  }

  function swatchHtml(t) {
    const on = t.id === currentThemeId;
    return (
      `<button type="button" class="theme-sw${on ? ' on' : ''}" data-theme="${t.id}">` +
      `<span class="tsw-prev" style="background:${t.sw.bg};border-color:${t.sw.ln}">` +
      `<span class="tsw-bar" style="background:${t.sw.ac}"></span>` +
      `<span class="tsw-line" style="background:${t.sw.tx}"></span>` +
      `<span class="tsw-line short" style="background:${t.sw.tx};opacity:.55"></span>` +
      `<span class="tsw-dot" style="background:${t.sw.ac}"></span>` +
      `</span><span class="tsw-name">${escapeHtml(t.name)}${on ? ' <span class="tsw-chk">✓</span>' : ''}</span></button>`
    );
  }

  function renderThemePicker() {
    const wl = document.getElementById('themeLight');
    const wd = document.getElementById('themeDark');
    if (!wl || !wd) return;
    wl.innerHTML = THEMES.filter((t) => !t.dark).map(swatchHtml).join('');
    wd.innerHTML = THEMES.filter((t) => t.dark).map(swatchHtml).join('');
    document.querySelectorAll('.theme-sw').forEach((b) => {
      b.addEventListener('click', () => setTheme(b.getAttribute('data-theme')));
    });
  }

  function openSettings() {
    renderThemePicker();
    document.getElementById('settingsOverlay').classList.add('show');
    // A BrowserView always paints above the chrome window's own content, so
    // the active tab's page would otherwise hide this modal — detach it
    // while the modal is open.
    window.browserAPI.hideActiveView();
  }

  function closeSettings() {
    document.getElementById('settingsOverlay').classList.remove('show');
    window.browserAPI.showActiveView();
  }

  // ---- initial theme: saved choice, else follow the OS setting ----
  let initialId = null;
  try {
    initialId = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* localStorage unavailable */
  }
  if (!initialId) {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    initialId = prefersDark ? 'midnight' : 'classic';
  }
  applyThemeId(initialId);

  // ---- wire the settings button + modal ----
  const settingsBtn = document.getElementById('btn-settings');
  const overlay = document.getElementById('settingsOverlay');
  const closeBtn = document.getElementById('settingsClose');

  settingsBtn.addEventListener('click', openSettings);
  closeBtn.addEventListener('click', closeSettings);
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) closeSettings();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.classList.contains('show')) closeSettings();
  });

  return { toggleTheme, setTheme };
}
