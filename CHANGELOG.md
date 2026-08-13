# Changelog

All notable changes to Bitlab are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each released section is extracted verbatim by the release workflow and becomes
the body of the matching GitHub Release, so write entries for users rather than
for reviewers.

## [Unreleased]

Add user-visible changes here before running `bun run release:prepare <version>`.

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
[0.2.1]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.2.1
[0.2.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.2.0
[0.1.0]: https://github.com/limboinf/bitlab-agent/releases/tag/v0.1.0
