# 产物中心技术设计

状态：**已实现（P0–P2）。**

最后核对：2026-08-26。

本文定义 Bitlab 如何识别 Agent 产出的文件，并在对话末尾和窗口右侧提供统一的产物查看入口。设计对象是 Electron 与 WebUI 共用的会话模型；不引入新的产物数据库，不复制现有预览器，也不把会话目录中的所有文件都冒充成“产物”。

## 0. 结论

Bitlab 已经具备文件树、文件监听、HTML 沙箱、图片/PDF/代码/Markdown/JSON 预览和右侧 Browser Dock，缺的是连接这些能力的**产物语义**与**统一右侧容器**。

本设计采用三条原则：

1. **产物从持久化会话事实与指定输出目录派生。**成功的文件写入工具消息提供来源与 Turn；`plans/`、`data/` 中的真实文件补齐脚本间接生成物。模型最终回复中的自然语言不是事实来源。
2. **产物、文件和变更分开。**产物是 Agent 写出来的交付物；变更是它改动的既有文件；文件是会话目录的完整树。
3. **右侧只保留一个 Dock。**把现有 Browser Dock 泛化成 `RightDock`，常驻窗口右列，承载“产物 / 变更 / 文件”三个可折叠分区，浏览器作为独占模式，不再增加第二条互相抢宽度的侧栏。

最小端到端版本只新增产物识别、产物列表、对话末尾产物条和统一 Dock；文件预览全部复用现有 `useLinkInterceptor` 与 `FilePreviewRenderer`。

---

## 1. 背景与竞品结论

### 1.1 WorkBuddy

WorkBuddy 把右侧区域定义为任务“结果区”，分为产物、工作空间文件、变更和浏览器。产物覆盖 Word、Markdown、PDF、Excel、CSV、PPT 与分析报告；网页或本地 Web 应用进入内置浏览器；代码修改进入独立变更视图。

这证明通用 Agent 不应把“目录树”“改过的源码”和“最终交付物”混成一份列表。

