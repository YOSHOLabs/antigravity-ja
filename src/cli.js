'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const readline = require('readline');
const { startAppServer, stripJsonCodeFences } = require('./appServer');
const {
  buildAiTranslationPrompt,
  ensureUserDataDir,
  importCustomTranslations,
  loadBaseDictionary,
  loadGlossary,
  pruneTranslatedFromUntranslated,
  readJsonSafe,
  validateDictionary,
} = require('./dictionary');
const { createDesktopShortcuts, isAppPatchedFast, launchAntigravity, openAppWindow } = require('./launcher');
const { getUserDataFiles, resolveAntigravityPaths } = require('./paths');
const { applyPatch, getStatus, isAntigravityRunning, restorePatch } = require('./patcher');

function printHelp() {
  console.log(`Antigravity 日本語UIローカライズ & ランチャー (antigravity-ja)

使い方:
  node src/cli.js <command> [options]

コマンド:
  app                            統合デスクトップアプリ（管理・辞書エディタ）を起動
  launch [--gui]                 日本語化をチェック・自動適用して Antigravity を起動
  create-shortcut [--with-manager]  デスクトップに「Antigravity (日本語)」ショートカットを作成
  status                         現在のインストール・日本語化パッチ・辞書状態を表示
  apply                          app.asar に日本語UIパッチを適用（自動バックアップ付き）
  restore                        バックアップから元の英語UIへ完全に復元
  sync                           最新の基本辞書をユーザーフォルダ (~/.antigravity-ja) へ同期
  validate                       辞書ファイルと用語集の整合性を検証
  export-untranslated [--out F]  収集済み未翻訳テキストのAI一括翻訳プロンプトを出力
  import <jsonFile>              翻訳済みJSONファイルをカスタム辞書へマージ
`);
}

function parseFlags(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--gui') {
      flags.gui = true;
    } else if (a === '--auto-exit') {
      flags.autoExit = true;
    } else if (a === '--with-manager') {
      flags.withManager = true;
    } else if (a === '--port' && i + 1 < args.length) {
      flags.port = Number(args[++i]);
    } else if (a === '--out' && i + 1 < args.length) {
      flags.out = args[++i];
    } else if (a === '--install-dir' && i + 1 < args.length) {
      flags.installDir = args[++i];
    } else if (a === '--user-dir' && i + 1 < args.length) {
      flags.userDataDir = args[++i];
    } else if (a === '-h' || a === '--help') {
      flags.help = true;
    } else {
      positionals.push(a);
    }
  }
  return { flags, positionals };
}

function checkLocalAppAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/ping`, { timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function waitUntilAntigravityClosed() {
  while (isAntigravityRunning()) {
    console.log('');
    console.log('Antigravity が起動中のため、処理を続行できません。');
    console.log(
      '画面右下のタスクトレイの Antigravity アイコンを右クリック →「Quit」（または「終了」）で完全に終了してから、'
    );
    await promptLine('Enter キーを押して続行してください...');
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const { flags, positionals } = parseFlags(argv.slice(1));

  if (!command || command === '--help' || command === '-h' || command === 'help' || flags.help) {
    printHelp();
    process.exit(0);
  }

  if (command === 'status') {
    const st = getStatus({ installDir: flags.installDir, userDataDir: flags.userDataDir });
    console.log('=== Antigravity 日本語UI ステータス ===');
    console.log(`インストール先   : ${st.installDir || '(未検出)'}`);
    console.log(`app.asar 検出    : ${st.installed ? 'あり' : 'なし'}`);
    console.log(`アプリバージョン : ${st.appVersion || '-'}`);
    console.log(`日本語化パッチ   : ${st.patched ? '適用済み' : '未適用'}`);
    console.log(
      `バックアップ     : ${st.backupExists ? (st.backupValid ? 'あり (SHA-256 正常)' : 'あり (整合性警告)') : 'なし'}`
    );
    console.log(`アプリ起動中     : ${st.antigravityRunning ? 'はい' : 'いいえ'}`);
    console.log(`ユーザー辞書     : ${st.userDataDir}`);
    console.log(
      `辞書エントリ数   : 基本 ${st.dictionaryStats.exactCount}件 + パターン ${st.dictionaryStats.patternCount}件 / カスタム ${st.dictionaryStats.customExactCount}件`
    );
    console.log(`未翻訳収集数     : ${st.untranslatedCount}件`);
    return;
  }

  if (command === 'apply') {
    const res = applyPatch({ installDir: flags.installDir, userDataDir: flags.userDataDir });
    console.log('日本語UIパッチを適用しました！');
    console.log(`  アプリバージョン : ${res.appVersion || '-'}`);
    console.log(`  対象 ASAR        : ${res.asarPath}`);
    console.log(`  バックアップ     : ${res.backupPath}${res.backupCreated ? ' (新規作成)' : ' (既存を維持)'}`);
    console.log(`  ユーザー辞書     : ${res.userDataDir}`);
    console.log('');
    console.log('操作ヒント:');
    console.log('  - Antigravity を起動すると日本語UIが有効になります。');
    console.log('  - 画面上で Ctrl+Alt+J : 日本語UI / 英語UI をリアルタイム切り替え');
    console.log('  - 画面上で Ctrl+Alt+Shift+J : 未翻訳UIテキストの自動収集 ON/OFF');
    console.log('  - トレイアイコン右クリック「日本語UI」からも設定や辞書フォルダを開けます。');
    return;
  }

  if (command === 'restore') {
    const res = restorePatch({ installDir: flags.installDir });
    console.log('元の英語UI (バックアップ) へ復元しました。');
    console.log(`  復元先 ASAR : ${res.asarPath}`);
    return;
  }

  if (command === 'sync') {
    const files = ensureUserDataDir(flags.userDataDir, { refreshBaseDict: true });
    const pruned = pruneTranslatedFromUntranslated(flags.userDataDir);
    console.log(`最新の基本辞書を同期しました: ${files.baseDictPath}`);
    if (pruned.removed > 0) {
      console.log(`未翻訳リストから翻訳済み・不要な項目 ${pruned.removed}件 を整理しました（残り ${pruned.remaining}件）`);
    }
    console.log('（設定やカスタム辞書はそのまま保持されています）');
    return;
  }

  if (command === 'validate') {
    const baseDict = loadBaseDictionary();
    const glossary = loadGlossary();
    const files = getUserDataFiles(flags.userDataDir);
    const customDict = fs.existsSync(files.customDictPath) ? readJsonSafe(files.customDictPath, null) : undefined;
    const result = validateDictionary(baseDict, customDict);
    if (!glossary || !Array.isArray(glossary.terms) || !Array.isArray(glossary.toneGuidelines)) {
      result.errors.push('glossary.json format invalid');
      result.valid = false;
    }
    if (!result.valid) {
      console.error('辞書の検証でエラーが見つかりました:');
      for (const e of result.errors) {
        console.error('  -', e);
      }
      process.exit(1);
    }
    console.log(
      `辞書検証 OK: 基本 ${result.stats.exactCount}件 (${result.stats.categoryCount}カテゴリ), パターン ${result.stats.patternCount}件, 用語集 ${glossary.terms.length}語`
    );
    return;
  }

  if (command === 'export-untranslated') {
    const files = ensureUserDataDir(flags.userDataDir, { refreshBaseDict: false });
    const untranslated = readJsonSafe(files.untranslatedPath, { items: {} });
    const glossary = loadGlossary();
    const prompt = buildAiTranslationPrompt(untranslated, glossary);
    if (flags.out) {
      const outPath = path.resolve(flags.out);
      fs.writeFileSync(outPath, prompt + '\n', 'utf8');
      console.log(`AI翻訳プロンプトを書き出しました: ${outPath}`);
    } else {
      process.stdout.write(prompt + '\n');
    }
    return;
  }

  if (command === 'import') {
    const targetFile = positionals[0];
    if (!targetFile) {
      throw new Error('インポートするJSONファイルパスを指定してください。');
    }
    const raw = fs.readFileSync(path.resolve(targetFile), 'utf8');
    const parsed = JSON.parse(stripJsonCodeFences(raw));
    const res = importCustomTranslations(flags.userDataDir, parsed);
    console.log(
      `インポート完了: 追加 ${res.added}件 / 更新 ${res.updated}件 / 未翻訳リストから削除 ${res.removedFromUntranslated}件`
    );
    return;
  }

  if (command === 'launch') {
    const paths = resolveAntigravityPaths(flags.installDir);
    if (!flags.gui && fs.existsSync(paths.asarPath) && !isAppPatchedFast(paths.asarPath)) {
      await waitUntilAntigravityClosed();
    }
    const res = launchAntigravity({
      installDir: flags.installDir,
      userDataDir: flags.userDataDir,
      gui: Boolean(flags.gui),
      passThroughArgs: positionals,
    });
    if (!flags.gui && res.launched) {
      console.log(res.patchedNow ? '日本語化を適用して Antigravity を起動しました。' : 'Antigravity を起動しました。');
    }
    return;
  }

  if (command === 'create-shortcut') {
    const res = createDesktopShortcuts({
      installDir: flags.installDir,
      includeManager: Boolean(flags.withManager),
    });
    console.log('デスクトップショートカットを作成しました:');
    for (const p of res.created) {
      console.log(`  - ${p}`);
    }
    return;
  }

  if (command === 'app') {
    const requestedPort = flags.port !== undefined ? flags.port : 43210;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      throw new Error(`ポート番号は 0〜65535 の整数で指定してください: ${flags.port}`);
    }
    let instance;
    try {
      instance = await startAppServer({
        port: requestedPort,
        installDir: flags.installDir,
        userDataDir: flags.userDataDir,
        autoExit: Boolean(flags.autoExit),
      });
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        if (requestedPort > 0 && (await checkLocalAppAlive(requestedPort))) {
          const existingUrl = `http://127.0.0.1:${requestedPort}/`;
          openAppWindow(existingUrl);
          console.log(`Antigravity 日本語化マネージャーはすでに起動中です: ${existingUrl}`);
          return;
        }
        if (flags.port === undefined) {
          instance = await startAppServer({
            port: 0,
            installDir: flags.installDir,
            userDataDir: flags.userDataDir,
            autoExit: Boolean(flags.autoExit),
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    console.log(`Antigravity 日本語化マネージャーを起動しました: ${instance.url}`);
    console.log('終了するには Ctrl+C を押してください。');
    openAppWindow(instance.url);
    await new Promise(() => {});
    return;
  }

  throw new Error(`不明なコマンドです: ${command}`);
}

main().catch((err) => {
  console.error(`エラー: ${err.message}`);
  process.exit(1);
});
