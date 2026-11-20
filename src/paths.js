'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function getDefaultInstallCandidates() {
  const candidates = [];
  if (process.env.ANTIGRAVITY_APP_DIR) {
    candidates.push(process.env.ANTIGRAVITY_APP_DIR);
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Programs', 'antigravity'));
    candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity'));
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Antigravity.app/Contents');
    candidates.push(path.join(os.homedir(), 'Applications', 'Antigravity.app', 'Contents'));
  } else {
    candidates.push('/opt/Antigravity');
    candidates.push('/usr/lib/antigravity');
    candidates.push(path.join(os.homedir(), '.local', 'share', 'antigravity'));
  }
  return candidates;
}

/**
 * Resolves Antigravity App installation and ASAR backup paths.
 * @param {string} [overrideDir]
 */
function resolveAntigravityPaths(overrideDir) {
  let installDir = overrideDir ? path.resolve(overrideDir) : '';
  if (!installDir) {
    const candidates = getDefaultInstallCandidates();
    for (const candidate of candidates) {
      const asarCandidate = path.join(candidate, 'resources', 'app.asar');
      if (fs.existsSync(asarCandidate)) {
        installDir = candidate;
        break;
      }
    }
    if (!installDir) {
      installDir = candidates[0] || '';
    }
  }

  const resourcesDir = path.join(installDir, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const backupPath = path.join(resourcesDir, 'app.asar.ja-backup');
  const metaPath = path.join(resourcesDir, 'app.asar.ja-meta.json');
  const exePath =
    process.platform === 'win32'
      ? path.join(installDir, 'Antigravity.exe')
      : process.platform === 'darwin'
        ? path.join(installDir, 'MacOS', 'Antigravity')
        : path.join(installDir, 'antigravity');

  return {
    installDir,
    resourcesDir,
    asarPath,
    backupPath,
    metaPath,
    exePath,
  };
}

/**
 * Returns the external user dictionary & config directory (~/.antigravity-ja).
 * @param {string} [overrideDir]
 */
function getUserDataDir(overrideDir) {
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  if (process.env.ANTIGRAVITY_JA_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_JA_DIR);
  }
  return path.join(os.homedir(), '.antigravity-ja');
}

/**
 * Returns all file paths inside the user data directory.
 * @param {string} [overrideDir]
 */
function getUserDataFiles(overrideDir) {
  const dir = getUserDataDir(overrideDir);
  return {
    dir,
    configPath: path.join(dir, 'config.json'),
    baseDictPath: path.join(dir, 'dictionary.json'),
    customDictPath: path.join(dir, 'custom.json'),
    untranslatedPath: path.join(dir, 'untranslated.json'),
  };
}

/**
 * Returns paths to the bundled dictionary and glossary files.
 */
function getBundledDictionaryPaths() {
  return {
    baseDictPath: path.join(PACKAGE_ROOT, 'dictionaries', 'ja-base.json'),
    glossaryPath: path.join(PACKAGE_ROOT, 'dictionaries', 'glossary.json'),
  };
}

module.exports = {
  PACKAGE_ROOT,
  getDefaultInstallCandidates,
  resolveAntigravityPaths,
  getUserDataDir,
  getUserDataFiles,
  getBundledDictionaryPaths,
};
