'use strict';

const fs = require('node:fs');
const path = require('node:path');
const yauzl = require('yauzl');

// Extracts a zip Buffer to destDir, hardened for genuinely untrusted
// input (a downloaded Chrome extension package) — this is deliberately
// NOT using the popular `extract-zip` package, which has an unpatched
// high-severity symlink path-traversal advisory (GHSA-jmr9-qjv8-65gv,
// no fix available) that is exactly the attack this function's whole job
// is to prevent. Two things extract-zip's issue lets slip that this
// explicitly rejects:
//   1. "Zip-slip" — an entry path like "../../../etc/cron.d/x" that
//      would resolve outside destDir once joined and normalized.
//   2. Symlink entries — a zip can declare a file as a symlink via its
//      Unix mode bits in the external file attributes; extracting one
//      lets the archive point anywhere on disk. Extensions never need
//      symlinks, so every symlink entry is rejected outright.
// Also caps total/per-file extracted size against zip-bomb-style abuse.

const MAX_TOTAL_BYTES = 200 * 1024 * 1024; // 200MB
const MAX_FILE_BYTES = 60 * 1024 * 1024; // 60MB
const MAX_ENTRIES = 20000;

function isSymlinkEntry(entry) {
  const unixMode = entry.externalFileAttributes >>> 16;
  const S_IFMT = 0xf000;
  const S_IFLNK = 0xa000;
  return unixMode !== 0 && (unixMode & S_IFMT) === S_IFLNK;
}

function resolveSafeEntryPath(destDir, entryFileName) {
  // Reject absolute paths and drive letters outright before any joining.
  if (path.isAbsolute(entryFileName) || /^[a-zA-Z]:/.test(entryFileName)) return null;
  const resolved = path.resolve(destDir, entryFileName);
  const destPrefix = destDir.endsWith(path.sep) ? destDir : destDir + path.sep;
  if (resolved !== destDir && !resolved.startsWith(destPrefix)) return null; // zip-slip
  return resolved;
}

function safeUnzipBuffer(buffer, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });

    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return reject(err);

      let totalBytes = 0;
      let entryCount = 0;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        try {
          zipfile.close();
        } catch {
          /* already closed */
        }
        reject(error);
      };

      zipfile.readEntry();

      zipfile.on('entry', (entry) => {
        if (settled) return;
        entryCount += 1;
        if (entryCount > MAX_ENTRIES) return fail(new Error('Extension package has too many files'));

        if (isSymlinkEntry(entry)) return fail(new Error(`Refusing to extract symlink entry: ${entry.fileName}`));

        const targetPath = resolveSafeEntryPath(destDir, entry.fileName);
        if (!targetPath) return fail(new Error(`Refusing to extract unsafe path: ${entry.fileName}`));

        const isDir = /\/$/.test(entry.fileName);

        if (isDir) {
          fs.mkdirSync(targetPath, { recursive: true });
          zipfile.readEntry();
          return;
        }

        totalBytes += entry.uncompressedSize;
        if (entry.uncompressedSize > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
          return fail(new Error('Extension package exceeds the size limit'));
        }

        fs.mkdirSync(path.dirname(targetPath), { recursive: true });

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr) return fail(streamErr);
          const writeStream = fs.createWriteStream(targetPath);
          readStream.on('error', fail);
          writeStream.on('error', fail);
          writeStream.on('close', () => {
            if (!settled) zipfile.readEntry();
          });
          readStream.pipe(writeStream);
        });
      });

      zipfile.on('end', () => {
        if (!settled) {
          settled = true;
          resolve(destDir);
        }
      });

      zipfile.on('error', fail);
    });
  });
}

module.exports = { safeUnzipBuffer };
