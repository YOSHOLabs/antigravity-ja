'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  importCustomTranslations,
  loadMergedBundle,
  pruneTranslatedFromUntranslated,
} = require('../src/dictionary');
const {
  DEFAULT_AUTO_CONFIG,
  isSafeForAutoTranslate,
  normalizeConfig,
  postProcessTranslation,
  runAutoTranslateForUserDir,
  translateBatch,
} = require('../src/runtime/autoTranslator');

test('isSafeForAutoTranslate accepts short safe UI labels/tooltips and rejects sensitive or noisy strings', () => {
  // Safe UI labels and descriptions
  assert.equal(isSafeForAutoTranslate('Open Settings'), true);
  assert.equal(isSafeForAutoTranslate('Compact Conversation'), true);
  assert.equal(isSafeForAutoTranslate('Review your pending changes before running'), true);
  assert.equal(isSafeForAutoTranslate('Filter rules...'), true);
  assert.equal(
    isSafeForAutoTranslate('Fast thinking model optimized for UI debugging.', { inTooltip: true }),
    true
  );

  // Keycaps, shortcuts, CSS units, bare filenames, lowercase workspace names
  assert.equal(isSafeForAutoTranslate('Ctrl'), false);
  assert.equal(isSafeForAutoTranslate('Shift'), false);
  assert.equal(isSafeForAutoTranslate('Enter', { inTooltip: true }), false);
  assert.equal(isSafeForAutoTranslate('Ctrl+K'), false);
  assert.equal(isSafeForAutoTranslate('14px'), false);
  assert.equal(isSafeForAutoTranslate('100%'), false);
  assert.equal(isSafeForAutoTranslate('sync-dict.bat'), false);
  assert.equal(isSafeForAutoTranslate('app.asar'), false);
  assert.equal(isSafeForAutoTranslate('scratch'), false);
  assert.equal(isSafeForAutoTranslate('uu aa'), false);

  // Sensitive secrets, paths, URLs, emails, UUIDs, standalone brands/models, code
  assert.equal(isSafeForAutoTranslate('sk-1234567890abcdef1234567890abcdef'), false);
  assert.equal(isSafeForAutoTranslate('AIzaSyD-1234567890abcdef1234567890'), false);
  assert.equal(isSafeForAutoTranslate('C:\\Users\\Developer\\project\\main.js'), false);
  assert.equal(isSafeForAutoTranslate('/usr/local/bin/node'), false);
  assert.equal(isSafeForAutoTranslate('https://example.com/api/v1'), false);
  assert.equal(isSafeForAutoTranslate('user@example.com'), false);
  assert.equal(isSafeForAutoTranslate('Signed in as alice@example.com'), false);
  assert.equal(isSafeForAutoTranslate('Open C:\\Users\\Dev\\secret\\file.txt'), false);
  assert.equal(isSafeForAutoTranslate('Visit https://internal.example/docs for info'), false);
  assert.equal(isSafeForAutoTranslate('github_pat_1234567890abcdef1234567890'), false);
  assert.equal(isSafeForAutoTranslate('AKIAIOSFODNN7EXAMPLE'), false);
  assert.equal(isSafeForAutoTranslate('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc'), false);
  assert.equal(isSafeForAutoTranslate('550e8400-e29b-41d4-a716-446655440000'), false);
  assert.equal(isSafeForAutoTranslate('Antigravity'), false);
  assert.equal(isSafeForAutoTranslate('Gemini 4 Neon'), false);
  assert.equal(isSafeForAutoTranslate('GitHub'), false);
  assert.equal(isSafeForAutoTranslate('MIT License'), false);
  assert.equal(isSafeForAutoTranslate('const value = foo.bar();'), false);
});

test('postProcessTranslation normalizes Antigravity term, strips quotes, and rejects invalid outputs', () => {
  assert.equal(
    postProcessTranslation('「反重力 モードを開く」', 'Open Antigravity Mode'),
    'Antigravity モードを開く'
  );
  assert.equal(postProcessTranslation('設定を開く', 'Open Settings'), '設定を開く');
  assert.equal(postProcessTranslation('Open Settings', 'Open Settings'), null);
  assert.equal(postProcessTranslation('abc def', 'Open Settings'), null);
  assert.equal(postProcessTranslation('', 'Open Settings'), null);
  assert.equal(postProcessTranslation('あ'.repeat(300), 'Open Settings'), null);
});

