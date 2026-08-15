# Skills

一个 Skill 就是一个目录，内含 `SKILL.md`（YAML frontmatter + Markdown 说明），可选地在旁边放脚本、references 与 assets。Skills 遵循 [Agent Skills](https://agentskills.io) 格式，因此为 Bitlab 写的 Skill 同样能被 Codex、Claude Code 与 Pi 自带 CLI 加载。

本文描述**已上线行为**。与标准之间的差距，以及规划中的 Skills Hub，见 [skills-design.md](./skills-design.md)。

## 发现路径

三层，按 slug 合并，优先级 `global < workspace < project`：

```text
1. ~/.agents/skills/<slug>/SKILL.md                    (global)
2. ~/.bitlab/workspaces/<slug>/skills/<slug>/SKILL.md  (workspace)
3. <projectRoot>/.agents/skills/<slug>/SKILL.md        (project)
```

`projectRoot` 是会话的工作目录，不是仓库根目录——project 层的 Skill 跟着当前会话所在目录走。`~/.bitlab` 受 `BITLAB_CONFIG_DIR` 控制；`~/.agents` 恒定在 home 目录下，与其他 Agent Skills 工具共享。

同名 Skill 出现在多层时，优先级最高的胜出，其余被 shadow 而非删除；catalog 会保留被遮蔽的条目，供上层展示遮蔽关系。

结果按 `(workspaceRoot, projectRoot)` 缓存，TTL 为 5 分钟（[`storage.ts:172`](../../packages/shared/src/skills/storage.ts)）。改完 `SKILL.md` 最长可能要等 5 分钟才生效，除非有代码调用 `invalidateSkillsCache()`——切换工作目录会触发。

## `SKILL.md` 格式

```markdown
---
name: pptx-deck-authoring
description: 从研究笔记生成结构化的 PowerPoint 演示文稿。当用户需要幻灯片或演示稿时使用。
icon: "📊"
---

# PPTX Deck Authoring

先规划演示文稿结构，起草每页标题，然后跑 `pptx-tool` 落地。
```

| Frontmatter 键 | 必填 | Bitlab 当前行为 |
| --- | --- | --- |
| `name` | 是 | 显示名。缺少 `name` 或 `description` 会导致整个目录被静默跳过 |
| `description` | 是 | 显示在 picker 与 Skills 列表中 |
| `license` | 否 | 记录并展示 |
| `compatibility` | 否 | 环境前置条件。记录并展示 |
| `metadata` | 否 | 自由的字符串映射。Bitlab 读取 `bitlab.icon`（emoji 或 URL；URL 会被下载为 Skill 目录下的 `icon.<ext>`，内联 SVG 与相对路径会被拒绝）与 `bitlab.requiresMcp`（逗号分隔的 MCP server 名，按 workspace 配置解析） |
| `allowed-tools` | 否 | 为调用该 Skill 的那一轮预授权这些工具（见下） |
| `disallowed-tools` | 否 | Skill 声明自己不会使用的工具。在其所在轮次直接拒绝（见下） |
| `disable-model-invocation` | 否 | 从模型看到的目录中隐藏该 Skill，但仍可被显式调用 |

顶层 `icon` 字段仍作为兜底被读取，但要写就写 `metadata.bitlab.icon`。按规范 `name` 应与目录名一致；不一致时会带一条警告加载，而不是失败。

## 调用方式

Skill 既可以由模型自行选中，也可以由用户点名。

**模型选中。** 每个生效的 Skill 的 `name`、`description` 与位置都会列在 system prompt 的 `<available_skills>` 里。当描述与任务匹配时，模型才去读该 Skill 的 `SKILL.md`——在那之前正文不占任何上下文，这正是大目录仍然划算的原因。

**用户点名。** 在 prompt 里写 `[skill:slug]`（聊天框的 picker 会插入这个语法）会要求模型先读该 `SKILL.md`，读完之前工具调用被阻断。

目录是通过 Pi 的 resource loader 送进去的，而不是拼好一整段 prompt 字符串：`noSkills` 关掉 Pi 自己的扫描（否则它既扫不到 Bitlab 的任何一层，又会捡起未经审阅的 `<cwd>/.pi/skills`），`skillsOverride` 按 Bitlab 的优先级把胜出者原样交给它，`systemPromptOverride` 则把 Bitlab 的基础 prompt 喂进去，让 Pi 在每次重建时继续追加目录。

有一点值得知道：只有 `read` 工具处于激活状态时，Pi 才会追加 `<available_skills>`。Bitlab 在装配阶段就对此做断言，而不是发出一个模型根本看不见的目录。

## 操作

| 操作 | 入口 | RPC 通道 |
| --- | --- | --- |
| 列表 | Settings → Skills；聊天 Skills 面板 | `skills.GET` |
| 浏览 Skill 内文件 | Skill 详情页 | `skills.GET_FILES` |
| 删除 | Skills 列表行菜单 | `skills.DELETE` |
| 用编辑器打开 `SKILL.md` | Skills 列表行菜单 | `skills.OPEN_EDITOR` |
| 在 Finder/资源管理器中打开 | Skills 列表行菜单 | `skills.OPEN_FINDER` |
| 校验 | `skill_validate` 会话工具，跨三层解析 | — |

创建 Skill 需要自己建目录和 `SKILL.md`，或者让 agent 帮你写。

`skills.DELETE`、`skills.OPEN_EDITOR`、`skills.OPEN_FINDER` 目前仍只按 workspace 层解析裸 slug，因此在 UI 上操作 global 或 project 层的 Skill 会打错路径或毫无效果。

任何由 slug 或 Skill id 推导出的路径，在落到文件系统操作之前都会先规范化并校验是否位于所属层的根目录内，因此路径穿越和指向外部的符号链接都到不了层外的目录。

## 工具预授权

Skill 的 `allowed-tools` 只覆盖**调用它的那一轮**，用户发出下一条消息即失效；再次调用会重新生效。

它只放宽，不收紧。未列出的工具照常提示，且 Skill 里的任何声明都无法把"拒绝"变成"允许"：

- `safe` 模式直接阻断写操作，根本走不到提示判定，因此那里的授权无从放宽。
- 危险命令（`rm`、`sudo`、`curl` 等）无论被谁声明都照样提示。声明 `Bash(rm:*)` 的 Skill 只会在安装时把这条声明展示出来，调用时依然要确认。

模式沿用规范写法：`Read` 授予该工具；`Bash(git:*)` 授予一个命令族。前缀比对的是命令而非子串——`Bash(git:*)` 不会覆盖 `gitleaks`。只有 Bash 会比对参数；文件路径不是命令，所以 `Write(src:*)` 什么也不授予。

`disallowed-tools` 是它的对应物：Skill 声明自己不会使用的工具，在该轮次会被直接拒绝。它的判定位于所有放宽之上——包括该 Skill 自己的 `allowed-tools`，也包括 `allow-all` 模式——因此同时声明两者也无法绕过拒绝；`skillToolApproval` 开关同样关不掉它：那个开关管的是 Skill 能否放宽权限，而不是能否收紧自己。

持久化的预授权不归这个字段管，那是 `permissions.json` 的职责。把全局配置里的 `skillToolApproval` 设为 `false`，可以在不改动任何 Skill 的前提下让所有声明失效。

## 项目信任

project 层的 Skill 是随着代码检出一起进来的可执行指令，因此在项目根目录被信任之前，它们不会进入运行时。在那之前它们仍会被列出、标记为未信任、不产生任何作用——同名 slug 由 workspace 或 global 层的副本胜出。

信任按项目根目录记录，持久化在该 workspace 的 `skills.json` 中，且可撤销。在没有 UI 可供授予的场景——headless server 与 WebUI——由运维方在 `BITLAB_TRUSTED_PROJECT_ROOTS`（按平台分隔符分隔的路径列表）中显式列出根目录。任何情况下默认都是不信任。

## 已知限制

- 无安装与更新——生命周期操作只有手工创建和删除。
- 删除、用编辑器打开、在文件管理器中显示，三者都只对 workspace 层生效。
- 靠 5 分钟 TTL 而非文件监听感知改动。
- 跨层遮蔽已记录在 catalog 中，但尚未在 UI 上呈现。
