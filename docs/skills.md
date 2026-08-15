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

A Skill present in several tiers resolves to the highest-priority one. The others are shadowed, not deleted, and the catalog retains them so the shadowing can be surfaced.

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
| `license` | no | Recorded and displayed |
| `compatibility` | no | Environment prerequisites. Recorded and displayed |
| `metadata` | no | Free-form string map. Bitlab reads `bitlab.icon` (emoji or URL; a URL is downloaded to `icon.<ext>` in the Skill directory, inline SVG and relative paths are rejected) and `bitlab.requiresMcp` (comma-separated MCP server names, resolved against workspace config) |
| `allowed-tools` | no | Pre-approves those tools for the turn that invokes the Skill (see below) |
| `disable-model-invocation` | no | Hides the Skill from the catalog the model sees; it remains explicitly invocable |

A top-level `icon` field is still read as a fallback, but `metadata.bitlab.icon` is the form to write. Per spec, `name` should match the directory name; a mismatch loads with a warning rather than failing.

## Invocation

A Skill can be selected by the model or named by the user.

**By the model.** Every eligible Skill's `name`, `description`, and location are listed in the system prompt under `<available_skills>`. The model reads a Skill's `SKILL.md` when its description matches the task — the body costs nothing until then, which is what keeps a large catalog affordable.

**By the user.** Referencing `[skill:slug]` in the prompt — the chat picker inserts this syntax — makes the model read that `SKILL.md` before anything else; tool calls are blocked until it has.

The catalog reaches Pi through its resource loader rather than a pre-assembled prompt string: `noSkills` turns off Pi's own scan (which would otherwise miss every Bitlab tier and pick up an unreviewed `<cwd>/.pi/skills`), `skillsOverride` supplies the resolved winners in Bitlab's precedence order, and `systemPromptOverride` feeds in Bitlab's base prompt so Pi keeps appending the catalog on every rebuild.

One consequence worth knowing: Pi only appends `<available_skills>` when the `read` tool is active. Bitlab asserts this at wiring time rather than shipping a catalog the model cannot see.

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

`skills.DELETE`, `skills.OPEN_EDITOR`, and `skills.OPEN_FINDER` still resolve a bare slug against the workspace tier only, so acting on a global or project Skill from the UI targets the wrong path or does nothing.

Paths derived from a slug or a Skill id are canonicalized and checked against their tier root before any filesystem operation, so neither a traversal nor an escaping symlink can reach a directory outside the tier.

## Tool pre-approval

A Skill's `allowed-tools` covers **the turn that invoked it** and clears when
the user sends the next message. Invoking the Skill again re-applies it.

It only ever widens. A tool that is not listed keeps its normal prompt, and
nothing in a Skill can turn a refusal into an allowance:

- `safe` mode blocks writes outright and never reaches the prompt decision, so
  a grant there has nothing to widen.
- Dangerous commands (`rm`, `sudo`, `curl`, …) are prompted no matter who
  declared them. A Skill asking for `Bash(rm:*)` gets the declaration shown at
  install time and the prompt anyway.

Patterns are the specification's: `Read` grants the tool; `Bash(git:*)` grants
one command family. The prefix is a command, not a substring — `Bash(git:*)`
does not cover `gitleaks`. Only Bash matches on arguments; a file path is not a
command, so `Write(src:*)` grants nothing.

Persistent pre-approval is not this field's job — that belongs in
`permissions.json`. Setting `skillToolApproval` to `false` in the global config
makes every declaration inert without editing any Skill.

## Project trust

Project-tier Skills execute instructions that arrive with a checkout, so they stay out of the runtime until the project root is trusted. Until then they are still listed, marked untrusted, and contribute nothing — the workspace or global copy of the same slug wins instead.

Trust is per project root, persisted in the workspace's `skills.json`, and revocable. Where there is no UI to grant it through — the headless server and WebUI — the operator names roots explicitly in `BITLAB_TRUSTED_PROJECT_ROOTS` (platform-delimited path list). The default is untrusted in every case.

## Known limitations

- No install or update — the only lifecycle operations are create-by-hand and delete.
- Delete, open-in-editor, and reveal-in-file-manager are workspace-tier only.
- Edits are picked up on a 5-minute TTL rather than a file watcher.
- Shadowed Skills across tiers are recorded in the catalog but not yet surfaced in the UI.
