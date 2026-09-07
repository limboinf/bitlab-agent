# 消息内生成媒体预览设计

状态：**设计待评审**。

最后更新：2026-09-07。

本文设计 AI 生成图片、视频和音频后，如何在对应的 Assistant 消息内直接预览。它建立在[产物中心技术设计](./artifact-center-design.md)之上：产物中心负责识别和组织文件，本设计负责把媒体产物安全、稳定地投影到消息流。

## 1. 结论

首版支持三类本地媒体产物：

| 类型 | 消息内表现 | 点击后 | 默认行为 |
| --- | --- | --- | --- |
| 图片 | 缩略图网格，可显示尺寸 | 复用图片预览 Overlay | 不自动播放、不放大占满消息 |
| 视频 | 海报帧 + 播放控件 | 消息内播放；点击进入大图播放器 | 不自动播放，默认静音 |
| 音频 | 音频卡片、时长和进度 | 消息内播放 | 不自动播放 |

核心决策：

1. **生成结果先落盘，再被消息引用。**不把视频、音频或原图 Base64 写进 JSONL 消息；消息只保存稳定的媒体引用和展示元数据。
2. **媒体消息是产物的投影，不是第二套文件系统。**来源仍是成功的结构化工具结果和会话输出目录；消息只记录哪个 Turn 关联了哪些媒体。
3. **统一一个 MessageMediaPreview 模块。**图片、视频、音频共享加载、权限、缺失和错误状态；具体播放器由类型 Adapter 承担。
4. **预览失败必须可解释、可恢复。**文件缺失、编码器不支持、权限拒绝与生成失败分别显示；可打开系统应用时提供兜底入口。

## 2. 背景与现状

Bitlab 已有：

- Message / JSONL 持久化和 Turn 聚合；
- SessionArtifact 派生、ProducedFilesRow 和 RightDock 产物入口；
- classifyFile、useLinkInterceptor、ImagePreviewOverlay；
- READ_DATA_URL、READ_PREVIEW_DATA_URL 和文件 allowed-root 校验；
- 用户附件的缩略图展示，但它只覆盖 User 消息，不代表 Agent 生成媒体。

当前缺口：

1. classifyFile 将 mp4、mov、mp3 等媒体全部交给系统应用，消息中没有媒体卡片。
2. SessionArtifact 只有通用 kind，没有尺寸、时长、海报帧和播放失败原因。
3. 生成式 Provider 可能返回 URL、二进制或 Base64；没有统一落盘 Adapter 时，Renderer 会被迫处理多种来源，重启后链接也容易失效。
4. 现有图片预览是 Overlay，视频和音频没有同等的安全读取与生命周期约束。

## 3. 目标与非目标

### 3.1 目标

1. 完成 Turn 后，媒体产物紧贴 Assistant 最终回复显示。
2. 同一媒体在消息、RightDock、文件树中的身份一致，点击行为一致。
3. 支持重启、重连、重新打开会话后恢复预览。
4. 图片、视频、音频分别采用合适交互，不强行用一个万能播放器。
5. 媒体读取继续经过 server-core 的路径和 allowed-root 校验。
6. Electron 与 WebUI 共用 DTO、派生规则和 UI 语义。

### 3.2 非目标

- 不在本期实现云端 CDN、公开分享、跨会话媒体库或媒体编辑器。
- 不承诺支持所有编码器；浏览器不能解码的格式交给系统应用。
- 不做自动播放、循环播放、后台持续播放或全局播放队列。
- 不把模型回复里的 Markdown 图片 URL 当作可信生成结果；外部 URL 仍走现有外链安全策略。
- 不保存每个视频的多版本帧、不做时间轴剪辑、不做音视频转码。
- 不将用户输入附件和 Agent 生成媒体混入同一类消息产物。

## 4. 用户体验

### 4.1 Assistant 消息中的媒体卡片

媒体卡片位于最终文本之后、消息操作栏之前；与 ProducedFilesRow 同一位置，但媒体存在时使用更强的视觉容器。

    Assistant：这是为首页生成的三张视觉稿。

    ┌──────────────┬──────────────┬──────────────┐
    │   image 1    │   image 2    │   image 3    │
    │  1024×1024   │  1024×1024   │  1024×1024   │
    └──────────────┴──────────────┴──────────────┘
    3 个媒体 · 查看全部 · 下载

