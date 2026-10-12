# Vagus development guide

Vagus is a desktop workspace for local Agent sessions. It integrates Pi, Claude Code, Codex, OpenCode, Qoder CLI, and ZCode. Keep Agent-specific behavior inside Provider adapters and expose shared behavior through the canonical protocol. Windows x64 is the primary desktop target; other platform claims must match the package configuration and CI.

## Repository map

- [App](packages/app/README.md) — conversation UI and workspace features
- [Desktop](packages/desktop/README.md) — Tauri shell and operating-system integration
- [Host](packages/host/README.md) — local Agent sessions, persistence, and Provider adapters
- [Client](packages/client/README.md) — typed Host connection and RPC requests
- [Protocol](packages/protocol/README.md) — shared commands, events, and data types
- [Agent core](packages/agent-core/README.md) — Provider and session contracts
- [README](README.md) — product scope, setup, supported integrations, and release information

## Working conventions

- Keep one clear owner for each responsibility. Put feature UI and state in its package module; keep native Agent protocols inside their adapters.
- Treat a capability as supported only when the adapter, protocol path, and user-facing behavior work together.
- Inspect the owning package README and source before changing a boundary. Keep setup and user-facing product statements in the root README.
- Check redistribution rights before adding third-party code or assets; retain any license notices required for redistribution.
- Keep changes focused, update affected tests, and report what was actually verified.

## Common commands

`npm ci` installs the workspace. Use `npm run dev` to build and launch the desktop app, `npm run build:app` for the UI, `npm run build:host` for the Host, and `npm run build:desktop` for a Windows installer. Run `npm run style:check`, `npm run test:stage-one`, and the relevant package build for changes. Native lifecycle changes should also run `npm run test:stage-one:native` on Windows.
