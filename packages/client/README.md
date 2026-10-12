# `@vagus/client`

A typed client for authenticated communication with the Vagus Host.

The client provides the application-facing connection to the Host RPC endpoint. It owns socket lifecycle, authentication, typed command requests, event subscriptions, connection state, and reconnection behavior. Application features should call this client rather than implement their own Host transport.

## Responsibilities

- Establish and authenticate a WebSocket connection to the Host.
- Map protocol commands to typed inputs and outputs.
- Deliver Host events to subscribers and report connection-state changes.
- Handle request timeouts, cancellation, connection loss, and reconnect attempts.
- Preserve result-uncertain semantics: a disconnected client must not blindly replay a command whose outcome is unknown.

The client does not start or supervise the Host process, persist application data, or interpret Agent-specific payloads. The desktop shell manages Host startup and supplies connection credentials; the protocol package owns the shared wire types.

## Source layout

- `src/index.ts` — `HostClient`, connection options, typed RPC helpers, and public exports.

## Development

Run from the repository root:

```sh
npm ci
npm run build:client
```

`npm run build:client` builds `@vagus/protocol` first and then emits the client package to `dist/`. The application build uses this root command to keep workspace dependency order consistent.

## Integration guidance

- Obtain the Host URL and token from the trusted desktop initialization path; do not store credentials in a URL, browser storage, or logs.
- Subscribe to connection state and events through the client lifecycle, and dispose subscriptions when their owner is removed.
- Do not retry non-idempotent operations after an uncertain disconnect unless the operation has an explicit idempotency contract.
- Keep provider-specific behavior in Host adapters, not in this package.


This package is private to the Vagus monorepo and is not currently published to npm.
