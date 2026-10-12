# `@vagus/app`

The React and Vite user interface for Vagus conversations and workspace features.

The app renders the conversation workspace, session and project navigation, settings, scheduled tasks, provider controls, and registered workspace tabs. It communicates with the Host through `@vagus/client`; desktop operating-system features are provided by the Tauri shell and must be accessed through the app's established desktop integration boundaries.

## Responsibilities

- Render conversations, Agent activity, session history, projects, and settings.
- Coordinate feature-specific state and conversions without putting provider protocol logic in shared UI components.
- Register workspace tabs such as browser, file, review, and terminal views through the tab system.
- Provide localized UI strings through the locale resources.
- Preserve the desktop application's product and security boundaries.

The app does not implement Agent runtimes, Host persistence, or the RPC transport. Do not treat direct browser execution as a supported product surface; the supported client is the desktop application.

## Source layout

- `src/main.tsx` — frontend entry point.
- `src/shell/` — app composition, navigation, and cross-feature coordination.
- `src/features/` — conversation, sessions, projects, settings, scheduled tasks, and provider UI.
- `src/workspace-tabs/` — tab registry, container, and built-in tab modules.
- `src/components/`, `src/hooks/`, `src/lib/` — shared UI and app utilities.
- `src/locales/` — translation resources and locale runtime.
- `src/workers/` — browser worker modules used by the app.


## Development

From the repository root:

```sh
npm ci
npm run dev
```

`npm run dev` starts the complete desktop development setup, including the Host and Tauri shell. The app package's Vite command is also used internally by Tauri's `beforeDevCommand`; it is not a substitute for the complete desktop workflow.

Build the client and app in dependency order with:

```sh
npm run build:app
```

The app's package-level build runs TypeScript validation and Vite bundling. Run the root `npm run build:app` when validating the integrated app because it builds `@vagus/client` first.

## UI contribution guidance

- Put feature-owned UI, state, and conversion code in the owning `features/<feature>/` directory.
- Put cross-page composition in `shell/`; avoid adding unrelated responsibilities to the app entry point.
- Keep tab-specific behavior in its module and shared tab lifecycle in `workspace-tabs/`.
- Use the locale system for user-visible strings rather than adding untranslated literals.

This package is private to the Vagus monorepo and is not currently published to npm.
