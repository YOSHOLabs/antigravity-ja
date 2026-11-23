'use strict';

const FORBIDDEN_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'CODE',
  'PRE',
  'KBD',
  'SAMP',
  'VAR',
  'SVG',
  'MATH',
  'CANVAS',
  'IFRAME',
  'WEBVIEW',
  'OBJECT',
  'EMBED',
]);

const INTERACTIVE_TAGS = new Set(['BUTTON', 'SUMMARY', 'LABEL']);
const INTERACTIVE_ROLES = new Set([
  'button',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'checkbox',
  'radio',
  'option',
]);

const EDITOR_OR_TERMINAL_CLASS_RE =
  /(?:^|\s)(?:xterm|xterm-screen|xterm-rows|monaco-editor|view-lines|cm-editor|CodeMirror|ace_editor|antigravity-ja-ignore)(?:\s|$)/;

const PROSE_CLASS_RE =
  /(?:^|\s)(?:prose|markdown|markdown-body|markdown-content|chat-message|message-content|message-body|assistant-message|user-message|response-content|diff-line|code-block)(?:\s|$)/i;

const PROSE_ATTR_ROLE_RE = /^(?:assistant|user|message|markdown|prose)$/i;

function getTag(el) {
  return String((el && (el.tagName || el.nodeName)) || '').toUpperCase();
}

function getAttr(el, name) {
  if (!el) return null;
  if (typeof el.getAttribute === 'function') {
    return el.getAttribute(name);
  }
  if (el.attributes && typeof el.attributes === 'object') {
    const val = el.attributes[name];
    return val === undefined ? null : val;
  }
  return null;
}

function getClassName(el) {
  if (!el) return '';
  if (typeof el.className === 'string') return el.className;
  if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
  const cls = getAttr(el, 'class');
  return typeof cls === 'string' ? cls : '';
}

function getParent(el) {
  if (!el) return null;
  return el.parentElement || el.parentNode || null;
}

function isForbiddenTag(tagName) {
  return FORBIDDEN_TAGS.has(String(tagName || '').toUpperCase());
}

function isContentEditableEl(el) {
  if (!el) return false;
  if (el.isContentEditable === true) return true;
  const ce = getAttr(el, 'contenteditable');
  if (ce === null || ce === undefined) return false;
  const norm = String(ce).toLowerCase();
  return norm === '' || norm === 'true' || norm === 'plaintext-only';
}

function isEditorOrTerminalEl(el) {
  if (!el) return false;
  if (el.id === 'antigravity-ja-toast-host') return true;
  if (getAttr(el, 'data-antigravity-ja-ignore') !== null) return true;
  const cls = getClassName(el);
  return cls ? EDITOR_OR_TERMINAL_CLASS_RE.test(cls) : false;
}

function isInteractiveUiElement(el) {
  if (!el) return false;
  const tag = getTag(el);
  if (INTERACTIVE_TAGS.has(tag)) return true;
  const role = String(getAttr(el, 'role') || '').toLowerCase();
  return INTERACTIVE_ROLES.has(role);
}

function isProseContainer(el) {
  if (!el) return false;
  const cls = getClassName(el);
  if (cls && PROSE_CLASS_RE.test(cls)) return true;
  const authorRole = getAttr(el, 'data-message-author-role') || getAttr(el, 'data-role');
  if (authorRole && PROSE_ATTR_ROLE_RE.test(String(authorRole))) return true;
  if (getAttr(el, 'data-markdown') !== null) return true;
  return false;
}

/**
 * Determines whether a DOM element (or text node's parent element) should be skipped
 * from translation/collection.
 * @param {object | null} el
 * @param {boolean} [isAttribute]
 * @returns {boolean}
 */
