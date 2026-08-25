# RedRose Browser — v1 Design

A minimal, secure, Chromium-based desktop browser built with Electron. Custom
UI chrome (tab strip, toolbar) rendered as a normal Electron renderer;
each browsing tab is a separate `BrowserView` hosting the actual web content.
`<webview>` is explicitly rejected — it is deprecated-in-spirit, harder to
sandbox correctly, and `BrowserView` is the officially recommended
multi-tab pattern.

---

## 1. V1 Feature Scope

In scope:

- Tabs: create, close, switch, drag-to-reorder is OUT of scope for v1
  (nice-to-have, not required to ship).
- Address/URL bar that doubles as a search box:
  - Valid URL (has scheme, or looks like `host.tld[/path]`) → navigate directly.
  - Anything else → treated as a search query, sent to a default search
    engine (e.g. `https://www.google.com/search?q=...`).
- Navigation controls: back, forward, reload, stop (stop only enabled while
  loading).
- New tab (button + `Cmd/Ctrl+T`), close tab (button + `Cmd/Ctrl+W`),
  close-last-tab closes the window.
- Loading indicator: spinner/progress state on the tab and in the toolbar
  (reload button morphs into a stop button while loading).
- Page title shown in the tab; falls back to URL/hostname if the page has
  no `<title>`.
- Favicon in the tab (small win, cheap to add via `page-favicon-updated`).
- Basic keyboard shortcuts: `Cmd/Ctrl+T`, `Cmd/Ctrl+W`, `Cmd/Ctrl+L` (focus
  address bar), `Cmd/Ctrl+R`, `Cmd/Ctrl+[`/`]` (back/forward), `Cmd/Ctrl+Tab`
  (next tab).

Explicitly OUT of scope for v1 (call these out as deliberate cuts, not
oversights):

- Bookmarks (star button, bookmarks bar/manager) — cut for v1. It's pure
  UI + a JSON store with no architectural dependency on anything else here;
  add it in v1.1 once the core shell is stable.
- History (persisted, searchable) — cut for v1. Track only in-memory
  per-tab back/forward via Chromium's own navigation stack.
- Downloads UI/manager — cut for v1; let Electron's default download
  behavior (save-as prompt) happen for now.
- Extensions, profiles/multi-account, private/incognito windows, settings
  UI, find-in-page, print, dev tools toggle (dev tools can stay available
  via a hidden shortcut for engineering use, just no menu entry).
- Tab drag-to-reorder / detach-to-new-window.

Rationale: v1's job is to prove the process architecture (main / chrome
renderer / per-tab BrowserView + IPC contract) end to end with a usable,
secure browsing loop. Everything above is additive UI that doesn't change
that architecture.

---

## 2. Process Architecture

Three distinct execution contexts. Do not blur these boundaries.

### 2.1 Main process (`src/main`)

Node.js-privileged. Owns all app-level state and is the only place that
touches `BrowserWindow` / `BrowserView` APIs directly.

Responsibilities:
- Create and own the single top-level `BrowserWindow` ("chrome window").
- Create/destroy/show/hide `BrowserView` instances, one per tab.
- Own the `TabManager`: ordered list of tabs, which tab is active, each
  tab's nav state (url, title, favicon, isLoading, canGoBack, canGoForward).
- Wire up `WebContents` events (`did-start-loading`, `did-stop-loading`,
  `did-navigate`, `page-title-updated`, `page-favicon-updated`,
  `did-fail-load`) and forward summarized state to the chrome renderer via
  IPC.
- Handle all `ipcMain.handle` / `ipcMain.on` requests coming from the
  chrome renderer's preload bridge.
- Own window resize → reposition the active BrowserView's bounds (BrowserView
  does not auto-resize; main must recompute bounds under the toolbar/tab
  strip on every `resize` event and on tab switch).
- Enforce navigation/security policy (see §7) via `will-navigate`,
  `setWindowOpenHandler`, `will-attach-webview` (deny), permission requests.
- Application menu / global shortcuts.

### 2.2 Chrome renderer (`src/renderer`)

A normal Electron renderer process showing only the UI chrome: tab strip,
back/forward/reload buttons, address bar. It renders **no page content
directly** — page content lives in BrowserViews stacked below/beside it in
the same native window.

- Framework-agnostic requirement here, but plain HTML/CSS/vanilla JS (or a
  tiny framework like Preact) is enough for this surface — no need for a
  full SPA framework for a toolbar.
- Talks to main only through the `window.browserAPI` object exposed by the
  preload script (§2.3) — no direct `require('electron')`, no Node APIs.
- Purely reactive to state pushed from main (`tab-updated`, `tabs-changed`
  events) plus user-initiated calls (`navigate`, `newTab`, etc.).

**This renderer must run with:**
- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- a dedicated `preload.js` using `contextBridge`

### 2.3 BrowserView (page content)

Each tab is a `new BrowserView({ webPreferences: {...} })` attached to the
chrome window via `win.addBrowserView(view)` / `win.setTopBrowserView(view)`,
positioned below the toolbar with `view.setBounds(...)`.

**Non-negotiable `webPreferences` for every BrowserView, no exceptions:**

```js
{
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,          // never disable, even for "just testing"
  preload: PAGE_PRELOAD_PATH, // minimal or empty — see below
  javascript: true,           // page JS is fine to allow; it's sandboxed
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
}
```

This is loading arbitrary remote content, so it gets the strictest
defaults Electron offers. The page-content preload script
(`src/preload/page-preload.js`) should generally be empty or near-empty —
there is no reason to expose an API surface to arbitrary web pages. If a
feature later needs it (e.g. custom right-click menu using page selection
text), expose the absolute minimum via `contextBridge`, never
`ipcRenderer` directly, never Node globals.

### 2.4 Process/IPC diagram (textual)

```
┌───────────────────────────────────────────────────────────────────┐
│ Main process (Node, full privilege)                                │
│  - TabManager (source of truth for tab state)                      │
│  - BrowserWindow "chrome window"                                   │
│  - N x BrowserView (one per tab), only the active one visible      │
│  - ipcMain handlers                                                │
└───────────────────────────────────────────────────────────────────┘
        ▲ ipcRenderer.invoke/send      │ webContents events
        │ (via contextBridge)          ▼ (did-navigate, etc.)
┌────────────────────────┐    ┌─────────────────────────────────────┐
│ Chrome renderer          │    │ Per-tab BrowserView                │
│ (contextIsolation: true, │    │ (contextIsolation: true,           │
│  nodeIntegration: false, │    │  nodeIntegration: false,           │
│  sandbox: true)          │    │  sandbox: true, webSecurity: true) │
│ preload/chrome-preload.js│    │ preload/page-preload.js (minimal)  │
│  -> window.browserAPI    │    │  -> no privileged API exposed      │
└────────────────────────┘    └─────────────────────────────────────┘
```

---

## 3. File / Folder Layout

```
New/
├── package.json
├── electron-builder.yml            # packaging config (see §6)
├── DESIGN.md
├── src/
│   ├── main/
│   │   ├── index.js                 # app entry: app.whenReady, creates window
│   │   ├── chrome-window.js         # creates the top-level BrowserWindow
│   │   ├── tab-manager.js           # TabManager class: create/close/switch/state
│   │   ├── ipc-handlers.js          # registers all ipcMain.handle/on listeners
│   │   ├── navigation.js            # URL-vs-search-query resolution, will-navigate policy
│   │   ├── menu.js                  # application menu + accelerators
│   │   └── security.js              # centralizes webPreferences defaults, CSP, permission handler
│   ├── preload/
│   │   ├── chrome-preload.js        # contextBridge -> window.browserAPI (for chrome renderer)
│   │   └── page-preload.js          # minimal/empty, attached to each BrowserView
│   ├── renderer/                    # the chrome UI (tab strip + toolbar)
│   │   ├── index.html
│   │   ├── index.js                 # renders UI, subscribes to browserAPI events
│   │   ├── components/
│   │   │   ├── TabStrip.js
│   │   │   ├── Toolbar.js
│   │   │   └── AddressBar.js
│   │   └── styles.css
│   └── shared/
│       ├── ipc-channels.js          # single source of truth for channel name constants
│       └── url-utils.js             # isLikelyUrl(), normalizeInput() — shared logic used by
│                                     # both navigation.js (main) and AddressBar.js (renderer,
│                                     # for optimistic UI) if duplicated, keep in sync manually
├── build/                           # icons, entitlements for electron-builder
└── test/
    ├── main/
    └── e2e/                         # Playwright/Spectron-style smoke tests
```

