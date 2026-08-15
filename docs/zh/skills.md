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

同名 Skill 出现在多层时，优先级最高的胜出，其余被 shadow 而非删除。Bitlab 目前不会对这种遮蔽给出提示。

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
| `icon` | 否 | 只接受 emoji 或 URL。URL 会被下载为 Skill 目录下的 `icon.<ext>`。内联 SVG 与相对路径会被拒绝 |
| `globs` | 否 | 会被解析和存储，但 Pi 后端**不消费** |
| `alwaysAllow` | 否 | 会被解析和存储，但**不消费**——不影响权限引擎 |

标准中的 `license`、`compatibility`、`metadata`、`allowed-tools` 字段能被 YAML 解析器读入，但目前被忽略。按规范 `name` 应与目录名一致，Bitlab 既不强制也不告警。

## 调用方式

Skills 只能显式调用，模型不会自行发现。

1. 用户在 prompt 里用 `[skill:slug]` 引用 Skill——聊天框的 picker 会插入这个语法。
2. system prompt 要求模型先读该 Skill 的 `SKILL.md`，读完之前工具调用会被阻断。
3. 模型按文件里的指令执行。

**用户没点名的 Skill 对模型不可见。** 两个彼此独立的原因，都在 Pi 后端：

- [`system-prompt-override.ts`](../../packages/pi-agent-server/src/system-prompt-override.ts) 把会话的 `_rebuildSystemPrompt` 替换成一个常量，丢弃了 Pi 在那里组装好的 Skill 目录。
- Pi 0.80.6 默认只扫描 `<agentDir>/skills` 与 `<cwd>/.pi/skills`。Bitlab 三层用的是 `.agents/skills` 与 workspace 目录，一条都不在扫描范围内——而且 `agentDir` 指向的是会话临时目录。

因此 Pi 原生的自动发现、渐进披露与 `/skill:name` 命令全部未启用。改变这一点的计划见 [skills-design.md](./skills-design.md)。

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

`skills.DELETE`、`skills.OPEN_EDITOR`、`skills.OPEN_FINDER` 都只按 workspace 层解析裸 slug，因此在 UI 上操作 global 或 project 层的 Skill 会打错路径或毫无效果。

`deleteSkill` 把 slug 直接拼到技能目录上再递归删除，**既无路径 containment 校验，RPC 层也不做 slug 校验**。

## 已知限制

- 无自动发现：用户不点名，模型就选不到。
- 无安装、更新、启用/禁用——生命周期操作只有删除一个。
- 删除、用编辑器打开、在文件管理器中显示，三者都只对 workspace 层生效。
- 删除对传入的 slug 不做任何路径 containment 校验。
- project 层 Skill 不受任何仓库信任决策的门控。
- 靠 5 分钟 TTL 而非文件监听感知改动。
- `globs` 与 `alwaysAllow` 是惰性字段，不起作用。
- 跨层遮蔽在 UI 上没有任何提示。
