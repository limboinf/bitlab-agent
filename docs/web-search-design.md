# Web Search 功能技术设计

> 状态：**已实现**。落地代码以仓库为准；下方「实现记录」列出与草案不一致的地方。
> 语言：中文。
> 本文原为技术设计文档，正文保留草案原貌，便于对照设计意图与最终实现。

---

## 实现记录（与草案的偏差）

落地过程中修正了草案的几处事实错误与过度设计，正文相应段落**以本节为准**：

| 草案 | 实际实现 | 原因 |
| --- | --- | --- |
| `search:testConnection` 通道 | **未实现** | Provider 代码在 `@bitlab/pi-agent-server`，而 `server-core` 只依赖 `core`/`shared`，主进程 import 不到；为一个"试搜"按钮把 Provider 搬进 shared 或复制一份 fetch 都不划算 |
| `InitMessage` 里 `import { SearchConfig }` | 在 `pi-agent-server/src/tools/search/types.ts` **本地定义**结构等价类型 | 该包刻意不依赖 workspace 包（`PiCredential` 同理） |
| `resolveSearchApiKeys` 遍历 `cfg.providers` | `resolveSearchSettings()` 只下发**当前激活 Provider** 的 Key | 草案写法在"只填了 Key、没填 baseURL"时拿不到 Key；顺带满足最小权限 |
| 风险表「`sendInit` 是同步的」 | 该风险不存在 | `pi-agent.ts` 早已 `await this.getPiAuth()`，直接 `await` 读 Key 即可 |
| `searchConfig` 写进 `config-defaults.json` + schema | 只用模块常量 `DEFAULT_SEARCH_CONFIG` | config-defaults 是给发行版可覆盖的布尔开关准备的，搜索配置不需要，少两处同步点 |
| — | 新增 `normalizeSearchConfig()`，读盘时丢弃未知 Provider id | 配置文件是用户可编辑的，不能全信 |
| — | 新增 `AgentBackend.refreshSearchConfig?()` + `SessionManager.refreshSearchConfig()` | 草案只说"发 `search_config_update` 消息"，没说主进程怎么找到所有活跃会话 |
| Provider 选择变更后需重启 | 改 Provider / 存 Key / 删 Key 三个 handler 都会广播刷新 | 与「不重建会话」的目标一致 |

Exa 的鉴权同时发 `x-api-key`（官方文档写法）与 `Authorization: Bearer`（代理常用），DeepSeek 同理。

---

## 0. 速览（TL;DR）

把现有 `web_search`（当前搜索后端**由 LLM 连接自动派生**）重构为**三层可插拔架构**，并新增一个 **Plugins 设置页**，让用户显式选择搜索 Provider、配置各 Provider 的 API Key（存入加密凭证库）。

- **三层架构**：① 工具外壳（`web_search`，只校验/格式化，不联网）→ ② Provider 选择接缝（`resolveSearchProvider`）→ ③ 可插拔 Provider（DuckDuckGo / Tavily / Exa / DeepSeek-native / LLM 派生）。
- **新增 Provider**：Tavily、Exa、DeepSeek-native（调用 DeepSeek Anthropic 兼容 Messages API 的服务端工具 `web_search_20250305`）。
- **密钥存储**：扩展 `CredentialType`，复用现有 AES-256-GCM 加密凭证库（与 LLM Key 同库）。
- **子进程密钥**：主进程下发（仿 `piAuth` / `token_update`），子进程不接触凭证库。
- **参考竞品**：`deepseek-harness` 的 `packages/web/`（`tool-web` / `web`（接缝）/ `web-search-deepseek` / `web-search-exa` / `web-search-perplexity`）。

---

## 1. 背景与现状

### 1.1 现有实现（bitlab-agent）

`web_search` + `web_fetch` **已经存在**，位于 `packages/pi-agent-server/src/tools/`：

| 文件 | 作用 |
| --- | --- |
| `search/create-search-tool.ts` | `web_search` 工具工厂（Tier A）。工具名固定 `web_search`，带 DDG 兜底。 |
| `search/resolve-provider.ts` | `resolveSearchProvider(piAuth)` —— **由 LLM 连接派生** Provider：OpenAI→Responses API，OpenRouter→Responses API，Google→Gemini grounding，其余→DDG。 |
| `search/types.ts` | `WebSearchProvider`、`WebSearchResult` 接口。 |
| `search/providers/ddg.ts` | `DDGSearchProvider` —— 无需 Key 的三级兜底（duck-duck-scrape → html.duckduckgo.com → lite.duckduckgo.com）。 |
| `search/providers/openai.ts` | `ResponsesApiSearchProvider`（兼容任意 Responses API 端点）。 |
| `search/providers/google.ts` | `GoogleSearchProvider` —— Gemini `generateContent` + `{ googleSearch:{} }` grounding。 |
| `search/providers/responses-api-parser.ts` | Responses API 搜索输出解析。 |
| `web-fetch.ts` | `web_fetch` 工具（HTML/PDF/图片/JSON/文本抽取 + SSRF 防护）。 |

**关键现状（决定本次改动范围）**：

1. Provider 选择**完全派生自 `initConfig.piAuth`（LLM 连接凭证）**，没有独立的搜索配置，也没有独立的搜索 Key。
2. 现有接口：

   ```ts
   // packages/pi-agent-server/src/tools/search/types.ts
   export interface WebSearchResult {
     title: string;
     url: string;
     description: string;
   }
   export interface WebSearchProvider {
     name: string;
     search(query: string, count: number): Promise<WebSearchResult[]>;
   }
   ```

3. Provider 在 `pi-agent-server/src/index.ts` 的 `ensureSession()`（约 580–600 行）以**动态 getter**方式接入，每次搜索都重新解析，从而 `token_update` 刷新无需重建会话：

   ```ts
   const searchProvider = {
     get name() { return resolveSearchProvider(initConfig?.piAuth).name; },
     async search(query, count) {
       return resolveSearchProvider(initConfig?.piAuth).search(query, count);
     },
   };
   const searchTool = createSearchTool(searchProvider);
   ```