规则：

- 图片最多首屏展示 4 张；更多媒体显示 + N 个，点击进入媒体浏览器；
- 视频只显示一张海报卡片，不在消息流自动加载完整视频；
- 音频显示文件名、时长、播放/暂停、进度和音量，不显示伪造波形；
- 卡片显示生成状态：生成中、已完成、加载失败、文件缺失；
- 卡片不展示原始绝对路径；完整路径放入辅助信息或“在文件夹中显示”；
- 消息滚动到视口时不自动播放音频/视频，不抢焦点。

### 4.2 图片

图片卡片使用缩略图数据 URL或受控媒体 URL。点击后优先复用 ImagePreviewOverlay 的缩放、导航、复制路径和外部打开能力。原图只在用户打开预览时读取，避免消息列表一次性载入大文件。

缩略图读取失败时回退到文件类型图标；原图读取失败时显示错误原因和“打开文件”按钮。

### 4.3 视频

视频卡片使用持久化海报帧。首版不要求服务端实时抽帧：

1. Provider 或媒体落盘 Adapter 能提供海报帧时保存到会话媒体目录；
2. 没有海报帧时使用统一视频图标，不在 Renderer 阻塞生成缩略图；
3. 用户点击播放后使用 video controls preload=metadata，默认 muted，不设置 autoplay；
4. 播放失败时显示浏览器返回的可读错误，并提供系统打开入口。

视频消息内播放只负责快速验收；大屏浏览、复制路径和外部打开由统一媒体预览 Overlay 承担。

### 4.4 音频

音频卡片使用 audio controls preload=metadata，不自动播放。卡片至少显示：文件名、时长、播放状态和进度。首版不生成波形图，避免为了装饰增加转码或解码依赖；后续可用真实峰值数据替换占位。

同一会话默认只允许一个音频元素实际播放。切换消息、删除会话或关闭应用时停止播放；不要求跨会话记住播放位置。浏览器不支持格式时展示“当前环境无法播放”，保留系统打开和复制路径。

## 5. 数据与架构

### 5.1 端到端链路

    Provider 返回 URL / Base64 / 二进制
      -> MediaOutputAdapter 验证 MIME、大小和来源
      -> 写入 session data/media/<artifact-id>/
      -> transcript 持久化 tool_result + media reference
      -> server-core 派生 SessionArtifact + MessageMedia
      -> TurnCard 选择当前 Turn 的媒体
      -> MessageMediaPreview 渲染缩略图/播放器
      -> 点击后走统一文件权限与预览入口

Provider Adapter 必须把远程 URL 下载为会话本地文件后再完成消息。远程 URL 只允许作为短暂下载输入，不能作为长期消息引用；否则过期、鉴权和跨域会让历史消息失效。

### 5.2 共享 DTO

建议在 packages/shared/src/protocol/ 增加以下类型。SessionArtifact 仍是事实投影，MessageMedia 是消息关联投影。

    export type GeneratedMediaType = 'image' | 'video' | 'audio'

    export type MediaPreviewStatus =
      | 'generating'
      | 'ready'
      | 'missing'
      | 'unsupported'
      | 'error'

    export interface MediaMetadata {
      mimeType: string
      byteSize?: number
      width?: number
      height?: number
      durationMs?: number
      posterPath?: string
    }

    export interface MessageMedia {
      id: string
      messageId: string
      artifactPath: string
      name: string
      mediaType: GeneratedMediaType
      metadata: MediaMetadata
      status: MediaPreviewStatus
      errorCode?: 'generation_failed' | 'file_missing' | 'permission_denied'
        | 'codec_unsupported' | 'read_failed'
    }

约束：

