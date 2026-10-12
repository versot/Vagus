# Agent instructions

Read [CLAUDE.md](CLAUDE.md) before repository-wide changes. For work inside a package, read its package README and follow any nearer instructions.

Keep these boundaries intact:

- Vagus is a multi-Agent desktop product. The root README lists integrated Providers and product scope.
- Desktop is the product client; platform statements must match the actual package and CI configuration.
- A capability is supported only after its full path through the adapter, canonical protocol, and UI works.
- Keep Provider-specific behavior behind the Provider adapter and canonical protocol.

Before changing behavior, inspect the owning code and nearest package README. Update README or contributor instructions when a change affects product scope, setup, or user-visible behavior.
