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
  (nice-to-have, not required to ship — added later anyway, §8.18).
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
- History (persisted, searchable) — cut for v1 (added later, §8.20).
  Track only in-memory per-tab back/forward via Chromium's own
  navigation stack, for now.
- Downloads UI/manager — cut for v1 (added later, §8.21); let
  Electron's default download behavior (save-as prompt) happen for now
  — and it still does even after §8.21, deliberately (see that section).
- Extensions (added later, §8.8), profiles/multi-account (added later,
  §8.3), find-in-page (added later, §8.19), a real settings UI (added
  later, §8.24 — search engine/home page/ad-blocking; still no
  appearance-vs-everything-else tabs, just one modal) — private/
  incognito windows, print, and a menu entry for dev tools (a hidden
  shortcut stays available for engineering use, and Inspect Element
  lives in the page context menu now too, §8.22) remain out of scope.
- Tab drag-to-reorder (added later, §8.18) / detach-to-new-window
  (still out of scope).

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
`ipcRenderer` directly, never Node globals. (That exact example arrived,
§8.22 — and turned out not to need this after all: `webContents`'s own
`context-menu` event already hands main everything needed, including
`selectionText`, with no page-side JS at all. `page-preload.js` is still
empty.)

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
   are denied by default — never silently allowed. §8.16 replaced the
   original blanket "deny everything, no UI at all" v1 policy with a
   three-tier one (a small always-allow set, a prompt-and-remember set,
   deny for everything else), but the non-negotiable part of this rule is
   unchanged: nothing gets access without either being on the small
   explicitly-reviewed always-allow list or the user actually saying yes.
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

- New `src/main/bookmark-store.js`: at the time this was written, tabs
  were deliberately not persisted (§1) — since reversed by §8.15's
  session restore, but groups still are in-memory only
  (`TabManager.groups`, restored as *data* by §8.15, not as their own
  standalone store). Bookmarks are meant to survive a restart
  regardless, so they get their own store keyed by profile id and
  persisted to `bookmarks.json` in
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

**v1.0.2 turned out to only cover half of this.** The user still hit
the block after upgrading. §8.13's fix covers same-tab navigation
(`will-navigate`) — but 1Password's settings link opens as a *new tab*
(`target="_blank"`/`window.open`), which is a separate code path:
`attachNavigationPolicy`'s `setWindowOpenHandler` correctly classified
it as allowed (same fix, same success), but then handed the URL to
`onOpenNewTab`, which called `TabManager.createTab(url)` — no `trusted`
flag — so `createTab` ran its *own*, separate `classifyNavigation(url)`
call with no `currentUrl` at all, and blocked it right back, having no
way to know this exact URL had already been vetted one call up the
stack. Reproduced in complete isolation (a minimal two-page test
extension, no 1Password/real-account involved) before touching
anything, to rule out the account/session noise that complicated
diagnosing this the first time.

Fixed by having `onOpenNewTab` call `createTab(url, { trusted: true
})` — safe specifically *because* `attachNavigationPolicy` only ever
invokes `onOpenNewTab` after its own `classifyNavigation` already
returned `'ok'` for that exact URL; re-running the same pure check
again with less context could only make the answer *worse*, never
better, so skipping the redundant re-check isn't a weaker boundary.
Verified both directions in the same test: the same-extension
new-tab case now succeeds, and — unchanged — a page trying to
`target="_blank"` open a `file://` URL still doesn't create a tab at
all. Shipped as v1.0.3.

**v1.0.3 still wasn't the whole story.** The user reported the same
block again after upgrading. Third code path, this time: 1Password's
settings link doesn't use a plain `<a>` (§8.13) or `window.open`
(§8.14) at all — it calls the `chrome.tabs.create()` *extension API*
directly, which MV3 extensions generally prefer for exactly this
"open my own settings in a full tab" pattern, since `window.open` isn't
reliably available from a service worker. That call never touches
`will-navigate`/`setWindowOpenHandler` — it's handled entirely by
`electron-chrome-extensions` (§8.8.1's bridge), which invokes this
app's own `createTab(details)` callback in
`chrome-extensions-bridge.js`. That callback called
`tabManager.createTab(details.url)` with no `trusted` flag at all —
yet another independent, context-free `classifyNavigation` call,
blocked for the same reason as the other two. Reproduced again in
total isolation first (a `chrome.tabs.create()`-based test extension)
before touching real 1Password/account state.

The fix here needed more judgment than §8.13/§8.14's, because this
callback's shape is different: it can *only* ever be reached by
`chrome.tabs.create()`, which is an extension-only API — no plain web
page can call it — but the requested URL isn't guaranteed to be
`chrome-extension:` the way the other two paths' already-passed check
guaranteed. An extension calling this with an `https:` URL, or (if
compromised) a `file:`/known-malicious one, should still go through
the normal scheme/malicious-site check — only a `chrome-extension:`
target is unconditionally trusted here, specifically because reaching
this callback at all already proves the caller is extension code, not
page content. Verified both ends again: a same-extension
`chrome.tabs.create()` now succeeds, and one to `file:///etc/passwd`
still gets the blocked-page treatment. Shipped as v1.0.4.

Three separate fixes for what looks like one bug from the outside is
worth being honest about: `chrome-extension:` targets can be reached
via same-tab navigation, `window.open`, *and* the `chrome.tabs.create`
API, and each one turned out to need its own fix rather than one
shared choke point catching all three. If a fourth path like this
surfaces later, look for another `TabManager.createTab(url)` call
missing `{ trusted }` before assuming it's something new.

### 8.15 Session restore — reopening where you left off

§1 originally called this out of scope deliberately: "unlike open tabs
(which are deliberately not persisted...)". Users expect a browser to
reopen with the tabs it had before, so this reverses that call.
`sidebar-state.js` and `bookmark-store.js` are the model this follows —
a small per-profile JSON file (`sessions.json`, one entry per profile
id) written debounced, the same 500ms-after-the-last-change pattern
`ProfileManager` already used for sidebar width.

What's persisted, per profile: each tab's URL (or `null` for the
home/new-tab page — see below), pinned state, tab-group membership, and
split-view pairing, plus which tab was active. `TabManager` owns both
directions — `getSessionSnapshot()` (save) and `restoreSession()`
(load) — since it already owns the tab/group/split data model;
`ProfileManager` just owns *when* to call them (debounced on every
tabs-changed event, for every profile's `TabManager`, not only the
active one — a background profile's tabs can still change) and *where*
they're stored (keyed by profile id, mirroring `BookmarkStore`).

A few decisions worth recording:

- **Extension pages are never persisted.** `getSessionSnapshot()` drops
  any tab whose URL is `chrome-extension://...` before saving. Restoring
  one before its owning extension has (re)loaded on the next launch
  would reproduce the exact "zero tabs known to `chrome.tabs`" race
  §8.8.3 already found and fixed by making the seed tab exist *before*
  extensions load — restoring an extension tab at that same point,
  pointed at an extension ID that may not even be installed yet in
  loading order, isn't worth the risk for what's one click away via the
  toolbar icon anyway.
- **The home/new-tab page round-trips through `null`, not the literal
  string `'about:blank'`.** A tab showing the home page already
  normalizes its `tab.url` to the `'about:blank'` sentinel (§8.10) —
  saved as `null` instead, so `restoreSession()`'s `createTab(url)` call
  takes the exact same "falsy url → load the bundled home page" branch
  a fresh new tab does, rather than literally navigating to
  `about:blank` (which is itself a scheme `classifyNavigation` doesn't
  even need to see here, since it's the `else` branch of `createTab`,
  not a `loadURL` call).
- **Splits are stored as an array index, not a tab id.** Every restore
  regenerates fresh `crypto.randomUUID()` tab ids, so yesterday's id
  means nothing on the next launch; the snapshot instead records "this
  tab's split partner is whichever tab ends up at index N", resolved
  back to a real id once all tabs exist.
- **Restoring is just `createTab()` in a loop, called with a new
  `silent: true` option** that skips the per-call `activateTab()` +
  tabs-changed emit `createTab` normally does. Without it, restoring
  five tabs would mean five BrowserView attach/detach cycles and five
  IPC round-trips to the renderer before landing on the one that was
  actually active; with it, only the explicit `activateTab()` call at
  the very end of `restoreSession()` does any of that work, and only
  once.
- **A save sitting in its 500ms debounce timer at quit time would
  otherwise be lost.** `ProfileManager.flushSessionSaves()` — called
  from `chromeWin`'s `'close'` event (not `'closed'` — webContents are
  still alive at that point) in `index.js` — cancels every profile's
  pending timer and writes its current snapshot immediately instead.
  `'close'` fires both for a real Quit and, on macOS, for just closing
  the window while the app itself stays running, so either way it's the
  right moment to flush.

**A pre-existing bug this surfaced:** `ProfileManager._loadProfiles()`
only ever wrote `profiles.json` from `switchProfile`/`createProfile`/
`renameProfile`/`deleteProfile` — never from the branch that mints the
very first default profile on a fresh install. That meant a user who
never touches profile management (i.e. almost everyone, since the app
ships with exactly one default profile) would never get a
`profiles.json` written at all — every single launch would hit the
"no stored profiles" branch again and mint a brand new random profile
id, silently discarding that "profile"'s bookmarks, extensions, *and*
now its session on every restart, despite looking to the user like one
continuous profile the whole time. Fixed by calling `_saveProfiles()`
immediately after minting that fallback profile. Caught before
shipping by testing session restore in isolation (a temp
`--user-data-dir`, two sequential Electron launches, a throwaway local
HTTP server instead of a real site) — phase two's profile id didn't
match phase one's until this was fixed, which is what surfaced it.

### 8.16 Site permissions — a three-tier policy replacing blanket deny

§7's rule 9 originally denied every permission request outright — camera,
mic, geolocation, notifications, all of it — with no UI to say yes even
if the user wanted to. That's fine for a v1 that's proving out the
process architecture, but it means the browser can't be used for
anything that legitimately needs a permission (a video call, a map site
asking where you are). This replaces it with the same three-tier model
real browsers use, still deny-by-default at its core (rule 9 is
unchanged in spirit — see its updated text above):

- **Always allow, no prompt:** `fullscreen`, `pointerLock`,
  `clipboard-sanitized-write`. Real browsers don't prompt for these
  either — they're low-risk and expected to just work.
- **Prompt once per origin, then remember the answer:** `media` (camera/
  mic — Electron reports getUserMedia as one combined permission, not
  split by device), `geolocation`, `notifications`. These are the ones a
  real browser also stops to ask about.
- **Deny, no exception, ever:** everything else (`display-capture`,
  `idle-detection`, `midiSysex`, `window-management`, ...). No pressing
  reason for a general-purpose v1 browser to grant any of these yet, so
  they stay closed rather than growing the always-allow list on
  speculation.

**Where the logic lives.** `security.js`'s original
`installPermissionHandler` (blanket deny) is untouched and still
installed on the chrome window's own default session in `index.js` — it
never shows untrusted page content, so a hard-coded backstop is fine
there. The real per-profile policy is new: `permission-manager.js`'s
`installPermissionPolicy(session, { win, tabManager, permissionStore,
profileId })`, installed in `ProfileManager._ensureTabManager` right
after that profile's `TabManager` is constructed (needs it — see below —
but must be in place before the seed/restored tab(s) start loading).
Decisions are kept in a new `permission-store.js` (`PermissionStore`),
the same per-profile-keyed-JSON-file convention as bookmarks/sessions,
storing only origins that were actually prompted — the always-allow and
always-deny tiers never touch it.

