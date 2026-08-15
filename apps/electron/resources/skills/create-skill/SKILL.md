---
name: create-skill
description: Turn a repeated workflow into a reusable Skill. Use when the user says something is repetitive, asks to "make that a skill", or describes a routine they run regularly.
license: Apache-2.0
metadata:
  bitlab.icon: "🧩"
---

# Create a Skill

A Skill is a directory holding `SKILL.md` — YAML frontmatter plus Markdown
instructions — that teaches specialized behavior. Your job is to turn what the
user described into one, and to propose it rather than write it silently.

## Ask before writing

A Skill built from a vague description is a Skill nobody uses. Ask only what
you cannot infer, and no more than three questions:

- What triggers it — what is the user doing when this should apply?
- What is the input, and where does it live?
- What does "done" look like?

Skip any question the user already answered.

## Write the frontmatter

Only these fields exist. Anything else is ignored.

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | lowercase, hyphens, matches the directory name |
| `description` | yes | says what it does **and when to use it** |
| `license` | no | |
| `compatibility` | no | environment prerequisites |
| `metadata` | no | string map; Bitlab reads `bitlab.icon` and `bitlab.requiresMcp` |

The `description` is the only thing loaded until the Skill activates, so it
carries the entire decision of whether to read further. "Formats data" is
useless. "Turn a CSV export into a summary table. Use when the user shares a
spreadsheet and asks what it says" is not.

## Write the body

Write instructions to a capable colleague who has not seen this task before.
Concrete steps, real paths, real command names. State what to do when the
usual case does not hold. Keep it under about 500 lines — anything longer
belongs in a file beside `SKILL.md` that the body points to.

Do not restate general good behavior. The agent already knows how to write
code; the Skill exists to carry what is specific to this workflow.

## Propose, then save

Show the complete `SKILL.md` and say which tier it would go to:

- **Workspace** — available across this workspace. The usual choice.
- **Directory** — travels with the checkout, shared with whoever clones it.
- **Global** — every workspace on this machine.

Then call `skill_validate` and let the user save it. Never write the file
without being asked to.
