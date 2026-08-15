# Skills: current state and design proposal

Bitlab ships a Skills feature that predates the Pi migration. This document records what the code actually does today, what the ecosystem has standardized on, and a staged proposal for a Skills Hub — discovery, installation, authoring, and lifecycle management.

Status: **P0 through P2 are implemented.** [`skills.md`](./skills.md) documents the shipped behavior and is the reference for how things work now; this document is kept as the design record — the reasoning, the alternatives weighed, and what was deliberately deferred. §1 describes the state that motivated the work, in the past tense of a problem statement, not of current behavior.

Revision note: §1.2 and §5.2 were rewritten after a review found the original root-cause analysis wrong. The claims below are backed by a reproducible probe against the pinned SDK — see [§1.6](#16-reproducing-the-probe).

Corrections found during implementation, recorded because the errors were load-bearing:

- **§1.4 said `globs` and `alwaysAllow` had "no consumer anywhere in the codebase". They had three.** `SkillInfoPage.tsx` rendered a whole "Permission Modes" table gated on `alwaysAllow`; `config/validators.ts` carried both in its schema; `EditPopover.tsx` advertised them to the agent when authoring a skill. The UI one mattered most: it told the user a skill had pre-approved permissions while the engine never read the field — the table was describing something that did not happen.
- **§5.2 said `applySystemPromptOverride` had one call site. It had two.** The second was an ephemeral session created with `tools: []` and no resource loader, so deleting the helper outright would have broken it; it got its own minimal loader instead.
- **§5.2's seam list was right but incomplete in one respect.** `DefaultResourceLoader` caches its resolved skills until the next `reload()`, and `reload()` rebuilds the extension runtime — too heavy to run on every `SKILL.md` edit. `BitlabResourceLoader` therefore answers `getSkills()` and `getSystemPrompt()` from the catalog on every call instead of delegating them.
- **§1.1 noted that `~/.agents` is pinned to `homedir()`.** That also made the global tier untestable, so the catalog takes an optional root; the default is unchanged.

## 1. Current state, verified against the code

### 1.1 Discovery

Three tiers, merged by slug, higher priority wins ([`storage.ts:189`](../packages/shared/src/skills/storage.ts)):

| Priority | Path | `SkillSource` |
| --- | --- | --- |
| 1 (lowest) | `~/.agents/skills/<slug>/SKILL.md` | `global` |
| 2 | `~/.bitlab/workspaces/<slug>/skills/<slug>/SKILL.md` | `workspace` |
| 3 (highest) | `<projectRoot>/.agents/skills/<slug>/SKILL.md` | `project` |

`projectRoot` is the session working directory, not the repository root. `~/.bitlab` honors `BITLAB_CONFIG_DIR`; `~/.agents` does not — it is pinned to `homedir()`.

The `.agents/` choice is worth keeping: it is the shared cross-tool directory Codex scans, so a skill authored for Bitlab is portable by construction. Note that Pi 0.80.6 does *not* scan it (§1.2).

### 1.2 Why the model never sees a skill

Two independent blockers, both verified.

**Blocker A — the system prompt override discards Pi's skill catalog.** [`system-prompt-override.ts:20`](../packages/pi-agent-server/src/system-prompt-override.ts) permanently replaces the session's `_rebuildSystemPrompt` with `() => prompt`. That method (`pi-coding-agent@0.80.6 dist/core/agent-session.js:708-723`) is precisely where Pi reads `resourceLoader.getSkills()` and hands the result to `buildSystemPrompt`, which appends `formatSkillsForPrompt(skills)`. Overriding it throws away the catalog Pi assembled. Even if skill paths were wired correctly, the model would still see nothing.

The override exists for a real reason — Pi 0.80.6 has no public per-turn system-prompt API and `state.systemPrompt` is reset on every `prompt()` call — but it reaches for a private method when a public one covers the need (§5.2).

**Blocker B — Pi's default scan misses every Bitlab tier.** In 0.80.6, `CONFIG_DIR_NAME` resolves to `.pi` (`dist/config.js:394`), and `loadSkills` with `includeDefaults` scans exactly two directories: `<agentDir>/skills` and `<cwd>/.pi/skills` (`dist/core/skills.js:330-332`). Bitlab uses `.agents/skills` and a workspace directory — **none of which Pi scans**. Combined with `agentDir` being redirected to a per-session temp dir, the default scan yields zero hits in practice.

This corrects a common assumption: Pi's published documentation describes `~/.agents/skills` and `.agents/skills` support, which the pinned build does not have. Everything in this document targets 0.80.6 as shipped — all three Bitlab tiers must be injected explicitly.

**Consequence.** Skills are invoked only by hand. The system prompt hardcodes the paths and the `[skill:slug]` convention ([`system.ts:515`](../packages/shared/src/prompts/system.ts)); the model is never told which skills exist. A skill the user does not name is invisible — which inverts the premise of the format, where `description` exists so the agent can judge relevance itself.

**Dead code.** [`pre-tool-use.ts:186-271`](../packages/shared/src/agent/core/pre-tool-use.ts) resolves bare slugs into `pluginName:skillSlug`, with comments referencing `.claude-plugin/plugin.json` — Claude Agent SDK vocabulary. The Pi backend registers no `Skill` tool, so this never fires. It carries a test suite, which makes it look maintained.

### 1.3 Two incompatible resolvers

Bitlab and Pi disagree on what a skill *is*:

| | Bitlab `loadAllSkills` | Pi `loadSkills` |
| --- | --- | --- |
| Identity | directory slug | frontmatter `name` |
| Collision winner | **last** writer wins (highest tier) | **first** loaded wins |
| Scan scope | the working directory only | walks ancestors; follows symlinks; honors ignore files |
| Shadowed entries | discarded | retained as `collision` diagnostics |
| Order | global → workspace → project | `<agentDir>/skills` → `<cwd>/.pi/skills` → `additionalSkillPaths` |

Two consequences that block the product design:

- **Naively appending workspace paths inverts precedence.** Because `additionalSkillPaths` is concatenated last and first-loaded wins, injecting the three tiers as extra paths yields `global > project > workspace`, not the `project > workspace > global` the product requires. Probe output in §1.6 shows exactly this.
- **`loadAllSkills` cannot back the Installed tab.** It returns winners only ([`storage.ts:192`](../packages/shared/src/skills/storage.ts)), so the per-tier listing and the shadow warnings in §4 have no data source.

### 1.4 Frontmatter is a private dialect

[`types.ts`](../packages/shared/src/skills/types.ts) defines `name`, `description`, `globs`, `alwaysAllow`, `icon`. Only `name` and `description` are standard. `globs` and `alwaysAllow` are parsed and stored but have **no consumer anywhere in the codebase**. The standard fields `license`, `compatibility`, `metadata`, and `allowed-tools` are unimplemented.

### 1.5 Lifecycle gaps

| Capability | Today |
| --- | --- |
| List / read | `skills.GET`, `skills.GET_FILES` |
| Delete | `skills.DELETE` — **workspace tier only** |
| Open in editor / file manager | `skills.OPEN_EDITOR`, `skills.OPEN_FINDER` — **also workspace tier only** |
| Create | Manual filesystem work, or ask the agent to write files |
| Install / update / enable / disable | None |
| Live reload | None — a 5-minute TTL cache ([`storage.ts:172`](../packages/shared/src/skills/storage.ts)) |
| Validate | `skill_validate` session tool, resolves across all three tiers |

Every mutating and revealing operation takes a bare slug and resolves it against `getWorkspaceSkillsPath`, so acting on a global or project skill from the UI silently targets the wrong tier or does nothing.

`deleteSkill` ([`storage.ts:274`](../packages/shared/src/skills/storage.ts)) does `join(skillsDir, slug)` followed by `rmSync(..., { recursive: true })` with **no path containment check and no slug validation at the RPC layer**. A crafted slug traverses out of the skills directory. This is a security bug, not a design gap.

### 1.6 Reproducing the probe

Fixture: `alpha` in both `<agentDir>/skills` and a workspace dir passed via `additionalSkillPaths`; `beta` in `<cwd>/.pi/skills`; a fourth skill in `<cwd>/.agents/skills`.

```
--- winners ---
gamma    /agentdir/skills/gamma/SKILL.md
alpha    /agentdir/skills/alpha/SKILL.md      ← agentDir beat the workspace copy
beta     /proj/.pi/skills/beta/SKILL.md
--- diagnostics ---
collision  name "alpha" collision  /ws/skills/alpha/SKILL.md
```

The skill under `<cwd>/.agents/skills` never appears — confirming Blocker B. The `alpha` collision confirms first-loaded-wins and that `additionalSkillPaths` sorts last.

## 2. What the ecosystem standardized on

Agent Skills is an open standard originally from Anthropic, now implemented by 40+ tools including Pi, Claude Code, Codex, Cursor, Gemini CLI, and Copilot. The unit is a directory holding `SKILL.md` plus optional `scripts/`, `references/`, and `assets/`.

Six frontmatter fields, and no more:

| Field | Required | Constraint |
| --- | --- | --- |
| `name` | yes | ≤64 chars, `[a-z0-9-]`, no leading/trailing/double hyphen, matches the directory name |
| `description` | yes | ≤1024 chars; says what it does **and when to use it** |
| `license` | no | license name or bundled file reference |
| `compatibility` | no | ≤500 chars; environment prerequisites |
| `metadata` | no | free-form string→string map for client-specific data |
| `allowed-tools` | no | space-separated pre-approved tools (**experimental**; support varies by client — see §5.10) |

Loading is a three-stage progressive disclosure: `name` + `description` for every skill at startup (~100 tokens each), the full body on activation (<5000 tokens recommended), bundled files only when referenced.

`metadata` is the designated escape hatch for client-specific fields.

### Competitive comparison

| | Pi 0.80.6 (our backend) | Claude Code | Codex | QwenWork | Bitlab today |
| --- | --- | --- | --- | --- | --- |
| Locations | `<agentDir>/skills`, `<cwd>/.pi/skills`, `additionalSkillPaths` | `~/.claude/skills`, `.claude/skills` (+ nested), plugins | `.agents/skills` (walks up), `$HOME/.agents/skills`, `/etc/codex/skills`, built-in | `~/.qwenworkcn/skills` | `~/.agents/skills`, workspace, `.agents/skills` |
| Auto-discovery | yes | yes | yes (`allow_implicit_invocation`) | yes | **no** |
| Explicit invocation | `/skill:name` | `/skill-name` | `$skill` / `@skill` | `/` menu | `[skill:slug]` mention |
| Progressive disclosure | yes | yes | yes | yes | **no** |
| Disable without deleting | — | `disable-model-invocation` | `[[skills.config]]` in `config.toml` | UI toggle | **no** |
| Live reload | — | file watcher, no restart | — | — | 5-min TTL |
| Distribution | `npm:` / `git:` packages, `pi install` | plugin marketplaces | `$skill-installer`, curated | marketplace UI with categories + install counts | **none** |
| Authoring assist | — | skill-creator | `$skill-creator` | `create-skill` built-in, conversational | **none** |
| Bundles | packages (extensions + skills + tools) | plugins (skills + agents + hooks + MCP) | MCP deps in `agents/openai.yaml` | Expert Kits — 12 role presets | **none** |
| Project trust gate | `project_trust` event | workspace trust dialog | — | — | **none** |

Two designs worth stealing outright:

- **Codex's `agents/openai.yaml`.** Client-specific presentation and policy live in a sidecar, leaving `SKILL.md` spec-pure and portable. Bitlab gets the same separation more cheaply through the standard `metadata` map plus its own sidecar for install state.
- **QwenWork's install funnel.** Marketplace / Built-in / Installed as three tabs, categories plus popular-versus-recent sort, and — critically — the raw `SKILL.md` rendered before install. A skill is executable instruction text; showing it before it lands on disk is the whole security story.

## 3. Design principles

1. **One catalog, one truth.** A single `SkillCatalog` owns discovery, validation, trust, enablement, precedence, and shadow bookkeeping. The UI and the Pi runtime consume the same snapshot, or they will drift.
2. **Standard first, no dialect.** Adopt the six spec fields verbatim; Bitlab-specific data goes under `metadata.bitlab.*`. Fields with no consumer get deleted, not migrated.
3. **Use the backend's public seams.** Pi exposes `systemPromptOverride`, `skillsOverride`, and `additionalSkillPaths`. Reaching into private methods is what broke this the first time.
4. **Install is a trust decision.** Skills execute code by proxy. Preview before write, gate project-tier skills on repository trust, record provenance.
5. **The filesystem stays the source of truth.** No database. A skill is a folder; the UI is a view over folders.
6. **Ship the hub before the market.** Local correctness (P0/P1) is useful with zero server infrastructure.

## 4. Product design

### Information architecture

```
Settings ─┬─ Connections
          ├─ Permissions
          ├─ Skills ──────┬─ Marketplace   registry, categories, install counts
          │               ├─ Built-in      shipped with Bitlab, always present
          │               └─ Installed     3 tiers, toggles, updates
          ├─ Bundles          (P4 — Skills + MCP + permission presets)
          └─ MCP
```

Chat keeps its existing surfaces: the `[skill:slug]` mention menu stays for explicit invocation, and `/skill-name` is added once the native path is live.

### Skills Hub — Installed tab

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Skills                                        [ ⟳ ]  [ 🔍 Search    ]  [+ Add ▾]│
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Marketplace    Built-in    ●Installed 12                    [Tier: All ▾]   │
│  ─────────────────────────────────────────────────────────────               │
│                                                                              │
│   PROJECT · bitlab-agent/.agents/skills            3 skills   [Reveal] [⋯]   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📐  release-notes                                          [ ●━━ On  ] │  │
│  │     Draft release notes from the changelog and merged PRs.             │  │
│  │     v1.2.0 · git:github.com/acme/skills · updated 2d ago    ⟳ Update   │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ 🧪  test-triage                                            [ ●━━ On  ] │  │
│  │     Classify failing tests and propose the smallest fix.               │  │
│  │     local · edited 4h ago                                              │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ 🚀  deploy                          ⚠ shadows workspace:deploy         │  │
│  │     Run the staging deploy checklist.                      [ ━━○ Off ] │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   WORKSPACE · ~/.bitlab/workspaces/main/skills      6 skills   [Reveal] [⋯]  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📊  data-report        Turn a CSV into a visual report.    [ ●━━ On  ] │  │
│  │ 🚀  deploy             Run the staging deploy checklist.   [ ●━━ On  ] │  │
│  │                        now active — project copy is Off                │  │
│  │                                                    … 4 more  ▾         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   GLOBAL · ~/.agents/skills                         3 skills   [Reveal] [⋯]  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📄  pdf                Read, merge, split, fill PDFs.       [ ●━━ On  ]│  │
│  │                                                    … 2 more  ▾         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Grouping by tier is deliberate: tier determines precedence, and precedence is what users get wrong. The shadow warning on `deploy` makes an invisible conflict legible — and the workspace row below shows the intended fallthrough semantics: turning the project copy Off promotes the workspace copy to winner (§5.4).

`[+ Add ▾]` opens: **Create with the agent** · **Import folder or .zip** · **Install from Git URL**.

### Untrusted project

Project-tier skills stay out of the runtime until the repository is trusted (§5.6).

```
┌────────────────────────────────────────────────────────────────────┐
│   PROJECT · bitlab-agent/.agents/skills      3 skills   ⚠ Untrusted│
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  This folder was not opened in Bitlab before. Skills here    │  │
│  │  can instruct the agent to run commands on your machine.     │  │
│  │                                                              │  │
│  │  release-notes · test-triage · deploy      [Review] [Trust]  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Marketplace tab

```
┌──────────────────────────────────────────────────────────────────────────────┐
│   ●Marketplace    Built-in    Installed 12                 [Popular│Recent]  │
│  ─────────────                                                               │
│   [All] [Writing] [Data] [Design] [Research] [DevOps] [Docs]           ▸     │
│                                                                              │
│   ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐│
│   │ 📊 data-report    [+]│ │ 📝 weekly-report  [+]│ │ ✨ humanizer-zh   [✓]││
│   │ Turn a CSV into a    │ │ Assemble a weekly    │ │ Strip AI tells from  ││
│   │ visual report.       │ │ status update.       │ │ Chinese copy.        ││
│   │ ⬇ 23K · Bitlab       │ │ ⬇ 18K · community    │ │ ⬇ 16K · installed    ││
│   └──────────────────────┘ └──────────────────────┘ └──────────────────────┘│
│   ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐│
│   │ 🎨 ui-designer    [+]│ │ 🔍 industry-research │ │ 🧩 mermaid        [+]││
│   │ Extract a design     │ │ Competitive and      │ │ Author and validate  ││
│   │ system from a ref.   │ │ market analysis.     │ │ Mermaid diagrams.    ││
│   │ ⬇ 1.8K · community   │ │ ⬇ 10K · community[+] │ │ ⬇ 9K · Bitlab        ││
│   └──────────────────────┘ └──────────────────────┘ └──────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### Install preview drawer

The security surface. Nothing is written to disk until the user has seen the instructions that will run on their behalf.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✕                                                                 │
│   🎨  ui-designer                                                  │
│       community · daymade · v1.0.0 · ⬇ 1.8K · Apache-2.0           │
│                                                                    │
│   Extract a design system from reference UI images and produce      │
│   implementation-ready prompts.                                    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ ⓘ  This skill declares allowed-tools:                        │  │
│  │      Read   Bash(git:*)                                      │  │
│  │    Safe mode and denied commands still prompt, always.       │  │
│  │                                              [What's this?]  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│   Contents                          Source of SKILL.md              │
│   ├─ SKILL.md              4.2 KB   ┌────────────────────────────┐ │
│   ├─ references/                    │ # UI Designer              │ │
│   │  └─ REFERENCE.md      11 KB     │                            │ │
│   └─ assets/                        │ ## Overview                │ │
│      └─ template.json     1.1 KB    │ Systematic extraction of   │ │
│                                     │ design systems from ref-   │ │
│   Install to                        │ erence images through a    │ │
│   ( ) Global    ~/.agents/skills    │ multi-step workflow:       │ │
│   (•) Workspace main                │ analyze → document → PRD   │ │
│   ( ) Project   bitlab-agent        │ → implementation prompts.  │ │
│                                     │                            │ │
│   ⚠ A skill named ui-designer       │ ## When to Use             │ │
│     already exists in Workspace.    │ - User provides UI screen- │ │
│     Installing overwrites it.       │   shots or mockups         │ │
│                                     └────────────────────────────┘ │
│                                        [ Cancel ]  [ Install ]     │
└────────────────────────────────────────────────────────────────────┘
```

The `allowed-tools` panel states what the skill asks for. In P0/P1 the declaration is displayed and nothing is granted; from P2 it becomes a per-turn grant with Claude Code's semantics (§5.10). Either way the line about safe mode and denied commands holds.

### Conversational authoring

```
┌──────────────────────────────────────────────────────────────────┐
│  You  Every Friday I write a release note from the changelog.    │
│       Make that a skill.                                         │
│                                                                  │
│  ▸ Skill  create-skill                                           │
│                                                                  │
│  Bitlab  A few questions before I write it:                      │
│          1. Where does the changelog live?                       │
│          2. Should it read merged PRs too, or the file only?     │
│          3. Output as Markdown, or post it somewhere?            │
│                                                                  │
│  You  CHANGELOG.md at the repo root. File only. Markdown.        │
│                                                                  │
│  ▸ skill_write   release-notes → workspace                       │
│  ▸ skill_validate release-notes                       ✓ valid    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 📐 release-notes                          workspace · new  │  │
│  │ ---                                                        │  │
│  │ name: release-notes                                        │  │
│  │ description: Draft release notes from CHANGELOG.md. Use    │  │
│  │   when the user asks for release notes or a version        │  │
│  │   summary.                                                 │  │
│  │ metadata:                                                  │  │
│  │   bitlab.icon: "📐"                                        │  │
│  │ ---                                                        │  │
│  │ ## Steps                                                   │  │
│  │ 1. Read CHANGELOG.md at the repository root.               │  │
│  │ 2. Take entries under the topmost Unreleased heading.      │  │
│  │ …                                                          │  │
│  │                                                            │  │
│  │        [ Edit ]  [ Discard ]  [ Save to workspace ]        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

The draft renders inline and **saving is an explicit click**. The agent proposes; it never writes silently.

## 5. Technical design

### 5.1 Minimal module set

Three deep modules with small interfaces, replacing the current scatter of helpers:

| Module | Interface | Owns |
| --- | --- | --- |
| `SkillCatalog` | `snapshot(context) → CatalogSnapshot` | Discovery across tiers, spec validation, trust filtering, enablement, precedence, winner/shadow, diagnostics, revision id |
| `PiSkillBridge` | `apply(snapshot)` / `reload()` | Wiring the snapshot into Pi via public seams; explicit-invocation registration |
| `SkillInstaller` | `prepare(source) → InstallPlan` / `commit(plan, target)` | Isolated staging, safety checks, diff, preview, atomic write, provenance |

`CatalogSnapshot` carries every discovered skill — winners **and** shadowed entries — each with a stable `skillId`, its tier, enabled state, trust state, and validation diagnostics. The UI renders it directly; `PiSkillBridge` feeds the winner subset to Pi. One snapshot, both consumers, no drift.

### 5.2 Wiring the catalog into Pi

The original version of this section proposed `sessionOptions.skillPaths`. **That field does not exist.** The correct seams are on `DefaultResourceLoaderOptions`, which [`BitlabMcpResourceLoader`](../packages/pi-agent-server/src/mcp/resource-loader.ts) already delegates to:

| Seam | Signature | Use |
| --- | --- | --- |
| `noSkills` | `boolean` | Turn off Pi's own scan so `.pi/skills` cannot inject unreviewed skills and ordering stays ours |
| `skillsOverride` | `(base) => { skills, diagnostics }` | Supply the catalog's winner set verbatim — bypasses Pi's first-wins/name-collision rules entirely |
| `systemPromptOverride` | `(base) => string \| undefined` | Feed Bitlab's base prompt in as `customPrompt`, so Pi keeps appending the skill catalog |

```
  SkillCatalog.snapshot()          ← discovery + trust + enablement + precedence
            │
            ▼
  PiSkillBridge.apply(snapshot)
            │
            ├─ noSkills: true                    (Pi stops scanning on its own)
            ├─ skillsOverride: () => winners     (exact set, exact order)
            └─ systemPromptOverride: () => bitlabPrompt
            │
            ▼
  DefaultResourceLoader ─ getSkills() ─┐
                        ─ getSystemPrompt() ─┐
                                             ▼
  agent-session _rebuildSystemPrompt ── buildSystemPrompt({ customPrompt, skills })
                                             │
                                             └─ + formatSkillsForPrompt(skills)
```

`applySystemPromptOverride` is deleted. Its stated purpose — surviving `prompt()` resets and tool-change rebuilds — is served by `systemPromptOverride`, because the loader is consulted on every rebuild rather than stamped once.

**Precondition: the resource loader must exist unconditionally.** Today `sessionOptions.resourceLoader` is assigned only inside the `if (mcpEnabled)` branch ([`index.ts:894`](../packages/pi-agent-server/src/index.ts)); with MCP off, Pi constructs its own loader internally and **there is nowhere to attach any of the three seams**. Every wiring above is unreachable in that configuration.

P0 therefore starts by inverting that structure: the loader is always constructed and always passed, and `mcpEnabled` decides only whether the MCP adapter extensions are added to it. This also removes a second inconsistency — the `tools` allowlist is omitted only under MCP (§5.2 note below), so today the two configurations differ in both resource loading and tool activation.

**Verified against 0.80.6.** A probe exercising the exact wiring above passed 10/10 — see [§5.2.1](#521-probe-results). The `additionalSkillPaths`-in-reverse fallback is not needed.

Two further constraints found while reading the SDK:

- `buildSystemPrompt` appends the skills section only when the `read` tool is active (`customPromptHasRead`). Bitlab's allowlist includes `read`, and the MCP path omits the allowlist entirely, so both configurations qualify — but a future change to the tool set must not silently drop the catalog. Worth an assertion.
- `skillsOverride` receives Pi's `Skill` objects. The catalog must emit that shape, which means honoring Pi's identity rule (frontmatter `name`) even though Bitlab's UI keys on `skillId`. Mapping between the two belongs in the bridge, not the catalog.

If `skillsOverride` had proved too coupled to Pi internals, the fallback would have been `additionalSkillPaths` with the tiers passed in reverse order — Pi's first-wins then produces Bitlab's last-wins precedence. The probe makes this unnecessary; it is recorded only in case a future SDK bump changes the seam.

### 5.2.1 Probe results

Fixture: `alpha` in both the project and workspace tiers, `beta` in global, and a canary `leak` under `<cwd>/.pi/skills` that must never surface. The catalog is built Bitlab-side with `project > workspace > global`, then handed to a `DefaultResourceLoader` configured exactly as above, and the output is fed to `buildSystemPrompt` the way `_rebuildSystemPrompt` does.

| Assertion | Result |
| --- | --- |
| `noSkills: true` suppresses `<cwd>/.pi/skills` | PASS — `leak` absent |
| `skillsOverride` reaches `getSkills()` | PASS — full set, verbatim |
| **Bitlab's precedence survives** (project `alpha` wins) | PASS — Pi's first-wins does not apply |
| Shadowed entry retained catalog-side | PASS — Pi never needs to know |
| `systemPromptOverride` reaches `getSystemPrompt()` | PASS |
| Base prompt preserved in the assembled prompt | PASS |
| Catalog injected as `<available_skills>` | PASS |
| Winner's description is the project one | PASS |
| Shadowed description absent from the prompt | PASS |
| Catalog **dropped** when the `read` tool is absent | PASS — the gate is real |

Three findings worth carrying into implementation:

1. **Precedence is fully ours.** Because `skillsOverride` replaces the resolved set rather than contributing to it, Pi's first-wins collision rule never runs. The catalog decides, and shadows stay a Bitlab-side concept — Pi receives winners only.
2. **The `read` gate is not theoretical.** With `selectedTools: ['bash']` the entire `<available_skills>` block vanishes silently. Acceptance test 8 must be a real assertion, not a comment.
3. **`createSyntheticSourceInfo` is the supported way to mint `Skill` objects.** It is exported from the package, so `PiSkillBridge` does not need to fabricate `sourceInfo` by hand.

The assembled catalog looks like this — note that `<location>` is what makes progressive disclosure work: only names, descriptions, and paths are resident, and the model loads a body with `read` when it decides the description matches.

```xml
<available_skills>
  <skill>
    <name>alpha</name>
    <description>PROJECT tier alpha (must win)</description>
    <location>/…/proj/.agents/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta</name>
    <description>GLOBAL tier beta</description>
    <location>/…/global/skills/beta/SKILL.md</location>
  </skill>
</available_skills>
```

A second probe confirmed the §5.4 claim about `disable-model-invocation`: a skill carrying it stays **loaded** and is merely omitted from `formatSkillsForPrompt`. It is a visibility flag, not an off switch — which is why Bitlab's enable/disable has to act in the catalog, one layer above.

### 5.3 Stable identity

Every mutating or revealing operation takes a `skillId`, never a bare slug:

```
skillId := "<scope>:<canonical path to SKILL.md>"
           scope ∈ { global, workspace, project }
```

This distinguishes same-named skills across tiers, survives renames of the display `name`, and gives every filesystem operation an already-canonical path to validate. `skills.DELETE`, `OPEN_EDITOR`, and `OPEN_FINDER` all move to it.

Path containment is enforced at the boundary regardless: resolve the canonical path, assert it is under the tier root, refuse otherwise. Slug-derived paths get validated with the existing `validateSlug` before any `join`.

### 5.4 Enablement

Per-workspace, in `~/.bitlab/workspaces/<slug>/skills.json`:

```json
{
  "disabled": ["project:/repo/.agents/skills/deploy/SKILL.md"],
  "installed": {
    "workspace:/Users/me/.bitlab/workspaces/main/skills/release-notes/SKILL.md": {
      "source": "git:github.com/acme/skills@v1.2.0",
      "version": "1.2.0",
      "installedAt": "2026-08-14T02:11:00Z",
      "sha256": "9f2c…"
    }
  }
}
```

Keyed by `skillId`, so same-named skills in different tiers toggle independently. Note there is no `grants` map: `allowed-tools` is a per-turn grant re-derived from frontmatter on each invocation (§5.10), so it has no persistent state.

Concurrency matters here: two windows toggling different skills must not clobber each other's write. Read-modify-write with an atomic rename, or a version field with retry — either is fine, absence of one is not (acceptance test 13).

**Semantics: disabled means fully excluded from the runtime candidate set.** Not "hidden from auto-selection" — a disabled skill cannot be invoked explicitly either. This diverges from Pi's `disable-model-invocation`, which only suppresses model-side selection while leaving `/skill:name` live; conflating the two produces a toggle that visibly does nothing. When the winner of a name is disabled, the next tier down is promoted to winner, which is why precedence has to be computed after the enablement filter, not before.

Provenance lives only here — never written back into a third-party `SKILL.md`, which would invalidate the very hash used to verify it. Hand-authored skills have no `installed` entry; that is a valid state.

### 5.5 RPC surface

| Channel | Change |
| --- | --- |
| `skills.GET` | Returns the full `CatalogSnapshot` — winners, shadows, diagnostics, trust state, revision |
| `skills.DELETE` / `OPEN_EDITOR` / `OPEN_FINDER` | Take `skillId`; containment-checked |
| `skills.SET_ENABLED` | Toggle by `skillId` |
| `skills.SET_PROJECT_TRUST` | Grant/revoke trust for the session's project root |
| `skills.CREATE` | Validate, then write |
| `skills.PREVIEW` | `SkillInstaller.prepare` without commit; powers the drawer |
| `skills.IMPORT` | Folder / `.zip` / Git → prepare → preview → commit |
| `skills.MARKET_LIST` / `MARKET_INSTALL` / `UPDATE` | P3 |

### 5.6 Project trust

Pi's `SettingsManager` defaults to `projectTrusted=true` under programmatic use, and Bitlab has no trust flow — so once project paths are wired in, a cloned repository's `.agents/skills` would reach the runtime unreviewed. The [Agent Skills client implementation guide](https://agentskills.io/client-implementation/adding-skills-support) calls for gating project-tier skills; Pi has `project_trust` and Claude Code has a workspace-trust dialog.

Design: trust is per project root, persisted in workspace config, and **defaults to untrusted**. `SkillCatalog` filters project-tier skills out of the snapshot's winner set until granted, while still listing them as untrusted so the UI can show the banner in §4. Granting is explicit and reversible.

This ships in P0, not with the marketplace. The exposure exists the moment §5.2 lands. Headless and WebUI have no dialog to grant through — see §5.15.

### 5.7 Live reload

The current watcher gap is not just staleness — refreshing the UI without refreshing the runtime is worse than not refreshing at all, because the two then disagree.

```
file change (any tier)
      │
      ▼
SkillCatalog.snapshot()  → new revision id
      │
      ├──────────────► UI  (skills_changed event, carries revision)
      └──────────────► PiSkillBridge.reload() → loader reload → prompt rebuild
```

Both consumers move to the same revision or neither does. The 5-minute TTL stays as a backstop where filesystem watching is unavailable.

### 5.8 Frontmatter: adopt the spec, drop the dialect

```yaml
---
name: release-notes
description: Draft release notes from CHANGELOG.md. Use when the user asks for release notes.
license: Apache-2.0
compatibility: Requires git
metadata:
  bitlab.icon: "📐"
---
```

- `globs` and `alwaysAllow` are **deleted**, not migrated. They have no consumer; carrying them forward would be maintaining a dialect for nothing.
- `icon` moves to `metadata.bitlab.icon`. The reader keeps accepting top-level `icon` for one release since it has real users and the cost is a single fallback line; the writer emits the standard form only.
- `allowed-tools` is parsed and displayed; it grants nothing until P2, then follows Claude Code's per-turn semantics (§5.10).
- `name` must match the directory name per spec. The validator warns rather than fails, matching Pi's lenient posture.

### 5.9 Install transactions

Every acquisition path — folder, `.zip`, Git, marketplace, update — goes through one module, because they share every hazard:

```
prepare(source) → InstallPlan          commit(plan, target)
  ├ fetch into an isolated staging dir    ├ atomic move into the tier
  ├ reject path traversal (../, absolute) ├ record provenance in skills.json
  ├ reject symlinks escaping the root     ├ invalidate catalog → new revision
  ├ enforce file count / size / depth caps└ rollback on any failure
  ├ validate SKILL.md against the spec
  ├ diff against an existing install
  └ collect risk signals for the drawer
```

`sha256` from an index proves the bytes match the index, not that the source is trustworthy. Signature verification against a known public key is the only thing that proves provenance, and it is a P3 decision.

### 5.10 Tool permissions for skills

Bitlab's permission model has no per-skill dimension. It has three modes (`safe` / `ask` / `allow-all`, canonically `explore` / `ask` / `execute`) and a workspace-level `permissions.json` carrying `allowedBashPatterns` and `allowedWritePaths`. A skill cannot say "I need git" in any way the engine understands.

Saying `allowed-tools` grants nothing (§7.2) is the correct default for v1, but on its own it produces a bad outcome: a skill that runs ten git commands makes the user approve ten prompts, every time. That friction is what the field exists to remove.

**Related defect found while reviewing this.** `respondToPermission(requestId, allowed, _alwaysAllow)` ([`pi-agent.ts:1944`](../packages/shared/src/agent/pi-agent.ts)) ignores its third parameter — the underscore prefix is accurate. `PermissionManager` maintains `alwaysAllowedCommands` / `alwaysAllowedDomains` sets, but nothing on the Pi path ever calls the methods that populate them. "Always allow" is inert in the shipped backend, independently of Skills. It should be fixed on its own ticket.

#### How the competitors do it

**Claude Code** — the tool that defined this field:

- The grant covers **the turn that invokes the skill**, and **clears when the user sends the next message**. Invoking the skill again re-applies it.
- It **only widens, never narrows**. Every tool stays callable; tools not listed keep going through normal permission settings.
- It applies **whenever you or Claude invoke the skill** — model-initiated activation is not treated differently.
- Persistent pre-approval is explicitly *not* this field's job: "to pre-approve tools for the whole session, add allow rules to those permission settings instead."
- Deny rules still win — the sibling `disallowed-tools` field cannot remove `EndConversation` while any other tool remains.
- Workspace trust does **not** gate it, and the docs carry the matching warning: a repository-checked-in skill can grant itself broad access, so review before running.

**Codex** — two orthogonal axes plus a dedicated switch:

- `sandbox_mode` (`read-only` / `workspace-write` / `danger-full-access`) decides what is technically possible; `approval_policy` (`untrusted` / `on-request` / `never`) decides when to ask.
- The granular form exposes `skill_approval` and `request_permissions` as independent toggles, so an operator can disable skill-originated approvals wholesale without giving up the rest.

#### What Bitlab adopts

Claude Code's semantics verbatim, because Bitlab already uses the same skill format and diverging would surprise anyone carrying skills between the two:

| Rule | Source |
| --- | --- |
| Grant covers the invoking turn; clears on the user's next message | Claude Code |
| Widens only — unlisted tools keep their normal prompts | Claude Code |
| Applies to both user- and model-initiated invocation | Claude Code |
| Existing deny paths still win | Claude Code, and Bitlab's mode system already behaves this way |
| Persistent pre-approval belongs in `permissions.json`, not in a skill | Claude Code |
| `disallowed-tools` supported as the narrowing counterpart | Claude Code (not in the spec) |
| A global "skills may pre-approve tools" switch in permission settings | Codex `skill_approval` |

Two Bitlab-specific bindings, both of which follow from mechanisms that already exist rather than from anything invented here:

- **`safe` mode and `DANGEROUS_COMMANDS` still win.** These are Bitlab's deny path, and deny wins in Claude Code too. A skill declaring `Bash(rm:*)` gets the declaration displayed and the call prompted anyway.
- **Untrusted project skills never reach the runtime at all** (§5.6), so their `allowed-tools` cannot apply. This is stricter than Claude Code, which applies a project skill's grant even in an untrusted folder and warns the user instead. Bitlab's gate sits further upstream, so the warning is unnecessary — but the difference is deliberate and worth stating, because a user moving skills from Claude Code will notice it.

**Consequence for §5.4:** the grant is per-turn and re-derived from frontmatter on each invocation, so **there is nothing to persist**. No `grants` map, no consent sheet, no revocation UI. The whole feature is: parse `allowed-tools`, apply it for the turn, drop it on the next user message. This is considerably smaller than the flow drafted earlier and removes a stored-state design entirely.

The residual risk — a skill self-granting broad access — is handled the way both competitors handle it: show the declaration before install (§4), keep deny paths above it, and give the operator one switch to turn the whole mechanism off.

Deferred to P2. P0/P1 ship with declaration-and-display only.

### 5.11 Skills and MCP

Two directions, both currently undesigned.

**A skill that depends on an MCP server.** MCP configuration is workspace- or global-level ([`config/mcp.ts`](../packages/shared/src/config/mcp.ts), plus project `.mcp.json`); a skill has no way to express a dependency, so a skill built around a Playwright or database server fails confusingly when the server is absent.

Following Codex's `agents/openai.yaml` pattern but staying inside the standard's `metadata` map:

```yaml
metadata:
  bitlab.requiresMcp: "playwright, postgres"
```

Resolution happens in `SkillCatalog.snapshot()`, which already reads workspace config, and produces one of three states per skill: `satisfied`, `missing` (not configured), or `disabled` (configured but off). Behavior per state:

- Preview drawer and detail page list the requirement and its state, with a link to MCP settings. Installing with an unmet dependency is allowed but flagged — the skill may still be useful, and blocking would be paternalistic.
- At activation, an unmet dependency appends one line to the injected instructions: *"Required MCP server `playwright` is not available."* The model then degrades honestly instead of hallucinating tool calls.
- **Bitlab never auto-installs or auto-enables an MCP server on a skill's behalf.** That is a strictly larger trust decision than installing the skill, and it belongs to the user.

**A skill that uses MCP tools already present** needs nothing new — MCP tools are named `mcp__<server>__<tool>` and skill instructions can reference them like any other tool. One caveat worth recording: when MCP is enabled the `tools` allowlist is omitted entirely, so the active tool set differs between the two configurations. The catalog must not, which is acceptance test 3.

Name-collision surface: skill names live in `/skill:<name>`, MCP tools in `mcp__<server>__<tool>`. They do not currently collide. If MCP prompts are ever surfaced as slash commands, they will — worth a namespace decision before that lands.

### 5.12 Bundled scripts

The spec blesses `scripts/` and both Pi and Claude Code carry warnings that skills may ship executable code. Bitlab has no story for it, and three things break in practice:

- **Execution path.** A script runs through the `Bash` tool, so it is subject to the permission mode like any command — correct, and worth stating rather than leaving implied.
- **Write paths.** `allowedWritePaths` is workspace-scoped. A script writing next to itself (a cache, an intermediate file) sits under the skill directory, which is not necessarily writable. Global-tier skills under `~/.agents/skills` are outside the workspace entirely.
- **Interpreter assumptions.** `scripts/extract.py` presumes a Python that may not exist. This is what the standard's `compatibility` field is for; surfacing it in the preview drawer is nearly free and prevents a class of confusing failure.

Minimum viable position for P2: scripts are data, not privileged code. They execute only through the normal tool path, the preview drawer lists them explicitly with their sizes, and `compatibility` is displayed. Nothing auto-runs on install — an install-time hook would be the single most dangerous feature this document could propose.

### 5.13 Built-in skills

§4 shows a Built-in tab without defining it. Decisions needed:

| Question | Recommendation |
| --- | --- |
| Where do they live? | Shipped as app resources, alongside the document tools; not written into `~/.agents` |
| Can users disable them? | Yes — same `skills.json` mechanism, keyed by a reserved `builtin:` scope |
| Can a user skill shadow one? | Yes, and the Built-in row should say so, mirroring Claude Code's bundled-skill override |
| What happens on app update? | Replaced wholesale; user edits are not preserved, which is why they are not user-writable |
| Do they count toward the catalog cost? | Yes (§5.14) — a large built-in set is not free |

`create-skill` (§4) is itself a built-in, which makes this tab a P2 dependency rather than cosmetic.

### 5.14 Catalog cost and session drift

**Cost.** Progressive disclosure keeps bodies out of context, but the catalog itself is resident: every enabled skill contributes `name` + `description` to the system prompt on every request. Fifty skills at ~100 tokens is ~5K tokens standing. The recently added context meter already breaks out `systemTokens` ([`context-breakdown.ts`](../packages/pi-agent-server/src/context-breakdown.ts)), so the cost is measurable — it should also be *attributable*, so a user can see the catalog's share and act on it. This is the strongest practical argument for enable/disable being a real feature rather than a nicety.

**Drift.** Sessions outlive skills. A session that used `release-notes` can be resumed after the skill was edited, disabled, or deleted, and branching forks a Pi session file that was built against a different catalog. Position: **do not attempt retroactive consistency** — the transcript records what happened, and rewriting it would be worse. Instead, stamp the catalog revision into session metadata at each turn, so a diagnostic can say "this session ran against revision X, current is Y." Cheap to record, and the only thing that makes drift debuggable.

### 5.15 Trust without a UI

§5.6 defaults project-tier skills to untrusted and grants trust through a dialog. The headless server and WebUI have no such dialog, so as written, project skills would be permanently unavailable there — a regression dressed as a security feature.

Headless needs an explicit, non-interactive channel: a `BITLAB_TRUSTED_PROJECT_ROOTS` environment variable or a workspace-config list, requiring the operator to name roots up front. Default stays untrusted; absence of a UI must not silently become "trust everything", and equally must not become "nothing works".

## 6. Roadmap

| Phase | Scope | Depends on |
| --- | --- | --- |
| **P0 — Correctness** ✅ | Unconditional resource loader (§5.2 precondition); `SkillCatalog` as the single resolver; `PiSkillBridge` via public seams; delete `applySystemPromptOverride`; project trust gate incl. the headless channel; `skillId` + path containment; delete the dead `Skill` qualification path; drop `globs`/`alwaysAllow`; UI↔runtime consistency tests | none |
| **P1 — Management** ✅ | Installed tab grouped by tier with shadows; enable/disable with fallthrough; precise delete/open per `skillId`; full live reload (catalog revision → UI + session); catalog cost attributed in the context meter; MCP dependency resolution and display | P0 |
| **P2 — Authoring & import** ✅ | `create-skill` and the Built-in tab; `skill_write` session tool; `SkillInstaller` with folder / `.zip` / Git; preview drawer incl. scripts and `compatibility`; validator surfaced in the UI; `allowed-tools` / `disallowed-tools` with Claude Code semantics plus the `skill_approval` switch (§5.10) | P1 |
| **P3 — Marketplace** (not started) | Static registry, categories, install/update/uninstall, provenance, signature verification | P2 |
| **P4 — Bundles** (not started) | Expert-Kit equivalent: Skills + MCP servers + permission presets as one unit | P3, MCP config work |

P0 is a correctness release: it fixes a security bug, removes dead code, and makes the feature do what its own documentation claims. It is worth shipping whether or not the marketplace ever exists.

**Implementation notes.** Precedence resolves on the directory slug rather than the frontmatter `name` — the slug is what the user manipulates on disk and what `[skill:slug]` addresses, and the spec requires the two to match anyway; reconciling with Pi's name-based identity happens in the bridge, which also drops and reports two winners declaring the same name. `skill_write` was not built: `create-skill` proposes a file and the existing write tool saves it, already carrying the permission prompt, and a second way to write a file would be a second thing to keep honest. Archive extraction shells out to `unzip`, which covers macOS and Linux; the fetchers sit behind one interface so a Windows backend slots in without touching the validation pipeline.

### Acceptance tests

P0/P1 are not done until these pass:

1. Three tiers hold the same `name`; the project copy wins; the other two appear as shadows in the snapshot.
2. Disabling the winner promotes the workspace copy; disabling all three removes the name from the runtime entirely.
3. The catalog is byte-identical with MCP enabled and disabled (the loader path differs; the snapshot must not).
4. An untrusted project root contributes zero skills to the winner set, and its skills are still listed as untrusted.
5. After editing a `SKILL.md`, the UI and the live session report the same catalog revision.
6. A `.zip` containing `../../evil` or an escaping symlink is rejected at `prepare`, before anything is written.
7. A `skillId` whose canonical path escapes its tier root is refused by delete, open-editor, and open-finder.
8. With the `read` tool absent from the allowlist, the bridge fails loudly rather than silently shipping a promptless catalog.
9. With MCP disabled, the resource loader still exists and the three seams are still applied (the §5.2 precondition, and the reason test 3 can pass at all).
10. A skill declaring `allowed-tools: Bash(rm:*)` gets the declaration displayed and the call prompted anyway; in `safe` mode every grant is inert.
11. A grant applies for the invoking turn and is gone on the next user message; re-invoking re-applies it. Tools not listed keep prompting throughout.
12. A skill declaring an unconfigured MCP server installs, lists the dependency as missing, and appends the degradation notice at activation.
13. Two windows toggling different skills concurrently do not lose either write to `skills.json`.

## 6.1 Deferred, with reasons

Recorded so they are decisions rather than oversights:

- **Per-skill model selection.** A cheap skill could name a mini model. Attractive, but it collides with the session's model routing and connection resolution; not before P3.
- **`context: fork` / subagent execution.** Claude Code runs some skills in an isolated context. Bitlab has session spawning already, so the pieces exist, but the interaction with permissions and the context meter is a design of its own.
- **Multilingual descriptions.** `description` is read by both the model and the user, and the repo enforces i18n parity for UI strings. A skill authored in Chinese shows Chinese in an English UI. Out of scope, but it will surface the moment a marketplace serves two locales.
- **Telemetry on activation.** Knowing which skills actually fire would inform the whole roadmap, and it is exactly the kind of data collection that needs an explicit privacy decision first.

## 7. Security

### 7.1 Install-time

1. **Preview before write.** Full `SKILL.md` rendered, file tree listed. No silent installs, including agent-initiated ones.
2. **Provenance recorded and displayed.** Source, version, and `sha256` in `skills.json`. `local` is a first-class, unmarked state.
3. **Integrity on install and update.** Verify against the index; on update, show the `SKILL.md` diff first.
4. **No auto-update.** An auto-updating skill is a remote code execution channel with a nice icon.
5. **Staging is isolated and bounded.** Path traversal, escaping symlinks, and archive bombs are rejected before commit (§5.9).

### 7.2 `allowed-tools` grants nothing in v1

The field is experimental in the spec, support varies by client, and Pi 0.80.6 does not wire it into Bitlab's permission engine. Implementing it as a real grant would mean a file on disk could pre-approve `Bash(*)`.

v1 behavior: parse it, show it in the drawer and the detail page, and grant nothing — every tool call still goes through the normal permission prompt. §5.10 adopts Claude Code's semantics in P2: the grant covers the invoking turn, clears on the user's next message, widens only, and never overrides `safe` mode or `DANGEROUS_COMMANDS`. An operator switch, modeled on Codex's `skill_approval`, disables the mechanism entirely.

### 7.3 Project trust

Project-tier skills are untrusted until the user grants trust for that project root (§5.6), mirroring Pi's `project_trust` and Claude Code's workspace-trust dialog. Trust is per root, persisted, revocable, and defaults to off.

## 8. Open questions

1. **Does the workspace tier survive?** `{workspace}/skills/` is Bitlab-specific and invisible to every other tool. Standardizing on `.agents/skills/` everywhere is more portable but discards the workspace boundary [`CLAUDE.md`](../CLAUDE.md) treats as the long-term context boundary. Recommendation: keep it as a documented Bitlab extension.
2. **Registry governance.** Curated-only, or community submissions with review? A policy decision with ongoing cost; it gates P3 more than any technical question.
3. **Does `[skill:slug]` stay?** Once `/skill-name` is live there are two explicit-invocation syntaxes. Keeping both is confusing; removing the mention breaks muscle memory and existing session history.
4. **What does trust apply to?** Repository root, or the session working directory? They differ in monorepos, and Bitlab's project tier keys on the working directory today.
5. **Who owns orphan cleanup?** A user deleting a skill directory by hand leaves `disabled` / `installed` entries behind. Pruning during `snapshot()` is easy but silently discards state if a directory is temporarily unreadable.
6. **Where does the `skill_approval` switch live?** `permissions.json` is the natural home since it governs the permission engine, but that file is workspace-scoped while the switch arguably wants to be global.

## Sources

- [Agent Skills specification](https://agentskills.io/specification) · [overview](https://agentskills.io) · [client implementation guide](https://agentskills.io/client-implementation/adding-skills-support)
- [Pi skills documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [QwenWork skills](https://qwenwork.cn/docs/features/skills) · [Alibaba Cloud help](https://help.aliyun.com/zh/qwenwork/skills)
