# Changelog

All notable changes to Bitlab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released section is extracted verbatim by the release workflow and becomes
the body of the matching GitHub Release, so write entries for users rather than
for reviewers.

## [Unreleased]

Add user-visible changes here before running `bun run release:prepare <version>`.

## [0.4.1] - 2026-08-19

### Fixed

- **A workspace with nothing in it opens a chat.** A workspace you had never
  written in — or one whose only empty chat was cleaned up when you navigated
  away — showed a second, thinner composer that was not the one you get from
  "New task", and coming back to it after switching workspaces could leave you
  on a greeting with no composer at all, or on "this session no longer exists"
  pointing at a chat that had already been tidied away. An empty task list now
  puts you straight into a real chat with the full composer, the same surface
  "New task" gives you, and a route left pointing at a chat that is gone falls
  back to a live one instead of an error.

### Changed

- **The folder row in "Add workspace" is the button.** Clicking anywhere on the
  row opens the folder picker, rather than only the small Browse control at its
  right edge.

## [0.4.0] - 2026-08-18

### Fixed

- **"New task" opens a new task.** Starting one could snap the panel back to
  the session you just left, because a sessions route without an explicit
  session resolves to the last one you had open — and the new session was not
  yet on that route while it was being created. New tasks now hold a route
  auto-selection refuses to touch until the real session takes over, so the
  chat you land in is the one you asked for, with the full composer.
- **The session list stops reordering itself on restart.** Closing the app
  flushed every session to disk and stamped each one as used right then, so an
  old branch could sit above the chat you were in the day before. Ordering now
  follows the last message in a session, and rewriting a session's file no
  longer counts as activity. Sessions written by earlier versions are ordered
  by when they were created rather than by that stale stamp.

### Changed

- **A quieter Skills page.** The Project filter is gone — the source of every
  skill is already on its card and searchable — along with the page's overflow
  menu and the panel-splitting control in the title bar, neither of which did
  anything a skill catalog needs. The detail dialog is wider, and the
  enable/disable toggle is the same switch used everywhere else in the app.
- **Connectors is reached from Extensions, not Settings.** The MCP settings
  page stays where deep links and existing shortcuts expect it, but no longer
  appears twice in the settings navigator and the app menu.
- **Less standing explanatory text.** The capability navigator's tip card and
  the footnote under the context meter's breakdown are gone; both restated what
  the surfaces above them already show.

## [0.3.0] - 2026-08-16

### Added