- artifactPath 必须与 SessionArtifact.path 精确匹配；没有 Artifact 身份的媒体不能进入消息预览；
- DTO 不包含原图 Base64、视频二进制、音频二进制和远程 URL；
- metadata 是服务端探测结果，Renderer 不从文件名猜尺寸和时长；
- messageId 指向最终 Assistant 消息或产生该媒体的持久化消息，不能用“最后一条消息”隐式绑定；
- status 由服务端文件状态和 Adapter 结果派生，消息文本不参与判断。

### 5.3 产物目录

生成媒体统一落在会话输出目录下，例如：

    <session-data>/data/media/<artifact-id>/source.png
    <session-data>/data/media/<artifact-id>/poster.jpg

poster.jpg 是媒体的辅助文件，不单独显示为一个 Artifact；在 SessionArtifact 中作为 posterPath 元数据返回。扫描仍遵循产物中心规则，不把 attachments、downloads、隐藏文件和运行时记账文件识别为生成媒体。

### 5.4 媒体身份和关联

媒体身份采用稳定 artifactPath，不是缩略图 URL，也不是数组下标。关联规则：

1. 生成工具完成并返回结构化媒体路径；
2. MediaOutputAdapter 校验并写入文件；
3. 持久化消息记录 toolUseId、artifactPath 和 messageId；
4. deriveSessionArtifacts 聚合 Artifact；
5. selectTurnProducedMedia 按当前 Turn 的工具活动筛选媒体。

同一路径重复生成只显示一个媒体卡片，修订次数进入产物详情；同名不同目录不得合并。

## 6. 模块与接口

采用一个深模块 MessageMediaPreview，隐藏来源读取、状态切换、播放器互斥和错误回退；调用方只传入已经关联好的 MessageMedia[] 和打开文件回调。

    interface MessageMediaPreviewProps {
      media: MessageMedia[]
      compact?: boolean
      onOpenArtifact: (path: string) => void
      onViewAll?: () => void
    }

内部 Adapter：

- ImageMediaAdapter：缩略图、原图 Overlay、尺寸；
- VideoMediaAdapter：海报、metadata、受控 video、播放失败；
- AudioMediaAdapter：audio 控件、单实例播放协调、时长；
- MediaSourceLoader：统一缩略图/媒体读取、取消请求和权限错误映射。

不要让 TurnCard、RightDock、文件树分别实现三套 img / video / audio 逻辑。它们只负责选择媒体并调用同一深模块。

## 7. RPC 与实时更新

复用现有文件读取通道，并补充两类只读能力：

    file.READ_MEDIA_METADATA(path): Promise<MediaMetadata>
    file.READ_MEDIA_PREVIEW(path, kind): Promise<string | Uint8Array>

实现要求：

- READ_MEDIA_PREVIEW 只返回缩略图或受控媒体响应，不允许以通用路径读取绕过 allowed-root；
- 原图和大媒体不要通过 JSON RPC Base64 传输；Electron 优先使用受控本地媒体 URL，WebUI 使用带权限校验的分块读取；
- 若当前 transport 还不支持流式媒体，本期视频/音频先通过系统应用打开，并把消息内播放作为 Electron Host 能力门槛；不能为了赶 UI 把大文件塞进 RPC；
- tool_result、FILES_CHANGED 和会话重连触发媒体快照刷新，继续使用现有 100ms 合并和请求代次丢弃规则；
- 不新增独立 MEDIA_CREATED 事件，避免媒体事件与 transcript 顺序分叉。

## 8. 安全、性能与兼容

### 8.1 安全

- 所有路径由 server-core 规范化并重新校验；Renderer 不能拼接 posterPath；
- MIME 以文件探测为准，扩展名只用于初步分类；禁止把任意文本响应当作媒体；
- 远程生成 URL 不直接渲染，先下载、限制重定向和大小，再写入会话目录；
- 不在错误文案中回显访问令牌、签名 URL 或完整异常栈；
- 视频、音频不使用 file:// 直接暴露整个文件系统；
- 对 HTML/SVG 媒体继续沿用现有 sandbox 和安全策略。

### 8.2 性能

