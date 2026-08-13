# Codex / ChatGPT Desktop UI 布局调研

> 调研日期：2026-08-12  
> 目的：为 Bitlab 桌面端布局重构提供信息架构与交互依据，不作为像素级复刻规范。

## 1. 结论先行

Codex 当前最值得 Bitlab 借鉴的不是某个圆角、列宽或颜色，而是四层边界：

1. **全局能力导航**：新建会话、定时任务、Plugins、Sites、Pull requests 等跨项目入口。
2. **项目与会话导航**：Project 承载共享上下文，Chat 承载一个明确成果。
3. **Chat 主画布**：消息、过程、结果和 composer 是默认焦点。
4. **按需工具面板**：Review/Diff、Terminal、Browser、Artifacts 等在需要验证或交付时展开，不与对话永久争夺空间。

对 Bitlab 的直接建议是：**保留“导航 + 会话主画布”的稳定骨架，把 Review、Terminal、Browser、文件/任务详情统一成按需出现的工具区；不要继续把所有能力都塞进常驻三栏。**

## 2. 证据范围与置信度

本文严格区分三类内容：

- **官方事实**：OpenAI 官方文档、官方更新日志或官方产品文章明确描述的结构与行为。
- **官方截图观察**：从 OpenAI 官方截图中可见，但官方没有给出完整规格的视觉与状态表现。
- **设计推断**：基于官方事实、截图与 Bitlab 当前边界给出的重构建议，不代表 OpenAI 官方设计规范。

### 2.1 本机观察限制

本机存在正在运行的 Codex / ChatGPT Desktop 进程（bundle id 为 `com.openai.codex`），但当前自动化环境出于安全限制禁止读取该应用窗口。因此本文没有把“本机实测像素值、完整 hover 状态、窄屏折叠动画”伪装成现场事实。官方公开资料也没有公布完整设计 token、精确列宽或断点。

## 3. 当前产品定位与信息架构

### 3.1 从“编码聊天”变为桌面工作台

**官方事实**：ChatGPT Desktop 被定位为复杂工作的 command center，可并行处理项目、文件、桌面工具和长期任务。用户可以直接开始普通 Chat、创建 Project，或打开本机文件夹。Projects、长期任务、Worktrees 和 Review 的官方文档共同表明，它围绕多项目、多任务与验证闭环组织工作，而不是传统 IDE 的“文件树优先”。

这意味着首页与全局导航的第一问题不是“文件在哪”，而是：

- 我正在推进哪些工作？
- 哪些工作需要我关注？
- 每项工作属于什么项目或上下文？
- 我如何继续、验证或交付？

