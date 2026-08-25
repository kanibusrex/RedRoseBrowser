#!/usr/bin/env node
'use strict';

// Rebuilds src/main/adblock-engine.bin — a serialized @ghostery/adblocker
// filter engine (EasyList/uBlock-compatible ads+tracking rules) — from
// Ghostery's maintained prebuilt lists. Run manually
// (`npm run update-adblock-lists`); the running app never fetches this
// itself, only loads the checked-in binary (see DESIGN.md §8.8.2 /
// src/main/ad-blocker.js). Same refresh-script pattern as
// update-blocklist.js (§8.7) and check-electron-updates.js (§6).

const fs = require('node:fs');
const path = require('node:path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');

const OUT_PATH = path.join(__dirname, '..', 'src', 'main', 'adblock-engine.bin');

async function main() {
  console.log('Fetching prebuilt ads+tracking filter lists...');
  const blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch);

  const buffer = blocker.serialize();
  fs.writeFileSync(OUT_PATH, buffer);

  console.log(`Wrote ${OUT_PATH} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
}

main().catch((err) => {
  console.error('Failed to update adblock engine:', err);
  process.exitCode = 1;
});
