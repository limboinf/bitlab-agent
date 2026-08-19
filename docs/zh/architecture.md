# 架构

Bitlab 是一个 Bun monorepo，三种客户端共用同一套经过鉴权的 WebSocket RPC 协议。唯一注册的 backend 是 `pi`。直接集成的是 `@earendil-works/pi-coding-agent`；`pi-agent-core` 与 `pi-ai` 是更底层的依赖，不是应用层会话 API。

## 分层拓扑

```text
+-----------------------------------------------------------+
| apps/electron                    apps/webui               |
|   Electron                         浏览器 adapter          |
|   (Browser 面板、自动更新、        (通过头部握手加载        |
|   更新、IPC)                       同一份 React)           |
|        \                                                  |
+---------|----------------------------------|--------------+
          v                                  v
   Browser adapter  ──>  preload Client API  ──> RPC client
                         (window.Bitlab)        (rpc-client.ts)
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
   packages/server (headless `BITLAB_SERVER_TOKEN` 服务)
          v                                       |
+-----------------------------------------------------------+
| packages/shared                                           |
|   config / credentials / prompts / Skills /               |
|   workspaces / views / theme / i18n / AgentEvent /         |
|   backend registry(仅 `pi`)                               |
+-----------------------------------------------------------+
          |
          v
+-----------------------------------------------------------+
| packages/pi-agent-server                                  |
|   Bun 子进程，stdio 上的 JSONL,与 Pi SDK 通信              |
+-----------------------------------------------------------+
          v
+-----------------------------------------------------------+
| packages/ui            packages/session-tools-core        |
|   React primitives、    LLM 驱动的会话工具                |
|   markdown/doc         (plan、skill、mermaid、             |
|   renderer、IPC、       convert、mini LLM、browser、        |
|   设置页                session info/list 等)             |
+-----------------------------------------------------------+
```

三种客户端操作同一份 workspace 与 JSONL 会话,不存在客户端特有的存储。

## Apps

- `apps/electron` 内嵌本地 server,通过 preload 暴露 Client API,负责窗口、Browser 面板、代理集成与自动更新。
- `apps/webui` 通过浏览器 adapter 加载同一份 React 应用。headless server 同时托管其静态资源与经过鉴权的附件端点。

## 共享 package

- `packages/server-core` 负责 transport、handler、`SessionManager` 与跨平台服务,内含子目录: `bootstrap/`、`domain/`、`handlers/`、`model-fetchers/`、`runtime/`、`services/`、`sessions/`、`transport/`、`utils/`、`webui/`。
- `packages/shared` 负责协议 DTO(`@bitlab/shared/protocol`)、配置、凭证、Skills、提示词、backend registry、workspace 存储与 Pi 客户端。
- `packages/pi-agent-server` 在独立 Bun 子进程(`packages/pi-agent-server/dist/index.js`)中调用 `@earendil-works/pi-coding-agent` 的 `createAgentSession(...)`,通过 JSONL 通信。开发与打包产物共用同一 SDK 边界;`bun run server:build:subprocess` 负责打包。
- `packages/ui` 与 `packages/session-tools-core` 提供共享渲染与会话级工具。Electron 与 WebUI 都复用它们,和平台无关。

## Backend registry

唯一注册的是 `pi` backend。自定义端点(`openai-completions`、`anthropic-messages`)和 Ollama 都是通过 Pi 执行的连接变体,不构成独立 backend。注册表在 `packages/server/src/index.ts` 与 `apps/electron/src/main` 中通过 `registerPiModelResolver(...)` 初始化。

## 鉴权握手

1. server 绑定 `BITLAB_RPC_HOST:BITLAB_RPC_PORT`(默认 `127.0.0.1:9100`)。
2. bearer token 从 `BITLAB_SERVER_TOKEN` 读取(Electron 启动时会自动生成;headless server 必须显式传入)。
3. token 兑换为短生命周期 JWT,后续每个 WebSocket 帧都使用(`@bitlab/server-core/webui`)。
4. WebUI 额外支持 `BITLAB_WEBUI_PASSWORD`(回退到 `BITLAB_SERVER_TOKEN`)和可选的 `BITLAB_TLS_CA` 用于 TLS pinning。
5. 握手时绑定 workspace id;后续 RPC 命令都作用域在该 workspace 内,只会看到它自己的会话、Skills、权限与 Views。

## 子进程边界

Pi 子进程与主进程隔离:

```text
主进程 (Bun)
  └─ spawns: bun packages/pi-agent-server/dist/index.js
              ↕ JSONL on stdio(每个 turn 事件一个 JSON 对象)
              Pi SDK ↔ provider (HTTPS)
```

取消、模型切换、thinking level 调整、权限响应、会话恢复全部走同一 JSONL 流。Pi 恢复文件保存在 `~/.bitlab/workspaces/<slug>/sessions/<id>/` 下。

## 打包面

- Desktop 应用:macOS arm64 / x64(DMG + ZIP)、Windows x64(NSIS)、Linux x64(AppImage)。构建入口 `bun run electron:dist[:dev][:mac|:win|:linux]`。
- Headless server:每个平台的编译 Bun archive;通过 `bun run scripts/build-server.ts` 构建。
- Pi 子进程:`bun run server:build:subprocess` 输出 `packages/pi-agent-server/dist/index.js`。

主仓库 `limboinf/bitlab-agent` 直接在 GitHub Releases 中发布 DMG/ZIP/NSIS/AppImage、headless-server archive、manifest、blockmap、checksum 和 release notes。`electron-updater` 读取公开 manifest，客户端不带任何 GitHub token。