4. 工具在子进程内执行（Tier A），`createSearchTool` 内置“主 Provider 失败 → 回退 DDG”的二级兜底。

### 1.2 竞品架构（deepseek-harness，参考）

三层：

1. **Layer 1 工具外壳** —— `packages/web/tool-web/src/search.ts`：schema `{ query }`，结果上限 8，超时 30s，`execute` 调 `ctx.web.search(...)`，**一行网络代码都没有**。
2. **Layer 2 接缝** —— `packages/web/web/src/index.ts`：`WebRuntime extends Service`，注册为 `ctx.web`。`search()` 先 `resolveProvider()`（配置 id 优先；否则自动选唯一；多个可用则报 `WEB_PROVIDER_AMBIGUOUS`），再 `capSources()` 截断到 `maxResults`。
3. **Layer 3 Provider** —— `web-search-deepseek`（默认）/ `web-search-exa` / `web-search-perplexity`，各自注册进 `ctx.web`。

**DeepSeek-native Provider 的真相**（`web-search-deepseek/src/provider.ts`）：它不爬网页、也不调 Google/Bing，而是**再开一轮 DeepSeek 模型调用**，用 DeepSeek 内置的服务端工具 `web_search_20250305` 去搜：

- `POST https://api.deepseek.com/anthropic/v1/messages`
- body 挂 `tools: [{ type:'web_search_20250305', name:'web_search', max_uses:5 }]`，message 为 `"Perform a web search for the query: xxx"`
- 解析返回的 `web_search_tool_result` 块（含 url/title/page_age），并用 `text` 块的 `citations[].cited_text` 作为 snippet，按 url 去重
- 注释直言：“Each search costs a model turn”（每次搜索消耗一个模型轮次）

### 1.3 差距与本次目标

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| Provider 选择 | LLM 连接派生，无独立配置 | 用户在 Plugins 页**显式选择**（仍保留 `auto` 选项走派生） |
| 新 Provider | 仅 DDG / OpenAI Responses / Google | 增加 **Tavily、Exa、DeepSeek-native** |
| 搜索 Key | 无（复用 LLM Key） | 独立搜索 Key，存**加密凭证库** |
| 架构分层 | Provider 与工具耦合在子进程内 | 明确三层（工具外壳 / 接缝 / Provider），换后端不动工具 schema |
| UI | 无搜索相关设置 | 新增 **Plugins** 设置页 |

---

## 2. 目标架构（三层）

```
┌──────────────────────────────────────────────────────────────┐
│ LLM 模型（在 pi-agent-server 子进程内）                          │
│   发起 web_search { query, count? }                            │
└───────────────────────────────┬──────────────────────────────┘
                                │ ① 校验 query / 截断 count / 格式化输出
                 ┌──────────────▼──────────────┐
   Layer 1       │  web_search 工具外壳          │  create-search-tool.ts
   工具外壳      │  （不联网）                   │  schema { query, count? }
                 └──────────────┬──────────────┘
                                │ ② 调 resolveSearchProvider(...)
                 ┌──────────────▼──────────────┐
   Layer 2       │  Provider 选择接缝           │  resolve-provider.ts
   接缝          │  显式配置优先 → auto 派生     │  选不到可用 Provider → DDG
                 └──────────────┬──────────────┘
                                │ ③ provider.search(query, count)
       ┌────────────┬───────────┼────────────┬─────────────┐
       ▼            ▼           ▼            ▼             ▼
   ┌───────┐  ┌─────────┐  ┌────────┐  ┌──────────┐  ┌──────────┐
   │ DDG   │  │ Tavily  │  │ Exa    │  │ DeepSeek │  │ LLM 派生 │
   │ 无Key │  │ Bearer  │  │ Bearer │  │ x-api-key│  │ OpenAI/  │
   │       │  │ /search │  │ /search│  │ Messages │  │ Google   │
   └───────┘  └─────────┘  └────────┘  └──────────┘  └──────────┘
       │            │           │            │             │
       └────────────┴───────────┴────────────┴─────────────┘
                                │ ④ WebSearchResult[]（title/url/description）
                 ┌──────────────▼──────────────┐
                 │  formatResults → 文本 + 来源  │
                 └──────────────┬──────────────┘
                                ▼ ⑤ 返回给模型（含可引用 URL）
```

### 2.1 分层职责（严格边界）

- **Layer 1（工具外壳）**：只负责 schema、参数校验（`query` 非空、`count` 1–10）、结果上限、输出格式化（markdown 来源列表）、错误包装（主 Provider 失败 → DDG 兜底）。**不含任何网络代码，不含 Provider 选择逻辑。**
- **Layer 2（接缝）**：`resolveSearchProvider({ searchConfig, piAuth, resolveKey })` 负责把“用户意图 + 当前凭证”映射到一个**可用**的 `WebSearchProvider` 实例。选不到可用 Provider 时退回 DDG，保证搜索永不硬失败。
- **Layer 3（Provider）**：每个 Provider 只懂自己的 HTTP 协议，实现 `WebSearchProvider`。新增后端只动 Layer 3 + 接缝的一个分支，不动工具。

### 2.2 与竞品的架构差异（及原因）

| 点 | 竞品（deepseek-harness） | 本设计（bitlab-agent） | 原因 |
| --- | --- | --- | --- |
| 接缝形态 | `ctx.web`（Cordis `Service`，DI 注入） | 一个纯函数 `resolveSearchProvider()` | bitlab 没有 Cordis/DI；子进程内直接函数调用更贴合现状 |
| 失败兜底 | 抛 `WebError`（`WEB_PROVIDER_UNAVAILABLE` 等），不兜底 | **选不到/调用失败 → 退回 DDG** | bitlab 已有 DDG 兜底传统；用户期望“搜索总能用” |
| 错误码 | 结构化 `WebError.code`（开放字符串） | 沿用现有 `throw new Error(...)`，工具层统一兜底 | 减少侵入；后续如需结构化错误可再演进 |
| 结果类型 | `{ content?, sources[], truncated }`（含 provider 答案 + 截断标志） | 沿用现有 `{ title, url, description }` | 最小改动；DeepSeek/Tavily 的“答案文本”可映射进 `description` 或后续扩字段 |

