# `@vagus/desktop`

The Tauri desktop shell for Vagus, built from a React frontend and a Rust operating-system layer.

This package owns the native application lifecycle and desktop integration. Rust starts and supervises the local Vagus Host, manages windows and operating-system features, and exposes narrowly scoped commands to the frontend. The React UI itself lives in `@vagus/app`.

## Responsibilities

- Assemble the Tauri application and register native commands.
- Start, authenticate, supervise, recover, and shut down the local Host process.
- Manage desktop settings, windows, tray behavior, notifications, power, and file access.
- Provide isolated browser and terminal surfaces with explicit permission boundaries.
- Bundle the frontend and standalone Host resources into platform installers.

The desktop package does not implement Agent adapters or own the shared UI. The Host remains a separate Node.js process. Installers do not include Node.js or Agent CLIs; users install the required runtime and Agent tools locally.

## Source layout

- `src-tauri/src/lib.rs` — application setup and native command registration.
- `src-tauri/src/host_runtime.rs`, `host_supervisor.rs` — Host launch and lifecycle supervision.
- `src-tauri/src/settings.rs`, `windows.rs`, `tray.rs` — settings, windows, and tray integration.
- `src-tauri/tauri.macos.conf.json`, `tauri.windows.conf.json` — platform-specific native window configuration.
- `src-tauri/src/browser.rs`, `filesystem.rs`, `terminal.rs` — isolated browser, constrained file access, and PTY operations.
- `src-tauri/tauri.conf.json` — frontend build hooks, bundled Host resources, icons, and installer configuration.

## Requirements

- Node.js 22.13 or later and npm. On macOS, the app also searches the interactive login shell for Node.js when resolving it for a GUI launch.
- On Apple silicon, if an Intel Vagus build is running under Rosetta and the npm Codex CLI has its matching ARM64 package installed, the Host uses that native Codex binary directly.
- Rust stable and the platform-specific native build tools.
- On Windows, MSVC C++ build tools, Windows SDK, and Microsoft Edge WebView2 Runtime.
- Agent CLIs and their account configuration, installed separately by the user. The Host searches its inherited PATH, the macOS login-shell PATH, common user install locations, and an available platform executable index when resolving agent commands.

A configured build target is not, by itself, a claim of verified platform compatibility.

The macOS desktop window overlays its native traffic-light controls on the app toolbar. Windows keeps the custom title bar and window buttons.

## Development and packaging

Run from the repository root:

```sh
npm ci
npm run dev
```

The root development command builds the Host, client, app, and standalone Host resources before starting Tauri. Build the local Windows installer with:

```sh
npm run build:desktop
```

This package is private to the Vagus monorepo and is not currently published to npm.
