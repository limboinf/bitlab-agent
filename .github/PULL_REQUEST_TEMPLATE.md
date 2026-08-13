## What and why

<!-- What changes, and what problem it solves. Link the issue: Fixes #123 -->

## How to verify

<!-- The steps a reviewer runs to see it working. Include the interface you tested:
     Desktop, WebUI, or CLI — and the platform. -->

## Checklist

- [ ] `bun run lint`, `bun run audit:brand`, `bun run validate:ci`, and `bun run test` pass locally
- [ ] User-visible changes are listed under `## [Unreleased]` in `CHANGELOG.md`
- [ ] New user-facing strings have both `en` and `zh` locale entries
- [ ] Documentation updated in `docs/` (and `docs/zh/` when the English source changed)
- [ ] No version bumps — releases are cut with `bun run release:prepare`
- [ ] Stays inside the Lite boundary described in `docs/upstream-sync.md`
