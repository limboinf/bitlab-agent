# Codex 布局重构 Phase 1 实施计划

> 范围：只重构 Bitlab 的应用壳层布局，保留现有 Craft 系视觉语言、主题、路由和业务能力。用户自行做最终视觉验收。

## 1. 目标

把默认桌面布局从：

```text
TopBar（含 Workspace）
└── 全局 Sidebar（220px） + Session/Skills/Settings Navigator（300px） + Chat
```

调整为：

```text
TopBar（应用级操作）
└── Unified Navigation（默认 280px） + Chat
```

Unified Navigation 的职责：

1. 顶部选择 Workspace。
2. 提供 New Session。
3. 根据当前路由展示 Sessions、Skills 或 Settings 的列表。
4. 底部固定 Skills 与 Settings 入口。
5. 保留 All Sessions、Flagged、Archived、搜索、新增 Skill 等现有能力。

## 2. 非目标

- 不修改主题、色彩、圆角、阴影、字体或消息渲染。
- 不实现 Review、Files、Artifacts 或右侧 Tool Panel。
- 不实现 per-session Terminal drawer。
- 不删除多内容 Panel 的状态模型；只让它退出默认布局路径。
- 不新增 Worktree、Cloud、Scheduled、Sites 或 Pull Requests 占位入口。

## 3. 组件边界

### 3.1 新增 `UnifiedNavigationPanel`

文件：`apps/electron/src/renderer/components/app-shell/UnifiedNavigationPanel.tsx`

只负责组合，不拥有业务数据：

- `WorkspaceSwitcher`
- New Session 按钮
- 当前区域 Header 与动作
- Sessions / Skills / Settings 主体内容 slot
- 底部 Skills / Settings 导航

### 3.2 收敛 `AppShell`

- 保留数据派生、导航回调、Session/Skill 操作与 resize 状态。
- 删除旧全局 Sidebar 的渲染和键盘 roving-focus 状态。
- `PanelStackContainer.sidebarWidth` 固定传 `0`。
- Unified Navigation 通过原 `navigatorSlot` 接入，复用现有 compact 转场。
- 只保留一个导航 resize handle 和一个持久化宽度。

### 3.3 收敛 `TopBar`

- 移除重复的 Workspace selector。
- 左侧保留 Sidebar toggle、App menu、Back/Forward。
- 右侧 Browser badges、Add panel、Help 保持不变。

### 3.4 持久化

- 新增 `navigationPanelWidth` localStorage key。
- 默认 280px，范围 248–400px。
- 不再读取或写入旧的 `sidebarWidth`、`sessionListWidth`；不做兼容迁移。

## 4. 响应式行为

- `>= 768px`：Unified Navigation + 内容区。
- `< 768px`：继续使用现有 compact 单面板 drill-in；Unified Navigation 占满可用宽度。
- Focus Mode：隐藏 Unified Navigation，只展示内容 panel。
- Toggle Sidebar：切换整个 Unified Navigation，不再出现“只隐藏半边导航”的状态。

## 5. 键盘与可达性

- `Cmd/Ctrl+B` 切换 Unified Navigation。
- `Cmd/Ctrl+1` 聚焦导航域首要操作，`Cmd/Ctrl+2` 聚焦当前列表，`Cmd/Ctrl+3` 聚焦 Chat；现有快捷键定义不改。
- SessionList 继续注册 `navigator` focus zone。
- Skills/Settings 底部入口使用真实 button，并提供 active、hover、focus-visible 状态。
- Workspace 与 New Session 保留现有 aria label 和快捷键提示。

## 6. 实施顺序

1. 新增纯布局 helper 与单元测试，固定宽度、可见性和 slot 决策。
2. 新增 `UnifiedNavigationPanel`。
3. 修改 `AppShell` 接入新组件，删除旧 Sidebar 与双 resize 状态。
4. 修改 `TopBar` 移除 Workspace。
5. 更新 localStorage key 和必要注释。
6. 运行 Electron typecheck、相关单测、i18n lint 与 `git diff --check`。
7. 独立阅读最终 diff，检查功能丢失、键盘回归、窄屏回归和用户已有改动覆盖风险。

## 7. 验收用例

### 桌面宽屏

- 默认只出现一列导航与 Chat。
- Workspace、New Session、搜索、筛选、Skills、Settings 都可达。
- 拖动导航右边界后，宽度刷新后仍保留。
- 隐藏导航后 Chat 占满；再次打开恢复原宽度。

### 768–978px 灰区

- 不再同时占用 220px + 300px。
- 单内容 panel 不应因为双导航而产生横向滚动。

### Compact

- 初始展示导航域。
- 选择 Session/Skill/Settings 后 drill-in 到详情。
- Header back action 可返回列表。

### 状态

- All Sessions、Flagged、Archived 的标题和列表匹配。
- Search 展开与关闭正常。
- Skill 可新增、选择、删除。
- Settings 子页可选择。
- 多 Panel、Browser badges 与 Focus Mode 未被破坏。

## 8. 完成标准

- TypeScript typecheck 通过。
- 新增布局单元测试通过。
- 相关现有测试通过。
- i18n 键值无需新增或新增后中英文完全一致。
- `git diff --check` 通过。
- 最终 diff 不覆盖任务开始前的用户改动。
