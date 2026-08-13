# 数据目录

默认根目录是 `~/.bitlab`(首次启动时由 `$HOME` 或 `%USERPROFILE%` 解析)。通过 `BITLAB_CONFIG_DIR` 可以隔离测试、运行多实例或备份到自定义位置。Bitlab 不会读取或迁移任何其他产品的数据。

## 布局

```text
~/.bitlab/
  config.json                       # 全局偏好(主题、语言、Browser 工具、...)
  credentials/                      # 凭证存储(由 OS keychain 加密)
  permissions/                      # 全局权限策略
  themes/                           # 主题预设(自带约 15 套)
  tool-icons/                       # 已知工具的图标
  logs/                             # 滚动 server 日志(`bitlab-server-*.log`)
  updates/                          # `electron-updater` 下载暂存目录
  skills/                           # 全局 Skills(优先级 global < workspace < project)
  workspaces/
    default/
      config.json                   # workspace 设置(默认 mode、thinking level、...)
      skills/                       # workspace 级 Skills
      permissions/                  # workspace 权限覆盖
      views.json                    # 内置 View 定义
      sessions/                     # 每个会话一个目录
        <session-id>/
          session.jsonl
          .pi-sessions/
          attachments/
```

## 哪些内容会被加密

| 字段 | 位置 | 加密方式 |
|---|---|---|
| API key 与 LLM OAuth token | `credentials/` | 由 OS keychain(`CredentialManager`) |
| 代理凭证 | 设置页 | OS keychain |
| workspace 设置 | `workspaces/<slug>/config.json` | 明文,但凭证字段是引用而不是内嵌 |
| 会话 JSONL | `workspaces/<slug>/sessions/<id>/session.jsonl` | 明文,但凭证形字段在写入前已脱敏 |
| 会话导出包 | 下载路径 | 凭证字段已被剔除 |

## 哪些**不**加密

- 主题与主题 token。
- Tool icons 与 `resources/` 资源。
- Skill Markdown 及其 YAML frontmatter。
- 不含凭证形字段的崩溃与请求日志(`main` 与 network interceptor 在写入前已脱敏)。

## 备份

请在应用停止**之后**或会话落盘之后再备份。开发期无需特殊 flush;生产用户应该先退出 Bitlab,然后 `cp -R ~/.bitlab <backup>` 再重启。

## 平台路径

- macOS:`~/` 展开为 `/Users/<you>`,目录是隐藏的。
- Linux:`~/.bitlab`;若设置了 `$XDG_DATA_HOME`,renderer 仍走 `~/.bitlab` 保持向后兼容(此变化记录在 `migration/migration-features.md`)。
- Windows:`%USERPROFILE%\.bitlab`(即 `C:\Users\<you>\.bitlab`)。

## 配置损坏时的恢复

首次启动若 `~/.bitlab/config.json` 不可读,会把文件备份成 `config.json.broken-<timestamp>` 并回退到 `apps/electron/resources/config-defaults.json`。每个 workspace 的 `config.json` 同理:workspace 不会加载,而是用默认配置重建。
