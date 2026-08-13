# Contributing to Bitlab

Thanks for taking the time. This document covers what you need to get a change
merged; the [development guide](./docs/development.md) covers the environment in
depth and the [architecture guide](./docs/architecture.md) explains the runtime
boundaries you will be working inside.

## Setup

```bash
git clone https://github.com/limboinf/bitlab-agent.git
cd bitlab-agent
bun install --frozen-lockfile
bun run electron:dev
```

You need [Bun](https://bun.sh) 1.3.14+, Node.js 18+, and — for the document-tool
tests — Python 3.12 with [`uv`](https://docs.astral.sh/uv/).

Develop against an isolated configuration root so you never touch your real
workspaces:

```bash
BITLAB_CONFIG_DIR=/tmp/bitlab-dev bun run electron:dev
```

## The gate

Run this before opening a pull request. CI runs the same commands, plus the
packaging matrix for macOS, Windows, and Linux:

```bash
bun run lint
bun run audit:brand
bun run validate:ci
bun run test
```

`validate:ci` covers type checking across every workspace, the focused test
suites, the document-tool smoke tests, and localization parity. If you touched
locale files, `bun run sort-locales` fixes ordering rather than only reporting it.

## Scope

Bitlab is deliberately a "Lite" derivative of Craft Agents OSS. Some feature areas
were removed on purpose and are not eligible to come back:

Claude Agent SDK backend, GitHub Copilot, external messaging gateways, Sources and
MCP servers, image generation, public sharing and the Viewer app, product
automations, and the scheduler UI.

[docs/upstream-sync.md](./docs/upstream-sync.md) lists the full boundary and the
procedure for absorbing upstream changes. A pull request that reintroduces one of
those areas will be closed regardless of quality, so open an issue first if you
believe the boundary should move.

## Pull requests

- Branch from `main`. Keep one logical change per pull request.
- Match the surrounding code: this repository favors small functions, explicit
  module seams, and no comments restating what the code already says.
- User-visible changes need a line under `## [Unreleased]` in
  [CHANGELOG.md](./CHANGELOG.md). Internal refactors do not.
- New user-facing strings go through i18n with both `en` and `zh` entries.
- Documentation lives in `docs/`; the Simplified Chinese translation under
  `docs/zh/` is kept in sync with the English source.
- Do not commit build output, `node_modules`, or the vendored Bun binary.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
fix(electron): keep the Browser pane alive across window reload
feat(cli): add --json to the session list command
docs(releases): document the first-release path
```

## Releases

Releases are cut by maintainers from `main` with `bun run release:prepare <version>`
followed by an annotated tag. Contributors never bump versions in a pull request —
`release:prepare` updates every workspace manifest at once, and a manual bump only
creates a conflict. See [docs/releases.md](./docs/releases.md).

## Reporting bugs and vulnerabilities

Use the issue templates for bugs and feature requests. **Do not open a public
issue for a security vulnerability** — follow [SECURITY.md](./SECURITY.md) instead.

## License

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE), consistent with the rest of the project.
