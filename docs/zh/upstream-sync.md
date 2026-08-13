# 上游同步

Bitlab 的架构、UI 与运行时继承自 [Craft Agents OSS](https://github.com/craft-ai-agents/craft-agents-oss)。本文定义在 Lite 边界内吸收新 Craft 变更的工作流。

## 当前基线

| 项 | 值 |
|---|---|
| 仓库 | `craft-ai-agents/craft-agents-oss` |
| Tag | `v0.11.2` |
| Commit | `a60ebc1a5a7cb0a6af7a77d5eed0512c5fc07658` |

当上游发布值得评估的新 tag 时:

1. 记录新 tag 与 commit:`git -C ../craft-agents-oss rev-parse HEAD && git -C ../craft-agents-oss describe --tags --always`。
2. 把 commit 加到本文件的 "当前基线" 表中。
3. 用新 commit 重新跑下面的步骤。

Bitlab 工作期间,参考 checkout(`../craft-agents-oss`、`../echo`、`../xagent`)保持只读。

## 同步流程

```text
  ┌──────────────────────────────────────────────────────────────────┐
  │ 1. 锁基线                                                          │
  │    git -C ../craft-agents-oss checkout <commit>                  │
  │    git -C ../craft-agents-oss status --short   # 必须干净          │
  │                                                                  │
  │ 2. 与基线做 diff                                                   │
  │    git -C ../craft-agents-oss diff <old>..<new> --stat            │
  │       人工审阅;已不再提供自动化血缘审计                            │
  │                                                                  │
  │ 3. 逐文件接入上游变更                                              │
  │    每个改动 same-path 文件的 upstream commit:                     │
  │      classify:  STRICT_REUSE  |  LITE_SEAM  |  REMOVED_FEATURE    │
  │      STRICT_REUSE:   原样取文件,重做品牌替换                      │
  │      LITE_SEAM:      手工合并,保留 Bitlab 定制缝                  │
  │      REMOVED_FEATURE: 不要导入,在 seam 里写明原因                 │
  │                                                                  │
  │ 4. 评估仅上游存在的新功能                                          │
  │      适配 Bitlab 范围 → bitlab migration-review issue           │
  │      不在范围       → 保持 Bitlab Lite                            │
  │                                                                  │
  │ 5. 校验                                                            │
  │    bun run typecheck:all                                          │
  │    bun run lint                                                   │
  │    bun run validate:ci                                            │
  │    bun run test                                                    │
  │    bun run electron:build                                         │
  │    bun run webui:build                                            │
  │    bun run server:build:subprocess                                │
  │                                                                  │
  │ 6. 对全新 config dir 做 GUI smoke                                  │
  │    rm -rf /tmp/bitlab-smoke && BITLAB_CONFIG_DIR=/tmp/bitlab-smoke \│
  │       bun run electron:dist:dev:mac                              │
  │    + headless smoke: bun run server:dev:webui                     │
  └──────────────────────────────────────────────────────────────────┘
```

## 文件 seam 分类

| 类别 | 规则 | 校验方式 |
|---|---|---|
| `STRICT_REUSE` | 同相对路径,只有机械差异(scope、URL 协议、配置根、品牌字符串) | 套用下方品牌替换后人工 diff |
| `LITE_SEAM` | 同相对路径,但已删除对应排除功能的分支,或接到 Bitlab 专用接口 | 人工语义审 + 定向 unit/integration 测试 + typecheck |
| `REMOVED_FEATURE` | 因对应的产品能力已删除,整个文件从 Bitlab 中移除 | 路径、call site 与 build closure |

接入上游独有功能时,先过一遍 Lite 问题;只挑选适配 Lite 边界的功能。

## 导入文件时需套用的品牌替换

Bitlab 已不再提供自动化的源码血缘审计（哈希清单与 `audit:craft-reuse`、
`lint:craft-*` 脚本在 Bitlab 改名时一并移除）。保留下来的是 `bun run audit:brand`，
它完全不与上游做对比：只要下表中的任一字符串残留在 `apps/`、`packages/`、`scripts/`
或 `.github/` 里，CI 就会失败。署名归属属于 `NOTICE`、`LICENSE` 和 `docs/`，这些目录
不在扫描范围内。确实需要保留品牌字符串的行（比如断言其不存在的测试），在行尾加
`bitlab-brand-audit-ignore` 注释豁免。

从 Craft 导入文件时，先手工套用以下替换再做 diff：

| 上游 | Bitlab |
|---|---|
| `@craft-agent/` | `@bitlab/` |
| `craftagents://` | `bitlab://` |
| `.craft-agent` | `.bitlab` |
| `CRAFT_AGENT_` | `BITLAB_` |
| `Craft Agents Backend` | `Pi Backend` |

## 不允许同步的内容

- Claude Agent SDK backend 与 `claude-agent-sdk*` 包；保留的 Claude OAuth 必须继续通过 Pi
- GitHub Copilot、通用 / Sources OAuth 及其 SDK
- 外部 messaging gateway 与 worker
- Sources、MCP server、bridge MCP server、相关 UI
- 图片生成模型与 `gen_image`
- 公开分享、Viewer app
- 产品 Automations 与 scheduler UI
- Sources API / Settings UI、会话 labels、用户自定义 status
- WhatsApp worker

以上都登记在 Lite 边界删除项中,详见 [`comparison-with-craft.md`](./comparison-with-craft.md)。

## 故障排查

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 同步后 `apps/electron/src/main` 单独报类型错 | 上游引入了新的环境变量或平台辅助 | 确认它能跨过 Lite seam,在提交前记录在文档中 |
| 打包后 renderer asset 404 | 新增上游 asset 但没更新 `scripts/copy-assets.ts` | 把 asset 加到 copy list 并重新构建 |
| `electron:build` 成功,但 `Bitlab Helper` 缺少某个 plugin | 确认 `appId` 是 `app.bitlab.desktop` 且 `extraResources` 只用 `@bitlab/*` 域 | 检查 `apps/electron/electron-builder.yml` |
