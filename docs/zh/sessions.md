# 会话

会话通过 `session.jsonl` 保存会话头和消息快照，Pi 恢复数据存在同一会话目录下。Desktop 与 WebUI 通过后端读写同一份会话数据；客户端状态不是持久化事实来源。

每个 AI 回复的耗时与速度统计见 [AI 消息时延统计](#ai-message-latency-design)。

## 磁盘布局

```text
~/.bitlab/workspaces/<slug>/
  config.json                              # workspace 设置(主题、默认 mode、...)
  skills/                                  # workspace 级别 Skills
  permissions/                             # 默认 + workspace 覆盖
  sessions/
    <session-id>/
      session.jsonl                        # 会话头 + StoredMessage 快照
      .pi-sessions/                        # Pi SDK 恢复数据
      attachments/                         # 用户附件(沙盒路径)
```

继续已有会话沿用 session id；创建分支会分配新 session id，再复制截止指定消息的会话内容。

当前 JSONL 格式与运行时事件协议是两套不同的数据结构：

| 数据 | 存储 / 传输方式 | 定义 |
|---|---|---|
| `SessionHeader` | `session.jsonl` 第一行 | 会话配置、列表元数据、会话级 token 用量 |
| `StoredMessage` | 第二行起，每行一条消息 | 正文、角色、工具字段、消息级元数据 |
| `SessionEvent` | RPC 推送，不直接逐条写成 JSONL 行 | 流式文本、消息完成、工具状态、会话完成等更新 |
| Pi 原生会话 | Pi 管理的独立文件 | 模型恢复、原生分支等 SDK 状态 |

当前持久化队列合并内存快照后写入临时文件，再替换 `session.jsonl`，不是 append-only 事件日志。格式以 [`jsonl.ts`](../../packages/shared/src/sessions/jsonl.ts)、[`persistence-queue.ts`](../../packages/shared/src/sessions/persistence-queue.ts) 和 [`Message / StoredMessage`](../../packages/core/src/types/message.ts) 为准。

只有通过 `sessions:import` RPC 物化为已注册、可打开的会话,导入才算完成。导出包不包含 API key、代理凭证或加密凭证数据。

## 生命周期操作

- **Create:** 后端创建会话配置，分配 id 并保存初始会话快照。
- **Continue / resume:** 后端恢复会话消息，通过 Pi 执行下一轮；不通过 tail 事件日志重建运行状态。
- **Cancel:** `POST session.cancel` 停掉飞行中的轮次;Pi 恢复文件保留未完成的 tool call。
- **Search:** 内置索引支持 `query`、`in:title`、`state:`、`view:` 过滤(Views 见下文)。
- **Rename:** 更新会话名称并保存包含新元数据的会话快照。
- **Delete:** 在 `~/.bitlab/workspaces/<slug>/sessions/.trash/` 暂存目录,过期后清理。
- **Flag / archive / unread:** 元数据标记保存在会话头中，列表不必加载完整消息。
- **Import / export:** 可移植 bundle 格式,封装 `session.jsonl` 加附件。导入前必须通过 `SessionBundle` 验证。
- **Branch:** 复制 `session.jsonl` 到选定 message id,分配新 session id,并回退 Pi 恢复状态,使新分支能从该点 `Continue`。
- **Multi-window:** 同一会话可被多个客户端打开；客户端通过后端快照和事件更新，不应自行 tail 或写入 `session.jsonl`。

## 技术状态

| 状态 | 触发 |
|---|---|
| `idle` | 没有飞行中的 turn |
| `processing` | 用户/助手 turn 正在或排队执行 |
| `waiting_for_permission` | Pi 请求权限;renderer 显示确认弹窗 |
| `failed` | 上一个 turn 因未处理错误结束 |
| `interrupted` | 进程中途退出(Electron 退出、Pi 崩溃) |

## 内置 Views

Views 以 Filtrex 表达式的形式存在 `~/.bitlab/workspaces/<slug>/views.json` 中。evaluator 只允许存活在 Lite 边界内的字段:

```text
hasUnread == true            # 未读
isFlagged == true            # Flagged
isArchived == true           # Archived
isProcessing == true         # 运行中
hasPendingPlan == true       # 待计划审核
permissionMode == "safe"     # 当前 workspace 默认只读
```

schema 为兼容历史可保留 label/status 字段,但这些条件已 no-op,因为 Bitlab 没有用户自定义 label 或 status。UI 暴露固定五个按钮(未读、Flagged、运行中、Archived、计划审核),**不**提供自定义 View 编辑器。

## Pi 恢复

Pi 子进程把自己的临时状态存在 `sessions/<id>/.pi-sessions/` 下。Bitlab 不解析这些文件,只在 resume 时把它们原样还给 Pi。想要完全 hermetic 的恢复测试,可以走 `SessionManager` 的 hook 注入路径。

## 会话内的权限

每个 Pi 工具调用都经过统一的权限引擎(`@bitlab/shared/agent/permissions-config`)。被拒的调用会以错误事件落到 JSONL,turn 在 `failed` 收尾;通过的继续。详见 [permissions.md](./permissions.md)。

## 审计会话

审计时应区分消息快照与原始执行事件：`session.jsonl` 保留消息顺序及其持久化字段，但不能据此还原每个流式 chunk 的到达时间。不要仅凭相邻消息的 timestamp 推算模型时延。

---

<a id="ai-message-latency-design"></a>

## AI 消息时延统计

每个聊天回复底部有一个「用时 N 秒」入口，展开是本轮的总用时、输出速度、首次调用 TTFT 和模型调用次数。数据随消息持久化，刷新、切换会话、重启后一致。

### 领域对象

| 对象 | 含义 |
|---|---|
| **Run** | 后端对一次用户请求的完整 Agent 执行，含多次模型调用和工具调用 |
| **Request** | 一次 Pi `streamFn` 调用。这是 SDK 调用单位，不是一个物理 HTTP 请求——provider 内部重试包含在同一次调用内 |
| **Message** | 展示与持久化的单条消息。同一次 Request 产生的思考块和正文共同引用它 |

```text
用户消息 U1 持有 Run R1
  Request Q1 → 思考 M1 + 中间正文 M2 + 工具调用
  Request Q2 → 仅工具调用
  Request Q3 → 思考 M3 + 最终正文 M4
```

M1、M2 的 `executionRef` 都指向 R1/Q1，所以 Q1 的 usage 不会被算两次。

### 计时口径

| 指标 | 起点 | 终点 | 含 / 不含 |
|---|---|---|---|
| Run `durationMs` | `runTurn` 开始，创建或恢复 Agent 之前 | 本轮执行实际停止 | 含初始化、上下文、模型、工具、审批、压缩、重试；不含排队和最终落盘 |
| Request `durationMs` | 调用原 `streamFn` 前 | 响应终态或调用失败 | 含鉴权、provider 内部等待与重试；不含前置上下文转换和后续工具执行 |
| Request `ttftMs` | 同上 | 第一个有效输出增量 | 不是收到 HTTP headers，也不是 renderer 首次绘制 |
| Request `decodeMs` | 第一个有效输出增量 | 响应终态 | 客户端观测的输出阶段，含末尾 finish/usage 等待，不是 GPU decode 时间 |

口径标识固定为 `measurement: 'sdk-call-v1'`。`startedAt` / `endedAt` 是 epoch 毫秒，只供阅读；所有时长由采样进程的单调时钟测得后持久化为毫秒数值，**不跨进程相减单调时钟，不在重启后用 wall clock 重算**。

**有效首输出**：非空 `text_delta`、非空 `thinking_delta`、非空工具参数增量，或 provider 首次给出工具名称。role、usage、空字符串、start/finish 等元事件都不算。只有最终完整消息、没有观察到任何有效增量时，保留调用耗时，TTFT/decode/TPS 缺失——不把完整返回时刻冒充首 token 时刻。

### 聚合规则

```text
S = status 为 completed，且 outputTokens 有限非负、decodeMs 有限为正的请求集合
runTPS  = sum(S.outputTokens) / (sum(S.decodeMs) / 1000)
runTTFT = sequence 最小的请求的 ttftMs
```

- 先求和再相除，不是对各次速率取算术平均。单次 decode 窗口极短的调用（模型只吐了工具参数就结束）会算出几十万 tok/s，加权求和天然不受它影响。
- `S` 为空时 TPS 缺失；有零输出的有效样本时允许显示 0 tok/s。
- error / aborted / interrupted 不参与 TPS 样本，耗时和状态仍然保留。
- 首次调用没有 TTFT 时整轮 TTFT 缺失，不跳到第二次，也不取最小值或平均值。
- 部分请求不满足 TPS 条件时显示「基于 X/Y 次模型调用」。
- `durationMs`、`ttftMs`、`decodeMs` 是测量事实；TPS、计数、总 token 是派生值，不另存一份会漂移的汇总。
- 校验拒绝 NaN、Infinity、负时间、负 token。缺失不等于 0；未知 schema 或损坏指标不影响正文加载，统计区降级为不可用。

### 数据结构

类型定义见 [`packages/core/src/types/execution-metrics.ts`](../../packages/core/src/types/execution-metrics.ts)，纯汇总与分支裁剪见同包的 [`utils/execution-metrics.ts`](../../packages/core/src/utils/execution-metrics.ts)。`Message` 与 `StoredMessage` 各增加两个可选字段：

| 字段 | 所有者 | 不变量 |
|---|---|---|
| `agentRuns` | 触发 Run 的原始用户消息 | 同一 runId 只有一个 owner；重新执行追加新 Run，不覆盖旧记录 |
| `executionRef` | 正文、思考、工具及执行期间新增的关联消息 | requestId 若存在，必须属于对应 runId |
| `runId` | SessionManager 在执行开始时生成 | 稳定随机 ID，跨重启不复用进程内计数 |
| `requestId` | 子进程在 `streamFn` 调用开始时生成 | 每次调用唯一，不复用 provider message id |
| `sequence` | Run 内的请求顺序 | 从 1 递增，失败和没有正文的请求也占号 |
| `revision` | SessionManager 的 Run 状态更新 | 每次权威变更递增，客户端不可自行递增 |

中途 steer 的用户消息只通过 `executionRef` 引用当前 Run，不复制 owner 的 `agentRuns`。指标不进入 SessionHeader、不写入 Pi 提示词、不塞进工具返回值——[集成测试](../../packages/shared/src/agent/__tests__/pi-conversation-flow.integration.test.ts)断言模型 payload 里没有这些字段。

### 采集链路

```text
streamFn 包装层 (子进程)         ── 测量：duration / TTFT / decode / usage
  └─ llm_request_started/completed
       └─ PiEventAdapter 透传
            └─ SessionManager  ── 归属：runId、sequence、messageIds
                 ├─ Message → StoredMessage → session.jsonl
                 └─ run_metrics_updated → 客户端 reducer
```

**子进程**（[`llm-request-timing.ts`](../../packages/pi-agent-server/src/llm-request-timing.ts)）包住 session 原有的 `streamFn`：原函数继续负责鉴权、headers、timeout 和 provider retries，包装层只掐表；流对象原样返回，不额外消费一次流。压缩走同一个 `streamFn`，用 `session.isCompacting` 排除在采样外——压缩耗时仍计入 Run 总时长，恢复后的模型调用是新的 Request。子进程只测「一次 SDK 调用」，不知道 Run 的存在。

**主服务**（[`run-metrics.ts`](../../packages/server-core/src/sessions/run-metrics.ts)）持有当前 Run 的运行时控制对象，负责归属、绑定消息 ID、递增 revision、在 `runTurn` 的统一收尾路径结算一次。一个子进程只服务一个会话，会话内的 Run 严格串行，所以归属不需要额外的 ID 传递；`call_llm` 与标题生成走独立的 ephemeral session，根本不经过被插桩的 `streamFn`。

一次响应结束时的顺序：子进程确定终态 → 适配层输出 thinking/text complete 或错误事件 → 主服务分配 messageId 并关联到 Request → 输出 `llm_request_completed`（即使没有任何正文也输出）→ 提交快照 → 向客户端发布。

**客户端**收到 `run_metrics_updated` 快照，按 ownerMessageId/runId upsert，只接受更高 revision；相同 revision 幂等，较低 revision 忽略。事件同时携带 `ownerMessageId`（服务端 canonical id）和 `ownerOptimisticMessageId`（客户端自己铸的乐观 id），reducer 匹配任意一个——[`handleUserMessage`](../../apps/electron/src/renderer/event-processor/handlers/session.ts) 刻意不把用户消息的 id 换成 canonical id（换了会让 `UserMessageBubble` 重新挂载、冲掉本地状态），所以协议里所有指向用户消息的服务端事件都必须提供乐观 id。

### 持久化与恢复

提交点：Run 开始（执行模型前保存 owner + running Run）、Request 开始（入队，受 debounce 控制，不为模型调用增加磁盘握手）、Request 收口（在 `runTurn` 的顺序消费者里 `await flush`）、Run 收口（显式 flush）、程序退出（`flushAll`）。首输出只在 tracker 内记录，不单独落盘。

[持久化队列](../../packages/shared/src/sessions/persistence-queue.ts)为此做了三项加固：定时写入与显式 flush 共用每 session 单 writer；`flush` 会等待已经离开队列、仍在飞行中的写入；`enqueue` 深拷贝 `agentRuns`，入队后继续修改内存 Run 不会改变待提交内容。替换不再先 unlink 目标，只有 Windows 上 rename 被拒时才回退到先删再改名。

写失败当前记日志、保留旧文件与内存结果，下次保存重试最新快照，**不向 flush 调用方传播**（见下方取舍）。已发生的模型或工具工作不因保存失败自动重试。

恢复由服务端在加载会话时执行，不由 renderer mount 判断——客户端断开不代表 Agent 停止。遗留的 running Run / Request 标为 `interrupted`；**没有可信结束时刻时不填 endedAt，不把停机时间计入 duration**。恢复幂等，第二次加载不再改动 revision。未知 schema 不猜测迁移、不删除原数据，正文照常读取。

### 生命周期边界

- **取消**：stop 只标记意图并发出 abort，实际停止时才记录结束时间，所以耗时包含停下来花的时间。完成回调不得覆盖 aborted。
- **重试**：同一 `streamFn` 内的 HTTP retries 计入同一个 Request，不编造 retryCount。SDK 重新调用 `streamFn` 时创建新 requestId，sequence 递增，前次失败保留。
- **overflow 恢复**：跨越中间 `agent_end` 时继续当前 Run，压缩耗时计入 Run，恢复调用计入新 Request。
- **空响应**：provider 返回 `stop` 但内容为空且没有观察到任何输出增量时，采样端与 `empty_response` 的业务判定一致标记为 error——否则一轮什么都没产出的调用会计入模型速度。
- **截断**：保留 provider 的 `finishReason`，它不同于用户 abort；有可信 usage 时仍参与 TPS。
- **排队**：只有用户消息，不建立 running Run；实际出队后才创建。
- **steer**：成功交给当前 Agent 时新增用户消息引用当前 runId，统计仍由原 owner 持有；未送达退回队列时不提前关联，实际执行时创建新 Run。
- **分支**：`trimRunMetricsForBranch` 在复制后的消息上重建指标。只有一次调用产出的消息和工具全部落在前缀内，或有更后的完整调用可证明它先于截断点结束，才保留完整读数；卡在思考与正文之间的调用保留关联、丢弃读数。被截断的 Run 置 `coverage: 'branch-prefix'` 并移除总时长，不伪造一次新的执行终态。源会话（含嵌套数组）不被修改。
- **导入导出**：新增字段是可选扩展，旧会话不需要迁移。导出只带模型标识、时间、数字和消息关联，不带 headers、密钥或凭证。旧会话没有原始测量，显示未记录——**禁止用消息 timestamp、发送时间或文字长度回填**。

### 展示

```text
复制    Markdown    用时 28 秒

本轮用时与速度
总用时                      28 秒
输出速度                    314 tok/s
首次模型调用 TTFT            1.3 秒
模型调用                    6 次
```

- 整轮最终回复处一个主入口。一个 Run 被 steer 拆成多张卡片时，入口只出现在最后一张。
- 没有最终正文的错误、取消、仅工具轮次，入口放在该 Run 最后一个现有活动区域。
- 运行中显示「执行中…」，不加持续跳动的客户端秒表。
- 旧消息不显示入口。非完整 TPS 样本显示覆盖数，分支保留部分记录时显示提示；失败/取消只展示已知读数，不展示 Infinity 或 NaN。
- Desktop 与 WebUI 共用 [`TurnTimingDetails`](../../packages/ui/src/components/chat/TurnTimingDetails.tsx)。`compactMode` 会隐藏桌面操作栏，所以窄屏另有一行独立入口。时长与数值格式化集中在 [`timing-format.ts`](../../packages/ui/src/components/chat/timing-format.ts)，用 `Intl.NumberFormat` 和 locale 字典，单位不写死在 JSX。

### 已知取舍

**不展示逐次调用明细。** 每次调用的 duration / TTFT / TPS / 状态都已采集并写进 `session.jsonl`，只是不渲染。原因有二：一轮六次调用就是六段三行文本，把「这轮花了多久」这个真正的问题淹掉；且单次 decode 窗口可以短到 0.3 毫秒，85 token 除下去是 32 万 tok/s——技术上合法，摆到用户面前是噪声。整轮 TPS 的加权求和不受影响，逐行展示没有这层保护。要恢复明细面板不需要改采集层。

**写失败不向调用方传播。** `flushSession` 有大量 `await` 调用点（发消息、改元数据、分支），让它开始抛错会改变这些路径的产品行为，还需要配套一套「统计尚未保存」的错误展示。这是独立的产品决定，没有夹带在本功能里。

**owner 两个 id 都匹配不上时丢弃快照**，不触发会话快照补取。这只可能发生在客户端状态已经不一致时，而下一次会话加载本来就会带回完整指标，不值得为此建第二个待定 Run 的 store。

**不承诺的东西**：不提供物理 HTTP 重试次数、GPU 推理时间、纯网络耗时或浏览器首屏绘制时延；不统计生成标题、`call_llm` 等辅助调用；不获取 pi-subagents 内部没有透传出来的逐条消息；不存每个 token 的时间序列；断电级零丢失不在保证范围内（fsync、目录同步、跨文件事务都没做）。

### 测试

精确数值全部由注入 fake clock 的单测覆盖，不用 sleep 后比较真实毫秒数；真实子进程集成测试只断言因果顺序、读数存在性与合理范围。

```sh
bun test packages/core/src/utils/__tests__/execution-metrics.test.ts        # 汇总公式、校验、分支裁剪
bun test packages/pi-agent-server/src/llm-request-timing.test.ts            # 采样状态机、首输出判定、时钟回拨
bun test packages/server-core/src/sessions/run-metrics.test.ts              # Run 生命周期、幂等恢复
bun test packages/shared/src/sessions/__tests__/execution-metrics-roundtrip.test.ts
bun test packages/shared/src/sessions/__tests__/persistence-queue-writer.test.ts
bun test packages/ui/src/components/chat/__tests__/turn-run-metrics.test.ts
bun test apps/electron/src/renderer/event-processor/handlers/__tests__/run-metrics.test.ts
bun test packages/shared/src/agent/__tests__/pi-conversation-flow.integration.test.ts  # 真实 Pi 子进程
```
