'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { EventEmitter } = require('node:events');
const { buildAsarHeaderBuffer, readAsarFile, readAsarHeader, sha256File } = require('../src/asar');
const { createAppHandler, startAppServer } = require('../src/appServer');
const {
  createDesktopShortcuts,
  getShortcutPaths,
  isAppPatchedFast,
  launchAntigravity,
} = require('../src/launcher');
const {
  MAIN_START_MARKER,
  applyPatch,
  getStatus,
  restorePatch,
} = require('../src/patcher');
const { resolveAntigravityPaths } = require('../src/paths');
const { PRELOAD_START_MARKER } = require('../src/runtime/preloadBuilder');

test('Full applyPatch / idempotency / vm.Script syntax check / restorePatch on temp copy of real app.asar', (t) => {
  const realPaths = resolveAntigravityPaths();
  if (!fs.existsSync(realPaths.asarPath)) {
    t.skip('Installed Antigravity app.asar not found');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-patcher-'));
  const tmpInstallDir = path.join(tmpRoot, 'app');
  const tmpResources = path.join(tmpInstallDir, 'resources');
  const tmpAsar = path.join(tmpResources, 'app.asar');
  const tmpUserDir = path.join(tmpRoot, 'user-data');

  try {
    fs.mkdirSync(tmpResources, { recursive: true });
    const sourceAsar = fs.existsSync(realPaths.backupPath) ? realPaths.backupPath : realPaths.asarPath;
    fs.copyFileSync(sourceAsar, tmpAsar);
    const originalSha = sha256File(tmpAsar);

    const beforeStatus = getStatus({ installDir: tmpInstallDir, userDataDir: tmpUserDir });
    assert.equal(beforeStatus.installed, true);
    assert.equal(beforeStatus.patched, false);
    assert.equal(beforeStatus.backupExists, false);

    // First apply
    const res1 = applyPatch({
      installDir: tmpInstallDir,
      userDataDir: tmpUserDir,
      skipRunningCheck: true,
    });
    assert.equal(res1.backupCreated, true);
    assert.equal(sha256File(res1.backupPath), originalSha);

    const afterStatus1 = getStatus({ installDir: tmpInstallDir, userDataDir: tmpUserDir });
    assert.equal(afterStatus1.patched, true);
    assert.equal(afterStatus1.backupExists, true);
    assert.equal(afterStatus1.backupValid, true);

    // Verify all patched/added JS files compile cleanly in vm.Script
    const mainJs = readAsarFile(tmpAsar, 'dist/main.js').toString('utf8');
    const preloadJs = readAsarFile(tmpAsar, 'dist/preload.js').toString('utf8');
    const jaMainJs = readAsarFile(tmpAsar, 'dist/jaI18nMain.js').toString('utf8');
    const jaAutoJs = readAsarFile(tmpAsar, 'dist/jaAutoTranslator.js').toString('utf8');

    assert.doesNotThrow(() => new vm.Script(mainJs, { filename: 'dist/main.js' }));
    assert.doesNotThrow(() => new vm.Script(preloadJs, { filename: 'dist/preload.js' }));
    assert.doesNotThrow(() => new vm.Script(jaMainJs, { filename: 'dist/jaI18nMain.js' }));
    assert.doesNotThrow(() => new vm.Script(jaAutoJs, { filename: 'dist/jaAutoTranslator.js' }));

    // Missing dist/jaAutoTranslator.js must cause isAppPatchedFast to treat ASAR as outdated/unpatched
    const headerWithoutAuto = JSON.parse(JSON.stringify(readAsarHeader(tmpAsar).header));
    delete headerWithoutAuto.files.dist.files['jaAutoTranslator.js'];
    const partialAsarPath = path.join(tmpRoot, 'partial.asar');
    const partialPayloadOffset = readAsarHeader(tmpAsar).payloadOffset;
    const rawAsarFd = fs.openSync(tmpAsar, 'r');
    try {
      const st = fs.statSync(tmpAsar);
      const partialHdrBuf = buildAsarHeaderBuffer(headerWithoutAuto);
      const restLen = st.size - partialPayloadOffset;
      const restBuf = Buffer.alloc(restLen);
      fs.readSync(rawAsarFd, restBuf, 0, restLen, partialPayloadOffset);
      fs.writeFileSync(partialAsarPath, Buffer.concat([partialHdrBuf, restBuf]));
    } finally {
      fs.closeSync(rawAsarFd);
    }
    assert.equal(isAppPatchedFast(partialAsarPath), false);

    // Verify user custom.json survives a second idempotent apply
    const customPath = path.join(tmpUserDir, 'custom.json');
    fs.writeFileSync(
      customPath,
      JSON.stringify({ exact: { 'My Custom Key': 'カスタム訳' }, patterns: [], ignored: [] }),
      'utf8'
    );

    const res2 = applyPatch({
      installDir: tmpInstallDir,
      userDataDir: tmpUserDir,
      skipRunningCheck: true,
    });
    assert.equal(res2.backupCreated, false);
    assert.equal(sha256File(res2.backupPath), originalSha);

    const mainJs2 = readAsarFile(tmpAsar, 'dist/main.js').toString('utf8');
    const preloadJs2 = readAsarFile(tmpAsar, 'dist/preload.js').toString('utf8');
    assert.equal(mainJs2.split(MAIN_START_MARKER).length - 1, 1);
    assert.equal(preloadJs2.split(PRELOAD_START_MARKER).length - 1, 1);

    const preservedCustom = JSON.parse(fs.readFileSync(customPath, 'utf8'));
    assert.equal(preservedCustom.exact['My Custom Key'], 'カスタム訳');

    const metaAfterReapply = JSON.parse(fs.readFileSync(path.join(tmpResources, 'app.asar.ja-meta.json'), 'utf8'));
    assert.equal(metaAfterReapply.originalSha256, originalSha);
    assert.ok(typeof metaAfterReapply.patchedAt === 'string' && metaAfterReapply.patchedAt.length > 0);

    // Restore and confirm byte-for-byte identity with original app.asar
    const restoreRes = restorePatch({
      installDir: tmpInstallDir,
      skipRunningCheck: true,
    });
    assert.equal(restoreRes.restored, true);
    assert.equal(sha256File(tmpAsar), originalSha);
    assert.equal(fs.existsSync(res1.backupPath), false);
    assert.equal(fs.existsSync(path.join(tmpResources, 'app.asar.ja-meta.json')), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

async function invokeHandler(handler, method, url, bodyObj, reqHeaders = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = reqHeaders;
  req.destroy = () => {};

  const chunks = [];
  let statusCode = 0;
  let headers = {};
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const res = {
    writeHead(code, hdrs) {
      statusCode = code;
      headers = hdrs || {};
    },
    end(data) {
      if (data !== undefined) {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'));
      }
      resolveDone();
    },
  };

  const pending = handler(req, res);
  if (bodyObj !== undefined) {
    req.emit('data', Buffer.from(JSON.stringify(bodyObj), 'utf8'));
  }
  req.emit('end');
  await Promise.all([pending, done]);

  const text = Buffer.concat(chunks).toString('utf8');
  return {
    status: statusCode,
    headers,
    text,
    json() {
      return JSON.parse(text);
    },
  };
}

test('Unified App HTTP endpoints, origin guard, and inline client script work end-to-end', async () => {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-editor-'));
  const srv = await startAppServer({ port: 0, userDataDir: tmpUserDir });
  assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  await srv.close();

  const mockFetch = async (url) => {
    const parsed = new URL(url);
    const q = parsed.searchParams.get('q') || '';
    const ja = q === 'Auto Discover Item' ? '自動発見項目' : '一時項目';
    return {
      ok: true,
      status: 200,
      async json() {
        return [[[ja, q]]];
      },
    };
  };

  const handler = createAppHandler(tmpUserDir, { _fetch: mockFetch });
  try {
    const htmlRes = await invokeHandler(handler, 'GET', '/');
    assert.equal(htmlRes.status, 200);
    assert.ok(htmlRes.text.includes('Antigravity 日本語化マネージャー'));

    // Verify inline client script has valid JS syntax
    const scriptMatch = /<script>([\s\S]*?)<\/script>/i.exec(htmlRes.text);
    assert.ok(scriptMatch, 'Expected inline <script> in app HTML');
    assert.doesNotThrow(() => new vm.Script(scriptMatch[1], { filename: 'app-inline.js' }));

    const pingRes = await invokeHandler(handler, 'GET', '/api/ping');
    assert.equal(pingRes.status, 200);
    assert.equal(pingRes.json().ok, true);

    // Seed untranslated item
    fs.writeFileSync(
      path.join(tmpUserDir, 'untranslated.json'),
      JSON.stringify({
        items: {
          'Test Button': { count: 3, tags: ['BUTTON'], roles: ['button'], attrs: [] },
          'Ignore Label': { count: 1, tags: ['SPAN'], roles: [], attrs: [] },
        },
      }),
      'utf8'
    );

    const stateRes = await invokeHandler(handler, 'GET', '/api/state');
    assert.equal(stateRes.status, 200);
    const stateJson = stateRes.json();
    assert.equal(stateJson.stats.untranslatedCount, 2);
    assert.equal(typeof stateJson.appStatus.installed, 'boolean');
    assert.equal(typeof stateJson.appStatus.patched, 'boolean');
    assert.equal(typeof stateJson.appStatus.shortcutExists, 'boolean');

    const syncRes = await invokeHandler(handler, 'POST', '/api/action/sync', {});
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.json().ok, true);

    const promptRes = await invokeHandler(handler, 'GET', '/api/ai-prompt');
    assert.equal(promptRes.status, 200);
    assert.ok(promptRes.json().prompt.includes('Test Button'));

    const saveRes = await invokeHandler(handler, 'POST', '/api/custom', {
      en: 'Test Button',
      ja: 'テストボタン',
    });
    assert.equal(saveRes.status, 200);

    const ignoreRes = await invokeHandler(handler, 'POST', '/api/ignore', { en: 'Ignore Label' });
    assert.equal(ignoreRes.status, 200);

    const importRes = await invokeHandler(handler, 'POST', '/api/import', {
      json: '```json\n{"Another Item": "別の項目"}\n```',
    });
    assert.equal(importRes.status, 200);
    assert.equal(importRes.json().added, 1);

    const stateAfter = (await invokeHandler(handler, 'GET', '/api/state')).json();
    assert.equal(stateAfter.custom.exact['Test Button'], 'テストボタン');
    assert.equal(stateAfter.custom.exact['Another Item'], '別の項目');
    assert.ok(stateAfter.custom.ignored.includes('Ignore Label'));
    assert.equal(stateAfter.stats.untranslatedCount, 0);

    const exportRes = await invokeHandler(handler, 'GET', '/api/export');
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.json().exact['Test Button'], 'テストボタン');

    const delRes = await invokeHandler(handler, 'DELETE', '/api/custom', { en: 'Another Item' });
    assert.equal(delRes.status, 200);
    const stateAfterDel = (await invokeHandler(handler, 'GET', '/api/state')).json();
    assert.equal(stateAfterDel.custom.exact['Another Item'], undefined);

    const cfgRes = await invokeHandler(handler, 'POST', '/api/config', {
      collectUntranslated: true,
      autoCollectTooltips: false,
      japaneseTypography: false,
      autoTranslate: true,
      autoTranslateProvider: 'gemini',
      autoTranslateApiKey: 'secret-test-key-xyz',
      autoTranslateModel: 'gemini-2.5-flash',
    });
    assert.equal(cfgRes.status, 200);
    assert.equal(cfgRes.json().config.collectUntranslated, true);
    assert.equal(cfgRes.json().config.autoCollectTooltips, false);
    assert.equal(cfgRes.json().config.japaneseTypography, false);
    assert.equal(cfgRes.json().config.autoTranslate, true);
    assert.equal(cfgRes.json().config.autoTranslateProvider, 'gemini');
    assert.equal(cfgRes.json().config.hasApiKey, true);
    assert.equal(cfgRes.json().config.autoTranslateApiKey, undefined);
    assert.equal(cfgRes.text.includes('secret-test-key-xyz'), false);

    // Switch back to free provider and test manual auto-translate action, delete source:'auto', and clear-auto
    const badEndpointRes = await invokeHandler(handler, 'POST', '/api/config', {
      autoTranslateProvider: 'openai',
      autoTranslateEndpoint: 'http://remote.example/api',
    });
    assert.equal(badEndpointRes.status, 400);

    const localEndpointRes = await invokeHandler(handler, 'POST', '/api/config', {
      autoTranslateProvider: 'ollama',
      autoTranslateEndpoint: 'http://127.0.0.1:11434',
    });
    assert.equal(localEndpointRes.status, 200);

    await invokeHandler(handler, 'POST', '/api/config', {
      autoTranslateProvider: 'free',
      autoTranslateEndpoint: '',
      clearApiKey: true,
    });
    const stateClearedKey = (await invokeHandler(handler, 'GET', '/api/state')).json();
    assert.equal(stateClearedKey.config.hasApiKey, false);
    assert.equal(stateClearedKey.text?.includes('secret-test-key-xyz') || false, false);

    fs.writeFileSync(
      path.join(tmpUserDir, 'untranslated.json'),
      JSON.stringify({
        items: {
          'Auto Discover Item': { count: 2, tags: ['BUTTON'], roles: ['button'], attrs: [] },
          'Temp Auto Item': { count: 1, tags: ['SPAN'], roles: [], attrs: [] },
        },
      }),
      'utf8'
    );

    const autoRes = await invokeHandler(handler, 'POST', '/api/action/auto-translate', {});
    assert.equal(autoRes.status, 200);
    assert.equal(autoRes.json().ok, true);

    const stateAfterAuto = (await invokeHandler(handler, 'GET', '/api/state')).json();
    assert.equal(stateAfterAuto.auto.exact['Auto Discover Item'], '自動発見項目');

    const delAutoRes = await invokeHandler(handler, 'DELETE', '/api/custom', {
      en: 'Temp Auto Item',
      source: 'auto',
    });
    assert.equal(delAutoRes.status, 200);

    const clearAutoRes = await invokeHandler(handler, 'POST', '/api/action/clear-auto', {});
    assert.equal(clearAutoRes.status, 200);
    const stateAfterClear = (await invokeHandler(handler, 'GET', '/api/state')).json();
    assert.equal(Object.keys(stateAfterClear.auto.exact).length, 0);

    const evilOriginRes = await invokeHandler(
      handler,
      'POST',
      '/api/custom',
      { en: 'Evil', ja: '悪意' },
      { host: '127.0.0.1:43210', origin: 'https://evil.example' }
    );
    assert.equal(evilOriginRes.status, 403);
  } finally {
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  }
});

test('Windows batch and VBScript launchers are pure ASCII with CRLF line endings', () => {
  const rootDir = path.resolve(__dirname, '..');
  for (const name of [
    'Antigravity-JA.bat',
    'Antigravity-Launch.bat',
    'bin/app-silent.vbs',
    'bin/launch-silent.vbs',
  ]) {
    const filePath = path.join(rootDir, name);
    const buf = fs.readFileSync(filePath);
    assert.ok(buf.length > 0, `${name} should not be empty`);
    for (let i = 0; i < buf.length; i++) {
      assert.ok(buf[i] <= 0x7f, `${name} contains non-ASCII byte 0x${buf[i].toString(16)} at offset ${i}`);
      if (buf[i] === 0x0a) {
        assert.ok(i > 0 && buf[i - 1] === 0x0d, `${name} contains bare LF without CR at offset ${i}`);
      }
    }
  }
});

test('Launcher handles fast launch, unpatched auto-patch splash flow, and desktop shortcuts in temp dir', async (t) => {
  const realPaths = resolveAntigravityPaths();
  if (!fs.existsSync(realPaths.asarPath)) {
    t.skip('Installed Antigravity app.asar not found');
    return;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-launch-'));
  const tmpInstallDir = path.join(tmpRoot, 'app');
  const tmpResources = path.join(tmpInstallDir, 'resources');
  const tmpAsar = path.join(tmpResources, 'app.asar');
  const tmpExe = path.join(tmpInstallDir, 'Antigravity.exe');
  const tmpUserDir = path.join(tmpRoot, 'user-data');
  const tmpDesktop = path.join(tmpRoot, 'desktop');

  try {
    fs.mkdirSync(tmpResources, { recursive: true });
    const sourceAsar = fs.existsSync(realPaths.backupPath) ? realPaths.backupPath : realPaths.asarPath;
    fs.copyFileSync(sourceAsar, tmpAsar);
    fs.writeFileSync(tmpExe, 'stub-exe', 'utf8');

    assert.equal(isAppPatchedFast(tmpAsar), false);

    let splashTitle = null;
    let splashClosed = false;
    let launchedExe = null;

    fs.mkdirSync(tmpUserDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpUserDir, 'untranslated.json'),
      JSON.stringify({
        items: {
          'New Update Toggle': { count: 2, tags: ['BUTTON'], roles: ['button'], attrs: [] },
        },
      }),
      'utf8'
    );

    // 1. Unpatched -> should show "日本語化中" splash, auto-patch, auto-translate pending items, close splash, and launch exe
    const resAutoPatch = await launchAntigravity({
      installDir: tmpInstallDir,
      userDataDir: tmpUserDir,
      gui: true,
      skipRunningCheck: true,
      _isRunning: () => false,
      _fetch: async (url) => {
        const q = new URL(url).searchParams.get('q') || '';
        return {
          ok: true,
          status: 200,
          async json() {
            return [[['新アップデート切替', q]]];
          },
        };
      },
      _spawnSplash(opts) {
        splashTitle = opts.title;
        return {
          close() {
            splashClosed = true;
          },
        };
      },
      _spawnExe(exePath) {
        launchedExe = exePath;
      },
    });

    assert.equal(resAutoPatch.launched, true);
    assert.equal(resAutoPatch.patchedNow, true);
    assert.equal(resAutoPatch.autoTranslatedCount, 1);
    assert.equal(splashTitle, '日本語化中');
    assert.equal(splashClosed, true);
    assert.equal(launchedExe, tmpExe);
    assert.equal(isAppPatchedFast(tmpAsar), true);
    const launchAutoJson = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'auto.json'), 'utf8'));
    assert.equal(launchAutoJson.exact['New Update Toggle'], '新アップデート切替');

    // 2. Already patched -> fast launch without splash or re-patching
    let secondSplashOpened = false;
    let secondLaunched = null;
    const resFast = await launchAntigravity({
      installDir: tmpInstallDir,
      userDataDir: tmpUserDir,
      gui: true,
      _spawnSplash() {
        secondSplashOpened = true;
        return { close() {} };
      },
      _spawnExe(exePath) {
        secondLaunched = exePath;
      },
    });
    assert.equal(resFast.launched, true);
    assert.equal(resFast.patchedNow, false);
    assert.equal(secondSplashOpened, false);
    assert.equal(secondLaunched, tmpExe);

    // 3. Desktop shortcut creation into temporary folder (Windows)
    if (process.platform === 'win32') {
      const scRes = createDesktopShortcuts({
        targetDir: tmpDesktop,
        installDir: tmpInstallDir,
        includeManager: true,
      });
      const expected = getShortcutPaths(tmpDesktop);
      assert.equal(scRes.created.length, 2);
      assert.equal(fs.existsSync(expected.launchShortcut), true);
      assert.equal(fs.existsSync(expected.managerShortcut), true);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('jaI18nMain broadcasts updates to WebContentsView and subscribed webContents', async () => {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-main-'));
  const prevEnv = process.env.ANTIGRAVITY_JA_DIR;
  process.env.ANTIGRAVITY_JA_DIR = tmpUserDir;

  const mockApp = new EventEmitter();
  try {
    fs.writeFileSync(
      path.join(tmpUserDir, 'dictionary.json'),
      JSON.stringify({ categories: { common: { exact: { Hello: 'こんにちは' } } }, patterns: [] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpUserDir, 'config.json'),
      JSON.stringify({ enabled: true, collectUntranslated: false, autoCollectTooltips: true, japaneseTypography: true }),
      'utf8'
    );

    const makeWebContents = (name) => {
      const sent = [];
      return {
        name,
        sent,
        isDestroyed() {
          return false;
        },
        send(channel, payload) {
          sent.push({ channel, payload });
        },
        once() {},
      };
    };

    const shellWc = makeWebContents('shell');
    const hubWc = makeWebContents('hubWcv');
    const ipcHandlers = new Map();
    const ipcListeners = new Map();

    const mockElectron = {
      Tray: { prototype: {} },
      Menu: {},
      MenuItem: function MockMenuItem() {},
      dialog: {},
      BrowserWindow: {
        getAllWindows() {
          return [{ isDestroyed: () => false, webContents: shellWc }];
        },
      },
      webContents: {
        getAllWebContents() {
          return [shellWc, hubWc];
        },
      },
      shell: { openPath() {} },
      ipcMain: {
        removeHandler(ch) {
          ipcHandlers.delete(ch);
        },
        handle(ch, fn) {
          ipcHandlers.set(ch, fn);
        },
        on(ch, fn) {
          ipcListeners.set(ch, fn);
        },
      },
      app: mockApp,
    };

    const mainSrcPath = path.resolve(__dirname, '../src/runtime/jaI18nMain.js');
    const mainCode = fs.readFileSync(mainSrcPath, 'utf8');
    const mod = { exports: {} };
    const wrapped = `(function(require, module, exports, __filename, __dirname) {\n${mainCode}\n})`;
    const compiledFn = new vm.Script(wrapped, { filename: 'jaI18nMain.js' }).runInThisContext();
    compiledFn(
      (id) => {
        if (id === 'electron') {
          return mockElectron;
        }
        if (id.startsWith('.')) {
          return require(path.resolve(path.dirname(mainSrcPath), id));
        }
        return require(id);
      },
      mod,
      mod.exports,
      mainSrcPath,
      path.dirname(mainSrcPath)
    );

    mod.exports.initJaI18n();
    mod.exports._setAutoTranslateFetcher(async (url) => {
      const q = new URL(url).searchParams.get('q') || '';
      return {
        ok: true,
        status: 200,
        async json() {
          return [[['真新しいボタン', q]]];
        },
      };
    });

    const getBundleHandler = ipcHandlers.get('antigravity-ja:get-bundle');
    const toggleHandler = ipcHandlers.get('antigravity-ja:toggle');
    assert.equal(typeof getBundleHandler, 'function');
    assert.equal(typeof toggleHandler, 'function');

    const initial = await getBundleHandler({ sender: hubWc });
    assert.equal(initial.enabled, true);
    assert.equal(typeof initial.revision, 'number');
    assert.equal(initial.exact.Hello, 'こんにちは');

    const toggled = await toggleHandler({ sender: hubWc });
    assert.equal(toggled.enabled, false);
    assert.equal(toggled.bundle.enabled, false);
    assert.ok(toggled.bundle.revision > initial.revision);

    // hubWc is only reachable via webContents.getAllWebContents() / subscribedContents (not BrowserWindow.webContents)
    assert.equal(hubWc.sent.length, 1);
    assert.equal(hubWc.sent[0].channel, 'antigravity-ja:bundle-updated');
    assert.equal(hubWc.sent[0].payload.enabled, false);
    assert.equal(shellWc.sent.length, 1);

    // Updating dictionary on disk returns fresh bundle immediately on get-bundle
    fs.writeFileSync(
      path.join(tmpUserDir, 'dictionary.json'),
      JSON.stringify({
        categories: { common: { exact: { Hello: 'こんにちは', World: '世界' } } },
        patterns: [],
      }),
      'utf8'
    );
    const refreshed = await getBundleHandler({ sender: hubWc });
    assert.equal(refreshed.exact.World, '世界');

    // Runtime live auto-discovery + background auto-translation broadcasts updated bundle to hubWc
    const reportListener = ipcListeners.get('antigravity-ja:report-untranslated');
    assert.equal(typeof reportListener, 'function');
    // Re-enable localization and ensure autoTranslate config is active
    await toggleHandler({ sender: hubWc });
    const prevHubSentLen = hubWc.sent.length;
    reportListener({ sender: hubWc }, [
      { text: 'Brand New Button', count: 1, tags: ['BUTTON'], roles: ['button'], attrs: [], inTooltip: false },
      { text: 'scratch', count: 1, tags: ['SPAN'], roles: [], attrs: [], inTooltip: false },
    ]);
    const flushRes = await mod.exports._flushAutoTranslateQueueForTest();
    assert.equal(flushRes.translated, 1);

    const runtimeAuto = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'auto.json'), 'utf8'));
    assert.equal(runtimeAuto.exact['Brand New Button'], '真新しいボタン');
    assert.equal(runtimeAuto.exact.scratch, undefined);
    assert.ok(hubWc.sent.length > prevHubSentLen);
    const lastBroadcast = hubWc.sent[hubWc.sent.length - 1];
    assert.equal(lastBroadcast.channel, 'antigravity-ja:bundle-updated');
    assert.equal(lastBroadcast.payload.exact['Brand New Button'], '真新しいボタン');
  } finally {
    mockApp.emit('will-quit');
    if (prevEnv === undefined) {
      delete process.env.ANTIGRAVITY_JA_DIR;
    } else {
      process.env.ANTIGRAVITY_JA_DIR = prevEnv;
    }
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  }
});
