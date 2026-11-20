'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadBaseDictionary, flattenExactMap } = require('../src/dictionary');
const {
  compileBundle,
  shouldCollectCandidate,
  shouldSkipNodeForTranslation,
  translateText,
} = require('../src/runtime/translatorCore');

function makeNode(tagName, opts = {}, parent = null) {
  return {
    tagName,
    id: opts.id || '',
    className: opts.className || '',
    isContentEditable: Boolean(opts.isContentEditable),
    attributes: opts.attributes || {},
    parentElement: parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
    },
  };
}

test('Exact translation, custom override priority, and whitespace preservation', () => {
  const base = loadBaseDictionary();
  const compiled = compileBundle({
    enabled: true,
    collectUntranslated: false,
    exact: {
      ...flattenExactMap(base),
      Settings: 'カスタム設定',
    },
    patterns: base.patterns,
    ignored: ['Ignored Label'],
  });

  const hit = translateText('  New Conversation\n', compiled);
  assert.equal(hit.changed, true);
  assert.equal(hit.value, '  新しい会話\n');

  const overridden = translateText('Settings', compiled);
  assert.equal(overridden.changed, true);
  assert.equal(overridden.value, 'カスタム設定');

  const miss = translateText('Unknown Label', compiled);
  assert.equal(miss.changed, false);
  assert.equal(miss.value, 'Unknown Label');
});

