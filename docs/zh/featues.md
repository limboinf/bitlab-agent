# 功能矩阵

本文档记录 Bitlab 相对上游基线**刻意**划定的产品边界。与 Craft Agents 的技术侧对比(含安装包体积)见 [`comparison-with-craft.md`](./comparison-with-craft.md)。

## 保留能力

- Electron Desktop、WebUI、headless server、共享 renderer、WebSocket RPC
- Pi agent backend、API key 模型连接，以及 ChatGPT Plus / Claude Pro/Max 订阅
- 自定义 OpenAI-兼容与 Anthropic-兼容端点,以及 Ollama
- 本地多 workspace 与 `default` workspace
- 会话(create / continue / cancel / resume / search / rename / delete / flag / archive / unread / import-export / branch / multi-window)
- Skills、mini chat、plan、annotations、follow-up
- Browser 面板 + `web_search` + `web_fetch`
- 附件与文档工具
- 权限(safe / allow-all)、网络代理、主题、英文与简体中文
- 自动更新集成

## 删除能力

- Claude Agent SDK backend
- GitHub Copilot，以及两种保留 LLM 订阅之外的全部 OAuth
- 外部 messaging channel 与 worker
- 产品 Automations 与定时任务
- 会话 labels 与用户自定义 status
- Projects 与 Kanban
- Sources(API Source、MCP Source)与 MCP server
- Viewer app、公开分享、远程 workspace
- 图片生成(`gen_image`)

## 引用策略

保留模块沿用上游目录布局、公开命名、代码风格与测试。产品名是 Bitlab。运行时标识仍沿用现有谱系（`@bitlab/*`、`~/.bitlab`、`BITLAB_*`、`bitlab://`、`app.bitlab.desktop`）。参考仓库只读。

## 数据锚点

| 指标 | Bitlab | 备注 |
|---|---:|---|
| 已跟踪 TS/TSX 源码行数 | 190,558 | 排除 `node_modules`、`dist`、`release`、`.git` |
| 相对 Craft 审计过的源文件数 | 1,163 | 见 [`comparison-with-craft.md`](./comparison-with-craft.md#1-仓库与源码规模) |
| 同路径率 | 96 % | 归一化后逐字一致 59 % |
| 顶层 `dependencies` 数 | 55 | 删去 6 个 backend / OAuth / MCP / Copilot 相关包 |
| 许可证 | Apache-2.0 | `NOTICE` 包含归属说明 |

## 边界校验

自动化源码血缘审计已在 Bitlab 改名时移除。上表是针对固定 Craft 基线的
时点快照；要重新核对边界，请按 [`upstream-sync.md`](./upstream-sync.md)
的说明手工与基线 commit 做 diff。
