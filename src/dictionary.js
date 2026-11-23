'use strict';

const fs = require('fs');
const path = require('path');
const { getBundledDictionaryPaths, getUserDataFiles } = require('./paths');
const {
  compileBundle,
  normalizeLookupKey,
  shouldCollectCandidate,
  translateText,
} = require('./runtime/translatorCore');

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
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

function loadBaseDictionary(filePath) {
  const target = filePath || getBundledDictionaryPaths().baseDictPath;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function loadGlossary(filePath) {
  const target = filePath || getBundledDictionaryPaths().glossaryPath;
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

/**
 * Flattens categories.<id>.exact and optional top-level exact into a single map.
 * @param {object} baseDict
 * @returns {Record<string, string>}
 */
function flattenExactMap(baseDict) {
  const merged = {};
  if (!baseDict || typeof baseDict !== 'object') {
    return merged;
  }
  if (baseDict.categories && typeof baseDict.categories === 'object') {
    for (const cat of Object.values(baseDict.categories)) {
      if (cat && cat.exact && typeof cat.exact === 'object') {
        for (const [k, v] of Object.entries(cat.exact)) {
          if (typeof k === 'string' && typeof v === 'string') {
            merged[k] = v;
          }
        }
      }
    }
  }
  if (baseDict.exact && typeof baseDict.exact === 'object') {
    for (const [k, v] of Object.entries(baseDict.exact)) {
      if (typeof k === 'string' && typeof v === 'string') {
        merged[k] = v;
      }
    }
  }
  return merged;
}

/**
 * Ensures ~/.antigravity-ja exists and initializes missing files.
 * Never overwrites existing config.json, custom.json, or untranslated.json.
 * @param {string} [userDataDir]
 * @param {{ refreshBaseDict?: boolean }} [options]
 */
function ensureUserDataDir(userDataDir, options = {}) {
  const files = getUserDataFiles(userDataDir);
  const bundled = getBundledDictionaryPaths();
  const refreshBaseDict = options.refreshBaseDict !== false;

  fs.mkdirSync(files.dir, { recursive: true });

  if (refreshBaseDict || !fs.existsSync(files.baseDictPath)) {
    const baseRaw = fs.readFileSync(bundled.baseDictPath, 'utf8');
    const dir = path.dirname(files.baseDictPath);
    const tmp = path.join(dir, `dictionary.json.tmp-${process.pid}-${Date.now()}`);
    fs.writeFileSync(tmp, baseRaw, 'utf8');
    fs.renameSync(tmp, files.baseDictPath);
  }

  if (!fs.existsSync(files.configPath)) {
    writeJsonAtomic(files.configPath, {
      enabled: true,
      collectUntranslated: false,
      autoCollectTooltips: true,
      japaneseTypography: true,
      autoTranslate: true,
      autoTranslateProvider: 'free',
      autoTranslateApiKey: '',
      autoTranslateModel: '',
      autoTranslateEndpoint: '',
    });
  }

  if (!fs.existsSync(files.autoDictPath)) {
    writeJsonAtomic(files.autoDictPath, {
      exact: {},
      meta: {},
    });
  }

  if (!fs.existsSync(files.customDictPath)) {
    writeJsonAtomic(files.customDictPath, {
      exact: {},
      patterns: [],
      ignored: [],
    });
  }

  if (!fs.existsSync(files.untranslatedPath)) {
    writeJsonAtomic(files.untranslatedPath, {
      items: {},
    });
  }

  return files;
}

/**
 * Loads config + base dictionary + custom overrides as a single merged bundle.
 * @param {string} [userDataDir]
 */
function loadMergedBundle(userDataDir) {
  const files = getUserDataFiles(userDataDir);
  const bundled = getBundledDictionaryPaths();

  const config = readJsonSafe(files.configPath, {
    enabled: true,
    collectUntranslated: false,
    autoCollectTooltips: true,
    japaneseTypography: true,
    autoTranslate: true,
  });

  const baseDict =
    readJsonSafe(files.baseDictPath, null) || readJsonSafe(bundled.baseDictPath, { categories: {}, patterns: [] });

  const autoDict = readJsonSafe(files.autoDictPath, {
    exact: {},
    meta: {},
  });

  const customDict = readJsonSafe(files.customDictPath, {
    exact: {},
    patterns: [],
    ignored: [],
  });

  const autoExact =
    autoDict && autoDict.exact && typeof autoDict.exact === 'object' && !Array.isArray(autoDict.exact)
      ? autoDict.exact
      : {};
  const baseExact = flattenExactMap(baseDict);
  const customExact =
    customDict && customDict.exact && typeof customDict.exact === 'object' && !Array.isArray(customDict.exact)
      ? customDict.exact
      : {};

  // Priority: custom.json (highest) > dictionary.json (curated base) > auto.json
  const exact = {};
  for (const [k, v] of Object.entries(autoExact)) {
    if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
      exact[k] = v;
    }
  }
  for (const [k, v] of Object.entries(baseExact)) {
    if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
      exact[k] = v;
    }
  }
  for (const [k, v] of Object.entries(customExact)) {
    if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
      exact[k] = v;
    }
  }

  const customPatterns = Array.isArray(customDict?.patterns) ? customDict.patterns : [];
  const basePatterns = Array.isArray(baseDict?.patterns) ? baseDict.patterns : [];

  const ignored = Array.isArray(customDict?.ignored)
    ? customDict.ignored.filter((x) => typeof x === 'string' && x.length > 0)
    : [];

  return {
    enabled: config?.enabled !== false,
    collectUntranslated: Boolean(config?.collectUntranslated),
    autoCollectTooltips: config?.autoCollectTooltips !== false,
    japaneseTypography: config?.japaneseTypography !== false,
    autoTranslate: config?.autoTranslate !== false,
    exact,
    patterns: [...customPatterns, ...basePatterns],
    ignored,
  };
}