test('normalizeConfig exposes expected defaults including autoTranslate ON and free provider', () => {
  const cfg = normalizeConfig({});
  assert.equal(cfg.autoTranslate, DEFAULT_AUTO_CONFIG.autoTranslate);
  assert.equal(cfg.autoTranslate, true);
  assert.equal(cfg.autoTranslateProvider, 'free');
  assert.equal(cfg.autoTranslateApiKey, '');
});

test('translateBatch supports free (with bisect recovery), gemini, openai, and ollama providers', async () => {
  // 1. Free provider normal batch
  const freeNormal = await translateBatch(
    ['Open Settings', 'Compact Conversation'],
    { autoTranslateProvider: 'free' },
    {
      _fetch: async (url) => {
        assert.match(url, /translate\.googleapis\.com\/translate_a\/single/);
        return {
          ok: true,
          status: 200,
          async json() {
            return [[['設定を開く\n', 'Open Settings\n'], ['会話をコンパクトにする', 'Compact Conversation']]];
          },
        };
      },
    }
  );
  assert.equal(freeNormal['Open Settings'], '設定を開く');
  assert.equal(freeNormal['Compact Conversation'], '会話をコンパクトにする');

  // 2. Free provider recursive bisect fallback when joined line count mismatches
  let freeCalls = 0;
  const freeBisect = await translateBatch(
    ['Open Settings', 'Clear Cache'],
    { autoTranslateProvider: 'free' },
    {
      _fetch: async (url) => {
        freeCalls += 1;
        const parsed = new URL(url);
        const q = parsed.searchParams.get('q') || '';
        if (q.includes('\n')) {
          return {
            ok: true,
            status: 200,
            async json() {
              // Wrong line count (1 line instead of 2) triggers bisect
              return [[['設定を開く、キャッシュを削除', q]]];
            },
          };
        }
        const ja = q === 'Open Settings' ? '設定を開く' : 'キャッシュを削除';
        return {
          ok: true,
          status: 200,
          async json() {
            return [[[ja, q]]];
          },
        };
      },
    }
  );
  assert.equal(freeCalls, 3);
  assert.equal(freeBisect['Open Settings'], '設定を開く');
  assert.equal(freeBisect['Clear Cache'], 'キャッシュを削除');

  // 3. Gemini provider (key must be sent via x-goog-api-key header, never URL query string)
  const geminiRes = await translateBatch(
    ['Start New Session'],
    { autoTranslateProvider: 'gemini', autoTranslateApiKey: 'test-gemini-key' },
    {
      _fetch: async (url, init) => {
        assert.match(url, /generativelanguage\.googleapis\.com/);
        assert.equal(url.includes('test-gemini-key'), false);
        assert.equal(init.headers['x-goog-api-key'], 'test-gemini-key');
        assert.equal(init.method, 'POST');
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              candidates: [
                {
                  content: {
                    parts: [{ text: '{"Start New Session": "新しいセッションを開始"}' }],
                  },
                },
              ],
            };
          },
        };
      },
    }
  );
  assert.equal(geminiRes['Start New Session'], '新しいセッションを開始');

  // 4. OpenAI provider
  const openaiRes = await translateBatch(
    ['Toggle Sidebar'],
    { autoTranslateProvider: 'openai', autoTranslateApiKey: 'test-openai-key' },
    {
      _fetch: async (url, init) => {
        assert.match(url, /api\.openai\.com\/v1\/chat\/completions/);
        assert.equal(init.headers.Authorization, 'Bearer test-openai-key');
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              choices: [
                {
                  message: { content: '```json\n{"Toggle Sidebar": "サイドバーを切り替え"}\n```' },
                },
              ],
            };
          },
        };
      },
    }
  );
  assert.equal(openaiRes['Toggle Sidebar'], 'サイドバーを切り替え');

  // 5. Ollama local provider
  const ollamaRes = await translateBatch(
    ['Export Logs'],
    {
      autoTranslateProvider: 'ollama',
      autoTranslateEndpoint: 'http://127.0.0.1:11434',
      autoTranslateModel: 'gemma3',
    },
    {
      _fetch: async (url, init) => {
        assert.equal(url, 'http://127.0.0.1:11434/api/chat');
        const parsed = JSON.parse(init.body);
        assert.equal(parsed.model, 'gemma3');
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              message: { content: '{"Export Logs": "ログをエクスポート"}' },
            };
          },
        };
      },
    }
  );
  assert.equal(ollamaRes['Export Logs'], 'ログをエクスポート');

  // 6. Reject non-local plaintext http:// custom endpoints
  await assert.rejects(
    () =>
      translateBatch(
        ['Export Logs'],
        {
          autoTranslateProvider: 'openai',
          autoTranslateApiKey: 'test-openai-key',
          autoTranslateEndpoint: 'http://remote.example/v1/chat/completions',
        },
        {
          _fetch: async () => {
            throw new Error('Should not have called fetch');
          },
        }
      ),
    /https:\/\//
  );
});

