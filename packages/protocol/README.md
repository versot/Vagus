# `@vagus/protocol`

The shared, provider-neutral contract between the Vagus Host and its clients.

This private npm workspace package defines the wire-level commands, inputs, outputs, events, and shared data types used across the Host/client boundary. It is the source of truth for message shapes; it does not implement transport, persistence, provider behavior, or UI presentation.

## Responsibilities

- Define the protocol version and stable RPC command and event types.
- Describe workspace, session, provider, scheduling, and Git-review payloads.
- Validate incoming RPC inputs and enforce protocol-level limits.
- Provide shared event reducers and canonical types where both Host and client need identical semantics.

## Source layout

- `src/index.ts` — public package exports and protocol constants.
- `src/rpc.ts` — RPC request/response envelopes, errors, limits, and input schemas.
- `src/workspace.ts` — command names and typed command inputs and outputs.
- `src/workspace-review.ts` — workspace review and patch payloads.

## Compatibility

The protocol version is declared by `PROTOCOL_VERSION`. Changes to commands, events, required fields, validation limits, or recovery semantics can affect every client and Host process. Before changing a public shape:

1. Update the canonical contract and its validation schema together.
2. Update the Host handler and client usage in the same change.
3. Consider mixed-version connections and preserve compatibility where practical.

Do not add provider-specific wire types here. Convert provider-native data at the Host adapter boundary.

## Development

Run commands from the repository root:

```sh
npm ci
npm run build --workspace=@vagus/protocol
npm run typecheck --workspace=@vagus/protocol
```

The package exports its built API from `dist/`; build it before building dependent workspaces. Root orchestration commands such as `npm run build:contracts`, `npm run build:host`, and `npm run build:app` handle the dependency order.



This package is private to the Vagus monorepo and is not currently published to npm.
