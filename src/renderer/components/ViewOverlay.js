'use strict';

// A BrowserView always paints above the chrome window's own content
// (DESIGN.md §2.3), so any in-chrome modal/popover needs the active tab's
// view detached while it's up, or it'd render invisibly behind the page.
// Until now only one thing ever did this at a time (the settings/theme
// picker, a full-screen overlay that blocks reopening itself), so a
// plain hideActiveView()/showActiveView() call pair was enough.
//
// Permission prompts (§8.16) can now overlap that, or each other — a
// second site's permission request can arrive while the first prompt (or
// the settings modal) is still open, and re-showing the view the moment
// the *second* one closes while the *first* is still supposed to be
// hiding it would flash the page back into view mid-modal. This tiny
// reference count is the fix: the underlying view only actually
// re-attaches once every caller that asked for it hidden has released
// it. Every hide/show call in the chrome renderer should go through this
// instead of calling window.browserAPI.hideActiveView/showActiveView
// directly.

let depth = 0;

export function pushHideActiveView() {
  depth += 1;
  if (depth === 1) window.browserAPI.hideActiveView();
}

export function popHideActiveView() {
  depth = Math.max(0, depth - 1);
  if (depth === 0) window.browserAPI.showActiveView();
}
