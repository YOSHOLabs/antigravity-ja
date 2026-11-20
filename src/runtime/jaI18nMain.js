'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const SUBMENU_ID = 'antigravity-ja-submenu';
const TOGGLE_ENABLED_ID = 'antigravity-ja-toggle-enabled';
const TOGGLE_COLLECT_ID = 'antigravity-ja-toggle-collect';
const TOGGLE_TYPOGRAPHY_ID = 'antigravity-ja-toggle-typography';
const MAX_UNTRANSLATED_ITEMS = 2000;

let initialized = false;
let userDataDir = '';
let currentConfig = {
  enabled: true,
  collectUntranslated: false,
  autoCollectTooltips: true,
  japaneseTypography: true,
};
let currentRawBundle = {
  enabled: true,
  collectUntranslated: false,
  autoCollectTooltips: true,
  japaneseTypography: true,
  exact: {},
  patterns: [],
  ignored: [],
};
let compiled = {
  enabled: true,
  collectUntranslated: false,
  autoCollectTooltips: true,
  japaneseTypography: true,
  exactMap: new Map(),
  patternList: [],
  ignoredSet: new Set(),
};

let activeTray = null;
let activeTrayMenu = null;
let activeAppMenu = null;
let fsWatcher = null;
let reloadTimer = null;
let untranslatedFlushTimer = null;
let bundleRevision = 0;
let lastConfigWriteAt = 0;
const pendingUntranslated = new Map();
const subscribedContents = new Set();

const menuItemOriginals = new WeakMap();
const WS_SPLIT_RE = /^(\s*)([\s\S]*?)(\s*)$/;

function registerSubscriber(sender) {
  if (!sender || typeof sender.send !== 'function') {
    return;
  }
  if (typeof sender.isDestroyed === 'function' && sender.isDestroyed()) {
    return;
  }
  if (!subscribedContents.has(sender)) {
    subscribedContents.add(sender);
    if (typeof sender.once === 'function') {
      try {
        sender.once('destroyed', () => {
          subscribedContents.delete(sender);
        });
      } catch {
        // ignore
      }
    }
  }
}

function resolveUserDataDir() {
  if (process.env.ANTIGRAVITY_JA_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_JA_DIR);
  }
  return path.join(os.homedir(), '.antigravity-ja');
}

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

function normalizeLookupKey(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/\r\n/g, '\n')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ');
}

function compileBundle(rawBundle) {
  const exactMap = new Map();
  if (rawBundle && rawBundle.exact && typeof rawBundle.exact === 'object') {
    for (const [k, v] of Object.entries(rawBundle.exact)) {
      if (typeof k === 'string' && typeof v === 'string' && k.length > 0 && v.length > 0) {
        exactMap.set(k, v);
        const norm = normalizeLookupKey(k);
        if (norm !== k && !exactMap.has(norm)) {
          exactMap.set(norm, v);
        }
      }
    }
  }
  const patternList = [];
  if (Array.isArray(rawBundle?.patterns)) {
    for (const item of rawBundle.patterns) {
      if (!item || typeof item.pattern !== 'string' || typeof item.replace !== 'string') {
        continue;
      }
      try {
        patternList.push({
          re: new RegExp(item.pattern, item.flags || ''),
          replace: item.replace,
        });
      } catch {
        // ignore invalid regex
      }
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
    exactMap,
    patternList,
    ignoredSet,
  };
}

function translateSimple(text) {
  if (!compiled.enabled || typeof text !== 'string' || !text) {
    return text;
  }
  const m = WS_SPLIT_RE.exec(text);
  const lead = m ? m[1] : '';
  const core = m ? m[2] : text;
  const trail = m ? m[3] : '';
  if (!core) {
    return text;
  }
  const normCore = normalizeLookupKey(core);
  let exactHit = compiled.exactMap.get(core);
  if (exactHit === undefined && normCore !== core) {
    exactHit = compiled.exactMap.get(normCore);
  }
  if (exactHit !== undefined && exactHit !== core) {
    return `${lead}${exactHit}${trail}`;
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
        return `${lead}${replaced}${trail}`;
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
          return `${lead}${replaced}${trail}`;
        }
      }
    }
  }
  return text;
}