test('runAutoTranslateForUserDir persists auto.json, prunes untranslated.json, and respects custom > base > auto priority', async () => {
  const tmpUserDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-autotrans-'));
  try {
    fs.writeFileSync(
      path.join(tmpUserDir, 'untranslated.json'),
      JSON.stringify({
        items: {
          'Open Feature Preview': { count: 3, tags: ['BUTTON'], roles: ['button'], attrs: [] },
          'Ctrl+K': { count: 2, tags: ['SPAN'], roles: [], attrs: [] },
          scratch: { count: 5, tags: ['SPAN'], roles: [], attrs: [] },
        },
      }),
      'utf8'
    );

    const mockFetch = async (url) => {
      const parsed = new URL(url);
      const q = parsed.searchParams.get('q') || '';
      return {
        ok: true,
        status: 200,
        async json() {
          return [[[`機能プレビューを開く`, q]]];
        },
      };
    };

    const res = await runAutoTranslateForUserDir(tmpUserDir, { _fetch: mockFetch });
    assert.equal(res.attempted, 1);
    assert.equal(res.translated, 1);

    const autoData = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'auto.json'), 'utf8'));
    assert.equal(autoData.exact['Open Feature Preview'], '機能プレビューを開く');

    // Noise items should be pruned or untouched cleanly; translated item removed from pending untranslated
    const untData = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'untranslated.json'), 'utf8'));
    assert.equal(untData.items['Open Feature Preview'], undefined);

    // Custom translation overrides auto.json in loadMergedBundle and prunes duplicate from auto.json
    importCustomTranslations(tmpUserDir, { 'Open Feature Preview': 'カスタム機能プレビュー' });
    pruneTranslatedFromUntranslated(tmpUserDir);

    const bundle = loadMergedBundle(tmpUserDir);
    assert.equal(bundle.exact['Open Feature Preview'], 'カスタム機能プレビュー');

    const autoAfterOverride = JSON.parse(fs.readFileSync(path.join(tmpUserDir, 'auto.json'), 'utf8'));
    assert.equal(autoAfterOverride.exact['Open Feature Preview'], undefined);

    // Disabled config skips run unless force: true
    fs.writeFileSync(
      path.join(tmpUserDir, 'config.json'),
      JSON.stringify({ autoTranslate: false }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpUserDir, 'untranslated.json'),
      JSON.stringify({ items: { 'Another New Label': { count: 1, tags: ['BUTTON'], roles: [], attrs: [] } } }),
      'utf8'
    );
    const disabledRes = await runAutoTranslateForUserDir(tmpUserDir, { _fetch: mockFetch });
    assert.equal(disabledRes.disabled, true);
    assert.equal(disabledRes.translated, 0);

    const forcedRes = await runAutoTranslateForUserDir(tmpUserDir, {
      force: true,
      _fetch: async (url) => {
        const q = new URL(url).searchParams.get('q') || '';
        return {
          ok: true,
          status: 200,
          async json() {
            return [[['別の新しいラベル', q]]];
          },
        };
      },
    });
    assert.equal(forcedRes.translated, 1);
  } finally {
    fs.rmSync(tmpUserDir, { recursive: true, force: true });
  }
});
