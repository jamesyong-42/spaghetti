# Releasing

This repository uses `release-please` as the single source of truth for releases.

## Policy

- Do not manually bump versions in the root `package.json`, `packages/cli/package.json`, `packages/sdk/package.json`, or `crates/spaghetti-napi/package.json` (or its per-platform npm shims under `crates/spaghetti-napi/npm/*/package.json`).
- Do not manually edit `.release-please-manifest.json`.
- Do not manually create release commits as part of the standard release flow.
- Do not manually tag versions unless you are explicitly repairing a broken release state.

`release-please` owns:

- version bumps
- root changelog updates
- release PR creation
- release tag creation
- GitHub release creation

The publish workflow then publishes the released package versions from the merged release commit.

## Normal Flow

1. Merge normal commits into `main`.
2. Wait for `release-please` to open or update its release PR.
3. Review that PR like any other PR.
4. Merge the release PR.
5. Let the `Release` GitHub Actions workflow publish the packages.

## Commit Conventions

`release-please` derives release notes and bump behavior from commit history.

- Use `feat:` for user-visible features.
- Use `fix:` for bug fixes.
- Use scoped conventional commits when useful, for example `feat(cli): ...` or `fix(channel): ...`.

In practice:

- `feat:` will normally drive a minor release.
- `fix:` will normally drive a patch release.

## Current Baseline

The authoritative baseline lives in `.release-please-manifest.json` (single component `.`) and is automatically advanced by `release-please` on each release PR merge. `release-please-config.json`'s `extra-files` list is what propagates that single bump into every package version in lock-step — currently the root `package.json`, `packages/cli/package.json`, `packages/sdk/package.json`, `crates/spaghetti-napi/package.json`, and the per-platform npm shims under `crates/spaghetti-napi/npm/*/package.json`.

Adding a new published workspace member (another platform crate, a new SDK subpackage, etc.) means adding its `package.json` to `extra-files` — otherwise it will drift out of the lock-step bump and fail publishing.

Future releases should continue from whatever the manifest currently records — through `release-please`, not through manual version/tag commits.