function loadBundleFromDisk() {
  const configPath = path.join(userDataDir, 'config.json');
  const baseDictPath = path.join(userDataDir, 'dictionary.json');
  const customDictPath = path.join(userDataDir, 'custom.json');

  const cfg = readJsonSafe(configPath, {
    enabled: true,
    collectUntranslated: false,
    autoCollectTooltips: true,
    japaneseTypography: true,
  });
  currentConfig = {
    enabled: cfg?.enabled !== false,
    collectUntranslated: Boolean(cfg?.collectUntranslated),
    autoCollectTooltips: cfg?.autoCollectTooltips !== false,
    japaneseTypography: cfg?.japaneseTypography !== false,
  };

  const baseDict = readJsonSafe(baseDictPath, { categories: {}, patterns: [] });
  const customDict = readJsonSafe(customDictPath, { exact: {}, patterns: [], ignored: [] });

  const exact = { ...flattenExactMap(baseDict) };
  if (customDict && customDict.exact && typeof customDict.exact === 'object' && !Array.isArray(customDict.exact)) {
    for (const [k, v] of Object.entries(customDict.exact)) {
      if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
        exact[k] = v;
      }
    }
  }

  const customPatterns = Array.isArray(customDict?.patterns) ? customDict.patterns : [];
  const basePatterns = Array.isArray(baseDict?.patterns) ? baseDict.patterns : [];
  const ignored = Array.isArray(customDict?.ignored)
    ? customDict.ignored.filter((x) => typeof x === 'string' && x.length > 0)
    : [];

  currentRawBundle = {
    revision: ++bundleRevision,
    enabled: currentConfig.enabled,
    collectUntranslated: currentConfig.collectUntranslated,
    autoCollectTooltips: currentConfig.autoCollectTooltips,
    japaneseTypography: currentConfig.japaneseTypography,
    exact,
    patterns: [...customPatterns, ...basePatterns],
    ignored,
  };
  compiled = compileBundle(currentRawBundle);
}

function saveConfigAndBroadcast() {
  const configPath = path.join(userDataDir, 'config.json');
  try {
    lastConfigWriteAt = Date.now();
    writeJsonAtomic(configPath, currentConfig);
  } catch {
    // ignore write failure
  }
  reloadAndBroadcast();
}

function broadcastBundleToWindows() {
  const targets = new Set();
  for (const wc of Array.from(subscribedContents)) {
    if (!wc || typeof wc.send !== 'function' || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      subscribedContents.delete(wc);
      continue;
    }
    targets.add(wc);
  }
  try {
    const webContentsMod = electron.webContents;
    if (webContentsMod && typeof webContentsMod.getAllWebContents === 'function') {
      for (const wc of webContentsMod.getAllWebContents()) {
        targets.add(wc);
      }
    }
  } catch {
    // ignore
  }
  try {
    const BrowserWindow = electron.BrowserWindow;
    if (BrowserWindow && typeof BrowserWindow.getAllWindows === 'function') {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win && win.webContents) {
          targets.add(win.webContents);
        }
      }
    }
  } catch {
    // ignore
  }
  for (const wc of targets) {
    try {
      if (wc && typeof wc.send === 'function' && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
        wc.send('antigravity-ja:bundle-updated', currentRawBundle);
      }
    } catch {
      // ignore
    }
  }
}

function translateMenuItemsRecursive(menu, options = {}) {
  if (!menu || !Array.isArray(menu.items)) {
    return;
  }
  const isTopAppBar = Boolean(options.isTopAppBar);
  for (const item of menu.items) {
    if (!item || item.type === 'separator') {
      continue;
    }
    if (item.id === SUBMENU_ID) {
      continue;
    }
    if (item.id !== 'check-for-updates' && !isTopAppBar && typeof item.label === 'string' && item.label.length > 0) {
      const rec = menuItemOriginals.get(item);
      const orig = rec && item.label === rec.lastTranslated ? rec.orig : item.label;
      if (compiled.enabled) {
        const nextLabel = translateSimple(orig);
        if (nextLabel !== orig) {
          menuItemOriginals.set(item, { orig, lastTranslated: nextLabel });
          if (item.label !== nextLabel) {
            item.label = nextLabel;
          }
        } else {
          menuItemOriginals.delete(item);
        }
      } else if (rec && item.label === rec.lastTranslated) {
        item.label = rec.orig;
        menuItemOriginals.delete(item);
      }
    }
    if (item.submenu) {
      translateMenuItemsRecursive(item.submenu, { isTopAppBar: false });
    }
  }
}