---

## 3. 一次搜索的完整时序

```
序列图（动态流程）

用户消息 ──▶ SessionManager.sendMessage()
              │
              ▼
         PiAgent.prompt() ── spawn ──▶ pi-agent-server 子进程
              │                          │
              │   init 消息（含 searchConfig + searchApiKeys）  │
              ├─────────────────────────▶│
              │                          │ ensureSession()
              │                          │  searchProvider = 动态 getter
              │                          │   resolveSearchProvider({
              │                          │     searchConfig, piAuth, resolveKey
              │                          │   })
              │                          │
              │   LLM 调用 web_search     │
              │◀──────────────────────────│
              │                          │ createSearchTool.execute:
              │                          │   ① 校验 query / count
              │                          │   ② provider.search(query, count)
              │                          │       └─ HTTP → Tavily/Exa/DeepSeek/...
              │                          │   ③ 失败 → DDG 兜底
              │                          │   ④ formatResults → markdown
              │   tool_result             │
              │◀──────────────────────────│
              ▼
         展示来源列表给用户

（用户在 Plugins 页改了 Provider / Key）
              │
              │   search_config_update 消息（刷新 initConfig.searchConfig + searchApiKeys）
              ├─────────────────────────▶│ 子进程下次搜索自动用新配置（无需重建会话）
```

---

## 4. Provider 规格

所有 Provider 统一实现现有接口（**不改接口**，保持向后兼容）：

```ts
export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}
export interface WebSearchProvider {
  name: string;
  search(query: string, count: number): Promise<WebSearchResult[]>;
}
```

约定：`name` 用于结果归属展示（如 `"Tavily"`、`"Exa"`、`"DeepSeek"`、`"DuckDuckGo"`）。所有 Provider 用原生 `fetch`，`redirect: 'error'`，30s 超时（`AbortSignal.timeout(30_000)`），无新增 npm 依赖。

### 4.1 DuckDuckGo（`duckduckgo`，无 Key）

- **现状**：`providers/ddg.ts` 已实现，三级兜底（`duck-duck-scrape` → html → lite）。
- **改动**：无。继续作为 `auto` 的最终兜底、以及用户显式选 DDG 时的 Provider。
- **`available`**：恒为 `true`（无需 Key）。

### 4.2 Tavily（`tavily`，新，需 Key）

- **端点**：`POST {baseURL}/search`，默认 `https://api.tavily.com`。
- **鉴权**：`Authorization: Bearer <apiKey>`。
- **请求体**：

  ```json
  {
    "query": "<query>",
    "max_results": <count>,
    "include_answer": false,
    "search_depth": "advanced"
  }
  ```

- **响应映射**：`results[]` → `{ title, url, description: content }`；丢弃无 `url` 的项。
- **新文件**：`packages/pi-agent-server/src/tools/search/providers/tavily.ts`。
- **`available`**：`apiKey` 非空且 `baseURL` 可解析。

### 4.3 Exa（`exa`，新，需 Key）

直接对标竞品 `web-search-exa/provider.ts`。

- **端点**：`POST {baseURL}/search`，默认 `https://api.exa.ai`。
- **鉴权**：`Authorization: Bearer <apiKey>`。
- **请求体**：

  ```json
  {
    "query": "<query>",
    "type": "auto",
    "numResults": <count>,
    "contents": { "highlights": { "highlightsPerUrl": 1 } }
  }
  ```

- **响应映射**：`results[]` → `{ title, url, description: highlights[0] }`；**丢弃无 highlight 的项**（接缝没有其它字段可造 snippet，造了就是撒谎，对齐竞品）。
- **新文件**：`providers/exa.ts`。

### 4.4 DeepSeek-native（`deepseek`，新，需 Key）

对标竞品 `web-search-deepseek/provider.ts` + `types.ts`。**核心机制**：再开一轮 DeepSeek 模型调用，用其服务端工具 `web_search_20250305` 去搜。

- **端点**：`POST {baseURL}/messages`，默认 `https://api.deepseek.com/anthropic/v1`（注意：**不是** chat-completions 的 `https://api.deepseek.com`）。
- **鉴权**：同时发 `x-api-key` 与 `Authorization: Bearer`（兼容原生与代理），外加 `anthropic-version: 2023-06-01`。
- **请求体**：

  ```json
  {
    "model": "deepseek-v4-flash",
    "max_tokens": 4096,
    "messages": [{
      "role": "user",
      "content": [{ "type": "text", "text": "Perform a web search for the query: <query>" }]
    }],
    "tools": [{ "type": "web_search_20250305", "name": "web_search", "max_uses": 5 }]
  }
  ```

- **响应解析**（关键，对标 `mapAnthropicResponse`）：
  1. 从 `content[]` 过滤出 `type === 'web_search_tool_result'` 块；**一个都没有则抛错**（不降级为散文抓取）。
  2. 先用 `citationSnippets(blocks)`：遍历所有 `text` 块的 `citations[]`，建 `url → cited_text` 映射（snippet 来源，首现为准）。
  3. 遍历结果块的 `content[]` 中 `type === 'web_search_result'` 项，按 `url` **去重**（`max_uses > 1` 可能重复），拼成 `{ title, url, description: snippet ?? '' }`；`page_age` 可塞进 `description` 后缀或后续扩字段。
- **新文件**：`providers/deepseek.ts`（含私有 wire 类型 `AnthropicResponse` / `WebSearchToolResultBlock` / `TextBlock` 等，可不单列 `types.ts`）。
- **`available`**：`apiKey` 非空、`baseURL` 可解析、`maxUses`/`maxTokens` 为正整数。
- **注意**：每次搜索 = 一次模型轮次（成本与延迟均高于普通 API 搜索），UI 上应提示用户。

### 4.5 LLM 派生（`auto`，沿用现状）

- 用户选 `auto`（默认）时，走现有 `resolveSearchProvider(piAuth)` 逻辑：OpenAI/OpenRouter → Responses API，Google → Gemini grounding，其余 → DDG。
- **改动**：仅把现有派生逻辑收纳为 `auto` 分支，不改变行为。

