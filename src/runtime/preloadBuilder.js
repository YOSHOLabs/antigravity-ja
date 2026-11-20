'use strict';

const fs = require('fs');
const path = require('path');

const PRELOAD_START_MARKER = '// === ANTIGRAVITY-JA-PRELOAD-START ===';
const PRELOAD_END_MARKER = '// === ANTIGRAVITY-JA-PRELOAD-END ===';

/**
 * Builds the self-contained, sandbox-safe preload snippet to append to dist/preload.js.
 * Does NOT require any external local files or fs APIs (safe under Electron sandbox: true).
 */
function buildPreloadSnippet() {
  const corePath = path.join(__dirname, 'translatorCore.js');
  const coreSource = fs.readFileSync(corePath, 'utf8');

  return `${PRELOAD_START_MARKER}
(function () {
  'use strict';
  const g = globalThis;
  if (g.__antigravityJaPreloadInstalled) {
    return;
  }
  const h = g.location && g.location.hostname;
  const proto = g.location && g.location.protocol;
  const okHost = !g.location || (/^https?:$/.test(proto || '') && (h === '127.0.0.1' || h === 'localhost'));
  if (!okHost || (g.top && g.self && g.top !== g.self)) {
    return;
  }
  let ipcRenderer = null;
  try {
    ipcRenderer = require('electron').ipcRenderer;
  } catch {
    return;
  }
  if (!ipcRenderer || typeof ipcRenderer.invoke !== 'function') {
    return;
  }
  g.__antigravityJaPreloadInstalled = true;

  const core = (function () {
    const module = { exports: {} };
    const exports = module.exports;
${coreSource}
    return module.exports;
  })();

  const TRANSLATED_ATTRS = ['placeholder', 'aria-label', 'title'];
  const textState = new WeakMap();
  const attrState = new WeakMap();
  const reportedCache = new Set();
  const pendingReport = new Map();
  let reportTimer = null;

  let compiled = core.compileBundle({
    enabled: false,
    collectUntranslated: false,
    autoCollectTooltips: true,
    japaneseTypography: true,
    exact: {},
    patterns: [],
    ignored: [],
  });

  let dirtyFull = false;
  const dirtyNodes = new Set();
  let scheduledFrame = null;
  let observer = null;
  let toastTimer = null;
  let origLangSaved = false;
  let origLang = null;
  let lastAppliedRevision = 0;

  function syncJapaneseTypography(active) {
    try {
      const doc = g.document;
      if (!doc || !doc.documentElement) {
        return;
      }
      if (!origLangSaved) {
        origLangSaved = true;
        origLang = doc.documentElement.getAttribute('lang');
      }
      if (active) {
        if (doc.documentElement.getAttribute('lang') !== 'ja') {
          doc.documentElement.setAttribute('lang', 'ja');
        }
        if (doc.head && !doc.getElementById('antigravity-ja-font-style')) {
          const style = doc.createElement('style');
          style.id = 'antigravity-ja-font-style';
          style.setAttribute('data-antigravity-ja-ignore', 'true');
          style.textContent =
            'html[lang="ja"] { --font-sans: "Segoe UI", "BIZ UDPGothic", "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif; } ' +
            'html[lang="ja"] body { font-family: var(--font-sans, "Segoe UI", "BIZ UDPGothic", "Yu Gothic UI", "Hiragino Sans", "Meiryo", sans-serif); }';
          doc.head.appendChild(style);
        }
      } else {
        if (origLang === null) {
          doc.documentElement.removeAttribute('lang');
        } else if (doc.documentElement.getAttribute('lang') !== origLang) {
          doc.documentElement.setAttribute('lang', origLang);
        }
        const existingStyle = doc.getElementById('antigravity-ja-font-style');
        if (existingStyle && existingStyle.parentNode) {
          existingStyle.parentNode.removeChild(existingStyle);
        }
      }
    } catch {
      // ignore typography sync errors
    }
  }

  function scheduleFlush() {
    if (scheduledFrame !== null) {
      return;
    }
    const raf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame : (fn) => g.setTimeout(fn, 16);
    scheduledFrame = raf(() => {
      scheduledFrame = null;
      flushTranslations();
    });
  }

  function isInsideTooltip(el) {
    let cur = el;
    let depth = 0;
    while (cur && depth < 16) {
      depth++;
      if (cur.nodeType === 1) {
        if (
          (typeof cur.getAttribute === 'function' && cur.getAttribute('role') === 'tooltip') ||
          String(cur.className || '').includes('compact-tooltip')
        ) {
          return true;
        }
      }
      cur = cur.parentElement || cur.parentNode;
    }
    return false;
  }

  function isTooltipNode(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }
    if (
      (typeof node.getAttribute === 'function' && node.getAttribute('role') === 'tooltip') ||
      String(node.className || '').includes('compact-tooltip')
    ) {
      return true;
    }
    if (typeof node.querySelector === 'function') {
      return Boolean(node.querySelector('[role="tooltip"], .compact-tooltip'));
    }
    return false;
  }

  function queueCandidate(text, el, attrName) {
    if (!compiled.enabled) {
      return;
    }
    const inTooltip = isInsideTooltip(el);
    if (!compiled.collectUntranslated && !(compiled.autoCollectTooltips && inTooltip)) {
      return;
    }
    if (reportedCache.size >= 1500) {
      return;
    }
    const tagName = el && el.tagName ? String(el.tagName).toUpperCase() : '';
    if (tagName === 'HEAD' || tagName === 'TITLE' || tagName === 'META' || tagName === 'LINK') {
      return;
    }
    const role = el && typeof el.getAttribute === 'function' ? el.getAttribute('role') || '' : '';
    const meta = { tagName, role, attr: attrName || '', inTooltip };
    if (!core.shouldCollectCandidate(text, meta, compiled)) {
      return;
    }
    let entry = pendingReport.get(text);
    if (!entry) {
      if (reportedCache.has(text)) {
        return;
      }
      entry = {
        text,
        count: 0,
        tags: [],
        roles: [],
        attrs: [],
        inTooltip,
      };
      pendingReport.set(text, entry);
    } else if (inTooltip) {
      entry.inTooltip = true;
    }
    entry.count++;
    if (tagName && !entry.tags.includes(tagName) && entry.tags.length < 4) entry.tags.push(tagName);
    if (role && !entry.roles.includes(role) && entry.roles.length < 4) entry.roles.push(role);
    if (attrName && !entry.attrs.includes(attrName) && entry.attrs.length < 4) entry.attrs.push(attrName);

    if (reportTimer === null) {
      reportTimer = g.setTimeout(() => {
        reportTimer = null;
        if (pendingReport.size === 0) {
          return;
        }
        const batch = Array.from(pendingReport.values());
        pendingReport.clear();
        for (const item of batch) {
          reportedCache.add(item.text);
        }
        try {
          ipcRenderer.send('antigravity-ja:report-untranslated', batch);
        } catch {
          // ignore
        }
      }, 1000);
    }
  }

  function processTextNode(node) {
    if (!node || node.nodeType !== 3) {
      return;
    }
    const parent = node.parentElement;
    if (!parent) {
      return;
    }
    if (core.shouldSkipNodeForTranslation(parent, false)) {
      return;
    }
    const current = node.nodeValue;
    if (typeof current !== 'string' || current.length === 0) {
      return;
    }
    const rec = textState.get(node);
    const orig = rec && current === rec.lastTranslated ? rec.orig : current;

    if (!compiled.enabled) {
      if (rec && current === rec.lastTranslated) {
        if (node.nodeValue !== rec.orig) {
          node.nodeValue = rec.orig;
        }
        textState.delete(node);
      }
      return;
    }

    const res = core.translateText(orig, compiled);
    if (res.changed) {
      textState.set(node, { orig, lastTranslated: res.value });
      if (current !== res.value) {
        node.nodeValue = res.value;
      }
    } else {
      if (rec) {
        if (current === rec.lastTranslated && current !== rec.orig) {
          node.nodeValue = rec.orig;
        }
        textState.delete(node);
      }
      if (res.core) {
        queueCandidate(res.core, parent, '');
      }
    }
  }

  function processElementAttrs(el) {
    if (!el || el.nodeType !== 1) {
      return;
    }
    if (el.id === 'antigravity-ja-toast-host') {
      return;
    }
    if (core.shouldSkipNodeForTranslation(el, true)) {
      return;
    }
    let map = attrState.get(el);
    for (let i = 0; i < TRANSLATED_ATTRS.length; i++) {
      const attr = TRANSLATED_ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(attr)) {
        continue;
      }
      const current = el.getAttribute(attr);
      if (typeof current !== 'string' || current.length === 0) {
        continue;
      }
      const rec = map ? map.get(attr) : undefined;
      const orig = rec && current === rec.lastTranslated ? rec.orig : current;

      if (!compiled.enabled) {
        if (rec && current === rec.lastTranslated) {
          if (current !== rec.orig) {
            el.setAttribute(attr, rec.orig);
          }
          map.delete(attr);
        }
        continue;
      }

      const res = core.translateText(orig, compiled);
      if (res.changed) {
        if (!map) {
          map = new Map();
          attrState.set(el, map);
        }
        map.set(attr, { orig, lastTranslated: res.value });
        if (current !== res.value) {
          el.setAttribute(attr, res.value);
        }
      } else {
        if (rec) {
          if (current === rec.lastTranslated && current !== rec.orig) {
            el.setAttribute(attr, rec.orig);
          }
          map.delete(attr);
        }
        if (res.core) {
          queueCandidate(res.core, el, attr);
        }
      }
    }
  }

  function scanSubtree(root) {
    const doc = g.document;
    if (!doc || !root) {
      return;
    }
    if (root.nodeType === 3) {
      processTextNode(root);
      return;
    }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) {
      return;
    }
    if (root.nodeType === 1) {
      if (root.id === 'antigravity-ja-toast-host' || core.isForbiddenTag(root.tagName) || core.isEditorOrTerminalEl(root)) {
        return;
      }
    }

    if (typeof doc.createTreeWalker === 'function') {
      const walker = doc.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
        acceptNode(node) {
          if (node.nodeType === 1) {
            if (
              node.id === 'antigravity-ja-toast-host' ||
              core.isForbiddenTag(node.tagName) ||
              core.isEditorOrTerminalEl(node)
            ) {
              return 2; // NodeFilter.FILTER_REJECT
            }
          }
          return 1; // NodeFilter.FILTER_ACCEPT
        },
      });
      let node = walker.currentNode;
      while (node) {
        if (node.nodeType === 1) {
          processElementAttrs(node);
        } else if (node.nodeType === 3) {
          processTextNode(node);
        }
        node = walker.nextNode();
      }
    }
  }

  function flushTranslations() {
    const doc = g.document;
    if (!doc || !doc.body) {
      return;
    }
    if (dirtyFull) {
      dirtyFull = false;
      dirtyNodes.clear();
      scanSubtree(doc.body);
      return;
    }
    if (dirtyNodes.size === 0) {
      return;
    }
    const batch = Array.from(dirtyNodes);
    dirtyNodes.clear();
    for (let i = 0; i < batch.length; i++) {
      const target = batch[i];
      if (target && target.isConnected) {
        scanSubtree(target);
      }
    }
  }

  function showToast(text) {
    try {
      const doc = g.document;
      if (!doc || !doc.documentElement) {
        return;
      }
      let host = doc.getElementById('antigravity-ja-toast-host');
      let shadow = host && host.shadowRoot;
      if (!host) {
        host = doc.createElement('div');
        host.id = 'antigravity-ja-toast-host';
        host.setAttribute('data-antigravity-ja-ignore', 'true');
        host.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;pointer-events:none;';
        shadow = host.attachShadow({ mode: 'open' });
        const style = doc.createElement('style');
        style.textContent =
          '.toast{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Yu Gothic UI",sans-serif;font-size:12px;line-height:1.4;color:#f4f4f5;background:rgba(24,24,27,0.92);border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:8px 14px;box-shadow:0 8px 24px rgba(0,0,0,0.35);opacity:0;transform:translateY(6px);transition:opacity .16s ease,transform .16s ease;}' +
          '.toast.show{opacity:1;transform:translateY(0);}';
        const pill = doc.createElement('div');
        pill.className = 'toast';
        shadow.appendChild(style);
        shadow.appendChild(pill);
        doc.documentElement.appendChild(host);
      }
      const pill = shadow && shadow.querySelector('.toast');
      if (!pill) {
        return;
      }
      pill.textContent = text;
      pill.classList.add('show');
      if (toastTimer !== null) {
        g.clearTimeout(toastTimer);
      }
      toastTimer = g.setTimeout(() => {
        toastTimer = null;
        pill.classList.remove('show');
      }, 2000);
    } catch {
      // ignore toast errors
    }
  }

  function applyBundle(rawBundle) {
    const rev = rawBundle && typeof rawBundle.revision === 'number' ? rawBundle.revision : null;
    if (rev !== null && rev === lastAppliedRevision) {
      return;
    }
    if (rev !== null) {
      lastAppliedRevision = rev;
    }
    compiled = core.compileBundle(rawBundle);
    if (!compiled.collectUntranslated && !compiled.autoCollectTooltips) {
      pendingReport.clear();
    }
    syncJapaneseTypography(compiled.enabled && compiled.japaneseTypography);
    dirtyFull = true;
    scheduleFlush();
  }

  function startObserver() {
    const doc = g.document;
    if (!doc || !doc.body || observer || typeof g.MutationObserver !== 'function') {
      return;
    }
    observer = new g.MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.target && m.target.id === 'antigravity-ja-toast-host') {
          continue;
        }
        const targetInTooltip = isInsideTooltip(m.target);
        if (m.type === 'childList') {
          for (let j = 0; j < m.addedNodes.length; j++) {
            const added = m.addedNodes[j];
            if (targetInTooltip || isTooltipNode(added)) {
              try {
                scanSubtree(added);
              } catch {
                dirtyNodes.add(added);
              }
            } else {
              dirtyNodes.add(added);
            }
          }
        } else if (m.type === 'characterData' || m.type === 'attributes') {
          if (targetInTooltip) {
            try {
              scanSubtree(m.target);
            } catch {
              dirtyNodes.add(m.target);
            }
          } else {
            dirtyNodes.add(m.target);
          }
        }
      }
      if (dirtyNodes.size > 0) {
        scheduleFlush();
      }
    });
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: TRANSLATED_ATTRS,
    });
    dirtyFull = true;
    scheduleFlush();
  }

  function onReady() {
    syncJapaneseTypography(compiled.enabled && compiled.japaneseTypography);
    startObserver();
  }

  try {
    ipcRenderer.on('antigravity-ja:bundle-updated', (_event, nextBundle) => {
      applyBundle(nextBundle);
    });
    void ipcRenderer
      .invoke('antigravity-ja:get-bundle')
      .then((initialBundle) => {
        if (initialBundle) {
          applyBundle(initialBundle);
        }
      })
      .catch(() => undefined);
  } catch {
    // ignore IPC init error
  }

  if (g.document) {
    if (g.document.readyState === 'loading') {
      g.document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } else {
      onReady();
    }
  }
  g.addEventListener?.('load', onReady, { once: true });

  g.addEventListener?.(
    'keydown',
    (ev) => {
      if (!ev || !ev.ctrlKey || !ev.altKey || ev.metaKey) {
        return;
      }
      const key = String(ev.key || '').toLowerCase();
      if (key !== 'j' && ev.code !== 'KeyJ') {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      if (ev.shiftKey) {
        void ipcRenderer
          .invoke('antigravity-ja:toggle-collect')
          .then((res) => {
            if (res && res.bundle) {
              applyBundle(res.bundle);
            }
            const on = Boolean(res && res.collectUntranslated);
            showToast(on ? '未翻訳UIテキスト収集: ON' : '未翻訳UIテキスト収集: OFF');
          })
          .catch(() => undefined);
      } else {
        void ipcRenderer
          .invoke('antigravity-ja:toggle')
          .then((res) => {
            if (res && res.bundle) {
              applyBundle(res.bundle);
            }
            const on = Boolean(res && res.enabled);
            showToast(on ? '日本語UI: ON' : '日本語UI: OFF');
          })
          .catch(() => undefined);
      }
    },
    true
  );
})();
${PRELOAD_END_MARKER}`;
}

module.exports = {
  PRELOAD_START_MARKER,
  PRELOAD_END_MARKER,
  buildPreloadSnippet,
};
