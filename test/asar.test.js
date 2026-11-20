'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BLOCK_SIZE,
  buildAsarHeaderBuffer,
  computeIntegrity,
  listAsarFiles,
  patchAsar,
  readAsarFile,
  readAsarHeader,
  sha256File,
} = require('../src/asar');
const { resolveAntigravityPaths } = require('../src/paths');

function createSyntheticAsar(filePath, jsonPaddingTargetMod) {
  const binBuf = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x89, 0x50, 0x4e, 0x47]);
  const textName = 'hello' + 'x'.repeat(jsonPaddingTargetMod) + '.txt';
  const textBuf = Buffer.from('original-content-' + jsonPaddingTargetMod, 'utf8');

  const header = {
    files: {
      [textName]: {
        size: textBuf.length,
        offset: '0',
        integrity: computeIntegrity(textBuf),
      },
      'bin.dat': {
        size: binBuf.length,
        offset: String(textBuf.length),
        integrity: computeIntegrity(binBuf),
        executable: true,
      },
      unpackedDir: {
        files: {
          'native.node': {
            size: 42,
            unpacked: true,
            integrity: computeIntegrity(Buffer.from('dummy')),
          },
        },
      },
    },
  };

  // Adjust filename length until JSON byte length % 4 === jsonPaddingTargetMod
  let curHeader = header;
  let jsonLen = Buffer.byteLength(JSON.stringify(curHeader), 'utf8');
  if (jsonLen % 4 !== jsonPaddingTargetMod) {
    const delta = (jsonPaddingTargetMod - (jsonLen % 4) + 4) % 4;
    const adjustedName = 'a'.repeat(delta) + textName;
    curHeader = {
      files: {
        [adjustedName]: header.files[textName],
        'bin.dat': header.files['bin.dat'],
        unpackedDir: header.files.unpackedDir,
      },
    };
  }

  const hdrBuf = buildAsarHeaderBuffer(curHeader);
  const full = Buffer.concat([hdrBuf, textBuf, binBuf]);
  fs.writeFileSync(filePath, full);
  return { textName: Object.keys(curHeader.files)[0], textBuf, binBuf, header: curHeader };
}

test('Chromium Pickle 4-byte alignment across all jsonLen mod 4 remainders', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-mod-'));
  try {
    for (const mod of [0, 1, 2, 3]) {
      const asarPath = path.join(tmpDir, `mod-${mod}.asar`);
      const { textName, textBuf, binBuf } = createSyntheticAsar(asarPath, mod);

      const { jsonByteLen, payloadOffset } = readAsarHeader(asarPath);
      assert.equal(jsonByteLen % 4, mod);
      assert.equal(payloadOffset % 4, 0);

      assert.deepEqual(readAsarFile(asarPath, textName), textBuf);
      assert.deepEqual(readAsarFile(asarPath, 'bin.dat'), binBuf);
      assert.equal(readAsarFile(asarPath, 'unpackedDir/native.node'), null);

      const outPath = path.join(tmpDir, `patched-${mod}.asar`);
      const newBuf = Buffer.from('updated-' + mod, 'utf8');
      patchAsar(asarPath, outPath, {
        upsertFiles: new Map([
          [textName, newBuf],
          ['nested/new.js', Buffer.from('console.log(1);\n', 'utf8')],
        ]),
      });

      assert.deepEqual(readAsarFile(outPath, textName), newBuf);
      assert.deepEqual(readAsarFile(outPath, 'bin.dat'), binBuf);
      assert.equal(readAsarFile(outPath, 'nested/new.js').toString('utf8'), 'console.log(1);\n');

      const listed = listAsarFiles(outPath);
      const binEntry = listed.find((e) => e.path === 'bin.dat');
      const unpackedEntry = listed.find((e) => e.path === 'unpackedDir/native.node');
      assert.equal(binEntry.executable, true);
      assert.equal(unpackedEntry.unpacked, true);
      assert.equal(unpackedEntry.offset, null);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('computeIntegrity splits 4 MiB blocks accurately', () => {
  const empty = computeIntegrity(Buffer.alloc(0));
  assert.equal(empty.blocks.length, 1);
  assert.equal(empty.hash, crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));

  const multi = Buffer.alloc(BLOCK_SIZE + 17, 0x41);
  const res = computeIntegrity(multi);
  assert.equal(res.blocks.length, 2);
  assert.equal(res.blockSize, BLOCK_SIZE);
  assert.equal(res.blocks[0], crypto.createHash('sha256').update(multi.subarray(0, BLOCK_SIZE)).digest('hex'));
  assert.equal(res.blocks[1], crypto.createHash('sha256').update(multi.subarray(BLOCK_SIZE)).digest('hex'));
});

test('Reads real installed Antigravity app.asar read-only and verifies integrity', (t) => {
  const paths = resolveAntigravityPaths();
  if (!fs.existsSync(paths.asarPath)) {
    t.skip('Installed Antigravity app.asar not found');
    return;
  }

  const { header } = readAsarHeader(paths.asarPath);
  assert.ok(header && header.files);

  const pkgBuf = readAsarFile(paths.asarPath, 'package.json');
  assert.ok(pkgBuf);
  const pkg = JSON.parse(pkgBuf.toString('utf8'));
  assert.equal(pkg.name, 'antigravity');

  const mainBuf = readAsarFile(paths.asarPath, 'dist/main.js');
  const preloadBuf = readAsarFile(paths.asarPath, 'dist/preload.js');
  assert.ok(mainBuf && mainBuf.length > 1000);
  assert.ok(preloadBuf && preloadBuf.length > 1000);

  const pkgIntegrity = computeIntegrity(pkgBuf);
  assert.deepEqual(pkgIntegrity, header.files['package.json'].integrity);
  assert.ok(sha256File(paths.asarPath).length === 64);
});
