'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { readAsarHeader, readAsarFile, patchAsar, sha256File } = require('./asar');
const {
  ensureUserDataDir,
  loadBaseDictionary,
  pruneTranslatedFromUntranslated,
  readJsonSafe,
  validateDictionary,
  writeJsonAtomic,
} = require('./dictionary');
const { PACKAGE_ROOT, getUserDataFiles, resolveAntigravityPaths } = require('./paths');
const { PRELOAD_END_MARKER, PRELOAD_START_MARKER, buildPreloadSnippet } = require('./runtime/preloadBuilder');

const MAIN_START_MARKER = '// === ANTIGRAVITY-JA-MAIN-START ===';
const MAIN_END_MARKER = '// === ANTIGRAVITY-JA-MAIN-END ===';

function isAntigravityRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return /Antigravity\.exe/i.test(out);
    }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const out = execFileSync('pgrep', ['-f', 'Antigravity'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return Boolean(out.trim());
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Strips a previously injected fenced marker block cleanly.
 * @param {string} source
 * @param {string} startMarker
 * @param {string} endMarker
 */
function stripMarkerBlock(source, startMarker, endMarker) {
  let out = String(source || '');
  while (true) {
    const startIdx = out.indexOf(startMarker);
    if (startIdx < 0) {
      break;
    }
    const endIdx = out.indexOf(endMarker, startIdx + startMarker.length);
    if (endIdx < 0) {
      out = out.slice(0, startIdx);
      break;
    }
    const afterEnd = endIdx + endMarker.length;
    const before = out.slice(0, startIdx).replace(/[\r\n]+$/, '');
    const after = out.slice(afterEnd).replace(/^[\r\n]+/, '');
    if (before && after) {
      out = `${before}\n${after}`;
    } else {
      out = before || after;
    }
  }
  return out;
}

function copyFileAtomic(src, dest) {
  const dir = path.dirname(dest);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(dest)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Inspects installation, patch status, backup validity, and dictionary statistics.
 * @param {{ installDir?: string, userDataDir?: string }} [options]
 */
function getStatus(options = {}) {
  const paths = resolveAntigravityPaths(options.installDir);
  const userFiles = getUserDataFiles(options.userDataDir);
  const installed = fs.existsSync(paths.asarPath);

  let appVersion = null;
  let patched = false;
  if (installed) {
    try {
      const pkgBuf = readAsarFile(paths.asarPath, 'package.json');
      if (pkgBuf) {
        const pkg = JSON.parse(pkgBuf.toString('utf8'));
        appVersion = pkg.version || null;
      }
      const mainBuf = readAsarFile(paths.asarPath, 'dist/main.js');
      const preloadBuf = readAsarFile(paths.asarPath, 'dist/preload.js');
      const jaMainBuf = readAsarFile(paths.asarPath, 'dist/jaI18nMain.js');
      const jaAutoBuf = readAsarFile(paths.asarPath, 'dist/jaAutoTranslator.js');
      patched = Boolean(
        mainBuf &&
          preloadBuf &&
          jaMainBuf &&
          jaAutoBuf &&
          mainBuf.toString('utf8').includes(MAIN_START_MARKER) &&
          preloadBuf.toString('utf8').includes(PRELOAD_START_MARKER)
      );
    } catch {
      // ignore read errors
    }
  }

  const backupExists = fs.existsSync(paths.backupPath);
  const meta = readJsonSafe(paths.metaPath, null);
  let backupValid = false;
  if (backupExists) {
    try {
      readAsarHeader(paths.backupPath);
      if (meta && meta.originalSha256) {
        backupValid = sha256File(paths.backupPath) === meta.originalSha256;
      } else {
        backupValid = true;
      }
    } catch {
      backupValid = false;
    }
  }

  const baseDict = fs.existsSync(userFiles.baseDictPath)
    ? readJsonSafe(userFiles.baseDictPath, loadBaseDictionary())
    : loadBaseDictionary();
  const autoDict = readJsonSafe(userFiles.autoDictPath, { exact: {} });
  const customDict = readJsonSafe(userFiles.customDictPath, { exact: {}, patterns: [], ignored: [] });
  const validation = validateDictionary(baseDict, customDict);
  const untranslated = readJsonSafe(userFiles.untranslatedPath, { items: {} });
  const untranslatedCount =
    untranslated && untranslated.items && typeof untranslated.items === 'object'
      ? Object.keys(untranslated.items).length
      : 0;

  return {
    installed,
    installDir: paths.installDir,
    asarPath: paths.asarPath,
    backupPath: paths.backupPath,
    appVersion,
    patched,
    backupExists,
    backupValid,
    antigravityRunning: isAntigravityRunning(),
    userDataDir: userFiles.dir,
    dictionaryStats: {
      ...validation.stats,
      autoExactCount:
        autoDict && autoDict.exact && typeof autoDict.exact === 'object' ? Object.keys(autoDict.exact).length : 0,
      customExactCount:
        customDict && customDict.exact && typeof customDict.exact === 'object' ? Object.keys(customDict.exact).length : 0,
      customPatternCount: Array.isArray(customDict?.patterns) ? customDict.patterns.length : 0,
      ignoredCount: Array.isArray(customDict?.ignored) ? customDict.ignored.length : 0,
    },
    untranslatedCount,
  };
}

/**
 * Applies the reversible Japanese UI patch to app.asar.
 * @param {{ installDir?: string, userDataDir?: string, skipRunningCheck?: boolean }} [options]
 */
function applyPatch(options = {}) {
  const paths = resolveAntigravityPaths(options.installDir);
  if (!fs.existsSync(paths.asarPath)) {
    throw new Error(`Antigravity の app.asar が見つかりません: ${paths.asarPath}`);
  }
  if (!options.skipRunningCheck && isAntigravityRunning()) {
    throw new Error(
      'Antigravity が起動中です。タスクトレイのアイコン（右クリック → Quit）を含めて完全に終了してから再実行してください。'
    );
  }

  const userFiles = ensureUserDataDir(options.userDataDir, { refreshBaseDict: true });
  try {
    pruneTranslatedFromUntranslated(options.userDataDir);
  } catch {
    // ignore non-critical prune error
  }

  const pkgBuf = readAsarFile(paths.asarPath, 'package.json');
  const mainBuf = readAsarFile(paths.asarPath, 'dist/main.js');
  const preloadBuf = readAsarFile(paths.asarPath, 'dist/preload.js');
  if (!mainBuf || !preloadBuf) {
    throw new Error('app.asar 内に dist/main.js または dist/preload.js が見つかりません。');
  }

  let appVersion = null;
  try {
    if (pkgBuf) {
      appVersion = JSON.parse(pkgBuf.toString('utf8')).version || null;
    }
  } catch {
    appVersion = null;
  }

  const rawMain = mainBuf.toString('utf8');
  const rawPreload = preloadBuf.toString('utf8');
  const toolPkg = readJsonSafe(path.join(PACKAGE_ROOT, 'package.json'), { version: '1.0.0' });
  const toolVersion = toolPkg.version || '1.0.0';

  let backupCreated = false;
  if (!rawMain.includes(MAIN_START_MARKER)) {
    const originalSha256 = sha256File(paths.asarPath);
    copyFileAtomic(paths.asarPath, paths.backupPath);
    writeJsonAtomic(paths.metaPath, {
      appVersion,
      originalSha256,
      patchedAt: new Date().toISOString(),
      toolVersion,
    });
    backupCreated = true;
  } else if (fs.existsSync(paths.metaPath)) {
    const existingMeta = readJsonSafe(paths.metaPath, null);
    if (existingMeta && existingMeta.originalSha256) {
      writeJsonAtomic(paths.metaPath, {
        appVersion: existingMeta.appVersion ?? appVersion,
        originalSha256: existingMeta.originalSha256,
        patchedAt: new Date().toISOString(),
        toolVersion,
      });
    }
  }

  const cleanMain = stripMarkerBlock(rawMain, MAIN_START_MARKER, MAIN_END_MARKER).replace(/\s+$/, '');
  const cleanPreload = stripMarkerBlock(rawPreload, PRELOAD_START_MARKER, PRELOAD_END_MARKER).replace(/\s+$/, '');

  const mainHook = [
    MAIN_START_MARKER,
    "try { require('./jaI18nMain').initJaI18n(); } catch {}",
    MAIN_END_MARKER,
  ].join('\n');

  const nextMain = `${cleanMain}\n\n${mainHook}\n`;
  const nextPreload = `${cleanPreload}\n\n${buildPreloadSnippet()}\n`;
  const jaMainPath = path.join(__dirname, 'runtime', 'jaI18nMain.js');
  const jaMainBuf = fs.readFileSync(jaMainPath);
  const jaMainSrc = jaMainBuf.toString('utf8');
  const jaAutoPath = path.join(__dirname, 'runtime', 'autoTranslator.js');
  const jaAutoBuf = fs.readFileSync(jaAutoPath);
  const jaAutoSrc = jaAutoBuf.toString('utf8');

  // Verify JS syntax for all modified/added scripts before writing app.asar.
  new vm.Script(nextMain, { filename: 'dist/main.js' });
  new vm.Script(nextPreload, { filename: 'dist/preload.js' });
  new vm.Script(jaMainSrc, { filename: 'dist/jaI18nMain.js' });
  new vm.Script(jaAutoSrc, { filename: 'dist/jaAutoTranslator.js' });

  const upserts = new Map([
    ['dist/main.js', Buffer.from(nextMain, 'utf8')],
    ['dist/preload.js', Buffer.from(nextPreload, 'utf8')],
    ['dist/jaI18nMain.js', jaMainBuf],
    ['dist/jaAutoTranslator.js', jaAutoBuf],
  ]);

  patchAsar(paths.asarPath, paths.asarPath, { upsertFiles: upserts });

  return {
    appVersion,
    asarPath: paths.asarPath,
    backupPath: paths.backupPath,
    userDataDir: userFiles.dir,
    backupCreated,
  };
}

/**
 * Restores the original unpatched app.asar from backup.
 * @param {{ installDir?: string, skipRunningCheck?: boolean }} [options]
 */
function restorePatch(options = {}) {
  const paths = resolveAntigravityPaths(options.installDir);
  if (!fs.existsSync(paths.backupPath)) {
    throw new Error(`バックアップが見つかりません: ${paths.backupPath}`);
  }
  if (!options.skipRunningCheck && isAntigravityRunning()) {
    throw new Error(
      'Antigravity が起動中です。タスクトレイのアイコン（右クリック → Quit）を含めて完全に終了してから再実行してください。'
    );
  }

  readAsarHeader(paths.backupPath);
  const meta = readJsonSafe(paths.metaPath, null);
  if (meta && meta.originalSha256) {
    const actualSha = sha256File(paths.backupPath);
    if (actualSha !== meta.originalSha256) {
      throw new Error(
        `バックアップの SHA-256 が一致しません (expected ${meta.originalSha256}, actual ${actualSha})。復元を中止しました。`
      );
    }
  }

  copyFileAtomic(paths.backupPath, paths.asarPath);
  try {
    fs.unlinkSync(paths.backupPath);
  } catch {
    // ignore
  }
  try {
    if (fs.existsSync(paths.metaPath)) {
      fs.unlinkSync(paths.metaPath);
    }
  } catch {
    // ignore
  }

  return {
    restored: true,
    asarPath: paths.asarPath,
  };
}

module.exports = {
  MAIN_START_MARKER,
  MAIN_END_MARKER,
  isAntigravityRunning,
  stripMarkerBlock,
  getStatus,
  applyPatch,
  restorePatch,
};