function buildJaSubmenuItem() {
  const { Menu, MenuItem, shell } = electron;
  const submenu = Menu.buildFromTemplate([
    {
      id: TOGGLE_ENABLED_ID,
      label: '日本語表示を有効にする',
      type: 'checkbox',
      checked: currentConfig.enabled,
      click: () => {
        currentConfig.enabled = !currentConfig.enabled;
        saveConfigAndBroadcast();
      },
    },
    {
      id: TOGGLE_COLLECT_ID,
      label: '未翻訳UIテキストを収集',
      type: 'checkbox',
      checked: currentConfig.collectUntranslated,
      click: () => {
        currentConfig.collectUntranslated = !currentConfig.collectUntranslated;
        saveConfigAndBroadcast();
      },
    },
    {
      id: TOGGLE_TYPOGRAPHY_ID,
      label: '日本語フォント最適化 (lang=ja)',
      type: 'checkbox',
      checked: currentConfig.japaneseTypography,
      click: () => {
        currentConfig.japaneseTypography = !currentConfig.japaneseTypography;
        saveConfigAndBroadcast();
      },
    },
    { type: 'separator' },
    {
      label: '辞書フォルダを開く',
      click: () => {
        try {
          fs.mkdirSync(userDataDir, { recursive: true });
          void shell.openPath(userDataDir);
        } catch {
          // ignore
        }
      },
    },
    {
      label: '辞書を再読み込み',
      click: () => {
        reloadAndBroadcast();
      },
    },
  ]);

  return new MenuItem({
    id: SUBMENU_ID,
    label: '日本語UI',
    submenu,
  });
}

function syncJaSubmenuCheckboxes(menu) {
  if (!menu || !Array.isArray(menu.items)) {
    return;
  }
  const sub = menu.items.find((item) => item && item.id === SUBMENU_ID);
  if (!sub || !sub.submenu || !Array.isArray(sub.submenu.items)) {
    return;
  }
  const toggleItem = sub.submenu.items.find((i) => i && i.id === TOGGLE_ENABLED_ID);
  if (toggleItem) {
    toggleItem.checked = currentConfig.enabled;
  }
  const collectItem = sub.submenu.items.find((i) => i && i.id === TOGGLE_COLLECT_ID);
  if (collectItem) {
    collectItem.checked = currentConfig.collectUntranslated;
  }
  const typoItem = sub.submenu.items.find((i) => i && i.id === TOGGLE_TYPOGRAPHY_ID);
  if (typoItem) {
    typoItem.checked = currentConfig.japaneseTypography;
  }
}

function ensureJaSubmenuInTrayMenu(menu) {
  if (!menu || !Array.isArray(menu.items) || typeof menu.insert !== 'function') {
    return;
  }
  const existing = menu.items.find((item) => item && item.id === SUBMENU_ID);
  if (!existing) {
    let insertPos = menu.items.length;
    for (let i = 0; i < menu.items.length; i++) {
      const item = menu.items[i];
      const rec = item ? menuItemOriginals.get(item) : null;
      const origLabel = rec ? rec.orig : item && item.label;
      if (origLabel === 'Quit' || origLabel === 'Quit Antigravity') {
        insertPos = i;
        break;
      }
    }
    menu.insert(insertPos, buildJaSubmenuItem());
  } else {
    syncJaSubmenuCheckboxes(menu);
  }
}

let origSetContextMenu = null;
let origSetApplicationMenu = null;

function refreshNativeMenus() {
  try {
    if (activeTray && activeTrayMenu && origSetContextMenu) {
      ensureJaSubmenuInTrayMenu(activeTrayMenu);
      translateMenuItemsRecursive(activeTrayMenu, { isTopAppBar: false });
      origSetContextMenu.call(activeTray, activeTrayMenu);
    }
  } catch {
    // ignore tray refresh error
  }
  try {
    if (activeAppMenu && origSetApplicationMenu) {
      translateMenuItemsRecursive(activeAppMenu, { isTopAppBar: true });
      origSetApplicationMenu.call(electron.Menu, activeAppMenu);
    }
  } catch {
    // ignore app menu refresh error
  }
}

function reloadAndBroadcast() {
  try {
    loadBundleFromDisk();
    refreshNativeMenus();
    broadcastBundleToWindows();
  } catch {
    // ignore reload errors
  }
}