来源：[Desktop App 总览](https://learn.chatgpt.com/docs/app)、[Projects and chats](https://learn.chatgpt.com/docs/projects)、[Long-running work](https://learn.chatgpt.com/docs/long-running-work)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Code review](https://learn.chatgpt.com/docs/code-review?surface=app)

### 3.2 左侧全局导航

**官方页面示意图观察**：当前 Features 页的侧栏示意图包含：

- New chat
- Scheduled
- Plugins
- Sites
- Pull requests
- Pinned
- Projects
- Chats

Add 菜单示例还包括 Files and folders、Attach Google Chrome、Goal、Plan mode。这里混合了三类对象：

- **动作**：New chat、Add；
- **跨项目工作队列**：Scheduled、Pull requests；
- **资源与容器**：Plugins、Sites、Projects、Chats。

**设计推断**：Codex 没有强迫所有入口属于同一种导航对象，而是优先让高频工作可达。Bitlab 可以借鉴这种务实分组，但应按自己实际能力裁剪，不要为了“像 Codex”加入 Scheduled、Sites 或 Pull requests 的空入口。

来源：[Features](https://learn.chatgpt.com/docs/features)

### 3.3 Project → Chat 是主组织模型

**官方事实**：Projects 视图同时管理 ChatGPT Projects 与绑定本机文件夹的 Local Projects。Project 保存跨会话共享的文件、说明和上下文；官方建议每个 distinct outcome 单独建立 Chat。Project 与 Chat 均可 pin，Chat 还可 rename、search、archive。

因此层级不是“Workspace 下不断堆历史消息”，而是：

```text
Project（长期上下文边界）
└── Chat（一次明确成果或任务边界）
    ├── Transcript / progress
    ├── Outputs / sources
    └── Execution context
```

**设计推断**：Bitlab 现有 Workspace 与 Session 可以分别对应 Project 与 Chat，但命名是否调整是产品决策，不应为了抄术语而迁移数据模型。真正重要的是：Workspace 负责共享上下文，Session 负责一个结果，列表不应同时承担文件树、能力市场和设置导航。

来源：[Projects and chats](https://learn.chatgpt.com/docs/projects)

## 4. 界面区域拆解

### 4.1 推荐理解模型

官方没有公开一张完整、当前版本的结构图。综合官方文档与截图，最稳妥的布局理解如下：

```text
┌──────────────┬──────────────────────────────┬──────────────────────┐
│ 全局/项目导航 │ Chat 主画布                  │ 按需右侧工具面板       │
│              │                              │ Review / Files /      │
│ New chat     │ Header / context             │ Sources / Artifacts /  │
│ Projects     │ Transcript / progress        │ Browser                │
│ Chats        │ Composer                     │                      │
└──────────────┴──────────────────────────────┴──────────────────────┘
               └──── 可选底部 Terminal drawer ────┘
```

这不是固定三栏规范：右侧工具面板和底部 Terminal 都是可切换区域；左侧也有 toggle shortcut。官方快捷键明确提供 Toggle sidebar、Toggle review panel、Toggle bottom panel 和 Toggle terminal。

来源：[Commands](https://learn.chatgpt.com/docs/reference/commands)

### 4.2 左侧：项目、会话与跨项目入口

**官方事实**：项目可置顶；会话可置顶、改名、搜索、归档。官方多任务截图展示项目/会话列表位于侧边区域。

**官方截图观察**：列表项可看到以下状态表达：

- pin 图标；
- 运行中 spinner；
- 蓝色圆点形式的选中或未读提示；
- 相对时间；
- 部分会话带执行环境/弹出标识；
- section 可折叠（更新日志也确认后来加入 collapsible sidebar sections）。

这些是截图可见现象，不是完整状态枚举。尤其蓝点到底是 unread、selected 还是状态组合，官方公开资料不足，不能擅自定义。

来源：[Projects and chats](https://learn.chatgpt.com/docs/projects)、[官方多任务截图](https://learn.chatgpt.com/images/codex/app/multitask-light.webp)、[Changelog](https://learn.chatgpt.com/docs/changelog)

### 4.3 中央：Chat 主画布

**官方事实**：Chat 是主要工作与结果边界。composer 支持文件附件、slash commands、模型选择；Codex Chat 在新会话时还要选择 Local、Worktree 或 Cloud，Worktree 会继续选择起始 branch。

**官方截图观察**：composer 使用较大的浮动容器，主输入在上，模型/推理、附件、权限、语音、发送等低频控制压在底部一行；执行环境与 Git branch 位于 composer 下方。这让“我要交代什么”比“我要配置什么”更突出。

**设计推断**：Bitlab 应继续 chat-first，但需要将模型、权限、工作目录、Git branch 归为一组“执行上下文”，避免它们散落在 Header、输入框和侧栏里。默认只展示当前值，高级选项按需展开。

来源：[Codex environments](https://learn.chatgpt.com/docs/environments/modes)、[官方环境选择截图](https://learn.chatgpt.com/images/codex/app/modes-light.webp)

### 4.4 右侧：Review 与任务资料

**官方事实**：Review pane 可查看仓库全部改动，而不只 Codex 产生的改动；范围包括 Unstaged、Staged、Commit、Branch、Last turn。多仓库时 Header 有 repository selector。用户可逐行评论，并在同一面板 stage、revert、commit、push。

2026 年 4 月的官方更新进一步加入 task sidebar，用于组织 plans、sources、artifacts、summaries，并把 Git summary、Sources、workspace file tabs、PR feedback 等放入 thread side panel。

**设计推断**：右侧不应是永远展示 Session metadata 的静态栏，而应是当前任务的“证据与交付面板”。同一个容器可通过 tabs/stack 承载：

- Changes / Review
- Files / Sources
- Artifacts / Preview
- Browser
- Task summary

首个 MVP 不必全做。先让 Changes 与 Browser 共用一个明确的可切换工具区，就已经比再加一列强。

来源：[Code review](https://learn.chatgpt.com/docs/code-review?surface=app)、[Changelog](https://learn.chatgpt.com/docs/changelog)、[官方 inline review 截图](https://learn.chatgpt.com/images/codex/app/inline-code-review-light.webp)

### 4.5 底部：Integrated Terminal

**官方事实**：每个 Chat 都有绑定当前 Project 或 Worktree 的 terminal。官方文档把它描述为 Chat 下方的 drawer，可用于运行测试、脚本和 Git 命令；Codex 还能读取当前终端输出。后续版本允许 Terminal 位于 bottom panel 或 right panel。

**设计推断**：Terminal 是验证工具，不应成为默认永久可见的第四区域。推荐默认收起，运行命令或用户主动打开时展开；关闭后保留 tab、进程与滚动状态。

来源：[Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)、[官方 Terminal 截图](https://learn.chatgpt.com/images/codex/app/integrated-terminal-light.webp)、[Changelog](https://learn.chatgpt.com/docs/changelog)

## 5. 关键交互与状态

| 对象 | 官方确认的状态/操作 | 对 Bitlab 的意义 |
| --- | --- | --- |
| Project | ChatGPT / Local Project；pin；search；archive chats；多文件夹与 primary folder | Workspace 要成为明确上下文边界，而非纯筛选器 |
| Chat | new；pin；rename；search；archive；running/long-running；queue 或 steer follow-up | Session 列表需优先表达“是否需要注意”和“是否还在工作” |
| Environment | Local / Worktree / Cloud；Worktree 选择 base branch；Local ↔ Worktree Handoff | 执行位置必须在发送前可见，不能藏在全局设置 |
| Composer | 附件；`@`；`/`；模型/推理选择；语音；发送；运行中可 steer 或 queue | 输入区是执行上下文控制面，不只是 textarea |
| Review | Unstaged / Staged / Commit / Branch / Last turn；inline comment；stage/revert/commit/push | 把“改了什么”和“下一步交付”集中在工具面板 |
| Terminal | per-chat；project/worktree scoped；多 tabs；bottom/right placement | 与 Chat 生命周期绑定，而非全局终端 |
| Sidebar | toggle；section collapse；pin；unread/running 可见；搜索可匹配内容和 branch | 左栏应承担调度，不应塞详情 |
| Settings | General、Profile、Keyboard shortcuts、Notifications、Appearance、Browser 等分类；可搜索 | 低频配置退出主导航，只保留单一入口 |

另外一个容易漏掉的状态是 **follow-up behavior**：官方允许用户选择运行中消息是 steer 当前 run，还是 queue 到下一 run。若 Bitlab 支持后台执行，这个差异必须有明确反馈，否则用户无法判断新消息到底干了什么。

来源：[Settings](https://learn.chatgpt.com/docs/reference/settings)、[Commands](https://learn.chatgpt.com/docs/reference/commands)、[Code review](https://learn.chatgpt.com/docs/code-review?surface=app)

## 6. 值得借鉴的设计

### 6.1 借鉴 IA，不抄菜单数量

把 Project、Chat、执行环境、验证工具分开，是 Codex 最成熟的地方。Bitlab 可保留更小的全局能力集合，但边界应一致清楚。

### 6.2 Chat 默认占据最大空间

长期 agent 产品最稀缺的是“理解它做了什么”，不是同时看见最多导航。默认应让 transcript、progress、approval 和最终结果获得最大宽度。

### 6.3 工具面板按需出现、状态可恢复

Review、Terminal、Browser 都与当前 Chat/Project 绑定，同时可 toggle。这既保留上下文，又不强迫所有用户始终面对复杂 IDE。

### 6.4 状态进入列表，而不是只留在详情页

运行中、未读、需要审批、完成、失败等信号应该在 Chat 列表就可见。用户管理并行任务时，列表就是控制台。

### 6.5 发送前呈现执行上下文

Local / Worktree / Cloud 与 branch 位于 composer 邻近区域，降低“在错误目录或错误隔离级别开工”的风险。Bitlab 即便只有 Local，也应清楚展示 Workspace、working directory、权限模式和模型。

### 6.6 Review 是交付闭环，不只是 diff viewer

Codex 把 inline feedback、stage、revert、commit、push 放在同一流程。Bitlab 后续若做 Review，应以完成闭环为目标；只做一个漂亮 diff，然后还要跳到终端处理一切，价值会打折。

## 7. 不应照搬的部分

### 7.1 不照搬完整的全局入口

Scheduled、Sites、Pull requests、Plugins 是 Codex 当前产品能力，不是通用 agent App 的标配。Bitlab 没有成熟能力就不要放占位入口，空菜单比没有菜单更伤信任。

### 7.2 不照搬 Project / ChatGPT Work / Codex 的多模式复杂度

OpenAI 正在把 Chat、Work、Codex 合入一个 App，它需要模式切换来容纳更大的产品矩阵。Bitlab 是 Pi-only、本地优先产品，没有必要复制品牌与模式层级。

### 7.3 不复制未公开的视觉规格

官方没有提供精确列宽、间距 token、响应式断点、动画参数和所有组件状态。按截图目测抄像素会得到脆弱赝品——长得像一版截图，交互一变就露馅。

### 7.4 不默认常驻右栏和底栏

Codex 本身也提供 sidebar、review panel、bottom panel 的独立 toggle。Bitlab 如果把左导航、中列表、Chat、右详情、底终端一起默认展开，最终会像飞机驾驶舱，只是用户还没拿到飞行执照。

### 7.5 不为 Cloud / Worktree 预埋空抽象

当前需求若只有 Local，就完整做好 Local 的目录、权限、状态和错误反馈。等 Worktree 真进入产品范围时再加入第二种执行环境，不要先放 disabled segmented control。

## 8. 面向 Bitlab 的布局建议

### 8.1 当前仓库可复用的基础

以下是**仓库事实**，不是 Codex 官方事实：

- `AppShell` 已有可隐藏左侧栏、可拖动 sidebar 与 session list，默认宽度分别约 220px、300px。
- `PanelStackContainer` 已支持多个内容 panel、resize sash 和横向溢出。
- 小于 768px 时已有 compact 单面板切换逻辑。
- 当前 `isRightSidebarVisible={false}`，右侧工具面板尚未成为稳定壳层。
- Browser 已有 pane 管理能力；Terminal 目前更多以任务输出 overlay 出现，尚不是 Codex 式 per-chat drawer。

因此没必要推翻重写布局引擎。更简单的方向是重新定义每个槽位的责任。

当前还有一个明确的响应式灰区：默认占用约为 `220px sidebar + 300px navigator + 440px content minimum + 12px panel gaps + 6px edge inset = 978px`，但只有小于 768px 才进入 compact。也就是说，约 768–978px 的窗口会同时保留桌面三域结构，又无法满足内容最小宽度，只能横向溢出或被迫频繁拖栏。这个问题应通过减少常驻导航解决，而不是继续微调最小宽度。

### 8.2 建议的桌面布局

```text
┌──────────────┬──────────────────────────────┬────────────────────┐
│ Navigation   │ Chat                         │ Tool panel         │
│              │                              │ (optional)         │
│ Workspace    │ Header: session + context    │ Changes            │
│ Sessions     │ Transcript / progress        │ Browser            │
│ Skills entry │ Composer                     │ Files / Artifacts  │
│ Settings     │                              │                    │
└──────────────┴──────────────────────────────┴────────────────────┘
               └──── Terminal drawer (optional) ────┘
```

与当前三栏相比，建议将“全局 sidebar + session navigator”在视觉上收敛成一个导航域：宽屏可以保留两级，常规窗口默认只呈现一列；用户切换 Workspace 后直接看到该 Workspace 的 Sessions。这样既不必立即重写数据模型，也能减少 220 + 300px 的固定占用。

### 8.3 渐进实施顺序

#### Phase 1：先跑通最小骨架

- 默认布局改为“单一导航域 + Chat”，导航域的原型起始宽度可先用 280px；这是 Bitlab 的试验值，不是 Codex 官方规格。
- 合并当前 220px 全局 sidebar 与 300px session navigator：Workspace selector 在顶部，Session list 占主体，Skills 与 Settings 放到底部固定入口。
- Workspace、Sessions、Skills、Settings 仍使用现有路由与组件，只重排入口；Skills/Settings 点击后在同一导航域 drill-in，不再常驻第二列。
- Header 与 composer 统一展示当前 Workspace、working directory、模型和权限摘要。
- 复用现有 sidebar toggle、resize 和 compact 机制。
- 多内容 panel 暂时保留底层能力，但从默认路径退出；第一阶段不同时改 Tool Panel、Terminal 与 Git Review。

#### Phase 2：增加一个统一 Tool Panel

- 先接 Browser 与 Files/changed files 两类内容。
- 面板默认关闭，记录最后宽度与 tab。
- 从 Chat 中的结果卡片、工具活动或 Header 按钮打开对应 tab。

#### Phase 3：补验证闭环

- 实现真正 per-session 的 Terminal drawer。
- 若产品确认需要 Git review，再加入 Changes 范围、inline feedback、stage/revert；不要只做静态 diff。

#### Phase 4：并行工作调度

- Session list 补齐 running、needs attention、completed、failed、unread 等明确状态。
- 再评估 pin、archive、search、branch 搜索和多 panel 并排是否值得保留。

## 9. 验收标准

布局重构方案进入实现前，至少应回答并通过以下检查：

1. 默认窗口下，Chat 是否明显获得最大可用宽度？
2. 用户能否在不进入 Settings 的情况下确认当前 Workspace、目录、模型和权限？
3. 左侧是否只用于选择/调度，而不承载冗长详情？
4. Browser、Changes、Files 是否进入同一个按需工具区，而不是各自新增一列？
5. Terminal 是否与当前 Session/Workspace 绑定，并在关闭后保持运行状态？
6. 运行中、等待审批、失败、完成、未读能否在 Session 列表区分？
7. 窄于 768px 时是否保持单主面板，工具区是否以 overlay/drawer 打开？
8. 关闭左栏、工具栏、底栏后，快捷键和恢复路径是否明确？
9. 是否删除了没有真实能力支撑的占位入口？
10. 是否用至少五类真实状态做视觉验收：空 Workspace、单会话运行中、多会话并行、权限等待、长对话 + 工具面板？

## 10. 官方来源

- [ChatGPT Desktop App 总览](https://learn.chatgpt.com/docs/app)
- [Features 与导航示例](https://learn.chatgpt.com/docs/features)
- [Projects and chats](https://learn.chatgpt.com/docs/projects)
- [Long-running work](https://learn.chatgpt.com/docs/long-running-work)
- [Codex environments](https://learn.chatgpt.com/docs/environments/modes)
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Code review](https://learn.chatgpt.com/docs/code-review?surface=app)
- [Integrated terminal](https://learn.chatgpt.com/docs/integrated-terminal)
- [Commands and shortcuts](https://learn.chatgpt.com/docs/reference/commands)
- [Settings](https://learn.chatgpt.com/docs/reference/settings)
- [ChatGPT & Codex changelog](https://learn.chatgpt.com/docs/changelog)

### 官方截图

- [多任务 / 项目与会话列表](https://learn.chatgpt.com/images/codex/app/multitask-light.webp)
- [Local / Worktree / Cloud 选择](https://learn.chatgpt.com/images/codex/app/modes-light.webp)
- [Integrated Terminal drawer](https://learn.chatgpt.com/images/codex/app/integrated-terminal-light.webp)
- [Inline code review](https://learn.chatgpt.com/images/codex/app/inline-code-review-light.webp)

## 11. 公开资料缺口

OpenAI 官方公开资料目前不足以确认：

- 每列精确宽度、最小/最大值和默认比例；
- 完整响应式断点与窄屏动画；
- hover、focus、loading、error、empty 的全量状态矩阵；
- 颜色、字体、阴影、圆角、间距 token；
- 右侧 task sidebar、review pane、browser、artifact viewer 的完整互斥/共存规则；
- 不同账号、平台和灰度版本之间的 UI 差异。

这些项目若要成为像素级重构依据，需要由用户在可访问的当前 Codex 窗口中逐页截图并测量；在此之前，只应把官方截图当视觉参考，不能当完整规范。