function shouldSkipNodeForTranslation(el, isAttribute = false) {
  let cur = el;
  let seenInteractive = false;
  let depth = 0;

  while (cur && depth < 64) {
    depth++;
    const tag = getTag(cur);
    if (!tag || tag === '#DOCUMENT' || tag === '#DOCUMENT-FRAGMENT') {
      break;
    }
    if (isForbiddenTag(tag)) {
      return true;
    }
    if (!isAttribute && (tag === 'TEXTAREA' || isContentEditableEl(cur))) {
      return true;
    }
    if (isEditorOrTerminalEl(cur)) {
      return true;
    }
    if (isInteractiveUiElement(cur)) {
      seenInteractive = true;
    }
    if (isProseContainer(cur) && !seenInteractive) {
      return true;
    }
    cur = getParent(cur);
  }

  return false;
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

/**
 * Compiles raw merged dictionary bundle for fast lookup.
 * @param {object} rawBundle
 */
function compileBundle(rawBundle) {
  const exactMap = new Map();
  const exactObj = rawBundle && rawBundle.exact && typeof rawBundle.exact === 'object' ? rawBundle.exact : {};
  for (const [k, v] of Object.entries(exactObj)) {
    if (typeof k === 'string' && typeof v === 'string' && k.length > 0 && v.length > 0) {
      exactMap.set(k, v);
      const norm = normalizeLookupKey(k);
      if (norm !== k && !exactMap.has(norm)) {
        exactMap.set(norm, v);
      }
    }
  }

  const patternList = [];
  const rawPatterns = Array.isArray(rawBundle?.patterns) ? rawBundle.patterns : [];
  for (const item of rawPatterns) {
    if (!item || typeof item.pattern !== 'string' || typeof item.replace !== 'string') {
      continue;
    }
    try {
      const re = new RegExp(item.pattern, item.flags || '');
      patternList.push({ re, replace: item.replace });
    } catch {
      // Ignore invalid user pattern so runtime never crashes
    }
  }

  const ignoredSet = new Set();
  if (Array.isArray(rawBundle?.ignored)) {
    for (const x of rawBundle.ignored) {
      if (typeof x === 'string' && x.length > 0) {
        ignoredSet.add(x);
        const norm = normalizeLookupKey(x);
        if (norm !== x) {
          ignoredSet.add(norm);
        }
      }
    }
  }

  return {
    enabled: rawBundle?.enabled !== false,
    collectUntranslated: Boolean(rawBundle?.collectUntranslated),
    autoCollectTooltips: rawBundle?.autoCollectTooltips !== false,
    japaneseTypography: rawBundle?.japaneseTypography !== false,
    autoTranslate: rawBundle?.autoTranslate !== false,
    exactMap,
    patternList,
    ignoredSet,
  };
}

const WS_SPLIT_RE = /^(\s*)([\s\S]*?)(\s*)$/;

/**
 * Translates text preserving leading/trailing whitespace.
 * @param {string} rawText
 * @param {ReturnType<typeof compileBundle>} compiled
 */
function translateText(rawText, compiled) {
  if (typeof rawText !== 'string' || rawText.length === 0) {
    return { changed: false, value: rawText || '', core: '' };
  }
  const m = WS_SPLIT_RE.exec(rawText);
  const lead = m ? m[1] : '';
  const core = m ? m[2] : rawText;
  const trail = m ? m[3] : '';

  if (!core) {
    return { changed: false, value: rawText, core: '' };
  }

  const normCore = normalizeLookupKey(core);
  let exactHit = compiled.exactMap.get(core);
  if (exactHit === undefined && normCore !== core) {
    exactHit = compiled.exactMap.get(normCore);
  }
  if (exactHit !== undefined && exactHit !== core) {
    return { changed: true, value: `${lead}${exactHit}${trail}`, core };
  }

  for (let i = 0; i < compiled.patternList.length; i++) {
    const p = compiled.patternList[i];
    if (p.re.global) {
      p.re.lastIndex = 0;
    }
    if (p.re.test(core)) {
      if (p.re.global) {
        p.re.lastIndex = 0;
      }
      const replaced = core.replace(p.re, p.replace);
      if (replaced !== core) {
        return { changed: true, value: `${lead}${replaced}${trail}`, core };
      }
    } else if (normCore !== core) {
      if (p.re.global) {
        p.re.lastIndex = 0;
      }
      if (p.re.test(normCore)) {
        if (p.re.global) {
          p.re.lastIndex = 0;
        }
        const replaced = normCore.replace(p.re, p.replace);
        if (replaced !== normCore) {
          return { changed: true, value: `${lead}${replaced}${trail}`, core };
        }
      }
    }
  }

  return { changed: false, value: rawText, core };
}

const HAS_CJK_RE = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/;
const HAS_LETTERS_RE = /[A-Za-z]{2,}/;
const URL_RE = /^(?:https?|wss?|sidecar|file|mailto):\/\//i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WIN_PATH_RE = /^[A-Za-z]:[\\/]/;
const POSIX_PATH_RE = /^(?:~\/|\/(?:[^/\s]+\/)+[^/\s]*$)/;
const REL_FILE_RE = /^[^\s]+\/[^\s]+\.[a-z0-9]{1,8}$/i;
const BARE_FILENAME_RE =
  /^[^\s/\\]+\.(?:bat|cmd|vbs|js|mjs|cjs|ts|tsx|jsx|json|md|py|exe|dll|asar|lnk|png|jpg|jpeg|gif|webp|mp4|wav|log|txt|yml|yaml|css|html|svg)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH_RE = /^(?:0x)?[0-9a-f]{12,}$/i;
const CSS_UNIT_RE = /^\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|ms|s)$/i;
const SEMVER_RE = /^v?\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?)?$/;
const TIME_RE = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
const CAMEL_CASE_RE = /^[a-z]+[A-Z][A-Za-z0-9]*$/;
const KEBAB_OR_SNAKE_LOWER_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/;
const SHORTCUT_COMBO_RE =
  /^(?:(?:Ctrl|Cmd|Command|Alt|Option|Opt|Shift|Meta|Super|Win)\+)+(?:[A-Za-z0-9,./;'[\]\\`\-=]|Enter|Return|Tab|Space|Esc|Escape|Backspace|Delete|Up|Down|Left|Right|Home|End|PageUp|PageDown|F\d{1,2})$/i;
const TOOLTIP_KEYCAP_RE =
  /^(?:Enter|Return|Esc|Escape|Tab|Space|Backspace|Shift|Ctrl|Alt|Cmd|Meta|F\d{1,2})$/i;

/**
 * Filters out non-UI strings (paths, URLs, UUIDs, code identifiers, Japanese text)
 * when collecting untranslated UI candidates.
 * @param {string} core
 * @param {{ tagName?: string, role?: string, attr?: string, inTooltip?: boolean }} meta
 * @param {ReturnType<typeof compileBundle>} compiled
 */
function shouldCollectCandidate(core, meta, compiled) {
  if (typeof core !== 'string') return false;
  const maxLen = meta?.inTooltip ? 600 : 450;
  if (core.length < 2 || core.length > maxLen) return false;
  if (/[\r\n]/.test(core)) {
    if (!meta?.inTooltip && core.length > 450) return false;
    if (/(?:\n\s*at\s+\S+|\{\s*\n|;\s*\n)/.test(core)) return false;
  }
  if (HAS_CJK_RE.test(core)) return false;
  if (!HAS_LETTERS_RE.test(core)) return false;
  if (SHORTCUT_COMBO_RE.test(core) || TOOLTIP_KEYCAP_RE.test(core)) return false;
  const normCore = normalizeLookupKey(core);
  if (
    compiled.exactMap.has(core) ||
    compiled.exactMap.has(normCore) ||
    compiled.ignoredSet.has(core) ||
    compiled.ignoredSet.has(normCore)
  ) {
    return false;
  }
  if (translateText(core, compiled).changed) return false;

  if (
    URL_RE.test(core) ||
    EMAIL_RE.test(core) ||
    WIN_PATH_RE.test(core) ||
    POSIX_PATH_RE.test(core) ||
    REL_FILE_RE.test(core) ||
    BARE_FILENAME_RE.test(core) ||
    UUID_RE.test(core) ||
    HEX_HASH_RE.test(core) ||
    CSS_UNIT_RE.test(core) ||
    SEMVER_RE.test(core) ||
    ISO_DATE_RE.test(core) ||
    TIME_RE.test(core)
  ) {
    return false;
  }

  const isExplicitUiHint =
    meta?.attr === 'placeholder' ||
    String(meta?.role || '').toLowerCase() === 'button' ||
    String(meta?.tagName || '').toUpperCase() === 'BUTTON';

  if (!isExplicitUiHint && !/\s/.test(core)) {
    if (core.includes('_') || core.includes('::') || core.includes('->')) {
      return false;
    }
    if (CAMEL_CASE_RE.test(core) || KEBAB_OR_SNAKE_LOWER_RE.test(core)) {
      return false;
    }
  }

  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FORBIDDEN_TAGS,
    INTERACTIVE_TAGS,
    INTERACTIVE_ROLES,
    isForbiddenTag,
    isEditorOrTerminalEl,
    isInteractiveUiElement,
    isProseContainer,
    shouldSkipNodeForTranslation,
    normalizeLookupKey,
    compileBundle,
    translateText,
    shouldCollectCandidate,
  };
}
