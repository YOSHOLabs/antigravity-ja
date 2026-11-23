# Antigravity 日本語UIマネージャー (`antigravity-ja`)

Antigravity App（Antigravity 2.0 デスクトップアプリ）のUIを、自然で読みやすい日本語へリアルタイムにローカライズするための **統合デスクトップアプリ＆自動日本語化ランチャー** です。

---

## 主な特徴

- **統合アプリ画面 (`Antigravity-JA.bat`)**: パッチの適用・復元・自動起動ショートカット作成・辞書同期・未翻訳収集・ライブ辞書編集までを 1 つの専用アプリウィンドウから操作できます（黒いコンソール画面は出ません）。
- **アップデート後も自動で日本語化 (`Antigravity-Launch.bat` / デスクトップショートカット)**:
  - すでに日本語化済みなら待ち時間ゼロで即起動
  - Antigravity 本体が自動アップデートされて英語に戻っていた場合は、**「日本語化中...」** のスプラッシュ表示とともに自動で最新パッチを再適用し、未翻訳の新規UIも自動翻訳してから起動します
- **アプデ新UI 自動発見＆自動翻訳 (`auto.json`)**:
  - 起動時（未適用・アプデ検出時）および Antigravity 使用中のバックグラウンドで、安全フィルタを通過した新規英語UI・ツールチップを自動発見して即時日本語化し、`%USERPROFILE%\.antigravity-ja\auto.json` へ永続キャッシュします
  - 無料のキー不要エンジン（`free`）に加え、Gemini API / OpenAI API / ローカル Ollama への切り替えやON/OFFを統合管理アプリから設定可能
  - チャット本文・コード・ターミナル出力・APIキー・URL・ローカルパス等は厳格に除外されるプライバシー設計で、優先度は **`custom.json` > `ja-base.json` (`dictionary.json`) > `auto.json`** です