---

## 5. 配置存储扩展（`packages/shared/src/config/`）

### 5.1 新类型文件 `packages/shared/src/config/search.ts`（建议新建）

```ts
/** 用户可选的搜索 Provider。 */
export type SearchProviderId =
  | 'auto'        // 沿用：由 LLM 连接派生（OpenAI/OpenRouter/Google），否则 DDG
  | 'duckduckgo'  // 无 Key
  | 'tavily'      // 需 Key
  | 'exa'         // 需 Key
  | 'deepseek';   // 需 Key（DeepSeek-native）

/** 需 Key 的 Provider 子集（auto/duckduckgo 不在此列）。 */
export type KeyedSearchProviderId = Exclude<SearchProviderId, 'auto' | 'duckduckgo'>;

/** 单个 Provider 的可选配置。注意：apiKey 不存这里，存加密凭证库。 */
export interface SearchProviderConfig {
  /** 可选 endpoint 覆盖。 */
  baseURL?: string;
  /** 可选模型名（deepseek/tavily 等支持）。 */
  model?: string;
  /** 可选单次结果上限。 */
  maxResults?: number;
}

/** 顶层搜索配置，挂在 StoredConfig.searchConfig。 */
export interface SearchConfig {
  /** 当前激活 Provider，默认 'auto'。 */
  provider: SearchProviderId;
  /** 各 Provider 的可选配置（Key 不在此，在凭证库）。 */
  providers: Partial<Record<KeyedSearchProviderId, SearchProviderConfig>>;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'auto',
  providers: {},
};
```

> 设计要点：**`apiKey` 绝不进入 `config.json`**（明文）。`SearchProviderConfig` 只放非敏感的 endpoint/模型/上限。Key 一律走加密凭证库（见第 6 节）。

### 5.2 `storage.ts` 改动

仿照 `getBrowserToolEnabled()` / `setBrowserToolEnabled()`（storage.ts 约 497–519 行）：

1. `StoredConfig` 新增字段：

   ```ts
   // 在 StoredConfig 接口中追加：
   searchConfig?: SearchConfig;  // Web Search provider 配置。缺省 = DEFAULT_SEARCH_CONFIG。
   ```

2. 新增 getter/setter：

   ```ts
   export function getSearchConfig(): SearchConfig {
     const config = loadStoredConfig();
     if (config?.searchConfig) return { ...DEFAULT_SEARCH_CONFIG, ...config.searchConfig };
     return DEFAULT_SEARCH_CONFIG;
   }

   export function setSearchConfig(cfg: SearchConfig): void {
     const config = loadStoredConfig();
     if (!config) return;
     config.searchConfig = cfg;
     saveConfig(config);
   }
   ```

3. 默认值：在 `FALLBACK_CONFIG_DEFAULTS`（storage.ts 约 115 行）与 `apps/electron/resources/config-defaults.json` 中补 `searchConfig` 默认（`{ provider:'auto', providers:{} }`），与 `browserToolEnabled` 同步机制一致。

---

## 6. 加密凭证扩展（`packages/shared/src/credentials/`）

复用现有 AES-256-GCM 加密库（`SecureStorageBackend`，密钥由机器硬件 UUID 经 PBKDF2 派生），与 LLM Key 同库。

### 6.1 `types.ts` 改动

```ts
// 扩展联合类型：
export type CredentialType = 'llm_api_key' | 'llm_oauth' | 'web_search_api_key';
//                                                                  ^^^^^^^^^^^^^^^^^^ 新增

// accountToCredentialId 的合法 type 判定追加 'web_search_api_key'：
export function accountToCredentialId(account: string): CredentialId | null {
  const [type, connectionSlug, ...rest] = account.split(CREDENTIAL_DELIMITER);
  if (
    type !== 'llm_api_key' && type !== 'llm_oauth' && type !== 'web_search_api_key'
    || !connectionSlug || rest.length > 0
  ) return null;
  return { type, connectionSlug };
}
```

**约定**：`connectionSlug` = Provider id（`'tavily'` / `'exa'` / `'deepseek'`）。即凭证 id 形如 `{ type:'web_search_api_key', connectionSlug:'tavily' }`，落库 account 字符串 `web_search_api_key::tavily`。

### 6.2 `manager.ts` 改动

仿照 `getLlmApiKey` / `setLlmApiKey`（manager.ts 约 99–107 行）追加：

```ts
async getSearchApiKey(providerId: string): Promise<string | null> {
  const credential = await this.get({ type: 'web_search_api_key', connectionSlug: providerId });
  return credential?.value ?? null;
}

async setSearchApiKey(providerId: string, apiKey: string): Promise<void> {
  await this.set({ type: 'web_search_api_key', connectionSlug: providerId }, { value: apiKey });
}

async deleteSearchApiKey(providerId: string): Promise<boolean> {
  return this.delete({ type: 'web_search_api_key', connectionSlug: providerId });
}

/** 返回脱敏字符串（如 sk-1234•••6789），供 UI 展示“已设置”而不暴露明文。 */
async getMaskedSearchApiKey(providerId: string): Promise<string | null> {
  const key = await this.getSearchApiKey(providerId);
  if (!key) return null;
  return maskKey(key); // 复用现有 maskKey 工具（与 LLM Key 同逻辑）
}
```

> 底层 `get`/`set`/`delete`（manager.ts 57–81 行）已按 `CredentialId` 通用路由，**无需改动加密/存储后端**。

---

## 7. RPC / IPC / Preload 全链路

新增通道一律走现有 5 触点清单（见 `apps/electron/src/transport/channel-map.ts` 顶部注释与 `build-api.ts`）。

### 7.1 通道定义（`packages/shared/src/protocol/channels.ts`）

在 `RPC_CHANNELS` 中新增 `search` 命名空间（仿 `tools:`，channels.ts 约 247–250 行）：

