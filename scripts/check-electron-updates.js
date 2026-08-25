#!/usr/bin/env node
'use strict';

// Electron bundles Chromium — Chromium security patches only reach this
// app when Electron itself is updated (there is no separate background
// updater for the browser engine, unlike a real installed browser). This
// script checks whether a newer Electron is available and tells you what
// to do; it never modifies anything on its own. Run it periodically
// (`npm run check-electron`) — see DESIGN.md §6.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

const installed = require(path.join(__dirname, '..', 'node_modules', 'electron', 'package.json')).version;

let latest;
try {
  latest = execFileSync('npm', ['view', 'electron', 'version'], { encoding: 'utf8' }).trim();
} catch (err) {
  console.error('Could not reach npm to check the latest Electron version:', err.message);
  process.exitCode = 1;
  process.exit();
}

if (installed === latest) {
  console.log(`Electron is up to date (${installed}) — you're already on the latest stable Chromium build.`);
  process.exit(0);
}

const [instMajor] = installed.split('.').map(Number);
const [latestMajor] = latest.split('.').map(Number);

console.log(`Electron ${installed} is installed; ${latest} is available.`);
if (latestMajor > instMajor) {
  console.log(
    `This is a MAJOR version bump (${instMajor} -> ${latestMajor}) — check the release notes for breaking changes ` +
      `before upgrading: https://www.electronjs.org/docs/latest/breaking-changes`
  );
} else {
  console.log('This is a same-major update (routine Chromium/Node/security patches).');
}
console.log('\nTo upgrade:');
console.log(`  npm install --save-dev electron@${latest}`);
console.log('  npm start   # confirm the app still launches cleanly before committing the bump');
process.exitCode = 1;