- **安全なリバーシブル適用**: 初回適用時に元の `app.asar` を `app.asar.ja-backup`（SHA-256 検証付き）としてバックアップし、ワンクリックでいつでも元の英語UIへ完全復元できます。
- **自然な日本語辞書＋動的パターン**: **1,935件**の基本UI辞書（9カテゴリ）と **191件**の動的正規表現パターン（思考時間、作業時間、変更ファイル数、モデル説明ツールチップ、クォータ残量、エージェント実行ステップ、トークン使用量、相対時刻など）を搭載。設定やカスタム翻訳は `%USERPROFILE%\.antigravity-ja\` に保持されるため、本体アップデートで消えません。
- **チャット本文・コード・ターミナルを保護**: `<code>`・`<pre>`・`<textarea>`・`[contenteditable]`・Monaco エディタ・ターミナル（`.xterm`）・AIのチャット応答本文は翻訳せず、ボタンやメニュー等のUI要素だけを安全に日本語化します。
- **日本語フォント最適化（`lang="ja"`）& ライブ反映**: Chromium の日本語字体適用で漢字の字体崩れを防ぎ、Antigravity 画面上の `Ctrl+Alt+J` で ON / OFF、辞書編集も再起動なしで即時反映されます。

---

## 動作要件

- **OS**: Windows 10 / 11（macOS / Linux 向け CLI 操作にも対応）
- **ランタイム**: Node.js 20 以上（外部パッケージ依存ゼロ・`npm install` 不要）

---

## 入手方法

GitHub のリポジトリページ右上にある **`Code` → `Download ZIP`** からダウンロードして任意のフォルダーへ展開するか、`git clone` で取得してください。

```bash
git clone https://github.com/YOSHOLabs/antigravity-ja.git
cd antigravity-ja
```

---

## 使い方（最短 2 ステップ）

1. **[`Antigravity-JA.bat`](./Antigravity-JA.bat)** をダブルクリックして管理アプリを開き、**「デスクトップにショートカット作成」** をクリックします（公式アイコン付きの **`Antigravity (日本語)`** がデスクトップに作成されます）。
2. Antigravity を一度完全終了（タスクトレイのアイコンを右クリック → **Quit**）してから、デスクトップの **`Antigravity (日本語)`**（または [`Antigravity-Launch.bat`](./Antigravity-Launch.bat)）を起動します。
   - 未適用／アプデ直後のときは **「日本語化中...」** が数秒表示されて自動適用され、そのまま日本語版 Antigravity が起動します。

### 便利なショートカット & トレイ操作

- **`Ctrl + Alt + J`**: Antigravity 画面上で日本語UIの ON / OFF を即時切り替え
- **`Ctrl + Alt + Shift + J`**: 画面全体の未翻訳UIテキスト収集 ON / OFF（`ⓘ` ツールチップは既定で自動収集されます）
- **タスクトレイ右クリック →「日本語UI」**: 日本語表示・未翻訳収集・日本語フォント最適化の切り替えや、辞書フォルダを開く／辞書の再読み込みができます

### 英語の表現を見つけたとき・自分好みに直したいとき

[`Antigravity-JA.bat`](./Antigravity-JA.bat) の **「未翻訳UI」** または **「翻訳辞書」** タブから直接編集できます。**保存した瞬間に起動中の Antigravity へ即反映**されます。

- **AI一括翻訳**: 「未翻訳UI」タブの **「AI一括翻訳用プロンプトをコピー」** を押すと用語集付きの翻訳プロンプトが作られます。AI に生成させた JSON を **「インポート / エクスポート」** タブへ貼り付けるだけで一括反映できます。
- **辞書だけ最新化したいとき（再起動不要）**: アプリ上の **「最新辞書を同期（再起動不要）」** を押すか `node src/cli.js sync` を実行すると、あなたの `custom.json` を保ったまま基本辞書だけが更新されます。

---

## CLI コマンド一覧

```bash
node src/cli.js app                  # 統合デスクトップアプリ（管理・辞書エディタ）を起動
node src/cli.js launch [--gui]       # 日本語化をチェック・自動適用して Antigravity を起動
node src/cli.js create-shortcut      # デスクトップに「Antigravity (日本語)」ショートカット作成
node src/cli.js status               # 適用状態・バックアップ・辞書件数を確認
node src/cli.js apply                # パッチ適用
node src/cli.js restore              # バックアップから完全復元
node src/cli.js sync                 # 最新の基本辞書をユーザーフォルダへ同期
node src/cli.js auto-translate       # 未翻訳の安全な英語UIを自動翻訳して auto.json に保存
node src/cli.js validate             # 辞書・用語集の構文検証
node src/cli.js export-untranslated  # AI一括翻訳用プロンプトを出力
node src/cli.js import <file.json>   # 翻訳JSONをカスタム辞書へマージ
npm test                             # 全テストスイートを実行
```

---

## プロジェクト構成

```text
antigravity-ja/
├── Antigravity-JA.bat             # 統合デスクトップアプリ（管理・辞書エディタ）を起動
├── Antigravity-Launch.bat         # 未適用／アプデ後なら「日本語化中...」で自動適用して起動
├── package.json
├── bin/
│   ├── app-silent.vbs             # 黒い画面なしで統合アプリを起動するラッパー
│   └── launch-silent.vbs          # 黒い画面なしで自動日本語化起動を行うラッパー
├── dictionaries/
│   ├── ja-base.json               # 基本UI辞書（1,935件）＋ 動的パターン（191件）
│   └── glossary.json              # 翻訳用語集・トーンガイドライン
├── src/
│   ├── appServer.js               # 統合管理アプリ & 辞書エディタのローカルサーバー (127.0.0.1)
│   ├── launcher.js                # 自動パッチ判定・「日本語化中...」スプラッシュ・ショートカット作成
│   ├── asar.js                    # ASAR 読み取り・Chromium Pickle/SHA-256 パッチャー
│   ├── cli.js                     # CLI エントリーポイント
│   ├── dictionary.js              # 辞書読み込み・検証・マージ・AIプロンプト生成
│   ├── patcher.js                 # パッチ適用／バックアップ検証／復元ロジック
│   ├── paths.js                   # インストール先・ユーザー辞書パス解決
│   └── runtime/
│       ├── autoTranslator.js      # アプデ新UI自動発見・安全フィルタ・4種翻訳エンジン連携
│       ├── jaI18nMain.js          # Electron メインプロセス連携（IPC/トレイ/WebContentsView監視）
│       ├── preloadBuilder.js      # サンドボックス対応 Preload スクリプト生成
│       └── translatorCore.js      # 翻訳・除外判定コアロジック
└── test/                          # Node 標準テストランナー用テスト一式
```

---

## 注意事項・免責

- 本ツールは **非公式のローカライズツールキット** であり、Google LLC / Antigravity 公式のものではありません。自己責任でご利用ください。
- 初回適用時に元の `app.asar` のバックアップ（`app.asar.ja-backup` および `app.asar.ja-meta.json`）を作成し、復元機能で SHA-256 を検証して元のバイナリへ完全復元できます。
- 一部のサーバー配信テキスト（モデル選択の `ⓘ` 説明文、Marketplace プラグインの説明文、お知らせバナー等）はアプリ側の静的バンドルに含まれないため未翻訳になる場合がありますが、ツールチップ自動収集機能によりホバーした文言を自動で記録し、管理アプリから簡単に日本語化できます。

## ライセンス

[MIT License](./LICENSE)
