# Release Notes

Maintain one English-language Markdown file for each release. The filename defines the release version and Git tag. For example:

```text
releases/v0.1.0-beta.1.md
```

When a release note is merged into `main`, GitHub Actions validates the version against the application manifests, builds installers for Windows x64, macOS Intel, and Apple silicon, then creates the corresponding GitHub Release. SemVer prereleases such as `0.1.0-beta.1` are marked as pre-releases. The Markdown file becomes the Release description, and the build artifacts include `SHA256SUMS.txt`.

Release notes must be written in professional, concise English. The workflow rejects release note files containing Chinese characters. Keep descriptions user-focused: explain the change and its impact without exposing internal implementation details unless they affect users.

## Preparing a release

1. Set the same version in the root package, desktop package, Tauri configuration, and Cargo package; update the lockfiles as needed.
2. Copy [`TEMPLATE.md`](TEMPLATE.md) to `v<version>.md` and describe the user-visible changes, fixes, and known issues in English.
3. Include the version updates and exactly one new release note in a pull request to `main`.
4. After the pull request is merged, review the platform builds and publication result in the GitHub Actions Beta Release workflow.

The proposed first Beta version is `0.1.0-beta.1`. Do not merge a release note until the installers are ready to publish and the release contents have been reviewed. The workflow publishes automatically after the merge.

See [`TEMPLATE.md`](TEMPLATE.md) for the required structure.
