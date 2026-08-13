# Architecture

Bitlab is a Bun monorepo with three clients sharing one authenticated WebSocket RPC protocol. Only the `pi` agent backend is registered. The direct Pi integration is `@earendil-works/pi-coding-agent`; `pi-agent-core` and `pi-ai` are lower-level dependencies, not the application-facing session API.

## Layered topology

```text
+-----------------------------------------------------------+
| apps/electron                    apps/webui               |
|   Electron                         Browser adapter        |
|   (Browser pane, auto-update,      (loads the same React  |
|   update, IPC)                     app via header         |
|        \                            handshake)            |
+---------|----------------------------------|--------------+
          v                                  v
   Browser adapter  ──>  preload Client API  ──> RPC client
                          (window.Bitlab)         (rpc-client.ts)
                                                       |
                                                WebSocket (wss://)
                                                       v
+-----------------------------------------------------------+
| packages/server-core                                      |
|   transport (WS server + JWT) / SessionManager /           |
|   handlers / services / webui (HTTP+sessions) /            |
|   model-fetchers / sessions                               |
+---------|---------------------------------------|
          v                                       |
   packages/server (headless `BITLAB_SERVER_TOKEN` server)
          v                                       |
+-----------------------------------------------------------+
| packages/shared                                           |
|   config / credentials / prompts / Skills /               |
|   workspaces / views / theme / i18n / AgentEvent /         |
|   backend registry (only `pi`)                            |
+-----------------------------------------------------------+
          |
          v
+-----------------------------------------------------------+
| packages/pi-agent-server                                  |
|   Bun subprocess, JSONL on stdio, talks to Pi SDK         |
+-----------------------------------------------------------+
          v
+-----------------------------------------------------------+
| packages/ui            packages/session-tools-core        |
|   React primitives,    LLM-backed session tools            |
|   markdown/doc         (plan, skill, mermaid,             |
|   renderers, IPC,      convert, mini LLM, browser,         |
|   settings pages       session info/list, etc.)           |
+-----------------------------------------------------------+
```

All three clients operate the same workspace and JSONL sessions; there is no client-specific storage.

## Apps

- `apps/electron` embeds the local server, exposes the Client API through preload, and owns windows, Browser panes, proxy integration, and auto-update.
- `apps/webui` loads the same React application through a browser adapter. The headless server serves its static files and the authenticated attachment endpoint.

## Shared packages

- `packages/server-core` owns transport, handlers, `SessionManager`, and platform-neutral services. Subpackages: `bootstrap/`, `domain/`, `handlers/`, `model-fetchers/`, `runtime/`, `services/`, `sessions/`, `transport/`, `utils/`, `webui/`.
- `packages/shared` owns protocol DTOs (`@bitlab/shared/protocol`), config, credentials, Skills, prompts, the backend registry, workspace storage, and the Pi client.
- `packages/pi-agent-server` runs `createAgentSession(...)` from `@earendil-works/pi-coding-agent` in a separate Bun subprocess (`packages/pi-agent-server/dist/index.js`) and communicates through JSONL. The same SDK boundary is used in development and packaged builds; `bun run server:build:subprocess` produces the bundle.
- `packages/ui` and `packages/session-tools-core` provide shared rendering and session-level tools. They are platform-neutral: Electron and WebUI reuse them.

## Backend registry

Only the `pi` backend is registered. Custom endpoints (`openai-completions`, `anthropic-messages`) and Ollama are connection variants executed through Pi rather than separate backends. The registry is initialized by `registerPiModelResolver(...)` inside `packages/server/src/index.ts` and `apps/electron/src/main`.

## Auth handshake

1. The server binds on `BITLAB_RPC_HOST:BITLAB_RPC_PORT` (default `127.0.0.1:9100`).
2. The bearer token is read from `BITLAB_SERVER_TOKEN` (Electron generates one automatically on launch; the headless server requires it to be passed in).
3. The token is exchanged for a short-lived JWT used on every subsequent WebSocket frame (`@bitlab/server-core/webui`).
4. WebUI additionally supports `BITLAB_WEBUI_PASSWORD` (falls back to `BITLAB_SERVER_TOKEN`) and an optional `BITLAB_TLS_CA` for TLS pinning.
5. The handshake binds a workspace id; later RPC commands are scoped to that workspace and only see its sessions, Skills, permissions, and Views.

## Subprocess boundary

The Pi subprocess is isolated from the main process:

```text
main process (Bun)
  └─ spawns: bun packages/pi-agent-server/dist/index.js
              ↕ JSONL on stdio (one JSON object per turn event)
              Pi SDK ↔ provider (HTTPS)
```

Abort, model switching, thinking-level change, permission responses, and session resume are all routed through the same JSONL stream. Pi recovery files are stored under `~/.bitlab/workspaces/<slug>/sessions/<id>/`.

## Packaging surface

- Desktop app: macOS arm64 / x64 (DMG + ZIP), Windows x64 (NSIS), Linux x64 (AppImage). Build entry: `bun run electron:dist[:dev][:mac|:win|:linux]`.
- Headless server: per-platform compiled Bun archive; build with `bun run scripts/build-server.ts`.
- Pi subprocess: `bun run server:build:subprocess` produces `packages/pi-agent-server/dist/index.js`.

The main `limboinf/bitlab-agent` repository publishes DMG/ZIP/NSIS/AppImage assets, headless-server archives, manifests, blockmaps, checksums, and release notes in GitHub Releases. `electron-updater` reads the public manifests and never embeds a GitHub token in the client.

## What is intentionally absent

Craft Agents bundles broad OAuth and Sources integrations, a Slack/Teams/Lark messaging gateway, a WhatsApp worker backed by Baileys, a session MCP server, a bridge MCP server, and an `apps/viewer` Electron app for public sharing. Bitlab retains only the ChatGPT and Claude LLM OAuth flows from that surface; the other components remain absent. Although Craft's underlying `pi-ai` dependency contains an OpenRouter image-generation API, neither Craft nor Bitlab registers it as an agent tool. See [`comparison-with-craft.md`](./comparison-with-craft.md) for an evidence-backed side-by-side and the resulting installer-size delta.