- **Skills, and the model can actually find them.** A skill packages
  instructions, scripts, and references into a capability the agent reaches for
  when the task fits — no longer only when you name it by hand. Skills resolve
  across four tiers (built-in, global `~/.agents/skills/`, workspace, and the
  working directory's `.agents/skills/`), with the highest tier winning and the
  ones it shadows shown rather than hidden. Skills in a working directory stay
  out of the agent's reach until you trust that directory; headless and WebUI
  grant the same trust through `BITLAB_TRUSTED_PROJECT_ROOTS`. The format is the
  open Agent Skills specification, so the same skill also loads in Codex and
  Claude Code.
- **A Skills library page.** Browse, search, and filter everything installed,
  see which tier each skill comes from and when it was last edited, toggle one
  on or off, and open a full detail view with its instructions, metadata, and
  dependencies. Disabling a skill that was winning promotes the next tier down.
- **Install a skill from a folder, a `.zip`, or a Git URL — after you have read
  it.** Picking a source stages it and stops. A preview shows the full
  `SKILL.md`, every file the install would write with scripts called out, the
  target tier, and whether an existing skill would be replaced, before there is
  an Install button. Nothing reaches disk until then. Sources that climb out of
  their destination, point elsewhere through a symlink, or expand without bound
  are refused while still in staging, and the reason is shown.
- **`create-skill`, built in.** Ask the agent to write a skill and it proposes
  the file for you to save. Built-in skills ship with the app, can be disabled
  like any other, and are shadowed by a skill of the same name you install
  yourself.
- **A skill can pre-approve the tools it needs.** `allowed-tools` grants those
  tools for the turn that invoked the skill and clears on your next message, so
  a skill that runs ten git commands stops asking ten times. It only ever
  widens: unlisted tools keep their normal prompts, safe mode still blocks
  writes, and dangerous commands still ask. `disallowed-tools` is the narrowing
  counterpart and outranks everything, including the skill's own grants. Set
  `skillToolApproval: false` to make every such declaration inert.
- **Skills can declare the MCP servers they need.** The detail view shows each
  dependency's resolved state, and using a skill whose server is missing or off
  tells the model so — it degrades honestly instead of inventing calls. An
  unmet dependency never blocks the skill.
- **The context meter attributes what the skill catalog costs.** The catalog is
  broken out beneath the system-prompt figure, so it is visible that fifty
  skills stand in every request.

### Changed

- **Skills and Connectors are now full pages, not list panels.** Both open as a
  browsable catalog in the main content area with their own search, filters, and
  card grid; the left navigation no longer carries a second list beside them.
  Managing an MCP server opens in a dialog instead of expanding a row in place.

### Removed

- **`globs` and `alwaysAllow` are no longer read from `SKILL.md`.** Nothing
  consumed `globs`, and `alwaysAllow` rendered a permission table for grants the
  engine never applied — use `allowed-tools` instead. A top-level `icon` still
  works for this release; move it to `metadata.bitlab.icon`.

## [0.2.2] - 2026-08-15

### Added

- **MCP servers run inside your sessions.** Configure Model Context Protocol
  servers per workspace over stdio, SSE, or streamable HTTP, and their tools and
  resources become available to the agent in every session. Remote servers that
  require OAuth are authorized through a loopback redirect flow and their tokens
  refresh on their own. Servers you have not trusted ask before a tool runs, and
  an unanswered request denies itself rather than hanging the turn.
- **A Connectors settings page.** Add, edit, enable, and authorize MCP servers,
  including transport, arguments, and environment variables, with a live probe
  showing whether each server actually connects and what it exposes. Configured
  servers also show up behind `@`-mentions and the `/mcp` command with their
  current status, and MCP tool calls render as their own activity blocks in the
  conversation.
- **A browser on the same machine skips the WebUI login.** Requests arriving
  from loopback are trusted by their TCP peer address, never by headers. This
  stays off when the server is bound to a non-loopback address, when it sits
  behind a reverse proxy, and whenever `BITLAB_WEBUI_REQUIRE_LOGIN` is set.

### Changed

- **A reorganized app shell.** Navigation gains an Extensions section grouping
  Skills and Connectors, the sidebar is now Tasks, and section titles carry
  counts. The session list keeps status in a fixed-width gutter showing one
  status at a time, moves the flag beside the title, and drops per-row
  separators at compact density. New sessions open on a leaner welcome screen.

### Fixed

- HTML previews no longer collapse into a single column — the overlay measures
  the width the content actually wants instead of shrinking to fit.

## [0.2.1] - 2026-08-13

### Added

- **A context meter next to the send button.** A ring shows how full the
  model's context window is at a glance, and opens a panel breaking the prompt
  down into system prompt, tool schemas, and conversation — so it is obvious
  when tools, rather than the conversation, are what fills the window. The
  headline figure is anchored to what the provider reported for the last
  response, so it stays honest; it reads as unknown right after a compaction
  until the next response, rather than showing a stale number. The breakdown is
  an estimate of composition and does not add up to the headline total.
- **A Plugins settings page for web search.** Choose which backend the agent's
  web search uses — automatic, DeepSeek, Tavily, Exa, or DuckDuckGo — and store
  the provider's API key encrypted, with an optional base URL and model. With
  no key set, searches fall back to DuckDuckGo.

### Changed

- **One model picker, and it remembers.** The model and connection pickers are
  now a single menu that selects a whole route — connection, model, and
  thinking level together, because a model id only means anything inside the
  connection that offers it. The route you pick becomes the default for the
  next session in that workspace. Switching mid-turn now applies to the next
  turn instead of splitting the one in flight, and a session that already
  contains images will not switch to a model that cannot accept them.

### Removed

- **The separate context-usage warning badge.** The percentage badge that
  appeared only near the compaction threshold is replaced by the always-visible
  context ring, which offers the same one-click compaction from its panel.

## [0.2.0] - 2026-08-13

### Removed

- **CLI bundle.** Use the desktop application or the headless server with its
  WebUI instead; the RPC contract the CLI spoke to is unchanged.

### Changed

- **Reasoning blocks open while the model is still thinking.** A reasoning step
  used to be a single scrolling line until it finished, with no way to read it.
  It now expands from the first token, rendering as formatted text that grows
  with the stream.
- **Answers stream where you read them.** After a turn ran tools, further text
  streamed as plain text inside the collapsed step list and jumped out only once
  finished. It now streams directly in the conversation, formatted as it
  arrives; only text that turns out to be a remark between tool calls settles
  back into a step.

### Fixed

- A turn card could crash with a React hook-order error when a turn rendered
  nothing and then received content.

## [0.1.0] - 2026-08-13

First public release. Bitlab is a local-first AI agent workspace available as a
desktop application, a browser WebUI served by a headless server, and a CLI.

### Added

- **Desktop application** for macOS (Apple Silicon and Intel), Windows x64, and
  Linux x64, with a built-in Browser pane and automatic updates where the
  platform build is signed.
- **Headless server** binaries for macOS, Windows, and Linux that serve the same
  WebUI and RPC contract as the desktop app, guarded by `BITLAB_SERVER_TOKEN`.
- **CLI bundle** for scripting and terminal workflows against a running server.
- **Local-first workspaces** — sessions, files, settings, and history stay under
  the local data directory; credentials go through the operating system
  credential manager.
- **Model connections** — ChatGPT Plus and Claude Pro/Max subscriptions, provider
  API keys, OpenAI-compatible and Anthropic-compatible endpoints, and local
  Ollama models, all routed through the Pi agent runtime.
- **Agent workflows** — session branching, plans, Skills, follow-ups, and
  multiple windows.
- **Built-in tools** — web browsing and fetching, attachments, Markdown and code
  rendering, and PDF/DOCX/XLSX/PPTX/image/iCal document tools.
- **Explicit permission modes** — Explore, Ask, and Execute, plus network proxy
  configuration.
- **Localization** for English and Simplified Chinese.

### Notes

- macOS and Windows builds are signed only when the corresponding release
  credentials are configured. Unsigned builds trigger Gatekeeper or SmartScreen
  warnings; see the release notes and `SIGNING_STATUS.txt` of each release for
  the resolved trust status.
- Bitlab derives from [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss)
  `v0.11.2` and continues with an independent history. See [NOTICE](./NOTICE)
  for attribution and [docs/comparison-with-craft.md](./docs/comparison-with-craft.md)
  for what differs.

[Unreleased]: https://github.com/limboinf/bitlab-agent/releases
[0.4.1]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.4.1
[0.4.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.4.0
[0.3.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.3.0
[0.2.2]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.2.2
[0.2.1]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.2.1
[0.2.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.2.0
[0.1.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.1.0
