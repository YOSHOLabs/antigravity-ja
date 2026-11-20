'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildAiTranslationPrompt,
  ensureUserDataDir,
  importCustomTranslations,
  loadBaseDictionary,
  loadGlossary,
  loadMergedBundle,
  pruneTranslatedFromUntranslated,
  validateDictionary,
} = require('../src/dictionary');

test('Bundled ja-base.json and glossary.json pass strict validation with 1850+ exact and 170+ patterns', () => {
  const baseDict = loadBaseDictionary();
  const glossary = loadGlossary();

  const res = validateDictionary(baseDict);
  assert.equal(res.valid, true, `Validation errors: ${res.errors.join('; ')}`);
  assert.ok(res.stats.exactCount >= 1850, `Expected >=1850 exact entries, got ${res.stats.exactCount}`);
  assert.ok(res.stats.patternCount >= 170, `Expected >=170 patterns, got ${res.stats.patternCount}`);
  assert.ok(res.stats.categoryCount >= 5);

  assert.ok(Array.isArray(glossary.toneGuidelines) && glossary.toneGuidelines.length >= 3);
  assert.ok(Array.isArray(glossary.terms) && glossary.terms.length >= 10);
});

test('validateDictionary detects invalid regex patterns, bad backrefs, normalized duplicates, and empty values', () => {
  const bad = {
    categories: {
      c: { label: 'test', exact: { Hello: '', 'Saving...': '保存中...', 'Saving\u2026': '保存中...' } },
    },
    patterns: [
      { pattern: '[unclosed', replace: 'x' },
      { pattern: '^Item (\\d+)$', replace: '項目 $1 / $2' },
    ],
  };
  const res = validateDictionary(bad);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('empty translation')));
  assert.ok(res.errors.some((e) => e.includes('Normalized duplicate')));
  assert.ok(res.errors.some((e) => e.includes('invalid RegExp')));
  assert.ok(res.errors.some((e) => e.includes('$2')));
});

test('buildAiTranslationPrompt, importCustomTranslations (with ignored), and pruneTranslatedFromUntranslated lifecycle', () => {
  const tmpUser = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ja-dict-'));
  try {
    const files = ensureUserDataDir(tmpUser);
    fs.writeFileSync(
      files.untranslatedPath,
      JSON.stringify({
        items: {
          'Open Preview': { count: 4, tags: ['BUTTON'], roles: ['button'], attrs: [] },
          'Share Link': { count: 1, tags: ['SPAN'], roles: [], attrs: [] },
          'Skip Label': { count: 1, tags: ['SPAN'], roles: [], attrs: [] },
          'Ctrl+,': { count: 2, tags: ['SPAN'], roles: [], attrs: [], inTooltip: true },
        },
      }),
      'utf8'
    );

    const prompt = buildAiTranslationPrompt(JSON.parse(fs.readFileSync(files.untranslatedPath, 'utf8')), loadGlossary());
    assert.ok(prompt.includes('Open Preview'));
    assert.ok(prompt.includes('ワークスペース'));
    assert.ok(prompt.includes('JSON'));

    const imported = importCustomTranslations(tmpUser, {
      exact: {
        'Open Preview': 'プレビューを開く',
        Settings: 'カスタマイズ設定',
      },
      ignored: ['Skip Label'],
    });
    assert.equal(imported.added, 2);
    assert.equal(imported.updated, 0);
    assert.equal(imported.removedFromUntranslated, 2);

    const merged = loadMergedBundle(tmpUser);
    assert.equal(merged.exact['Open Preview'], 'プレビューを開く');
    assert.equal(merged.exact['Settings'], 'カスタマイズ設定');
    assert.ok(merged.ignored.includes('Skip Label'));

    const pruned = pruneTranslatedFromUntranslated(tmpUser);
    assert.equal(pruned.removed, 1);
    assert.equal(pruned.remaining, 1);

    const remaining = JSON.parse(fs.readFileSync(files.untranslatedPath, 'utf8'));
    assert.equal(Object.keys(remaining.items).length, 1);
    assert.ok(remaining.items['Share Link']);
  } finally {
    fs.rmSync(tmpUser, { recursive: true, force: true });
  }
});