function flushUntranslatedNow() {
  if (untranslatedFlushTimer) {
    clearTimeout(untranslatedFlushTimer);
    untranslatedFlushTimer = null;
  }
  if (pendingUntranslated.size === 0) {
    return;
  }
  const untranslatedPath = path.join(userDataDir, 'untranslated.json');
  try {
    const existing = readJsonSafe(untranslatedPath, { items: {} });
    const items = existing && existing.items && typeof existing.items === 'object' ? existing.items : {};
    const now = new Date().toISOString();

    for (const [text, inc] of pendingUntranslated.entries()) {
      if (compiled.exactMap.has(text) || compiled.ignoredSet.has(text)) {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(items, text) && Object.keys(items).length >= MAX_UNTRANSLATED_ITEMS) {
        continue;
      }
      const prev = items[text] && typeof items[text] === 'object'
        ? items[text]
        : { count: 0, tags: [], roles: [], attrs: [], firstSeen: now, lastSeen: now };
      const tags = new Set(Array.isArray(prev.tags) ? prev.tags : []);
      const roles = new Set(Array.isArray(prev.roles) ? prev.roles : []);
      const attrs = new Set(Array.isArray(prev.attrs) ? prev.attrs : []);
      for (const t of inc.tags || []) if (tags.size < 6) tags.add(t);
      for (const r of inc.roles || []) if (roles.size < 6) roles.add(r);
      for (const a of inc.attrs || []) if (attrs.size < 6) attrs.add(a);

      items[text] = {
        count: (Number(prev.count) || 0) + (Number(inc.count) || 1),
        tags: Array.from(tags),
        roles: Array.from(roles),
        attrs: Array.from(attrs),
        inTooltip: Boolean(prev.inTooltip || inc.inTooltip),
        firstSeen: prev.firstSeen || now,
        lastSeen: now,
      };
    }
    pendingUntranslated.clear();
    writeJsonAtomic(untranslatedPath, { items });
  } catch {
    pendingUntranslated.clear();
  }
}

function recordUntranslatedBatch(batch) {
  if ((!compiled.collectUntranslated && !compiled.autoCollectTooltips) || !Array.isArray(batch)) {
    return;
  }
  for (const item of batch) {
    if (!item || typeof item.text !== 'string' || !item.text) {
      continue;
    }
    const isTooltip = Boolean(item.inTooltip);
    if (!compiled.collectUntranslated && !(compiled.autoCollectTooltips && isTooltip)) {
      continue;
    }
    const norm = normalizeLookupKey(item.text);
    if (
      compiled.exactMap.has(item.text) ||
      compiled.exactMap.has(norm) ||
      compiled.ignoredSet.has(item.text) ||
      compiled.ignoredSet.has(norm)
    ) {
      continue;
    }
    const prev = pendingUntranslated.get(item.text) || { count: 0, tags: [], roles: [], attrs: [], inTooltip: false };
    prev.count += Number(item.count) || 1;
    if (isTooltip) prev.inTooltip = true;
    for (const t of item.tags || []) if (!prev.tags.includes(t) && prev.tags.length < 6) prev.tags.push(t);
    for (const r of item.roles || []) if (!prev.roles.includes(r) && prev.roles.length < 6) prev.roles.push(r);
    for (const a of item.attrs || []) if (!prev.attrs.includes(a) && prev.attrs.length < 6) prev.attrs.push(a);
    pendingUntranslated.set(item.text, prev);
  }
  if (!untranslatedFlushTimer && pendingUntranslated.size > 0) {
    untranslatedFlushTimer = setTimeout(() => {
      flushUntranslatedNow();
    }, 1500);
  }
}

function translateMessageBoxOptions(opts) {
  if (!compiled.enabled || !opts || typeof opts !== 'object') {
    return opts;
  }
  const next = { ...opts };
  if (typeof next.title === 'string') next.title = translateSimple(next.title);
  if (typeof next.message === 'string') next.message = translateSimple(next.message);
  if (typeof next.detail === 'string') next.detail = translateSimple(next.detail);
  if (Array.isArray(next.buttons)) {
    next.buttons = next.buttons.map((b) => (typeof b === 'string' ? translateSimple(b) : b));
  }
  return next;
}

