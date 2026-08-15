# Skills

A Skill is a directory containing `SKILL.md` — YAML frontmatter plus Markdown instructions — and optionally scripts, references, and assets beside it. Skills follow the [Agent Skills](https://agentskills.io) format, so a Skill written for Bitlab also loads in Codex, Claude Code, and Pi's own CLI.

This document describes shipped behavior. For the gap against the standard and the planned Skills Hub, see [skills-design.md](./skills-design.md).

## Discovery paths

Three tiers, merged by slug. Priority `global < workspace < project`:

```text
1. ~/.agents/skills/<slug>/SKILL.md                    (global)
2. ~/.bitlab/workspaces/<slug>/skills/<slug>/SKILL.md  (workspace)
3. <projectRoot>/.agents/skills/<slug>/SKILL.md        (project)
```

`projectRoot` is the session's working directory, not the repository root — project Skills follow the directory the session is working in. `~/.bitlab` honors `BITLAB_CONFIG_DIR`; `~/.agents` is always under the home directory and is shared with other Agent Skills tools.

A Skill present in several tiers resolves to the highest-priority one. The others are shadowed, not deleted, and Bitlab does not currently warn about the shadowing.

Results are cached per `(workspaceRoot, projectRoot)` pair with a 5-minute TTL ([`storage.ts:172`](../packages/shared/src/skills/storage.ts)). Editing a `SKILL.md` can take up to 5 minutes to show up unless something calls `invalidateSkillsCache()` — changing the working directory does.

## `SKILL.md` format

```markdown
---
name: pptx-deck-authoring
description: Author a structured PowerPoint deck from research notes. Use when the user asks for slides or a presentation.
icon: "📊"
---

# PPTX Deck Authoring

Plan the deck structure, draft slide titles, then run `pptx-tool` to materialize.
```

| Frontmatter key | Required | Behavior in Bitlab today |
| --- | --- | --- |
| `name` | yes | Display name. Missing `name` or `description` makes the directory be skipped silently |
| `description` | yes | Shown in the picker and the Skills list |
| `icon` | no | Emoji or URL only. A URL is downloaded to `icon.<ext>` in the Skill directory. Inline SVG and relative paths are rejected |
| `globs` | no | Parsed and stored, but **not consumed** by the Pi backend |
| `alwaysAllow` | no | Parsed and stored, but **not consumed** — the permission engine is unaffected |

The standard's `license`, `compatibility`, `metadata`, and `allowed-tools` fields are accepted by the YAML parser but currently ignored. Per spec, `name` should match the directory name; Bitlab does not enforce or warn on a mismatch.

## Invocation

Skills are invoked explicitly. The model does not discover them on its own.

1. The user references a Skill with `[skill:slug]` in the prompt — the chat picker inserts this syntax.
2. The system prompt tells the model to read that Skill's `SKILL.md` before anything else; tool calls are blocked until it has.
3. The model follows the instructions in the file.

A Skill the user does not name is invisible to the model. Two independent reasons, both in the Pi backend:

- [`system-prompt-override.ts`](../packages/pi-agent-server/src/system-prompt-override.ts) replaces the session's `_rebuildSystemPrompt` with a constant, discarding the Skill catalog Pi assembles there.
- Pi 0.80.6 scans `<agentDir>/skills` and `<cwd>/.pi/skills` by default. Bitlab's tiers use `.agents/skills` and a workspace directory, so none of them are scanned — and `agentDir` points at a per-session temp directory.

Pi's native auto-discovery, progressive disclosure, and `/skill:name` commands are therefore all inactive. See [skills-design.md](./skills-design.md) for the plan to change this.

## Operations

| Operation | Entry point | RPC channel |
| --- | --- | --- |
| List | Settings → Skills; chat Skills panel | `skills.GET` |
| Browse files in a Skill | Skill detail page | `skills.GET_FILES` |
| Delete | Skills list row menu | `skills.DELETE` |
| Open `SKILL.md` in editor | Skills list row menu | `skills.OPEN_EDITOR` |
| Open folder in Finder/Explorer | Skills list row menu | `skills.OPEN_FINDER` |
| Validate | `skill_validate` session tool, resolves across all three tiers | — |

Creating a Skill means creating the directory and `SKILL.md` yourself, or asking the agent to write them.

`skills.DELETE`, `skills.OPEN_EDITOR`, and `skills.OPEN_FINDER` all resolve a bare slug against the workspace tier only, so acting on a global or project Skill from the UI targets the wrong path or does nothing.

`deleteSkill` joins the slug onto the skills directory and removes the result recursively, with no path containment check and no slug validation at the RPC layer.

## Known limitations

- No auto-discovery: the model cannot select a Skill unless the user names it.
- No install, update, or enable/disable — the only lifecycle operation is delete.
- Delete, open-in-editor, and reveal-in-file-manager are workspace-tier only.
- Delete performs no path containment check on the slug it is given.
- Project-tier Skills are not gated on any repository trust decision.
- Edits are picked up on a 5-minute TTL rather than a file watcher.
- `globs` and `alwaysAllow` are inert.
- Shadowed Skills across tiers are not surfaced anywhere in the UI.