- 消息列表只读缩略图和 metadata，不读取原媒体；
- 图片缩略图限制最大边长 320 px；视频海报限制 640×360；音频不生成波形；
- 单条消息最多渲染 4 个首屏卡片，虚拟化和无限媒体瀑布流不在首版；
- 同一 artifact 的 metadata、poster 和 preview 请求按 path 去重并可取消；
- 生成中只渲染状态卡，不轮询文件系统；由现有事件触发刷新。

### 8.3 格式兼容

首版建议支持：

| 类型 | 格式 |
| --- | --- |
| 图片 | PNG、JPEG、WebP、GIF、SVG、AVIF、BMP |
| 视频 | MP4（H.264/AAC）、WebM（VP8/VP9/Opus）、MOV（以 Host 能力为准） |
| 音频 | MP3、WAV、M4A/AAC、OGG/Opus、WebM 音频 |

具体是否可播放以运行时 canPlayType 和实际加载结果为准，不以扩展名硬编码“必定支持”。HEIC、TIFF、专业视频编码、无损音频等格式允许降级系统应用。

## 9. 实施边界

### 9.1 新增

| 文件/模块 | 职责 |
| --- | --- |
| packages/shared/src/protocol/media.ts | 媒体 DTO、状态和错误码 |
| packages/server-core/src/sessions/media.ts | MIME/metadata 探测、媒体引用派生 |
| packages/ui/src/components/chat/MessageMediaPreview.tsx | 消息媒体容器与状态 UI |
| packages/ui/src/components/chat/media/ | 图片、视频、音频 Adapter |
| packages/ui/src/components/overlay/MediaPreviewOverlay.tsx | 多媒体大图预览和统一操作 |
| packages/ui/src/components/chat/media-utils.ts | 按 Turn 选择媒体、去重和排序 |

### 9.2 修改

| 文件/模块 | 改动 |
| --- | --- |
| packages/ui/src/lib/file-classification.ts | 增加 video/audio 预览类型和格式集合；保留外部打开降级 |
| apps/electron/src/renderer/hooks/useLinkInterceptor.ts | 增加媒体预览状态和受控加载入口 |
| packages/ui/src/components/chat/TurnCard.tsx | 在最终回复后注入当前 Turn 的媒体 |
| apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx | 传入媒体选择结果和 Host 回调 |
| packages/server-core/src/handlers/rpc/files.ts | 增加 metadata/preview 读取并复用路径校验 |
| packages/shared/src/protocol/ channel map | 注册只读媒体通道 |
| i18n 中英文资源 | 增加生成中、缺失、编码器不支持、播放失败文案 |
| Provider 适配层 | 远程 URL/Base64/二进制统一落盘并产出引用 |

### 9.3 不改动

- 不改 StoredAttachment 的用户附件语义；
- 不把生成媒体塞入 MessageAttachment，避免用户输入和 Agent 输出共用错误模型；
- 不复制 RightDock 的产物派生规则；消息媒体只消费 SessionArtifact；
- 不新增数据库、artifacts.json 或媒体清单旁路。

## 10. 实施顺序

### P0：媒体事实链路

1. 定义 DTO、错误码和媒体目录约定；
2. 实现 Provider MediaOutputAdapter：校验、落盘、生成 poster（若已有）；
3. 扩展 Artifact 派生和 selectTurnProducedMedia；
4. 先用图片做端到端验证。

完成标准：重启后能从持久化消息和文件恢复一张生成图片及其 metadata，消息只保存引用。

### P1：消息内三类预览

1. 落地 MessageMediaPreview；
2. 图片接入现有 Overlay；
3. 视频接入受控 video 和海报；
4. 音频接入受控 audio 和单实例播放；
5. 缺失、失败、unsupported 状态和系统打开兜底。

完成标准：同一条 Assistant 消息可以同时展示图片、视频、音频，刷新和重启后状态一致。

### P2：Host 与体验完善

1. Electron 受控媒体 URL/流式读取；
2. WebUI 无流式能力时明确降级，不伪装成已支持；
3. 多图浏览、全屏 Overlay、复制路径、在文件夹中显示；
4. RightDock 与消息卡片状态同步；
5. 生成过程中的 placeholder 和失败重试。

## 11. 测试方案

### 11.1 纯函数和协议

