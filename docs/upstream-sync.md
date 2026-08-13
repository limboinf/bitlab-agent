# Upstream synchronization

Bitlab derives its architecture, UI, and runtime from [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss). This document defines the workflow for absorbing new Craft changes while staying inside the Lite boundary.

## Baseline (current)

| Item | Value |
|---|---|
| Repository | `craft-ai-agents/craft-agents-oss` |
| Tag | `v0.11.2` |
| Commit | `a60ebc1a5a7cb0a6af7a77d5eed0512c5fc07658` |

When upstream publishes a new tag worth evaluating:

1. Record the new tag and commit: `git -C ../craft-agents-oss rev-parse HEAD && git -C ../craft-agents-oss describe --tags --always`.
2. Add the commit to this document so the "current baseline" stays a single source of truth.
3. Move through the steps below using the new commit.

Reference checkouts (`../craft-agents-oss`, `../echo`, `../xagent`) stay read-only during Bitlab work.

## Sync procedure

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │ 1. Lock the baseline                                              │
  │    git -C ../craft-agents-oss checkout <commit>                  │
  │    git -C ../craft-agents-oss status --short   # must be clean    │
  │                                                                  │
  │ 2. Diff against the baseline                                      │
  │    git -C ../craft-agents-oss diff <old>..<new> --stat            │
  │       → review by hand; no automated lineage audit ships anymore  │
  │                                                                  │
  │ 3. Pull upstream changes file-by-file                            │
  │    for each upstream commit touching a same-path file:           │
  │      classify:  STRICT_REUSE  |  LITE_SEAM  |  REMOVED_FEATURE    │
  │      STRICT_REUSE:  take the file as-is, re-apply brand renames  │
  │      LITE_SEAM:     merge manually, keep Bitlab seams            │
  │      REMOVED_FEATURE: do not import; document why in the seam    │
  │                                                                  │
  │ 4. Add upstream-only features that fit Bitlab                    │
  │      new feature scope → bitlab migration-review issue           │
  │      outside scope     → keep Bitlab Lite                        │
  │                                                                  │
  │ 5. Validate                                                       │
  │    bun run typecheck:all                                          │
  │    bun run lint                                                   │
  │    bun run validate:ci                                            │
  │    bun run test                                                    │
  │    bun run electron:build                                         │
  │    bun run webui:build                                            │
  │    bun run cli:build                                              │
  │    bun run server:build:subprocess                                │
  │                                                                  │
  │ 6. GUI smoke against a fresh config dir                           │
  │    rm -rf /tmp/bitlab-smoke && BITLAB_CONFIG_DIR=/tmp/bitlab-smoke \│
  │       bun run electron:dist:dev:mac                              │
  │    + headless smoke: bun run server:dev:webui                     │
  └──────────────────────────────────────────────────────────────────┘
```

## File-seam classification

| Class | Rule | Validation |
|---|---|---|
| `STRICT_REUSE` | Same relative path, mechanical differences only (scope, URL scheme, config root, brand strings) | Manual diff after applying the brand renames below |
| `LITE_SEAM` | Same relative path with branches removed for excluded features, or wired into Bitlab-only interfaces | Manual semantic review; targeted unit/integration tests; typecheck |
| `REMOVED_FEATURE` | File is removed entirely from Bitlab because the corresponding product area is gone | Path, call sites, and build closure |

Adding upstream-only features starts with the Lite question first; only features that fit the Lite boundary should be picked up.

## Brand renames applied to imported files

Bitlab no longer ships an automated source-lineage audit (the hash manifests and
`audit:craft-reuse` / `lint:craft-*` scripts were removed during the Bitlab rename).
What remains is `bun run audit:brand`, which does not compare against upstream at
all: it fails CI when any of the strings below survives into `apps/`, `packages/`,
`scripts/`, or `.github/`. Attribution belongs in `NOTICE`, `LICENSE`, and `docs/`,
which the audit does not scan. A line that must keep a brand string — a test
asserting its absence, for instance — is exempted with a trailing
`bitlab-brand-audit-ignore` comment.

When importing a file from Craft, apply these substitutions by hand before diffing:

| Upstream | Bitlab |
|---|---|
| `@craft-agent/` | `@bitlab/` |
| `craftagents://` | `bitlab://` |
| `.craft-agent` | `.bitlab` |
| `CRAFT_AGENT_` | `BITLAB_` |
| `Craft Agents Backend` | `Pi Backend` |

## What is not eligible for sync

- Claude Agent SDK backend and the `claude-agent-sdk*` packages; keep the retained Claude OAuth flow routed through Pi
- GitHub Copilot, generic/Sources OAuth, and their SDKs
- External messaging gateway and workers
- Sources, MCP server, bridge MCP server, MCP-related UI
- Image generation models and `gen_image`
- Public sharing, Viewer app
- Product automations and the scheduler UI
- Sources API/Settings UI, session labels, user-defined statuses
- WhatsApp worker

These are recorded as Lite-boundary deletions in [`comparison-with-craft.md`](./comparison-with-craft.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Type error in `apps/electron/src/main` only after a sync | Upstream introduced a new env var or platform helper | confirm it survives the Lite seam; document before commit |
| Renderer asset 404 in packaged build | New Craft asset added without updating `scripts/copy-assets.ts` | add the asset to the copy list and rebuild |
| `electron:build` succeeds but `Bitlab Helper` lacks a Claude/Sources plugin | Confirm `appId` is `app.bitlab.desktop` and `@bitlab/*` is the only scope in `extraResources` | check `apps/electron/electron-builder.yml` |
