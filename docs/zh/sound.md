# 界面提示音

当某件你本来必须盯着屏幕才能发现的事情发生时，Bitlab 会播放一声短提示：一轮回答结束了、Agent 卡在等你审批、消息已经发出去了。声音永远是附加信号——每个 cue 都有对应的视觉、文字和 ARIA 反馈，关掉声音后它们完全不变。

音效来自 [`uisfx`](https://uisfx.com/)，使用 **`minimal`** 音色包（"干、准、几乎无存在感"）。该库在运行时用 Web Audio API 合成每一个 cue；不打包、不下载、也不写入任何音频文件，因此离线可用，安装包体积不受影响。

Electron 与 WebUI 共用同一套 renderer，以下内容对两端同时生效。

## 哪些事件会发声

| 事件 | Cue | 触发时机 |
|---|---|---|
| 发送消息 | `send` | 提交处理函数内 |
| 流式进行中发送（排队） | `queued` | 同一处理函数，会话正在处理时 |
| **回答完毕** | `complete` | 收到 `complete` 会话事件 |
| 出错 | `error` | `error` 或 `typed_error` |
| 被中断 | `stop` | `interrupted` 事件——不在 Stop 按钮上播 |
| **等待审批** | `warning` | 收到工具权限或 admin 审批请求 |
| 批准通过 | `unlock` | 后端确认响应之后 |
| 拒绝 | `cancel` | 后端确认响应之后 |
| 删除会话 | `delete` | 删除提交完成之后 |
| 远程连接重连中 | `connecting`（循环） | `connecting` / `reconnecting`，仅 remote transport |
| 远程连接恢复 | `connect` | 循环停止，且此前确实掉过线 |
| 远程连接断开 | `disconnect` | `disconnected` / `failed` |
| 按键 | `typing` | 每个本地文本输入 `input` 事件；默认关闭 |

结果类 cue 一律在「工作真正结束的那个事件」上播，而不是在「请求它的那次点击」上播，因此每一声都是对状态的真实陈述。

标记为 `hidden` 的会话（mini-agent 会话）全程静音，与系统通知使用同一套过滤规则。

### 刻意不发声的部分

hover、列表选中、Tab 与面板切换、滚动、后台刷新、toast、禁用状态的控件。Agent 工作期间也**没有** `processing` 常驻循环音——那东西一响就是好几分钟。

## 偏好设置

**设置 → App → 声音**

| 控件 | 默认值 | 作用 |
|---|---|---|
| 界面提示音 | 开 | 总开关 |
| 音量 | 适中（0.7） | 轻 0.4 / 适中 0.7 / 响 1.0 |
| 按键音 | 关 | 为本地文本输入加上 `typing` cue |

偏好存于 `localStorage`，和主题、外观等其他「按设备」偏好放在一起，而不是主进程的设置文件——扬声器属于你正坐在前面的这台机器，所以桌面端窗口和手机上的 WebUI 标签页本来就应该各管各的。

| Key | 取值 |
|---|---|
| `craft-sound-enabled` | `true` \| `false` |
| `craft-sound-volume` | `0`–`1` |
| `craft-sound-typing` | `true` \| `false` |

`prefers-reduced-motion` 不被当作音频偏好。

## 实现结构

| 模块 | 职责 |
|---|---|
| [`lib/sfx/cues.ts`](../../apps/electron/src/renderer/lib/sfx/cues.ts) | 事件 → cue 映射与连接状态归约。不含 React，不含 player |
| [`lib/sfx/controller.ts`](../../apps/electron/src/renderer/lib/sfx/controller.ts) | 解锁闸门、循环注册表、按 cue 冷却 |
| [`lib/sfx/player.ts`](../../apps/electron/src/renderer/lib/sfx/player.ts) | 模块级单例、首次手势解锁、销毁 |
| [`lib/sfx/preferences.ts`](../../apps/electron/src/renderer/lib/sfx/preferences.ts) | 唯一的持久化接缝，player 与 atom 都经由它读写 |
| [`atoms/sfx.ts`](../../apps/electron/src/renderer/atoms/sfx.ts) | 供设置界面使用的偏好状态 |
| [`hooks/useSfx.ts`](../../apps/electron/src/renderer/hooks/useSfx.ts) | `useSfx`、`useSfxPreferences`、`useSfxRuntime` |

### 解锁

加载时零发声。一个 capture 阶段的 `pointerdown` / `keydown` 监听器会在首次真实手势时 resume `AudioContext`。在此之前，异步 cue 会被**直接丢弃而不是排队**——否则你的第一次点击会听到十分钟前那次重连的回声。手势类 cue（`send`、`typing`、设置面板里的控件）在各自的处理函数中同步播放。

### 生命周期

player 是模块级单例而非组件状态：React Strict Mode 的双挂载和面板重挂载都不会产生第二个 `AudioContext`。它只在 `pagehide` 时销毁一次。`AudioContext` 由 `uisfx` 自行创建，因此不存在需要额外 `close()` 的调用方自持 context。

### 循环音

`connecting` 是唯一的循环音。启动是幂等的；成功、失败、静音、切换 workspace、组件清理和销毁这些路径都会停止它并清空句柄。切换 workspace 会先 `stopAll()` 再重新断言循环状态，因此界面上还在重连的连接不会变成「横幅在转但没声音」。

### 冷却

`send` 与 `queued` 有 150ms 冷却，用于吸收「同一次激活同时触发指针与键盘处理」的重复播放。结果类 cue 冷却 400ms，让同一 tick 内结束的多个会话只发一声。`typing` 永不节流。

## 测试

`apps/electron/src/renderer/lib/sfx/__tests__/` 覆盖语义映射、cue 时机、解锁前的静音抑制、循环的幂等性与全退出路径清理、静音持久化、指针/键盘去重、重挂载时的单例复用，以及无 `window` 环境下降级为静音。其中一条测试会用 `uisfx` 自带的 recipe 渲染器把应用引用到的每个 cue 真实渲染一遍——上游若删改了某个 cue 名字，红的是测试而不是应用。