test('Regex patterns translate dynamic counters, thinking duration, and relative timestamps', () => {
  const base = loadBaseDictionary();
  const compiled = compileBundle({
    enabled: true,
    exact: flattenExactMap(base),
    patterns: base.patterns,
    ignored: [],
  });

  assert.equal(translateText('Thought for 3.2s', compiled).value, '3.2秒間思考しました');
  assert.equal(translateText('Thought for 1m 14s', compiled).value, '1分14秒間思考しました');
  assert.equal(translateText('5 files changed', compiled).value, '5件のファイルを変更');
  assert.equal(translateText('2 agents running', compiled).value, '2個のエージェントが実行中');
  assert.equal(translateText('12 minutes ago', compiled).value, '12分前');
  assert.equal(translateText('Show 4 more', compiled).value, 'さらに4件を表示');
  assert.equal(translateText('Version 2.33.0', compiled).value, 'バージョン 2.33.0');
  assert.equal(
    translateText('To plan with Gemini 4 Neon and hand implementation work to Gemini 4 Hydrogen, select Orchestrator.', compiled).value,
    'Gemini 4 Neon で計画を立て、実装作業を Gemini 4 Hydrogen に引き継ぐには Orchestrator を選択してください。'
  );
  assert.equal(translateText('75% left', compiled).value, '残り 75%');
  assert.equal(translateText('Resets in 2h 30m', compiled).value, '2時間30分後にリセット');
  assert.equal(
    translateText('Select model, current: Orchestrator (Neon)', compiled).value,
    'モデルを選択（現在: Orchestrator (Neon)）'
  );
  assert.equal(translateText('Notice', compiled).value, '注意');
  assert.equal(translateText('Unavailable', compiled).value, '利用不可');
  assert.equal(
    translateText('Argon that may offload routine steps to Hydrogen. Same Argon-level quality, fewer tokens used.', compiled).value,
    '定型作業を Hydrogen に任せることがある Argon。Argon と同等の品質を保ちつつ、トークン消費を抑えます。'
  );
  assert.equal(
    translateText('Neon that may offload routine steps to Hydrogen. Same Neon-level quality, fewer tokens used.', compiled).value,
    '定型作業を Hydrogen に任せることがある Neon。Neon と同等の品質を保ちつつ、トークン消費を抑えます。'
  );
  assert.equal(
    translateText('This model will be removed on November 18, 2026.', compiled).value,
    'このモデルは November 18, 2026 に提供終了予定です。'
  );
  assert.equal(
    translateText('Only available on Google AI Ultra.', compiled).value,
    'Google AI Ultra プランでのみ利用可能です。'
  );
  assert.equal(translateText('Blocked, needs input', compiled).value, '入力待ちで停止中');
  assert.equal(translateText('Side Question', compiled).value, 'サイド質問');
  assert.equal(translateText('Staged Changes', compiled).value, 'ステージ済みの変更');
  assert.equal(translateText('Open in Antigravity IDE', compiled).value, 'Antigravity IDE で開く');
  assert.equal(translateText('No active terminals', compiled).value, '実行中のターミナルはありません');
  assert.equal(translateText('Ran command', compiled).value, 'コマンドを実行');
  assert.equal(translateText('Thought Process', compiled).value, '思考プロセス');
  assert.equal(translateText('Waiting for your approval', compiled).value, '承認待ち');
  assert.equal(translateText('Plan, 3 of 5 steps done', compiled).value, '計画（3 / 5 ステップ完了）');
  assert.equal(translateText('12 lines added, 4 lines removed', compiled).value, '12行追加、4行削除');
  assert.equal(translateText('Available AI Credits: 500', compiled).value, '利用可能な AI クレジット: 500');
  assert.equal(translateText('Turn 2 of 8', compiled).value, 'ターン 2 / 8');
  assert.equal(
    translateText('The folder \u201cdemo\u201d does not exist. Would you like to create it?', compiled).value,
    'フォルダー「demo」は存在しません。新しく作成しますか？'
  );
  assert.equal(translateText('For speed and efficiency in execution tasks', compiled).value, '実行タスクでのスピードと効率性に優れたモデルです');
  assert.equal(translateText('The original Gemini 4 model for advanced workflows', compiled).value, '高度なワークフロー向けのオリジナル Gemini 4 モデルです');
  assert.equal(translateText('For most deep reasoning and complex problems', compiled).value, '深い推論や複雑な課題のほとんどに最適なモデルです');
  assert.equal(translateText('Cancel (Ctrl+D)', compiled).value, 'キャンセル (Ctrl+D)');
  assert.equal(translateText('Start Voice mode', compiled).value, '音声モードを開始');
  assert.equal(translateText('Record Audio', compiled).value, '音声を録音');
  assert.equal(translateText('Submit (\u21b5)', compiled).value, '送信 (\u21b5)');
  assert.equal(translateText('Daily limit, resets in 4h 23m', compiled).value, '1日の上限（4時間23分後にリセット）');
  assert.equal(
    translateText('Your quota for Gemini 4 Neon will reset on 2026-11-21. Switch to another available model to continue.', compiled).value,
    'Gemini 4 Neon のクォータは 2026-11-21 にリセットされます。続けるには利用可能な別のモデルに切り替えてください。'
  );
  assert.equal(
    translateText('Agent settings and permissions for conversations outside of projects.', compiled).value,
    'プロジェクト外の会話に対するエージェント設定と権限を管理します。'
  );
  assert.equal(translateText('Also includes', compiled).value, '併せて適用:');
  assert.equal(translateText('when working', compiled).value, '／適用範囲:');
  assert.equal(translateText('in these conversations', compiled).value, 'これらの会話');
  assert.equal(
    translateText('The breakdown below shows token usage from customizations like rules, skills, and MCP. If a budget is exceeded, large rules are demoted to path pointers and large customizations are excluded automatically.', compiled).value,
    '以下の内訳は、ルール・スキル・MCP などのカスタマイズによるトークン使用量を示しています。上限を超えた場合、大きなルールはパス参照に軽量化され、大きなカスタマイズは自動的に除外されます。'
  );
  assert.equal(translateText('Show 11 breakdowns', compiled).value, '11件の内訳を表示');
  assert.equal(translateText('tokens (', compiled).value, 'トークン (');
  assert.equal(translateText('tokens)', compiled).value, 'トークン)');
  assert.equal(translateText('Unlock the power of agent swarms.', compiled).value, 'エージェントスウォーム（複数エージェントの並列協調）機能を有効にします。');
  assert.equal(translateText('Knowledge Work', compiled).value, 'ナレッジワーク');
  assert.equal(
    translateText('Simplified interface for research, writing, and everyday tasks.', compiled).value,
    'リサーチ・文章作成・日常業務向けのシンプルな画面です。'
  );
  assert.equal(translateText('Software Engineering', compiled).value, 'ソフトウェア開発');
  assert.equal(
    translateText('Full interface for coding, developer tools, and managing agents.', compiled).value,
    'コーディング・開発ツール・エージェント管理向けのフル機能画面です。'
  );
  assert.equal(
    translateText('Gemini 4 Carbon is currently available to Ultra plan subscribers.', compiled).value,
    'Gemini 4 Carbon は現在 Ultra プランの契約者向けに提供されています。'
  );
  assert.equal(translateText('Ask anything, @ to mention, / for actions', compiled).value, '何でも質問してください（@ で参照、/ でアクション）');
  assert.equal(translateText('Edit Conversation Title', compiled).value, '会話タイトルを編集');
  assert.equal(translateText('Undo to this point', compiled).value, 'この時点まで元に戻す');
  assert.equal(translateText('Gemini Models', compiled).value, 'Gemini モデル');
  assert.equal(translateText('Claude and GPT models', compiled).value, 'Claude・GPT モデル');
  assert.equal(translateText('Thinking for 5s', compiled).value, '5秒間思考中');
  assert.equal(translateText('Still thinking, 16 seconds', compiled).value, '引き続き思考中（16秒）');
  assert.equal(translateText('Worked for 35s', compiled).value, '35秒間作業しました');
  assert.equal(translateText('Worked for 2m', compiled).value, '2分間作業しました');
  assert.equal(translateText('Load older messages, showing 54 of 633', compiled).value, '古いメッセージを読み込む（633件中 54件を表示中）');
  assert.equal(translateText('Agent permissions preset selector, current: Turbo', compiled).value, 'エージェント権限プリセット（現在: Turbo）');
  assert.equal(translateText('Reading README.md', compiled).value, 'README.md を読み込み中');
  assert.equal(translateText('Editing package.json', compiled).value, 'package.json を編集中');
  assert.equal(translateText('Explored files, ran commands, edited files', compiled).value, 'ファイル探索・コマンド実行・ファイル編集');
  assert.equal(
    translateText('Comprehensive guide and reference for the Antigravity Customization System. Use to explain how customizations work, their loading priority, discovery mechanisms, and to guide the creation of skills, rules, plugins, hooks, and MCP servers.', compiled).changed,
    true
  );
  assert.equal(compiled.autoCollectTooltips, true);
  assert.equal(compiled.japaneseTypography, true);
});