**Only the tab on screen ever gets prompted.** A request from a
background tab (still loading, or one the user switched away from) is
denied outright — not queued, not remembered — the instant it's not
`tabManager.activeTabId`. Without this, a page nobody's looking at could
throw up a permission prompt for something the user is doing on a
completely different tab, or pile up several behind each other. If that
tab becomes the active one later, it's free to ask again.

**The request/response round trip.** `setPermissionRequestHandler` is
inherently async-capable (a `callback`, not a return value) but Electron
gives no way to *show UI* from main directly — the actual prompt has to
render in the chrome renderer. So: main generates a `requestId`
(`crypto.randomUUID()`), stashes `{ resolve }` in a module-level
`Map` in `permission-manager.js`, and pushes
`{ requestId, origin, permission, tabId }` over a new
`MAIN_TO_RENDERER.PERMISSION_REQUEST` channel. `PermissionPrompt.js` in
the chrome renderer shows a popover (Allow/Block) anchored at the address
bar's security icon, and calls back over a new
`RENDERER_TO_MAIN.PERMISSION_RESPOND` channel with `{ requestId, allow,
remember }`; `ipc-handlers.js` resolves the pending map entry, which (if
`remember`) writes the decision to `PermissionStore` and then, only now,
calls the *original* Electron `callback(allow)` — the page's
`getUserMedia()`/etc. promise was sitting there waiting on exactly this
the whole time. `setPermissionCheckHandler` (a separate, *synchronous*
hook Electron uses for capability checks like
`navigator.permissions.query()`) can't participate in this round trip at
all — it can only ever consult an already-remembered decision or the
always-allow set, never trigger a prompt.

**Why the popover needed a change to the shared popup code.** Every
existing popover (ContextMenu.js) anchors from inside the sidebar (a tab
row, a group dot, the rail glyph) and `positionWithinViewport` clamps to
that width specifically so it can't spill into the region the active
tab's BrowserView occludes (it always paints above the chrome window's
own content). A permission prompt anchored at the address bar's security
icon is well outside that region. Rather than teach the clamp logic
about a second safe zone, `PermissionPrompt.js` sidesteps the occlusion
problem the same way the settings/theme modal already does — detach the
active view for as long as the prompt is open — and `showPopover` grew a
`fullWidth: true` option that skips the sidebar clamp for exactly (and
only) a caller that's done that. Doing this surfaced a real gap: the
settings modal and a permission prompt could now overlap (or two
permission prompts, in sequence), and a plain hide/show call pair has no
way to know another caller still needs the view hidden when it
re-shows it. Fixed with a small reference count
(`components/ViewOverlay.js`, `pushHideActiveView`/`popHideActiveView`)
that both call sites now go through instead of
`window.browserAPI.hideActiveView/showActiveView` directly.

**Dismissing without choosing** (click outside, Escape, or a second
prompt/modal opening over this one) is treated as "not now" — the
pending request is denied so the page's promise doesn't hang forever,
but nothing is written to `PermissionStore`, so the site can ask again
later rather than being silently blocked for good. Detected in
`PermissionPrompt.js` with a `MutationObserver` on the popover's removal
from the DOM, since `ContextMenu.js`'s generic dismiss-on-outside-click
handling has no callback hook of its own to hang this off of.

**Known v1 simplifications, deliberate for now:** no per-site permissions
*management* UI (no way to review/revoke a remembered decision short of
deleting `permissions.json` by hand) — only the prompt-and-remember flow
exists; and only one permission prompt is ever shown at a time (a second
request arriving while one is open dismisses the first as "not now"
rather than queuing). Both are reasonable follow-ups if they turn out to
matter in practice, not architectural dead ends.

**Verified in complete isolation** (a temp `--user-data-dir`, a
throwaway local HTTP test page, no real account/session involved) before
ever touching real data, per this project's established practice: the
full request → popover → Allow → remembered → no-second-prompt round
trip for `notifications`; the same for Block (→ `denied`, remembered,
still no re-prompt); a background tab's request denied without a prompt
and without being persisted; and — via `document.body.requestFullscreen()`
called with no genuine user gesture — an incidental confirmation that
Chromium itself routes gesture-less fullscreen through a *different*,
stricter, correctly-still-denied permission (`automatic-fullscreen`),
distinct from the gesture-triggered `fullscreen` this policy allows.

### 8.17 Auto-updates — real on Windows, check-only on macOS

Every release up to now has meant asking users to notice a new GitHub
release exists and manually download/reinstall it. `src/main/updater.js`
adds a background check (10s after launch, then every 4 hours) plus a
"Check for Updates…" menu item (mac: app menu, under About; Windows/
Linux: a new Help menu) — but not the same mechanism on both platforms,
because of this project's own signing situation.