```ts
search: {
  GET_CONFIG: 'search:getConfig',
  SET_CONFIG: 'search:setConfig',
  GET_API_KEY: 'search:getApiKey',      // 返回脱敏字符串
  SET_API_KEY: 'search:setApiKey',
  DELETE_API_KEY: 'search:deleteApiKey',
  TEST_CONNECTION: 'search:testConnection', // 可选：试搜一次
},
```

> 如有通道穷举校验测试（`getAllChannelValues()`），需同步把新通道归类。

### 7.2 RPC handler（`packages/server-core/src/handlers/rpc/settings.ts`）

在 `registerSettingsHandlers` + `HANDLED_CHANNELS` 中追加（仿 tools handler，settings.ts 约 333–345 行）：

```ts
// ============================================================
// Web Search Settings
// ============================================================

server.handle(RPC_CHANNELS.search.GET_CONFIG, async () => {
  const { getSearchConfig } = await import('@bitlab/shared/config/storage');
  return getSearchConfig();
});

server.handle(RPC_CHANNELS.search.SET_CONFIG, async (_ctx, cfg: SearchConfig) => {
  const { setSearchConfig } = await import('@bitlab/shared/config/storage');
  setSearchConfig(cfg);
  // 触发子进程配置刷新（见第 8 节）
  // 由 config 变更监听统一驱动，或在此显式调用 PiAgent.refreshSearchConfig()。
});

server.handle(RPC_CHANNELS.search.GET_API_KEY, async (_ctx, providerId: string) => {
  const { getCredentialManager } = await import('@bitlab/shared/credentials/manager');
  return getCredentialManager().getMaskedSearchApiKey(providerId);
});

server.handle(RPC_CHANNELS.search.SET_API_KEY, async (_ctx, providerId: string, key: string) => {
  // 脱敏占位符（含 '••'）不写入，避免把占位符当真 Key 存
  if (key.includes('••')) return;
  const { getCredentialManager } = await import('@bitlab/shared/credentials/manager');
  await getCredentialManager().setSearchApiKey(providerId, key);
  // 触发子进程密钥刷新（见第 8 节）
});

server.handle(RPC_CHANNELS.search.DELETE_API_KEY, async (_ctx, providerId: string) => {
  const { getCredentialManager } = await import('@bitlab/shared/credentials/manager');
  await getCredentialManager().deleteSearchApiKey(providerId);
});

// 可选：试搜
server.handle(RPC_CHANNELS.search.TEST_CONNECTION, async (_ctx, providerId: string) => {
  // 主进程解析配置 + Key，直接构造 Provider 试搜 "test"，返回 { ok, message? }
});
```

> Key 写入路径只接触加密库，**永不落 `config.json`**。

### 7.3 Preload bridge（`apps/electron/src/transport/channel-map.ts`）

```ts
search: {
  getConfig: invoke(RPC_CHANNELS.search.GET_CONFIG),
  setConfig: invoke(RPC_CHANNELS.search.SET_CONFIG),
  getApiKey: invoke(RPC_CHANNELS.search.GET_API_KEY),
  setApiKey: invoke(RPC_CHANNELS.search.SET_API_KEY),
  deleteApiKey: invoke(RPC_CHANNELS.search.DELETE_API_KEY),
  testConnection: invoke(RPC_CHANNELS.search.TEST_CONNECTION),
},
```

> 注：`channel-map.ts` 用扁平 key + 点号嵌套（`build-api.ts` 33–54 行）。若 `search` 顶层 key 形式不便，可改为扁平 `searchGetConfig` 等，但建议用嵌套 `search.*` 以保持命名空间清晰。

### 7.4 `ElectronAPI` 类型（`apps/electron/src/shared/types.ts`）

```ts
search: {
  getConfig(): Promise<SearchConfig>;
  setConfig(cfg: SearchConfig): Promise<void>;
  getApiKey(providerId: string): Promise<string | null>;
  setApiKey(providerId: string, key: string): Promise<void>;
  deleteApiKey(providerId: string): Promise<void>;
  testConnection(providerId: string): Promise<{ ok: boolean; message?: string }>;
};
```

---

## 8. 子进程密钥与配置下发（架构关键点）

> 这是本设计**唯一真正的架构分叉点**：加密凭证库在**主进程**，而真正发 HTTP 的是 **pi-agent-server 子进程**（`web_search.execute` 在子进程内跑）。竞品没有这个进程分叉（单进程）。本设计采用**主进程下发**方案。

### 8.1 方案：主进程下发（仿 `piAuth` / `token_update`）

与现有 LLM Key 完全一致的下发路径：主进程从加密库读出明文 Key，随进程消息下发给子进程；子进程**不接触凭证库**，只在内存里持有当次会话所需 Key。

#### 8.1.1 `InitMessage` 扩展（`pi-agent-server/src/index.ts`，约 96–120 行）

```ts
interface InitMessage {
  // ... 现有字段 ...
  piAuth?: { provider: string; credential: PiCredential };
  // ↓ 新增
  searchConfig?: SearchConfig;
  searchApiKeys?: Partial<Record<KeyedSearchProviderId, string>>; // 主进程解析好的明文 Key
}
```

#### 8.1.2 主进程下发（`packages/shared/src/agent/pi-agent.ts`，约 464–488 行 init payload）

```ts
this.send({
  type: 'init',
  // ... 现有字段 ...
  piAuth,
  // ↓ 新增：搜索配置 + 主进程已解析的明文 Key
  searchConfig: getSearchConfig(),
  searchApiKeys: await resolveSearchApiKeys(getSearchConfig()),
});
```

其中 `resolveSearchApiKeys` 在主进程内：

```ts
async function resolveSearchApiKeys(cfg: SearchConfig): Promise<Partial<Record<KeyedSearchProviderId, string>>> {
  const cm = getCredentialManager();
  const out: Partial<Record<KeyedSearchProviderId, string>> = {};
  for (const id of Object.keys(cfg.providers ?? {}) as KeyedSearchProviderId[]) {
    const key = await cm.getSearchApiKey(id);
    if (key) out[id] = key;
  }
  // 也可能需要下发 deepseek Key 即便未在 providers 里显式配（若用户 provider='deepseek' 但 providers 为空）
  return out;
}
```