function validatePatternList(patterns, label, errors) {
  if (patterns === undefined) {
    return 0;
  }
  if (!Array.isArray(patterns)) {
    errors.push(`${label}.patterns must be an array`);
    return 0;
  }
  let validCount = 0;
  const seenSignatures = new Set();
  patterns.forEach((p, idx) => {
    if (!p || typeof p !== 'object') {
      errors.push(`${label}.patterns[${idx}] must be an object`);
      return;
    }
    if (typeof p.pattern !== 'string' || p.pattern.length === 0) {
      errors.push(`${label}.patterns[${idx}].pattern must be a non-empty string`);
      return;
    }
    if (typeof p.replace !== 'string') {
      errors.push(`${label}.patterns[${idx}].replace must be a string`);
      return;
    }
    if (p.flags !== undefined && typeof p.flags !== 'string') {
      errors.push(`${label}.patterns[${idx}].flags must be a string`);
      return;
    }
    const sig = `${p.pattern}\u0000${p.flags || ''}`;
    if (seenSignatures.has(sig)) {
      errors.push(`${label}.patterns[${idx}] duplicate pattern "${p.pattern}"`);
      return;
    }
    seenSignatures.add(sig);
    try {
      new RegExp(p.pattern, p.flags || '');
      const probeFlags = String(p.flags || '').replace(/[gy]/g, '');
      const groupProbe = new RegExp(`(?:${p.pattern})|`, probeFlags).exec('');
      const captureCount = groupProbe ? groupProbe.length - 1 : 0;
      const strippedReplace = p.replace.replace(/\$\$/g, '');
      const refMatches = strippedReplace.matchAll(/\$(\d+)/g);
      let badRef = false;
      for (const m of refMatches) {
        const refNum = Number(m[1]);
        if (refNum < 1 || refNum > captureCount) {
          errors.push(
            `${label}.patterns[${idx}] replace references $${refNum} but pattern only has ${captureCount} capturing group(s)`
          );
          badRef = true;
        }
      }
      if (!badRef) {
        validCount++;
      }
    } catch (err) {
      errors.push(`${label}.patterns[${idx}] invalid RegExp: ${err.message}`);
    }
  });
  return validCount;
}

/**
 * Validates base and optional custom dictionaries.
 * @param {object} baseDict
 * @param {object} [customDict]
 */
