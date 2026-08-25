'use strict';

const { normalizeInput } = require('../shared/url-utils');
const { classifyNavigation } = require('./security');

/**
 * Resolves raw address-bar input (§4.1 nav:go) into the URL that should
 * actually be loaded: either the URL itself (scheme-normalized) or a
 * search-engine query URL.
 */
function resolveNavigationTarget(input) {
  return normalizeInput(input);
}

/**
 * Wires the navigation/popup security policy (DESIGN.md §7.7, §7.8, §8.7)
 * onto a single WebContents instance (a BrowserView's webContents). Main
 * is the enforcement point, never the renderer.
 *
 * `onOpenNewTab(url)` is invoked when a page requests a new top-level
 * browsing context (e.g. target="_blank", window.open) for an otherwise
 * allowed URL — it should open a new managed tab via TabManager. Anything
 * disallowed is denied outright, never handed to an unmanaged
 * BrowserWindow or `shell.openExternal` auto-invocation.
 *
 * `onBlocked(url, reason)` fires whenever a page-initiated navigation
 * (redirect, link click, window.open) is denied — 'scheme' or
 * 'malicious' — so the caller can show an explanation instead of just
 * silently cancelling the navigation, which used to look like the
 * browser was broken rather than actively protecting the user.
 */
function attachNavigationPolicy(webContents, { onOpenNewTab, onBlocked } = {}) {
  const guard = (event, targetUrl) => {
    // getURL() at this point (will-navigate/will-redirect fire before the
    // navigation commits) still reflects the page navigating away — the
    // source, for the same-extension exception in classifyNavigation.
    const verdict = classifyNavigation(targetUrl, webContents.getURL());
    if (verdict !== 'ok') {
      event.preventDefault();
      if (typeof onBlocked === 'function') onBlocked(targetUrl, verdict);
    }
  };

  webContents.on('will-navigate', guard);
  webContents.on('will-redirect', guard);

  webContents.setWindowOpenHandler(({ url }) => {
    const verdict = classifyNavigation(url, webContents.getURL());
    if (verdict !== 'ok') {
      if (typeof onBlocked === 'function') onBlocked(url, verdict);
      return { action: 'deny' };
    }
    if (typeof onOpenNewTab === 'function') {
      onOpenNewTab(url);
    }
    // Never let Electron create an unmanaged BrowserWindow for the popup;
    // we've already routed it to a managed tab (or dropped it) above.
    return { action: 'deny' };
  });
}

module.exports = { resolveNavigationTarget, attachNavigationPolicy };
