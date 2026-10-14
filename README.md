<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Vagus logo" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>One desktop workspace for the agents you already use</strong><br />
  Keep projects, conversations, agent activity, and code changes together.
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
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Beta build targets: Windows and macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="License: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="Beta testing" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes.png" alt="Reviewing agent changes and diffs in Vagus" width="1000" />
</p>

<p align="center"><sub>A conversation and its file changes, side by side.</sub></p>

## Built for working with coding agents

Vagus gives your projects and agent conversations a shared desktop home. Choose an agent, follow its work as it happens, inspect file changes beside the conversation, and return to earlier sessions when you need them. Your agent CLIs, accounts, and models remain configured on your machine.

## Features

- **Choose the agent that fits the task.** Start conversations with Pi, Claude Code, Codex, OpenCode, Qoder CLI, or ZCode in the same project workspace. Select the models and working modes each integration exposes.
- **See how the answer was made.** Follow streaming replies, tool activity, and execution state in the conversation.
- **Review edits in context.** See which files changed in each turn, then open the complete diff beside the conversation.
- **Keep the tools you need nearby.** Open file, terminal, browser, and review tabs in the desktop workspace.
- **Find your way back.** Search past conversations and import native history from agents that support it.
- **Put repeat work on a schedule.** Create local scheduled tasks and choose the available agent, model, and mode for each one.

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-detail.svg" alt="Selecting an agent for a new conversation in Vagus" width="1000" />
</p>

<p align="center"><sub>Choose an agent when starting a conversation.</sub></p>

### Integrated agents

| Agent       | Integration      | Notes                                                                                                       |
| ----------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Pi          | Pi RPC           | Preserves Pi extension interactions and native conversation import.                                         |
| Claude Code | ACP bridge       | The local Claude Code CLI manages installation, sign-in, and user configuration.                            |
| Codex       | Codex app-server | Uses the local Codex CLI; app-server is still an experimental interface.                                    |
| OpenCode    | ACP              | Uses session capabilities exposed by the local OpenCode CLI.                                                |
| Qoder CLI   | ACP              | Uses capabilities exposed by the local Qoder CLI.                                                           |
| ZCode       | ACP bridge       | Connects through the community-maintained `zcode-acp-server`; this is not an official Z.ai ACP integration. |

Each agent's official tools manage its installation, account, and model configuration. Vagus does not sign in on your behalf or guarantee features that an agent does not expose through its integration protocol.

## Quick Start

1. On 64-bit Windows, install Node.js 22.13 or later, npm, Rust stable, the MSVC C++ build tools, the Windows SDK, and Microsoft Edge WebView2 Runtime. Install and configure at least one supported agent CLI separately: Pi, Claude Code, Codex, OpenCode, Qoder CLI, or ZCode.
2. From the repository root, install dependencies and launch the desktop app:

   ```powershell
   npm ci
   npm run dev
   ```

3. In Vagus, add a project folder, start a new chat, choose an available agent, enter your request, and send it. You can also start a chat without a project.

## Platform status

Vagus is in public Beta. The first release provides installers for Windows x64, macOS Intel, and macOS Apple silicon. Platform code signing and macOS notarization are not configured, and the macOS packages have not passed release-level validation. Linux is not currently supported.

## Beta releases and downloads

Download the first public test build from [Vagus v0.1.0-beta.1](https://github.com/versot/Vagus/releases/tag/v0.1.0-beta.1). Each GitHub pre-release lists its installers, release notes, and known issues. Back up important data before testing, and include your Vagus version and operating system when reporting a problem.

The desktop app uses the local Node.js runtime to run Vagus Host. Node.js 22.13 or later is required. On macOS, Vagus also checks the user's interactive login shell so it can find Node.js when launched from Finder or the Dock. Users install, sign in to, and configure the agent CLIs they need; installers do not bundle Node.js or agent CLIs.

Each version has its own user-facing release note under [`releases/`](releases/). The same Markdown file is used as the GitHub Release description.

### Requirements

- 64-bit Windows
- Node.js 22.13 or later and npm
- Rust stable toolchain, MSVC C++ build tools, and the Windows SDK
- Microsoft Edge WebView2 Runtime

### Build a desktop installer

```powershell
npm run build:desktop
```

### Verify changes

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

Automated quality checks currently run on Windows CI. A passing CI run does not mean that every agent version, machine configuration, or platform has passed end-to-end validation.

## Contributing

Bug reports and improvements are welcome. See the [Code of Conduct](CODE_OF_CONDUCT.md) for community expectations. Report security issues privately as described in [SECURITY.md](SECURITY.md). Before submitting images, icons, fonts, code, or documentation, confirm that they may be redistributed and document their source and license.

## License

Vagus's original code is licensed under the [Apache License 2.0](LICENSE). Dependencies and assets retain their respective upstream licenses. Agent brand marks remain the property of their respective owners and are not licensed by Vagus.
