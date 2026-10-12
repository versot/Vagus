<p align="center">
  <img src="packages/desktop/src-tauri/icons/vagus-logo.png" alt="Vagus 로고" width="88" />
</p>

<h1 align="center">Vagus</h1>

<p align="center">
  <strong>늘 쓰던 Agent를 하나의 데스크톱 작업 공간에서</strong><br />
  프로젝트, 대화, Agent 활동, 코드 변경 사항을 한곳에 모으세요.
</p>

<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <a href="README.es.md">Español</a> · <a href="README.ja.md">日本語</a> · 한국어 · <a href="README.pt-BR.md">Português (Brasil)</a> · <a href="README.fr.md">Français</a> · <a href="README.de.md">Deutsch</a> · <a href="README.ru.md">Русский</a> · <a href="README.vi.md">Tiếng Việt</a></p>

<p align="center">
  <img src="https://img.shields.io/badge/Beta%20build-Windows%20%7C%20macOS-4477ee" alt="Beta 빌드 대상: Windows 및 macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache--2.0-3da683" alt="라이선스: Apache-2.0" /></a>
  <img src="https://img.shields.io/badge/Stage-Beta%20testing-e9a23b" alt="베타 테스트" />
</p>

<p align="center">
  <img src="assets/screenshots/vagus-turn-changes-showcase.png" alt="Vagus에서 에이전트 변경 사항과 diff 검토" width="1000" />
</p>

<p align="center"><sub>대화와 파일 변경 사항을 나란히 확인하세요.</sub></p>

## 코딩 Agent를 위한 작업 공간

Vagus는 프로젝트와 Agent 대화를 하나의 데스크톱 작업 공간에 모읍니다. Agent를 선택하고 작업 과정을 실시간으로 확인하며 대화 옆에서 파일 변경 사항을 검토하고 이전 세션으로 돌아갈 수 있습니다. Agent CLI, 계정, 모델은 계속 로컬 컴퓨터에서 설정합니다.

## 기능

- **작업에 맞는 Agent 선택.** 같은 프로젝트에서 Pi, Claude Code, Codex, OpenCode, Qoder CLI, ZCode를 사용하고 각 연동에서 제공하는 모델과 작업 모드를 선택합니다.
- **답변이 만들어지는 과정 확인.** 실시간 응답, 도구 활동, 실행 상태를 대화에서 확인합니다.
- **맥락 속에서 변경 사항 검토.** 턴마다 수정된 파일을 보고 대화 옆에서 전체 diff를 엽니다.
- **필요한 도구를 가까이에.** 파일, 터미널, 브라우저, 리뷰 탭을 데스크톱 작업 공간에서 엽니다.
- **이전 작업으로 돌아가기.** 대화를 검색하고 지원되는 Agent의 기본 기록을 가져옵니다.
- **반복 작업 예약.** 로컬 예약 작업을 만들고 각 작업에 사용 가능한 Agent, 모델, 모드를 선택합니다.

<p align="center">
  <img src="assets/screenshots/vagus-agent-picker-showcase.png" alt="Vagus에서 새 대화에 사용할 에이전트 선택" width="1000" />
</p>

<p align="center"><sub>새 대화를 시작할 때 Agent를 선택하세요.</sub></p>

### 통합된 Agent

| Agent | 통합 방식 | 설명 |
| --- | --- | --- |
| Pi | Pi RPC | Pi 확장 기능과 네이티브 대화 가져오기를 지원합니다. |
| Claude Code | ACP bridge | 로컬 Claude Code CLI가 설치, 로그인, 사용자 설정을 관리합니다. |
| Codex | Codex app-server | 로컬 Codex CLI를 사용하며 app-server는 실험적 인터페이스입니다. |
| OpenCode | ACP | 로컬 OpenCode CLI가 제공하는 세션 기능을 사용합니다. |
| Qoder CLI | ACP | 로컬 Qoder CLI가 제공하는 기능을 사용합니다. |
| ZCode | ACP bridge | 커뮤니티가 관리하는 `zcode-acp-server`를 사용하며 Z.ai 공식 ACP 통합은 아닙니다. |

각 Agent의 공식 도구가 설치, 계정, 모델 설정을 관리합니다.

## 플랫폼 현황

Vagus는 공개 베타 단계입니다. 첫 릴리스에서는 Windows x64, macOS Intel 및 Apple silicon용 설치 프로그램을 제공합니다. 코드 서명과 macOS 공증은 설정되어 있지 않고 macOS 패키지는 릴리스 수준 검증을 마치지 않았습니다.

## 베타 릴리스 및 다운로드

첫 공개 테스트 버전은 [Vagus v0.1.0-beta.1](https://github.com/versot/Vagus/releases/tag/v0.1.0-beta.1)에서 다운로드할 수 있습니다. 각 GitHub Pre-release 페이지에서 설치 프로그램, 변경 사항, 알려진 문제를 확인할 수 있습니다. 테스트 전 중요한 데이터를 백업하고 문제를 제보할 때 Vagus 버전과 운영체제를 적어 주세요.

데스크톱 앱은 로컬 Node.js로 Vagus Host를 실행하며 Node.js 22.13 이상이 필요합니다. 필요한 Agent CLI는 사용자가 직접 설치하고 로그인 및 설정해야 합니다. 설치 프로그램에는 Node.js나 Agent CLI가 포함되지 않습니다.

각 버전의 사용자용 변경 내역은 [`releases/`](releases/)에 별도 Markdown 파일로 기록되며 GitHub Release 본문에도 사용됩니다.

### 요구 사항

- 64비트 Windows
- Node.js 22.13 이상 및 npm
- Rust stable, MSVC C++ 빌드 도구, Windows SDK
- Microsoft Edge WebView2 Runtime

저장소 루트에서 개발 앱을 실행합니다.

```powershell
npm ci
npm run dev
```

데스크톱 설치 프로그램을 빌드합니다.

```powershell
npm run build:desktop
```

### 변경 사항 검증

```powershell
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
```

자동 품질 검사는 현재 Windows CI에서 실행됩니다. CI 통과가 모든 Agent 버전, 컴퓨터 설정, 플랫폼의 엔드투엔드 검증을 의미하지는 않습니다.

## 기여

버그 보고와 개선 제안을 환영합니다. [기여 가이드](CONTRIBUTING.md)를 읽고 [Issue 템플릿](.github/ISSUE_TEMPLATE/) 또는 [Pull Request 템플릿](.github/PULL_REQUEST_TEMPLATE.md)을 사용해 주세요. 이미지, 아이콘, 글꼴, 코드, 문서를 제출하기 전에 재배포 권한을 확인하고 출처와 라이선스를 적어 주세요.

## 라이선스

Vagus 자체 코드는 [Apache License 2.0](LICENSE)에 따라 제공됩니다. 종속성과 에셋에는 각 upstream 프로젝트의 라이선스가 적용됩니다. Agent 브랜드 표시는 각 권리자의 소유이며 Vagus 라이선스에 포함되지 않습니다.
