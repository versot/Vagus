# `@vagus/agent-core`

Provider-neutral interfaces that describe how the Host starts and manages Agent sessions.

This private workspace package owns the boundary between Vagus Host and Agent implementations. It defines provider descriptors, capability declarations, session lifecycle operations, runtime settings, imports, and other provider-facing contracts. It depends on `@vagus/protocol` for canonical Vagus types and must not depend on a specific Agent SDK.

## Responsibilities

- Define `AgentProvider` and `AgentSession` contracts consumed by the Host.
- Describe provider identity, capability status, session startup, resume references, and optional operations.
- Keep native Agent event and storage formats behind each provider adapter.
- Make unsupported and partially supported capabilities explicit instead of assuming feature parity.

## Source layout

- `src/provider.ts` — provider, session, capability, import, and runtime-setting interfaces.

## Adding or changing a contract

Before extending an interface, identify the end-to-end path that will consume it. Keep optional operations optional when providers may not support them, and represent provider-owned resume data as opaque data. Do not put Pi-, ACP-, Claude-, Codex-, OpenCode-, Qoder-, or ZCode-specific types in this package.

Provider capability declarations must describe what Vagus has actually wired through the adapter, protocol, and UI.

## Development

Run from the repository root:

```sh
npm ci
npm run build --workspace=@vagus/agent-core
npm run typecheck --workspace=@vagus/agent-core
```

`@vagus/protocol` must be built first. Use `npm run build:contracts` to build the contract packages in dependency order.



This package is private to the Vagus monorepo and is not currently published to npm.
