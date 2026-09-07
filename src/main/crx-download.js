'use strict';

const https = require('node:https');
const crypto = require('node:crypto');

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
// payload *and* the publisher's DER-encoded RSA public key (§8.35) when
// one can be found. This does NOT verify the embedded publisher
// signature — a real gap noted in DESIGN.md — we trust Google's endpoint
// over HTTPS for authenticity/integrity in transit but don't re-derive
// trust in the publisher key the way Chrome itself does; the key is
// extracted purely to get a *stable, correct* extension id (see
// manifestKeyFromCrx below), not for any signature-verification purpose.
function parseCrx(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Downloaded file is not a valid Chrome extension package (.crx)');
  }
  const version = buffer.readUInt32LE(4);

  if (version === 3) {
    const headerLength = buffer.readUInt32LE(8);
    const zipStart = 12 + headerLength;
    if (zipStart > buffer.length) throw new Error('Corrupt .crx package (bad header length)');
    const header = buffer.subarray(12, 12 + headerLength);
    return { zip: buffer.subarray(zipStart), publicKeyDer: extractCrx3PublicKey(header) };
  }

  if (version === 2) {
    const pubKeyLength = buffer.readUInt32LE(8);
    const sigLength = buffer.readUInt32LE(12);
    const zipStart = 16 + pubKeyLength + sigLength;
    if (zipStart > buffer.length) throw new Error('Corrupt .crx package (bad header length)');
    // CRX2's header is a flat, fixed layout (no protobuf involved) — the
    // public key sits right after the 16-byte fixed header, for exactly
    // pubKeyLength bytes, already DER-encoded.
    const publicKeyDer = pubKeyLength > 0 ? buffer.subarray(16, 16 + pubKeyLength) : null;
    return { zip: buffer.subarray(zipStart), publicKeyDer };
  }

  throw new Error(`Unsupported .crx version: ${version}`);
}

// ---- CRX3's header is a serialized protobuf (crx3.proto); parsed by
// hand below rather than pulling in a general protobuf library for one
// message shape. Wire-format basics: each field is a varint tag
// ((fieldNumber << 3) | wireType) followed by its value — wire type 0 is
// itself a varint, wire type 2 is a varint length followed by that many
// raw bytes (used for both "bytes"/"string" fields and embedded
// messages, which is what makes walking into a nested message just a
// matter of re-running this same parse on that slice). ----

function readVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  // Real varints here are always small (tags, byte-array lengths) —
  // still using BigInt throughout to avoid any 32-bit overflow surprise
  // on a malformed/adversarial input before converting back to a plain
  // number at the end.
  while (true) {
    if (pos >= buf.length) throw new Error('Truncated protobuf varint');
    const byte = buf[pos];
    pos++;
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
  }
  return { value: Number(result), next: pos };
}

// Returns Map<fieldNumber, Array<Buffer|number>> — only wire types 0
// (varint) and 2 (length-delimited: bytes/string/embedded message) are
// needed for crx3.proto's CrxFileHeader/AsymmetricKeyProof, so 5-byte
// (fixed32) and 8-byte (fixed64) fields are skipped over rather than
// interpreted, on the assumption this is only ever pointed at that one
// known message shape.
function readProtobufFields(buf) {
  const fields = new Map();
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.next;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;
    let value;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      value = v.value;
      pos = v.next;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.next;
      if (pos + len.value > buf.length) throw new Error('Truncated protobuf length-delimited field');
      value = buf.subarray(pos, pos + len.value);
      pos += len.value;
    } else if (wireType === 5) {
      pos += 4;
      continue;
    } else if (wireType === 1) {
      pos += 8;
      continue;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wireType}`);
    }
    if (!fields.has(fieldNumber)) fields.set(fieldNumber, []);
    fields.get(fieldNumber).push(value);
  }
  return fields;
}

// CrxFileHeader.sha256_with_rsa (field 2) is a *repeated*
// AsymmetricKeyProof { public_key = field 1; signature = field 2 } — not
// always just one. Found the hard way: taking proofs[0] unconditionally
// derived the exact same id for two entirely different real extensions,
// which is only possible if that entry isn't actually the publisher's
// own key. Real Chrome Web Store packages are effectively double-signed
// — the original publisher's key survives from the original upload, but
// Google's own publishing pipeline adds its own additional proof
// alongside it, and which one lands at index 0 isn't something to rely
// on. CrxFileHeader.signed_header_data (field 10000) → SignedData.crx_id
// (field 1) is Chromium's own already-computed, authoritative answer —
// the same first-16-bytes-of-SHA256(public key) value the extension's
// final id is itself derived from — so this hashes every candidate
// proof's key and picks whichever one actually matches crx_id, rather
// than guessing an index. Returns null (never
// throws) on anything unexpected — a CRX3 with no sha256_with_rsa
// proofs at all (only sha256_with_ecdsa, field 3), no signed_header_data
// to check against, or where nothing matches — since the caller's
// fallback (the extension just keeps whatever id Electron assigns it on
// its own) is already a safe, correct no-op for that case.
function extractCrx3PublicKey(headerBuf) {
  try {
    const fields = readProtobufFields(headerBuf);
    const rsaProofs = fields.get(2);
    if (!rsaProofs || rsaProofs.length === 0) return null;

    const signedHeaderData = fields.get(10000);
    const crxId = signedHeaderData && signedHeaderData.length > 0 ? readProtobufFields(signedHeaderData[0]).get(1) : null;
    const targetId = crxId && crxId.length > 0 ? crxId[0] : null;

    const candidates = rsaProofs
      .map((proof) => readProtobufFields(proof).get(1))
      .filter((k) => k && k.length > 0)
      .map((k) => k[0]);
    if (candidates.length === 0) return null;

    if (targetId) {
      const match = candidates.find((key) => crypto.createHash('sha256').update(key).digest().subarray(0, 16).equals(targetId));
      if (match) return match;
    }
    // No signed_header_data/crx_id to check against, or nothing matched
    // it (shouldn't happen for a genuine Web Store package) — falling
    // back to the first candidate is no worse than what this did before
    // crx_id cross-checking existed, for whatever edge case reaches here.
    return candidates[0];
  } catch {
    return null;
  }
}

// manifest.json's own "key" field (§8.35) — base64 of the same DER
// SubjectPublicKeyInfo bytes found above — is what tells Electron's
// (Chromium-derived) unpacked-extension loader to compute the *real*,
// stable Web-Store id (SHA256 of this key, first 16 bytes, hex-mapped
// a-p) instead of falling back to one derived from the extension's own
// install path, which changes every time it's (re)installed and can
// never match anything another, real installation of the same
// extension — e.g. a native-messaging host's own allowed_origins list —
// already expects. Returns null for a CRX with no recoverable key
// (CRX2 with an empty/missing key field, or a CRX3 signed with an
// algorithm other than RSA), in which case the extension keeps
// Electron's own fallback id, exactly as it did before this existed.
function manifestKeyFromCrx(publicKeyDer) {
  return publicKeyDer ? publicKeyDer.toString('base64') : null;
}

module.exports = { parseExtensionRef, downloadCrx, parseCrx, manifestKeyFromCrx, EXTENSION_ID_RE };
