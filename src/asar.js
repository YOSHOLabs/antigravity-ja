'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BLOCK_SIZE = 4 * 1024 * 1024; // 4 MiB

/**
 * Reads and parses the Chromium Pickle ASAR header.
 * @param {string} asarPath
 */
function readAsarHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const pre = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, pre, 0, 16, 0);
    if (bytesRead < 16) {
      throw new Error(`Invalid ASAR file (too small): ${asarPath}`);
    }
    const sizePicklePayloadLen = pre.readUInt32LE(0);
    const headerPickleSize = pre.readUInt32LE(4);
    const headerPicklePayloadSize = pre.readUInt32LE(8);
    const jsonByteLen = pre.readUInt32LE(12);

    if (sizePicklePayloadLen !== 4) {
      throw new Error(`Unexpected ASAR size pickle header (${sizePicklePayloadLen}) in ${asarPath}`);
    }
    if (headerPickleSize < jsonByteLen + 8 || headerPicklePayloadSize < jsonByteLen + 4) {
      throw new Error(`Corrupt ASAR header lengths in ${asarPath}`);
    }

    const payloadOffset = 8 + headerPickleSize;
    const jsonBuf = Buffer.alloc(jsonByteLen);
    const jsonRead = fs.readSync(fd, jsonBuf, 0, jsonByteLen, 16);
    if (jsonRead !== jsonByteLen) {
      throw new Error(`Truncated ASAR JSON header in ${asarPath}`);
    }

    const header = JSON.parse(jsonBuf.toString('utf8'));
    return { header, payloadOffset, jsonByteLen, headerPickleSize };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Builds the Chromium Pickle-aligned ASAR header buffer for a header object.
 * @param {object} header
 */
function buildAsarHeaderBuffer(header) {
  const jsonBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const jsonByteLen = jsonBuf.length;
  const padLen = (4 - (jsonByteLen % 4)) % 4;
  const alignedJsonLen = jsonByteLen + padLen;
  const headerPicklePayloadSize = alignedJsonLen + 4;
  const headerPickleSize = alignedJsonLen + 8;

  const buf = Buffer.alloc(16 + alignedJsonLen, 0);
  buf.writeUInt32LE(4, 0);
  buf.writeUInt32LE(headerPickleSize, 4);
  buf.writeUInt32LE(headerPicklePayloadSize, 8);
  buf.writeUInt32LE(jsonByteLen, 12);
  jsonBuf.copy(buf, 16);
  return buf;
}

function normalizeRelPath(relPath) {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

function findEntry(header, relPath) {
  const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur || !cur.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      return null;
    }
    cur = cur.files[part];
  }
  return cur;
}

/**
 * Reads a packed file from an ASAR archive into a Buffer.
 * Returns null if the path does not exist or is a directory/unpacked entry.
 * @param {string} asarPath
 * @param {string} relPath
 * @returns {Buffer | null}
 */
function readAsarFile(asarPath, relPath) {
  const { header, payloadOffset } = readAsarHeader(asarPath);
  const entry = findEntry(header, relPath);
  if (!entry || entry.files || entry.unpacked || entry.link !== undefined) {
    return null;
  }
  const size = Number(entry.size || 0);
  const offset = Number(entry.offset || 0);
  const buf = Buffer.alloc(size);
  if (size === 0) {
    return buf;
  }
  const fd = fs.openSync(asarPath, 'r');
  try {
    let totalRead = 0;
    while (totalRead < size) {
      const n = fs.readSync(fd, buf, totalRead, size - totalRead, payloadOffset + offset + totalRead);
      if (n <= 0) {
        throw new Error(`Unexpected EOF reading ${relPath} from ${asarPath}`);
      }
      totalRead += n;
    }
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Lists all file entries in an ASAR archive.
 * @param {string} asarPath
 */
function listAsarFiles(asarPath) {
  const { header } = readAsarHeader(asarPath);
  const out = [];
  function walk(node, prefix) {
    if (!node || !node.files) {
      return;
    }
    for (const key of Object.keys(node.files)) {
      const child = node.files[key];
      const nextPath = prefix ? `${prefix}/${key}` : key;
      if (child.files) {
        walk(child, nextPath);
      } else {
        out.push({
          path: nextPath,
          size: Number(child.size || 0),
          unpacked: Boolean(child.unpacked),
          executable: Boolean(child.executable),
          link: child.link,
          offset: child.offset !== undefined ? Number(child.offset) : null,
        });
      }
    }
  }
  walk(header, '');
  return out;
}

/**
 * Computes ASAR SHA-256 integrity metadata (4 MiB blocks).
 * @param {Buffer} buf
 */
function computeIntegrity(buf) {
  const fullHash = crypto.createHash('sha256').update(buf).digest('hex');
  const blocks = [];
  if (buf.length === 0) {
    blocks.push(fullHash);
  } else {
    for (let start = 0; start < buf.length; start += BLOCK_SIZE) {
      const slice = buf.subarray(start, Math.min(start + BLOCK_SIZE, buf.length));
      blocks.push(crypto.createHash('sha256').update(slice).digest('hex'));
    }
  }
  return {
    algorithm: 'SHA256',
    hash: fullHash,
    blockSize: BLOCK_SIZE,
    blocks,
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function setEntry(header, relPath, entryValue) {
  const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
  if (parts.length === 0) {
    throw new Error('Cannot set empty ASAR path');
  }
  let cur = header;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cur.files) {
      cur.files = {};
    }
    if (!cur.files[part] || !cur.files[part].files) {
      cur.files[part] = { files: {} };
    }
    cur = cur.files[part];
  }
  if (!cur.files) {
    cur.files = {};
  }
  cur.files[parts[parts.length - 1]] = entryValue;
}

function deleteEntry(header, relPath) {
  const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  let cur = header;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!cur || !cur.files || !cur.files[part]) {
      return;
    }
    cur = cur.files[part];
  }
  if (cur && cur.files) {
    delete cur.files[parts[parts.length - 1]];
  }
}