function installPatches() {
  const { Tray, Menu, dialog, ipcMain, app } = electron;

  if (Tray && Tray.prototype && typeof Tray.prototype.setContextMenu === 'function' && !origSetContextMenu) {
    origSetContextMenu = Tray.prototype.setContextMenu;
    Tray.prototype.setContextMenu = function (menu) {
      try {
        activeTray = this;
        activeTrayMenu = menu;
        if (menu) {
          ensureJaSubmenuInTrayMenu(menu);
          translateMenuItemsRecursive(menu, { isTopAppBar: false });
        }
      } catch {
        // fallback to untouched menu
      }
      return origSetContextMenu.call(this, menu);
    };
  }

  if (Menu && typeof Menu.setApplicationMenu === 'function' && !origSetApplicationMenu) {
    origSetApplicationMenu = Menu.setApplicationMenu;
    Menu.setApplicationMenu = function (menu) {
      try {
        activeAppMenu = menu;
        if (menu) {
          translateMenuItemsRecursive(menu, { isTopAppBar: true });
        }
      } catch {
        // ignore
      }
      return origSetApplicationMenu.call(this, menu);
    };
  }

  if (dialog && typeof dialog.showMessageBox === 'function') {
    const origShowMessageBox = dialog.showMessageBox.bind(dialog);
    dialog.showMessageBox = function (...args) {
      try {
        if (args.length >= 2 && args[0] && typeof args[0].webContents === 'object') {
          args[1] = translateMessageBoxOptions(args[1]);
        } else if (args.length >= 1) {
          args[0] = translateMessageBoxOptions(args[0]);
        }
      } catch {
        // ignore
      }
      return origShowMessageBox(...args);
    };
  }

  if (dialog && typeof dialog.showMessageBoxSync === 'function') {
    const origShowMessageBoxSync = dialog.showMessageBoxSync.bind(dialog);
    dialog.showMessageBoxSync = function (...args) {
      try {
        if (args.length >= 2 && args[0] && typeof args[0].webContents === 'object') {
          args[1] = translateMessageBoxOptions(args[1]);
        } else if (args.length >= 1) {
          args[0] = translateMessageBoxOptions(args[0]);
        }
      } catch {
        // ignore
      }
      return origShowMessageBoxSync(...args);
    };
  }

  if (dialog && typeof dialog.showErrorBox === 'function') {
    const origShowErrorBox = dialog.showErrorBox.bind(dialog);
    dialog.showErrorBox = function (title, content) {
      try {
        if (compiled.enabled) {
          return origShowErrorBox(
            typeof title === 'string' ? translateSimple(title) : title,
            typeof content === 'string' ? translateSimple(content) : content
          );
        }
      } catch {
        // ignore
      }
      return origShowErrorBox(title, content);
    };
  }

  if (ipcMain) {
    try {
      ipcMain.removeHandler('antigravity-ja:get-bundle');
      ipcMain.removeHandler('antigravity-ja:toggle');
      ipcMain.removeHandler('antigravity-ja:toggle-collect');
    } catch {
      // ignore
    }
    ipcMain.handle('antigravity-ja:get-bundle', (event) => {
      registerSubscriber(event && event.sender);
      try {
        loadBundleFromDisk();
      } catch {
        // keep last valid bundle
      }
      return currentRawBundle;
    });
    ipcMain.handle('antigravity-ja:toggle', (event) => {
      registerSubscriber(event && event.sender);
      currentConfig.enabled = !currentConfig.enabled;
      saveConfigAndBroadcast();
      return { enabled: currentConfig.enabled, bundle: currentRawBundle };
    });
    ipcMain.handle('antigravity-ja:toggle-collect', (event) => {
      registerSubscriber(event && event.sender);
      currentConfig.collectUntranslated = !currentConfig.collectUntranslated;
      saveConfigAndBroadcast();
      return { collectUntranslated: currentConfig.collectUntranslated, bundle: currentRawBundle };
    });
    ipcMain.on('antigravity-ja:report-untranslated', (event, batch) => {
      registerSubscriber(event && event.sender);
      recordUntranslatedBatch(batch);
    });
  }

  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    if (fs.existsSync(userDataDir)) {
      fsWatcher = fs.watch(userDataDir, { persistent: false }, (_eventType, filename) => {
        if (filename) {
          const name = String(filename);
          if (name.includes('.tmp-') || name === 'untranslated.json') {
            return;
          }
          if (name !== 'config.json' && name !== 'dictionary.json' && name !== 'custom.json') {
            return;
          }
          if (name === 'config.json' && Date.now() - lastConfigWriteAt < 500) {
            return;
          }
        }
        if (reloadTimer) {
          clearTimeout(reloadTimer);
        }
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          reloadAndBroadcast();
        }, 250);
      });
    }
  } catch {
    // ignore fs.watch unavailability
  }

  if (app && typeof app.on === 'function') {
    app.on('will-quit', () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      subscribedContents.clear();
      flushUntranslatedNow();
      if (fsWatcher) {
        try {
          fsWatcher.close();
        } catch {
          // ignore
        }
        fsWatcher = null;
      }
    });
  }
}

function initJaI18n() {
  if (initialized) {
    return;
  }
  initialized = true;
  try {
    userDataDir = resolveUserDataDir();
    loadBundleFromDisk();
    installPatches();
  } catch {
    // Never fail host app startup
  }
}

module.exports = {
  initJaI18n,
};