Key layout decisions:
- `shared/ipc-channels.js` is required reading before touching IPC — it's
  the contract in §4, expressed as code, imported by both main and the
  chrome preload script so channel names can never drift out of sync.
- `src/main` never imports anything from `src/renderer`; `src/renderer`
  never imports anything from `src/main` or Node built-ins. The only
  bridge is `src/preload`.

---

## 4. IPC Contract

All channel names live in `src/shared/ipc-channels.js` as constants (shown
here as string literals for readability). Two directions:

- **Renderer → Main**: exposed on `window.browserAPI` via `contextBridge`,
  implemented with `ipcRenderer.invoke` (request/response) for actions,
  `ipcRenderer.send` only for fire-and-forget UI events if ever needed.
- **Main → Renderer**: pushed via `webContents.send`, received in the
  renderer via a `browserAPI.on(event, callback)` subscription registered
  in the preload script (never expose raw `ipcRenderer.on` to the
  renderer — wrap it so the renderer can't listen to arbitrary channels).

### 4.1 Renderer → Main (invoke/handle)

| Channel           | Payload                          | Returns / Effect |
|--------------------|-----------------------------------|-------------------|
| `tabs:create`      | `{ url?: string }`                | Creates a new tab (defaults to new-tab page/blank), makes it active. Returns `{ tabId }`. Triggers `tabs:changed`. |
| `tabs:close`       | `{ tabId: string }`               | Destroys the BrowserView for that tab. If it was active, activates the next tab (or closes window if it was the last). Triggers `tabs:changed`. |
| `tabs:activate`    | `{ tabId: string }`               | Switches the visible BrowserView. Triggers `tabs:changed`. |
| `nav:go`           | `{ tabId: string, input: string }`| Runs `normalizeInput()`: if it looks like a URL, load it; else build a search-engine URL. Triggers `tab:updated`. |
| `nav:back`         | `{ tabId: string }`               | `view.webContents.goBack()` if `canGoBack`. |
| `nav:forward`      | `{ tabId: string }`               | `view.webContents.goForward()` if `canGoForward`. |
| `nav:reload`       | `{ tabId: string }`               | `view.webContents.reload()`. |
| `nav:stop`         | `{ tabId: string }`               | `view.webContents.stop()`. |
| `tabs:getAll`      | `{}`                              | Returns `{ tabs: TabState[], activeTabId: string }` — used on chrome-renderer mount to hydrate initial state. |

`TabState` shape (used both in `tabs:getAll` response and in the
`tab:updated` push event):

```ts
{
  id: string,            // uuid, generated by main when tab is created
  url: string,
  title: string,
  favicon: string | null,
  isLoading: boolean,
  canGoBack: boolean,
  canGoForward: boolean,
}
```

### 4.2 Main → Renderer (push events)

| Channel          | Payload                                        | When |
|-------------------|-------------------------------------------------|------|
| `tabs:changed`    | `{ tabs: TabState[], activeTabId: string }`     | Whenever the tab list/order/active tab changes (create/close/activate). Full snapshot, not a diff — keeps the renderer trivially consistent. |
| `tab:updated`     | `{ tab: TabState }`                             | Whenever a single tab's nav state changes (loading start/stop, title, favicon, url change, back/forward availability). Renderer patches its local copy by `id`. |
| `tab:load-failed` | `{ tabId: string, errorCode: number, errorDescription: string, validatedURL: string }` | On `did-fail-load` (excluding aborted-by-user code `-3`). Renderer can show an inline error state. |

### 4.3 Preload bridge shape (`chrome-preload.js`)

```js
contextBridge.exposeInMainWorld('browserAPI', {
  createTab: (url) => ipcRenderer.invoke('tabs:create', { url }),
  closeTab: (tabId) => ipcRenderer.invoke('tabs:close', { tabId }),
  activateTab: (tabId) => ipcRenderer.invoke('tabs:activate', { tabId }),
  navigate: (tabId, input) => ipcRenderer.invoke('nav:go', { tabId, input }),
  goBack: (tabId) => ipcRenderer.invoke('nav:back', { tabId }),
  goForward: (tabId) => ipcRenderer.invoke('nav:forward', { tabId }),
  reload: (tabId) => ipcRenderer.invoke('nav:reload', { tabId }),
  stop: (tabId) => ipcRenderer.invoke('nav:stop', { tabId }),
  getAllTabs: () => ipcRenderer.invoke('tabs:getAll'),

  onTabsChanged: (cb) => subscribe('tabs:changed', cb),
  onTabUpdated: (cb) => subscribe('tab:updated', cb),
  onTabLoadFailed: (cb) => subscribe('tab:load-failed', cb),
});
```

`subscribe()` is a small internal helper that wraps `ipcRenderer.on` and
returns an unsubscribe function, so the renderer never gets a raw
`ipcRenderer` reference and can't register listeners on arbitrary
channels.

---

## 5. UI Layout Wireframe

Revised from the original top-tab-strip layout to three columns, matching
ScriptureDesk's actual two-panel shell exactly (not just its color
convention): a narrow 64px app rail (glyph badge, vertical shimmering app
name, icon buttons pinned to the bottom — ScriptureDesk's `.rail`), a
wider tab-list panel next to it (ScriptureDesk's `.list-pane`), then the
topbar + content to the right.

```
┌────┬───────────────┬────────────────────────────────────────────────┐
│ RR │  + New Tab    │ [<] [>] [⟳/×]  ┌──────────────────────────────┐│  ← Toolbar
│    │               │ back fwd reload│ 🔒 https://example.com/path  ││
│ R  │ ● Google    × │                └──────────────────────────────┘│
│ e  │   GitHub    × ├────────────────────────────────────────────────┤
│ d  │ ○ News      × │                                                │
│ R  │  (loading)    │                                                │
│ o  │               │        BrowserView (active tab's page)         │  ← Content area
│ s  │               │        fills remaining window bounds           │
│ e  │               │                                                │
│    │  (tab panel)  │                                                │
│ ⚙  │               │                                                │
└────┴───────────────┴────────────────────────────────────────────────┘
 rail
```

Layout notes:
- The rail (`.rail`), tab panel (`#sidebar`, holding `#tab-list`), and
  topbar (nav buttons + address/search bar, `#toolbar`) are rendered by
  `src/renderer` (HTML/CSS) inside the chrome `BrowserWindow`. The rail
  and tab panel both run the full window height on the left, side by
  side (rail ~64px, tab panel ~200px); the topbar runs across the
  remaining width at the top (~48px). The measurements below are the
  values main.js uses when calling `view.setBounds()` — the actual
  layout must match `styles.css` or the BrowserView will occlude/
  misalign under the chrome.
- The BrowserView's bounds are computed in main as
  `{ x: RAIL_W + TAB_PANEL_W, y: TOPBAR_H + PROGRESS_H, width: winWidth - (RAIL_W + TAB_PANEL_W), height: winHeight - (TOPBAR_H + PROGRESS_H) }`
  (`SIDEBAR_W` in code is `RAIL_W + TAB_PANEL_W` combined),
  recalculated on `BrowserWindow`'s `resize` event and whenever the active
  tab changes (only the active tab's view is attached/topmost;
  inactive tabs can either stay attached-but-hidden-behind or be
  detached — detaching and re-attaching on switch is simpler and avoids
  paint of hidden views; recommended for v1).
- Loading indicator: a thin progress bar (CSS width transition driven by
  `isLoading` toggling, indeterminate animation — no need for real
  percentage since Electron doesn't expose granular load progress) shown
  under the toolbar, plus a spinner glyph swapped in on the tab itself.
- The address bar doubles as the search bar (§1) and now spans the full
  remaining width of the topbar, since nav buttons are the only other
  occupants of that row once tabs moved to the sidebar. It shows a
  lock/info icon reflecting `https:` vs `http:` (purely cosmetic in v1 —
  no full security-state UI, no cert details).

---

## 6. Key Dependencies & Versions

- **Node.js**: 20.x LTS minimum (Electron 30+ bundles Node 20).
- **Electron**: pin to latest stable major at time of implementation —
  currently **43.x** (ships a current Chromium; check
  [electronjs.org/docs/latest/tutorial/electron-timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
  for what any given major bundles). Track upstream security releases; do
  not fall behind more than one major version, since Chromium security
  patches are the whole point of this stack.
  Electron has **no separate background updater for its bundled
  Chromium** — unlike an installed browser, a security patch only reaches
  this app when someone bumps the `electron` devDependency and ships a
  new build. There's no CI/cloud automation for this (the project isn't
  in a git repo), so run `npm run check-electron`
  (`scripts/check-electron-updates.js`) periodically — it compares the
  installed version against npm's `latest` dist-tag and prints the
  upgrade command if one's available; it never changes anything on its
  own.
- **electron-builder**: for packaging/distribution (`dmg`, `nsis`,
  `AppImage` targets) — simpler config surface than `electron-forge` for a
  single-window app like this; either is defensible, electron-builder is
  the more common default.
- Dev-only: `electron-devtools-installer` optional; a bundler
  (`esbuild` or `vite`) for the renderer if it grows beyond plain
  HTML/CSS/JS — not required for v1's small toolbar surface.
- No runtime UI framework is required; if the team prefers React/Preact
  for the tab strip, add it as a renderer-only dependency — it must never
  leak into `src/main` or `src/preload`.

`package.json` engines field should pin:
```json
"engines": { "node": ">=20.0.0" }
```

---

## 7. Security Defaults — Must Not Be Violated

These are hard constraints, not tuning knobs. Any PR that changes one of
these needs an explicit, written justification and a second reviewer,
because it is the entire reason to use `BrowserView` over `<webview>` in
the first place:

1. **Every renderer that can touch remote/untrusted content
   (`nodeIntegration: false`)** — always, no exceptions, including the
   chrome renderer even though it only shows trusted local HTML.
2. **`contextIsolation: true`** on every `BrowserWindow` and every
   `BrowserView`, with no exceptions. Never set this to `false` "to make
   the preload script simpler."
3. **`sandbox: true`** on every renderer and every BrowserView.
4. **`webSecurity: true`** always — never disabled to work around CORS or
   mixed-content issues during development. If a real feature needs
   relaxed CORS, solve it with a proper proxy or CSP, not by disabling
   `webSecurity`.
5. **No `eval()` or `new Function()` of remote/dynamic strings** anywhere
   in main or preload code. Renderer-loaded web *pages* running their own
   JS is fine (that's normal browsing) — this rule is about our own
   application code, main process, and preload scripts never evaluating
   strings sourced from the network or from IPC payloads.
6. **`preload` scripts stay minimal.** `page-preload.js` (attached to
   BrowserViews showing arbitrary sites) exposes nothing via
   `contextBridge` unless a specific, reviewed feature needs it — and
   even then, expose narrow functions, never raw `ipcRenderer` or Node
   modules.
7. **`setWindowOpenHandler`** on every BrowserView denies popups by
   default (`return { action: 'deny' }`), or explicitly allows opening a
   new managed tab via `tabs:create` — never `require('electron').shell`
   auto-opens or raw `window.open` passthrough to an unmanaged
   `BrowserWindow`.
8. **`will-navigate` / `will-redirect`** handlers validate top-level
   navigations against an allow-policy (e.g., block `file://`,
   `chrome://`, and other privileged schemes from being reachable by
   page-initiated navigation) — main is the enforcement point, not the
   renderer.
9. **Permission requests** (camera, mic, geolocation, notifications, etc.)
   from BrowserViews go through `session.setPermissionRequestHandler` and
   are denied by default in v1 (no UI to prompt the user yet) rather than
   silently allowed.
10. **IPC channel allowlisting**: `ipcMain.handle`/`.on` register only the
    channels enumerated in §4 — no wildcard/dynamic channel name
    handling, so a compromised renderer can't invoke something
    unanticipated.
11. **Never load remote content into the chrome renderer.** `index.html`
    for the chrome UI is always loaded via `loadFile()` from local disk,
    never `loadURL()` against a remote origin — the chrome renderer is
    the one place with `browserAPI` access and must stay 100% local/
    trusted code.
12. **Content-Security-Policy** on the chrome renderer's `index.html` (a
    `<meta http-equiv="Content-Security-Policy">` tag) restricting
    `script-src 'self'`, disallowing inline scripts — belt-and-suspenders
    given nodeIntegration is already off.

If a future feature seems to require violating one of these (e.g. an
extension system, or a webview-hosted settings page that needs Node
access), that is a signal to redesign the feature, not to weaken the
default.

---

## 8. Pinned Tabs, Tab Groups, Multiple Profiles

Added post-v1. Each is a straightforward extension of the tab model
except profiles, which forks the architecture — documented here so the
reasoning isn't lost.

### 8.1 Pinned tabs

- `TabState` gained `pinned: boolean`. `TabManager.setPinned(tabId, pinned)`
  keeps pinned tabs contiguous at the front of `order` (so the renderer
  can trust `order` as the whole sort, pinned first) without otherwise
  reordering within either group.
- Pinned tabs render as a compact 32×32 icon-only row above the regular
  list (`#sidebar` → `.pinned-row`). No visible close button — pin/unpin
  and close both live in the right-click context menu, matching the
  Chrome convention that pinned tabs shouldn't be easy to close by
  accident.
- Sites with no real favicon (or Chromium's degenerate `data:,`
  empty-favicon report — see `TabStrip.js` `applyFavicon`) fall back to a
  colored letter glyph so a pinned tab is never a blank, unidentifiable
  square.

### 8.2 Tab groups

- `TabState` gained `groupId: string | null`. `TabManager` owns a
  `groups: Map<id, {id, name, color}>` alongside its tabs.
- Colors are a fixed 8-name palette (`grey/blue/red/yellow/green/pink/
  purple/cyan`, see `GROUP_COLORS` in `tab-manager.js` and the matching
  hex table in `src/renderer/components/GroupColors.js`) — deliberately
  independent of the active color theme so a group's color stays stable
  and distinguishable no matter which of the §9 themes is active.
- A group with zero remaining tabs is pruned automatically
  (`_pruneOrphanGroups`, called after every close/regroup) rather than
  lingering as dead state.
- Deleting a group only ungroups its tabs — it never closes them. Closing
  a whole group at once was deliberately left out of v1 as a destructive
  action with no undo.
- Created via the tab context menu ("New group from tab" / "Move to
  ‘Name’"); renamed by double-clicking the group header; recolored via a
  small popover on the header's color dot.

### 8.3 Multiple profiles — single window, workspace-style

Real browsers give each profile its own OS window with fully isolated
storage. **This app deliberately does not** — profiles behave more like
workspaces switched within one window. That trade-off was made
explicitly (not a default arrived at by omission): it's simpler to build
and to use for quick switching, at the cost of not matching how
Chrome/Edge/Firefox profiles actually behave. If that mismatch ever
matters (e.g. wanting two profiles visible side-by-side), the fix is a
real second `BrowserWindow` per profile, which is a bigger change than
extending the current `ProfileManager`.

- `ProfileManager` (`src/main/profile-manager.js`) owns every profile and,
  per profile, a `TabManager` instance whose `BrowserView`s all share
  that profile's `session.fromPartition('persist:profile-<id>')` — cookies,
  storage, and cache are fully isolated between profiles, same as real
  browser profiles. `installPermissionHandler` (§7.9) is installed on
  each profile's session individually, not just the default session.
  Only the active profile's `TabManager` has a `BrowserView` attached to
  the window at a time; switching detaches the outgoing one and attaches
  the incoming one — same detach/reattach mechanism §7's `hideActiveView`/
  `showActiveView` already used for the settings modal.
- A profile's `TabManager` (and its `BrowserView`s) is created lazily,
  the first time that profile is switched to, and then kept alive in
  memory for the rest of the session — switching back to a
  previously-visited profile is instant and never reloads its tabs.
- Profiles (id/name/color — never tab/session data) persist to
  `profiles.json` in `app.getPath('userData')`, so the profile *list*
  survives a restart even though open tabs don't (consistent with v1's
  existing no-history-persistence scope).
- The rail's glyph button (previously a decorative "home" click-to-new-tab
  shortcut) is now the profile switcher's entry point — click it to open
  a popover listing profiles (switch/rename/delete) plus an inline
  "create profile" form. This reuses the same popover primitive
  (`src/renderer/components/ContextMenu.js` → `showPopover`) as the
  group color picker.
- Closing the last tab in a profile no longer closes the window (that
  v1 behavior assumed one profile == one window's worth of tabs); it now
  reseeds a fresh blank tab in that profile instead
  (`TabManager.closeTab`'s zero-tabs branch). The window only closes via
  an explicit OS close or Quit.
- Deleting a profile drops it from the switcher and closes its tabs
  (`TabManager.destroyAll()` — full teardown, unlike `closeTab()`, since
  the instance is being discarded) but does **not** wipe its session
  partition's cookies/storage on disk — profiles here are workspaces, not
  accounts with data to nuke on removal.

### 8.4 Bookmarks — per profile, persisted independently of tabs

- New `src/main/bookmark-store.js`: unlike tabs (deliberately not
  persisted, §1) or groups (in-memory only, `TabManager.groups`),
  bookmarks are meant to survive a restart, so they get their own store
  keyed by profile id and persisted to `bookmarks.json` in
  `app.getPath('userData')` — independent of `TabManager`/`ProfileManager`
  entirely, just referenced by `ProfileManager` via `this.activeProfileId`
  the same way tab/group operations already dispatch to whichever
  profile is active.
- The rail's bookmarks button (next to the settings gear) opens a
  popover listing the active profile's bookmarks — same `showPopover`
  primitive as the group color picker and profile switcher, so it's
  automatically clamped within the chrome area (§8.3's context-menu
  note) and never covers the page.
  Deleting a profile does **not** delete its bookmarks (same
  data-preservation stance as its session partition, §8.3) — they're just
  unreachable from the switcher until/unless that profile id is reused.
- Adding a bookmark happens via a star toggle in the address bar
  (`#btn-star`), disabled on non-navigable pages (`about:blank`).
  `BookmarkStore.toggle()` matches by URL — clicking a starred page's
  star again removes it, so there's no separate "already bookmarked"
  dialog or duplicate-prevention step to build.

### 8.5 Window size/position memory

- New `src/main/window-state.js`: persists the chrome `BrowserWindow`'s
  bounds, maximized state, and (macOS) native fullscreen state to
  `window-state.json` in `app.getPath('userData')`, restored on the next
  launch. This is app-window state, not per-profile — unlike tabs/
  bookmarks it isn't scoped to `ProfileManager`.
- Maximized (`isMaximized`) and fullscreen (`isFullScreen`) are tracked
  and restored separately — on macOS the green traffic-light button
  triggers native fullscreen (`setFullScreen`/`enter-full-screen`/
  `leave-full-screen`), a distinct Electron concept from `maximize()`/
  `isMaximized()`. Restoring the wrong one would leave the window in the
  wrong state on relaunch.
- A saved `x`/`y` is only trusted if it still overlaps a currently
  connected display's work area (`isVisibleOnSomeDisplay`) — otherwise
  (an external monitor since unplugged, a changed display arrangement)
  the window falls back to Electron's default centered placement rather
  than restoring off-screen and unreachable.
- The window is created with `show: false` and only shown on
  `ready-to-show`, with maximize/fullscreen applied beforehand — avoids a
  visible flash of the un-maximized window before it snaps to its
  restored state.
- Saves are debounced (500ms) during active resize/move, plus an
  unconditional synchronous save on `close`, so state isn't lost if the
  app quits mid-drag.

### 8.6 Load-failure / certificate-error page

- `did-fail-load` and a blocked-scheme navigation (§7.8) previously just
  logged to the devtools console (or did nothing at all) — invisible to
  the user, which is actively bad for a *security* signal: a silent
  failure on a certificate error reads as "the site is down," not "this
  connection isn't safe." Both now navigate the tab's `BrowserView` to a
  local `src/renderer/error-page.html` (own strict CSP, no inline
  script — `error-page.js` is external) with the failure details in the
  query string.
- The address bar keeps showing the URL the user actually tried to
  visit, not `error-page.html`'s own `file://` path — `TabManager`
  stashes it as `tab._pendingErrorUrl` before loading the error page and
  the next `did-navigate` (which fires for that load) special-cases it
  instead of overwriting `tab.url`/`tab.title` normally.
  `error-page.js` distinguishes three cases from the passed error code/
  description: a policy block (`code: '0'`, TabManager's own synthetic
  value, no "Try again" since retrying a blocked scheme can't succeed),
  a certificate error (`net::ERR_CERT_*` range, stronger "connection
  isn't private" wording), and a generic failure (DNS, connection
  refused, etc).
- This is presentation only — it does not change what Chromium already
  blocks. Certificate validation itself was already strict by default
  (no `certificate-error` handler override anywhere in this codebase, no
  `setCertificateVerifyProc`, `webSecurity` always `true` — see §7); this
  section just makes an existing safe default *visible*.

### 8.7 Malicious-site (phishing/malware) blocklist

Real browsers warn on known-bad sites via a live threat-intelligence API
(Google Safe Browsing, Microsoft SmartScreen). This app deliberately does
**not** integrate one — that choice was made explicitly, not by default:
a live API means every visited hostname (as a hash prefix, in Safe
Browsing's case) leaves the machine on every navigation, and needs an
API key/account to be provisioned and kept working. Given this app has
no accounts/telemetry infrastructure at all otherwise, an offline local
list was the more consistent choice — the trade-off is coverage that's
only as fresh as the last manual refresh, not real-time.

- `src/main/blocklist.js` loads `src/main/blocklist.txt` (a merged,
  deduped snapshot of hostnames from abuse.ch URLhaus's malware host
  file and OpenPhish's free phishing feed — both no-account, no-API-key
  feeds) into a `Set` once at startup and checks it purely locally
  against the navigation target's hostname — **no network request is
  ever made by the running app for this feature**, unlike Safe Browsing.
  A match includes subdomains (`evil.com` blocks `login.evil.com`) via
  suffix comparison, never a bare substring match.
- `security.js`'s `classifyNavigation(url)` combines this with the
  existing scheme blocklist (§7.8) into one verdict (`'ok' | 'scheme' |
  'malicious'`) — every navigation entry point (typed address-bar input,
  `createTab(url)`, and page-initiated `will-navigate`/`will-redirect`/
  `window.open` via `navigation.js`'s `onBlocked` callback) now routes
  through it and shows the matching error page (§8.6) instead of some
  paths blocking silently and others not.
- The list is refreshed manually: `npm run update-blocklist`
  (`scripts/update-blocklist.js`) re-fetches both feeds and rewrites
  `blocklist.txt` — a deliberate maintainer action, same pattern as
  `npm run check-electron` (§6), not an automatic background updater.
  As of this writing it's ~590 hostnames — small enough that the `Set`
  lookup is effectively free per navigation.

### 8.8 Chrome extensions — per-profile, installed from a Web Store URL/ID

Extensions are installed directly from a Chrome Web Store URL or bare
32-character extension ID (`[a-p]{32}`), not from a locally unpacked
folder — the more convenient but less-vetted path was the explicit
choice made when this feature was scoped, on the reasoning that
downloading the CRX Google already serves for that ID is no less
trusted than what stock Chrome does for the same install flow. Like
tabs, groups, and bookmarks, installed extensions are scoped **per
profile** (§8.3): each profile only sees and runs the extensions it
installed, consistent with profiles being fully isolated sessions.

- `src/main/crx-download.js` — `parseExtensionRef(input)` extracts the
  extension ID from either a bare ID or a `chrome.google.com/webstore`
  / `chromewebstore.google.com` URL. `downloadCrx(id)` fetches the CRX
  from Google's unauthenticated update endpoint
  (`clients2.google.com/service/update2/crx`, `installsource=ondemand`)
  over `https`, with a size cap, timeout, and bounded redirect-follow —
  the same endpoint Chrome itself uses, no API key. `extractZipFromCrx`
  strips the CRX2/CRX3 header (validating the `Cr24` magic) down to the
  inner ZIP.
- `src/main/safe-unzip.js` extracts that ZIP with a hand-rolled
  extractor built directly on `yauzl`, **not** the popular `extract-zip`
  package — that package was tried first, but `npm audit` flagged an
  unpatched high-severity symlink path-traversal advisory
  (GHSA-jmr9-qjv8-65gv, no fix available) as a runtime dependency,
  which is exactly the vulnerability class that matters when extracting
  an untrusted downloaded archive. The hand-rolled extractor explicitly
  rejects symlink entries (via the Unix mode bits in
  `externalFileAttributes`) and zip-slip path traversal (resolved path
  must stay under the destination dir), plus enforces total-size,
  per-file-size, and entry-count caps against zip bombs.
- `src/main/extension-manager.js` is the per-profile registry: it
  persists `{id, name, version, description, enabled}` records to
  `extensions.json` in the app's userData dir, extracts each install
  into `extensions/<profileId>/<extensionId>/`, and loads/unloads
  extensions into that profile's session via Electron's
  `session.extensions.loadExtension()` / `.removeExtension()` (the
  current, non-deprecated API) — never the global default session, so
  an extension installed in one profile never runs in another.
  `loadAllForProfile()` re-loads every enabled record when a profile's
  session is first created (app start or first switch into that
  profile), so installs persist across restarts the same way bookmarks
  and tabs do.
- The rail's puzzle-piece button (`src/renderer/components/Extensions.js`)
  opens a popover — a text field to install by URL/ID, and a row per
  installed extension with an enable/disable toggle and a remove
  button — following the same popover/rail-button pattern as bookmarks
  (§8.4) and the profile switcher (§8.3), including the same
  chrome-area width clamping so it never needs to hide the page's
  `BrowserView`.
- No toolbar action-button UI (the row of extension icons next to the
  address bar that stock Chrome shows) is built — installed extensions'
  background/content-script behavior runs, but an extension that relies
  on a toolbar popup for its primary UI won't be reachable that way in
  v1. This is a known, explicit scope limit, not an oversight.

#### 8.8.1 Making extensions actually work — the `electron-chrome-extensions` bridge, and why this project is now GPL-3.0

Installing an extension and having it actually *work* turned out to be
two different problems. Electron's own built-in extension support
(`session.extensions`) implements only a bare minimum aimed at DevTools
use cases — no `chrome.tabs`, `chrome.windows`, `chrome.contextMenus`,
or `chrome.webNavigation` at all. Loaded that way, real extensions
either crash immediately (their background script references an
undefined API) or silently no-op.

**The fix**: [`electron-chrome-extensions`](https://github.com/samuelmaddock/electron-browser-shell)
(`src/main/chrome-extensions-bridge.js`) layers those missing APIs on
top of Electron's core support — one instance per profile, tied to
that profile's session and `TabManager` via `createTab`/`selectTab`/
`removeTab` hooks, and `TabManager`'s new `onTabCreated` callback
(`tab-manager.js`) registers every tab with it via `addTab()` the
moment its `BrowserView` exists. This is verified, working
integration — background pages run without crashing, `chrome.tabs.*`
tracks our real tabs, `browserAction.setIcon`/`setBadgeText` fire per
navigation, and `chrome.tabs.insertCSS` (cosmetic filtering) executes
correctly.

**The license trade-off this required**: `electron-chrome-extensions`
is dual-licensed — free under GPL-3.0 (copyleft: whatever links it
must also be GPL-3.0), or a paid "Patron License" for closed-source
use. This project chose the free GPL-3.0 path — see `LICENSE` and
`package.json`'s `license` field — rather than a recurring paid
license, meaning RedRose Browser's source must stay available under
GPL-3.0 to anyone it's distributed to.

**What this does *not* fix — a real, verified Electron limitation**:
Even with the bridge, ad blockers specifically still don't block
anything, for two independent reasons found through direct testing
(not assumption):

1. **uBlock Origin *Lite* (MV3)** crashes its service worker on the
   very first line it runs (`browser.permissions.onRemoved` — the
   WebExtension-standard `browser.*` global exists in Electron but
   doesn't mirror `chrome.permissions`, only `chrome.*` does). Its
   whole blocking mechanism is `chrome.declarativeNetRequest` anyway,
   which is implemented by neither Electron core nor this bridge, so
   it couldn't block anything even past that crash.
2. **Classic uBlock Origin (MV2)**, which the bridge genuinely helps —
   confirmed loading cleanly, tracking tabs, and fully compiling its
   real filter lists (EasyList etc., verified non-zero rule counts) —
   *still* doesn't block network requests. Root cause, isolated with a
   minimal test extension: Electron reports `details.tabId` as `-1` on
   every `chrome.webRequest` event for **every** tab this app creates,
   whether hosted in a `BrowserView` or as a plain `BrowserWindow`'s
   own `webContents` — there's no public Electron API to get a real,
   non–`-1` tabId assigned. Blocking itself works fine at the
   mechanical level (a test extension that blocks unconditionally,
   ignoring `tabId`, does block successfully) — but uBlock's actual
   filtering logic keys per-tab state off a valid `tabId` to know which
   page a request belongs to, and silently declines to act when it
   can't resolve that. This is an Electron platform gap, not something
   fixable in this app's or the bridge library's code.

**Net effect**: extensions that don't depend on `webRequest`'s tabId
(most non-ad-blocker extensions — content-script tools, storage-backed
utilities, theme/appearance extensions, anything driven by
`chrome.tabs`/`chrome.windows`/`browserAction` rather than per-tab
request blocking) are now meaningfully more likely to work end-to-end
than before this bridge existed. Ad blockers and other extensions that
gate their core behavior on a real `tabId` are not fixable within
Electron's current public API surface — but see §8.8.2: ad blocking
itself was still achievable, just not *as a Chrome extension*.

#### 8.8.2 Built-in ad/tracker blocking — solving it without a Chrome extension

Given §8.8.1's finding — Chrome-extension ad blockers structurally
cannot work in Electron because `chrome.webRequest`'s `tabId` is always
`-1` — the fix was to stop routing ad blocking through the extension
system at all. Electron's own native `session.webRequest` API (not the
`chrome.webRequest` an extension sees) was confirmed working reliably
in the same investigation, and critically its request-details object
carries a real, always-valid `webContentsId` instead of the broken
`tabId`. `@ghostery/adblocker-electron` — a library built specifically
for this exact problem, MPL-2.0 licensed, used by other Electron-based
browsers — wires an EasyList/uBlock-filter-compatible blocking engine
directly onto `session.webRequest.onBeforeRequest`/`onHeadersReceived`,
sidestepping the extension layer (and its broken tabId) entirely.

- `src/main/ad-blocker.js`'s `AdBlocker` loads a pre-built filter
  engine from a checked-in binary (`src/main/adblock-engine.bin`) via
  `ElectronBlocker.deserialize()` — **no network call at runtime**,
  same zero-runtime-fetch stance as the malicious-site blocklist
  (§8.7). `enableForSession(session)` is called once per profile
  session in `profile-manager.js`'s `_ensureTabManager`, alongside
  extension loading, so blocking is on by default for every profile.
- `scripts/update-adblock-lists.js` (`npm run update-adblock-lists`)
  rebuilds that binary from Ghostery's maintained prebuilt
  ads+tracking lists and re-serializes it — a deliberate manual
  maintainer action, same refresh pattern as
  `npm run update-blocklist` (§8.7) and `npm run check-electron` (§6).
- Verified directly, not assumed: with this enabled, requests to
  `pagead2.googlesyndication.com`, `googletagmanager.com`, and
  `google-analytics.com` are blocked, while a normal same-page fetch to
  the page's own origin still succeeds — the engine discriminates
  correctly, it isn't blocking everything.
- One constraint worth knowing: Electron only supports **one**
  registered `session.webRequest.onBeforeRequest` listener per session
  — the library's own code notes this. `AdBlocker` is currently the
  only thing in this app registering one, but if that ever changes,
  the two would silently clobber each other rather than both running;
  whichever registers last wins.
- This is a separate mechanism from the §8.8.1 extensions bridge, not
  a replacement for it — a user can still install a real Chrome
  extension for other purposes (its network-blocking just won't work
  if it's the kind of extension that needs one); this built-in blocker
  is what actually delivers working ad/tracker blocking.

#### 8.8.3 Making other real-world extensions actually run — three fixes found debugging 1Password's extension

§8.8.1's bridge and §8.8.2's blocker made ad blocking work, but other
extension categories hit their own, different problems. Debugging why
1Password's extension didn't work (crashed immediately) surfaced three
separate, real bugs — one genuinely fixable in Electron's extension
model, two in this app's own code:

1. **The `browser.*` namespace gap.** Chromium's `browser.*`
   WebExtension-compat global (used by extensions written for
   cross-browser/Firefox portability) only mirrors a *subset* of
   `chrome.*` in Electron — confirmed empirically: `browser.tabs` and
   `browser.runtime` exist, but `browser.windows`, `browser.storage`,
   `browser.permissions`, and `browser.contextMenus` do not, even
   though every one of those works fine under `chrome.*` (§8.8.1's
   bridge covers that side). Extensions that reference a missing one —
   both uBlock Origin Lite (`browser.permissions.onRemoved`) and
   1Password's extension (`browser.windows.WINDOW_ID_NONE`) do, on
   effectively their first line of background code — crash their
   entire background/service-worker script before anything else runs.
   A `session.registerPreloadScript({type: 'service-worker', ...})`
   was tried first, since Electron explicitly supports that context
   type; it doesn't work — empirically, `chrome`/`browser` are still
   `undefined` inside it, meaning it executes in a separate realm from
   the extension's own script rather than sharing globals with it. The
   fix that does work: `src/main/browser-ns-polyfill.js` (a small,
   generic "alias any missing `browser.X` to the working `chrome.X`"
   snippet) is prepended as raw text directly into the extension's own
   background entry file on disk, once, at install time
   (`_injectBrowserPolyfill` in `extension-manager.js`, called right
   after the manifest is parsed and before the first `loadExtension`)
   — same realm, same timing as the extension's own code, which is
   confirmed to have working `chrome`/`browser` bindings by then.
   Handles MV3 `service_worker`, MV2 `scripts[]`, and MV2 HTML
   `background.page` shapes.
2. **A tab-creation race in this app's own code.** In
   `profile-manager.js`'s `_ensureTabManager`, extensions were being
   loaded (`extensionManager.loadAllForProfile`) *before* the seed tab
   was created and registered with the extensions bridge
   (`tm.createTab()`). An extension whose background script calls
   `chrome.tabs.get()`/`chrome.windows.getCurrent()` during its own
   startup — a common pattern — could run with zero tabs known to the
   bridge yet, getting back `undefined` instead of real data. Some
   extensions handle that gracefully; 1Password's didn't (a further
   uncaught `Cannot read properties of null (reading 'id')`). Fixed by
   simply reordering: the seed tab is now created *before* extensions
   are loaded for that profile.
3. **Extension-id mismatch for manifests without an embedded signing
   `key`.** `extension-manager.js`'s `install()` used to store the
   Chrome-Web-Store id (parsed from the install URL/ref) as the
   record's `id`. But Electron's `loadExtension()` only reproduces that
   real id when the manifest embeds a signing `key` field — many
   extensions don't have one (1Password's confirmed doesn't), and get a
   different, directory-derived id instead. Since `remove()`/
   `setEnabled()` call `session.extensions.removeExtension(id)` with
   whatever id is stored, a mismatch meant those silently targeted an
   id Chromium didn't recognize — the UI would show "removed" while the
   extension kept running. Fixed by storing *both*: `sourceId` (the
   Web-Store-parsed id — stable, used only for this app's own directory
   layout and install-dedup bookkeeping) and `id` (`loaded.id`, whatever
   Electron actually assigned — used for every `session.extensions.*`
   call, and what's exposed to the UI/IPC).

**Where this leaves 1Password specifically**: with all three fixes,
its extension installs, loads without crashing, its background script
runs its full real startup sequence (theme setup, storage migration,
etc.), and it correctly/gracefully falls back when native-messaging
desktop-app integration fails (§8.8.1 already established Electron
doesn't support `chrome.runtime.connectNative` at all — expected, not
fixable here). Its popup renders 1Password's actual UI and exchanges
several successful `chrome.runtime.sendMessage` round-trips with the
background script (`get-popup-config`, `get-popup-restore-point`,
`get-active-tab`, `popup-ready` all resolve) — but currently stalls on
a loading spinner rather than reaching the sign-in form. Traced as far
as: the last message sent is `set-popup-restore-point`, after which
nothing further happens for 45+ seconds. This no longer looks like a
missing API (nothing throws) — it looks like 1Password's own
popup-side state logic not reaching a resolved state given the
response shapes it's getting from an Electron-hosted background
script, which is a much harder thing to keep debugging from outside
the extension's own (also minified) source. Documented here rather
than silently left unfixed.

**Update, after further tracing**: the "never resolves" read above was
wrong — it was an artifact of only instrumenting Promise-style
`sendMessage` calls. 1Password's popup actually uses the 3-argument
callback form (`sendMessage(msg, options, callback)`); once that was
traced too, *every* message in the sequence — including
`set-popup-restore-point` — completes successfully. Messaging isn't
broken at all. The real issue is in the data: `get-popup-config`
returns `initialView: {state: "AccountPasswordRequired", details:
{accounts: [], unlockWithPassword: false, ...}}` — self-contradictory,
since `"AccountPasswordRequired"` implies an existing locked account
but `accounts: []` says there are none. The popup's rendering logic
almost certainly needs an account object to draw that screen, gets
nothing, and silently never leaves the loading splash — no crash, no
error. Confirmed via direct DOM inspection: after 90+ seconds the
popup has 0 forms/inputs/buttons, just the loading shell.

Critically, **every test that produced this was against a completely
blank profile — no 1Password account was ever added**, since testing
with a real account isn't something to do without the user's own
credentials. That guess was confirmed correct: with a real, existing
1Password account signed in through the popup opened via §8.9, it
works. The "zero accounts" inconsistency above is real but is an edge
case of a fresh, never-configured extension install, not something
that affects actual use.

### 8.9 Opening an extension's own popup/options page

Installing an extension and being able to enable/disable/remove it
(§8.8) still left no way to actually *use* most extensions — the
popup is where 1Password's sign-in lives, and without a way to open
it, install/remove was the only interaction possible. §8.8's own note
("No toolbar action-button UI... known limitation") undersold how
blocking this was once actually tried.

- `src/main/extension-manager.js`'s `list(profileId)` now enriches
  each record with `popupUrl`/`optionsUrl` — computed fresh from the
  manifest on disk each call (`action.default_popup` /
  `browser_action.default_popup` for the popup, `options_ui.page` /
  `options_page` for options), not persisted to `extensions.json`, so
  it's correct even for extensions installed before this existed and
  stays correct if a manifest ever changes.
- **The security-relevant part**: `chrome-extension:` is (deliberately
  — §7.8) in `security.js`'s blocked-navigation-scheme set, so a page
  or a user typing a `chrome-extension://` URL into the address bar
  stays blocked, same as before. But the browser's *own* action of
  opening an extension it installed itself is a fundamentally
  different, trusted case (equivalent to clicking a toolbar icon in
  real Chrome). `TabManager.createTab(url, { trusted: true })` is a new
  opt-in that skips `classifyNavigation` entirely — and the renderer
  can never set it. The only path to it is a narrow, new IPC method,
  `openExtensionPage(id, kind)` (`profile-manager.js`), which looks up
  the URL itself from `extensionManager.list()` — a value this app's
  own main-process code computed from a manifest it downloaded, never
  from anything page- or user-supplied — and only *then* calls
  `createTab(url, { trusted: true })`. The renderer can ask "open
  extension X's popup," never "open this arbitrary URL as trusted."
  Verified the boundary holds both ways: `openExtensionPage` opens the
  popup tab correctly, while calling the ordinary `createTab` with the
  exact same URL still shows the blocked-address error page.
- In the rail's extensions popover (`Extensions.js`), an extension's
  icon/name is clickable when it has a popup (opens it in a new tab,
  reusing existing tab infra rather than a separate floating-popup-window
  subsystem), and a small gear button appears only when an options page
  exists — 1Password, confirmed via testing, has a popup and no
  options page, so only the former shows for it.

### 8.10 Home page / new-tab page — SimpleHome

The default new-tab page and the toolbar Home button both open
SimpleHome — a single self-contained `index.html` (no build step, no
server, no framework — clock, launcher search with an inline
calculator, editable shortcut tiles, a scratchpad, nineteen themes),
previously built by the same author as its own standalone project
(`~/My Stuff/SimpleHome`) and bundled here as
`src/renderer/home/index.html`. Bundled as a copy rather than
referenced from its original location outside this project, so
RedRose stays self-contained and doesn't break if that other project's
folder ever moves — re-sync manually if SimpleHome gets updated later.

- Loaded via `webContents.loadFile()` — like `error-page.html` (§8.6),
  **not** through `classifyNavigation` (§7.8/§8.7) — it's app-bundled
  content, not page- or user-supplied, so the scheme/malicious-host
  checks don't apply to it (same reasoning as §8.9's trusted
  `createTab`).
- A blank new tab (the `+` button, `Cmd+T`) used to intentionally load
  nothing (`tab-manager.js`'s `createTab`, "genuinely blank... must
  never be navigated anywhere" — a fix from earlier in this project for
  a bug where blank tabs ran a Google search for the literal text
  "about:blank"). That comment's *reasoning* still holds
  (`resolveNavigationTarget`/`classifyNavigation` must never see a bare
  `about:blank`) but the conclusion changed: a blank tab now
  `loadFile()`s the home page directly, sidestepping that whole code
  path rather than triggering it.
- `TabManager.goHome(tabId)` (wired to the new toolbar Home button —
  `index.html`/`Toolbar.js`/`index.js`, IPC channel `nav:home`) does
  the same `loadFile()` on an existing tab, replacing whatever was
  there — standard browser Home-button behavior.
- The address bar and tab title must not show the home page's own
  `file://.../home/index.html` path — same problem §8.6 solved for
  error pages. Solved slightly differently here: rather than a
  one-shot `_pendingErrorUrl`-style flag, `did-navigate` compares the
  navigated URL against a precomputed `HOME_PAGE_URL` (via Node's
  `pathToFileURL`, so spaces in the install path are percent-encoded
  the same way Electron reports them) and shows `about:blank` / "New
  Tab" whenever they match — stateless, so it stays correct after a
  reload or back/forward navigation to the home page, not just the
  first load.

### 8.11 Resizable tab panel

The tab panel's width (`TAB_PANEL_W`, previously a fixed 200px
constant baked into both `tab-manager.js` and `styles.css` — §5) is now
user-adjustable via a drag handle between it and the page content,
clamped to 160–480px and persisted across restarts. The rail (icon
strip) stays fixed-width; only the tab list resizes.

- `src/main/sidebar-state.js` — `load/saveSidebarWidth`, same small
  JSON-file-in-userData pattern as `window-state.js`, plus the
  authoritative clamp (`clampTabPanelWidth`).
- **Why this couldn't stay a module constant**: the BrowserView's
  bounds are computed in the main process (`TabManager.recomputeBounds`),
  independent of any CSS the chrome renderer draws — so a value the
  user changes via a renderer-side drag has to reach main and be
  applied to the *active* tab's `BrowserView.setBounds()` on every
  move, or the page content and the visible sidebar edge drift apart
  (the exact glitch hit while testing this — see below). `TabManager`
  now takes `tabPanelWidth` as instance state (constructor option +
  `setTabPanelWidth()`), not a shared constant; `ProfileManager` is the
  single canonical owner (`getSidebarWidth`/`setSidebarWidth`) since the
  sidebar is one shared piece of chrome-level layout, not per-profile —
  it keeps whichever `TabManager` is currently active in sync, both on
  every live resize and when switching profiles (a resize made while a
  different profile was active would otherwise leave that profile's
  `TabManager` holding a stale width until synced on switch-in).
- IPC (`sidebar:getWidth` / `sidebar:setWidth`) is deliberately chatty
  by design — `setSidebarWidth` is meant to be called on every pointer-
  move frame during a drag (throttled to one call per animation frame
  in `SidebarResize.js`) for the BrowserView to track the cursor live;
  only the *disk write* is debounced (500ms, mirroring
  `window-state.js`), not the live reposition.
- `src/renderer/components/SidebarResize.js` owns the drag interaction:
  `pointerdown` + `setPointerCapture` (needed because the hit target is
  only 6px wide — without capture, `pointermove` stops firing the
  instant the cursor leaves that thin strip, which it will on any fast
  drag) sets `--tab-panel-w` directly for zero-latency visual feedback
  and calls `setSidebarWidth` in the same frame. Confirmed via actual
  `PointerEvent`s dispatched on the real handle element (this display's
  scaling makes a 6px target unreliable to hit with click automation —
  same issue noted throughout this project's testing) that a live drag
  correctly moves both the CSS-drawn sidebar edge and the BrowserView's
  bounds together, with the gap-between-them glitch mentioned above
  fully gone once both update in the same call.
- **A real interaction this surfaced**: `ContextMenu.js`'s popup
  positioning (§8.4/§8.9's "keep every popup inside the chrome area, or
  it renders invisibly behind the BrowserView") assumed the chrome area
  was always ≥264px (`--rail-w` + the old fixed `--tab-panel-w`) and
  only clamped a popup's *position*, not its width, trusting
  `.popup-menu`'s CSS `max-width: 248px` to already fit. A narrowed tab
  panel breaks that assumption. Fixed by having `positionWithinViewport`
  set an inline `max-width` from the *current* chrome width on every
  open, which — being inline — overrides the class's fixed one. Known
  remaining edge: `.extensions-popover`/`.bookmarks-popover` also
  declare their own `min-width` (240px/220px); at the very narrowest
  tab-panel setting (160px) that min-width can still exceed the
  available space by a few pixels, since CSS resolves a min/max
  conflict in min-width's favor. Judged a minor, rare cosmetic
  edge — a few px of overlap at the extreme end of the resize range —
  not worth the added complexity of also reconciling those hardcoded
  min-widths dynamically.

### 8.12 Split view — drag one tab onto another

Dragging a tab's row onto another tab's row in the panel pairs them:
both tabs' `BrowserView`s show at once, side by side, whatever either
one navigates to independently — real split-screen browsing, not a
merged single tab. v1 scope, deliberately kept simple: exactly one
partner per tab (no 3+ way splits), a fixed 50/50 divide (no draggable
divider between the two panes), and both tabs stay separate rows in
the tab strip rather than collapsing into one combined entry.

- **Data model**: `tab.splitWithTabId` on the `TabManager`-internal tab
  record — a bidirectional link (both tabs point at each other).
  Exposed to the renderer via `_toTabState`.
- **Why this needed real main-process surgery, not just a new method**:
  every prior assumption in `tab-manager.js` was "exactly one
  `BrowserView` is ever attached to the window at a time" —
  `activateTab`/`hideActiveView`/`showActiveView`/`closeTab`/`destroyAll`
  all only ever touched `this.tabs.get(this.activeTabId).view`. Split
  view needs *two* views attached, detached, and destroyed together as
  a unit. Introduced `_viewsForTab(tabId)` (a tab's own view, plus its
  partner's if it has one) and `_attachViewsFor`/`_detachViewsFor` built
  on it, and every one of those methods now goes through them instead
  of touching `tab.view` directly.
- **Stable left/right, no swap-on-click**: naively, "whichever tab is
  `activeTabId` is the left pane" would mean clicking the *right* pane's
  own tab-strip row (to just point the address bar/back-forward at it)
  visibly swaps which side it's rendered on, every time — jarring for
  no reason, since both views are already on screen either way. Fixed
  by keying left/right off tab-strip order (`this.order.indexOf`, stable
  regardless of which one is toolbar-focused) in `recomputeBounds`,
  and by having `activateTab` skip the attach/detach/reposition dance
  entirely when the newly-activated tab is already one of the two
  panes currently showing — it just updates which tab's data drives the
  toolbar. Verified directly: activating the other pane changes the
  address bar and tab-strip highlight but the two panes stay in place.
- **Closing one half**: unlinks the partner (so it doesn't keep
  expecting a pane that's about to stop existing) and, if the closed
  tab was active, prefers reactivating the surviving partner over an
  arbitrary neighboring tab — closing one pane and landing on the other
  one it was just showing reads as more natural. Verified: the survivor
  correctly returns to full width.
- **Drag-and-drop** (`TabStrip.js`): tab rows are `draggable`, using a
  namespaced custom MIME type (`application/x-redrose-tab-id`) so a
  drop only ever means "split with this tab" — there's no competing
  drag interaction (list-reorder-by-drag isn't implemented) to
  disambiguate against. Verified with real `DragEvent`s carrying an
  actual `DataTransfer` dispatched on the live DOM elements (not just
  the underlying IPC call) — this display's click-precision issues,
  noted throughout this project's testing, make a native OS-level drag
  unreliable to drive via automation, so this was the faithful way to
  exercise the shipped `dragstart`/`dragover`/`drop` handlers directly.
  Paired rows get a small split-glyph button (click to unsplit) and an
  accent-colored left edge; a "Close split view" item appears in the
  tab's context menu too when it has a partner.
- Interacts cleanly with the resizable tab panel (§8.11) — same
  `recomputeBounds()` runs for both, so a live sidebar drag reflows
  both split panes together, verified directly.

### 8.13 Packaged-build-only startup bug: the Dock icon call

v1.0.0's macOS build launched (Dock icon appeared, process ran, stayed
alive) but never showed a window — worked perfectly in `npm start` dev
mode, which is why this shipped without being caught earlier; nothing
in this session's extensive dev-mode testing would have exercised the
packaged/asar code path at all.

Root cause, found by running the actual packaged binary from Terminal
(not double-clicking — that route gives no console output) and
capturing stderr: `index.js`'s `app.dock.setIcon(path.join(__dirname,
'..', '..', 'build', 'icon.png'))` — added early in this project,
before packaging was ever tested — throws an unhandled promise
rejection under a packaged build, because `build/icon.png` lives
inside `app.asar` once packaged, and the native (non-Node) image
loader behind `dock.setIcon()` can't read through the asar archive the
way `fs.readFileSync` transparently can. The comment directly above
that line already explained why the call is dev-mode-only in the first
place — packaged builds get their Dock icon from the bundle's
Info.plist automatically — it just wasn't actually guarded that way.

Fixed with one condition: `!app.isPackaged &&` added to the existing
check. Confirmed via the same Terminal-launch method: the asar error is
gone, and the process now visibly proceeds much further into normal
startup (reaching this profile's extension-loading code, which only
runs after the window's `did-finish-load` — i.e. after the window was
created and actually loaded its content), where it didn't before.
Shipped as v1.0.1.

### 8.14 Extension-internal navigation — the other half of §8.9's trust boundary

§8.9 added a trusted path for *opening* an extension's popup/options
page, but not for navigating *within* that extension afterward — found
when 1Password's real settings link (`chrome-extension://<id>/popup/
index.html`'s gear icon, going to `chrome-extension://<id>/app/
app.html#/page/settings` — a different document, same extension, so a
real cross-document navigation, not an in-page hash change) hit the
same "blocked for your safety" page §7.8's scheme blocklist was always
going to show any `chrome-extension:` target, popup or not.

The distinction that was missing: `classifyNavigation` only ever looked
at the *target* URL's scheme. What `chrome-extension:` actually needs
blocked is a *different* origin — an ordinary web page, or a different
extension — reaching into extension-privileged space; an extension
navigating within its own pages is normal (real Chrome allows it) and
was never the threat model. Fixed by giving `classifyNavigation` (and
`isNavigationAllowed`) an optional second `currentUrl` parameter: if
both current and target are `chrome-extension:` with the *same*
hostname (extension ID), the navigation is allowed regardless of scheme
policy. Wired at all three sites that can trigger it — `will-navigate`/
`will-redirect`/`setWindowOpenHandler` in `navigation.js` (via
`webContents.getURL()`, which at `will-navigate` time still reflects
the page navigating *away*, i.e. the source) and `TabManager.navigate`
(the address bar). `createTab` needed no change — a brand new tab has
no prior extension context for the exception to apply to; that's what
§8.9's separate `trusted` flag already covers.

Verified against the real reported case, not a synthetic one — using
the same 1Password install and its actual (real, signed-in) account:
triggering that exact navigation used to show the blocked-page; after
the fix it correctly lands on 1Password's real settings UI.
