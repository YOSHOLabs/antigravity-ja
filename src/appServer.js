'use strict';

const fs = require('fs');
const http = require('http');
const {
  buildAiTranslationPrompt,
  ensureUserDataDir,
  filterPendingUntranslatedItems,
  flattenExactMap,
  importCustomTranslations,
  loadBaseDictionary,
  loadGlossary,
  loadMergedBundle,
  pruneTranslatedFromUntranslated,
  readJsonSafe,
  writeJsonAtomic,
} = require('./dictionary');
const {
  createDesktopShortcuts,
  getShortcutPaths,
  launchAntigravity,
  openDirectoryInExplorer,
} = require('./launcher');
const { applyPatch, getStatus, restorePatch } = require('./patcher');
const { DEFAULT_AUTO_CONFIG, runAutoTranslateForUserDir, validateEndpointUrl } = require('./runtime/autoTranslator');
const { compileBundle } = require('./runtime/translatorCore');

const MAX_BODY_BYTES = 2 * 1024 * 1024;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function stripJsonCodeFences(rawText) {
  const trimmed = String(rawText || '').trim();
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function isLocalHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
}

function isRequestAllowed(req) {
  const headers = req && req.headers ? req.headers : {};
  if (typeof headers.host === 'string' && headers.host.trim()) {
    try {
      const hostUrl = new URL(`http://${headers.host.trim()}`);
      if (!isLocalHostname(hostUrl.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  if ((req.method === 'POST' || req.method === 'DELETE') && typeof headers.origin === 'string' && headers.origin.trim()) {
    try {
      const originUrl = new URL(headers.origin.trim());
      if (!isLocalHostname(originUrl.hostname)) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function getFilteredUntranslated(userDataDir, untranslatedItems) {
  const compiled = compileBundle(loadMergedBundle(userDataDir));
  return filterPendingUntranslatedItems(untranslatedItems, compiled).filtered;
}

function buildStatePayload(userDataDir, installDir) {
  const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
  const config = readJsonSafe(files.configPath, { ...DEFAULT_AUTO_CONFIG });
  const baseDict = readJsonSafe(files.baseDictPath, loadBaseDictionary());
  const auto = readJsonSafe(files.autoDictPath, { exact: {}, meta: {} });
  const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
  const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
  const glossary = loadGlossary();
  const status = getStatus({ installDir, userDataDir });
  const shortcuts = getShortcutPaths();

  const baseFlat = flattenExactMap(baseDict);
  const autoExact = auto && auto.exact && typeof auto.exact === 'object' && !Array.isArray(auto.exact) ? auto.exact : {};
  const customExact = custom && custom.exact && typeof custom.exact === 'object' ? custom.exact : {};
  const rawUntranslated =
    untranslated && untranslated.items && typeof untranslated.items === 'object' ? untranslated.items : {};
  const untranslatedItems = getFilteredUntranslated(userDataDir, rawUntranslated);

  return {
    userDataDir: files.dir,
    appStatus: {
      ...status,
      shortcutExists: fs.existsSync(shortcuts.launchShortcut),
      launchShortcutPath: shortcuts.launchShortcut,
    },
    config: {
      enabled: config?.enabled !== false,
      collectUntranslated: Boolean(config?.collectUntranslated),
      autoCollectTooltips: config?.autoCollectTooltips !== false,
      japaneseTypography: config?.japaneseTypography !== false,
      autoTranslate: config?.autoTranslate !== false,
      autoTranslateProvider:
        typeof config?.autoTranslateProvider === 'string' &&
        ['free', 'gemini', 'openai', 'ollama'].includes(config.autoTranslateProvider)
          ? config.autoTranslateProvider
          : 'free',
      autoTranslateModel: typeof config?.autoTranslateModel === 'string' ? config.autoTranslateModel : '',
      autoTranslateEndpoint: typeof config?.autoTranslateEndpoint === 'string' ? config.autoTranslateEndpoint : '',
      hasApiKey: Boolean(typeof config?.autoTranslateApiKey === 'string' && config.autoTranslateApiKey.trim()),
    },
    categories: baseDict.categories || {},
    basePatterns: Array.isArray(baseDict.patterns) ? baseDict.patterns : [],
    auto: {
      exact: autoExact,
    },
    custom: {
      exact: customExact,
      patterns: Array.isArray(custom.patterns) ? custom.patterns : [],
      ignored: Array.isArray(custom.ignored) ? custom.ignored : [],
    },
    untranslated: untranslatedItems,
    glossary,
    stats: {
      baseCount: Object.keys(baseFlat).length,
      basePatternCount: Array.isArray(baseDict.patterns) ? baseDict.patterns.length : 0,
      autoCount: Object.keys(autoExact).length,
      customExactCount: Object.keys(customExact).length,
      customPatternCount: Array.isArray(custom.patterns) ? custom.patterns.length : 0,
      ignoredCount: Array.isArray(custom.ignored) ? custom.ignored.length : 0,
      untranslatedCount: Object.keys(untranslatedItems).length,
    },
  };
}

function renderAppHtml() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Antigravity 日本語化マネージャー</title>
<style>
  :root {
    --bg: #0c0d10;
    --surface: #14161c;
    --surface-2: #1c1f28;
    --border: rgba(255, 255, 255, 0.1);
    --text: #f3f4f6;
    --muted: #9ca3af;
    --accent: #60a5fa;
    --accent-strong: #3b82f6;
    --ok: #34d399;
    --warn: #fbbf24;
    --danger: #f87171;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Yu Gothic UI", "Meiryo", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
  }
  .container {
    max-width: 1120px;
    margin: 0 auto;
    padding: 22px 20px 60px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 18px;
  }
  h1 {
    font-size: 20px;
    margin: 0 0 4px;
    font-weight: 600;
  }
  .subtitle {
    color: var(--muted);
    font-size: 13px;
  }
  .controls-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 5px 12px;
    font-size: 12px;
    color: var(--muted);
  }
  .pill strong { color: var(--text); }
  .pill.ok {
    background: rgba(52, 211, 153, 0.14);
    border-color: rgba(52, 211, 153, 0.45);
    color: #a7f3d0;
  }
  .pill.warn {
    background: rgba(251, 191, 36, 0.14);
    border-color: rgba(251, 191, 36, 0.45);
    color: #fde68a;
  }
  .switch-btn {
    cursor: pointer;
    border: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    border-radius: 999px;
    padding: 6px 14px;
    font-size: 12px;
    font-weight: 500;
    transition: background .15s, border-color .15s;
  }
  .switch-btn.on {
    background: rgba(52, 211, 153, 0.16);
    border-color: rgba(52, 211, 153, 0.5);
    color: #a7f3d0;
  }
  .tabs {
    display: flex;
    gap: 8px;
    margin-bottom: 18px;
    flex-wrap: wrap;
  }
  .tab {
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 8px 16px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
  }
  .tab.active {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
    color: #fff;
  }
  .tab-count {
    display: inline-block;
    margin-left: 6px;
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    background: rgba(255,255,255,0.16);
    color: #fff;
  }
  .panel { display: none; }
  .panel.active { display: block; }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    margin-bottom: 16px;
  }
  .status-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .stat-box {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .stat-label {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .stat-val {
    font-size: 14px;
    font-weight: 600;
  }
  .action-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 10px;
  }
  .action-btn {
    padding: 11px 14px;
    font-size: 13px;
    text-align: center;
  }
  .notice-box {
    display: none;
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 8px;
    background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.45);
    color: #fde68a;
    font-size: 13px;
  }
  .notice-box.show { display: block; }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
    margin-bottom: 14px;
  }
  input[type="text"], input[type="password"], select, textarea {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 8px 10px;
    font-size: 13px;
    font-family: inherit;
  }
  input[type="text"]:focus, input[type="password"]:focus, select:focus, textarea:focus {
    outline: none;
    border-color: var(--accent);
  }
  textarea {
    width: 100%;
    min-height: 220px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  button {
    cursor: pointer;
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 7px 12px;
    font-size: 12px;
    font-weight: 500;
  }
  button:hover:not(:disabled) { border-color: rgba(255,255,255,0.28); }
  button:disabled { opacity: 0.6; cursor: wait; }
  button.primary {
    background: var(--accent-strong);
    border-color: var(--accent-strong);
    color: #fff;
  }
  button.danger {
    color: #fecaca;
    border-color: rgba(248, 113, 113, 0.35);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 10px 8px;
    border-bottom: 1px solid var(--border);
    vertical-align: middle;
  }
  th {
    color: var(--muted);
    font-weight: 500;
    font-size: 12px;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--surface-2);
    color: var(--muted);
    border: 1px solid var(--border);
  }
  .badge.custom {
    background: rgba(96, 165, 250, 0.16);
    border-color: rgba(96, 165, 250, 0.4);
    color: #bfdbfe;
  }
  .badge.auto {
    background: rgba(168, 85, 247, 0.16);
    border-color: rgba(168, 85, 247, 0.45);
    color: #e9d5ff;
  }
  .row-actions {
    display: flex;
    gap: 6px;
    white-space: nowrap;
  }
  .toast {
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #18181b;
    color: #f4f4f5;
    border: 1px solid rgba(255,255,255,0.16);
    border-radius: 8px;
    padding: 10px 16px;
    font-size: 13px;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    opacity: 0;
    transform: translateY(8px);
    transition: opacity .15s, transform .15s;
    pointer-events: none;
    z-index: 9999;
  }
  .toast.show { opacity: 1; transform: translateY(0); }
  .empty {
    color: var(--muted);
    text-align: center;
    padding: 28px 12px;
    font-size: 13px;
  }
  kbd {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 6px;
    font-size: 11px;
    font-family: ui-monospace, monospace;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <div>
      <h1>Antigravity 日本語化マネージャー</h1>
      <div class="subtitle">パッチ管理・自動起動ショートカット・ライブ辞書編集（保存先: <span id="userDir" class="mono"></span>）</div>
    </div>
    <div class="controls-bar">
      <span id="hdrPatchPill" class="pill">確認中...</span>
      <span class="pill">基本辞書 <strong id="statBase">0</strong></span>
      <span class="pill">自動翻訳 <strong id="statAuto">0</strong></span>
      <span class="pill">カスタム <strong id="statCustom">0</strong></span>
      <span class="pill">未翻訳 <strong id="statUntranslated">0</strong></span>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab active" data-tab="home">ホーム（管理）</button>
    <button class="tab" data-tab="untranslated">未翻訳UI<span id="tabUntranslatedCount" class="tab-count">0</span></button>
    <button class="tab" data-tab="dictionary">翻訳辞書（編集・検索）</button>
    <button class="tab" data-tab="import">インポート / エクスポート</button>
    <button class="tab" data-tab="glossary">用語集 &amp; 使い方</button>
  </nav>

  <section id="tab-home" class="panel active">
    <div class="card">
      <div class="status-grid">
        <div class="stat-box">
          <div class="stat-label">Antigravity 本体</div>
          <div id="stAppVer" class="stat-val">-</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">日本語UI パッチ状態</div>
          <div id="stPatched" class="stat-val">-</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">元のバックアップ / 起動状態</div>
          <div id="stBackupRun" class="stat-val">-</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">デスクトップ自動起動ショートカット</div>
          <div id="stShortcut" class="stat-val">-</div>
        </div>
      </div>

      <div class="action-grid">
        <button id="btnLaunchJa" class="primary action-btn">日本語で Antigravity を起動</button>
        <button id="btnApplyPatch" class="action-btn">日本語化を適用 / 再適用</button>
        <button id="btnSyncDict" class="action-btn">最新辞書を同期（再起動不要）</button>
        <button id="btnCreateShortcut" class="action-btn">デスクトップにショートカット作成</button>
        <button id="btnOpenUserDir" class="action-btn">辞書フォルダを開く</button>
        <button id="btnRestorePatch" class="danger action-btn">元の英語UIに戻す</button>
      </div>

      <div id="homeNotice" class="notice-box"></div>
    </div>

    <div class="card">
      <h2 style="margin-top:0;font-size:15px">ライブ表示・収集設定（Antigravity に即時反映）</h2>
      <div class="toolbar" style="margin-bottom:8px">
        <button id="btnToggleEnabled" class="switch-btn">日本語UI: -</button>
        <button id="btnToggleTooltipCollect" class="switch-btn">ツールチップ自動収集: -</button>
        <button id="btnToggleCollect" class="switch-btn">画面全体の未翻訳収集: -</button>
        <button id="btnToggleTypography" class="switch-btn">日本語フォント最適化 (lang=ja): -</button>
      </div>
      <div class="subtitle">
        本体アップデートで英語に戻ったときも、デスクトップの「Antigravity (日本語)」または上の「日本語で Antigravity を起動」から開けば、自動で「日本語化中...」を表示して日本語版へ戻します。
      </div>
    </div>

    <div class="card">
      <div class="toolbar" style="justify-content:space-between;margin-bottom:10px">
        <div>
          <h2 style="margin:0;font-size:15px">アプデ新UI 自動発見＆自動翻訳</h2>
          <div class="subtitle">新しい英語UIやツールチップを自動で発見・翻訳して <span class="mono">auto.json</span> にキャッシュします（チャット本文・コード・パスは送信しません）。</div>
        </div>
        <span id="autoCachePill" class="pill">自動翻訳キャッシュ <strong id="stAutoCacheCount">0</strong> 件</span>
      </div>
      <div class="toolbar" style="margin-bottom:10px">
        <button id="btnToggleAutoTranslate" class="switch-btn">新UI自動翻訳: -</button>
        <select id="autoProvider">
          <option value="free">無料翻訳（APIキー不要）</option>
          <option value="gemini">Gemini API（より自然なUI訳）</option>
          <option value="openai">OpenAI API（GPT）</option>
          <option value="ollama">ローカル Ollama（完全オフライン）</option>
        </select>
        <button id="btnRunAutoTranslate" class="primary">未翻訳UIを今すぐ自動翻訳</button>
        <button id="btnClearAutoCache" class="danger">自動キャッシュをクリア</button>
      </div>
      <div id="autoProviderCreds" class="toolbar" style="display:none;margin-bottom:0">
        <input id="autoApiKey" type="password" placeholder="APIキー (未入力なら既存設定/環境変数を維持)" style="flex:1;min-width:220px" />
        <input id="autoModel" type="text" placeholder="モデル名 (省略可: 例 gemini-2.5-flash)" style="width:230px" />
        <input id="autoEndpoint" type="text" placeholder="エンドポイントURL (省略可)" style="flex:1;min-width:220px" />
        <button id="btnSaveAutoConfig" class="primary">翻訳エンジン設定を保存</button>
      </div>
    </div>
  </section>

  <section id="tab-untranslated" class="panel">
    <div class="card">
      <div class="toolbar">
        <button id="btnCopyAiPrompt" class="primary">AI一括翻訳用プロンプトをコピー</button>
        <button id="btnRefresh">再読み込み</button>
        <button id="btnClearUntranslated" class="danger">収集リストをクリア</button>
        <span class="subtitle">Antigravity 内で <kbd>Ctrl+Alt+Shift+J</kbd> を押すと画面全体の未翻訳UIテキストも収集できます。</span>
      </div>
      <div id="untranslatedWrap"></div>
    </div>
  </section>

  <section id="tab-dictionary" class="panel">
    <div class="card">
      <div class="toolbar">
        <input id="newEn" type="text" placeholder="英語原文 (例: New Conversation)" style="flex:1;min-width:200px" />
        <input id="newJa" type="text" placeholder="自然な日本語訳 (例: 新しい会話)" style="flex:1;min-width:200px" />
        <button id="btnAddEntry" class="primary">新規追加 / 上書き</button>
      </div>
      <div class="toolbar">
        <input id="searchQuery" type="text" placeholder="英語・日本語で検索..." style="flex:1;min-width:220px" />
        <select id="categoryFilter"></select>
        <label class="pill" style="cursor:pointer">
          <input id="onlyCustom" type="checkbox" /> カスタム上書きのみ
        </label>
      </div>
      <div id="dictWrap"></div>
    </div>
  </section>

  <section id="tab-import" class="panel">
    <div class="card">
      <div class="toolbar">
        <button id="btnImportJson" class="primary">JSONをマージして即時反映</button>
        <button id="btnExportCustom">カスタム辞書をダウンロード (.json)</button>
      </div>
      <p class="subtitle">AI一括翻訳で生成した <code>{ "English": "自然な日本語" }</code> 形式のJSONを貼り付けて反映できます（<code>&#96;&#96;&#96;json</code> コードブロックも自動除去します）。</p>
      <textarea id="importTextarea" placeholder='{\n  "New Conversation": "新しい会話"\n}'></textarea>
    </div>
  </section>

  <section id="tab-glossary" class="panel">
    <div class="card">
      <h2 style="margin-top:0;font-size:16px">ショートカット &amp; 操作ガイド</h2>
      <ul>
        <li><strong>デスクトップ「Antigravity (日本語)」</strong>：未適用／アプデ後は自動で「日本語化中...」を表示してパッチ適用＆起動（適用済みなら即起動）</li>
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>J</kbd>：Antigravity 画面上で日本語UI / 英語UIを即座に切り替え</li>
        <li><kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>J</kbd>：画面全体の未翻訳UIテキスト収集 ON/OFF 切り替え</li>
        <li>タスクトレイのアイコンを右クリック → <strong>「日本語UI」</strong> からも各種切り替え・辞書再読み込み・フォルダ表示ができます。</li>
      </ul>
    </div>
    <div class="card">
      <h2 style="margin-top:0;font-size:16px">自然な日本語翻訳ガイドライン</h2>
      <ul id="guidelinesList"></ul>
      <h3 style="font-size:14px;margin-top:18px">標準用語集</h3>
      <div id="glossaryWrap"></div>
    </div>
  </section>
</div>
<div id="toast" class="toast"></div>

<script>
(function () {
  let state = null;
  let toastTimer = null;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function showNotice(msg) {
    const box = document.getElementById('homeNotice');
    if (!msg) {
      box.textContent = '';
      box.classList.remove('show');
      return;
    }
    box.textContent = msg;
    box.classList.add('show');
  }

  function runSafe(fn) {
    Promise.resolve().then(fn).catch((err) => {
      showToast('エラー: ' + (err && err.message ? err.message : String(err)));
    });
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function renderHeaderAndHome() {
    document.getElementById('userDir').textContent = state.userDataDir || '';
    document.getElementById('statBase').textContent = state.stats.baseCount;
    document.getElementById('statAuto').textContent = state.stats.autoCount || 0;
    document.getElementById('statCustom').textContent = state.stats.customExactCount;
    document.getElementById('statUntranslated').textContent = state.stats.untranslatedCount;
    document.getElementById('tabUntranslatedCount').textContent = state.stats.untranslatedCount;
    document.getElementById('stAutoCacheCount').textContent = state.stats.autoCount || 0;

    const app = state.appStatus || {};
    const pill = document.getElementById('hdrPatchPill');
    if (!app.installed) {
      pill.textContent = 'Antigravity 未検出';
      pill.className = 'pill warn';
    } else if (app.patched) {
      pill.textContent = '日本語UI 適用済み (v' + (app.appVersion || '-') + ')';
      pill.className = 'pill ok';
    } else {
      pill.textContent = '未適用 / アプデ後英語 (v' + (app.appVersion || '-') + ')';
      pill.className = 'pill warn';
    }

    document.getElementById('stAppVer').textContent = app.installed
      ? 'v' + (app.appVersion || '-')
      : '見つかりません';
    document.getElementById('stPatched').textContent = app.patched
      ? '適用済み（日本語有効）'
      : '未適用（要パッチ適用）';
    document.getElementById('stPatched').style.color = app.patched ? '#34d399' : '#fbbf24';

    const backupLabel = app.backupExists ? (app.backupValid ? '正常' : '要確認') : '未作成';
    const runLabel = app.antigravityRunning ? '起動中' : '停止中';
    document.getElementById('stBackupRun').textContent = backupLabel + ' / ' + runLabel;

    document.getElementById('stShortcut').textContent = app.shortcutExists ? '作成済み' : '未作成';

    const btnEnabled = document.getElementById('btnToggleEnabled');
    btnEnabled.textContent = state.config.enabled ? '日本語UI: ON' : '日本語UI: OFF';
    btnEnabled.classList.toggle('on', state.config.enabled);

    const btnCollect = document.getElementById('btnToggleCollect');
    btnCollect.textContent = state.config.collectUntranslated ? '画面全体の未翻訳収集: ON' : '画面全体の未翻訳収集: OFF';
    btnCollect.classList.toggle('on', state.config.collectUntranslated);

    const btnTip = document.getElementById('btnToggleTooltipCollect');
    btnTip.textContent = state.config.autoCollectTooltips ? 'ツールチップ自動収集: ON' : 'ツールチップ自動収集: OFF';
    btnTip.classList.toggle('on', state.config.autoCollectTooltips);

    const btnTypo = document.getElementById('btnToggleTypography');
    btnTypo.textContent = state.config.japaneseTypography ? '日本語フォント最適化 (lang=ja): ON' : '日本語フォント最適化 (lang=ja): OFF';
    btnTypo.classList.toggle('on', state.config.japaneseTypography);

    const btnAutoTr = document.getElementById('btnToggleAutoTranslate');
    btnAutoTr.textContent = state.config.autoTranslate ? '新UI自動翻訳: ON' : '新UI自動翻訳: OFF';
    btnAutoTr.classList.toggle('on', state.config.autoTranslate);

    const provEl = document.getElementById('autoProvider');
    const prov = state.config.autoTranslateProvider || 'free';
    provEl.value = prov;
    const credsEl = document.getElementById('autoProviderCreds');
    credsEl.style.display = prov === 'free' ? 'none' : 'flex';
    const keyInput = document.getElementById('autoApiKey');
    keyInput.style.display = prov === 'ollama' ? 'none' : '';
    keyInput.placeholder = state.config.hasApiKey
      ? 'APIキー設定済み（変更時のみ入力）'
      : 'APIキー (未入力なら環境変数を使用)';
    const modelInput = document.getElementById('autoModel');
    if (document.activeElement !== modelInput) {
      modelInput.value = state.config.autoTranslateModel || '';
    }
    const epInput = document.getElementById('autoEndpoint');
    if (document.activeElement !== epInput) {
      epInput.value = state.config.autoTranslateEndpoint || '';
    }
  }

  function renderUntranslated() {
    const wrap = document.getElementById('untranslatedWrap');
    const entries = Object.entries(state.untranslated || {}).sort(
      (a, b) => (b[1].inTooltip ? 1 : 0) - (a[1].inTooltip ? 1 : 0) || (b[1].count || 0) - (a[1].count || 0) || a[0].localeCompare(b[0])
    );
    if (entries.length === 0) {
      wrap.innerHTML = '<div class="empty">未翻訳のUIテキストはまだ収集されていません。</div>';
      return;
    }
    const rows = entries.map(([text, meta]) => {
      const ctx = []
        .concat(meta.tags || [])
        .concat(meta.roles ? meta.roles.map((r) => 'role=' + r) : [])
        .concat(meta.attrs ? meta.attrs.map((a) => 'attr=' + a) : [])
        .join(', ');
      const tipBadge = meta.inTooltip ? '<span class="badge custom">ツールチップ</span> ' : '';
      return (
        '<tr data-en="' + escHtml(text) + '">' +
          '<td class="mono">' + tipBadge + escHtml(text) + '<div class="subtitle">' + escHtml(ctx || '-') + ' (' + (meta.count || 1) + '回)</div></td>' +
          '<td><input type="text" class="ja-input" placeholder="日本語訳を入力..." style="width:100%" /></td>' +
          '<td class="row-actions">' +
            '<button class="primary act-save">保存</button>' +
            '<button class="act-ignore">無視</button>' +
          '</td>' +
        '</tr>'
      );
    }).join('');
    wrap.innerHTML = '<table><thead><tr><th style="width:42%">英語テキスト / 文脈</th><th>日本語訳</th><th style="width:130px">操作</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderCategoryFilter() {
    const sel = document.getElementById('categoryFilter');
    const prev = sel.value || 'all';
    const opts = [
      '<option value="all">すべてのカテゴリ</option>',
      '<option value="custom">カスタムのみ</option>',
      '<option value="auto">自動翻訳のみ</option>',
    ];
    for (const [id, cat] of Object.entries(state.categories || {})) {
      opts.push('<option value="' + escHtml(id) + '">' + escHtml(cat.label || id) + '</option>');
    }
    sel.innerHTML = opts.join('');
    sel.value = prev;
  }

  function renderDictionary() {
    const q = document.getElementById('searchQuery').value.trim().toLowerCase();
    const catFilter = document.getElementById('categoryFilter').value;
    const onlyCustom = document.getElementById('onlyCustom').checked;
    const customExact = state.custom.exact || {};
    const autoExact = (state.auto && state.auto.exact) || {};
    const rowsData = [];
    const seen = new Set();

    for (const [catId, cat] of Object.entries(state.categories || {})) {
      for (const [en, baseJa] of Object.entries(cat.exact || {})) {
        seen.add(en);
        const isCustom = Object.prototype.hasOwnProperty.call(customExact, en);
        const currentJa = isCustom ? customExact[en] : baseJa;
        rowsData.push({ en, ja: currentJa, baseJa, catId, catLabel: cat.label || catId, isCustom, isAuto: false });
      }
    }
    for (const [en, autoJa] of Object.entries(autoExact)) {
      if (!seen.has(en)) {
        seen.add(en);
        const isCustom = Object.prototype.hasOwnProperty.call(customExact, en);
        const currentJa = isCustom ? customExact[en] : autoJa;
        rowsData.push({
          en,
          ja: currentJa,
          baseJa: isCustom ? autoJa : null,
          catId: isCustom ? 'custom' : 'auto',
          catLabel: isCustom ? 'カスタム追加' : '自動翻訳',
          isCustom,
          isAuto: !isCustom,
        });
      }
    }
    for (const [en, ja] of Object.entries(customExact)) {
      if (!seen.has(en)) {
        rowsData.push({ en, ja, baseJa: null, catId: 'custom', catLabel: 'カスタム追加', isCustom: true, isAuto: false });
      }
    }

    const filtered = rowsData.filter((r) => {
      if (onlyCustom && !r.isCustom) return false;
      if (catFilter !== 'all') {
        if (catFilter === 'custom' && !r.isCustom) return false;
        if (catFilter === 'auto' && !r.isAuto) return false;
        if (catFilter !== 'custom' && catFilter !== 'auto' && r.catId !== catFilter) return false;
      }
      if (q) {
        return r.en.toLowerCase().includes(q) || r.ja.toLowerCase().includes(q);
      }
      return true;
    });

    const wrap = document.getElementById('dictWrap');
    if (filtered.length === 0) {
      wrap.innerHTML = '<div class="empty">条件に一致する項目がありません。</div>';
      return;
    }

    const html = filtered.slice(0, 300).map((r) => {
      const badge = r.isCustom
        ? '<span class="badge custom">カスタム</span>'
        : r.isAuto
          ? '<span class="badge auto">自動翻訳</span>'
          : '<span class="badge">' + escHtml(r.catLabel) + '</span>';
      const resetBtn = r.isCustom
        ? '<button class="danger act-reset">' + (r.baseJa ? '元に戻す' : '削除') + '</button>'
        : r.isAuto
          ? '<button class="danger act-reset-auto">削除</button>'
          : '';
      return (
        '<tr data-en="' + escHtml(r.en) + '">' +
          '<td class="mono">' + escHtml(r.en) + '<div>' + badge + '</div></td>' +
          '<td><input type="text" class="ja-input" value="' + escHtml(r.ja) + '" style="width:100%" /></td>' +
          '<td class="row-actions"><button class="primary act-save">保存</button>' + resetBtn + '</td>' +
        '</tr>'
      );
    }).join('');
    const note = filtered.length > 300 ? '<div class="subtitle" style="margin-top:8px">上位300件を表示中（全' + filtered.length + '件）</div>' : '';
    wrap.innerHTML = '<table><thead><tr><th style="width:42%">原文</th><th>日本語訳</th><th style="width:150px">操作</th></tr></thead><tbody>' + html + '</tbody></table>' + note;
  }

  function renderGlossary() {
    const g = state.glossary || {};
    document.getElementById('guidelinesList').innerHTML = (g.toneGuidelines || [])
      .map((line) => '<li>' + escHtml(line) + '</li>')
      .join('');
    const rows = (g.terms || [])
      .map((t) => '<tr><td class="mono">' + escHtml(t.en) + '</td><td>' + escHtml(t.ja) + '</td><td class="subtitle">' + escHtml(t.note || '') + '</td></tr>')
      .join('');
    document.getElementById('glossaryWrap').innerHTML =
      '<table><thead><tr><th>英語</th><th>標準訳</th><th>補足</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderAll() {
    renderHeaderAndHome();
    renderUntranslated();
    renderCategoryFilter();
    renderDictionary();
    renderGlossary();
  }

  async function refreshState() {
    state = await api('GET', '/api/state');
    renderAll();
  }

  async function withBusyButton(btn, busyLabel, actionFn) {
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyLabel;
    showNotice('');
    try {
      await actionFn();
    } catch (err) {
      if (err && err.code === 'ANTIGRAVITY_RUNNING') {
        showNotice('Antigravity が起動中のため変更できません。画面右下のタスクトレイアイコンを右クリック →「Quit」で完全終了してからもう一度押してください。');
      }
      showToast('エラー: ' + (err && err.message ? err.message : String(err)));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('btnLaunchJa').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    void withBusyButton(btn, '日本語化中...', async () => {
      const res = await api('POST', '/api/action/launch', {});
      await refreshState();
      if (res.launched) {
        showToast(res.patchedNow ? '日本語化を適用して起動しました' : 'Antigravity を起動しました');
      } else if (res.cancelled) {
        showToast('起動をキャンセルしました');
      }
    });
  });

  document.getElementById('btnApplyPatch').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    void withBusyButton(btn, '日本語化中...', async () => {
      const res = await api('POST', '/api/action/apply', {});
      await refreshState();
      showToast('日本語化パッチを適用しました (v' + (res.appVersion || '-') + ')');
    });
  });

  document.getElementById('btnSyncDict').addEventListener('click', () => runSafe(async () => {
    const res = await api('POST', '/api/action/sync', {});
    await refreshState();
    showToast('基本辞書を同期しました' + (res.removed > 0 ? '（未翻訳 ' + res.removed + '件整理）' : ''));
  }));

  document.getElementById('btnCreateShortcut').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/action/create-shortcut', {});
    await refreshState();
    showToast('デスクトップに「Antigravity (日本語)」ショートカットを作成しました');
  }));

  document.getElementById('btnOpenUserDir').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/action/open-user-dir', {});
    showToast('辞書フォルダを開きました');
  }));

  document.getElementById('btnRestorePatch').addEventListener('click', (ev) => {
    if (!confirm('バックアップから元の英語UIへ復元しますか？')) return;
    const btn = ev.currentTarget;
    void withBusyButton(btn, '復元中...', async () => {
      await api('POST', '/api/action/restore', {});
      await refreshState();
      showToast('元の英語UIへ復元しました');
    });
  });

  document.getElementById('btnToggleEnabled').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/config', { enabled: !state.config.enabled });
    await refreshState();
    showToast(state.config.enabled ? '日本語UIを有効にしました' : '日本語UIを無効にしました');
  }));

  document.getElementById('btnToggleCollect').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/config', { collectUntranslated: !state.config.collectUntranslated });
    await refreshState();
    showToast(state.config.collectUntranslated ? '未翻訳UI収集をONにしました' : '未翻訳UI収集をOFFにしました');
  }));

  document.getElementById('btnToggleTooltipCollect').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/config', { autoCollectTooltips: !state.config.autoCollectTooltips });
    await refreshState();
    showToast(state.config.autoCollectTooltips ? 'ツールチップ自動収集をONにしました' : 'ツールチップ自動収集をOFFにしました');
  }));

  document.getElementById('btnToggleTypography').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/config', { japaneseTypography: !state.config.japaneseTypography });
    await refreshState();
    showToast(state.config.japaneseTypography ? '日本語フォント最適化をONにしました' : '日本語フォント最適化をOFFにしました');
  }));

  document.getElementById('btnToggleAutoTranslate').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/config', { autoTranslate: !state.config.autoTranslate });
    await refreshState();
    showToast(state.config.autoTranslate ? '新UI自動翻訳をONにしました' : '新UI自動翻訳をOFFにしました');
  }));

  document.getElementById('autoProvider').addEventListener('change', (ev) => runSafe(async () => {
    const provider = ev.target.value;
    document.getElementById('autoProviderCreds').style.display = provider === 'free' ? 'none' : 'flex';
    await api('POST', '/api/config', { autoTranslateProvider: provider });
    await refreshState();
    showToast('自動翻訳エンジンを切り替えました: ' + provider);
  }));

  document.getElementById('btnSaveAutoConfig').addEventListener('click', () => runSafe(async () => {
    const provider = document.getElementById('autoProvider').value;
    const apiKey = document.getElementById('autoApiKey').value.trim();
    const model = document.getElementById('autoModel').value.trim();
    const endpoint = document.getElementById('autoEndpoint').value.trim();
    const payload = {
      autoTranslateProvider: provider,
      autoTranslateModel: model,
      autoTranslateEndpoint: endpoint,
    };
    if (apiKey) {
      payload.autoTranslateApiKey = apiKey;
      document.getElementById('autoApiKey').value = '';
    }
    await api('POST', '/api/config', payload);
    await refreshState();
    showToast('自動翻訳エンジンの設定を保存しました');
  }));

  document.getElementById('btnRunAutoTranslate').addEventListener('click', (ev) => {
    const btn = ev.currentTarget;
    void withBusyButton(btn, '自動翻訳中...', async () => {
      const res = await api('POST', '/api/action/auto-translate', {});
      await refreshState();
      if (res.error) {
        showToast('自動翻訳エラー: ' + res.error);
      } else {
        showToast('自動翻訳完了: ' + (res.translated || 0) + '件を反映しました');
      }
    });
  });

  document.getElementById('btnClearAutoCache').addEventListener('click', () => runSafe(async () => {
    if (!confirm('自動翻訳キャッシュ (auto.json) をクリアしますか？')) return;
    await api('POST', '/api/action/clear-auto', {});
    await refreshState();
    showToast('自動翻訳キャッシュをクリアしました');
  }));

  document.getElementById('btnRefresh').addEventListener('click', () => runSafe(async () => {
    await refreshState();
    showToast('再読み込みしました');
  }));

  document.getElementById('btnClearUntranslated').addEventListener('click', () => runSafe(async () => {
    await api('POST', '/api/clear-untranslated', {});
    await refreshState();
    showToast('収集リストをクリアしました');
  }));

  document.getElementById('btnCopyAiPrompt').addEventListener('click', () => runSafe(async () => {
    const data = await api('GET', '/api/ai-prompt');
    try {
      await navigator.clipboard.writeText(data.prompt);
      showToast('AI翻訳プロンプトをクリップボードにコピーしました');
    } catch {
      document.getElementById('importTextarea').value = data.prompt;
      showToast('クリップボードへコピーできないため、インポート欄に出力しました');
    }
  }));

  document.getElementById('btnAddEntry').addEventListener('click', () => runSafe(async () => {
    const en = document.getElementById('newEn').value.trim();
    const ja = document.getElementById('newJa').value.trim();
    if (!en || !ja) {
      showToast('原文と日本語訳の両方を入力してください');
      return;
    }
    await api('POST', '/api/custom', { en, ja });
    document.getElementById('newEn').value = '';
    document.getElementById('newJa').value = '';
    await refreshState();
    showToast('保存して即時反映しました');
  }));

  document.getElementById('newJa').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing) {
      ev.preventDefault();
      document.getElementById('btnAddEntry').click();
    }
  });

  document.getElementById('searchQuery').addEventListener('input', renderDictionary);
  document.getElementById('categoryFilter').addEventListener('change', renderDictionary);
  document.getElementById('onlyCustom').addEventListener('change', renderDictionary);

  function bindTableEnterSubmit(containerId) {
    document.getElementById(containerId).addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || !ev.target.classList.contains('ja-input')) return;
      const tr = ev.target.closest('tr[data-en]');
      const saveBtn = tr && tr.querySelector('.act-save');
      if (saveBtn) {
        ev.preventDefault();
        saveBtn.click();
      }
    });
  }

  document.getElementById('untranslatedWrap').addEventListener('click', (ev) => runSafe(async () => {
    const tr = ev.target.closest('tr[data-en]');
    if (!tr) return;
    const en = tr.dataset.en;
    if (ev.target.classList.contains('act-save')) {
      const ja = tr.querySelector('.ja-input').value.trim();
      if (!ja) { showToast('日本語訳を入力してください'); return; }
      await api('POST', '/api/custom', { en, ja });
      await refreshState();
      showToast('翻訳を保存しました');
    } else if (ev.target.classList.contains('act-ignore')) {
      await api('POST', '/api/ignore', { en });
      await refreshState();
      showToast('無視リストに追加しました');
    }
  }));

  document.getElementById('dictWrap').addEventListener('click', (ev) => runSafe(async () => {
    const tr = ev.target.closest('tr[data-en]');
    if (!tr) return;
    const en = tr.dataset.en;
    if (ev.target.classList.contains('act-save')) {
      const ja = tr.querySelector('.ja-input').value.trim();
      if (!ja) { showToast('日本語訳を入力してください'); return; }
      await api('POST', '/api/custom', { en, ja });
      await refreshState();
      showToast('辞書を更新しました');
    } else if (ev.target.classList.contains('act-reset')) {
      await api('DELETE', '/api/custom', { en });
      await refreshState();
      showToast('カスタム上書きを解除しました');
    } else if (ev.target.classList.contains('act-reset-auto')) {
      await api('DELETE', '/api/custom', { en, source: 'auto' });
      await refreshState();
      showToast('自動翻訳エントリを削除しました');
    }
  }));

  bindTableEnterSubmit('untranslatedWrap');
  bindTableEnterSubmit('dictWrap');

  document.getElementById('btnImportJson').addEventListener('click', () => runSafe(async () => {
    const raw = document.getElementById('importTextarea').value;
    if (!raw.trim()) { showToast('JSONを入力してください'); return; }
    const res = await api('POST', '/api/import', { json: raw });
    await refreshState();
    showToast('追加 ' + res.added + '件 / 更新 ' + res.updated + '件 を反映しました');
  }));

  document.getElementById('btnExportCustom').addEventListener('click', () => {
    window.location.href = '/api/export';
  });

  setInterval(() => {
    void fetch('/api/ping').catch(() => undefined);
  }, 5000);

  window.addEventListener('pagehide', () => {
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/bye', '{}');
      }
    } catch {
      // ignore
    }
  });

  runSafe(refreshState);
})();
</script>
</body>
</html>`;
}

/**
 * Creates the HTTP request handler for the unified Japanese control app & dictionary editor.
 * @param {string} [userDataDir]
 * @param {{ installDir?: string, onActivity?: () => void, onClientBye?: () => void }} [options]
 */
function createAppHandler(userDataDir, options = {}) {
  const installDir = options.installDir;
  ensureUserDataDir(userDataDir, { refreshBaseDict: false });

  return async (req, res) => {
    if (!isRequestAllowed(req)) {
      sendJson(res, 403, { error: 'Forbidden origin' });
      return;
    }

    if (typeof options.onActivity === 'function') {
      options.onActivity();
    }

    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = urlObj.pathname;

    try {
      if (req.method === 'GET' && pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(renderAppHtml());
        return;
      }

      if (req.method === 'GET' && pathname === '/api/ping') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/bye') {
        if (typeof options.onClientBye === 'function') {
          options.onClientBye();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/state') {
        sendJson(res, 200, buildStatePayload(userDataDir, installDir));
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/apply') {
        try {
          const result = applyPatch({ installDir, userDataDir });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const isRunning = msg.includes('起動中') || err.code === 'EBUSY' || err.code === 'EPERM';
          sendJson(res, isRunning ? 409 : 400, {
            error: msg,
            code: isRunning ? 'ANTIGRAVITY_RUNNING' : 'APPLY_FAILED',
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/restore') {
        try {
          const result = restorePatch({ installDir });
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          const isRunning = msg.includes('起動中') || err.code === 'EBUSY' || err.code === 'EPERM';
          sendJson(res, isRunning ? 409 : 400, {
            error: msg,
            code: isRunning ? 'ANTIGRAVITY_RUNNING' : 'RESTORE_FAILED',
          });
        }
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/sync') {
        ensureUserDataDir(userDataDir, { refreshBaseDict: true });
        const pruned = pruneTranslatedFromUntranslated(userDataDir);
        sendJson(res, 200, { ok: true, ...pruned });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/launch') {
        const resLaunch = await launchAntigravity({ installDir, userDataDir, gui: true, _fetch: options._fetch });
        sendJson(res, 200, { ok: true, ...resLaunch });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/auto-translate') {
        const resAuto = await runAutoTranslateForUserDir(userDataDir, {
          maxItems: 60,
          timeoutMs: 15000,
          force: true,
          glossary: loadGlossary(),
          _fetch: options._fetch,
        });
        sendJson(res, 200, { ok: true, ...resAuto });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/clear-auto') {
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        writeJsonAtomic(files.autoDictPath, { exact: {}, meta: {} });
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/create-shortcut') {
        const body = await readRequestBody(req);
        const resShortcut = createDesktopShortcuts({
          installDir,
          includeManager: Boolean(body && body.includeManager),
        });
        sendJson(res, 200, { ok: true, ...resShortcut });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/action/open-user-dir') {
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        openDirectoryInExplorer(files.dir);
        sendJson(res, 200, { ok: true, dir: files.dir });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/ai-prompt') {
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
        const rawItems = untranslated && untranslated.items && typeof untranslated.items === 'object' ? untranslated.items : {};
        const filteredItems = getFilteredUntranslated(userDataDir, rawItems);
        const glossary = loadGlossary();
        const prompt = buildAiTranslationPrompt({ items: filteredItems }, glossary);
        const count = Object.keys(filteredItems).length;
        sendJson(res, 200, { prompt, count });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/export') {
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="antigravity-ja-custom.json"',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(custom, null, 2) + '\n');
        return;
      }

      if (req.method === 'POST' && pathname === '/api/custom') {
        const body = await readRequestBody(req);
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
        if (!custom.exact || typeof custom.exact !== 'object') custom.exact = {};
        if (!Array.isArray(custom.patterns)) custom.patterns = [];
        if (!Array.isArray(custom.ignored)) custom.ignored = [];

        if (body.pattern) {
          if (typeof body.pattern !== 'string' || typeof body.replace !== 'string') {
            sendJson(res, 400, { error: 'pattern と replace は文字列で指定してください' });
            return;
          }
          new RegExp(body.pattern, body.flags || '');
          custom.patterns.push({
            pattern: body.pattern,
            flags: typeof body.flags === 'string' ? body.flags : '',
            replace: body.replace,
            description: typeof body.description === 'string' ? body.description : '',
          });
        } else {
          const en = typeof body.en === 'string' ? body.en.trim() : '';
          const ja = typeof body.ja === 'string' ? body.ja.trim() : '';
          if (!en || !ja) {
            sendJson(res, 400, { error: 'en と ja は必須です' });
            return;
          }
          custom.exact[en] = ja;
          const autoDict = readJsonSafe(files.autoDictPath, { exact: {}, meta: {} });
          if (autoDict && autoDict.exact && Object.prototype.hasOwnProperty.call(autoDict.exact, en)) {
            delete autoDict.exact[en];
            if (autoDict.meta && Object.prototype.hasOwnProperty.call(autoDict.meta, en)) {
              delete autoDict.meta[en];
            }
            writeJsonAtomic(files.autoDictPath, autoDict);
          }
          const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
          if (untranslated && untranslated.items && Object.prototype.hasOwnProperty.call(untranslated.items, en)) {
            delete untranslated.items[en];
            writeJsonAtomic(files.untranslatedPath, untranslated);
          }
        }
        writeJsonAtomic(files.customDictPath, custom);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'DELETE' && pathname === '/api/custom') {
        const body = await readRequestBody(req);
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        if (body.source === 'auto') {
          const autoDict = readJsonSafe(files.autoDictPath, { exact: {}, meta: {} });
          if (typeof body.en === 'string' && autoDict && autoDict.exact) {
            delete autoDict.exact[body.en];
            if (autoDict.meta) delete autoDict.meta[body.en];
            writeJsonAtomic(files.autoDictPath, autoDict);
          }
          sendJson(res, 200, { ok: true });
          return;
        }
        const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
        if (typeof body.en === 'string' && custom.exact) {
          delete custom.exact[body.en];
        }
        if (
          Number.isInteger(body.patternIndex) &&
          Array.isArray(custom.patterns) &&
          body.patternIndex >= 0 &&
          body.patternIndex < custom.patterns.length
        ) {
          custom.patterns.splice(body.patternIndex, 1);
        }
        writeJsonAtomic(files.customDictPath, custom);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/ignore') {
        const body = await readRequestBody(req);
        const en = typeof body.en === 'string' ? body.en.trim() : '';
        if (!en) {
          sendJson(res, 400, { error: 'en が必要です' });
          return;
        }
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        const custom = readJsonSafe(files.customDictPath, { exact: {}, patterns: [], ignored: [] });
        if (!Array.isArray(custom.ignored)) custom.ignored = [];
        if (!custom.ignored.includes(en)) {
          custom.ignored.push(en);
        }
        writeJsonAtomic(files.customDictPath, custom);

        const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
        if (untranslated && untranslated.items && Object.prototype.hasOwnProperty.call(untranslated.items, en)) {
          delete untranslated.items[en];
          writeJsonAtomic(files.untranslatedPath, untranslated);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/import') {
        const body = await readRequestBody(req);
        let parsed = body && body.json !== undefined ? body.json : body;
        if (typeof parsed === 'string') {
          parsed = JSON.parse(stripJsonCodeFences(parsed));
        }
        const result = importCustomTranslations(userDataDir, parsed);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/config') {
        const body = await readRequestBody(req);
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        const prev = readJsonSafe(files.configPath, { ...DEFAULT_AUTO_CONFIG });
        const rawProv =
          typeof body.autoTranslateProvider === 'string'
            ? body.autoTranslateProvider
            : prev.autoTranslateProvider || 'free';
        const nextProvider = ['free', 'gemini', 'openai', 'ollama'].includes(rawProv) ? rawProv : 'free';
        const nextApiKey = body.clearApiKey
          ? ''
          : typeof body.autoTranslateApiKey === 'string' && body.autoTranslateApiKey.trim()
            ? body.autoTranslateApiKey.trim()
            : typeof prev.autoTranslateApiKey === 'string'
              ? prev.autoTranslateApiKey
              : '';
        const rawEndpoint =
          typeof body.autoTranslateEndpoint === 'string'
            ? body.autoTranslateEndpoint.trim()
            : typeof prev.autoTranslateEndpoint === 'string'
              ? prev.autoTranslateEndpoint
              : '';
        if (typeof body.autoTranslateEndpoint === 'string' && rawEndpoint) {
          try {
            validateEndpointUrl(rawEndpoint);
          } catch (err) {
            sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
            return;
          }
        }
        const next = {
          enabled: typeof body.enabled === 'boolean' ? body.enabled : prev.enabled !== false,
          collectUntranslated:
            typeof body.collectUntranslated === 'boolean'
              ? body.collectUntranslated
              : Boolean(prev.collectUntranslated),
          autoCollectTooltips:
            typeof body.autoCollectTooltips === 'boolean'
              ? body.autoCollectTooltips
              : prev.autoCollectTooltips !== false,
          japaneseTypography:
            typeof body.japaneseTypography === 'boolean'
              ? body.japaneseTypography
              : prev.japaneseTypography !== false,
          autoTranslate:
            typeof body.autoTranslate === 'boolean'
              ? body.autoTranslate
              : prev.autoTranslate !== false,
          autoTranslateProvider: nextProvider,
          autoTranslateApiKey: nextApiKey,
          autoTranslateModel:
            typeof body.autoTranslateModel === 'string'
              ? body.autoTranslateModel.trim()
              : typeof prev.autoTranslateModel === 'string'
                ? prev.autoTranslateModel
                : '',
          autoTranslateEndpoint: rawEndpoint,
        };
        writeJsonAtomic(files.configPath, next);
        sendJson(res, 200, {
          ok: true,
          config: {
            enabled: next.enabled,
            collectUntranslated: next.collectUntranslated,
            autoCollectTooltips: next.autoCollectTooltips,
            japaneseTypography: next.japaneseTypography,
            autoTranslate: next.autoTranslate,
            autoTranslateProvider: next.autoTranslateProvider,
            autoTranslateModel: next.autoTranslateModel,
            autoTranslateEndpoint: next.autoTranslateEndpoint,
            hasApiKey: Boolean(next.autoTranslateApiKey),
          },
        });
        return;
      }

      if (req.method === 'POST' && pathname === '/api/clear-untranslated') {
        const files = ensureUserDataDir(userDataDir, { refreshBaseDict: false });
        writeJsonAtomic(files.untranslatedPath, { items: {} });
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  };
}

/**
 * Creates and starts the local 127.0.0.1 app HTTP server.
 * @param {{ port?: number, userDataDir?: string, installDir?: string, autoExit?: boolean }} [options]
 */
function startAppServer(options = {}) {
  const userDataDir = options.userDataDir;
  const installDir = options.installDir;
  const autoExit = Boolean(options.autoExit);
  const requestedPort = options.port !== undefined ? Number(options.port) : 43210;

  let lastActivityAt = Date.now();
  let seenFirstClient = false;
  let byeTimer = null;
  let idleCheckTimer = null;

  function clearExitTimers() {
    if (byeTimer) {
      clearTimeout(byeTimer);
      byeTimer = null;
    }
    if (idleCheckTimer) {
      clearInterval(idleCheckTimer);
      idleCheckTimer = null;
    }
  }

  let server = null;
  const handler = createAppHandler(userDataDir, {
    installDir,
    onActivity() {
      seenFirstClient = true;
      lastActivityAt = Date.now();
      if (byeTimer) {
        clearTimeout(byeTimer);
        byeTimer = null;
      }
    },
    onClientBye() {
      if (!autoExit) {
        return;
      }
      const byeAt = Date.now();
      if (byeTimer) {
        clearTimeout(byeTimer);
      }
      byeTimer = setTimeout(() => {
        byeTimer = null;
        if (lastActivityAt <= byeAt && server) {
          clearExitTimers();
          server.close(() => process.exit(0));
        }
      }, 3500);
      byeTimer.unref();
    },
  });

  server = http.createServer(handler);

  if (autoExit) {
    idleCheckTimer = setInterval(() => {
      const elapsed = Date.now() - lastActivityAt;
      const limit = seenFirstClient ? 18000 : 25000;
      if (elapsed > limit && server) {
        clearExitTimers();
        server.close(() => process.exit(0));
      }
    }, 3000);
    idleCheckTimer.unref();
  }

  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      clearExitTimers();
      reject(err);
    });
    server.listen(requestedPort, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/`,
        close: () =>
          new Promise((resClose) => {
            clearExitTimers();
            server.close(() => resClose());
          }),
      });
    });
  });
}

module.exports = {
  createAppHandler,
  startAppServer,
  buildStatePayload,
  renderAppHtml,
  stripJsonCodeFences,
};