> 注意 `pi-agent.ts` 的 `sendInit` 当前是同步的（在 spawn 后直接发）。因读 Key 是异步的，需把 Key 解析提前到 spawn 之前（与 `piAuth` 的解析同位置，pi-agent.ts 约 400–405 行），暂存后随 init 一起发。

#### 8.1.3 运行时刷新（不重建会话）

仿 `token_update`（index.ts 约 150 行、586–593 行动态 getter）：新增轻量消息 `search_config_update`，主进程在用户改配置/Key 后发送，子进程更新 `initConfig.searchConfig` / `initConfig.searchApiKeys`，**下次搜索自动用新配置**。

```ts
// InboundMessage 新增：
| { type: 'search_config_update'; searchConfig: SearchConfig; searchApiKeys: Partial<Record<KeyedSearchProviderId, string>> }

// handler：
async function handleSearchConfigUpdate(msg) {
  if (initConfig) {
    initConfig.searchConfig = msg.searchConfig;
    initConfig.searchApiKeys = msg.searchApiKeys;
  }
}
```

#### 8.1.4 接缝消费（`ensureSession()` 内的动态 getter 改写）

```ts
const searchProvider = {
  get name() {
    return resolveSearchProvider({
      piAuth: initConfig?.piAuth,
      searchConfig: initConfig?.searchConfig,
      resolveKey: (id) => initConfig?.searchApiKeys?.[id as KeyedSearchProviderId] ?? null,
    }).name;
  },
  async search(query, count) {
    return resolveSearchProvider({
      piAuth: initConfig?.piAuth,
      searchConfig: initConfig?.searchConfig,
      resolveKey: (id) => initConfig?.searchApiKeys?.[id as KeyedSearchProviderId] ?? null,
    }).search(query, count);
  },
};
```

> `resolveKey` 是同步取内存值（Key 已在 init/update 时下发到 `initConfig.searchApiKeys`），不是异步读库——子进程永远不读凭证库。

### 8.2 为什么不选“子进程直读凭证库”

| 维度 | 主进程下发（采用） | 子进程直读（备选，不采用） |
| --- | --- | --- |
| 与现状一致性 | ✅ 与 `piAuth`/LLM Key 完全同路径 | ❌ 现状 Key 全走主进程 |
| 子进程耦合 | ✅ 子进程不知道凭证库存在 | ❌ 子进程需拿机器 UUID 派生密钥，深耦合 `SecureStorageBackend` |
| 安全边界 | ✅ 主进程是唯一密钥托管者 | ❌ 两个进程都能解密，攻击面变大 |
| 刷新复杂度 | ✅ 一条 `search_config_update` 消息 | ⚠️ 子进程需自己监听变更/重读文件 |
| 多运行时（CLI/headless） | ✅ 主进程抽象统一 | ⚠️ 子进程模式仅 Electron 有，CLI/server 需另走一套 |

---

## 9. Provider 选择接缝（`resolve-provider.ts` 改写）

### 9.1 新签名

```ts
export interface ResolveSearchProviderOptions {
  /** 旧路径：LLM 连接凭证（auto 派生用）。 */
  piAuth?: SearchProviderAuthConfig;
  /** 新路径：用户显式搜索配置。 */
  searchConfig?: SearchConfig;
  /** 从已下发的内存 Key 中取某 Provider 的 Key（同步）。 */
  resolveKey?: (providerId: string) => string | null;
}

export function resolveSearchProvider(opts: ResolveSearchProviderOptions): WebSearchProvider;
```

### 9.2 选择逻辑（显式优先，auto 走派生，选不到可用 → DDG）

```
provider = searchConfig?.provider ?? 'auto'

if provider === 'auto':
    return 旧派生(piAuth)   // OpenAI/OpenRouter→Responses，Google→Gemini，否则 DDG

if provider === 'duckduckgo':
    return new DDGSearchProvider()

if provider in {tavily, exa, deepseek}:
    cfg  = searchConfig.providers[provider]
    key  = resolveKey?.(provider) ?? null
    if key 为空:
        return new DDGSearchProvider()    // 无 Key → 退回 DDG（不硬失败）
    return new <Tavily|Exa|DeepSeek>Provider({ apiKey:key, baseURL:cfg?.baseURL, model:cfg?.model, ... })

// 兜底
return new DDGSearchProvider()
```

> “无 Key 退回 DDG”是有意为之：用户选了 Tavily 但没填 Key，搜索应继续可用（用 DDG），而不是抛错。UI 侧应同时提示“Tavily 未配置 Key，已回退 DuckDuckGo”。

### 9.3 现有派生逻辑保留

把现有 `resolveSearchProvider(piAuth)` 函数体改名为 `resolveDerivedSearchProvider(piAuth)`，作为 `auto` 分支调用，**行为零变化**。

---

## 10. Plugins 设置页（UI）

按 `settings-registry.ts` 顶部注释的 4 步流程（实测为 5 触点，含 preload/types）：

### 10.1 注册页面（`apps/electron/src/shared/settings-registry.ts`）

在 `SETTINGS_PAGES` 追加：

```ts
{ id: 'plugins' as const, labelKey: 'settings.plugins.title', descriptionKey: 'settings.plugins.description' },
```

`SettingsSubpage` 联合类型自动派生出 `'plugins'`。

### 10.2 页面组件（`apps/electron/src/renderer/pages/settings/PluginsSettingsPage.tsx`，新建）

布局（对标你给的竞品截图：分卡片的设置页）：

```
Plugins 设置页
├── Web Search 卡片（SettingsSection）
│   ├── Active provider（SettingsMenuSelect，带描述副标题）
│   │     - Auto（follow LLM connection）
│   │     - DuckDuckGo（no key required）
│   │     - Tavily
│   │     - Exa
│   │     - DeepSeek
│   └── <条件渲染：当选中需 Key 的 Provider 时>
│       ├── API Key（SettingsInput, type=password，显示脱敏值，带“保存/清除”按钮）
│       ├── Base URL（SettingsInput, 可选，仅 tavily/exa/deepseek 显示）
│       └── Model（SettingsInput, 可选，仅 deepseek 显示）
│       └── “Test connection” 按钮（可选）
```