来源：[WorkBuddy 结果查看](https://www.codebuddy.cn/docs/workbuddy/Results)、[WorkBuddy 右侧边栏](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Right-Sidebar)。

### 1.2 千问办公

千问办公没有强行使用一个万能产物面板，而是按任务类型切换右侧工作台：

- 幻灯片工作台提供“幻灯片 / 大纲 / 文件”，支持逐页生成、放映和 PPTX/PDF/HTML 导出；
- 设计工作台提供“画布 / 设计文件 / 预览 / 风格参考 / 计划”，生成过程实时更新画布；
- 通用任务在对话中预览，完成后进入按任务或会话组织的 Agent 工作区。

Bitlab 当前没有 Office 在线编辑与设计画布，不应复制这套重量级工作台；但应保留按产物类型选择专用查看器的接口。

来源：[千问办公幻灯片工作台](https://help.aliyun.com/zh/qwenwork/workbench-slides)、[设计工作台](https://help.aliyun.com/zh/qwenwork/qw-workbench-design)、[Web 端使用链路](https://help.aliyun.com/zh/qwenwork/qwenwork-web-usage)。

### 1.3 Codex / ChatGPT Desktop

OpenAI 当前桌面产品把生成的文档、演示文稿、表格、PDF 与 HTML 显示在聊天旁边；HTML 可以在渲染视图和源码视图之间切换，支持针对预览具体位置提交修改要求。文件与聊天通过 Project 组织。

值得借鉴的是“聊天负责意图，旁边的预览负责验收”，而不是把完整文件内容继续塞进消息流。

来源：[OpenAI Work with files](https://learn.chatgpt.com/docs/artifacts-viewer)、[Projects and chats](https://learn.chatgpt.com/docs/projects)。

### 1.4 Claude Artifacts

Claude 把 Artifact 建模为独立对象：在聊天右侧打开、支持多个产物切换、版本选择、源码查看、复制、下载与分享。只有用户发布的 Artifact 才进入全局 Artifacts 区域，对话中的临时结果不会自动污染全局收藏。

Bitlab 第一版不做发布和内容版本快照，但应避免把“一次文件写入”误建模成一个永久全局对象。

来源：[Claude Artifacts](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)。

### 1.5 DeepSeek Harness

本地核对的 DeepSeek Harness 版本为 `f1f7dc36faa4a1548b742fb3f63cac8651c166cb`。它已经实现 `ui-deliverables`：

- 从成功的文件修改工具事件中读取 `locations`；
- 按 Turn 去重并保留首次出现顺序；
- 在最终回复下方显示最多六个文件 Chip，溢出显示 `+ N files`；
- 点击文件后交给 Host 打开；
- 不依赖模型有没有在结尾提到文件。

相关实现位于 sibling checkout：

- `packages/client/ui-deliverables/src/client/turn-deliverables.ts`
- `packages/client/ui-deliverables/src/client/ProducedFiles.tsx`
- `packages/bundle/web-app/cordis.patch.yml`

它没有右侧产物中心、内置文件预览、版本、分享或发布。Bitlab 应复用其“由成功工具事件派生”的思路，而不是复制它的 UI 上限。

---

## 2. Bitlab 当前状态

### 2.1 已有能力

| 能力 | 当前实现 | 可直接复用 |
| --- | --- | --- |
| 会话文件树 | `SessionFilesSection.tsx` | 是 |
| 会话目录扫描 | `packages/server-core/src/handlers/rpc/sessions.ts` | 是 |
| 文件变化监听 | `sessions.WATCH_FILES` + `FILES_CHANGED` | 是 |
| 文件类型识别 | `packages/ui/src/lib/file-classification.ts` | 是 |
| 文件打开路由 | `useLinkInterceptor.ts` | 是 |
| 图片/PDF/代码/文本/HTML/Markdown/JSON 预览 | `FilePreviewRenderer` | 是 |
| HTML 沙箱 | `html-preview://` 协议 | 是 |
| 右侧可调整宽度列 | `BrowserDock` + `browser-dock.ts` | 改造成通用 Dock |
| 工具调用持久化 | `persist-transcript.ts` | 是，产物事实来源 |
| Turn 聚合 | `packages/ui/src/components/chat/turn-utils.ts` | 是 |

### 2.2 当前数据链路

Pi 工具生命周期已经被完整记录：

```text
Pi tool_execution_start
  -> PiEventAdapter.createToolStart()
  -> AgentEvent.tool_start
  -> SessionManager
  -> Message {
       role: "tool",
       toolName,
       toolUseId,
       toolInput,
       toolStatus: "executing",
       turnId
     }

Pi tool_execution_end
  -> AgentEvent.tool_result
  -> persist-transcript 按 toolUseId 合并
  -> Message {
       toolStatus: "completed" | "error",
       toolResult,
       isError
     }
```

因此，重启后仍能从 `Message[]` 重建“哪个成功工具改了哪个文件”，无需增加第二份持久化状态。

### 2.3 当前缺口

1. `SessionFilesSection` 展示会话目录的全部文件，不知道文件由哪一轮、哪个工具产生。
2. Workspace 源码修改不在会话文件树里，只能从工具活动中查看。
3. 预览器是全屏 Overlay；没有持续可见的产物列表和当前选择状态。
4. `RightSidebarPanel` 只剩 `files/history/none` 路由状态，本轮源码扫描没有找到对应渲染分支；真正占用窗口右侧的是全局 `BrowserDock`。
5. Browser Dock 使用原生 `WebContentsView`，单纯用 CSS 隐藏无法让其他面板盖住它。

---

## 3. 术语

### 3.1 Produced file

Agent 通过一个成功的文件修改工具创建或修改的文件。它是机器可验证事实，不代表它一定是用户要交付的最终成果。

### 3.2 Artifact

Agent **写出来的**文件，即交付物。判定依据是它对文件做了什么，不是文件在哪：本次会话对该路径的首次成功写入使用 `Write`（整文件写）即视为 Artifact。

> **修订说明（2026-08-26）**：初版按位置判定（落在会话 `plans/`/`data/` 或会话目录内即 Artifact）。实测证伪：session cwd 就是 workspace 数据根，Agent 在其下自建工作目录（如 `agent-team-research/`）产出交付物，会话目录里只剩 `api-error.json`、`tool-metadata.json` 等运行时记账文件。按位置判定会把**全部真实交付物**归入 Change，产物列表恒为空。

模型在最终回复中提到或预览一个路径，不改变该路径的分类。

### 3.3 File

会话目录文件树中的普通文件。它可能是输入、缓存、中间结果或产物。

### 3.4 Change

Agent **改动的既有文件**。本次会话对该路径的首次成功写入使用 `Edit`、`MultiEdit` 或 `NotebookEdit` 即视为 Change —— 这三个工具只能作用于已存在的文件，因此足以证明该文件先于本次会话存在。

Artifact 与 Change 互斥：一个路径只会出现在其中一侧。

### 3.5 Revision

同一路径在不同 Turn 中再次被成功修改形成一次修订记录。第一版只记录“何时、由哪个 Turn 修改”，不保存历史文件内容，因此 UI 不得称其为“版本历史”。

---

## 4. 目标与非目标

### 4.1 目标

1. 用户在一轮任务结束后能立即看到本轮产物。
2. 用户可以在右侧查看当前会话全部产物，并区分普通文件与 Workspace 变更。
3. 点击产物沿用现有文件安全校验和预览器。
4. 关闭、重启、重新进入会话后，产物列表可从会话记录稳定重建。
5. Electron 与 WebUI 消费同一 RPC 与 DTO。
6. Browser 与产物面板共享同一右侧空间，不发生重叠和双重 resize。

### 4.2 非目标

- 不做 Word、Excel、PowerPoint 的内置编辑器；不支持的文件交给系统应用打开。
- 不做云盘、公开分享、发布市场或跨会话全局产物库。
- 不保存每次修改的文件内容快照。
- 不解析任意 Bash 命令来猜输出路径；脚本产物通过扫描指定输出目录发现。
- 不根据模型结尾一句“我生成了某文件”直接相信它。
- 不新增数据库或 `artifacts.json` 旁路事实源。

---

## 5. 架构决策

### D1：产物是会话投影，不是新存储实体

`Message[]` 已经持久化工具名、输入、状态、结果和 Turn；会话的 `plans/`、`data/` 是系统明确交给 Agent 的输出目录。新增 `deriveSessionArtifacts()` 将两者合并成只读投影：工具消息提供修改来源，输出目录补齐 Bash、Python 和文档脚本间接生成的文件。

优点：

- 不存在 transcript 和 artifact manifest 双写不一致；
- 老会话只要保留工具消息或输出目录文件即可自动获得产物列表；
- 回放、测试和重启使用同一套逻辑；
- 删除功能时没有迁移包袱。

### D2：派生在 server-core 完成

路径解析必须正确处理相对路径、Windows 路径、Workspace cwd、会话目录 containment 和真实文件状态。该逻辑放在 Node 侧 `server-core`，Renderer 只消费 DTO。

不在 React 组件里手写路径规则，也不为 Electron 和 WebUI 各实现一次。

### D3：统一 RightDock，删除旧侧栏状态

现有 `BrowserDock` 已经拥有右侧列、宽度、resize 和原生 View bounds。新增另一条 Sidebar 会产生两个状态源和两个宽度系统。

目标结构：

```ts
type RightDockSection = 'artifacts' | 'changes' | 'files'
type RightDockMode = 'sections' | 'browser'

interface RightDockState {
  /** 常驻列，默认 true；用户的收起选择被持久化。 */
  open: boolean
  mode: RightDockMode
  /** 三个分区各自展开与否，可同时展开。 */
  sections: Record<RightDockSection, boolean>
}
```

产物、变更、文件做成**可同时展开的折叠分区**而非 Tab：它们回答的是相邻问题（做出了什么 / 动了什么 / 这个会话里有什么），Tab 强迫用户二选一。

浏览器只能是**独占模式**：它是原生 `WebContentsView`，需要一块稳定矩形；放进会随兄弟分区展开而变高的盒子里，它会跟着抖动，且两个分区同时展开时根本无法定位。

实施时直接删除：

- `RightSidebarPanel = files | history | none`
- `sidebar=` 对应的旧 route-parser 分支
- `browserDockOpenAtom` 作为独立开关的角色

不保留兼容映射。新的 `RightDock` 成为窗口右侧唯一所有者。

### D4：预览器保持单一入口

Artifact、File、Change 点击都调用同一个 `onOpenFile(path)`：

```text
RightDock row click
  -> AppShellContext.onOpenFile
  -> useLinkInterceptor.handleOpenFile
  -> classifyFile
     -> 可预览：FilePreviewRenderer
     -> 不可预览：系统默认应用
```

RightDock 不自行读取文件，不复制 Overlay，不出现“侧栏能看、聊天里打不开”的第二套行为。

### D5：不猜 Bash 命令，只认输出目录结果

Shell 命令可以创建任意文件，仅靠命令字符串无法可靠判断最终写入集合。系统不解析命令；命令完成后真实落在 `plans/`、`data/` 中的文件由输出目录扫描发现。

Bash 生成在 Workspace 或其他目录中的文件不会自动进入 Artifact；它们仍可通过 Workspace 或文件入口访问。系统不得用正则解析 `>、tee、cp、python` 等命令来伪造确定性。

---

## 6. 目标架构

```text
┌─────────────────────────────────────────────────────────────────┐
│                         Agent Runtime                           │
│                                                                 │
│  tool_start(input.file_path) ────┐                              │
│  tool_result(completed/error) ───┼── AgentEvent                 │
└──────────────────────────────────┼──────────────────────────────┘
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SessionManager / JSONL                       │
│                                                                 │
│  Message[]：toolName + toolInput + toolStatus + turnId          │
│  plans/、data/：Agent 指定输出目录                               │
│  两者共同组成可回放事实                                          │
└──────────────────────────────────┬──────────────────────────────┘
                                   │ sessions.GET_ARTIFACTS
                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│             deriveSessionArtifacts(messages, context)           │
│                                                                 │
│  1. 过滤成功修改工具                                             │
│  2. 扫描 plans/、data/ 输出文件                                  │
│  3. 解析并规范化路径                                             │
│  4. 按 normalizedPath 聚合                                      │
│  5. 判断 artifact / change 并读取文件状态                        │
└────────────────────┬─────────────────────────────┬──────────────┘
                     │                             │
                     ▼                             ▼
┌──────────────────────────────┐   ┌──────────────────────────────┐
│ ProducedFilesRow             │   │ RightDock                    │
│ 每轮最终回复下方              │   │ Artifacts / Files / Changes │
└────────────────────┬─────────┘   │ / Browser                    │
                     │             └────────────────┬─────────────┘
                     └────────── onOpenFile(path) ──┘
                                                    ▼
                                      useLinkInterceptor
                                                    ▼
                                      FilePreviewRenderer / OS
```

---

## 7. 数据合约

共享 DTO 放在 `packages/shared/src/protocol/`，Renderer 不直接消费 server-core 私有类型。

```ts
export type ArtifactKind =
  | 'html'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'json'
  | 'code'
  | 'text'
  | 'office'
  | 'other'

export interface ArtifactRevision {
  /** 产生这次修改的持久化 tool Message id。 */
  messageId: string
  toolUseId: string
  toolName: string
  turnId?: string
  timestamp: number
}

export interface SessionArtifact {
  /** 当前会话内的规范化绝对路径；也是投影聚合键。 */
  path: string
  name: string
  kind: ArtifactKind
  scope: 'session' | 'workspace'
  classification: 'artifact' | 'change'
  exists: boolean
  size?: number
  modifiedAt?: number
  /** tool 表示存在可追溯修改；session-output 表示由输出目录扫描发现。 */
  sources: Array<'tool' | 'session-output'>
  revisions: ArtifactRevision[]
}

export interface SessionArtifactsSnapshot {
  sessionId: string
  artifacts: SessionArtifact[]
  changes: SessionArtifact[]
}
```

约束：

- `path` 是 Host 上的路径，不允许 Renderer 自行拼接；
- `sources` 去重且固定按 `tool`、`session-output` 排序；
- `revisions` 按时间升序，同一个 `toolUseId` 只出现一次；
- `artifacts` 和 `changes` 按最后修改时间降序；
- 同一路径若既是 Workspace change 又被明确呈现为交付物，只出现在 `artifacts`，DTO 的 `scope` 仍为 `workspace`；
- 有 `tool` revision 的文件被删除后保留记录并返回 `exists: false`；仅由目录扫描发现、没有持久化 provenance 的文件在删除后不再出现。

不加入 `version`、`downloadUrl`、`shareUrl`、`content`。这些字段当前没有真实能力支撑。

实现时补充了一个字段：`relativePath`。§9.3 要求行内显示相对路径，而 D2 又要求 Renderer 不做路径解析，两者只能由 Server 计算好再下发。取值规则是"落在会话目录里就相对会话目录，否则相对 session cwd，都不在就退回绝对路径"。

---

## 8. 产物派生规则

### 8.1 候选来源

候选集合是以下两者的并集：

1. `plans/`、`data/` 中递归扫描到的非隐藏普通文件，来源记为 `session-output`；
2. 以下结构化修改工具的成功消息，来源记为 `tool`。

输出目录扫描不包含 `attachments/`、`long_responses/`、`downloads/`、`session.jsonl` 和任意隐藏路径段。`downloads/` 表示外部输入缓存，不是 Agent 交付物。

### 8.2 支持的修改工具

第一版只认以下规范化工具名：

| 工具 | 路径字段 | 结果要求 |
| --- | --- | --- |
| `Write` | `file_path` | `toolStatus === completed` |
| `Edit` | `file_path` | `toolStatus === completed` |
| `MultiEdit` | `file_path` | `toolStatus === completed` |
| `NotebookEdit` | `notebook_path` | `toolStatus === completed` |

`Read`、`Grep`、`Find`、`Ls`、`Glob`、`WebFetch`、`WebSearch`、失败工具和仍在执行的工具全部忽略。

### 8.3 路径解析

```text
rawPath = toolInput.file_path ?? toolInput.notebook_path

若 rawPath 为绝对路径：
  normalizedPath = resolve(rawPath)

若 rawPath 为相对路径：
  normalizedPath = resolve(session.cwd, rawPath)
```

然后执行：

1. 使用平台正确的 `node:path` 实现；
2. 拒绝空字符串、NUL 和无法解析的路径；
3. `realpath` 只用于读取当前状态，不替换投影身份，避免文件删除后 identity 消失；
4. 所有读取与打开继续经过现有 allowed-root 校验。

### 8.4 Artifact 与 Change 分类

```text
firstWrite = revisions[0]

if 没有 firstWrite               // 仅由输出目录扫描发现
then artifact                    // 那两个目录本来就只该放交付物
else if firstWrite.toolName === 'Write'
then artifact                    // 整文件写 = Agent 产出了它
else                             // Edit / MultiEdit / NotebookEdit
then change                      // 只能改已存在的文件 = 它先于本会话存在
```

`scope`（`session` / `workspace`）仍按路径是否落在会话目录内计算，但**不参与** artifact/change 判定，只用于展示。

已知近似：`Write` 覆盖一个既有文件会被判为 Artifact。要区分两者需在每次写入前记录文件是否存在，代价与收益不成比例；且该误判是良性的——被整体覆盖的文件此刻确实由 Agent 产出。

最终回复中的自然语言、本地链接和预览块不参与分类。

### 8.5 去重和修订

同一路径多次写入：

- 产物列表只显示一行；
- 每个成功工具消息追加一个 `ArtifactRevision`；
- 仅由输出目录扫描发现的文件允许 `revisions` 为空；
- 列表时间取最后一次修订；
- 对话末尾产物条按当前 Turn 去重，并保留该 Turn 首次出现顺序。

输出目录扫描无法证明文件属于哪一个 Turn，因此仅有 `session-output` 来源的文件进入 RightDock，不进入对话末尾产物条。不能为了“看起来完整”把当前目录快照错误归到最后一轮。

### 8.6 空结果

没有符合规则的文件时：

- 不渲染对话末尾产物条；
- RightDock 的“产物”显示空状态；
- 不自动打开 Dock。

---

## 9. RightDock 信息架构

### 9.1 桌面布局

```text
┌──────────────┬─────────────────────────────┬──────────────────────────┐
│ Navigation   │ Chat                        │ RightDock                │
│              │                             │                          │
│ Sessions     │ User request                │                    [🌐][⇥]│
│ Skills       │ Tool activities             │ ▾ 产物                  3 │
│ Settings     │ Final response              │ ▸ 变更                  1 │
│              │ Produced: report.html …     │ ▸ 文件                    │
└──────────────┴─────────────────────────────┴──────────────────────────┘
```

Dock 行为：

- 窗口级唯一实例，**默认常驻**（收起状态持久化）；
- 复用现有 360–1100 px 宽度限制和拖拽 resize；
- 默认宽度 480 px；
- 切换分区或模式不改变宽度；
- 存储宽度会按壳宽度实时钳制（保证聊天区不低于 460 px），但**不回写**——窗口变宽后恢复用户选定的宽度；
- 不保留旧 `browser-dock-width` 兼容读取；
- Artifacts、Changes、Files 随当前会话切换；Browser tabs 仍按当前 Workspace 过滤。

### 9.2 Browser 原生 View

`WebContentsView` 总在 Renderer 之上。RightDock 切离 Browser 时必须通过 `useDockBoundsSync` 向 Main 进程发送 `visible: false`，不能只隐藏占位 DOM。

```text
mode === 'browser' && dock.open && browserInstance exists
  -> native view visible

其他情况
  -> native view detached/hidden
```

分区模式下 BrowserPanel 保持挂载但被 CSS `hidden`，占位 rect 归零即触发 detach，同时它的 tab 监听不掉线。

Host 不提供 `browser-pane:*` 通道时（远程 WebUI），不渲染浏览器入口、也不挂载 BrowserPanel —— 否则它会持续向无人应答的通道推送 dock 几何。

现有 Overlay suppression counter 保留，只在 browser 模式下生效。

### 9.3 产物面板

每行显示：

- 文件类型图标或已有缩略图；
- 文件名；
- 相对路径；
- 最近产出时间；
- 文件缺失状态；
- `…` 菜单：预览/打开、在文件管理器中显示、复制路径。

点击整行执行预览。Office 和未知格式由系统默认应用打开。

列表默认按最近修改排序；不增加搜索、筛选、固定、分享和批量操作。列表内联渲染，滚动由整列承担。

### 9.4 文件分区

直接复用 `SessionFilesSection`，但从 `SessionInfoPopover` 中拆出为独立可组合内容。文件分区仍代表完整会话目录，不显示“产物”徽标来混淆概念。

会话目录扫描必须排除运行时记账文件（`session.jsonl`、`api-error.json`、`tool-metadata.json`）与隐藏路径。不排除的话，多数会话的文件分区里**只有**这几个文件，看上去像是面板指错了目录。

分区高度设上限（`min(45vh, 320px)`）并在内部滚动：文件树是唯一可能上百行的内容，让它把其他分区顶出视野就失去了并列展示的意义。

### 9.5 变更面板

展示 Workspace 中由结构化文件工具成功修改的路径。第一版只显示文件列表和修订次数，点击走现有文件预览；Diff 内容继续由对话中的工具活动负责，不再造一套 Git diff 引擎。

### 9.6 对话末尾产物条

位于一个已完成 Assistant Turn 的最终回复之后、操作按钮之前：

```text
产物  [report.html] [summary.pdf] [+ 3 个文件]   [查看全部]
```

规则：

- 最多显示六个文件；
- 单行，不横向滚动；
- Chip 只显示 basename，完整路径放入 tooltip；
- 点击 Chip 直接预览；
- “查看全部”打开 RightDock 的 Artifacts panel；
- Turn 仍在执行时不显示，避免失败写入闪现为最终产物；
- 仅由输出目录扫描发现、没有 Turn provenance 的文件不进入产物条。

### 9.7 紧凑布局

`isAutoCompact` 下不渲染右侧列。点击产物入口打开全高 Sheet，内容组件与桌面 RightDock 共用；Browser 保持当前紧凑布局行为，不在本功能中新增移动浏览器 Dock。

---

## 10. RPC 与实时更新

新增只读 RPC：

```ts
sessions.GET_ARTIFACTS(sessionId): Promise<SessionArtifactsSnapshot>
```

调用时机：

1. 进入会话；
2. 打开 Artifacts 或 Changes panel；
3. 当前会话收到成功或失败的 `tool_result`；
4. 当前会话收到 `FILES_CHANGED`，用于刷新 exists/size/modifiedAt；
5. Renderer 重连后。

不新增 `ARTIFACT_CREATED` 推送事件。现有 `tool_result` 与 `FILES_CHANGED` 已经覆盖事实变化，额外事件只会制造顺序问题。

为避免一轮包含多个写工具时连续读取磁盘，Renderer 对刷新请求做 100 ms 合并；同一 session 同时只允许一个请求在途，后发请求使先发结果失效。

---

## 11. 安全边界

1. **不新增读取权限。**产物列表返回 metadata；文件内容仍由既有 `readFile`、`readFilePreviewDataUrl`、PDF binary 与 HTML protocol 读取。
2. **路径不由 Renderer 拼接。**Server 返回规范化 Host 路径。
3. **打开前再次校验。**列表中存在不等于当前仍有权限打开；调用既有 opener 时重新走 allowed-root 检查。
4. **符号链接按既有读取策略处理。**Artifact 派生不能绕过最终文件操作的 containment。
5. **HTML 保持 sandbox。**RightDock 不引入新的 `file://` 或宽松 iframe。
6. **远程 WebUI 不调用本机 Finder。**只有 Host 明确暴露 reveal 能力时显示“在文件管理器中显示”。
7. **不信任自然语言。**模型文本只能在与 Produced file 精确匹配后提升分类。

---

## 12. 代码改动边界

### 12.1 新增

| 文件 | 职责 |
| --- | --- |
| `packages/server-core/src/sessions/artifacts.ts` | 纯派生函数、路径归一化、分类、去重 |
| `packages/server-core/src/sessions/artifacts.test.ts` | 派生规则单测 |
| `apps/electron/src/renderer/atoms/right-dock.ts` | 唯一 Dock 状态与宽度 |
| `apps/electron/src/renderer/components/right-dock/RightDock.tsx` | Dock 外壳、模式切换 |
| `apps/electron/src/renderer/components/right-dock/RightDockSections.tsx` | 三个折叠分区，桌面与紧凑共用 |
| `apps/electron/src/renderer/components/right-dock/ArtifactList.tsx` | 产物/变更共用的行列表 |
| `apps/electron/src/renderer/components/right-dock/dock-width.ts` | 按壳宽度钳制 Dock 宽度 |
| `packages/ui/src/components/chat/ProducedFilesRow.tsx` | 对话末尾产物条 |

具体测试文件可按所在 package 现有命名约定放置，不为追求目录对称新建空模块。

### 12.2 修改

| 文件 | 改动 |
| --- | --- |
| `packages/shared/src/protocol/` 对应 DTO/Channel | 新增 Artifact DTO 与 `GET_ARTIFACTS` |
| `packages/server-core/src/handlers/rpc/sessions.ts` | 注册只读 RPC |
| `apps/electron/src/renderer/components/app-shell/AppShell.tsx` | 用 `RightDock` 替换 Browser-only 右列 |
| `apps/electron/src/renderer/components/browser/BrowserDock.tsx` | 更名 `BrowserPanel.tsx`，变为 RightDock 的浏览器模式内容 |
| `packages/server-core/src/handlers/rpc/sessions.ts` 的目录扫描 | 排除运行时记账文件 |
| `SessionFilesSection.tsx` | 解除对 Popover 布局的假设，作为 Files panel 复用 |
| `ChatDisplay.tsx` / TurnCard 调用链 | 注入按 Turn 的产物数据和打开 Dock 动作 |
| `TopBar.tsx`、`BrowserDockToggle.tsx` | 打开 RightDock 的 Browser panel |
| i18n `zh-Hans.json`、`en.json` | 新面板、空状态和操作文案 |

### 12.3 删除

- `RightSidebarPanel` 旧 union 及 `files/history/none` 分支；
- `route-parser.ts` 中旧 `sidebar=` 解析/生成逻辑；
- `browserDockOpenAtom` 和只服务于 Browser-only 容器的命名；
- SessionInfoPopover 中重复的完整文件树入口，避免同一能力出现两个不一致位置。

删除必须做全仓精确扫描，不能留兼容别名或死路由。

---

## 13. 实施顺序

### P0：事实链路

1. 定义共享 DTO 与 RPC channel；
2. 实现 `deriveSessionArtifacts()` 与指定输出目录扫描；
3. 覆盖成功、失败、重复路径、相对路径、Windows 路径、缺失文件和会话重载；
4. 注册 `GET_ARTIFACTS`，用真实持久化 Message 夹具验证。

完成标准：不做任何新 UI，也能从一个完成会话稳定查询 Artifact/Change 快照。

### P1：统一 RightDock

1. 抽出 RightDock 状态与宽度；
2. 把 BrowserDock 迁入 Browser panel；
3. 保证 native View 在切 Tab、关闭 Dock、Overlay 打开时正确隐藏；
4. 加入 Artifacts、Files、Changes panel；
5. 删除旧 RightSidebar 路由状态。

完成标准：Browser 无回归，三类文件信息可以在同一右栏切换。

### P2：对话闭环

1. 在完成 Turn 下渲染 `ProducedFilesRow`；
2. Chip 点击复用预览；
3. “查看全部”打开 Artifacts panel；
4. 自动刷新和重连恢复；
5. 增加紧凑布局 Sheet。

完成标准：从 Agent 写文件到用户在产物条/右栏预览，形成完整端到端链路。

P0 至 P2 是同一架构的递进落地，不引入临时数据模型或过渡兼容层。

---

## 14. 测试方案

### 14.1 纯函数单测

必须覆盖：

- `Write` 首写 ⇒ artifact；`Edit`/`MultiEdit`/`NotebookEdit` 首写 ⇒ change；
- 分类看**首次**写入而非最后一次（先 Edit 后 Write 仍是 change）；
- 交付物落在会话目录之外（workspace 自建工作目录）仍是 artifact；
- `Read` 不产生 Artifact；`Bash` 命令文本不解析；
- Bash/Python 间接写入 `plans/`、`data/` 后由目录扫描发现；
- error/executing/backgrounded 不计入；
- 相对路径基于 session cwd；
- 同一路径多次修改合并 revisions；
- 同 basename、不同路径不合并；
- `scope` 按路径计算，且不影响 artifact/change 判定；
- 隐藏文件、`session.jsonl`、附件目录排除；
- 最终回复链接或预览块不能凭空提升分类；
- 有 tool provenance 的文件删除后 `exists: false`；
- POSIX 与 Windows 路径夹具。

### 14.2 RPC 测试

- 未知 session 返回 typed not-found error，不伪装成空列表；
- 已存在 session 返回稳定排序；
- 无文件时返回空数组；
- RPC 不返回文件内容；
- 多客户端查询不共享可变数组。

### 14.3 Renderer 测试

- Tab 切换与关闭；
- Artifact 点击只调用一次 `onOpenFile`；
- 缺失文件禁用预览并显示状态；
- 文件类型图标、缩略图失败回退；
- ProducedFilesRow 的六项上限与 `+ N`；
- “查看全部”打开正确 panel；
- session 切换时不显示上一个 session 的快照；
- 迟到请求不会覆盖新 session。

### 14.4 Browser Dock 回归

- Browser panel active 时 native View bounds 正确；
- 切到 Artifacts/Files/Changes 时 native View 不可见；
- 切回 Browser 恢复同一实例；
- resize、窗口缩放、最大化、Overlay suppression 不回归；
- 无 Browser tab 时打开 Browser panel 不会留下空白右栏。

### 14.5 端到端场景

至少提供以下可运行案例：

1. Agent 用 `Write` 在 `data/` 生成 `report.html`，最终回复含 `html-preview`：产物条出现，右栏可预览 HTML。
2. Agent 用 `Write` 在 `data/` 生成 PDF：产物条出现，右栏点击进入现有 PDF 预览。
3. Agent 用 `Edit` 修改 Workspace 源码但未呈现：只进入 Changes，不进入 Artifacts。
4. Agent 写入两个同名不同目录文件：右栏显示两项，tooltip 路径可区分。
5. 重启应用并重新打开会话：产物和修订数保持一致。
6. Bash/Python 在 `data/` 创建文件：RightDock 能看到；因没有工具路径 provenance，不错误归入最后一轮产物条。
7. 切换到产物 Tab：正在显示的 Browser native View 立即隐藏。

---

## 15. 验收标准

功能验收：

- [ ] 成功文件工具调用会稳定进入 Artifact 或 Change；失败调用不会进入。
- [ ] `plans/`、`data/` 中的脚本间接产物可在重启后稳定重建。
- [ ] 对话末尾只展示当前完成 Turn 的 Artifact。
- [ ] RightDock 常驻，三个分区可独立展开并持久化；浏览器为独占模式。
- [ ] 窗口变窄时 Dock 让位，变宽后恢复用户设定宽度。
- [ ] 点击产物复用现有预览/外部打开逻辑。
- [ ] 重启、重连、切换会话后结果正确。
- [ ] Electron 与 WebUI 使用同一 DTO 与 RPC。

架构验收：

- [ ] 没有新增 Artifact 数据库、manifest 或双写状态。
- [ ] Renderer 没有复制路径解析和文件分类逻辑。
- [ ] Browser native View 只有 RightDock 一个布局所有者。
- [ ] 旧 RightSidebar 状态、路由和 Browser-only open state 被完整删除。
- [ ] Artifact/Change 判定不依赖文件位置。
- [ ] Artifact、File、Change 三个概念在类型与 UI 中保持分离。

质量验收：

- [ ] 相关单测、RPC 测试、Renderer 测试和 Browser Dock 回归通过。
- [ ] i18n 中英文键对齐且无未使用键。
- [ ] `git diff --check` 通过。
- [ ] 全仓扫描不存在旧符号与兼容别名。

---

## 16. 风险与处理

| 风险 | 处理 |
| --- | --- |
| 工具输入使用相对路径 | 只在 server-core 结合 session cwd 解析 |
| Bash 生成文件漏识别 | 不解析命令；扫描 `plans/`、`data/` 的真实结果 |
| 模型声称生成不存在文件 | 必须与成功 Produced file 精确相交 |
| 同一路径被反复编辑 | 聚合为一项，保留 revision 元数据 |
| 文件后来被删除 | 有 tool provenance 时保留并显示缺失；纯扫描项随文件消失 |
| Browser 原生 View 遮住 React 面板 | 切 Tab 时从 Main 层隐藏 View |
| 旧请求污染新会话 | sessionId + request generation 丢弃迟到结果 |
| Office 文件无法内置预览 | 第一版使用系统应用，UI 不虚假展示预览按钮 |
| `Write` 覆盖既有文件被判为产物 | 接受的良性近似，见 §8.4 |
| 默认常驻挤压聊天区 | 按壳宽度钳制显示宽度，不回写存储值 |

---

## 17. 不采用的方案

### 17.1 扫描目录并把所有文件叫产物

输入附件、中间缓存和 Agent 输出无法区分；会话目录外的 Workspace 修改又会漏掉。文件系统扫描只适合 Files panel。

### 17.2 新建 `artifacts.json`

工具消息和 manifest 需要双写、事务、修复与迁移；当前 transcript 加指定输出目录已有第一版所需事实，没有理由制造第二事实源。

### 17.3 解析 Bash 命令

Shell 写文件的方式无限，正则既会漏报也会误报。没有结构化执行结果就不宣称确定性。

### 17.4 再增加一条 Artifact Sidebar

现有 Browser Dock 已占窗口最右列。两个独立侧栏会争抢宽度、TopBar inset、compact 模式和 native View bounds。

### 17.5 第一版实现 Claude 式内容版本

当前只保存最新磁盘文件，revision metadata 不能还原旧内容。没有快照就不做假版本选择器。

---

## 18. 最终形态

实现完成后，Bitlab 的产物链路应当是：

```text
Agent 成功写文件
  -> transcript 持久化
  -> server-core 派生 Artifact/Change
  -> 完成 Turn 显示产物条
  -> RightDock 常驻分区汇总当前会话产物/变更/文件
  -> 用户点击
  -> 现有预览器验收
  -> 用户继续在同一会话要求修改
```

这里真正新增的是“识别、组织和导航”，不是第三套文件系统，也不是第八个预览组件。
