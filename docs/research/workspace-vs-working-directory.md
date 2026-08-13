# Workspace / 工作目录心智模型对齐

> 调研日期：2026-08-12  
> 状态：已落地的产品与工程决策

这份文档记录 Bitlab 对齐 WorkBuddy / Codex 类产品后的最终模型：用户只选择一次“当前项目”，内部继续把项目目录和 Bitlab 数据目录分开。

## 结论

用户可见模型：

```text
Workspace（本地项目文件夹）
└── Session（一次任务）
    └── Agent cwd = Workspace.folderPath
```

内部存储模型：

```text
项目文件夹：用户选择，例如 ~/work/abc/
Bitlab 数据：~/.bitlab/workspaces/<slug>/
```

`~/.bitlab/workspaces/<slug>/` 保持不变，但它不再被当成用户的“项目工作目录”。它只存放会话、Workspace Skills、权限、主题和其他 Bitlab 状态。

## 为什么这样做

旧模型同时暴露 Workspace 和 Session working directory，用户需要回答两个相似的问题：

1. 当前在哪个 Workspace？
2. Agent 到底在哪个文件夹里工作？

对 coding agent 来说，这个拆分增加了决策税。WorkBuddy 的菜单和 Codex 的 Local Project 都把“打开项目”和“Agent 默认 cwd”合并成一次选择；无项目对话则显式作为一个选项。

因此 Bitlab 采用：

- Folder workspace = 用户选中的项目文件夹。
- Default workspace = “不使用工作空间”，没有用户项目目录。
- 新建 Session 自动继承 Workspace 的有效 cwd。
- 不再提供 Session 级 cwd 选择器或 Workspace 默认 cwd 设置。

## 数据模型

```ts
interface WorkspaceInfo {
  id: string
  name: string
  slug: string
  kind: 'default' | 'folder'
  folderPath: string | null
}

interface Workspace extends WorkspaceInfo {
  dataRoot: string
  createdAt: number
}
```

字段职责：

| 字段 | 含义 |
|---|---|
| `folderPath` | 用户项目文件夹；Default 为 `null` |
| `dataRoot` | `~/.bitlab/workspaces/<slug>/`，由 slug 派生，不写入全局配置 |
| `slug` | Workspace 数据目录的稳定身份 |
| `kind` | 区分项目 Workspace 和无项目 Default |

### slug 规则

1. 首次打开目录时使用目录 basename 的 URL-safe slug。
2. 同名目录发生冲突时，在 basename 后追加真实路径 SHA-256 前 8 位。
3. 同一个真实目录再次打开时复用已有 Workspace。
4. 删除 Workspace 只删除 `dataRoot`，不删除 `folderPath`。

示例：

```text
~/work/abc   → slug abc       → ~/.bitlab/workspaces/abc/
~/client/abc → slug abc-a1b2  → ~/.bitlab/workspaces/abc-a1b2/
```

## 默认 Workspace

Default 是稳定的内置条目：

```text
kind: default
slug: default
folderPath: null
dataRoot: ~/.bitlab/workspaces/default/
```

它对应 UI 中的“不使用工作空间”。Agent cwd 仍然是 `dataRoot`，避免把用户 Home 当成默认项目目录或可写范围。

## UI 规则

Workspace 菜单按下面顺序展示：

```text
已登记的项目 Workspace
────────────
新建工作空间
打开本地文件夹
────────────
不使用工作空间
```

当前选中项目后，聊天直接使用项目目录；用户不需要再点“在文件夹中工作”。项目创建流程如果目标目录不存在，会先创建目录，再注册 Workspace。

## 运行时边界

### 数据读写

- 会话、附件、Plans、Pi 恢复态：`dataRoot/sessions/<id>/`
- Workspace Skills：`dataRoot/skills/`
- Workspace 权限：`dataRoot/permissions/`
- Project Skills：`folderPath/.bitlab/skills/`
- Default 不扫描 `~/.agents/skills` 或用户 Home 下的项目 Skills。

### Session

Session 内部仍可携带 `workingDirectory`，但它只是由 Workspace 派生出来的运行时快照，不能通过 UI、RPC 或 Slash command 修改。这样 Agent、权限引擎和 project Skills 仍有明确的有效 cwd，同时用户不需要维护第二套路径状态。

### 权限

- Folder workspace 的相对路径以项目目录为基准。
- Default workspace 的相对路径以 `dataRoot` 为基准。
- 删除 Workspace 时只清理 Bitlab 数据目录。

## 非目标

- 不把用户项目代码复制到 `~/.bitlab/workspaces/`。
- 不把 `dataRoot` 持久化成可编辑字段。
- 不维护旧 `rootPath` / `defaults.workingDirectory` 配置格式。
- 不保留独立的“在文件夹中工作”一级控件。
- 不做远程 Workspace 联邦。

## 验收标准

1. 选择 `~/work/abc` 后，Workspace 的 `folderPath` 是该目录，`dataRoot` 是 `~/.bitlab/workspaces/abc/`。
2. 新 Session 的 Agent cwd 是 `folderPath`。
3. Default Workspace 的 `folderPath` 为 `null`，Agent cwd 是 `~/.bitlab/workspaces/default/`。
4. 两个 basename 都是 `abc` 的项目目录不会共享 `dataRoot`。
5. 删除 Workspace 后，项目目录仍存在，只有 `dataRoot` 被删除。
6. 全局配置中不存在 `dataRoot`，也不存在 Workspace 默认工作目录字段。

## 关联文档

- [workspaces.md](../workspaces.md)
- [skills.md](../skills.md)
- [permissions.md](../permissions.md)
- [sessions.md](../sessions.md)