- **加载**：mount 时 `Promise.all([search.getConfig(), search.getApiKey(provider)])`。
- **保存 Provider**：`onValueChange` → `search.setConfig({...cfg, provider})`；切换 Provider 后重新拉对应 Key 的脱敏值。
- **保存 Key**：`SettingsInput` + 保存按钮；点保存 → `search.setApiKey(provider, value)`；脱敏占位符（含 `••`）不回写。
- **复用组件**：`SettingsSection` / `SettingsCard` / `SettingsMenuSelect`（带 description）/ `SettingsInput`（支持 password 类型与 show/hide）。这些组件已存在，签名见各文件头注释。
- **meta**：

  ```ts
  export const meta: DetailsPageMeta = { navigator: 'settings', slug: 'plugins' };
  ```

### 10.3 注册组件（`apps/electron/src/renderer/pages/settings/settings-pages.ts`）

```ts
import PluginsSettingsPage from './PluginsSettingsPage';
// ...
export const SETTINGS_PAGE_COMPONENTS: Record<SettingsSubpage, ComponentType> = {
  // ... 现有 ...
  plugins: PluginsSettingsPage,
};
```

### 10.4 图标（`SettingsIcons.tsx` + `menu-schema.ts`）

新增 Plugins 图标（建议 lucide `Puzzle` 或 `Blocks`），在 `SETTINGS_ICONS` 与 `menu-schema.ts` 注册。

> 该页**设计为可扩展**：后续其它“插件式”集成（如 MCP、其它工具开关）可挂到同一页的新卡片，与竞品截图的多分区布局一致。

---

## 11. i18n（`packages/shared/src/i18n/locales/{en,zh-Hans}.json`）

**locale-parity 测试会校验两份 locale 的 key 完全一致**（`__tests__/locale-parity.test.ts`），故新 key 必须同时加到 `en.json` 与 `zh-Hans.json`。建议 key：

```
settings.plugins.title                       Plugins / 插件
settings.plugins.description                 ... / ...
settings.plugins.webSearch.title             Web Search / 网页搜索
settings.plugins.webSearch.provider          Active provider / 搜索引擎
settings.plugins.webSearch.providerDesc.auto Follow LLM connection / 跟随 LLM 连接
settings.plugins.webSearch.providerDesc.duckduckgo No key required / 无需 Key
settings.plugins.webSearch.providerDesc.tavily   ...
settings.plugins.webSearch.providerDesc.exa      ...
settings.plugins.webSearch.providerDesc.deepseek  Uses DeepSeek server-side search / 使用 DeepSeek 服务端搜索（每次搜索消耗一个模型轮次）
settings.plugins.webSearch.apiKey            API Key
settings.plugins.webSearch.apiKeyHint        Stored encrypted / 已加密存储
settings.plugins.webSearch.baseURL           Base URL
settings.plugins.webSearch.model             Model
settings.plugins.webSearch.test              Test connection / 测试连接
settings.plugins.webSearch.fallbackNotice    ... not configured, falling back to DuckDuckGo / ...未配置，已回退 DuckDuckGo
settings.plugins.webSearch.providerName.tavily   Tavily
settings.plugins.webSearch.providerName.exa      Exa
settings.plugins.webSearch.providerName.deepseek  DeepSeek
settings.plugins.webSearch.providerName.duckduckgo DuckDuckGo
settings.plugins.webSearch.providerName.auto      Auto
```

---

## 12. 测试计划

### 12.1 单元测试

- **Provider 层**（对标竞品测试，mock `fetch`）：
  - `packages/pi-agent-server/src/tools/search/providers/tavily.test.ts` —— 响应映射、空结果、HTTP 错误。
  - `.../exa.test.ts` —— 无 highlight 项被丢弃、numResults 透传。
  - `.../deepseek.test.ts` —— **重点**：`mapAnthropicResponse` 的 url 去重、`citationSnippets` 拼 snippet、无 `web_search_tool_result` 块时抛错（对标竞品 `mapAnthropicResponse`）。
- **接缝**：`resolve-provider.test.ts` 扩展：
  - `provider='auto'` → 走派生（OpenAI/Google/DDG）。
  - `provider='tavily'` + 有 Key → `TavilySearchProvider`。
  - `provider='tavily'` + 无 Key → 退回 DDG。
  - `provider='duckduckgo'` → DDG。
- **凭证**：`packages/shared/src/credentials/` 新测：`getSearchApiKey`/`setSearchApiKey`/`getMaskedSearchApiKey`/`deleteSearchApiKey` 的加解密往返；`accountToCredentialId` 接受 `web_search_api_key`。

### 12.2 集成/契约测试

- 通道穷举测试（若存在 `getAllChannelValues()` 分类测试）：新 `search.*` 通道已归类。
- i18n parity：两份 locale key 一致（既有测试自动覆盖）。

### 12.3 手测清单

1. Plugins 页选 Tavily + 填 Key → 新会话 `web_search` 走 Tavily，来源带 Tavily 归属。
2. 选 Tavily 但**不填** Key → 搜索仍可用（DDG 回退），UI 有提示。
3. 填 Key 后**不重启**、在已有会话里改 Provider → 下次搜索生效（`search_config_update` 刷新）。
4. 选 DeepSeek → 来源来自 DeepSeek 服务端搜索；留意“每次搜索 = 一次模型轮次”的成本。
5. 切回 `auto` → 行为与改动前完全一致（OpenAI/Google 用户无感）。

---

## 13. 迁移与兼容

- **默认值**：`searchConfig.provider = 'auto'` → **现有用户零感知**，行为不变。
- **无 Key 回退**：任何“选了需 Key 但没填”的情况都退回 DDG，不存在“升级后搜索坏了”。
- **凭证类型扩展**：`CredentialType` 加 `'web_search_api_key'` 是**加法**，不影响现有 LLM Key 读写。`accountToCredentialId` 的 type 白名单同步扩展。
- **接口不变**：`WebSearchProvider` / `WebSearchResult` 不改，现有 DDG/OpenAI/Google Provider 零改动。
- **向后兼容**：旧 `config.json`（无 `searchConfig` 字段）→ `getSearchConfig()` 返回 `DEFAULT_SEARCH_CONFIG`。

