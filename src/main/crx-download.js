'use strict';

const https = require('node:https');

// Extension IDs are always 32 lowercase letters in [a-p] (Chrome derives
// them from a hash, base16-encoded with a-p instead of 0-9a-f). Validate
// strictly before this ever touches a URL or a filesystem path.
const EXTENSION_ID_RE = /^[a-p]{32}$/;

const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // 100MB
const DOWNLOAD_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;

/**
 * Accepts either a bare 32-char extension ID or a Chrome Web Store URL
 * (old chrome.google.com/webstore/... or current chromewebstore.google.com/...)
 * and returns the extension ID, or throws a clear error.
 */
function parseExtensionRef(input) {
  const trimmed = String(input || '').trim();
  if (EXTENSION_ID_RE.test(trimmed)) return trimmed;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('Enter a Chrome Web Store URL or a 32-letter extension ID.');
  }

  if (!/(^|\.)google\.com$/.test(url.hostname) && !/(^|\.)chromewebstore\.google\.com$/.test(url.hostname)) {
    throw new Error('That URL is not a Chrome Web Store link.');
  }

  const match = url.pathname.match(/[a-p]{32}/);
  if (!match) throw new Error("Couldn't find an extension ID in that URL.");
  return match[0];
}

// Google's own (undocumented but long-stable — Chrome itself uses it)
// direct CRX download endpoint. No API key; this is a plain HTTPS GET.
//
// prodversion matters: Google's server checks it against each
// extension's minimum-Chrome-version requirement and responds 204 (no
// applicable update) if it looks too old, even though the extension is
// otherwise perfectly downloadable. This needs to track roughly-current
// Chrome so newer extensions don't start silently 204ing as time passes
// — bump it periodically (same maintainer-action spirit as
// npm run update-blocklist / check-electron, DESIGN.md §6, §8.7).
const CHROME_PRODVERSION = '140.0.0.0';

function crxDownloadUrl(extensionId) {
  const params = new URLSearchParams({
    response: 'redirect',
    prodversion: CHROME_PRODVERSION,
    acceptformat: 'crx2,crx3',
    x: `id=${extensionId}&installsource=ondemand&uc`,
  });
  return `https://clients2.google.com/service/update2/crx?${params.toString()}`;
}

function get(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: DOWNLOAD_TIMEOUT_MS }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects downloading extension'));
        resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (res.statusCode === 204) {
        res.resume();
        return reject(new Error("This extension isn't available for download. Double-check the ID or Web Store link."));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Extension download failed (HTTP ${res.statusCode})`));
      }

      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_DOWNLOAD_BYTES) {
          req.destroy();
          reject(new Error('Extension package is too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timed out downloading extension')));
    req.on('error', reject);
  });
}

async function downloadCrx(extensionId) {
  return get(crxDownloadUrl(extensionId), MAX_REDIRECTS);
}

// Strips the CRX2/CRX3 container header off, returning the inner ZIP
// payload. This does NOT verify the embedded publisher signature — a
// real gap noted in DESIGN.md — we trust Google's endpoint over HTTPS
// for authenticity/integrity in transit but don't re-derive trust in the
// publisher key the way Chrome itself does.
function extractZipFromCrx(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Downloaded file is not a valid Chrome extension package (.crx)');
  }
  const version = buffer.readUInt32LE(4);

  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    const zipStart = 12 + headerLength;
    if (zipStart > buffer.length) throw new Error('Corrupt .crx package (bad header length)');
    return buffer.subarray(zipStart);
  }

  if (version === 2) {
    const pubKeyLength = buffer.readUInt32LE(8);
    const sigLength = buffer.readUInt32LE(12);
    const zipStart = 16 + pubKeyLength + sigLength;
    if (zipStart > buffer.length) throw new Error('Corrupt .crx package (bad header length)');
    return buffer.subarray(zipStart);
  }

  throw new Error(`Unsupported .crx version: ${version}`);
}

module.exports = { parseExtensionRef, downloadCrx, extractZipFromCrx, EXTENSION_ID_RE };