**Why the platform split.** `electron-updater`'s macOS support is
Squirrel.Mac, which — before it will apply an update at all — validates
the *running* app's own code signature. This project ships unsigned on
mac (`package.json`'s `identity: null`; see the README's Gatekeeper
caveat), so that check fails outright, every time, for every mac user.
Wiring up the real mechanism there would mean shipping a feature that
can only ever error. So: **Windows** gets the real thing — `autoDownload
= false` (never spend the user's bandwidth without asking first, the
same instinct this project applies to everything outward/hard-to-reverse,
e.g. never auto-publishing a release without an explicit yes),
`checkForUpdates()` → an "update available, download?" dialog →
`downloadUpdate()` → an "update ready, restart now?" dialog →
`quitAndInstall()`. NSIS has no equivalent hard requirement — it can
silently re-run an unsigned installer; the only user-facing cost is the
same SmartScreen prompt a first-time manual download already shows.
**macOS** gets a homegrown, lighter check instead: ask
`api.github.com/repos/.../releases/latest` for the current published
release's tag, compare it to `app.getVersion()` with a plain x.y.z
comparator (this project's tags are never anything fancier), and if
it's newer, offer to open the Releases page — the same manual install
flow the README already documents. GitHub's `/releases/latest` endpoint
only ever returns a *published* (non-draft, non-prerelease) release,
which lines up exactly with this project's own draft-then-publish-by-
hand release process — a release still sitting in draft, mid-review,
is correctly invisible to this check.

**Never runs in a dev build** (`!app.isPackaged`) — an unpackaged
checkout has no meaningful "current version" to compare against a
release tag, so every check there would be a false positive.

**CI/build-config changes needed for this to work at all.** electron-
updater needs update-feed metadata (`latest.yml`/`latest-mac.yml`, plus
`.blockmap` files for differential downloads) generated *alongside* the
installers — electron-builder only writes these when `package.json`'s
`build.publish` names a real provider, which had been set to `null`
specifically to stop electron-builder auto-detecting CI and trying to
publish a GitHub release itself with no token (see the CI-build-failure
fix earlier in this doc's history). Changed `publish` to a real `{
provider: "github", owner, repo }` object, and — so that doesn't
reopen the auto-publish problem — added `--publish never` directly to
the `dist:mac`/`dist:win` npm scripts, which forces "never publish"
regardless of the config object (defense in depth: even a future
`electron-builder` invocation that forgets the flag would need the config
itself changed too). `.github/workflows/build.yml`'s per-OS artifact
upload globs were extended to include `*.yml`/`*.blockmap` so the
release job actually attaches them to the GitHub release the update
checks read from — without them, `latest-mac.yml`/`latest.yml` would
generate locally every build and then never reach anywhere a real
user's copy of the app could see them.

**Verified:** built the mac target locally with the new `publish`
config and confirmed `latest-mac.yml` (with correct version/sha512/size
fields) and both `.blockmap` files are generated with `--publish
never` and nothing is uploaded anywhere on its own; launched the
packaged `.app` against an isolated `--user-data-dir` (not the real
installed copy's) and confirmed it still opens cleanly — the same
Dock-icon-but-no-window regression class as §8.13's original bug is the
main risk any packaging-config change reintroduces, so re-checking it
is routine now for any change that touches `package.json`'s `build`
block.

### 8.18 Reopen closed tab (Cmd/Ctrl+Shift+T) and drag-to-reorder

Two small, independent table-stakes gaps closed together:

**Reopen closed tab.** `TabManager` keeps a `closedStack` (capped at
`CLOSED_STACK_LIMIT`, 20) — `closeTab()` pushes `{url, pinned, groupId}`
(the same "home page → `null`" convention `getSessionSnapshot()` uses,
§8.15) before tearing the tab down; `reopenLastClosedTab()` pops the
stack and recreates it via the normal `createTab()` path, restoring
pinned state and group membership if the group still exists. Deliberately
session-only, not persisted to disk across a restart the way §8.15's
session itself is — merging an "undo close" stack with the session-
restore format for a feature whose whole point is undoing something
that *just happened* isn't worth the complexity here. Popping repeatedly
(pressing the shortcut several times in a row) walks back through
several closes without needing the previously-reopened tab to be closed
again first, matching real browsers.

**Drag-to-reorder.** `TabManager.moveTab(tabId, targetTabId, position)`
splices `tabId` to just before/after `targetTabId` in `order`, refusing
the move outright if the two tabs aren't in the same pinned/unpinned
bucket — pinned tabs must stay contiguous at the front (the same
invariant `setPinned` already maintains), and the tab strip's two
buckets are spatially separate enough that a cross-bucket drag was never
going to be attempted expecting a reorder anyway. The harder part was
disambiguating this from §8.12's existing "drag tab A onto tab B to
split them" — both now live on the same drag gesture, split when
dropped on the middle ~40% of a row, reorder when dropped on the top/
bottom ~30% edge (`TabStrip.js`'s `dropZone`), the same drop-position
disambiguation kanban boards and file trees commonly use for "onto" vs.
"between".

**Verified in isolation** (temp `--user-data-dir`, throwaway local HTTP
pages): `moveTab` reordering both directions, refusing a cross-bucket
move, reopening preserving pinned/group state, and repeated reopens
correctly walking back through multiple closes.

### 8.19 Find-in-page (Cmd/Ctrl+F) — and a real bug found while building it

The obvious implementation — Electron's native
`webContents.findInPage()` / `'found-in-page'` event, the same one every
Electron find-in-page tutorial uses — is **not what this ships with**.
It's what this *started* with, and it silently didn't work. What follows
is worth documenting in full because the eventual fix (§8.19's actual
mechanism) only makes sense in light of what was ruled out, and because
the investigation surfaced a second, independent, real bug along the way.

**The UI.** `#find-bar` is a real element in `index.html`'s document
flow (inside `#main-col`, after the progress bar), not a floating
overlay — `TabManager.recomputeBounds()` reserves `FIND_BAR_H` (44px,
must match `--find-bar-h` in `styles.css`) above the BrowserView only
while `findBarOpen` is true, the same "make room in the chrome, don't
paint over the page" approach the topbar itself uses, and the opposite
of how the permission prompt (§8.16) and settings modal handle needing
to be visible — those hide the BrowserView entirely, which isn't an
option here since the whole point is searching the page while looking
at it. Cmd/Ctrl+F opens it (or just refocuses it if already open for
this tab); Escape or the × closes it; switching the active tab away from
whichever one it was opened for closes it too (`FindBar.js`'s
`onActiveTabChanged`) rather than silently continuing to search a page
no longer on screen.

**What went wrong.** `webContents.findInPage(text)` returns a request
id and is documented to fire `'found-in-page'` asynchronously with the
match count. In this app, once a tab is registered with
ProfileManager's `electron-chrome-extensions` bridge (§8.8.1) — which
every real tab always is, immediately after creation — that event
simply never fires. No error, no rejected promise, `webContents.
isDestroyed()` false, the page loads and renders completely normally;
the find request just vanishes.

**The investigation** (all in complete isolation — temp
`--user-data-dir`, a throwaway local HTTP server, never against real
extensions/account state), roughly in order, each ruling out one
candidate:

1. A plain `BrowserWindow` loading a page directly: works.
2. A `BrowserView` attached to a host window: works.
3. A `BrowserView` on a custom `session.fromPartition(...)` partition
   (matching ProfileManager's per-profile sessions): works.
4. The real `TabManager` class, wired up exactly like the app does, but
   with `ProfileManager` (and therefore the extensions bridge) left out
   entirely: works.
5. The real `TabManager` *plus* `createExtensionsBridge(...)` — nothing
   else, no `AdBlocker`, no `ExtensionManager.loadAllForProfile`, no
   `PermissionManager` — with exactly one tab registered via `addTab()`:
   **broken**. This isolated it to the bridge specifically.
6. Suspecting a double-attach: `ElectronChromeExtensions.addTab()`
   elects an active tab the first time it sees a new window by calling
   back into `this.impl.selectTab()` — this app's own
   `chrome-extensions-bridge.js`, which calls `tabManager.activateTab()`
   — and at the time this fired, `createTab()` hadn't run its own
   `activateTab()` yet, so this reentrant call did a full, premature
   `addBrowserView`/`setTopBrowserView` attach on a view that hadn't
   started loading. **This was real** (confirmed by counting
   `_attachViewsFor` calls) and independently worth fixing — see below —
   but fixing it did **not** fix find-in-page. Ruled out as the cause,
   kept as a fix anyway.
7. Registering *only* the bridge's own preload script
   (`chrome-extension-api.preload.js`) on the session, without
   constructing `ElectronChromeExtensions` at all: works fine. Reading
   that preload's source confirms why — it only does anything
   (`injectExtensionAPIs()`) for a service worker or a
   `chrome-extension://` page; for an ordinary `http:` page it's a
   nearly complete no-op. Ruled out.
8. Bisecting further into the library's own tab-observation code
   (`TabsAPI`/`WebNavigationAPI`'s `observeTab`, the message router)
   turned up nothing that touches `findInPage` or `found-in-page`
   anywhere in its source. At this point, chasing the exact mechanism
   further inside a third-party GPL-3.0 dependency's internals stopped
   being worth it — confirmed *what* breaks it (the full
   `ElectronChromeExtensions` instance, with a tab actually registered
   via `addTab()`) without needing to know *why*, and a working
   alternative was already in hand (next).

**The fix.** `window.find(text, caseSensitive, backwards, wrapAround,
wholeWord, searchInFrames, showDialog)` — a legacy but still fully
Chromium-implemented `Window` method — runs entirely inside the page's
own JS context via `webContents.executeJavaScript()`, never touching
whatever internal channel the native API relies on. Verified directly
in the exact broken setup from step 5 above: works every time. `text` is
never concatenated into the executed script — `JSON.stringify(text)`
produces an escaped JS string literal, so find-bar input can't break out
into arbitrary `executeJavaScript` code.

The real trade-off: `window.find()` reports only "found a match" per
call (and moves the browser's native text selection/highlight to it,
scrolling it into view) — not a running position the way
`found-in-page`'s `activeMatchOrdinal` did. `startFind()` fills that gap
itself: a fresh search (`findNext: false`, every keystroke) runs a plain
case-insensitive substring count over `document.body.innerText` and
pushes that as the match count, then resets the selection to the
document's start (`window.getSelection().removeAllRanges()`) before
calling `window.find()` so a fresh search always starts from the top;
`findNext: true` (Enter/Shift+Enter, the prev/next buttons) just steps
`window.find()` forward or backward without recomputing the count. The
find bar shows a plain "N matches", not Chrome's "3 of 12" — a
deliberate, disclosed simplification, not an oversight.

**The independent bug this surfaced (step 6 above), fixed regardless of
not being find-in-page's cause:** `TabManager.createTab()` used to fire
`onTabCreated` — which is what registers the tab with the extensions
bridge — *before* running its own `activateTab()`/`_emitTabsChanged()`
at the end of the same function. For the first tab of every profile (and
only the first — after that, the bridge already has an active tab on
record for the shared window and doesn't reentrantly call
`selectTab()`), this meant `bridge.addTab()`'s reentrant call into
`activateTab()` ran while `this.activeTabId` didn't yet equal the new
tab's id, so it took the *normal* attach branch instead of `activateTab`
's "already showing, nothing to do" no-op — a second, premature
`addBrowserView`/`setTopBrowserView` cycle on a view that hadn't started
loading yet. Fixed by moving `onTabCreated` to fire *after* the tab's
own activate/emit sequence: by the time the bridge's reentrant call
happens, `this.activeTabId` already equals the new tab's id, so
`activateTab`'s existing "already showing" check absorbs it as a no-op.
This also happens to be the exact mechanism behind a
`MaxListenersExceededWarning` ("N closed listeners added to
[BrowserWindow]") noticed in passing during this same investigation —
Electron's own `addBrowserView()` adds an internal listener to the host
window on every call with no apparent dedup, so the premature extra
attach on every profile's first tab was quietly contributing one stray
listener per profile ever created in a running session. One fix, two
symptoms — worth being honest that these looked, at first, like two
unrelated findings.

**Verified end to end** in the real, full stack (`ProfileManager` +
`registerIpcHandlers`, extensions bridge and all — the exact
configuration find-in-page was broken in) via a throwaway HTTP page: the
match count for a real search term, a nonexistent term correctly
reporting zero, `findNext` correctly *not* re-emitting a count, the
`FIND_BAR_H` bounds reservation appearing and disappearing, and the real
`FindBar.js` UI driven through actual DOM events (a synthetic Cmd+F
keydown, typing into `#find-input`, reading `#find-count`'s rendered
text, Escape) — not just the main-process methods in isolation.

### 8.20 Browsing history

§1 originally cut this outright ("Track only in-memory per-tab back/
forward via Chromium's own navigation stack"). `history-store.js`
(`HistoryStore`) is the same per-profile-JSON-file convention as
bookmarks/sessions/permissions, but append-only and chronological — one
record per real page visit, newest first, rather than one record per
bookmarked URL toggled on/off. Capped at `HISTORY_LIMIT_PER_PROFILE`
(5000) per profile, oldest trimmed, since this is a plain JSON file, not
a database with proper indexing/pagination. Writes are debounced
(`SAVE_DEBOUNCE_MS`, 800ms) — a visit is recorded on every real
navigation, far more often than a bookmark toggle — with `flush()`
called from the same window-`'close'` handler §8.15's session-save flush
already lives in, so a visit landing right before quit isn't lost to the
debounce window.

**What counts as a visit.** Recorded from `TabManager`'s `did-navigate`
handler, in the same branch that treats a URL as a genuine content
navigation (not the home-page branch, not the failed/blocked-load error
branch) — so the home/new-tab page and blocked navigations never show up
in history, the same way they're excluded from §8.15's session restore.
`chrome-extension://` pages are excluded too, for the same "not
'browsing' in the sense a history list means" reasoning §8.15 already
applies. Same-document navigations (`did-navigate-in-page` — hash
changes, SPA route changes) are deliberately **not** recorded, unlike a
real browser — a disclosed v1 simplification, not an oversight; recording
every SPA route change would flood history with noise for the pages that
do this heavily.

**Title timing.** At `did-navigate` time the page's real `<title>`
usually hasn't arrived yet — `tab.title` is still the hostname fallback
seeded synchronously, with `page-title-updated` correcting it
moments later for pages that set one. Recording immediately would
permanently store that hostname fallback as the history title. Instead,
the actual `historyStore.record()` call is deferred 300ms (long enough
for the near-universal case of a `<title>` tag present in the initial
HTML, which fires `page-title-updated` within milliseconds — not an
attempt to guarantee correctness for every page), and re-checks
`tab.url` still matches before recording, in case the user already
navigated away in the meantime (that newer navigation schedules and
records its own entry instead).

**No live-push subscription**, unlike bookmarks/extensions/downloads
(§8.21) — `History.js`'s popover fetches fresh (`HISTORY_LIST`, with an
optional search query) every time it opens and every time the search box
changes, rather than main pushing a `HISTORY_CHANGED` event on every
single navigation to a UI element that's closed most of the time. Search
is a plain case-insensitive substring match against title OR url,
filtered in `HistoryStore.list()`.

Deleting one entry (`HISTORY_REMOVE`) or clearing everything
(`HISTORY_CLEAR`, behind a native `window.confirm()` in the popover — a
destructive, unrecoverable action on the user's own data) only touches
the history *record*, never the site itself or any of its stored data —
same "workspace/list, not an account to nuke" posture profile deletion
already has (§8.3).

**Verified in isolation**: recording real page titles (not just
hostnames) after the deferred write, newest-first ordering, revisiting
the same URL creating a *new* chronological entry rather than deduping,
search filtering by both title and url, remove/clear, and the real
`History.js` popover driven through actual DOM events (clicking the rail
button, typing into the search box, reading the rendered rows and empty
state).

### 8.21 Downloads

§1 originally cut this too ("let Electron's default download behavior
(save-as prompt) happen for now"). This is deliberately additive, not a
replacement: `download-manager.js`'s `installDownloadTracking()` adds a
`session.on('will-download', ...)` listener per profile, but — unlike
every tutorial's version of this — never calls `item.setSavePath()`
itself, which is the one thing that would suppress Electron's native
Save-As dialog. The existing "ask where to save every time" behavior is
completely unchanged; this only *observes* what already happens
(filename, progress, the path the user chose, completion/failure) well
enough to show it in a list, cancel it mid-flight, reopen the file, or
reveal it in the file manager later — none of which was possible before
since nothing was tracking downloads at all.

**Two data lifetimes, one list.** An in-progress download lives entirely
in `download-manager.js`'s own in-memory `live` map (keyed by a fresh id,
not Electron's own download-item identity, which doesn't survive past
the item's lifetime) — `download-store.js`'s `DownloadStore` (same
per-profile-JSON-file convention as bookmarks/history/permissions) only
ever receives a *finished* record (`completed`, `cancelled`, or
`interrupted`) once the `'done'` event fires. `list()` merges live
entries (newest activity first) with persisted ones from disk into one
flat array so the renderer never has to reconcile two differently-shaped
sources — a download that just finished briefly exists in both for one
tick, deduped by id.

**Unlike history (§8.20), this does push live updates**
(`DOWNLOADS_CHANGED`) — a download's whole reason for being in a list is
watching its progress bar move, not something you'd expect to have to
reopen a popover to see. `Downloads.js` also toggles a small dot badge
on the rail button itself (`.has-active-download`) whenever anything is
`progressing`, so an active download is noticeable without the popover
open at all.

**Removing vs. cancelling.** "Remove" on a still-`progressing` entry
cancels the download instead of just hiding it — there's no such thing
as pulling an active download out of the list without stopping it — and
that cancellation's own `'done'` handler persists the resulting
`cancelled` record and drops it from `live` on its own, so `remove()`
doesn't need special-case bookkeeping beyond calling `item.cancel()`.
"Clear" (`DOWNLOADS_CLEAR`) only ever touches finished, persisted
entries — it can never silently cancel something still running that the
user didn't ask to stop. Neither one deletes the actual file on disk,
only the list entry — same posture history's clear/remove has toward
the sites it records, and bookmarks' removal has toward the page itself.

**Open / show in folder** use `shell.openPath()`/`shell.showItemInFolder()`
(Electron's `shell` module, main-process only) against the record's
`savePath` — looked up from the merged `list()`, not from a live
`DownloadItem` reference, so these still work for a download from a
previous session, loaded back from `DownloadStore`.

**Verified in isolation** (a throwaway local HTTP server serving a small
file with a `Content-Disposition: attachment` header, triggering the
download directly via `session.downloadURL()`, with a test-only extra
`will-download` listener setting the save path so no native dialog blocks
the test — the app's own code path still never does this): progress
events arriving, completion persisting the correct filename/path/state,
the downloaded file actually existing on disk with correct contents,
remove-without-deleting-the-file, a second download after clearing,
`openDownload` not throwing, and the real `Downloads.js` popover (and its
badge) driven through actual DOM events.

### 8.22 Page context menu

Right-clicking on a page did *nothing* before this — `context-menu` on
`webContents` fires, but Electron doesn't build or show any menu on its
own unless something calls `Menu.buildFromTemplate(...).popup(...)`. No
one did.

`page-context-menu.js`'s `buildPageContextMenuTemplate()` reads the
`params` Electron's own `context-menu` event provides and builds a menu
scoped to what was actually clicked, in order: a link (open in new tab,
copy address); an image (open in new tab, copy image, copy address,
"Save Image As…" — this last one just calls `webContents.downloadURL()`,
landing in the exact same `session.downloadURL()` → `'will-download'`
path §8.21 already tracks, so a right-click-saved image shows up in the
downloads list identically to any other download); editable content
(cut/copy/paste/select-all, respecting Chromium's own `editFlags` for
which are actually valid right now); a plain text selection (copy, plus
a "Search for "…"" item); and, for a non-editable click, Back/Forward/
Reload. Every one of these is always followed by Inspect Element.

**Trust model.** Everything here operates on data Electron's own
`context-menu` event already computed for this exact click — the one
place page-supplied data still gets treated as untrusted is a link/image
URL actually being navigated to, which goes through `createTab()`'s
normal (non-`trusted`) path, same as any other page-initiated
navigation. The "Search for…" action is the interesting edge case in the
other direction: the URL it navigates to is *built* by this app's own
code (the selected text run through `resolveNavigationTarget` against
the configured search engine, §8.24), so it's passed `{ trusted: true }`
— safe specifically because the app constructed that exact URL from its
own trusted template, encoding the selected text into the query
parameter rather than ever treating it as a URL to interpret. The
selected text itself is never trusted with anything more than that.

**Inspect Element, deliberately included.** §1's original scope call
kept dev tools out of the application menu bar ("dev tools can stay
available via a hidden shortcut for engineering use, just no menu
entry"). That was about the app's own chrome menu specifically — a
page's right-click menu is a different surface, where Inspect Element is
a normal, expected affordance for any browser user (and just as useful
for engineering use as the hidden shortcut already was), not something
that needs gatekeeping the way a permanent menu-bar entry would.

**Verified**: a comprehensive set of direct unit checks against
`buildPageContextMenuTemplate()` (every branch — link, image, editable
with mixed enabled/disabled edit flags, selection — with a hand-built
fake `webContents`/`tabManager` recording what each item's `click`
actually calls), plus a live-wiring smoke test that right-clicks real
elements on a real loaded page (`webContents.sendInputEvent` — genuine
input-level clicks, not synthetic DOM events) and confirms Chromium's
own `context-menu` event reports the expected `linkURL`/`srcURL`/
`mediaType`/`isEditable`/`selectionText` for a link, an image, a focused
text input, and a text selection, respectively.

### 8.23 Address bar autocomplete

Typing in the address bar now suggests matches from bookmarks and
history (§8.20) — up to 4 bookmark matches (title or url, case-
insensitive substring) plus history matches (deduped against whatever
bookmarks already matched) filling the remaining slots, capped at 6
total. Debounced 150ms per keystroke, since a history match is a real
IPC round trip (`HISTORY_LIST` with the current query), not free.

**Reserves real layout space, not an overlay** — the exact same
reasoning and mechanism as the find bar (§8.19): `TabManager` reserves
`ADDRESS_SUGGEST_H` (240px, fixed regardless of how many of the up-to-6
rows are actually showing — the same simplicity trade-off `FIND_BAR_H`
already makes, to avoid a two-way renderer↔main height sync for
something whose row count changes on every keystroke) above the
BrowserView while `AddressBar.js` has anything to show, toggled via a
new `setAddressSuggestOpen` IPC call. Additive with the find bar's own
reservation if both were somehow open at once (not a realistic
scenario, but correct either way — see `recomputeBounds`).

**Keyboard model**: ArrowUp/Down move a highlighted selection (wrapping
is deliberately not implemented — hitting the top/bottom just stops);
Enter navigates to the highlighted suggestion if one exists, else falls
back to whatever's typed (unchanged from before this existed); Escape
closes the dropdown without blurring the address bar itself if
suggestions are open, or blurs it as before if not. Clicking a
suggestion uses `mousedown` with `preventDefault()`, not `click` — the
browser's default mousedown behavior would otherwise blur the input
(shifting focus away from a non-focusable row) before a `click` handler
ever got a chance to run, racing against the `blur` listener that closes
the whole dropdown.

**Verified**: typing a query that matches both a bookmark and a history
entry (bookmark sorted first), the `ADDRESS_SUGGEST_H` bounds reservation
appearing and disappearing, ArrowDown highlighting, Enter on a
highlighted suggestion actually navigating and closing the dropdown, a
query with zero matches never opening it at all, and Escape closing the
dropdown without blurring the input — all against the real
`AddressBar.js` UI driven through actual DOM events, not just the
suggestion-computation logic in isolation.

### 8.24 General settings — search engine, home page, ad blocking

§1 cut a settings UI entirely for v1; the settings modal that did ship
(the theme picker, §6) only ever covered appearance. This adds a
"General" section above it in the same modal — search engine (a fixed
list: Google/DuckDuckGo/Bing, `shared/search-engines.js`), home page
(free-text URL, blank = the bundled SimpleHome default), and an ad-
blocking on/off toggle — each committing immediately on change, no Save
button, same as the theme swatches next to them.

**Scoped per profile**, like bookmarks/history/permissions —
`settings-store.js`'s `SettingsStore` is the same per-profile-JSON-file
convention, a flat key/value object per profile (`get`/`set`, not a
list) with `DEFAULTS` merged under whatever's actually stored so a
settings file from an older version missing a newer key never needs its
own migration.

**How it actually takes effect.** Search engine and home page are read
*live* — `TabManager` gets a `getSettings()` accessor
(`ProfileManager`'s closure reading `SettingsStore` fresh every call,
never a cached snapshot) it calls on every navigation
(`resolveNavigationTarget(input, searchEngineUrl)`) and every "no
explicit url" `createTab()`/`goHome()` call (`_loadHomePage()`) — so a
settings change takes effect on the very next thing that needs it,
nothing needs to be recreated. `resolveNavigationTarget`/`normalizeInput`
already accepted an optional custom search-engine-URL parameter before
this (unused until now); threading it through was the only change
`navigation.js` needed. A custom home page URL is validated exactly like
any address-bar input (`classifyNavigation`) before being trusted,
falling back to the bundled SimpleHome page if it's somehow invalid or
blocked — never trusted outright just because it came from the settings
modal rather than the address bar.

Ad-block is different: it's session-level state (`@ghostery/adblocker-
electron`'s `enableBlockingInSession`/`disableBlockingInSession`, both
already existing library methods this just started calling), so toggling
it calls `AdBlocker.enableForSession`/`disableForSession` on the
*current live session* immediately, in addition to persisting the
choice for next launch's `_ensureTabManager` to read.

**One conflated concept, kept deliberately conflated**: "home page" and
"new tab page" are two separate settings in some real browsers; this app
already treated them as one and the same thing before settings existed
at all (§8.10 — the Home button and a blank new tab load the identical
bundled page), so the new setting controls both together rather than
introducing a second, separate "new tab page" concept this app has never
had.

**Verified**: every default value, the search-engine list contents,
navigating a search query actually using the configured engine (not the
hardcoded default), a custom home page affecting both a fresh new tab
*and* the Home button, clearing it falling back to the bundled page, the
ad-block toggle taking effect on the live session immediately in both
directions, persistence across calls, and the real settings-modal UI
(the `<select>`, the home-page `<input>` committing on Enter, the
checkbox) driven through actual DOM events end to end.

### 8.25 Dock/taskbar download progress

The last small piece of §8.21's "make downloads visible" work: while
anything is downloading, the Dock icon (macOS) / taskbar button
(Windows) shows real progress via `BrowserWindow.setProgressBar()` —
removed entirely (`setProgressBar(-1)`) the instant nothing is
downloading anywhere.

**App-wide, not per-profile** — `ProfileManager._updateDockProgress()`
aggregates *every* profile's currently-`progressing` downloads
(summed received/total bytes) into one fraction, because there's exactly
one Dock icon for the whole app no matter how many profiles exist; a
background profile's download genuinely is still happening and should
still show up here, unlike history (§8.20, deliberately no live push)
or even the renderer-facing side of downloads itself (§8.21, gated to
the active profile for the popover/badge — this is the one thing about
downloads that isn't gated). Recomputed on every progress tick and every
completion from every profile's download manager, and once more after
deleting a profile (its tracker disappears from the aggregate, though
not from a download it may have had genuinely in flight — see below).

**Unknown total size** — some servers never send a `Content-Length`, so
a real fraction can't always be computed. Rather than fabricate one, that
case shows an indeterminate bar (`setProgressBar(2, { mode:
'indeterminate' })`, Electron's documented way to ask for one) instead
of pretending to know a number it doesn't.

**A known, disclosed gap**: deleting a profile (§8.3) while it has an
in-progress download only removes that download from the aggregate and
from anything the UI can show or cancel — it does not cancel the actual
in-flight Electron `DownloadItem`, which keeps running to completion (or
failure) with nothing left tracking or reporting it. Pre-existing
behavior (profile deletion never cancelled anything download-related,
before or after this), surfaced while wiring this in rather than
introduced by it; not fixed here since deleting a profile mid-download
is a narrow edge case, but worth being honest about rather than silently
leaving it undocumented.

**Verified** by spying on the real `win.setProgressBar` (a temp local
HTTP server serving a large-enough, slow-enough file that intermediate
progress is actually observable, not just an instant 0-to-1 jump):
an intermediate fraction while downloading, `-1` on completion, a
second profile's download — deliberately triggered while that profile is
in the *background* — still updating the one shared progress bar, and
`-1` again once every profile is back to idle.

### 8.26 Fixed: the history (and downloads) popover getting cut off

Reported plainly: "the history menu is getting cut off and the whole
thing is not displaying." Two distinct bugs, both in the shared popover
plumbing (`ContextMenu.js`), not anything specific to History.js itself
— found in that order, and the second, more fundamental one was hiding
behind the first.

**Bug one: nothing capped a popover's *total* height.**
`positionWithinViewport` has always clamped a popover's *position* (its
`x`/`y`) to keep it from starting past the window's edge, and clamped
its *width* — but never its height. `History.js`'s popover (and
`Downloads.js`'s, structured the same way) puts an always-visible search
box and a "Clear all history" footer *outside* the scrollable
`.history-list`, which only capped *itself* at a fixed 320px — the
search box, list, and footer's combined height was never capped
anywhere, so on a shorter window (this app's own documented 480px
minimum included) the total could genuinely run past the bottom of the
window with no scrollbar anywhere to reach the rest. Fixed by making
`.history-popover`/`.downloads-popover` themselves `display: flex;
flex-direction: column` with their own `max-height: min(70vh, 480px)`,
and turning the inner list's fixed `max-height` into `flex: 1 1 auto;
min-height: 0` so *it's* the part that shrinks and scrolls internally
once the search box and footer take their (fixed, always-visible)
share — the standard "header + scrollable middle + footer, capped to
available height" flexbox pattern. `positionWithinViewport` also grew a
last-resort fallback (an inline `max-height` + `overflow-y: auto` on the
popover itself) for the rare case even that per-popover cap doesn't
leave enough room — deliberately last-resort, since it can only scroll
a popover as one whole unit, losing the "header/footer stay put"
behavior the per-popover CSS fix gives the common case.

**Bug two, the actual root cause: positioning ran before the real
content did.** Testing bug one's fix at a *normal*, plenty-tall window
size still failed — the popover was positioned at `y=568` in a 768px-
tall window with a 480px height, running well past the bottom despite
plenty of room existing higher up. `showPopover(build, anchor, ...)`
calls `build(popover)` and immediately measures/positions the result —
but `History.js`'s `build` (`renderList`) is `async`: it awaits
`HISTORY_LIST` (an IPC round trip) before the real rows ever exist in
the DOM. `positionWithinViewport` was measuring and clamping against
whatever was in `popover` *before* that await resolved — just an empty
list between a search box and a footer, maybe 100px tall — computing a
`y` that had plenty of room for *that* height, then never re-running
once the real ~30-row content actually rendered in and grew the popover
to its full capped height. The exact same thing happens on every
*later* re-render too: typing in the search box, or (`Downloads.js`)
a live `downloads:changed` push arriving while the popover is already
open, can each change the content's height without ever re-triggering
`positionWithinViewport` on their own.

Fixed with `repositionCurrentPopup()`, a new export tracking whatever
popover is currently open (`{ el, anchor, fullWidth }`) so the same
position/clamp logic can be re-run later, not just once at creation:
`showPopover` itself calls it automatically once an async `build`'s
promise resolves (covers `History.js`'s and `Downloads.js`'s *first*
render), and `History.js`/`Downloads.js` each call it again at the end
of their own later re-renders (a search keystroke, a live push) — the
one thing `showPopover` can't know about on its own, since those happen
long after the initial call returns.

**Verified**: at the app's own 720×480 minimum window size, a 30-entry
history list — search box, list (now genuinely scrolling internally,
`scrollHeight` far exceeding `clientHeight`), and the "Clear all
history" footer all measured, via real `getBoundingClientRect()` calls,
to render fully within the window; the same popover at a normal, tall
window size (the case that exposed bug two — failed until
`repositionCurrentPopup()` existed); narrowing via search and then
clearing it back to the full list (content shrinking then growing back
after the popover is already open) still fitting afterward; the same
flex fix applied to `.downloads-popover` verified independently (its
footer visible and the popover still fitting after a real, live
`downloads:changed` push arrives while it's open); and a regression pass
confirming the synchronous Bookmarks popover (no search box, no footer,
unaffected by either bug) still behaves exactly as before.

### 8.27 Popovers can now render over the main window

Asked plainly: "make the popover menus be able to show over the main
window? There's no reason they should go under the main window." Fair —
every popover `ContextMenu.js` manages (bookmarks, history, downloads,
extensions, the profile switcher, the tab/group-color context menus)
used to be squeezed into a `getChromeWidth()`-derived clamp (rail + tab
panel width, 264px by default) purely because a `BrowserView` always
paints above the chrome window's own content (§2.3) — a popover
positioned past that boundary would render invisibly *behind* the
active tab's page, not in front of it. The permission prompt
(§8.16) was already the one exception, since it separately detached the
active view for as long as it was open and passed `fullWidth: true` to
skip that clamp.

**The fix generalizes what the permission prompt already did, to every
popup this module shows.** `showContextMenu`/`showPopover` now call
`pushHideActiveView()` (ViewOverlay.js) right after appending the popup
to the DOM, and the shared dismiss handler (`wireDismiss`'s
`closeCurrent`) calls `popHideActiveView()` whenever a popup actually
closes — covering every path that ends a popup's life (an item's own
`onClick`, an outside click, Escape, or one popup replacing another via
`showPopover`'s/`showContextMenu`'s own `closePopup()` call at the top).
Going through `ViewOverlay.js`'s reference count (not
`window.browserAPI.hideActiveView` directly) is what keeps this correct
when a permission prompt happens to overlap a popover, or one popover
replaces another — the view only actually re-attaches once *every*
caller that asked for it hidden has released it, never prematurely
mid-overlap.

With the view now always hidden while any of these are open, the
`getChromeWidth()` clamp had no reason left to exist — `fullWidth` is
gone as a concept entirely (there's only one behavior now), and
`positionWithinViewport` clamps position/width/height against the real
window edges (`window.innerWidth`/`innerHeight`) rather than the old
sidebar boundary. `PermissionPrompt.js` dropped its own now-redundant
`pushHideActiveView`/`popHideActiveView` calls and its `fullWidth: true`
option, since `ContextMenu.js` handles both for it automatically now,
the same as everything else.

One incidental side effect worth naming: `.popup-menu`'s base CSS
`max-width: 248px` and each popover's own more specific `max-width`
(220–320px, `.history-popover`/`.downloads-popover`/etc.) were always
being silently overridden by `positionWithinViewport`'s own inline
`style.maxWidth` (which computed to roughly the same ~248px anyway,
purely by coincidence of the old sidebar width) — now that the inline
value is window-width-derived (typically 1000px+), those per-popover
CSS rules actually take effect for the first time, rather than every
popover being invisibly capped to ~248px regardless of what its own
class asked for.

**Verified**: every popup type (a `showPopover` one — bookmarks — and a
`showContextMenu` one — the tab right-click menu) detaches the active
BrowserView the instant it opens and reattaches it the instant it
closes, via any dismissal path (item click, outside click); a popover
can now genuinely render with its right edge past the old 264px sidebar
boundary, into where the page content would otherwise be; opening a
second popover while a first is still open never lets the view flash
back into view in the gap between them (checked via `win.getBrowserViews()
.length` staying at 0 throughout, not just before and after); and the
permission prompt — now relying entirely on `ContextMenu.js`'s handling
instead of its own — still correctly hides/shows across both an
explicit Allow/Block click and an outside-click dismiss, with the
underlying page's permission request still resolving correctly
(`granted`/`denied`) either way.

### 8.28 True-overlay popovers: a dedicated BrowserView per popover

Follow-up to §8.27: "do the popover menus have to hide the page
content?" They didn't have to in principle — hiding the page was a
workaround for one specific constraint (a `BrowserView` always paints
above the chrome window's own content, §2.3), not something popovers
needed for their own sake. Two ways forward: migrate the chrome UI off
`BrowserView` entirely onto the newer `WebContentsView` (which composites
via the same content-view tree as regular DOM, so ordinary CSS z-index
would work), or give each popover its own small `BrowserView`, sized to
exactly its own footprint, stacked on top of the page's view instead of
detaching it. Asked which to pursue; the migration was picked first.

**Spike 1 (rejected): `WebContentsView` migration.** The premise was a
transparent, click-through chrome layer covering the whole window,
letting the page show through everywhere except where actual chrome
content was drawn. Built an isolated throwaway script to test the one
load-bearing assumption *before* touching any real code — Electron has
no CSS-driven click-through between two stacked views. A transparent
`WebContentsView`/`BrowserView` positioned over another one still
captures every mouse event inside its own bounds regardless of its
visual transparency; `setIgnoreMouseEvents()` is a `BrowserWindow`-level
API for forwarding input to a separate OS window *behind* this one, not
something that applies between two views stacked inside the same
window's own content-view tree. That killed the whole-window-overlay
idea outright — not a matter of degree or extra plumbing, the mechanism
this plan depended on doesn't exist. Reported this back rather than
building further on a premise that didn't hold.

**Spike 2 (confirmed, built on): small per-popover `BrowserView`s.** The
same experiment, run the other way: a `BrowserView` sized via
`setBounds()` to *exactly* its own content's footprint (not the whole
window) and raised with `setTopBrowserView()` overlays the page correctly
in just that region, while the page stays fully live and clickable
everywhere else — because "everywhere else" simply isn't covered by any
view at all, no click-through trickery needed. This is the approach
built here, confirmed working before writing a line of the real
implementation.

**Architecture.** `PopoverManager` (`src/main/popover-manager.js`) owns
one on-demand `BrowserView` per chrome window, created fresh on every
`show({kind, anchor, data})` and destroyed on every close — never reused,
so there's no stale-listener/stale-state cleanup to reason about
anywhere in this feature; closing one is just letting the whole realm go.
It loads a new dedicated page, `popover.html` → `popover.js`, using the
same `chromeWindowWebPreferences()` (contextIsolation/sandbox on,
`chrome-preload.js`) as the chrome window itself, so every popover gets
the exact same trusted `window.browserAPI` surface for free. Three new
IPC channels (`popover:show`, `popover:close`, `popover:reportSize`) plus
one push (`popover:init`) replace `ContextMenu.js`'s in-document
`showContextMenu`/`showPopover`/`closePopup`, which is now dead code and
removed — nothing imports it any more (`ViewOverlay.js` stays; `theme.js`
still uses it directly for the settings modal, which stays a full DOM
overlay — it's a centered modal, not an anchored dropdown, so it was
never part of this).

Each popover kind has a small standalone render function under
`src/renderer/popovers/` (`bookmarks.js`, `history.js`, `downloads.js`,
`extensions.js`, `profileSwitcher.js`, `tabMenu.js`,
`groupColorPicker.js`, `permission.js`) that `popover.js` dispatches to
by `kind`. Moving each one out of the old `ContextMenu.js`-based
components turned out to be a small, low-risk change: every injected
callback the old chrome-side modules passed in (`onOpen`, `onRemove`,
`onCancel`, `groupActions.setGroupColor`, ...) was already nothing but a
thin `window.browserAPI.X()` wrapper (see the old `index.js`), so the
popover's own content, now running in its own separate webContents, just
calls `window.browserAPI` directly instead of receiving it secondhand.
Only genuinely tab/group-specific state that main can't hand back on its
own crosses as `data` — the tab id, its pinned/group/split state, and the
other groups it could move to for the tab context menu; the group id and
current color name for the color picker; the requestId/origin/permission
for the permission prompt. Each chrome-side trigger file (`Bookmarks.js`,
`History.js`, etc.) shrank to just the click handler that calls
`window.browserAPI.showPopover(kind, anchor, data)` — `Downloads.js` also
keeps its rail-button "something's downloading" badge logic, since
that's chrome-window DOM the popover has no reason to reach into.

Live-updating popovers (bookmarks/downloads/extensions) subscribe to the
same `onBookmarksChanged`/`onDownloadsChanged`/`onExtensionsChanged`
pushes the chrome window gets — which required widening
`ipc-handlers.js`'s central `send()` broadcaster to also forward to
whatever popover is currently open, not just the chrome window; sending
every channel to both is harmless, a popover of a kind that doesn't care
about a given channel just never subscribes to it.

**Two-phase sizing**, replacing `repositionCurrentPopup()`'s old manual
call sites scattered through `ContextMenu.js`/`History.js`/`Downloads.js`:
the `BrowserView` starts at a minimal 1×1 (invisible) size; `popover.js`
renders the popover's actual content into `#popover-root`, watches its
one top-level child (`.popup-menu`/`.bookmarks-popover`/etc. — the
element that class was always applied to) with a `ResizeObserver`, and
reports its measured width/height to main via `reportPopoverSize()` on
every change — a search keystroke narrowing the list, a download's
progress rows changing height, anything. `PopoverManager.reportSize()`
clamps that against the real window size and calls `setBounds()`,
positioning it against its anchor and flipping to whichever corner still
fits. Dismissal is a single `blur` listener on the popover's own
webContents — covers "clicked the page" and "clicked elsewhere in the
chrome window" as one signal, since only one webContents can hold OS
input focus at a time; no mousedown-listener/timing-hack needed the way
`ContextMenu.js`'s same-document version required (deferring its own
listener by a tick so the click that *opened* the popup didn't also
close it) — that whole class of problem doesn't exist once the popover
is a separate webContents from whatever opened it.

**Two bugs caught by reasoning about the two-phase sizing before ever
running it**, both in `popover.html`'s CSS:

- Each popover's root class was already `position: absolute` (load-
  bearing — that's what makes it shrink-to-fit its own content via
  min/max-width, rather than stretch to fill its container the way a
  plain block element would) with `width` left at the CSS default
  (`auto`). But CSS's shrink-to-fit algorithm for `width: auto` sizes
  toward the *available width of the containing block* before clamping
  to min/max-width — and while the view is still 1×1 (before the first
  real measurement), available width is ~0, so it would measure the
  narrowest possible word-wrapped layout, not what the content actually
  wants. Fixed with `width: max-content !important` on the popover's
  root element — sized purely from its own preferred size, with no
  dependency on the containing block's width at all, still clamped by
  min/max-width exactly like `auto` would be. Reproduces, for the new
  1×1-then-resize case, the same result `auto` already gave for free in
  the old architecture (hosted in the much-larger chrome-window
  viewport, where available width was never the limiting factor anyway).
- `#popover-root` itself is a plain `position: static` box — an
  absolutely positioned child never contributes to a static ancestor's
  own auto-sized box, in any browser, regardless of the ancestor's own
  `position`. So `popover.js` measures the popover's actual top-level
  content element (`root.firstElementChild`), not `#popover-root` itself,
  which would always read 0×0.

**One bug caught only by actually looking at a screenshot, not by
reasoning beforehand**: the first working version rendered every popover
in the default light "classic" theme regardless of what theme the rest
of the app was actually in — obvious in hindsight (this app's whole
theme system, `theme.js`, works by toggling classes on the chrome
window's own `<html>` element, persisted to that document's own
`localStorage`; `popover.html` is a separate document with no theme
state or `localStorage` access of its own, even though it shares the
same `styles.css`) but not something the sizing-focused design work
above had reason to surface. Fixed by having `PopoverManager.show()` ask
the chrome window's own document what it's currently wearing
(`executeJavaScript('document.documentElement.className')`) and pass
that along as part of `popover:init`'s payload; `popover.js` applies it
to its own `<html>` before rendering anything.

**Also found while testing, not a bug**: `BrowserWindow.capturePage()`
does not include a separately-attached `BrowserView` composited on top
of it — confirmed against Electron's own issue tracker, not just this
app's behavior. A screenshot taken this way of a chrome window with a
popover open shows the chrome window *without* the popover, even though
the popover genuinely exists, is correctly sized/positioned
(`view.getBounds()`), and is correctly rendering (its own
`webContents.capturePage()`, called directly on the popover's own
webContents rather than the window's, shows it fine). Worth recording so
a future screenshot-based check of this feature isn't mistaken for a
regression — it's a `capturePage()` characteristic, not a compositing
failure; real on-screen compositing of a `BrowserView` above its
window's own content is the exact, long-relied-upon mechanism §8.27's
whole workaround existed *because of* (a popover rendering invisibly
behind the page was only possible because a `BrowserView` really does
paint on top of everything else in the window).

**Verified** end-to-end for every popover kind (bookmarks, history,
downloads, extensions, the profile switcher, the tab context menu, the
group color picker, the permission prompt), via an isolated Electron
script (throwaway `--user-data-dir`, a local HTTP server for real pages
to bookmark/visit/request permissions from) driving the real app's main-
process wiring directly rather than through the packaged entry point, so
`PopoverManager`/`ProfileManager` stay directly inspectable rather than
only reachable through IPC:

- every kind opens, is sized well past 1×1, and its actual rendered
  content (not just "a view exists") matches what was expected — the
  bookmarked page's title, the visited page's history entry, all 8 group
  color swatches, the tab menu's Pin/Close items, the permission
  prompt's origin and copy;
- clicking a row/item both performs the action (opens a tab, changes a
  group's color) and closes the popover;
- Escape closes the open popover;
- clicking into the active tab's own page (simulated by focusing its
  webContents directly) closes the popover via the `blur` mechanism —
  and, checked explicitly via `electron.webContents.getFocusedWebContents()`
  rather than trusting `webContents.isFocused()` (which reported `true`
  on both sides at once and turned out not to be the right signal here),
  the page genuinely keeps real input focus afterward rather than
  `PopoverManager.close()`'s own unconditional refocus-the-chrome-window
  call stealing it back — a plausible-sounding regression that direct
  testing showed doesn't actually happen;
- opening a second popover while a first is open closes the first
  first (checked via the permission-prompt case specifically, since
  that's the one where getting superseded needs to fall back to "deny,
  don't remember" — see below);
- the permission prompt resolves the page's actual
  `navigator.geolocation.getCurrentPosition()` call correctly both ways:
  `allow` when answered explicitly, and `deny` (without remembering)
  when dismissed *any* other way (superseded by a different popover, in
  the test) — via `PopoverManager`'s new `onClose` callback, wired up
  only for this one kind in `ipc-handlers.js`'s `POPOVER_SHOW` handler,
  replacing `PermissionPrompt.js`'s old `MutationObserver`-on-
  `document.body` (which detected its own popup's DOM node disappearing,
  regardless of why) with something that fires no matter how the popover
  actually goes away. `resolvePendingPermission`'s existing idempotency
  (deletes its pending entry on first call) is what makes this safe to
  wire unconditionally rather than needing to track "was this already
  answered" separately — a call after an explicit answer is just a
  no-op.
- reopening the exact same suite of checks after the theme-class fix
  confirmed no regression (28 checks, then 28 again), plus a further 3
  checks specifically for theme propagation (a forced dark accent theme
  is picked up by a freshly opened popover, both as the right CSS class
  and as the right computed `--paper` background color) and 6 more for
  the Escape/page-click dismissal paths above.

### 8.29 Focus mode

"I want to have the side rail, side bar, and top url bar slowly hide
away leaving only the main web window with no distractions." Two open
product questions asked up front: how to get the chrome back
temporarily without fully leaving focus mode (hovering the very top
edge of the window "peeks" it back, auto-hiding again a moment after —
the same idea as fullscreen video controls or macOS's auto-hiding menu
bar), and what toggles it (Cmd/Ctrl+Shift+F, plus a rail button that —
necessarily — only ever helps turn it *on*, since it's part of the rail
that disappears once it's active).

**The same `BrowserView`-always-on-top constraint from §8.27/§8.28
shows up again here, in the opposite direction.** The rail/sidebar/
toolbar collapsing is a CSS transition in this document
(`#chrome-root.focus-hide`, styles.css) — cheap, ordinary, nothing new.
But the page itself is a separate `BrowserView`, positioned by main
(`TabManager.recomputeBounds()`) with no awareness of this document's
own CSS at all. Expanding it to fill the window is what actually
reveals more of the page — and since a `BrowserView` always paints
*above* this document, doing that at the wrong moment breaks the
illusion entirely:

- **Entering** (hide): if the `BrowserView` expanded *before* the CSS
  collapse finishes, it would instantly cover the still-fading-out rail/
  toolbar — the "slowly hide away" transition would be hidden behind the
  now-full-size page from its very first frame, not actually visible.
- **Leaving/peeking** (reveal): the opposite risk — if the CSS reveal
  started *before* the `BrowserView` shrinks back down, the reappearing
  chrome would render *underneath* the still-full-size page and never
  actually be seen.

So the two directions are deliberately sequenced oppositely
(`FocusMode.js`'s `setDesiredHidden`): hiding waits for the CSS
`transitionend` before telling main to expand the view; revealing tells
main to shrink the view first, and only removes the CSS class once
that's confirmed. A monotonic token guards the case a hide and a reveal
race each other (toggling twice fast, or a peek starting and ending
faster than a 340ms transition) — found and fixed by reasoning through
that scenario before ever running it, the same way §8.28 caught its own
CSS bugs ahead of testing: a stale `transitionend` listener from an
abandoned hide, left attached, would otherwise fire later and re-hide a
view that had already been told to reveal.

**Peeking** is a temporary, fully-reversible suspension of the same
hide/reveal mechanism, not a separate code path — `startPeek()`/
`endPeek()` call exactly the same `setDesiredHidden()` the top-level
toggle does. What decides when to end a peek turned out to need three
signals, not just "did the mouse leave":

- the mouse position (`clientX`/`clientY` against the revealed rail's/
  toolbar's own live `getBoundingClientRect()` — both are revealed
  together as one unit, since the rail+tab panel run the window's full
  height on the left while the toolbar is a strip across the top);
- whether something *in* the revealed chrome currently has real
  keyboard focus (`document.activeElement`) — needed because Cmd/Ctrl+L
  (focus the address bar) can peek the chrome and then be followed by
  typing with the mouse sitting anywhere, nowhere near the toolbar;
- whether the chrome window's own document currently has focus at all
  (`document.hasFocus()`) — needed because opening a popover (§8.28)
  from the peeked rail hands input focus to that popover's own separate
  webContents, which would otherwise read as "mouse left, nothing
  focused, hide it" out from under whatever the user just opened.
  `PopoverManager.close()` already hands focus back to this document the
  moment a popover closes (§8.28), which is what lets the hide countdown
  correctly resume right then instead of however long was left on a
  stale timer, or hanging forever.

Cmd/Ctrl+L peeks the chrome first if it's currently hidden
(`peekForInteraction()`) before focusing the address bar — without this,
the shortcut would silently focus an invisible field (a plain `.focus()`
call works on a zero-opacity, zero-size, `pointer-events: none` element
same as any other, just with the user unable to see it happened).
Cmd/Ctrl+F (find-in-page) deliberately does *not* do this — the find bar
can float on its own near the very top of an otherwise-clean window
without needing the rest of the chrome back, which reads as reasonable
rather than broken.

`focusMode` follows the exact same "one canonical value on
`ProfileManager`, synced to whichever `TabManager` is currently active"
pattern §8.11's `tabPanelWidth` already established for the sidebar's
width — chrome-level UI, not per-profile, kept correct across a profile
switch the same way. Unlike `tabPanelWidth` it's never written to disk:
always `false` again on a fresh launch, the same convention `findBarOpen`
already used, rather than an app that quit while focused reopening into
a chromeless window with no visible way back in.

One sliver, `FOCUS_HOTZONE_H` (6px, tab-manager.js), is deliberately
*never* covered by the `BrowserView` even at full focus — it's what
makes hovering the top edge detectable at all in this document's own
`mousemove` listener; if the page filled the entire window with nothing
left uncovered, there would be nowhere left for that hover to ever
reach this side.

**Verified** via an isolated Electron script (21 checks): entering via
the rail button and via the shortcut, exiting via the shortcut, and the
`BrowserView`'s actual bounds (not just the CSS class) expanding/
contracting correctly each time; hovering the top edge peeks the rail/
sidebar/toolbar back (both the reported `TabManager.focusMode` flag and
the rail's own computed opacity checked, not just one or the other);
moving away re-hides it after the delay; Cmd/Ctrl+L peeks the chrome and
actually focuses the address bar, and typing in it (mouse left
untouched) holds the peek open past where the plain auto-hide delay
would otherwise have fired; opening a popover from the peeked rail holds
the peek open regardless of where the mouse then goes, and closing that
popover lets the hide countdown resume and actually complete.