---

## 14. 风险与对策

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| DeepSeek-native 每次搜索消耗一个模型轮次 | 成本/延迟高 | UI 明确提示；默认 Provider 保持 `auto`/DDG，不把 deepseek 设为默认 |
| 子进程 Key 明文驻留内存 | 安全 | 与现有 LLM Key 同风险等级（LLM Key 也是这样下发的）；不写盘；`search_config_update` 仅传增量 |
| `pi-agent.ts` 的 `sendInit` 当前同步，读 Key 异步 | 初始化时序 | Key 解析提前到 spawn 前（与 `piAuth` 解析同位置），暂存后同步发 |
| 用户填了脱敏占位符当 Key | 写入错误数据 | handler 对含 `••` 的值不写库（与 LLM Key 处理一致，llm-connections.ts 137 行 `isMasked` 模式） |
| Exa 丢弃无 highlight 项 → 结果偏少 | 体验 | 接缝层 DDG 兜底；后续可考虑 fallback 到 URL-only |
| Provider endpoint 被代理/墙 | 不可用 | `baseURL` 可配；失败走 DDG |
| 多运行时（CLI/headless server） | 配置入口不一 | 配置/凭证走 `@bitlab/shared`，主进程抽象统一；CLI/server 复用同一 `getSearchConfig()` + 凭证库 |

---

## 15. 实现顺序建议（落地时的 PR 拆分）

> 本文档阶段不实现，以下仅为后续实施时的推荐顺序。

1. **配置 + 凭证底座**（第 5、6 节）：`search.ts` 类型、`storage.ts` getter/setter、`CredentialType`/`manager` 扩展 + 单测。纯底座，无 UI、无子进程。
2. **新 Provider**（第 4 节）：`tavily.ts`/`exa.ts`/`deepseek.ts` + 单测。可独立 mock 测试。
3. **接缝改写**（第 9 节）：`resolveSearchProvider` 新签名 + `auto` 派生收纳 + 无 Key 回退。单测覆盖。
4. **子进程下发**（第 8 节）：`InitMessage`/`search_config_update` + `pi-agent.ts` 下发 + `ensureSession` 动态 getter 改写。
5. **RPC/IPC/preload**（第 7 节）：通道 + handler + channel-map + types。
6. **UI + i18n**（第 10、11 节）：Plugins 页 + 图标 + 双 locale key。
7. **手测与打磨**（第 12.3 节）。

---

## 附录 A：相关文件清单（改动/新增）

```
新增：
  packages/shared/src/config/search.ts                              # 搜索配置类型
  packages/pi-agent-server/src/tools/search/providers/tavily.ts     # Tavily Provider
  packages/pi-agent-server/src/tools/search/providers/exa.ts        # Exa Provider
  packages/pi-agent-server/src/tools/search/providers/deepseek.ts   # DeepSeek-native Provider
  packages/pi-agent-server/src/tools/search/providers/tavily.test.ts
  packages/pi-agent-server/src/tools/search/providers/exa.test.ts
  packages/pi-agent-server/src/tools/search/providers/deepseek.test.ts
  apps/electron/src/renderer/pages/settings/PluginsSettingsPage.tsx # Plugins 设置页

改动：
  packages/shared/src/config/storage.ts                             # StoredConfig + get/setSearchConfig + 默认值
  packages/shared/src/credentials/types.ts                          # CredentialType 加 web_search_api_key
  packages/shared/src/credentials/manager.ts                        # get/set/delete/getMasked SearchApiKey
  packages/shared/src/protocol/channels.ts                          # search 命名空间
  packages/server-core/src/handlers/rpc/settings.ts                 # search.* handler
  packages/pi-agent-server/src/index.ts                             # InitMessage + search_config_update + ensureSession getter
  packages/pi-agent-server/src/tools/search/resolve-provider.ts     # 新签名 + auto 收纳 + 回退
  packages/pi-agent-server/src/tools/search/resolve-provider.test.ts
  packages/shared/src/agent/pi-agent.ts                             # init 下发 searchConfig + searchApiKeys
  apps/electron/src/transport/channel-map.ts                        # search.* 映射
  apps/electron/src/shared/types.ts                                 # ElectronAPI.search
  apps/electron/src/shared/settings-registry.ts                     # plugins 页注册
  apps/electron/src/renderer/pages/settings/settings-pages.ts       # 组件注册
  apps/electron/src/renderer/components/icons/SettingsIcons.tsx     # plugins 图标
  apps/electron/src/main/.../menu-schema.ts                         # 菜单项
  apps/electron/resources/config-defaults.json                      # searchConfig 默认
  packages/shared/src/i18n/locales/en.json                          # 新 key
  packages/shared/src/i18n/locales/zh-Hans.json                     # 新 key（parity）
```

## 附录 B：竞品参考映射

| 本设计 | 竞品（deepseek-harness） |
| --- | --- |
| `create-search-tool.ts`（工具外壳，已有） | `packages/web/tool-web/src/search.ts` |
| `resolve-provider.ts`（接缝） | `packages/web/web/src/index.ts`（`WebRuntime` + `resolveProvider`） |
| `providers/ddg.ts` | （竞品无 DDG，最接近的是默认 deepseek） |
| `providers/tavily.ts`（新） | （竞品无，新增） |
| `providers/exa.ts`（新） | `packages/web/web-search-exa/src/provider.ts` |
| `providers/deepseek.ts`（新） | `packages/web/web-search-deepseek/src/provider.ts` + `types.ts` |
| `WebSearchProvider`/`WebSearchResult` | `packages/web/web/src/types.ts`（`WebSearchProvider`/`WebSearchSource`） |
| 加密凭证库（现有） | `@deepseek-ai/dsh-credentials` |
| `StoredConfig.searchConfig` | 竞品 settings section `web-search-deepseek` |
| `search_config_update` 消息 | 竞品单进程无需此机制 |