function validateDictionary(baseDict, customDict) {
  const errors = [];
  let exactCount = 0;
  let patternCount = 0;
  let categoryCount = 0;

  if (!baseDict || typeof baseDict !== 'object' || Array.isArray(baseDict)) {
    errors.push('baseDict must be an object');
  } else {
    if (!baseDict.categories || typeof baseDict.categories !== 'object' || Array.isArray(baseDict.categories)) {
      errors.push('baseDict.categories must be an object');
    } else {
      const seenKeys = new Map();
      const seenNormalized = new Map();
      for (const [catId, cat] of Object.entries(baseDict.categories)) {
        categoryCount++;
        if (!cat || typeof cat !== 'object' || Array.isArray(cat)) {
          errors.push(`categories.${catId} must be an object`);
          continue;
        }
        if (!cat.exact || typeof cat.exact !== 'object' || Array.isArray(cat.exact)) {
          errors.push(`categories.${catId}.exact must be an object`);
          continue;
        }
        for (const [en, ja] of Object.entries(cat.exact)) {
          if (typeof en !== 'string' || en.trim().length === 0) {
            errors.push(`categories.${catId}.exact contains empty key`);
          }
          if (typeof ja !== 'string' || ja.trim().length === 0) {
            errors.push(`categories.${catId}.exact["${en}"] has empty translation`);
          }
          if (seenKeys.has(en)) {
            errors.push(`Duplicate key "${en}" in categories.${catId} (already in ${seenKeys.get(en)})`);
          } else {
            seenKeys.set(en, catId);
            const norm = normalizeLookupKey(en);
            if (seenNormalized.has(norm)) {
              const prev = seenNormalized.get(norm);
              errors.push(
                `Normalized duplicate key "${en}" in categories.${catId} (conflicts with "${prev.en}" in ${prev.catId})`
              );
            } else {
              seenNormalized.set(norm, { en, catId });
            }
          }
          exactCount++;
        }
      }
    }
    patternCount += validatePatternList(baseDict.patterns, 'baseDict', errors);
  }

  if (customDict !== undefined && customDict !== null) {
    if (typeof customDict !== 'object' || Array.isArray(customDict)) {
      errors.push('customDict must be an object');
    } else {
      if (customDict.exact !== undefined) {
        if (!customDict.exact || typeof customDict.exact !== 'object' || Array.isArray(customDict.exact)) {
          errors.push('customDict.exact must be an object');
        } else {
          for (const [en, ja] of Object.entries(customDict.exact)) {
            if (typeof en !== 'string' || en.trim().length === 0) {
              errors.push('customDict.exact contains empty key');
            }
            if (typeof ja !== 'string' || ja.trim().length === 0) {
              errors.push(`customDict.exact["${en}"] has empty translation`);
            }
          }
        }
      }
      patternCount += validatePatternList(customDict.patterns, 'customDict', errors);
      if (customDict.ignored !== undefined && !Array.isArray(customDict.ignored)) {
        errors.push('customDict.ignored must be an array');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    stats: {
      exactCount,
      patternCount,
      categoryCount,
    },
  };
}

/**
 * Builds an AI batch-translation prompt with glossary and UI DOM context.
 * @param {object|Array} untranslatedInput
 * @param {object} [glossary]
 */
function buildAiTranslationPrompt(untranslatedInput, glossary) {
  const g = glossary || loadGlossary();
  let entries = [];
  if (Array.isArray(untranslatedInput)) {
    entries = untranslatedInput;
  } else if (untranslatedInput && typeof untranslatedInput === 'object') {
    const map = untranslatedInput.items && typeof untranslatedInput.items === 'object'
      ? untranslatedInput.items
      : untranslatedInput;
    entries = Object.entries(map).map(([text, meta]) => ({
      text,
      ...(meta && typeof meta === 'object' ? meta : {}),
    }));
  }

  entries.sort((a, b) => (b.count || 0) - (a.count || 0) || String(a.text).localeCompare(String(b.text)));

  const lines = [];
  lines.push('あなたは日本語のモダンな開発者向けデスクトップアプリ（Antigravity App）のUIローカライズ専門家です。');
  lines.push('以下の未翻訳UIテキストを、直訳ではない自然で洗練された日本語に翻訳してください。');
  lines.push('');
  lines.push('## 翻訳ガイドライン');
  for (const rule of g.toneGuidelines || []) {
    lines.push(`- ${rule}`);
  }
  lines.push('');
  lines.push('## 用語集（表記統一）');
  for (const term of g.terms || []) {
    lines.push(`- ${term.en} → ${term.ja}${term.note ? `（${term.note}）` : ''}`);
  }
  lines.push('');
  lines.push('## 出力形式');
  lines.push('- 有効な JSON オブジェクトのみを出力してください（説明文や前置きは不要、コードブロックは ```json のみ可）。');
  lines.push('- キーは元の英語テキストを1文字も変えずそのまま使い、値に日本語訳を入れてください。');
  lines.push('- 翻訳不要な固有名詞・技術コードと思われる項目は出力から除外して構いません。');
  lines.push('');
  lines.push('## 翻訳対象テキスト一覧（UI文脈付き）');

  if (entries.length === 0) {
    lines.push('（未翻訳テキストはありません）');
  } else {
    for (const item of entries) {
      const ctxParts = [];
      if (item.tags && item.tags.length) ctxParts.push(`tag=${item.tags.join(',')}`);
      if (item.roles && item.roles.length) ctxParts.push(`role=${item.roles.join(',')}`);
      if (item.attrs && item.attrs.length) ctxParts.push(`attr=${item.attrs.join(',')}`);
      if (item.count) ctxParts.push(`count=${item.count}`);
      const ctx = ctxParts.length ? ` [${ctxParts.join(' ')}]` : '';
      lines.push(`- ${JSON.stringify(item.text)}${ctx}`);
    }
  }

  return lines.join('\n');
}

/**
 * Merges a flat `{ [en]: ja }` JSON map into custom.json and removes matched entries from untranslated.json.
 * @param {string} userDataDir
 * @param {object} jsonMap
 */
function importCustomTranslations(userDataDir, jsonMap) {
  const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });

  let rawExact = jsonMap;
  if (
    jsonMap &&
    typeof jsonMap === 'object' &&
    !Array.isArray(jsonMap) &&
    jsonMap.exact &&
    typeof jsonMap.exact === 'object' &&
    !Array.isArray(jsonMap.exact) &&
    Object.keys(jsonMap).every((k) => ['exact', 'patterns', 'ignored', 'version'].includes(k))
  ) {
    rawExact = jsonMap.exact;
  }

  if (!rawExact || typeof rawExact !== 'object' || Array.isArray(rawExact)) {
    throw new Error('インポートするJSONは { "English": "日本語" } 形式のオブジェクトである必要があります。');
  }

  const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
  if (!custom.exact || typeof custom.exact !== 'object' || Array.isArray(custom.exact)) {
    custom.exact = {};
  }
  if (!Array.isArray(custom.patterns)) {
    custom.patterns = [];
  }
  if (!Array.isArray(custom.ignored)) {
    custom.ignored = [];
  }

  let added = 0;
  let updated = 0;
  const importedKeys = [];

  for (const [k, v] of Object.entries(rawExact)) {
    if (typeof k !== 'string' || typeof v !== 'string') {
      continue;
    }
    const en = k.trim();
    const ja = v.trim();
    if (!en || !ja) {
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(custom.exact, en)) {
      if (custom.exact[en] !== ja) {
        custom.exact[en] = ja;
        updated++;
      }
    } else {
      custom.exact[en] = ja;
      added++;
    }
    importedKeys.push(en);
  }

  if (jsonMap && rawExact !== jsonMap && Array.isArray(jsonMap.patterns)) {
    const existingSig = new Set(custom.patterns.map((p) => `${p.pattern}\u0000${p.flags || ''}`));
    for (const p of jsonMap.patterns) {
      if (p && typeof p.pattern === 'string' && typeof p.replace === 'string') {
        new RegExp(p.pattern, p.flags || '');
        const sig = `${p.pattern}\u0000${p.flags || ''}`;
        if (!existingSig.has(sig)) {
          custom.patterns.push({
            pattern: p.pattern,
            flags: p.flags || '',
            replace: p.replace,
            description: p.description || '',
          });
          existingSig.add(sig);
        }
      }
    }
  }

  if (jsonMap && rawExact !== jsonMap && Array.isArray(jsonMap.ignored)) {
    const existingIgnored = new Set(custom.ignored);
    for (const item of jsonMap.ignored) {
      if (typeof item === 'string') {
        const trimmed = item.trim();
        if (trimmed && !existingIgnored.has(trimmed)) {
          custom.ignored.push(trimmed);
          existingIgnored.add(trimmed);
          importedKeys.push(trimmed);
        }
      }
    }
  }

  writeJsonAtomic(files.customDictPath, custom);

  // Clean up any auto.json entries superseded by custom.json / ignored
  if (fs.existsSync(files.autoDictPath) && importedKeys.length > 0) {
    const autoDict = readJsonSafe(files.autoDictPath, { exact: {}, meta: {} });
    if (autoDict && autoDict.exact && typeof autoDict.exact === 'object') {
      let autoChanged = false;
      for (const k of importedKeys) {
        if (Object.prototype.hasOwnProperty.call(autoDict.exact, k)) {
          delete autoDict.exact[k];
          if (autoDict.meta && Object.prototype.hasOwnProperty.call(autoDict.meta, k)) {
            delete autoDict.meta[k];
          }
          autoChanged = true;
        }
      }
      if (autoChanged) {
        writeJsonAtomic(files.autoDictPath, autoDict);
      }
    }
  }

  let removedFromUntranslated = 0;
  const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
  if (untranslated && untranslated.items && typeof untranslated.items === 'object') {
    for (const k of importedKeys) {
      if (Object.prototype.hasOwnProperty.call(untranslated.items, k)) {
        delete untranslated.items[k];
        removedFromUntranslated++;
      }
    }
    if (removedFromUntranslated > 0) {
      writeJsonAtomic(files.untranslatedPath, untranslated);
    }
  }

  return {
    added,
    updated,
    removedFromUntranslated,
  };
}

