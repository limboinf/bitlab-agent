# Skills：现状核对与设计方案

Bitlab 的 Skills 功能早于 Pi 迁移。本文记录代码今天实际做了什么、生态已经收敛到什么标准，以及一份分期的 Skills Hub 方案——发现、安装、创作与生命周期管理。

状态：方案，尚未实现。已上线行为见 [`skills.md`](./skills.md)。

修订说明：§1.2 与 §5.2 在一次审查指出原根因判断错误后重写。下文结论均有针对锁定版 SDK 的可复现探针支撑，见 [§1.6](#16-探针复现)。

> ASCII 原型图中的界面文案保留英文：中文与 emoji 混排在不同等宽渲染器下必然错位，且按翻译约定代码块以英文为准。图下方的中文说明是权威解读。

## 1. 现状（代码实证）

### 1.1 发现路径

三层，按 slug 合并，高优先级覆盖低优先级（[`storage.ts:189`](../../packages/shared/src/skills/storage.ts)）：

| 优先级 | 路径 | `SkillSource` |
| --- | --- | --- |
| 1（最低） | `~/.agents/skills/<slug>/SKILL.md` | `global` |
| 2 | `~/.bitlab/workspaces/<slug>/skills/<slug>/SKILL.md` | `workspace` |
| 3（最高） | `<projectRoot>/.agents/skills/<slug>/SKILL.md` | `project` |

`projectRoot` 是会话工作目录，不是仓库根目录。`~/.bitlab` 受 `BITLAB_CONFIG_DIR` 控制；`~/.agents` 不受，写死在 `homedir()` 下。

选 `.agents/` 值得保留：它是 Codex 会扫描的跨工具共享目录，因此为 Bitlab 写的技能天然可移植。但注意 Pi 0.80.6 **不扫描**它（§1.2）。

### 1.2 模型为什么从来看不见技能

两道彼此独立的阻断，均已验证。

**阻断 A —— system prompt 覆盖把 Pi 拼好的技能目录整段丢弃。** [`system-prompt-override.ts:20`](../../packages/pi-agent-server/src/system-prompt-override.ts) 把会话的 `_rebuildSystemPrompt` 永久替换成 `() => prompt`。而这个方法（`pi-coding-agent@0.80.6 dist/core/agent-session.js:708-723`）恰恰就是 Pi 读取 `resourceLoader.getSkills()` 并交给 `buildSystemPrompt`、由后者追加 `formatSkillsForPrompt(skills)` 的地方。覆盖它 = 扔掉 Pi 组装好的技能目录。**即使技能路径接对了，模型依然什么都看不到。**

这个覆盖有它的现实理由——Pi 0.80.6 没有公开的按轮次 system-prompt API，且 `state.systemPrompt` 会在每次 `prompt()` 时被重置——但它伸手改了私有方法，而公开入口本可满足需求（§5.2）。

**阻断 B —— Pi 的默认扫描完全错过 Bitlab 的三层。** 在 0.80.6 中 `CONFIG_DIR_NAME` 解析为 `.pi`（`dist/config.js:394`），`loadSkills` 在 `includeDefaults` 下只扫两个目录：`<agentDir>/skills` 与 `<cwd>/.pi/skills`（`dist/core/skills.js:330-332`）。Bitlab 用的是 `.agents/skills` 与 workspace 目录，**没有任何一条在 Pi 的扫描范围内**。再加上 `agentDir` 被指向会话临时目录，默认扫描实际命中为零。

这条纠正一个常见误解：Pi 的公开文档确实描述了 `~/.agents/skills` 与 `.agents/skills`，但锁定的这个构建没有该能力。**本文全部内容以 0.80.6 现状为准**——Bitlab 三层路径必须全部显式注入。

**后果。** 技能只能手动点名。system prompt 硬编码了路径和 `[skill:slug]` 约定（[`system.ts:515`](../../packages/shared/src/prompts/system.ts)），却从不告诉模型有哪些技能存在。用户没点名的技能等于不存在——这把这个格式的前提整个倒过来了：`description` 存在的意义就是让 agent 自己判断相关性。

**死代码。** [`pre-tool-use.ts:186-271`](../../packages/shared/src/agent/core/pre-tool-use.ts) 把裸 slug 解析成 `pluginName:skillSlug`，注释里还引用 `.claude-plugin/plugin.json`——Claude Agent SDK 的词汇。Pi 后端不注册 `Skill` 工具，这段永不触发，却配着一整套测试装作在维护。

### 1.3 两套互不兼容的解析器

Bitlab 与 Pi 对"技能是什么"的理解不一致：

| | Bitlab `loadAllSkills` | Pi `loadSkills` |
| --- | --- | --- |
| 身份标识 | 目录 slug | frontmatter `name` |
| 碰撞胜者 | **后写者**获胜（最高层） | **首个加载者**获胜 |
| 扫描范围 | 仅工作目录本身 | 向上扫描祖先；跟随符号链接；遵守 ignore 文件 |
| 被遮蔽项 | 丢弃 | 保留为 `collision` 诊断 |
| 顺序 | global → workspace → project | `<agentDir>/skills` → `<cwd>/.pi/skills` → `additionalSkillPaths` |

两个直接卡住产品设计的后果：

- **简单追加 workspace 路径会把优先级弄反。** 因为 `additionalSkillPaths` 被拼在最后而且首个加载者获胜，把三层当额外路径注入的结果是 `global > project > workspace`，而不是产品要求的 `project > workspace > global`。§1.6 的探针输出就是这个现象。
- **`loadAllSkills` 撑不起 Installed 页。** 它只返回胜者（[`storage.ts:192`](../../packages/shared/src/skills/storage.ts)），§4 里的分层列表和 shadow warning 没有数据来源。

### 1.4 frontmatter 是自创方言

[`types.ts`](../../packages/shared/src/skills/types.ts) 定义了 `name`、`description`、`globs`、`alwaysAllow`、`icon`。只有前两个是标准字段。`globs` 与 `alwaysAllow` 会被解析和存储，但**在整个代码库里没有任何消费者**。标准字段 `license`、`compatibility`、`metadata`、`allowed-tools` 均未实现。

### 1.5 生命周期缺口

| 能力 | 现状 |
| --- | --- |
| 列表 / 读取 | `skills.GET`、`skills.GET_FILES` |
| 删除 | `skills.DELETE` —— **仅 workspace 层** |
| 打开编辑器 / 文件管理器 | `skills.OPEN_EDITOR`、`skills.OPEN_FINDER` —— **同样仅 workspace 层** |
| 创建 | 手动操作文件系统，或让 agent 写文件 |
| 安装 / 更新 / 启用 / 禁用 | 无 |
| 实时热更新 | 无——5 分钟 TTL 缓存（[`storage.ts:172`](../../packages/shared/src/skills/storage.ts)） |
| 校验 | `skill_validate` 会话工具，跨三层解析 |

所有变更类和跳转类操作都接收裸 slug 并按 `getWorkspaceSkillsPath` 解析，因此在 UI 上操作 global 或 project 层的技能要么静默无效，要么打错目标。

`deleteSkill`（[`storage.ts:274`](../../packages/shared/src/skills/storage.ts)）执行 `join(skillsDir, slug)` 后直接 `rmSync(..., { recursive: true })`，**既无路径 containment 校验，RPC 层也不做 slug 校验**。构造特殊 slug 即可穿越出技能目录。这是安全缺陷，不是设计缺口。

### 1.6 探针复现

夹具：`alpha` 同时放在 `<agentDir>/skills` 与经 `additionalSkillPaths` 传入的 workspace 目录；`beta` 放在 `<cwd>/.pi/skills`；另有一个技能放在 `<cwd>/.agents/skills`。

```
--- winners ---
gamma    /agentdir/skills/gamma/SKILL.md
alpha    /agentdir/skills/alpha/SKILL.md      ← agentDir 层压过了 workspace 副本
beta     /proj/.pi/skills/beta/SKILL.md
--- diagnostics ---
collision  name "alpha" collision  /ws/skills/alpha/SKILL.md
```

放在 `<cwd>/.agents/skills` 下的技能从未出现——证实阻断 B。`alpha` 的碰撞证实"首个加载者获胜"且 `additionalSkillPaths` 排在最后。

## 2. 生态已经收敛到什么

Agent Skills 是 Anthropic 开源的开放标准，目前已有 40+ 工具实现，包括 Pi、Claude Code、Codex、Cursor、Gemini CLI 与 Copilot。基本单元是一个目录，内含 `SKILL.md` 与可选的 `scripts/`、`references/`、`assets/`。

frontmatter 只有六个字段：

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | ≤64 字符，`[a-z0-9-]`，不可首尾连字符或连续连字符，须与目录名一致 |
| `description` | 是 | ≤1024 字符；说明做什么**以及何时使用** |
| `license` | 否 | 许可证名称或随包文件引用 |
| `compatibility` | 否 | ≤500 字符；环境前置要求 |
| `metadata` | 否 | 自由的 string→string 映射，供客户端存放私有数据 |
| `allowed-tools` | 否 | 空格分隔的预授权工具（**实验性**，各客户端支持不一） |

加载分三阶段渐进披露：启动时每个技能只载入 `name` + `description`（约 100 token），激活时载入完整正文（建议 <5000 token），随包文件仅在被引用时读取。

`metadata` 是标准指定的客户端扩展逃生口。

### 竞品横评

| | Pi 0.80.6（我们的后端） | Claude Code | Codex | 千问办公 | Bitlab 现状 |
| --- | --- | --- | --- | --- | --- |
| 发现位置 | `<agentDir>/skills`、`<cwd>/.pi/skills`、`additionalSkillPaths` | `~/.claude/skills`、`.claude/skills`（含嵌套）、插件 | `.agents/skills`（逐级向上）、`$HOME/.agents/skills`、`/etc/codex/skills`、内置 | `~/.qwenworkcn/skills` | `~/.agents/skills`、workspace、`.agents/skills` |
| 自动发现 | 有 | 有 | 有（`allow_implicit_invocation`） | 有 | **无** |
| 显式调用 | `/skill:name` | `/skill-name` | `$skill` / `@skill` | `/` 菜单 | `[skill:slug]` mention |
| 渐进披露 | 有 | 有 | 有 | 有 | **无** |
| 禁用而不删除 | — | `disable-model-invocation` | `config.toml` 的 `[[skills.config]]` | UI 开关 | **无** |
| 热更新 | — | 文件监听，无需重启 | — | — | 5 分钟 TTL |
| 分发 | `npm:` / `git:` 包，`pi install` | 插件市场 | `$skill-installer`、官方精选 | 市场 UI，含分类与下载量 | **无** |
| 创作辅助 | — | skill-creator | `$skill-creator` | `create-skill` 内置，对话式 | **无** |
| 套件 | packages（extensions + skills + tools） | plugins（skills + agents + hooks + MCP） | `agents/openai.yaml` 声明 MCP 依赖 | 专家套件——12 个职业预设 | **无** |
| 项目信任门控 | `project_trust` 事件 | 工作区信任弹窗 | — | — | **无** |

两个值得直接抄的设计：

- **Codex 的 `agents/openai.yaml`。** 把客户端私有的展示信息和策略放进旁挂文件，让 `SKILL.md` 保持规范纯净、可移植。Bitlab 用标准 `metadata` map 加自己的安装状态旁挂文件，能以更低成本拿到同样的隔离。
- **千问办公的安装漏斗。** 市场 / 内置 / 已安装三个 tab，分类加热门与最新排序，以及最关键的——安装前渲染 `SKILL.md` 原文。技能就是可执行的指令文本，落盘之前让用户看到它，这就是全部的安全叙事。

## 3. 设计原则

1. **单一 catalog，单一事实。** 由一个 `SkillCatalog` 统一负责发现、校验、信任、启停、优先级与 shadow 记账。UI 与 Pi 运行时消费同一份快照，否则必然漂移。
2. **标准优先，不养方言。** 原样采纳六个规范字段，Bitlab 私有数据放 `metadata.bitlab.*`。没有消费者的字段直接删掉，而不是迁移。
3. **走后端的公开接缝。** Pi 暴露了 `systemPromptOverride`、`skillsOverride`、`additionalSkillPaths`。第一次就是因为伸手改私有方法才坏掉的。
4. **安装是一次信任决策。** 技能会借模型之手执行代码。写盘前先预览，project 层受仓库信任门控，记录来源。
5. **文件系统仍是唯一事实来源。** 不引数据库。技能就是文件夹，UI 只是文件夹的视图。
6. **先做 Hub，再做市场。** 本地正确性（P0/P1）零服务端成本就有价值。

## 4. 产品设计

### 信息架构

```
Settings ─┬─ Connections
          ├─ Permissions
          ├─ Skills ──────┬─ Marketplace   registry, categories, install counts
          │               ├─ Built-in      shipped with Bitlab, always present
          │               └─ Installed     3 tiers, toggles, updates
          ├─ Bundles          (P4 — Skills + MCP + permission presets)
          └─ MCP
```

对话侧保留既有入口：`[skill:slug]` mention 菜单继续用于显式调用；原生通路打通后再加 `/skill-name`。

### 技能中心 — 已安装

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Skills                                        [ ⟳ ]  [ 🔍 Search    ]  [+ Add ▾]│
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   Marketplace    Built-in    ●Installed 12                    [Tier: All ▾]   │
│  ─────────────────────────────────────────────────────────────               │
│                                                                              │
│   PROJECT · bitlab-agent/.agents/skills            3 skills   [Reveal] [⋯]   │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📐  release-notes                                          [ ●━━ On  ] │  │
│  │     Draft release notes from the changelog and merged PRs.             │  │
│  │     v1.2.0 · git:github.com/acme/skills · updated 2d ago    ⟳ Update   │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ 🧪  test-triage                                            [ ●━━ On  ] │  │
│  │     Classify failing tests and propose the smallest fix.               │  │
│  │     local · edited 4h ago                                              │  │
│  ├────────────────────────────────────────────────────────────────────────┤  │
│  │ 🚀  deploy                          ⚠ shadows workspace:deploy         │  │
│  │     Run the staging deploy checklist.                      [ ━━○ Off ] │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   WORKSPACE · ~/.bitlab/workspaces/main/skills      6 skills   [Reveal] [⋯]  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📊  data-report        Turn a CSV into a visual report.    [ ●━━ On  ] │  │
│  │ 🚀  deploy             Run the staging deploy checklist.   [ ●━━ On  ] │  │
│  │                        now active — project copy is Off                │  │
│  │                                                    … 4 more  ▾         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│   GLOBAL · ~/.agents/skills                         3 skills   [Reveal] [⋯]  │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ 📄  pdf                Read, merge, split, fill PDFs.       [ ●━━ On  ]│  │
│  │                                                    … 2 more  ▾         │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**按层分组是刻意的**：层级决定优先级，而优先级恰恰是用户最容易搞错的东西。`deploy` 行的遮蔽警告把一个本来不可见的冲突变成明面信息；下方 workspace 行则展示了预期的降级语义——把 project 副本关掉，workspace 副本自动成为 winner（§5.4）。

`[+ Add ▾]` 展开三项：**通过对话创建** · **导入文件夹或 .zip** · **从 Git URL 安装**。

### 未信任项目

project 层技能在仓库被信任前不进入运行时（§5.6）。

```
┌────────────────────────────────────────────────────────────────────┐
│   PROJECT · bitlab-agent/.agents/skills      3 skills   ⚠ Untrusted│
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  This folder was not opened in Bitlab before. Skills here    │  │
│  │  can instruct the agent to run commands on your machine.     │  │
│  │                                                              │  │
│  │  release-notes · test-triage · deploy      [Review] [Trust]  │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### 市场

```
┌──────────────────────────────────────────────────────────────────────────────┐
│   ●Marketplace    Built-in    Installed 12                 [Popular│Recent]  │
│  ─────────────                                                               │
│   [All] [Writing] [Data] [Design] [Research] [DevOps] [Docs]           ▸     │
│                                                                              │
│   ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐│
│   │ 📊 data-report    [+]│ │ 📝 weekly-report  [+]│ │ ✨ humanizer-zh   [✓]││
│   │ Turn a CSV into a    │ │ Assemble a weekly    │ │ Strip AI tells from  ││
│   │ visual report.       │ │ status update.       │ │ Chinese copy.        ││
│   │ ⬇ 23K · Bitlab       │ │ ⬇ 18K · community    │ │ ⬇ 16K · installed    ││
│   └──────────────────────┘ └──────────────────────┘ └──────────────────────┘│
│   ┌──────────────────────┐ ┌──────────────────────┐ ┌──────────────────────┐│
│   │ 🎨 ui-designer    [+]│ │ 🔍 industry-research │ │ 🧩 mermaid        [+]││
│   │ Extract a design     │ │ Competitive and      │ │ Author and validate  ││
│   │ system from a ref.   │ │ market analysis.     │ │ Mermaid diagrams.    ││
│   │ ⬇ 1.8K · community   │ │ ⬇ 10K · community[+] │ │ ⬇ 9K · Bitlab        ││
│   └──────────────────────┘ └──────────────────────┘ └──────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 安装预览抽屉

安全面所在。在用户看到"将代表他执行的指令"之前，不往磁盘写任何东西。

```
┌────────────────────────────────────────────────────────────────────┐
│  ✕                                                                 │
│   🎨  ui-designer                                                  │
│       community · daymade · v1.0.0 · ⬇ 1.8K · Apache-2.0           │
│                                                                    │
│   Extract a design system from reference UI images and produce      │
│   implementation-ready prompts.                                    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ ⓘ  This skill declares allowed-tools:                        │  │
│  │      Read   Bash(git:*)                                      │  │
│  │    Safe mode and denied commands still prompt, always.       │  │
│  │                                              [What's this?]  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│   Contents                          Source of SKILL.md              │
│   ├─ SKILL.md              4.2 KB   ┌────────────────────────────┐ │
│   ├─ references/                    │ # UI Designer              │ │
│   │  └─ REFERENCE.md      11 KB     │                            │ │
│   └─ assets/                        │ ## Overview                │ │
│      └─ template.json     1.1 KB    │ Systematic extraction of   │ │
│                                     │ design systems from ref-   │ │
│   Install to                        │ erence images through a    │ │
│   ( ) Global    ~/.agents/skills    │ multi-step workflow:       │ │
│   (•) Workspace main                │ analyze → document → PRD   │ │
│   ( ) Project   bitlab-agent        │ → implementation prompts.  │ │
│                                     │                            │ │
│   ⚠ A skill named ui-designer       │ ## When to Use             │ │
│     already exists in Workspace.    │ - User provides UI screen- │ │
│     Installing overwrites it.       │   shots or mockups         │ │
│                                     └────────────────────────────┘ │
│                                        [ Cancel ]  [ Install ]     │
└────────────────────────────────────────────────────────────────────┘
```

四块信息缺一不可：元信息与许可证、`allowed-tools` 声明、文件清单与体积、`SKILL.md` 原文。`allowed-tools` 面板陈述技能索要什么：P0/P1 只展示不授予，P2 起变成按 Claude Code 语义的按轮次授权（§5.10）。无论哪个阶段，"safe 模式与被拒命令始终确认"这句都成立。

### 对话式创作

```
┌──────────────────────────────────────────────────────────────────┐
│  You  Every Friday I write a release note from the changelog.    │
│       Make that a skill.                                         │
│                                                                  │
│  ▸ Skill  create-skill                                           │
│                                                                  │
│  Bitlab  A few questions before I write it:                      │
│          1. Where does the changelog live?                       │
│          2. Should it read merged PRs too, or the file only?     │
│          3. Output as Markdown, or post it somewhere?            │
│                                                                  │
│  You  CHANGELOG.md at the repo root. File only. Markdown.        │
│                                                                  │
│  ▸ skill_write   release-notes → workspace                       │
│  ▸ skill_validate release-notes                       ✓ valid    │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ 📐 release-notes                          workspace · new  │  │
│  │ ---                                                        │  │
│  │ name: release-notes                                        │  │
│  │ description: Draft release notes from CHANGELOG.md. Use    │  │
│  │   when the user asks for release notes or a version        │  │
│  │   summary.                                                 │  │
│  │ metadata:                                                  │  │
│  │   bitlab.icon: "📐"                                        │  │
│  │ ---                                                        │  │
│  │ ## Steps                                                   │  │
│  │ 1. Read CHANGELOG.md at the repository root.               │  │
│  │ 2. Take entries under the topmost Unreleased heading.      │  │
│  │ …                                                          │  │
│  │                                                            │  │
│  │        [ Edit ]  [ Discard ]  [ Save to workspace ]        │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

草稿内联渲染，**保存是一次显式点击**。agent 只提议，绝不静默写盘。

## 5. 技术设计

### 5.1 最小模块集

三个小接口的深模块，取代当前散落的工具函数：

| 模块 | 接口 | 负责 |
| --- | --- | --- |
| `SkillCatalog` | `snapshot(context) → CatalogSnapshot` | 跨层发现、规范校验、信任过滤、启停、优先级、winner/shadow、诊断、revision id |
| `PiSkillBridge` | `apply(snapshot)` / `reload()` | 通过公开接缝把快照接入 Pi；显式调用注册 |
| `SkillInstaller` | `prepare(source) → InstallPlan` / `commit(plan, target)` | 隔离暂存、安全校验、diff、预览、原子落盘、来源记录 |

`CatalogSnapshot` 携带全部被发现的技能——**winner 与 shadow 都在**——每条带稳定 `skillId`、所属层、启停状态、信任状态与校验诊断。UI 直接渲染它，`PiSkillBridge` 把 winner 子集喂给 Pi。一份快照，两个消费者，不会漂移。

### 5.2 把 catalog 接进 Pi

本节的初版方案提出用 `sessionOptions.skillPaths`。**该字段并不存在。** 正确的接缝在 `DefaultResourceLoaderOptions` 上，而 [`BitlabMcpResourceLoader`](../../packages/pi-agent-server/src/mcp/resource-loader.ts) 本来就是委托给它的：

| 接缝 | 签名 | 用途 |
| --- | --- | --- |
| `noSkills` | `boolean` | 关掉 Pi 自己的扫描，避免 `.pi/skills` 注入未审查技能，顺序也由我们掌控 |
| `skillsOverride` | `(base) => { skills, diagnostics }` | 原样提供 catalog 的 winner 集合——彻底绕开 Pi 的首个获胜与 name 碰撞规则 |
| `systemPromptOverride` | `(base) => string \| undefined` | 把 Bitlab 的基础提示词作为 `customPrompt` 送进去，让 Pi 继续追加技能目录 |

```
  SkillCatalog.snapshot()          ← discovery + trust + enablement + precedence
            │
            ▼
  PiSkillBridge.apply(snapshot)
            │
            ├─ noSkills: true                    (Pi stops scanning on its own)
            ├─ skillsOverride: () => winners     (exact set, exact order)
            └─ systemPromptOverride: () => bitlabPrompt
            │
            ▼
  DefaultResourceLoader ─ getSkills() ─┐
                        ─ getSystemPrompt() ─┐
                                             ▼
  agent-session _rebuildSystemPrompt ── buildSystemPrompt({ customPrompt, skills })
                                             │
                                             └─ + formatSkillsForPrompt(skills)
```

`applySystemPromptOverride` 就此删除。它声称要解决的问题——扛住 `prompt()` 重置与工具变更重建——由 `systemPromptOverride` 天然满足，因为 loader 在每次重建时都会被重新询问，而不是被盖一次死。

**前置条件：resource loader 必须无条件存在。** 今天 `sessionOptions.resourceLoader` 只在 `if (mcpEnabled)` 分支里赋值（[`index.ts:894`](../../packages/pi-agent-server/src/index.ts)）；**MCP 一关，Pi 就用自己内部构造的 loader，上面三个接缝一个都挂不上**。也就是说该配置下整套接线不可达。

因此 P0 的第一步是把这个结构倒过来：loader 恒定构造、恒定传入，`mcpEnabled` 只决定要不要往上加 MCP adapter extension。这顺带修掉第二处不一致——`tools` allowlist 只在 MCP 模式下被省略，导致两种配置在"资源加载"和"工具激活"两个维度上都不同。

**已在 0.80.6 上验证。** 一份完全按上述接线编写的探针 10/10 通过——见 [§5.2.1](#521-探针结果)。`additionalSkillPaths` 倒序兜底用不上了。

读 SDK 时发现的另外两条约束：

- `buildSystemPrompt` 只在 `read` 工具处于激活状态时才追加技能段（`customPromptHasRead`）。Bitlab 的 allowlist 含 `read`，MCP 路径又整个省略 allowlist，两种配置都满足——但将来改动工具集不能把技能目录悄悄弄丢。值得加一条断言。
- `skillsOverride` 收的是 Pi 的 `Skill` 对象。catalog 必须产出这个形状，也就是要遵守 Pi 的身份规则（frontmatter `name`），尽管 Bitlab 的 UI 以 `skillId` 为键。两者的映射放在 bridge 里，不放在 catalog 里。

假如 `skillsOverride` 被证明与 Pi 内部耦合过深，退路本来是用 `additionalSkillPaths` 并**按相反顺序**传三层——Pi 的首个获胜正好产出 Bitlab 要的后写者获胜。探针证明这条退路用不上；此处保留记录，仅供将来 SDK 变更接缝时参考。

### 5.2.1 探针结果

夹具：`alpha` 同时存在于 project 与 workspace 两层，`beta` 在 global，另有一个诱饵 `leak` 放在 `<cwd>/.pi/skills` 下、绝不允许出现。catalog 在 Bitlab 侧按 `project > workspace > global` 构建，交给一个完全按上述配置的 `DefaultResourceLoader`，再把输出按 `_rebuildSystemPrompt` 的调用形状喂给 `buildSystemPrompt`。

| 断言 | 结果 |
| --- | --- |
| `noSkills: true` 压掉 `<cwd>/.pi/skills` | PASS —— `leak` 未出现 |
| `skillsOverride` 抵达 `getSkills()` | PASS —— 全集，原样 |
| **Bitlab 的优先级完整保留**（project `alpha` 获胜） | PASS —— Pi 的首个获胜规则未介入 |
| 被遮蔽项由 catalog 侧保留 | PASS —— Pi 无需知晓 |
| `systemPromptOverride` 抵达 `getSystemPrompt()` | PASS |
| 基础提示词在最终提示词中保留 | PASS |
| catalog 以 `<available_skills>` 注入 | PASS |
| 胜者的描述是 project 那份 | PASS |
| 被遮蔽者的描述不在提示词中 | PASS |
| `read` 工具缺席时 catalog 被**丢弃** | PASS —— 这道门是真的 |

三条值得带进实现的发现：

1. **优先级完全归我们。** 因为 `skillsOverride` 是**替换**已解析集合而非向其追加，Pi 的首个获胜碰撞规则根本不会运行。由 catalog 说了算，shadow 也就纯粹是 Bitlab 侧的概念——Pi 只收到 winner。
2. **`read` 门不是理论风险。** 传 `selectedTools: ['bash']` 时整个 `<available_skills>` 块**静默消失**。验收 8 必须是一条真断言，不能只写在注释里。
3. **`createSyntheticSourceInfo` 是构造 `Skill` 对象的受支持途径。** 它由包导出，因此 `PiSkillBridge` 不必手工伪造 `sourceInfo`。

组装出来的 catalog 长这样——注意 `<location>` 正是渐进披露成立的关键：常驻的只有名称、描述与路径，模型判断描述匹配后再用 `read` 加载正文。

```xml
<available_skills>
  <skill>
    <name>alpha</name>
    <description>PROJECT tier alpha (must win)</description>
    <location>/…/proj/.agents/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta</name>
    <description>GLOBAL tier beta</description>
    <location>/…/global/skills/beta/SKILL.md</location>
  </skill>
</available_skills>
```

第二份探针证实了 §5.4 关于 `disable-model-invocation` 的判断：带该标记的技能仍处于**已加载**状态，只是被 `formatSkillsForPrompt` 略去。**它是可见性标记，不是开关**——这正是 Bitlab 的启停必须作用在 catalog 这一层（高一层）的原因。

### 5.3 稳定身份

所有变更类与跳转类操作一律接收 `skillId`，不再接收裸 slug：

```
skillId := "<scope>:<canonical path to SKILL.md>"
           scope ∈ { global, workspace, project }
```

这样能区分跨层同名技能，能在展示用 `name` 改名后依然稳定，也让每个文件系统操作直接拿到一个已规范化的路径去校验。`skills.DELETE`、`OPEN_EDITOR`、`OPEN_FINDER` 全部改用它。

无论如何，边界处强制 containment：解析出规范路径，断言它位于该层根目录之下，否则拒绝。由 slug 推导路径的场合，先过现有的 `validateSlug` 再 `join`。

### 5.4 启停

按 workspace 存放于 `~/.bitlab/workspaces/<slug>/skills.json`：

```json
{
  "disabled": ["project:/repo/.agents/skills/deploy/SKILL.md"],
  "installed": {
    "workspace:/Users/me/.bitlab/workspaces/main/skills/release-notes/SKILL.md": {
      "source": "git:github.com/acme/skills@v1.2.0",
      "version": "1.2.0",
      "installedAt": "2026-08-14T02:11:00Z",
      "sha256": "9f2c…"
    }
  }
}
```

以 `skillId` 为键，因此跨层同名技能可独立开关。注意这里**没有** `grants` 映射：`allowed-tools` 是按轮次的授权，每次调用都从 frontmatter 重新推导（§5.10），不存在需要持久化的状态。

并发在这里是真问题：两个窗口同时切换不同技能，不能互相覆盖写入。读-改-写加原子 rename，或者加版本号重试，任选其一——但不能一个都没有（验收 13）。

**语义：禁用 = 从运行时候选集中完全排除。** 不是"仅不参与自动选择"——被禁用的技能也不能显式调用。这与 Pi 的 `disable-model-invocation` 不同（后者只压制模型侧选择，`/skill:name` 仍然可用）；把两者混为一谈会做出一个看起来毫无反应的开关。当某个名字的 winner 被禁用时，下一层自动升为 winner——所以**优先级必须在启停过滤之后计算，而不是之前**。

来源信息只存在这里，**绝不回写第三方 `SKILL.md`**，否则会让用来校验它的哈希失效。手写技能没有 `installed` 条目，这是合法状态。

### 5.5 RPC 面

| 通道 | 变化 |
| --- | --- |
| `skills.GET` | 返回完整 `CatalogSnapshot`——winner、shadow、诊断、信任状态、revision |
| `skills.DELETE` / `OPEN_EDITOR` / `OPEN_FINDER` | 改收 `skillId`；做 containment 校验 |
| `skills.SET_ENABLED` | 按 `skillId` 开关 |
| `skills.SET_PROJECT_TRUST` | 授予/撤销当前会话项目根的信任 |
| `skills.CREATE` | 先校验后写入 |
| `skills.PREVIEW` | 只 `prepare` 不 `commit`，为预览抽屉供数 |
| `skills.IMPORT` | 文件夹 / `.zip` / Git → prepare → 预览 → commit |
| `skills.MARKET_LIST` / `MARKET_INSTALL` / `UPDATE` | P3 |

### 5.6 项目信任

Pi 的 `SettingsManager` 在程序化使用时默认 `projectTrusted=true`，而 Bitlab 没有任何信任流程——因此一旦 project 路径接进去，克隆仓库里的 `.agents/skills` 就会未经审查直达运行时。[Agent Skills 客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)明确建议对 project 层做信任门控；Pi 有 `project_trust`，Claude Code 有工作区信任弹窗。

设计：信任按项目根粒度、持久化在 workspace 配置里，**默认不信任**。`SkillCatalog` 在未授予前把 project 层技能排除出 winner 集合，同时仍以"未信任"状态列出，供 UI 显示 §4 的横幅。授予是显式且可撤销的。

**这一项进 P0，不能推到市场阶段**——§5.2 一落地，暴露面就存在了。headless 与 WebUI 没有弹窗可用，见 §5.15。

### 5.7 热更新

当前的 watcher 缺口不只是"数据陈旧"：只刷新 UI 而不刷新运行时，比不刷新更糟，因为两者会各说各话。

```
file change (any tier)
      │
      ▼
SkillCatalog.snapshot()  → new revision id
      │
      ├──────────────► UI  (skills_changed event, carries revision)
      └──────────────► PiSkillBridge.reload() → loader reload → prompt rebuild
```

两个消费者要么一起走到同一个 revision，要么都不动。5 分钟 TTL 保留作为无法监听文件系统时的兜底。

### 5.8 frontmatter：采纳规范，清掉方言

```yaml
---
name: release-notes
description: Draft release notes from CHANGELOG.md. Use when the user asks for release notes.
license: Apache-2.0
compatibility: Requires git
metadata:
  bitlab.icon: "📐"
---
```

- `globs` 与 `alwaysAllow` **直接删除**，不做迁移。它们没有任何消费者，留着就是白养一套方言。
- `icon` 迁到 `metadata.bitlab.icon`。读取侧保留一个版本的顶层 `icon` 兼容——它有真实用户且成本只是一行 fallback；写入侧只产出标准形态。
- `allowed-tools` 解析并展示；P2 之前不授予任何权限，之后按 Claude Code 的按轮次语义生效（§5.10）。
- 按规范 `name` 须与目录名一致。校验器 warn 而非 fail，与 Pi 的宽松姿态一致。

### 5.9 安装事务

所有获取路径——文件夹、`.zip`、Git、市场、更新——走同一个模块，因为它们共享全部风险：

```
prepare(source) → InstallPlan          commit(plan, target)
  ├ fetch into an isolated staging dir    ├ atomic move into the tier
  ├ reject path traversal (../, absolute) ├ record provenance in skills.json
  ├ reject symlinks escaping the root     ├ invalidate catalog → new revision
  ├ enforce file count / size / depth caps└ rollback on any failure
  ├ validate SKILL.md against the spec
  ├ diff against an existing install
  └ collect risk signals for the drawer
```

索引里的 `sha256` 只能证明字节与索引一致，**不能证明来源可信**。能证明来源的只有对已知公钥的签名校验，那是 P3 的决策。

### 5.10 技能的工具权限

Bitlab 的权限模型里没有"按技能"这个维度。它只有三档模式（`safe` / `ask` / `allow-all`，规范名 `explore` / `ask` / `execute`）和一个 workspace 级 `permissions.json`（内含 `allowedBashPatterns` 与 `allowedWritePaths`）。技能没有任何办法说出"我需要 git"这件事让引擎听懂。

"`allowed-tools` 不授予任何权限"（§7.2）作为 v1 默认值是对的，但只有它会产生一个糟糕结果：一个要跑十条 git 命令的技能，用户每次都要点十次批准。而这恰恰就是这个字段存在的目的。

**审查本节时发现的关联缺陷。** `respondToPermission(requestId, allowed, _alwaysAllow)`（[`pi-agent.ts:1944`](../../packages/shared/src/agent/pi-agent.ts)）忽略第三个参数——那个下划线前缀是写实的。`PermissionManager` 维护着 `alwaysAllowedCommands` / `alwaysAllowedDomains` 两个集合，但 Pi 这条路径上没有任何地方调用过填充它们的方法。**"总是允许"在已发布的后端里是死的**，且与 Skills 无关，是独立缺陷，应单开一张单来修。

#### 竞品怎么做

**Claude Code** —— 这个字段的定义者：

- 授权覆盖**触发调用的那一轮**，并在**用户发出下一条消息时清除**。再次调用则重新应用。
- **只放宽，不收窄**。所有工具依然可调用；未列出的工具照常走权限设置。
- **用户调用与模型调用一视同仁**——文档原文是 "whenever you or Claude invoke the skill"，模型自主激活不做区别对待。
- 持久预授权明确**不是**这个字段的职责："要为整个会话预授权，请改为在权限设置里加 allow 规则。"
- deny 规则依然压过它——同族的 `disallowed-tools` 也无法在尚有其他工具时移除 `EndConversation`。
- workspace 信任**不**门控该字段，文档因此配了对应警告：仓库里签入的技能可以给自己授予宽泛权限，运行前应先审阅。

**Codex** —— 两条正交轴外加一个专用开关：

- `sandbox_mode`（`read-only` / `workspace-write` / `danger-full-access`）决定技术上能做什么；`approval_policy`（`untrusted` / `on-request` / `never`）决定何时暂停询问。
- granular 形态把 `skill_approval` 与 `request_permissions` 暴露为独立开关，运维方可以整体关掉"技能发起的授权"而不牺牲其余部分。

#### Bitlab 采纳什么

**原样采用 Claude Code 的语义**——Bitlab 本就使用同一套技能格式，分叉会让在两边搬运技能的人措手不及：

| 规则 | 出处 |
| --- | --- |
| 授权覆盖触发轮，用户下一条消息即清除 | Claude Code |
| 只放宽——未列出的工具保持常规确认 | Claude Code |
| 用户调用与模型调用一视同仁 | Claude Code |
| 既有 deny 路径依然压过它 | Claude Code；Bitlab 的模式系统本就如此 |
| 持久预授权归 `permissions.json`，不归技能 | Claude Code |
| 支持 `disallowed-tools` 作为收窄的对偶 | Claude Code（规范未定义） |
| 一个"允许技能预授权工具"的全局开关 | Codex 的 `skill_approval` |

两条 Bitlab 特有的绑定，都是从既有机制推导而来，而非本文发明：

- **`safe` 模式与 `DANGEROUS_COMMANDS` 依然压过一切。** 它们是 Bitlab 的 deny 路径，而 deny 在 Claude Code 里同样优先。声明 `Bash(rm:*)` 的技能，声明照常展示，调用照常弹确认。
- **未信任的 project 技能根本进不了运行时**（§5.6），因此它的 `allowed-tools` 无从生效。这比 Claude Code **更严格**——后者即便在未信任目录里也会应用 project 技能的授权，改用警告提示用户。Bitlab 的门控位置更靠上游，所以不需要那条警告；但这个差异是刻意的，值得写明，因为从 Claude Code 搬技能过来的用户会察觉。

**对 §5.4 的影响**：授权是按轮次的，且每次调用都从 frontmatter 重新推导，因此**没有任何东西需要持久化**。没有 `grants` 映射，没有同意面板，没有撤销 UI。整个功能就是：解析 `allowed-tools` → 本轮生效 → 用户下一条消息时丢弃。这比先前起草的流程小得多，并且整个删掉了一处需要存储状态的设计。

残余风险——技能给自己授予宽泛权限——按两家竞品同样的方式处理：安装前展示声明（§4）、deny 路径始终在其之上、给运维方一个开关整体关闭该机制。

推迟到 P2。P0/P1 只做声明与展示。

### 5.11 技能与 MCP

两个方向，目前都没设计。

**依赖 MCP server 的技能。** MCP 配置是 workspace 或全局级的（[`config/mcp.ts`](../../packages/shared/src/config/mcp.ts)，外加项目 `.mcp.json`），技能无法表达依赖，因此围绕 Playwright 或数据库 server 构建的技能在 server 缺席时会以令人困惑的方式失败。

沿用 Codex 的 `agents/openai.yaml` 思路，但留在标准的 `metadata` map 内：

```yaml
metadata:
  bitlab.requiresMcp: "playwright, postgres"
```

解析发生在 `SkillCatalog.snapshot()`——它本来就要读 workspace 配置——并为每个技能产出三态之一：`satisfied`、`missing`（未配置）、`disabled`（已配置但关闭）。各态行为：

- 预览抽屉与详情页列出依赖及其状态，并给出跳转 MCP 设置的链接。**允许**在依赖不满足时安装，只做标记——技能可能依然有用，拦住反而是家长式做派。
- 激活时，未满足的依赖会在注入的指令后追加一行：*"所需 MCP server `playwright` 不可用。"* 模型于是诚实降级，而不是幻觉出工具调用。
- **Bitlab 绝不代技能自动安装或自动启用 MCP server。** 那是比安装技能严格更大的信任决策，归用户。

**使用已存在 MCP 工具的技能**无需任何新东西——MCP 工具名为 `mcp__<server>__<tool>`，技能指令像引用其他工具一样引用即可。一条需要记录的注意事项：MCP 启用时 `tools` allowlist 被整个省略，因此两种配置下活跃工具集不同，**但 catalog 必须相同**——这就是验收 3。

命名冲突面：技能名活在 `/skill:<name>`，MCP 工具活在 `mcp__<server>__<tool>`，当前不冲突。若将来把 MCP prompts 也做成斜杠命令，就会冲突——落地之前需要一个命名空间决策。

### 5.12 随包脚本

规范认可 `scripts/`，Pi 与 Claude Code 都挂了"技能可能携带可执行代码"的警告。Bitlab 对此没有任何说法，实践中会坏三处：

- **执行路径。** 脚本通过 `Bash` 工具运行，因此和任何命令一样受权限模式约束——这是对的，但值得明说而不是留给读者推断。
- **写入路径。** `allowedWritePaths` 是 workspace 作用域。脚本往自己旁边写东西（缓存、中间文件）落在技能目录下，而那里未必可写；global 层技能位于 `~/.agents/skills`，压根在 workspace 之外。
- **解释器假设。** `scripts/extract.py` 假定存在某个 Python，而它可能不存在。这正是标准 `compatibility` 字段的用途；在预览抽屉里把它显示出来几乎零成本，却能挡掉一整类莫名其妙的失败。

P2 的最小立场：**脚本是数据，不是特权代码。** 只能经由常规工具路径执行；预览抽屉显式列出脚本及其体积；展示 `compatibility`。安装时不自动运行任何东西——安装期钩子会是本文档能提出的最危险的功能。

### 5.13 内置技能

§4 画了 Built-in tab 却没有定义它。需要拍板的：

| 问题 | 建议 |
| --- | --- |
| 放在哪？ | 作为应用资源随包发布，与文档工具并列；不写进 `~/.agents` |
| 用户能禁用吗？ | 能——复用 `skills.json` 机制，用保留的 `builtin:` scope 作键 |
| 用户技能能遮蔽内置吗？ | 能，且 Built-in 行要标明，对齐 Claude Code 的 bundled-skill 覆盖 |
| 应用更新时怎么办？ | 整体替换；不保留用户改动——这正是它们不可由用户写入的原因 |
| 算不算 catalog 成本？ | 算（§5.14）——庞大的内置集合不是免费的 |

`create-skill`（§4）本身就是内置技能，因此这张 tab 是 P2 的依赖项，不是装饰。

### 5.14 catalog 成本与会话漂移

**成本。** 渐进披露把正文挡在上下文之外，但 catalog 本身是常驻的：每个启用的技能都在每次请求里贡献 `name` + `description`。五十个技能按每个约 100 token 算，就是约 5K token 的常驻开销。新加的 context meter 已经拆出了 `systemTokens`（[`context-breakdown.ts`](../../packages/pi-agent-server/src/context-breakdown.ts)），所以成本是可测的——它还应当**可归因**，让用户看得见 catalog 占了多少并据此行动。这是"启用/禁用必须是真功能而非点缀"的最有力实证论据。

**漂移。** 会话的寿命长于技能。用过 `release-notes` 的会话，可能在该技能被编辑、禁用或删除之后被恢复；而 branch 会 fork 一个针对不同 catalog 构建出来的 Pi 会话文件。立场：**不追求追溯一致性**——记录本身就是当时发生的事实，改写它只会更糟。改为在每轮把 catalog revision 盖进会话元数据，这样诊断时能说清"这个会话跑在 revision X 上，当前是 Y"。记录成本极低，而这是让漂移可调试的唯一手段。

### 5.15 没有 UI 时的信任

§5.6 把 project 层默认设为不信任，并通过弹窗授予。而 headless server 与 WebUI 没有这个弹窗，于是照字面实现的话，**project 技能在那里将永久不可用**——一个披着安全外衣的功能倒退。

headless 需要一条显式的非交互通道：`BITLAB_TRUSTED_PROJECT_ROOTS` 环境变量，或 workspace 配置里的一份列表，要求运维方预先点名。默认仍是不信任；**没有 UI 不能悄悄变成"全部信任"，同样也不能变成"什么都跑不了"**。

## 6. 分期路线

| 阶段 | 范围 | 依赖 |
| --- | --- | --- |
| **P0 — 正确性** | resource loader 无条件构造（§5.2 前置条件）；`SkillCatalog` 成为唯一解析器；`PiSkillBridge` 走公开接缝；删除 `applySystemPromptOverride`；项目信任门控含 headless 通道；`skillId` + 路径 containment；删除 `Skill` 限定死代码；清掉 `globs`/`alwaysAllow`；UI↔运行时一致性测试 | 无 |
| **P1 — 管理** | 已安装 tab 按层分组含 shadow；启停与降级；按 `skillId` 精确删除/打开；完整 live reload（catalog revision → UI + 会话）；catalog 成本在 context meter 中归因；MCP 依赖解析与展示 | P0 |
| **P2 — 创作与导入** | `create-skill` 与 Built-in tab；`skill_write` 会话工具；`SkillInstaller` 支持文件夹 / `.zip` / Git；预览抽屉含脚本与 `compatibility`；校验结果上 UI；`allowed-tools` / `disallowed-tools` 按 Claude Code 语义实现，外加 `skill_approval` 开关（§5.10） | P1 |
| **P3 — 市场** | 静态注册中心、分类、安装/更新/卸载、来源展示、签名校验 | P2 |
| **P4 — 套件** | 对标专家套件：Skills + MCP servers + 权限预设作为一个单元安装 | P3、MCP 配置工作 |

**P0 是一个正确性版本**：它修掉一个安全缺陷、删掉死代码，并让这个功能真正做到它自己文档里声称的事。无论市场做不做，它都值得发。

### 验收清单

P0/P1 未通过以下测试即未完成：

1. 三层存在同名技能；project 副本获胜；另外两个在快照中以 shadow 出现。
2. 禁用 winner 后 workspace 副本升为 winner；三层全禁用后该名字从运行时彻底消失。
3. MCP 开与关两种配置下，catalog 逐字节一致（loader 路径不同，快照不能不同）。
4. 未信任的项目根对 winner 集合贡献为零，且其技能仍以未信任状态列出。
5. 编辑 `SKILL.md` 后，UI 与活跃会话报告同一个 catalog revision。
6. 含 `../../evil` 或逃逸符号链接的 `.zip` 在 `prepare` 阶段即被拒绝，落盘之前。
7. 规范路径逃出所属层根目录的 `skillId`，在删除、打开编辑器、打开文件管理器三处均被拒绝。
8. 当 `read` 不在 allowlist 中时，bridge 显式报错，而不是静默发出一个没有技能目录的提示词。
9. MCP 关闭时 resource loader 依然存在，三个接缝依然生效（§5.2 前置条件，也是验收 3 能通过的前提）。
10. 声明 `allowed-tools: Bash(rm:*)` 的技能，声明被展示、调用照常弹确认；`safe` 模式下一切授权失效。
11. 授权在触发轮生效，用户下一条消息后消失；再次调用重新应用。未列出的工具全程照常确认。
12. 声明了未配置 MCP server 的技能可以安装，依赖标记为 missing，激活时追加降级提示。
13. 两个窗口并发切换不同技能，`skills.json` 不丢任何一次写入。

## 6.1 明确推迟的项

记录在案，使其成为决策而非疏漏：

- **按技能选模型。** 便宜的技能可以指定 mini 模型。很诱人，但它与会话的模型路由和连接解析冲突；P3 之前不做。
- **`context: fork` / 子 agent 执行。** Claude Code 会把部分技能放进隔离上下文运行。Bitlab 已有会话派生能力，零件齐全，但它与权限、context meter 的交互本身就是一个独立设计。
- **多语言 description。** `description` 同时被模型和用户阅读，而仓库对 UI 文案强制 i18n parity。用中文写的技能在英文界面里就是中文。当前不在范围内，但市场一旦服务两个语区就会浮现。
- **激活遥测。** 知道哪些技能真的被触发会指导整个路线图，而这恰恰是需要先做隐私决策的那类数据采集。

## 7. 安全

### 7.1 安装期

1. **先预览，后写盘。** 渲染完整 `SKILL.md`，列出文件树。不存在静默安装，agent 发起的也不行。
2. **来源必须记录并展示。** 来源、版本、`sha256` 落在 `skills.json`。`local` 是一等的、不加标记的正常状态。
3. **安装与更新都校验完整性。** 对照索引校验；更新时先展示 `SKILL.md` 的 diff。
4. **不做自动更新。** 会自动更新的技能，等于一条配了漂亮图标的远程代码执行通道。
5. **暂存隔离且有上限。** 路径穿越、逃逸符号链接、压缩炸弹在 commit 之前被拒绝（§5.9）。

### 7.2 v1 的 `allowed-tools` 不授予任何权限

该字段在规范中仍是实验性的，各客户端支持不一，且 Pi 0.80.6 并未把它接入 Bitlab 的权限引擎。把它实现成真授权，意味着磁盘上一个文件就能预批 `Bash(*)`。

v1 行为：解析、在抽屉与详情页展示、**不授予**——每次工具调用照常走权限提示。§5.10 在 P2 采纳 Claude Code 的语义：授权覆盖触发轮、用户下一条消息即清除、只放宽、且永不越过 `safe` 模式与 `DANGEROUS_COMMANDS`。另有一个仿照 Codex `skill_approval` 的运维开关可整体禁用该机制。

### 7.3 项目信任

project 层技能在用户为该项目根授予信任之前一律不受信（§5.6），对齐 Pi 的 `project_trust` 与 Claude Code 的工作区信任弹窗。信任按根粒度、可持久化、可撤销、默认关闭。

## 8. 待定问题

1. **workspace 层要不要保留？** `{workspace}/skills/` 是 Bitlab 私有的，对其他所有工具不可见。统一到 `.agents/skills/` 更可移植，但会丢掉 [`CLAUDE.md`](../../CLAUDE.md) 视为长期上下文边界的 workspace 概念。建议保留，并明确记录它是 Bitlab 扩展。
2. **注册中心治理。** 只做官方精选，还是开放社区提交加审核？这是有持续成本的政策决策，它对 P3 的阻塞程度高于任何技术问题。
3. **`[skill:slug]` 留不留？** `/skill-name` 上线后会有两套显式调用语法并存。两套令人困惑；删掉又会打断肌肉记忆和既有会话历史。
4. **信任的作用对象是什么？** 仓库根，还是会话工作目录？在 monorepo 里两者不同，而 Bitlab 的 project 层今天是按工作目录取的。
5. **孤儿条目谁来清理？** 用户手工删掉技能目录后，`disabled` / `installed` 里会留下残条。在 `snapshot()` 时顺手清理很容易，但目录只是临时不可读时会静默丢状态。
6. **`skill_approval` 开关放在哪？** `permissions.json` 是自然归宿，因为它治理权限引擎；但那个文件是 workspace 作用域，而这个开关可能更该是全局的。

## 参考来源

- [Agent Skills 规范](https://agentskills.io/specification) · [总览](https://agentskills.io) · [客户端实现指南](https://agentskills.io/client-implementation/adding-skills-support)
- [Pi skills 文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md) · [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Claude Code skills](https://code.claude.com/docs/en/skills)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [千问办公 skills](https://qwenwork.cn/docs/features/skills) · [阿里云帮助中心](https://help.aliyun.com/zh/qwenwork/skills)
