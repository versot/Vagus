<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Vagus ロゴ" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>いつもの Agent を、ひとつのデスクトップワークスペースに</strong><br />
  プロジェクト、会話、作業の経過、コードの変更をまとめて確認。
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · 日本語 · <a href="README.ko.md">한국어</a> · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a> · <a href="README.vi.md">Tiếng Việt</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Beta ビルド対象: Windows と macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="ライセンス: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="ベータテスト" />
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes-showcase.png" alt="Vagus で Agent の変更と差分を確認" width="1000" />
</p>

<p align="center"><sub>会話とファイルの変更を並べて表示。</sub></p>

## コーディング Agent のためのワークスペース

Vagus はプロジェクトと Agent との会話をひとつのデスクトップワークスペースにまとめます。Agent を選び、作業をリアルタイムで追い、会話の横でファイルの変更を確認し、以前のセッションにも戻れます。Agent の CLI、アカウント、モデルは引き続きローカルで設定します。

## 主な機能

- **タスクに合う Agent を選択。** 同じプロジェクトで Pi、Claude Code、Codex、OpenCode、Qoder CLI、ZCode を利用し、各連携が提供するモデルや動作モードを選べます。
- **回答までの過程を確認。** ストリーミング応答、ツールの動作、実行状態を会話内で追えます。
- **変更を会話の文脈で確認。** ターンごとの変更ファイルを把握し、会話の横で差分全体を開けます。
- **必要なツールを手元に。** ファイル、ターミナル、ブラウザー、レビューのタブをワークスペース内で開けます。
- **過去の作業に戻る。** 会話を検索し、対応する Agent のネイティブ履歴をインポートできます。
- **繰り返す作業を予約。** ローカルの定期タスクを作成し、利用可能な Agent、モデル、モードを選べます。

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-showcase.png" alt="Vagus で新しい会話の Agent を選択" width="1000" />
</p>

<p align="center"><sub>新しい会話を始めるときに Agent を選択。</sub></p>

### 対応エージェント

| エージェント | 連携方式 | 備考 |
| --- | --- | --- |
| Pi | Pi RPC | Pi 拡張機能との連携とネイティブ会話のインポートに対応します。 |
| Claude Code | ACP bridge | CLI、ログイン、ユーザー設定はローカルの Claude Code が管理します。 |
| Codex | Codex app-server | ローカルの Codex CLI を使用します。app-server は実験的なインターフェースです。 |
| OpenCode | ACP | ローカルの OpenCode CLI が公開するセッション機能を使用します。 |
| Qoder CLI | ACP | ローカルの Qoder CLI が公開する機能を使用します。 |
| ZCode | ACP bridge | コミュニティ運営の `zcode-acp-server` を使用します。Z.ai 公式の ACP 連携ではありません。 |

各エージェントのインストール、アカウント、モデル設定は公式ツールで行います。 Vagus はユーザーに代わってログインせず、連携プロトコルで公開されていない機能を保証しません。

## プラットフォーム

Vagus は公開ベータ版です。最初のリリースでは Windows x64、macOS Intel、Apple silicon 向けのインストーラーを提供しています。コード署名と macOS 公証は設定されておらず、macOS パッケージはリリース品質の検証を完了していません。Linux は現在サポート対象外です。ビルド対象は互換性検証済みであることを意味しません。

## ベータ版とダウンロード

最初の公開テスト版は [Vagus v0.1.0-beta.1](https://github.com/versot/Vagus/releases/tag/v0.1.0-beta.1) からダウンロードできます。各 GitHub Pre-release ページにインストーラー、変更内容、既知の問題を掲載します。テスト前に重要なデータをバックアップし、問題を報告する際は Vagus のバージョンと OS を記載してください。

デスクトップアプリはローカルの Node.js で Vagus Host を実行します。Node.js 22.13 以降が必要です。必要なエージェント CLI は各自でインストール、ログイン、設定してください。インストーラーに Node.js やエージェント CLI は含まれません。

各バージョンのユーザー向け変更内容は [`releases/`](releases/) に個別の Markdown ファイルとして保存され、GitHub Release の本文にも使用されます。

### 必要な環境

- 64 ビット Windows
- Node.js 22.13 以降と npm
- Rust stable、MSVC C++ Build Tools、Windows SDK
- Microsoft Edge WebView2 Runtime

リポジトリのルートで開発版を起動します。

```powershell
npm ci
npm run dev
```

デスクトップインストーラーをビルドします。

```powershell
npm run build:desktop
```

### 変更の確認

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

自動品質チェックは現在 Windows CI で実行されます。 CI が成功しても、すべてのエージェントのバージョン、PC 構成、プラットフォームで E2E 検証が完了したことにはなりません。

## コントリビューション

不具合報告や改善提案を歓迎します。まず[コントリビューションガイド](CONTRIBUTING.md)を読み、[Issue テンプレート](.github/ISSUE_TEMPLATE/)または[Pull Request テンプレート](.github/PULL_REQUEST_TEMPLATE.md)を使用してください。画像、アイコン、フォント、コード、ドキュメントを提出する前に、再配布権を確認し、出典とライセンスを記載してください。

## ライセンス

Vagus 独自のコードは[Apache License 2.0](LICENSE)で公開されています。依存関係とアセットには、それぞれの上流プロジェクトのライセンスが適用されます。Agent のブランドロゴは各権利者に帰属し、Vagus のライセンスには含まれません。
