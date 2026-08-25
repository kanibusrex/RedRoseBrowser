# RedRose Browser

[![Build](https://github.com/kanibusrex/RedRoseBrowser/actions/workflows/build.yml/badge.svg)](https://github.com/kanibusrex/RedRoseBrowser/actions/workflows/build.yml)

A Chromium-based desktop browser, built with Electron, with a custom UI shell and a
few things stock Chrome doesn't do out of the box: built-in ad/tracker blocking, a
local malicious-site blocklist, split-view tabs, and a resizable tab panel.

## Download

Grab the latest build from [Releases](https://github.com/kanibusrex/RedRoseBrowser/releases) —
a `.dmg` for macOS, `Setup.exe` for Windows.

> **Note:** these builds aren't code-signed yet, so the first launch will show an
> "unidentified developer" warning on macOS (right-click → Open) or a SmartScreen
> warning on Windows ("More info" → "Run anyway"). The app itself isn't affected —
> there's just no paid signing certificate configured for CI yet.

## Features

- **Profiles** — separate, fully isolated workspaces (own cookies, storage, tabs,
  extensions) switchable from one window, not one window per profile.
- **Tabs** — pinning, color-coded groups, and drag-one-tab-onto-another **split view**
  for browsing two pages side by side.
- **Resizable tab panel** — drag the edge of the tab list to make it wider or
  narrower; it's remembered across restarts.
- **Bookmarks**, scoped per profile.
- **Chrome extensions** — installable from a Chrome Web Store URL or ID. Includes a
  compatibility fix for a real gap in Electron's extension support (see
  [DESIGN.md](DESIGN.md#88-chrome-extensions--per-profile-installed-from-a-web-store-urlid)
  for what that actually took) so more extensions load and run than Electron
  supports by default.
- **Built-in ad/tracker blocking** — a real EasyList/uBlock-filter-compatible
  engine wired directly into the browser, not a Chrome extension (Electron's
  extension API has a gap that keeps extension-based ad blockers from working at
  all — this sidesteps it entirely).
- **A local, offline malicious-site blocklist** — no live API calls, no phoning
  home; the list is a periodically-refreshed local snapshot.
- **A custom home / new-tab page** — a self-contained start page with a clock,
  launcher search (with an inline calculator and unit conversion), and
  customizable shortcuts.
- Window size, position, and the sidebar width all persist across restarts.

## Building from source

```bash
npm install
npm start
```

Requires Node 20+. `npm start` runs the app directly via Electron; there's no
build step for development.

### Packaging installers

```bash
npm run dist:mac    # produces a .dmg and .zip in release/
npm run dist:win     # produces an NSIS installer in release/
```

macOS installers can only be built on macOS, and Windows installers on Windows —
that's a limitation of the underlying packaging tools ([electron-builder](https://www.electron.build/)),
not this project. CI (`.github/workflows/build.yml`) builds both automatically on
every push to `main`, and attaches installers to a draft GitHub Release whenever a
`v*` tag is pushed.

### Maintenance scripts

```bash
npm run check-electron        # checks for a newer stable Electron release
npm run update-blocklist      # refreshes the local malicious-site blocklist
npm run update-adblock-lists  # rebuilds the bundled ad/tracker filter engine
```

None of these run automatically — refreshing them is a deliberate, manual
maintainer action, not something the shipped app does on its own.

## Architecture

[DESIGN.md](DESIGN.md) covers the full architecture and the reasoning behind
every non-obvious decision — process boundaries, security model, and each
feature's own section explaining what it does and why it's built the way it is.

## License

[GPL-3.0](LICENSE).
