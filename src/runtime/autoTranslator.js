'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_AUTO_CONFIG = Object.freeze({
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

const VALID_PROVIDERS = new Set(['free', 'gemini', 'openai', 'ollama']);

const HAS_CJK_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const HAS_LETTERS_RE = /[A-Za-z]{2,}/;
const URL_RE = /^(?:https?|wss?|sidecar|file|mailto):\/\//i;
const EMBEDDED_URL_RE = /(?:https?|wss?|sidecar|file|mailto):\/\/\S+/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMBEDDED_EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[A-Za-z]{2,}\b/;
const WIN_PATH_RE = /^[A-Za-z]:[\\/]/;
const EMBEDDED_WIN_PATH_RE = /\b[A-Za-z]:\\[^\s]+/;
const POSIX_PATH_RE = /^(?:~\/|\/(?:[^/\s]+\/)+[^/\s]*$)/;
const REL_FILE_RE = /^[^\s]+\/[^\s]+\.[a-z0-9]{1,8}$/i;
const BARE_FILENAME_RE =
  /^[^\s/\\]+\.(?:bat|cmd|vbs|js|mjs|cjs|ts|tsx|jsx|json|md|py|exe|dll|asar|lnk|png|jpg|jpeg|gif|webp|mp4|wav|log|txt|yml|yaml|css|html|svg)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH_RE = /^(?:0x)?[0-9a-f]{12,}$/i;
const HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const CSS_UNIT_RE = /^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|ms|s)$/i;
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
const CAMEL_CASE_RE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
const KEBAB_OR_SNAKE_LOWER_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const SHORTCUT_COMBO_RE =
  /^(?:(?:Ctrl|Cmd|Command|Alt|Option|Opt|Shift|Meta|Super|Win)\+)+(?:[A-Za-z0-9,./;'[\]\\`\-=]|Enter|Return|Tab|Space|Esc|Escape|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|F\d{1,2})$/i;
const KEYCAP_ONLY_RE =
  /^(?:Enter|Return|Esc|Escape|Tab|Space|Backspace|Delete|Shift|Ctrl|Alt|Cmd|Command|Meta|Option|Opt|Super|Win|CapsLock|PageUp|PageDown|Home|End|Insert|F\d{1,2})$/i;
const SECRET_TOKEN_RE =
  /(?:^|\b)(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer\s+\S+)\b/;
const CODE_SYNTAX_RE = /(?:[{}<>`]|=>|::|&&|\|\||^\s*(?:npm|npx|node|git|python|pip)\s+)/;
const UI_START_CASE_RE = /^(?:[A-Z]|["'(\[]+[A-Z]|\d+(?:\.\d+)?\s+[A-Za-z])/;
const MODEL_NAME_ONLY_RE =
  /^(?:Gemini|Claude|GPT|Gemma|Llama|Qwen|O[134])(?:\s+[\w.+-]+){0,5}(?:\s*\((?:Low|Medium|High|XHigh|Thinking|Carbon|Neon|Argon|Hydrogen|Fast|Flash|Pro|Ultra)\))?$/i;

const NON_TRANSLATABLE_EXACT = new Set([
  'antigravity',
  'github',
  'google',
  'google sans',
  'inter',
  'segoe ui',
  'consolas',
  'monaco',
  'windows',
  'macos',
  'linux',
  'mit',
  'mit license',
  'wsl',
  'ssh',
  'mcp',
  'cli',
  'sdk',
  'api',
  'json',
  'html',
  'css',
  'url',
  'uuid',
  'sha-256',
  'ok',
  'on',
  'off',
  'am',
  'pm',
]);

function normalizeConfig(raw) {
  const provider =
    raw && typeof raw.autoTranslateProvider === 'string' && VALID_PROVIDERS.has(raw.autoTranslateProvider)
      ? raw.autoTranslateProvider
      : DEFAULT_AUTO_CONFIG.autoTranslateProvider;
  return {
    enabled: raw?.enabled !== false,
    collectUntranslated: Boolean(raw?.collectUntranslated),
    autoCollectTooltips: raw?.autoCollectTooltips !== false,
    japaneseTypography: raw?.japaneseTypography !== false,
    autoTranslate: raw?.autoTranslate !== false,
    autoTranslateProvider: provider,
    autoTranslateApiKey: typeof raw?.autoTranslateApiKey === 'string' ? raw.autoTranslateApiKey.trim() : '',
    autoTranslateModel: typeof raw?.autoTranslateModel === 'string' ? raw.autoTranslateModel.trim() : '',
    autoTranslateEndpoint: typeof raw?.autoTranslateEndpoint === 'string' ? raw.autoTranslateEndpoint.trim() : '',
  };
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
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
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

function flattenExactMap(baseDict) {
  const merged = {};
  if (!baseDict || typeof baseDict !== 'object') return merged;
  if (baseDict.categories && typeof baseDict.categories === 'object') {
    for (const cat of Object.values(baseDict.categories)) {
      if (cat && cat.exact && typeof cat.exact === 'object') {
        for (const [k, v] of Object.entries(cat.exact)) {
          if (typeof k === 'string' && typeof v === 'string') merged[k] = v;
        }
      }
    }
  }
  if (baseDict.exact && typeof baseDict.exact === 'object') {
    for (const [k, v] of Object.entries(baseDict.exact)) {
      if (typeof k === 'string' && typeof v === 'string') merged[k] = v;
    }
  }
  return merged;
}

function normalizeLookupKey(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\r\n/g, '\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ');
}

function resolveUserDataDir(overrideDir) {
  if (overrideDir) return path.resolve(overrideDir);
  if (process.env.ANTIGRAVITY_JA_DIR) return path.resolve(process.env.ANTIGRAVITY_JA_DIR);
  return path.join(os.homedir(), '.antigravity-ja');
}

function stripJsonCodeFences(rawText) {
  const trimmed = String(rawText || '').trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Strict privacy + UI quality filter before sending any string to an external/local translator.
 * @param {string} text
 * @param {{ inTooltip?: boolean, attr?: string, role?: string, tagName?: string }} [meta]
 */
function isSafeForAutoTranslate(text, meta = {}) {
  if (typeof text !== 'string') return false;
  const core = text.trim();
  const maxLen = meta?.inTooltip ? 420 : 280;
  if (core.length < 2 || core.length > maxLen) return false;
  if (HAS_CJK_RE.test(core)) return false;
  if (!HAS_LETTERS_RE.test(core)) return false;
  if (/(?:\n\s*at\s+\S+|\{\s*\n|;\s*\n)/.test(core)) return false;
  if (KEYCAP_ONLY_RE.test(core) || SHORTCUT_COMBO_RE.test(core)) return false;
  if (
    URL_RE.test(core) ||
    EMBEDDED_URL_RE.test(core) ||
    EMAIL_RE.test(core) ||
    EMBEDDED_EMAIL_RE.test(core) ||
    WIN_PATH_RE.test(core) ||
    EMBEDDED_WIN_PATH_RE.test(core) ||
    POSIX_PATH_RE.test(core) ||
    REL_FILE_RE.test(core) ||
    BARE_FILENAME_RE.test(core) ||
    UUID_RE.test(core) ||
    HEX_HASH_RE.test(core) ||
    HEX_COLOR_RE.test(core) ||
    CSS_UNIT_RE.test(core) ||
    SEMVER_RE.test(core) ||
    ISO_DATE_RE.test(core) ||
    TIME_RE.test(core) ||
    SECRET_TOKEN_RE.test(core)
  ) {
    return false;
  }
  if (CODE_SYNTAX_RE.test(core)) return false;
  if (NON_TRANSLATABLE_EXACT.has(core.toLowerCase())) return false;
  if (MODEL_NAME_ONLY_RE.test(core)) return false;

  if (!/\s/.test(core)) {
    if (core.includes('_') || core.includes('::') || core.includes('->')) return false;
    if (CAMEL_CASE_RE.test(core) || KEBAB_OR_SNAKE_LOWER_RE.test(core)) return false;
    if (/^\d+$/.test(core)) return false;
  }

  const isPlaceholder = meta?.attr === 'placeholder';
  if (!isPlaceholder && !UI_START_CASE_RE.test(core)) {
    return false;
  }

  return true;
}

/**
 * Cleans translated Japanese text and preserves key product/brand terms.
 * @param {string} jaText
 * @param {string} originalEn
 * @returns {string | null}
 */
function postProcessTranslation(jaText, originalEn) {
  if (typeof jaText !== 'string' || typeof originalEn !== 'string') {
    return null;
  }
  let out = jaText.trim();
  // Remove accidental outer quotes if original didn't use them
  if (
    ((out.startsWith('"') && out.endsWith('"') && !originalEn.trim().startsWith('"')) ||
      (out.startsWith('「') && out.endsWith('」') && !originalEn.trim().startsWith('"'))) &&
    out.length >= 2
  ) {
    out = out.slice(1, -1).trim();
  }
  if (!out || out === originalEn.trim()) return null;
  if (!HAS_CJK_RE.test(out)) return null;
  if (out.length > Math.max(80, originalEn.length * 4)) return null;

  if (/\bAntigravity\b/i.test(originalEn)) {
    out = out.replace(/反重力|アンチグラビティ|アンティグラビティ/g, 'Antigravity');
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/ +([、。！？])/g, '$1').trim();
  return out || null;
}

async function fetchWithTimeout(fetchFn, url, init, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    return await fetchFn(url, {
      ...init,
      signal: controller ? controller.signal : undefined,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function translateFreeChunk(chunk, fetchFn, timeoutMs) {
  if (chunk.length === 0) return [];
  const joined = chunk.join('\n');
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ja&dt=t&q=' +
    encodeURIComponent(joined);
  const res = await fetchWithTimeout(fetchFn, url, { method: 'GET' }, timeoutMs);
  if (!res || !res.ok) {
    throw new Error(`Free translate HTTP ${res ? res.status : 'error'}`);
  }
  const data = await res.json();
  const segments = Array.isArray(data && data[0]) ? data[0] : [];
  const fullText = segments.map((s) => (Array.isArray(s) && typeof s[0] === 'string' ? s[0] : '')).join('');

  if (chunk.length === 1) {
    return [fullText];
  }

  const lines = fullText.split('\n');
  if (lines.length === chunk.length) {
    return lines;
  }

  // Fallback: split recursively on line-count mismatch so alignments never drift
  const mid = Math.floor(chunk.length / 2);
  const left = await translateFreeChunk(chunk.slice(0, mid), fetchFn, timeoutMs);
  const right = await translateFreeChunk(chunk.slice(mid), fetchFn, timeoutMs);
  return [...left, ...right];
}

async function translateWithFree(texts, fetchFn, timeoutMs) {
  const results = {};
  const singleLine = [];
  const multiLine = [];
  for (const t of texts) {
    if (t.includes('\n')) multiLine.push(t);
    else singleLine.push(t);
  }

  // Group single-line entries up to 16 items or ~1300 chars
  let batch = [];
  let charCount = 0;
  const batches = [];
  for (const t of singleLine) {
    if (batch.length >= 16 || charCount + t.length > 1300) {
      batches.push(batch);
      batch = [];
      charCount = 0;
    }
    batch.push(t);
    charCount += t.length + 1;
  }
  if (batch.length > 0) batches.push(batch);

  for (const b of batches) {
    const translatedList = await translateFreeChunk(b, fetchFn, timeoutMs);
    for (let i = 0; i < b.length; i++) {
      const cleaned = postProcessTranslation(translatedList[i], b[i]);
      if (cleaned) results[b[i]] = cleaned;
    }
  }

  for (const mText of multiLine) {
    const [translated] = await translateFreeChunk([mText], fetchFn, timeoutMs);
    const cleaned = postProcessTranslation(translated, mText);
    if (cleaned) results[mText] = cleaned;
  }

  return results;
}

function buildLlmMessages(texts, glossary) {
  const terms = Array.isArray(glossary?.terms)
    ? glossary.terms.slice(0, 20).map((t) => `${t.en} => ${t.ja}`).join(', ')
    : 'Agent => エージェント, Conversation => 会話, Workspace => ワークスペース, Settings => 設定, Permissions => 権限';

  const systemPrompt =
    'You are a Japanese UI localization specialist for a developer desktop app (Antigravity). ' +
    'Translate every English UI string into natural, concise Japanese using polite/clear UI phrasing (〜します / 〜する / 〜中). ' +
    'Keep Antigravity, GitHub, Gemini, Claude, GPT, MCP, WSL, SSH, JSON untranslated when present. ' +
    `Standard glossary: ${terms}. ` +
    'Return ONLY a valid JSON object mapping each original English key verbatim to its Japanese translation.';

  const userPrompt = JSON.stringify({ items: texts });
  return { systemPrompt, userPrompt };
}

function extractTranslatedObject(rawContent, sourceTexts) {
  const parsed = JSON.parse(stripJsonCodeFences(rawContent));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }
  const srcSet = new Set(sourceTexts);
  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!srcSet.has(k) || typeof v !== 'string') continue;
    const cleaned = postProcessTranslation(v, k);
    if (cleaned) out[k] = cleaned;
  }
  return out;
}

/**
 * Ensures custom API endpoints use https:// (or http:// strictly for loopback localhost).
 * @param {string} rawUrl
 * @returns {string}
 */
function validateEndpointUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return '';
  }
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('カスタムエンドポイントは有効な URL を指定してください');
  }
  const host = parsed.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
  if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback)) {
    return trimmed;
  }
  throw new Error('カスタムエンドポイントは https://（ローカルのみ http://）を指定してください');
}

async function translateWithGemini(texts, cfg, fetchFn, glossary, timeoutMs) {
  const apiKey = cfg.autoTranslateApiKey || process.env.GEMINI_API_KEY || '';
  if (!apiKey) {
    throw new Error('Gemini API キーが設定されていません');
  }
  const model = cfg.autoTranslateModel || 'gemini-2.5-flash';
  const endpoint = cfg.autoTranslateEndpoint
    ? validateEndpointUrl(cfg.autoTranslateEndpoint)
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const { systemPrompt, userPrompt } = buildLlmMessages(texts, glossary);

  const res = await fetchWithTimeout(
    fetchFn,
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    },
    timeoutMs
  );
  if (!res || !res.ok) {
    throw new Error(`Gemini HTTP ${res ? res.status : 'error'}`);
  }
  const payload = await res.json();
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return extractTranslatedObject(text, texts);
}

async function translateWithOpenAI(texts, cfg, fetchFn, glossary, timeoutMs) {
  const apiKey = cfg.autoTranslateApiKey || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    throw new Error('OpenAI API キーが設定されていません');
  }
  const model = cfg.autoTranslateModel || 'gpt-4o-mini';
  const endpoint = cfg.autoTranslateEndpoint
    ? validateEndpointUrl(cfg.autoTranslateEndpoint)
    : 'https://api.openai.com/v1/chat/completions';
  const { systemPrompt, userPrompt } = buildLlmMessages(texts, glossary);

  const res = await fetchWithTimeout(
    fetchFn,
    endpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
    timeoutMs
  );
  if (!res || !res.ok) {
    throw new Error(`OpenAI HTTP ${res ? res.status : 'error'}`);
  }
  const payload = await res.json();
  const text = payload?.choices?.[0]?.message?.content || '{}';
  return extractTranslatedObject(text, texts);
}

async function translateWithOllama(texts, cfg, fetchFn, glossary, timeoutMs) {
  const model = cfg.autoTranslateModel || 'qwen2.5:7b';
  let endpoint = validateEndpointUrl(cfg.autoTranslateEndpoint || 'http://127.0.0.1:11434/api/chat').replace(/\/+$/, '');
  if (!/\/api\/(chat|generate)$/i.test(endpoint)) {
    endpoint = `${endpoint}/api/chat`;
  }
  const { systemPrompt, userPrompt } = buildLlmMessages(texts, glossary);

  const res = await fetchWithTimeout(
    fetchFn,
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        options: { temperature: 0.1 },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
    timeoutMs
  );
  if (!res || !res.ok) {
    throw new Error(`Ollama HTTP ${res ? res.status : 'error'}`);
  }
  const payload = await res.json();
  const text = payload?.message?.content || '{}';
  return extractTranslatedObject(text, texts);
}

/**
 * Translates an array of safe UI strings using the configured provider.
 * @param {string[]} texts
 * @param {object} [config]
 * @param {{ _fetch?: Function, glossary?: object, timeoutMs?: number }} [options]
 * @returns {Promise<Record<string, string>>}
 */
async function translateBatch(texts, config = {}, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return {};
  }
  const fetchFn = options._fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch API is unavailable in this runtime');
  }
  const cfg = normalizeConfig(config);
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const unique = Array.from(new Set(texts.filter((x) => typeof x === 'string' && x.trim().length > 0)));
  if (unique.length === 0) {
    return {};
  }

  if (cfg.autoTranslateProvider === 'gemini') {
    return translateWithGemini(unique, cfg, fetchFn, options.glossary, timeoutMs);
  }
  if (cfg.autoTranslateProvider === 'openai') {
    return translateWithOpenAI(unique, cfg, fetchFn, options.glossary, timeoutMs);
  }
  if (cfg.autoTranslateProvider === 'ollama') {
    return translateWithOllama(unique, cfg, fetchFn, options.glossary, timeoutMs);
  }
  return translateWithFree(unique, fetchFn, timeoutMs);
}

function buildPatternRegexList(rawPatterns) {
  const list = [];
  if (!Array.isArray(rawPatterns)) return list;
  for (const p of rawPatterns) {
    if (!p || typeof p.pattern !== 'string' || typeof p.replace !== 'string') continue;
    try {
      list.push({ re: new RegExp(p.pattern, p.flags || ''), replace: p.replace });
    } catch {
      // ignore invalid
    }
  }
  return list;
}

function isAlreadyCovered(text, meta, exactMap, normMap, patternList, ignoredSet) {
  const norm = normalizeLookupKey(text);
  if (exactMap.has(text) || normMap.has(norm) || ignoredSet.has(text) || ignoredSet.has(norm)) {
    return true;
  }
  for (const p of patternList) {
    if (p.re.global) p.re.lastIndex = 0;
    if (p.re.test(text)) return true;
    if (norm !== text) {
      if (p.re.global) p.re.lastIndex = 0;
      if (p.re.test(norm)) return true;
    }
  }
  return !isSafeForAutoTranslate(text, meta);
}

/**
 * Discovers pending safe UI strings in userDataDir/untranslated.json, translates them in bounded
 * batches, saves to userDataDir/auto.json, and prunes translated keys from untranslated.json.
 * @param {string} [userDataDir]
 * @param {{ maxItems?: number, timeoutMs?: number, _fetch?: Function, glossary?: object, texts?: Array<{ text: string, meta?: object }> }} [options]
 */
async function runAutoTranslateForUserDir(userDataDir, options = {}) {
  const dir = resolveUserDataDir(userDataDir);
  const configPath = path.join(dir, 'config.json');
  const baseDictPath = path.join(dir, 'dictionary.json');
  const customDictPath = path.join(dir, 'custom.json');
  const autoDictPath = path.join(dir, 'auto.json');
  const untranslatedPath = path.join(dir, 'untranslated.json');

  const cfg = normalizeConfig(readJsonSafe(configPath, DEFAULT_AUTO_CONFIG));
  if (!cfg.autoTranslate && !options.force) {
    return { attempted: 0, translated: 0, skipped: 0, provider: cfg.autoTranslateProvider, disabled: true };
  }

  const baseDict = readJsonSafe(baseDictPath, { categories: {}, patterns: [] });
  const customDict = readJsonSafe(customDictPath, { exact: {}, patterns: [], ignored: [] });
  const autoDict = readJsonSafe(autoDictPath, { exact: {}, meta: {} });
  const untranslated = readJsonSafe(untranslatedPath, { items: {} });

  const exactMap = new Map();
  const normMap = new Map();
  const addExactSource = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'string' && k && v) {
        exactMap.set(k, v);
        normMap.set(normalizeLookupKey(k), v);
      }
    }
  };
  addExactSource(autoDict?.exact);
  addExactSource(flattenExactMap(baseDict));
  addExactSource(customDict?.exact);

  const ignoredSet = new Set();
  for (const x of Array.isArray(customDict?.ignored) ? customDict.ignored : []) {
    if (typeof x === 'string' && x) {
      ignoredSet.add(x);
      ignoredSet.add(normalizeLookupKey(x));
    }
  }
  const patternList = buildPatternRegexList([
    ...(Array.isArray(customDict?.patterns) ? customDict.patterns : []),
    ...(Array.isArray(baseDict?.patterns) ? baseDict.patterns : []),
  ]);

  let candidates = [];
  if (Array.isArray(options.texts)) {
    candidates = options.texts.map((item) => ({
      text: typeof item === 'string' ? item : item?.text,
      meta: typeof item === 'object' && item ? item : {},
    }));
  } else {
    const items = untranslated && untranslated.items && typeof untranslated.items === 'object' ? untranslated.items : {};
    candidates = Object.entries(items)
      .sort((a, b) => (b[1]?.inTooltip ? 1 : 0) - (a[1]?.inTooltip ? 1 : 0) || (b[1]?.count || 0) - (a[1]?.count || 0))
      .map(([text, meta]) => ({ text, meta: meta || {} }));
  }

  const maxItems = Number.isFinite(options.maxItems) ? options.maxItems : 40;
  const toTranslate = [];
  let skipped = 0;
  for (const c of candidates) {
    if (typeof c.text !== 'string' || !c.text) continue;
    if (isAlreadyCovered(c.text, c.meta, exactMap, normMap, patternList, ignoredSet)) {
      skipped++;
      continue;
    }
    toTranslate.push(c.text);
    if (toTranslate.length >= maxItems) break;
  }

  if (toTranslate.length === 0) {
    return { attempted: 0, translated: 0, skipped, provider: cfg.autoTranslateProvider, addedEntries: {} };
  }

  let translatedMap = {};
  try {
    translatedMap = await translateBatch(toTranslate, cfg, {
      _fetch: options._fetch,
      glossary: options.glossary,
      timeoutMs: options.timeoutMs || 8000,
    });
  } catch (err) {
    return {
      attempted: toTranslate.length,
      translated: 0,
      skipped,
      provider: cfg.autoTranslateProvider,
      error: err && err.message ? err.message : String(err),
      addedEntries: {},
    };
  }

  const nextAutoExact = autoDict && autoDict.exact && typeof autoDict.exact === 'object' ? { ...autoDict.exact } : {};
  const nextAutoMeta = autoDict && autoDict.meta && typeof autoDict.meta === 'object' ? { ...autoDict.meta } : {};
  const now = new Date().toISOString();
  const addedEntries = {};

  for (const [en, ja] of Object.entries(translatedMap)) {
    if (typeof en === 'string' && typeof ja === 'string' && en && ja) {
      nextAutoExact[en] = ja;
      nextAutoMeta[en] = { provider: cfg.autoTranslateProvider, translatedAt: now };
      addedEntries[en] = ja;
    }
  }

  const countAdded = Object.keys(addedEntries).length;
  if (countAdded > 0) {
    writeJsonAtomic(autoDictPath, { exact: nextAutoExact, meta: nextAutoMeta });
    const rawItems = untranslated && untranslated.items && typeof untranslated.items === 'object' ? { ...untranslated.items } : {};
    let untrChanged = false;
    for (const en of Object.keys(addedEntries)) {
      if (Object.prototype.hasOwnProperty.call(rawItems, en)) {
        delete rawItems[en];
        untrChanged = true;
      }
    }
    if (untrChanged) {
      writeJsonAtomic(untranslatedPath, { items: rawItems });
    }
  }

  return {
    attempted: toTranslate.length,
    translated: countAdded,
    skipped,
    provider: cfg.autoTranslateProvider,
    addedEntries,
  };
}

module.exports = {
  DEFAULT_AUTO_CONFIG,
  normalizeConfig,
  validateEndpointUrl,
  isSafeForAutoTranslate,
  postProcessTranslation,
  translateBatch,
  runAutoTranslateForUserDir,
};