test('Typographic normalization handles curly apostrophes, ellipses, and multi-line descriptions', () => {
  const base = loadBaseDictionary();
  const compiled = compileBundle({
    enabled: true,
    exact: flattenExactMap(base),
    patterns: base.patterns,
    ignored: [],
  });

  assert.equal(translateText('Saving\u2026', compiled).value, '保存中...');
  assert.equal(
    translateText('Your agent\u2019s ability to execute commands is also controlled by enterprise security policies.', compiled).value,
    'エージェントによるコマンド実行権限は、エンタープライズセキュリティポリシーによっても制御されます。'
  );
  assert.equal(
    translateText('Controls whether terminal commands require your approval before running.\n\nNote: A change to this setting will only apply to new messages sent to the agent. In-progress responses will use the previous setting value.', compiled).changed,
    true
  );
});

test('DOM exclusion skips code, pre, textarea, contenteditable, xterm, monaco, and prose while translating buttons inside prose', () => {
  const root = makeNode('DIV', { className: 'app-shell' });
  const sidebarBtn = makeNode('BUTTON', {}, root);
  assert.equal(shouldSkipNodeForTranslation(sidebarBtn, false), false);

  const codeEl = makeNode('CODE', {}, root);
  assert.equal(shouldSkipNodeForTranslation(codeEl, false), true);

  const preSpan = makeNode('SPAN', {}, makeNode('PRE', {}, root));
  assert.equal(shouldSkipNodeForTranslation(preSpan, false), true);

  const textarea = makeNode('TEXTAREA', {}, root);
  assert.equal(shouldSkipNodeForTranslation(textarea, false), true);
  assert.equal(shouldSkipNodeForTranslation(textarea, true), false);

  const editable = makeNode('DIV', { isContentEditable: true }, root);
  assert.equal(shouldSkipNodeForTranslation(makeNode('SPAN', {}, editable), false), true);

  const xterm = makeNode('DIV', { className: 'xterm-rows' }, root);
  assert.equal(shouldSkipNodeForTranslation(makeNode('SPAN', {}, xterm), false), true);

  const monaco = makeNode('DIV', { className: 'monaco-editor' }, root);
  assert.equal(shouldSkipNodeForTranslation(makeNode('SPAN', {}, monaco), false), true);

  const prose = makeNode('DIV', { className: 'prose markdown-body' }, root);
  const prosePara = makeNode('P', {}, prose);
  assert.equal(shouldSkipNodeForTranslation(prosePara, false), true);

  const proseBtn = makeNode('BUTTON', {}, prose);
  const proseBtnSpan = makeNode('SPAN', {}, proseBtn);
  assert.equal(shouldSkipNodeForTranslation(proseBtnSpan, false), false);

  const codeInsideBtn = makeNode('CODE', {}, proseBtn);
  assert.equal(shouldSkipNodeForTranslation(codeInsideBtn, false), true);
});

