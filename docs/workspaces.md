# Workspaces

Bitlab 对用户只暴露一个“我现在在哪个项目里工作”的选择：Workspace 就是本地项目文件夹。

内部仍然把项目文件夹和 Bitlab 自己的数据分开：

```text
用户项目文件夹（代码、配置、项目 Skills）
└── 例如 ~/work/abc/

Bitlab 数据目录（会话、工作区 Skills、权限、主题）
└── ~/.bitlab/workspaces/abc/
```

## Workspace 类型

| 类型 | 用户可见含义 | `folderPath` | Agent cwd | 数据目录 |
|---|---|---|---|---|
| Folder workspace | 一个本地项目 | 项目绝对路径 | 项目文件夹 | `~/.bitlab/workspaces/<slug>/` |
| Default workspace | 不使用工作空间，适合纯问答 | `null` | `~/.bitlab/workspaces/default/` | 同上 |

默认 Workspace 不会把 `~` 当成项目目录，也不会把用户 Home 当成可写项目范围。这样“不开项目”仍然是明确且安全的模式。

## 持久化模型

全局 `~/.bitlab/config.json` 只登记用户选择过的项目路径和稳定 slug：

```jsonc
{
  "workspaces": [
    {
      "id": "workspace-id",
      "name": "abc",
      "slug": "abc",
      "kind": "folder",
      "folderPath": "~/work/abc",
      "createdAt": 1755000000000
    },
    {
      "id": "default",
      "name": "Default",
      "slug": "default",
      "kind": "default",
      "folderPath": null,
      "createdAt": 1755000000000
    }
  ],
  "activeWorkspaceId": "workspace-id"
}
```

`dataRoot` 不写入全局配置，而是由 slug 派生：

```text
dataRoot = ~/.bitlab/workspaces/<slug>/
```

同一项目文件夹再次打开会复用原 Workspace。不同目录即使同名，也会使用不同 slug，例如：

```text
~/work/abc       → ~/.bitlab/workspaces/abc/
~/client/abc     → ~/.bitlab/workspaces/abc-<path-hash>/
```

## 用户操作

- 新建 Workspace：选择一个项目文件夹；新建流程会创建缺失的文件夹。
- 打开本地文件夹：选择已有项目文件夹并注册为 Workspace。
- 切换 Workspace：切换后新会话自动使用该项目文件夹。
- 不使用工作空间：切换到内置 `default`，新会话使用 `~/.bitlab/workspaces/default/`。
- 删除 Workspace：只删除 `~/.bitlab/workspaces/<slug>/` 下的 Bitlab 数据，绝不删除用户项目文件夹。

Workspace 下方不再提供独立的“在文件夹中工作”选择器，也不再维护 Workspace 默认工作目录。会话里的 `workingDirectory` 仅是运行时 cwd 快照，由 Workspace 派生，不能被用户单独修改。

## 隔离边界

| 关注点 | 隔离位置 |
|---|---|
| Sessions | `~/.bitlab/workspaces/<slug>/sessions/<id>/` |
| Workspace Skills | `~/.bitlab/workspaces/<slug>/skills/` |
| Project Skills | `<folderPath>/.bitlab/skills/` |
| Permissions | `~/.bitlab/workspaces/<slug>/permissions/` |
| Views、主题、默认模型 | Workspace 数据目录中的配置 |

Project Skills 只在 Folder workspace 中扫描；Default workspace 没有项目目录，因此不会扫描用户 Home。

## CLI

CLI 与 Desktop 使用同一套注册表：

```bash
bitlab workspace create ~/work/abc
bitlab workspace create ~/work/abc "ABC Project"
```

`--workspace` 使用 Workspace id、slug 或名称选择已登记的 Workspace。CLI 不再把 `~/.bitlab/workspaces/` 下的内部数据目录当作用户项目目录。
