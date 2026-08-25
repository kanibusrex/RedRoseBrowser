#!/usr/bin/env node
'use strict';

// Refreshes src/main/blocklist.txt from abuse.ch URLhaus (malware) and
// OpenPhish (phishing) — the same free, no-account-needed feeds it was
// originally built from. Run manually (`npm run update-blocklist`); the
// running app never fetches these itself (see DESIGN.md §8.7 / blocklist.js).

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const OUT_PATH = path.join(__dirname, '..', 'src', 'main', 'blocklist.txt');
const URLHAUS_URL = 'https://urlhaus.abuse.ch/downloads/hostfile/';
const OPENPHISH_URL = 'https://openphish.com/feed.txt';

function fetch(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(fetch(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`${url} responded ${res.statusCode}`));
          res.resume();
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

function parseHostsFile(text) {
  const hosts = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) hosts.add(parts[1].toLowerCase());
  }
  return hosts;
}

function parseUrlFeed(text) {
  const hosts = new Set();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const hostname = new URL(trimmed).hostname;
      if (hostname) hosts.add(hostname.toLowerCase());
    } catch {
      /* skip unparsable lines */
    }
  }
  return hosts;
}

async function main() {
  console.log('Fetching URLhaus (malware) host file...');
  const urlhaus = parseHostsFile(await fetch(URLHAUS_URL));
  console.log(`  ${urlhaus.size} hostnames`);

  console.log('Fetching OpenPhish (phishing) feed...');
  const openphish = parseUrlFeed(await fetch(OPENPHISH_URL));
  console.log(`  ${openphish.size} hostnames`);

  const merged = new Set([...urlhaus, ...openphish]);
  const sorted = [...merged].sort();

  const header = [
    '# RedRose Browser known-malicious hostname blocklist',
    '# Merged snapshot from abuse.ch URLhaus (malware) + OpenPhish (phishing) free feeds.',
    '# Static, offline, checked locally per navigation — no network calls made at runtime.',
    '# Refresh with: npm run update-blocklist',
    `# Snapshot date: ${new Date().toISOString().slice(0, 10)}`,
    '',
  ].join('\n');

  fs.writeFileSync(OUT_PATH, header + sorted.join('\n') + '\n', 'utf8');
  console.log(`\nWrote ${sorted.length} unique hostnames to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((err) => {
  console.error('Failed to update blocklist:', err.message);
  process.exitCode = 1;
});