/**
 * Surgically patches an ASAR archive with upserted/deleted files and writes atomically.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {{ upsertFiles?: Map<string, Buffer | { buffer: Buffer, executable?: boolean }>, deleteFiles?: Set<string> }} options
 */
function patchAsar(inputPath, outputPath, options = {}) {
  const upsertFilesRaw = options.upsertFiles || new Map();
  const deleteFilesRaw = options.deleteFiles || new Set();

  const upserts = new Map();
  for (const [k, v] of upsertFilesRaw.entries()) {
    const norm = normalizeRelPath(k);
    if (Buffer.isBuffer(v)) {
      upserts.set(norm, { buffer: v });
    } else if (v && Buffer.isBuffer(v.buffer)) {
      upserts.set(norm, { buffer: v.buffer, executable: v.executable });
    } else {
      throw new Error(`Invalid upsert value for ${k}: expected Buffer`);
    }
  }

  const deletes = new Set();
  for (const k of deleteFilesRaw) {
    deletes.add(normalizeRelPath(k));
  }

  const { header: origHeader, payloadOffset: origPayloadOffset } = readAsarHeader(inputPath);
  const newHeader = deepClone(origHeader);

  for (const delPath of deletes) {
    deleteEntry(newHeader, delPath);
  }

  for (const [upPath, spec] of upserts.entries()) {
    const existing = findEntry(origHeader, upPath);
    const entry = {
      size: spec.buffer.length,
      offset: '0',
      integrity: computeIntegrity(spec.buffer),
    };
    const isExec = spec.executable !== undefined ? spec.executable : Boolean(existing && existing.executable);
    if (isExec) {
      entry.executable = true;
    }
    setEntry(newHeader, upPath, entry);
  }

  // Collect all packed files in deterministic traversal order and assign new offsets.
  const writePlan = [];
  let nextOffset = 0;

  function assignOffsets(node, prefix) {
    if (!node || !node.files) {
      return;
    }
    for (const key of Object.keys(node.files)) {
      const child = node.files[key];
      const rel = prefix ? `${prefix}/${key}` : key;
      if (child.files) {
        assignOffsets(child, rel);
      } else if (child.unpacked || child.link !== undefined) {
        delete child.offset;
      } else if (upserts.has(rel)) {
        const buf = upserts.get(rel).buffer;
        child.size = buf.length;
        child.offset = String(nextOffset);
        writePlan.push({ kind: 'buffer', buffer: buf, size: buf.length });
        nextOffset += buf.length;
      } else {
        const origEntry = findEntry(origHeader, rel);
        if (!origEntry || origEntry.unpacked || origEntry.link !== undefined) {
          throw new Error(`Missing original packed entry for ${rel}`);
        }
        const size = Number(origEntry.size || 0);
        const origOffset = Number(origEntry.offset || 0);
        child.size = size;
        child.offset = String(nextOffset);
        writePlan.push({ kind: 'copy', origOffset, size });
        nextOffset += size;
      }
    }
  }

  assignOffsets(newHeader, '');

  const headerBuffer = buildAsarHeaderBuffer(newHeader);
  const outDir = path.dirname(outputPath);
  fs.mkdirSync(outDir, { recursive: true });
  const tmpPath = path.join(outDir, `${path.basename(outputPath)}.tmp-${process.pid}-${Date.now()}`);

  let inFd = null;
  let outFd = null;
  try {
    inFd = fs.openSync(inputPath, 'r');
    outFd = fs.openSync(tmpPath, 'w');

    writeAllSync(outFd, headerBuffer);

    const copyChunk = Buffer.alloc(1024 * 1024);
    for (const item of writePlan) {
      if (item.kind === 'buffer') {
        if (item.buffer.length > 0) {
          writeAllSync(outFd, item.buffer);
        }
      } else {
        let remaining = item.size;
        let readPos = origPayloadOffset + item.origOffset;
        while (remaining > 0) {
          const toRead = Math.min(remaining, copyChunk.length);
          const n = fs.readSync(inFd, copyChunk, 0, toRead, readPos);
          if (n <= 0) {
            throw new Error(`Unexpected EOF copying slice at ${readPos} from ${inputPath}`);
          }
          writeAllSync(outFd, copyChunk.subarray(0, n));
          remaining -= n;
          readPos += n;
        }
      }
    }

    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = null;
    fs.closeSync(inFd);
    inFd = null;

    fs.renameSync(tmpPath, outputPath);
  } catch (err) {
    if (outFd !== null) {
      try {
        fs.closeSync(outFd);
      } catch {
        // ignore
      }
    }
    if (inFd !== null) {
      try {
        fs.closeSync(inFd);
      } catch {
        // ignore
      }
    }
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore
    }
    throw err;
  }
}

function writeAllSync(fd, buf) {
  let offset = 0;
  while (offset < buf.length) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (written <= 0) {
      throw new Error('Failed to write bytes to output ASAR');
    }
    offset += written;
  }
}

/**
 * Computes SHA-256 hex digest of a file.
 * @param {string} filePath
 */
function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) {
        break;
      }
      hash.update(buf.subarray(0, n));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  BLOCK_SIZE,
  readAsarHeader,
  buildAsarHeaderBuffer,
  readAsarFile,
  listAsarFiles,
  computeIntegrity,
  patchAsar,
  sha256File,
};
