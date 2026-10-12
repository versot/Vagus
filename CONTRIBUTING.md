# Contributing to Vagus

Thank you for your interest in improving Vagus. Before starting work, read the [README](README.md) and check existing issues to make sure your proposal fits the desktop product and its supported agent integrations.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security issues privately as described in the [Security Policy](SECURITY.md); do not disclose vulnerability details in a public issue.

## Get started

Development requires Node.js 22.13 or later, npm, a stable Rust toolchain, the C++ build tools required by Tauri on Windows, and the Microsoft Edge WebView2 Runtime. Windows x64 is the primary development target. The release workflow also builds macOS packages, but those builds have not completed release-level validation.

From the repository root:

```powershell
npm ci
npm run dev
```

## Make a change

- Keep changes focused. Update the root README or the relevant package documentation when a change affects product scope, setup, or user-visible behavior.
- Keep provider-specific protocols and behavior in their adapters. Shared UI code should depend on Vagus's canonical contracts.
- Describe a capability as supported only after its adapter, protocol, and UI paths work together.
- Before adding a dependency, explain its purpose, maintenance status, and license. Update `package-lock.json` or `Cargo.lock` as appropriate, and retain any upstream copyright, license, and NOTICE files required for redistribution.
- Submit code, images, icons, fonts, and documentation only when you have the right to redistribute them under their applicable licenses. For third-party material, provide its source, version, and license text or link. A code license does not grant rights to third-party trademarks.
- Do not commit real credentials, personal conversation data, build artifacts, or machine-specific settings.

## Verify your work

Run the checks relevant to your change and list the commands and results in your pull request. Common commands are:

```powershell
npm run style:check
npm run test:stage-one
npm run build:app
cargo test --locked --manifest-path packages/desktop/src-tauri/Cargo.toml
npm run build:desktop
```

Run `npm run style:check` before submitting. It checks changed files, so formatting rules do not create unrelated repository-wide edits.

For changes to the native desktop lifecycle, also run the Windows native regression check:

```powershell
npm run test:stage-one:native
```

State which operating systems and environments you actually checked. A successful build alone does not establish compatibility on other platforms.

## Open a pull request

Use the repository's pull request template and include:

1. The problem addressed and its user-visible effect.
2. The implementation scope, including affected agents or platforms.
3. The checks you ran, their results, and anything you did not verify.
4. The name, source, version, and license of any new third-party code or assets.
5. Screenshots or a short recording for UI changes.