- 图片、视频、音频 MIME 与扩展名分类；
- 相同 artifactPath 去重，不同目录同名不合并；
- 成功工具进入媒体，失败/执行中工具不进入；
- Provider URL 下载后只持久化本地引用；
- DTO 不含 Base64、二进制和远程 URL；
- poster 不被当作独立 Artifact；
- Turn 选择按 toolUseId，不按“最后一条消息”猜测。

### 11.2 Renderer

- 图片网格最多 4 项，超出显示 + N；
- 视频不自动播放，默认静音；
- 音频同一会话只有一个播放器可播放；
- 切换会话、卸载消息、关闭应用会停止播放；
- 缩略图失败回退图标，原媒体失败显示错误和外部打开；
- 不支持的编码器不会卡死消息列表；
- 迟到请求不会覆盖新会话或新媒体状态。

### 11.3 安全与性能

- 路径穿越、符号链接、越权目录和签名 URL 不可读取；
- 大媒体不经过 JSON Base64 RPC；
- 100 个媒体产物的会话打开不会读取 100 个原文件；
- 生成失败不会显示可播放卡片；
- 删除文件后历史消息显示“文件缺失”，不抛出未处理异常。

### 11.4 端到端案例

1. Agent 生成 PNG：最终回复后显示缩略图，点击进入图片预览。
2. Agent 生成 MP4：显示海报，点击可静音播放；不支持编码时提供外部打开。
3. Agent 生成 MP3：显示音频卡片，播放另一条音频会暂停前一条。
4. 一条消息同时生成 PNG、MP4、MP3：三种卡片都能独立加载。
5. 生成返回远程 URL：落盘成功后历史消息可在断网情况下继续预览。
6. 删除源文件或权限变化：显示准确缺失/拒绝状态，不污染其他消息。
7. 重启应用并打开旧会话：媒体关联、缩略图和时长保持一致。

## 12. 验收标准

- [ ] 图片、视频、音频都能在完成的 Assistant 消息内看到对应预览卡片。
- [ ] 视频和音频均不自动播放；音频播放时不会同时播放另一条音频。
- [ ] 消息只保存媒体引用和 metadata，不保存大文件 Base64。
- [ ] 生成结果先落盘，历史消息不依赖短期远程 URL。
- [ ] 同一媒体在消息和 RightDock 点击后走同一权限与预览入口。
- [ ] 文件缺失、权限拒绝、编码器不支持、生成失败有区分明确的状态。
- [ ] Electron 不支持的媒体能力会真实降级，不用“看起来能播”的假 UI 糊弄用户。
- [ ] WebUI、Electron 共用 DTO 与派生规则。
- [ ] 相关单测、Renderer 测试、路径安全测试和端到端案例通过。
- [ ] git diff --check 通过，旧附件语义无回归。

## 13. 风险与取舍

| 风险 | 取舍 |
| --- | --- |
| 不同平台浏览器编码器差异 | 运行时探测；不支持就系统打开，不做转码大工程 |
| 视频/音频体积大 | 原媒体不进 JSON RPC；优先受控 URL或流式通道 |
| Provider 返回短期 URL | 先下载落盘，牺牲一点生成延迟换历史可用性 |
| 海报帧生成成本 | 首版允许无海报图标回退，不阻塞消息展示 |
| 波形需要解码/采样 | 首版不做伪波形，先交付可靠播放 |
| 消息和产物双重状态 | SessionArtifact 是事实投影，消息只存关联，不建立第二事实源 |
| 旧会话没有媒体 metadata | 首次读取时按文件探测补齐；探测失败显示未知，不修改历史原文 |

## 14. 最终形态

    Agent 生成媒体
      -> Provider Adapter 落盘
      -> transcript 保存媒体引用
      -> server-core 派生 Artifact + metadata
      -> Assistant 消息显示媒体卡片
      -> 用户直接看图 / 播视频 / 听音频
      -> 点击进入统一预览或系统应用

这条链路把“消息里能看”做成产物中心之上的一个薄投影：体验更即时，事实仍然只有会话记录和真实文件两份，后续加 GIF、字幕、波形或媒体批量下载时也不需要推翻消息模型。
