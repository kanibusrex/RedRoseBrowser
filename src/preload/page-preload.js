'use strict';

// Attached to every BrowserView showing arbitrary, untrusted web content
// (DESIGN.md §2.3 / §7.6). It still exposes **no contextBridge API
// surface at all** to the page — that rule is unchanged. The one thing it
// now does is listen, in its own isolated world, for the mouse's
// back/forward buttons (§8.40), because that is the only place those
// events can be observed at all.
//
// `ipcRenderer` is used directly here but is never handed to the page:
// nothing is exposed on `window`, so page script has no way to reach this
// channel. The event is `isTrusted`-checked so a page can't forge one by
// dispatching a synthetic MouseEvent, and the only thing it can trigger —
// back/forward within that same tab's own session history — is something
// any page can already do for itself with `history.back()`.

const { ipcRenderer } = require('electron');

const NAV_MOUSE_BUTTON = 'nav:mouseButton'; // keep in sync with src/shared/ipc-channels.js

// §8.40 — the two thumb buttons on most mice. Electron has no built-in
// handling for them: `app-command` is Windows/Linux only, the main
// process's `before-input-event` (§8.32) is keyboard-only, and a
// webContents' own `input-event` carries no button identity — so unlike
// every other browser-level input in this app, this one has to be
// recognised in a renderer and handed to main. They arrive as ordinary
// DOM mouse events: button 3 = back, button 4 = forward. Capture phase,
// so a page can't swallow them before the browser gets its say — the
// same "the browser wins, not the page" rule §8.32 applies to Cmd+T.
window.addEventListener(
  'mouseup',
  (event) => {
    if (!event.isTrusted) return;
    if (event.button !== 3 && event.button !== 4) return;
    event.preventDefault();
    ipcRenderer.send(NAV_MOUSE_BUTTON, { direction: event.button === 3 ? 'back' : 'forward' });
  },
  true
);