test('shouldCollectCandidate accepts genuine English UI labels and filters non-UI noise', () => {
  const base = loadBaseDictionary();
  const compiled = compileBundle({
    enabled: true,
    collectUntranslated: true,
    exact: flattenExactMap(base),
    patterns: base.patterns,
    ignored: ['Skip Me'],
  });

  assert.equal(shouldCollectCandidate('Open Unmapped Command', { tagName: 'BUTTON' }, compiled), true);
  assert.equal(shouldCollectCandidate('Workspace Rules', { tagName: 'SPAN' }, compiled), true);
  assert.equal(shouldCollectCandidate('Settings', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('Skip Me', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('新しい会話', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('https://antigravity.google/docs', { tagName: 'A' }, compiled), false);
  assert.equal(shouldCollectCandidate('C:\\Users\\example\\project', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('/usr/local/bin/node', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('12345678-1234-5678-1234-567812345678', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('a1b2c3d4e5f67890', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('2.33.0', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('12345', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('enableTerminalSandbox', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('my_variable_name', { tagName: 'SPAN' }, compiled), false);
  assert.equal(shouldCollectCandidate('Search...', { tagName: 'INPUT', attr: 'placeholder' }, compiled), false);
  assert.equal(shouldCollectCandidate('Filter rules...', { tagName: 'INPUT', attr: 'placeholder' }, compiled), true);
  assert.equal(shouldCollectCandidate('Ctrl+,', { tagName: 'SPAN', inTooltip: true }, compiled), false);
  assert.equal(shouldCollectCandidate('Ctrl+/', { tagName: 'SPAN', inTooltip: true }, compiled), false);
  assert.equal(shouldCollectCandidate('Alt+Enter', { tagName: 'DIV', inTooltip: true }, compiled), false);
  assert.equal(shouldCollectCandidate('Enter', { tagName: 'DIV', inTooltip: true }, compiled), false);
  assert.equal(shouldCollectCandidate('Another untranslated tooltip message', { tagName: 'DIV', inTooltip: true }, compiled), true);
  assert.equal(
    shouldCollectCandidate(
      'This experimental model routes complex reasoning steps automatically.\nUse for large refactors.',
      { tagName: 'DIV', inTooltip: true },
      compiled
    ),
    true
  );
});
