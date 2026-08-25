'use strict';

// Intentionally empty (DESIGN.md §2.3 / §7.6): this preload is attached to
// every BrowserView showing arbitrary, untrusted web content. There is no
// reason to expose any contextBridge API surface to arbitrary pages in
// v1. If a future feature needs one (e.g. a custom context menu using
// page selection text), expose the absolute minimum via contextBridge —
// never raw ipcRenderer, never Node globals.
