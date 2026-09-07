#!/usr/bin/env node
'use strict';

// Launches the real, unpackaged app (the same "electron ." npm start
// uses) against a disposable --user-data-dir and confirms it actually
// comes up cleanly — a real window loads its own chrome UI, nothing
// crashes on the way — rather than just "the process didn't immediately
// exit". Written for scripts/electron-auto-update.js (§8.37) to verify
// an automated Electron bump is safe to ship before committing to it,
// but also runnable by hand via `npm run smoke-test`.
//
// --remote-debugging-port is a standard Chromium/Electron switch this
// app doesn't need any code of its own to support (same as
// --user-data-dir already working with zero app-side handling) — used
// here purely to ask "did a real window actually load", not just
// "is the process still alive", via the same DevTools Protocol
// endpoint any Chromium browser exposes when given that flag.

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const APP_ROOT = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
// Generous — a freshly-installed/bumped Electron's first launch can be
// slower than a warm one (unpacking, GPU shader cache, etc.), and this
// running under Xvfb in CI is slower again.
const STARTUP_WAIT_MS = Number(process.env.SMOKE_TEST_WAIT_MS) || 15000;
const DEBUG_PORT = 9333;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      })
      .on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error(`FAIL: no electron binary at ${ELECTRON_BIN} — run npm install first.`);
    process.exitCode = 1;
    return;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vellum-smoke-test-'));

  const args = [
    '.',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    // CI runners (especially under Xvfb, with no real GPU) commonly need
    // this to avoid the renderer falling back to slow/failing software
    // paths — harmless on a real machine either way.
    '--disable-gpu',
    // Chromium's setuid sandbox helper (node_modules/electron/dist/
    // chrome-sandbox) has to be owned by root with mode 4755 to work at
    // all — true after electron-builder packages a real installer, but
    // NOT true of a plain `npm install`'s extracted binary on a fresh
    // CI runner, which fails this exact check and aborts with SIGTRAP
    // (found by actually running this in GitHub Actions — see the
    // "Automated Electron bump ... failed its smoke test" issue this
    // produced). Scoped to Linux only: this is a Linux-specific
    // packaging detail, macOS/Windows never hit it, and every local
    // verification of this script ran unsandboxed-flag-free on macOS.
    // Only weakens this ad hoc CI smoke-test launch, never the actual
    // shipped app — end users' installed copies run with their
    // platform's normal sandboxing untouched.
    ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
  ];

  console.log(`Launching: ${ELECTRON_BIN} ${args.join(' ')}`);
  const child = spawn(ELECTRON_BIN, args, { cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });

  function dumpOutput() {
    console.error('--- stdout ---\n' + stdout);
    console.error('--- stderr ---\n' + stderr);
  }

  // Best-effort only, deliberately never allowed to affect the actual
  // pass/fail result or crash the script — found the hard way: killing
  // the child and immediately rmSync-ing its --user-data-dir races the
  // (still-shutting-down) app's own writes to that same directory
  // (session-state flushes, lock files, ...), throwing ENOTEMPTY on a
  // directory that gained an entry mid-deletion. A short wait for the
  // process to actually exit first avoids the race in practice; the
  // try/catch is what keeps a rare remaining race from ever turning a
  // real PASS into a reported FAIL.
  async function cleanup() {
    if (!exited) {
      child.kill();
      await sleep(500);
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  await sleep(STARTUP_WAIT_MS);

  if (exited) {
    console.error(`FAIL: the app exited on its own after ${STARTUP_WAIT_MS}ms (code ${exitCode}) — it should still be running.`);
    dumpOutput();
    await cleanup();
    process.exitCode = 1;
    return;
  }

  let targets;
  try {
    targets = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
  } catch (err) {
    console.error(`FAIL: couldn't reach the app's own DevTools endpoint (${err.message}) — it may not have created a window at all.`);
    dumpOutput();
    await cleanup();
    process.exitCode = 1;
    return;
  }

  const hasChromeWindow = targets.some((t) => t.type === 'page' && /index\.html$/.test(t.url || ''));

  await cleanup();

  if (!hasChromeWindow) {
    console.error('FAIL: the app is running but no window loaded its own chrome UI (index.html).');
    console.error('DevTools targets seen:', JSON.stringify(targets, null, 2));
    dumpOutput();
    process.exitCode = 1;
    return;
  }

  console.log(`PASS: the app launched cleanly and its chrome window loaded within ${STARTUP_WAIT_MS}ms.`);
}

main().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exitCode = 1;
});
