'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const ENGINE_PATH = path.join(__dirname, 'adblock-engine.bin');

/**
 * Built-in ad/tracker blocking, independent of the Chrome-extensions
 * bridge (§8.8.1). Chrome-extension ad blockers (uBlock Origin, etc.)
 * were proven not to work here — Electron's `chrome.webRequest` reports
 * `tabId: -1` for every request from every tab this app creates, and
 * extensions like uBlock silently decline to block when they can't
 * resolve a real tab. This blocker sidesteps that entirely by using
 * Electron's own `session.webRequest` directly — proven reliable in
 * that same investigation — with `@ghostery/adblocker-electron`, a
 * library purpose-built for exactly this (EasyList/uBlock-filter
 * compatible, MPL-2.0, used by other Electron browsers for this same
 * problem).
 *
 * The filter list itself is loaded from a checked-in, pre-serialized
 * binary (`adblock-engine.bin`), never fetched at runtime — same
 * zero-runtime-network-calls stance as the malicious-site blocklist
 * (§8.7). Refresh it with `npm run update-adblock-lists`.
 */
class AdBlocker {
  constructor() {
    /** @type {import('@ghostery/adblocker-electron').ElectronBlocker | null} */
    this.blocker = null;
    this.loadError = null;
    try {
      const buffer = fs.readFileSync(ENGINE_PATH);
      this.blocker = ElectronBlocker.deserialize(buffer);
    } catch (err) {
      // Missing/corrupt engine file must not crash the browser — just
      // means ad blocking is unavailable until `npm run update-adblock-lists`
      // is run. Every other feature keeps working.
      this.loadError = err.message;
      console.warn('Ad blocker unavailable:', err.message);
    }
  }

  enableForSession(session) {
    if (!this.blocker) return;
    try {
      this.blocker.enableBlockingInSession(session);
    } catch {
      /* already enabled for this session */
    }
  }
}

module.exports = { AdBlocker };