/**
 * Filters raw untranslated items map, keeping only entries that are still untranslated
 * and still pass candidate collection heuristics under the compiled merged bundle.
 * @param {Record<string, any>} items
 * @param {ReturnType<typeof compileBundle>} compiled
 * @returns {{ filtered: Record<string, any>, removed: number, remaining: number }}
 */
function filterPendingUntranslatedItems(items, compiled) {
  const filtered = {};
  let removed = 0;
  let remaining = 0;
  if (!items || typeof items !== 'object') {
    return { filtered, removed, remaining };
  }
  for (const [key, meta] of Object.entries(items)) {
    const norm = normalizeLookupKey(key);
    const metaHint = {
      tagName: Array.isArray(meta?.tags) ? meta.tags[0] : '',
      role: Array.isArray(meta?.roles) ? meta.roles[0] : '',
      attr: Array.isArray(meta?.attrs) ? meta.attrs[0] : '',
      inTooltip: Boolean(meta?.inTooltip),
    };
    const isIgnored = compiled.ignoredSet.has(key) || compiled.ignoredSet.has(norm);
    const isTranslated = translateText(key, compiled).changed;
    const isCandidate = shouldCollectCandidate(key, metaHint, compiled);
    if (isIgnored || isTranslated || !isCandidate) {
      removed++;
    } else {
      filtered[key] = meta;
      remaining++;
    }
  }
  return { filtered, removed, remaining };
}

