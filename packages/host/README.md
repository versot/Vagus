# `@vagus/host`

The Node.js service that manages Vagus projects, sessions, providers, and local workspace operations.

The Host is a separate process from the desktop UI. In the current desktop product, Tauri starts and supervises it locally; the UI communicates with it through the authenticated protocol and typed client.

## Responsibilities

- Own RPC transport, authentication, request routing, and Host lifecycle.
- Manage projects, Agent sessions, provider configuration, model catalogs, and session history.
- Persist workspace data in SQLite and run local scheduled tasks.
- Adapt Agent-specific protocols and events to Vagus's provider-neutral contracts.
- Provide workspace services such as Git review without treating them as Agent capabilities.

## Source layout

- `src/server.ts` — process entry point, service initialization, listen, and shutdown.
- `src/runtime/` — Host state and service composition.
- `src/transport/` — WebSocket transport, authentication, and event delivery.
- `src/sessions/`, `src/storage/`, `src/projects/`, `src/scheduling/`, `src/workspace/` — domain services.
- `src/agent/` — provider registry, model/configuration services, and provider adapters.
- `src/agent/providers/<id>/` — transport and conversion details owned by one Agent.
- `scripts/bundle-desktop.mjs` — prepares the standalone Host resources embedded by the desktop build.

## Runtime requirements

- Node.js 22.13 or later; Node.js 24 is recommended.
- Agent CLIs and credentials are installed and configured by the user.
- Provider executable discovery checks the Host's inherited `PATH`, the macOS login-shell `PATH`, common per-user install locations, and the platform's available executable index. Provider-specific `VAGUS_*_EXECUTABLE` variables can select a nonstandard CLI path; the Settings catalog shows the resolved path after a successful refresh.
- The desktop-managed Host requires an authentication token and binds to loopback. Do not add an unauthenticated mode.

## Development

Run commands from the repository root:

```sh
npm ci
npm run build:host
npm run check --workspace=@vagus/host
```

The production desktop build also bundles the Host and its runtime dependencies:

```sh
npm run bundle:desktop --workspace=@vagus/host
```

Use `npm run dev` to start the complete desktop development workflow. It builds the contract and client packages, prepares the standalone Host bundle, then launches Tauri and the app.

## Provider development

Add Agent integrations under `src/agent/providers/<id>/`. Keep native process management, protocol conversion, settings, and history handling inside the adapter. Declare only capabilities that are implemented end to end in the adapter, protocol, and UI.

This package is private to the Vagus monorepo and is not currently published to npm.
