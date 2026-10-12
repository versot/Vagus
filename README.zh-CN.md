<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Vagus 标志" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>常用编程 Agent，共用一个桌面工作区</strong><br />
  把项目、会话、执行过程和代码改动放在一起。
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> ·
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
  <img src="https://img.shields.io/badge/Beta%20构建-Windows%20%7C%20macOS-4477ee" alt="Beta 构建目标：Windows 和 macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/许可证-Apache--2.0-3da683" alt="许可证：Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/阶段-Beta%20测试-e9a23b" alt="Beta 测试阶段" />
</p>

<p align="center">
  <a href="#启动开发版">启动开发版</a> ·
  <a href="#功能特色">功能特色</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a>
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes-showcase.png" alt="在 Vagus 中查看 Agent 的对话和文件差异" width="1000" />
</p>

<p align="center"><sub>对话和本轮文件改动并排呈现。</sub></p>

## 面向编程 Agent 的桌面工作区

Vagus 把项目和 Agent 会话集中在一个桌面工作区。你可以选择 Agent、实时跟进执行、在会话旁审查文件改动，并随时回到之前的工作。Agent CLI、账号和模型仍由你在本机配置。

## 功能特色

- **按任务选择 Agent。** 在同一个项目中使用 Pi、Claude Code、Codex、OpenCode、Qoder CLI 或 ZCode，并选择各接入方式提供的模型和工作模式。
- **看见答案产生的过程。** 对话中呈现流式回复、工具活动与执行状态。
- **在上下文中审查改动。** 按轮次汇总修改文件，在会话旁打开完整 diff。
- **常用工具就在旁边。** 在桌面工作区中打开文件、终端、浏览器和改动审查标签页。
- **随时找回之前的工作。** 搜索历史会话，并导入支持此功能的 Agent 原生会话。
- **让重复任务按时运行。** 创建本地定时任务，为每项任务选择可用的 Agent、模型和模式。

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-showcase.png" alt="在 Vagus 新建会话时选择 Agent" width="1000" />
</p>

<p align="center"><sub>新建会话时选择适合当前任务的 Agent。</sub></p>

### 已接入的 Agent

| Agent | 接入方式 | 说明 |
| --- | --- | --- |
| Pi | Pi RPC | 保留 Pi 扩展交互及原生会话导入能力。 |
| Claude Code | ACP bridge | CLI、登录和用户配置由本机 Claude Code 管理。 |
| Codex | Codex app-server | 使用本机 Codex CLI；app-server 仍属实验性接口。 |
| OpenCode | ACP | 使用本机 OpenCode CLI 公布的会话能力。 |
| Qoder CLI | ACP | 使用本机 Qoder CLI 公布的会话能力。 |
| ZCode | ACP bridge | 通过社区维护的 `zcode-acp-server` 连接；不是 Z.ai 官方 ACP 接入。 |

Agent 的安装、账号和模型配置由各自的官方工具管理。 Vagus 不代替这些工具登录，也不保证 Agent 未通过接入协议公开的功能。

## 当前平台

Vagus 处于 Beta 测试阶段，尚未发布首个安装包。 发布工作流已配置为构建 Windows x64 和 macOS Intel/Apple 芯片安装包；目前不配置平台代码签名或 macOS 公证，macOS 包也未经发行级验证。 Linux 暂不支持。

## Beta 版本与下载

每个公开测试版本会以 GitHub Pre-release 发布，版本号采用 `0.1.0-beta.N`，例如 `0.1.0-beta.1`。各平台安装包、变更说明和已知问题会放在该版本的 Release 页面。Beta 期间请先备份重要数据，并在提交问题时注明版本号和操作系统。

桌面应用会调用本机 Node.js 运行 Vagus Host；需要 Node.js 22.13 或更新版本，并由用户自行安装、登录和配置所需的 Agent CLI。安装包不包含 Node.js 或这些 Agent。

每个版本的用户可见变化分别记录在 [`releases/`](releases/)，同一份 Markdown 说明会自动用于 GitHub Release 正文。

### 环境要求

- Windows x64
- Node.js 22.13 或更新版本及 npm
- Rust stable 工具链、MSVC C++ 构建工具和 Windows SDK
- Microsoft Edge WebView2 Runtime

### 启动开发版

在仓库根目录运行：

```powershell
npm ci
npm run dev
```

构建桌面安装包：

```powershell
npm run build:desktop
```

### 验证改动

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

自动质量检查目前运行在 Windows CI。

## 参与贡献

欢迎提交问题反馈和改进建议。开始前请阅读[贡献指南](CONTRIBUTING.md)，并使用仓库中的 [Issue 模板](.github/ISSUE_TEMPLATE/) 或 [Pull Request 模板](.github/PULL_REQUEST_TEMPLATE.md)。提交图片、图标、字体、代码或文档时，请确认拥有再分发权并注明来源与许可。

## 许可

Vagus 自有代码以 [Apache License 2.0](LICENSE) 授权。依赖和素材遵循各自上游许可。Agent 品牌标识归各自权利人所有，不由 Vagus 许可证授权。