/**
 * Removes entries from auto.json superseded by base/custom dictionaries, and removes
 * entries from untranslated.json that are already translated, ignored, or filtered noise.
 * @param {string} [userDataDir]
 */
function pruneTranslatedFromUntranslated(userDataDir) {
  const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
  const bundled = getBundledDictionaryPaths();

  if (fs.existsSync(files.autoDictPath)) {
    const autoDict = readJsonSafe(files.autoDictPath, { exact: {}, meta: {} });
    const baseDict =
      readJsonSafe(files.baseDictPath, null) || readJsonSafe(bundled.baseDictPath, { categories: {}, patterns: [] });
    const customDict = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
    const nonAutoBundle = compileBundle({
      exact: {
        ...flattenExactMap(baseDict),
        ...(customDict && customDict.exact && typeof customDict.exact === 'object' ? customDict.exact : {}),
      },
      patterns: [
        ...(Array.isArray(customDict?.patterns) ? customDict.patterns : []),
        ...(Array.isArray(baseDict?.patterns) ? baseDict.patterns : []),
      ],
      ignored: Array.isArray(customDict?.ignored) ? customDict.ignored : [],
    });
    if (autoDict && autoDict.exact && typeof autoDict.exact === 'object') {
      let autoChanged = false;
      for (const key of Object.keys(autoDict.exact)) {
        const norm = normalizeLookupKey(key);
        if (
          nonAutoBundle.exactMap.has(key) ||
          nonAutoBundle.exactMap.has(norm) ||
          nonAutoBundle.ignoredSet.has(key) ||
          nonAutoBundle.ignoredSet.has(norm) ||
          translateText(key, nonAutoBundle).changed
        ) {
          delete autoDict.exact[key];
          if (autoDict.meta && Object.prototype.hasOwnProperty.call(autoDict.meta, key)) {
            delete autoDict.meta[key];
          }
          autoChanged = true;
        }
      }
      if (autoChanged) {
        writeJsonAtomic(files.autoDictPath, autoDict);
      }
    }
  }

  const bundle = loadMergedBundle(userDataDir);
  const compiled = compileBundle(bundle);
  const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
  const rawItems = untranslated && untranslated.items && typeof untranslated.items === 'object' ? untranslated.items : {};
  const { filtered, removed, remaining } = filterPendingUntranslatedItems(rawItems, compiled);
  if (removed > 0) {
    writeJsonAtomic(files.untranslatedPath, { items: filtered });
  }
  return { removed, remaining };
}

module.exports = {
  readJsonSafe,
  writeJsonAtomic,
  loadBaseDictionary,
  loadGlossary,
  flattenExactMap,
  ensureUserDataDir,
  loadMergedBundle,
  validateDictionary,
  buildAiTranslationPrompt,
  importCustomTranslations,
  filterPendingUntranslatedItems,
  pruneTranslatedFromUntranslated,
};
