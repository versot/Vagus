<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Vagus 標誌" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>常用的程式開發 Agent，共用一個桌面工作區</strong><br />
  把專案、對話、執行過程與程式碼變更放在一起。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> · 繁體中文 ·
  <a href="README.es.md">Español</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.pt-BR.md">Português (Brasil)</a> ·
  <a href="README.fr.md">Français</a> ·
  <a href="README.de.md">Deutsch</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="README.vi.md">Tiếng Việt</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20建置-Windows%20%7C%20macOS-4477ee" alt="Beta 建置目標：Windows 和 macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/授權條款-Apache--2.0-3da683" alt="授權條款：Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/階段-Beta%20測試-e9a23b" alt="Beta 測試階段" />
</p>

<p align="center">
  <a href="#從原始碼執行">從原始碼執行</a> ·
  <a href="#功能特色">功能特色</a> ·
  <a href="CONTRIBUTING.md">參與貢獻</a>
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes.png" alt="在 Vagus 中檢視 Agent 的對話與檔案差異" width="1000" />
</p>

<p align="center"><sub>對話與該回合的檔案變更並排呈現。</sub></p>

## 為程式開發 Agent 設計的桌面工作區

Vagus 將專案與 Agent 對話集中在同一個桌面工作區。你可以選擇 Agent、即時追蹤工作、在對話旁檢視檔案變更，並隨時回到先前的工作。Agent CLI、帳號與模型仍由你在本機設定。

## 功能特色

- **依任務選擇 Agent。** 在同一個專案中使用 Pi、Claude Code、Codex、OpenCode、Qoder CLI 或 ZCode，並選擇各整合提供的模型與工作模式。
- **看見答案如何完成。** 對話中呈現即時回覆、工具活動與執行狀態。
- **在對話脈絡中檢視變更。** 依回合彙整修改的檔案，並在對話旁開啟完整 diff。
- **常用工具就在旁邊。** 在桌面工作區開啟檔案、終端機、瀏覽器和變更檢視分頁。
- **隨時找回先前的工作。** 搜尋歷史對話，並匯入支援此功能的 Agent 原生紀錄。
- **讓重複工作定時執行。** 建立本機排程任務，為每項任務選擇可用的 Agent、模型與模式。

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-detail.svg" alt="在 Vagus 建立新對話時選擇 Agent" width="1000" />
</p>

<p align="center"><sub>建立對話時選擇適合任務的 Agent。</sub></p>

### 已整合的 Agent

| Agent       | 接入方式         | 說明                                                                |
| ----------- | ---------------- | ------------------------------------------------------------------- |
| Pi          | Pi RPC           | 保留 Pi 擴充功能互動及原生對話匯入能力。                            |
| Claude Code | ACP bridge       | CLI、登入及使用者設定由本機 Claude Code 管理。                      |
| Codex       | Codex app-server | 使用本機 Codex CLI；app-server 仍屬實驗性介面。                     |
| OpenCode    | ACP              | 使用本機 OpenCode CLI 公開的工作階段能力。                          |
| Qoder CLI   | ACP              | 使用本機 Qoder CLI 公開的能力。                                     |
| ZCode       | ACP bridge       | 透過社群維護的 `zcode-acp-server` 連線；這不是 Z.ai 官方 ACP 整合。 |

各 Agent 的安裝、帳號及模型設定由其官方工具管理。 Vagus 不會代替使用者登入，也不保證 Agent 未透過接入協定公開的功能。

## 平台狀態

Vagus 已進入公開 Beta 測試階段，首個版本提供 Windows x64、macOS Intel 及 Apple 晶片安裝程式。目前未設定平台程式碼簽署或 macOS 公證，macOS 套件也尚未完成發行級驗證。暫不支援 Linux。

## Beta 版本與下載

首個公開測試版本可從 [Vagus v0.1.0-beta.1](https://github.com/versot/Vagus/releases/tag/v0.1.0-beta.1) 下載。每個 GitHub Pre-release 頁面都會列出安裝程式、版本說明及已知問題。測試前請先備份重要資料，回報問題時請註明 Vagus 版本及作業系統。

桌面應用程式會使用本機 Node.js 執行 Vagus Host，需要 Node.js 22.13 或更新版本。使用者需自行安裝、登入並設定所需的 Agent CLI。安裝程式不包含 Node.js 或 Agent CLI。

每個版本的使用者可見變更會分別記錄於 [`releases/`](releases/)，同一份 Markdown 說明也會作為 GitHub Release 的內文。

### 環境需求

- 64 位元 Windows
- Node.js 22.13 或更新版本及 npm
- Rust stable 工具鏈、MSVC C++ 建置工具和 Windows SDK
- Microsoft Edge WebView2 Runtime

### 從原始碼執行

在儲存庫根目錄啟動開發版本：

```powershell
npm ci
npm run dev
```

建置桌面安裝程式：

```powershell
npm run build:desktop
```

### 驗證變更

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

自動品質檢查目前在 Windows CI 執行。

## 參與貢獻

歡迎回報問題及提出改進建議。開始前請閱讀[貢獻指南](CONTRIBUTING.md)，並使用 [Issue 範本](.github/ISSUE_TEMPLATE/) 或 [Pull Request 範本](.github/PULL_REQUEST_TEMPLATE.md)。提交圖片、圖示、字型、程式碼或文件前，請確認具備再散布權，並註明來源與授權條款。

## 授權條款

Vagus 自有程式碼採用 [Apache License 2.0](LICENSE) 授權。依賴項目及素材遵循各自上游的授權條款。Agent 品牌標誌歸各自權利人所有，不受 Vagus 授權條款涵蓋。
