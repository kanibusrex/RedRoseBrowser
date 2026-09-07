'use strict';

// Bootstrap for popover.html — the dedicated page every popover (§8.28)
// loads into its own small BrowserView. Runs in the same trusted,
// contextIsolation/sandbox-on chrome renderer environment as index.js
// (same preload, same window.browserAPI surface), just a different
// document with nothing else in it.
//
// One of these loads fresh every time a popover opens (PopoverManager
// calls loadFile() again on every show(), never reuses a live view) — so
// unlike index.js there's no teardown/unsubscribe to worry about
// anywhere in here or in any of ./popovers/*.js: the whole realm, and
// every listener registered in it, is simply destroyed with the
// BrowserView when the popover closes.

import { render as renderBookmarks } from './popovers/bookmarks.js';
import { render as renderHistory } from './popovers/history.js';
import { render as renderDownloads } from './popovers/downloads.js';
import { render as renderExtensions } from './popovers/extensions.js';
import { render as renderProfileSwitcher } from './popovers/profileSwitcher.js';
import { render as renderTabMenu } from './popovers/tabMenu.js';
import { render as renderGroupColorPicker } from './popovers/groupColorPicker.js';
import { render as renderPermission } from './popovers/permission.js';

const RENDERERS = {
  bookmarks: renderBookmarks,
  history: renderHistory,
  downloads: renderDownloads,
  extensions: renderExtensions,
  profileSwitcher: renderProfileSwitcher,
  tabMenu: renderTabMenu,
  groupColorPicker: renderGroupColorPicker,
  permission: renderPermission,
};

const root = document.getElementById('popover-root');

let resizeObserver = null;
let lastReportedW = -1;
let lastReportedH = -1;

// Measures the popover's own content element, NOT #popover-root itself —
// root is a plain position:static box, and an absolutely positioned
// child (every popover's own top-level element — see popover.html) never
// contributes to a static ancestor's auto size, so root's own
// getBoundingClientRect() would always read 0x0. The content element's
// own rect is unaffected by that — it's just measuring itself.
function watchSize(target) {
  if (resizeObserver) resizeObserver.disconnect();
  lastReportedW = -1;
  lastReportedH = -1;
  resizeObserver = new ResizeObserver(() => {
    const rect = target.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    if (w === lastReportedW && h === lastReportedH) return;
    lastReportedW = w;
    lastReportedH = h;
    window.browserAPI.reportPopoverSize(w, h);
  });
  resizeObserver.observe(target);
}

window.browserAPI.onPopoverInit(({ kind, data, themeClass } = {}) => {
  // Matches whatever theme (dark/light + accent variant) the chrome
  // window's own <html> currently has — PopoverManager reads that fresh
  // on every show() (this document has no theme state, or localStorage
  // access to index.html's, of its own). See popover-manager.js's show().
  document.documentElement.className = themeClass || '';
  const renderFn = RENDERERS[kind];
  if (!renderFn) return; // unknown kind — nothing to show, leave root empty
  renderFn(root, data || {});
  // Each render() fills in exactly one top-level child of #popover-root
  // (matching popover.html's `#popover-root > *` CSS, same one-child
  // shape the old ContextMenu.js container always had) — that's the
  // element whose size actually matters, however its own insides change
  // afterward (a search keystroke, a live downloads update, ...).
  const target = root.firstElementChild;
  if (target) watchSize(target);
});

// Escape closes whatever's open, full stop — no popover here has a
// narrower "cancel just this inner bit" Escape behavior of its own
// (ProfileSwitcher.js's rename field used to close the whole popover on
// Escape too, even before this migration).
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.browserAPI.closePopover();
});
