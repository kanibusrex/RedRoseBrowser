'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BLOCKLIST_PATH = path.join(__dirname, 'blocklist.txt');

// Known-malicious hostnames (malware distribution + phishing), merged from
// abuse.ch URLhaus and OpenPhish's free feeds (see scripts/update-
// blocklist.js). Loaded once into a Set at startup and checked purely
// locally on every navigation — deliberately NOT a live API call (unlike
// Google Safe Browsing) so browsing never phones a third party; the
// trade-off is the list is only as fresh as its last manual refresh
// (`npm run update-blocklist`), not real-time.
let hostnames = null;

function load() {
  if (hostnames) return hostnames;
  hostnames = new Set();
  try {
    const raw = fs.readFileSync(BLOCKLIST_PATH, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      hostnames.add(trimmed.toLowerCase());
    }
  } catch {
    /* missing/unreadable blocklist — fail open to an empty set rather
       than blocking all navigation */
  }
  return hostnames;
}

// Matches the exact hostname or any subdomain of a blocked entry (e.g.
// blocking "evil.com" also blocks "login.evil.com"), but never matches on
// a bare substring (e.g. blocking "evil.com" must not match
// "notevil.com").
function isMaliciousHost(hostname) {
  if (!hostname) return false;
  const list = load();
  const host = hostname.toLowerCase();
  if (list.has(host)) return true;
  for (const blocked of list) {
    if (host.endsWith('.' + blocked)) return true;
  }
  return false;
}

function isMaliciousUrl(targetUrl) {
  try {
    return isMaliciousHost(new URL(targetUrl).hostname);
  } catch {
    return false;
  }
}

module.exports = { isMaliciousHost, isMaliciousUrl };
