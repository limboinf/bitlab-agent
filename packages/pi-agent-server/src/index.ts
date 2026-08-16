#!/usr/bin/env node
/**
 * Pi Agent Server
 *
 * Out-of-process Pi agent server communicating via JSONL over stdio.
 * Wraps @earendil-works/pi-coding-agent SDK and communicates with the main
 * Electron process using a line-delimited JSON protocol.
 *
 * The main process spawns this as a child process. All Pi SDK interactions
 * (session creation, prompting, tool execution, permissions) happen here,
 * with events forwarded back to the main process for UI rendering.
 *
 * This design isolates the Pi SDK's ESM + heavy dependencies into a
 * separate process, avoiding bundling issues in the Electron main process.
 */

import http from 'node:http';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

// Pi SDK
import {
  createAgentSession,
  SessionManager as PiSessionManager,
  AuthStorage as PiAuthStorage,
  ModelRegistry as PiModelRegistry,
  SettingsManager as PiSettingsManager,
  createReadToolDefinition,
  createBashToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentSession,
  AgentSessionEvent,
  AgentToolResult,
  AuthCredential,
  AuthStorageBackend,
  CreateAgentSessionOptions,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// Pi AI types
import type { TextContent as PiTextContent } from '@earendil-works/pi-ai';

// Pre-register the Bedrock provider module so the Pi SDK doesn't attempt a
// dynamic import of "./amazon-bedrock.js" — which fails in the bundled output
// because bun collapses everything into a single file.
// pi-ai is deduped (single hoisted copy), so one registration covers both
// pi-ai and pi-agent-core module scopes.
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
setBedrockProviderModule(bedrockProviderModule);

// Model resolution (extracted for testability + custom-endpoint precedence)
import { resolvePiModel, isDeniedMiniModelId, isModelNotFoundError } from './model-resolution.ts';
import { pickProviderAppropriateMiniModel } from './pick-mini-model.ts';
import {
  buildCustomEndpointModelDef,
  normalizeCustomEndpointModelEntry,
  stripPiPrefix,
  type CustomEndpointModelEntry,
  type CustomEndpointModelOverrides,
} from './custom-endpoint-models.ts';

// Direct source imports from shared (bundled by bun build)
import { handleLargeResponse, estimateTokens, tokenLimitFor } from '../../shared/src/utils/large-response.ts';
import { getSessionPlansPath, getSessionPath } from '../../shared/src/sessions/storage.ts';
import { buildCallLlmRequest, withTimeout, LLM_QUERY_TIMEOUT_MS } from '../../shared/src/agent/llm-tool.ts';
import type { LLMQueryRequest, LLMQueryResult } from '../../shared/src/agent/llm-tool.ts';
import { PI_TOOL_NAME_MAP, THINKING_TO_PI } from '../../shared/src/agent/backend/pi/constants.ts';
import { getDefaultSummarizationModel } from '../../shared/src/config/models.ts';
import { createWebFetchTool } from './tools/web-fetch.ts';
import { resolveSearchProvider } from './tools/search/resolve-provider.ts';
import { createSearchTool } from './tools/search/create-search-tool.ts';
import type { KeyedSearchProviderId, SearchConfig } from './tools/search/types.ts';
import { allowBitlabMetadataProperties, stripBitlabMetadata } from './bitlab-metadata-schema.ts';
import { computeContextBreakdown } from './context-breakdown.ts';
import type { ContextBreakdown, ToolWireShape } from './context-breakdown.ts';

// MCP (pi-mcp-adapter runs in-process as an inline Pi extension)
import type {
  AdapterMcpConfig,
  McpApprovalDecision,
  McpApprovalRequestPayload,
  McpStatusSnapshot,
} from './mcp/types.ts';
import {
  buildAdapterExtension,
  clearPendingMcpApprovals,
  createMcpHostExtension,
  hasMcpServers,
  interpretMcpAuthResult,
  resolveMcpApproval,
  setCurrentMcpConfig,
  createMcpUiBridge,
  type McpProxyToolResult,
} from './mcp/mcp-extension.ts';
import { BitlabResourceLoader } from './resource-loader.ts';
import { PiSkillBridge } from './skill-bridge.ts';
import { SkillCatalog } from '@bitlab/shared/skills';

// ============================================================
// Types — JSONL Protocol
// ============================================================

/** Credential union used in init and token_update messages */
type PiCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number };

/** Custom endpoint protocol — determines which streaming adapter Pi SDK uses */
type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';

/** Init message from main process — configures the Pi agent server */
interface InitMessage {
  type: 'init';
  apiKey: string;
  model: string;
  cwd: string;
  thinkingLevel: string;
  workspaceRootPath: string;
  sessionId: string;
  sessionPath: string;
  workingDirectory: string;
  plansFolderPath: string;
  miniModel?: string;
  agentDir?: string;
  providerType?: string;
  authType?: string;
  workspaceId?: string;
  baseUrl?: string;
  branchFromSdkSessionId?: string;
  branchFromSessionPath?: string;
  branchFromSdkTurnId?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean; supportsThinking?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean; supportsThinking?: boolean }>;
  piAuth?: { provider: string; credential: PiCredential };
  /** web_search provider selection (Settings → Plugins). Absent = 'auto'. */
  searchConfig?: SearchConfig;
  /**
   * Search API keys resolved by the main process. The credential store lives in
   * the main process only — this subprocess just holds what it was handed.
   */
  searchApiKeys?: Partial<Record<KeyedSearchProviderId, string>>;
  /**
   * MCP adapter config snapshot built by the main process from Bitlab's
   * config.json (see shared/src/config/mcp.ts buildAdapterMcpConfig). The
   * adapter NEVER reads ambient MCP config files — this programmatic snapshot
   * is the only source. Absent or empty `mcpServers` = MCP disabled.
   */
  mcpConfig?: AdapterMcpConfig;
}

interface RuntimeConfigUpdateMessage {
  type: 'update_runtime_config';
  id: string;
  model: string;
  providerType?: string;
  authType?: string;
  baseUrl?: string;
  customEndpoint?: { api: CustomEndpointApi; supportsImages?: boolean; supportsThinking?: boolean };
  customModels?: Array<string | { id: string; contextWindow?: number; supportsImages?: boolean; supportsThinking?: boolean }>;
}

/** Messages from main process (stdin) */
type InboundMessage =
  | InitMessage
  | { type: 'prompt'; id: string; message: string; systemPrompt: string; images?: Array<{ type: 'image'; data: string; mimeType: string }> }
  | { type: 'register_tools'; tools: ProxyToolDef[] }
  | { type: 'tool_execute_response'; requestId: string; result: { content: string; isError: boolean } }
  | { type: 'pre_tool_use_response'; requestId: string; action: 'allow' | 'block' | 'modify'; input?: Record<string, unknown>; reason?: string }
  | { type: 'abort' }
  | { type: 'mini_completion'; id: string; prompt: string }
  | { type: 'llm_query'; id: string; request: LLMQueryRequest }
  | { type: 'ensure_session_ready'; id: string }
  | { type: 'set_model'; model: string }
  | { type: 'set_thinking_level'; level: string }
  | { type: 'compact'; id: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id: string; enabled: boolean }
  | RuntimeConfigUpdateMessage
  | { type: 'steer'; message: string }
  | { type: 'token_update'; piAuth: { provider: string; credential: PiCredential } }
  | { type: 'search_config_update'; searchConfig: SearchConfig; searchApiKeys: Partial<Record<KeyedSearchProviderId, string>> }
  | { type: 'update_mcp_config'; mcpConfig: AdapterMcpConfig }
  | { type: 'skills_changed' }
  | { type: 'mcp_approval_response'; requestId: string; decision: McpApprovalDecision }
  | { type: 'mcp_auth'; id: string; serverName: string }
  | { type: 'mcp_logout'; id: string; serverName: string; url: string }
  | { type: 'shutdown' };

/** Proxy tool definition from main process */
interface ProxyToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Canonical tool metadata propagated on Pi tool start events */
interface ToolExecutionMetadata {
  intent?: string;
  displayName?: string;
  source: 'interceptor';
}

type EnrichedToolExecutionStartEvent = Extract<AgentSessionEvent, { type: 'tool_execution_start' }> & {
  toolMetadata?: ToolExecutionMetadata;
};

type OutboundAgentEvent = AgentSessionEvent | EnrichedToolExecutionStartEvent;

/** Messages to main process (stdout) */
interface OutboundReady { type: 'ready'; sessionId: string | null; callbackPort: number }
interface OutboundEvent { type: 'event'; event: OutboundAgentEvent }
/**
 * Context-meter reading. `tokens`/`percent` are the SDK's provider-anchored
 * occupancy (null right after a compaction, until a fresh response lands);
 * `breakdown` is the independent heuristic composition and does NOT sum to
 * `tokens` — see context-breakdown.ts.
 */
interface OutboundContextUsage {
  type: 'context_usage';
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
  breakdown: ContextBreakdown;
}
interface OutboundPreToolUseReq {
  type: 'pre_tool_use_request';
  requestId: string;
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface OutboundToolExecReq { type: 'tool_execute_request'; requestId: string; toolName: string; args: Record<string, unknown> }
interface OutboundSessionToolCompleted { type: 'session_tool_completed'; toolName: string; args: Record<string, unknown>; isError: boolean }
interface OutboundMiniResult { type: 'mini_completion_result'; id: string; text: string | null }
interface OutboundLlmQueryResult {
  type: 'llm_query_result';
  id: string;
  result: LLMQueryResult | null;
  errorMessage?: string;
  /**
   * When set, signals the main process that a generic `error` with the same code
   * was also emitted on the error channel (for centralized auth-refresh detection).
   */
  errorCode?: string;
}
interface OutboundEnsureSessionReadyResult { type: 'ensure_session_ready_result'; id: string; sessionId: string | null }
interface OutboundCompactResult {
  type: 'compact_result';
  id: string;
  success: boolean;
  result?: { summary: string; firstKeptEntryId: string; tokensBefore: number };
  errorMessage?: string;
}
interface OutboundSetAutoCompactionResult {
  type: 'set_auto_compaction_result';
  id: string;
  success: boolean;
  enabled: boolean;
  errorMessage?: string;
}
interface OutboundRuntimeConfigUpdateResult {
  type: 'update_runtime_config_result';
  id: string;
  success: boolean;
  updated: boolean;
  errorMessage?: string;
}
interface OutboundSessionIdUpdate { type: 'session_id_update'; sessionId: string }
interface OutboundOAuthCredentialUpdate {
  type: 'oauth_credential_update';
  provider: string;
  credential: Extract<PiCredential, { type: 'oauth' }>;
  previousRefresh?: string;
}
/**
 * MCP server status snapshot published by the pi-mcp-adapter extension
 * (channel `pi-mcp-adapter/status/v1`). Forwarded verbatim.
 */
interface OutboundMcpStatus { type: 'mcp_status'; snapshot: McpStatusSnapshot }
/**
 * MCP tool-call approval ask. The adapter waits for the paired
 * `mcp_approval_response` — see mcp-extension.ts for the fail-closed rules.
 */
interface OutboundMcpApprovalRequest extends McpApprovalRequestPayload {
  type: 'mcp_approval_request';
}
/** Adapter ui.notify forwarded from the UI bridge (auth progress, notices). */
interface OutboundMcpNotify {
  type: 'mcp_notify';
  message: string;
  level: 'info' | 'warning' | 'error';
}
/**
 * Result of an MCP operation round-trip (`mcp_auth`, `mcp_logout`).
 *
 * `code` is the adapter's own outcome tag (`auth_required`, `connect_failed`,
 * `not_found`, …) or one of this server's own (`no_session`, `no_proxy_tool`).
 * The main process maps it to user-facing text; `message` is the adapter's
 * prose, which is written for an agent ("run mcp({connect:…})") and is only a
 * fallback for codes the UI does not know.
 */
interface OutboundMcpOpResult {
  type: 'mcp_op_result';
  id: string;
  ok: boolean;
  message: string;
  code?: string;
}
interface OutboundError { type: 'error'; message: string; code?: string }

type OutboundMessage =
  | OutboundReady
  | OutboundEvent
  | OutboundContextUsage
  | OutboundPreToolUseReq
  | OutboundToolExecReq
  | OutboundSessionToolCompleted
  | OutboundMiniResult
  | OutboundLlmQueryResult
  | OutboundEnsureSessionReadyResult
  | OutboundCompactResult
  | OutboundSetAutoCompactionResult
  | OutboundRuntimeConfigUpdateResult
  | OutboundSessionIdUpdate
  | OutboundOAuthCredentialUpdate
  | OutboundMcpStatus
  | OutboundMcpApprovalRequest
  | OutboundMcpNotify
  | OutboundMcpOpResult
  | OutboundError;

class OAuthSyncAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => { result: T; next?: string }): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<{ result: T; next?: string }>): Promise<T> {
    const previous = this.value;
    const { result, next } = await fn(previous);
    if (next !== undefined) {
      this.value = next;
      this.sendOAuthCredentialUpdates(previous, next);
    }
    return result;
  }

  private sendOAuthCredentialUpdates(previous: string | undefined, next: string): void {
    const previousCredentials = previous ? JSON.parse(previous) as Record<string, AuthCredential> : {};
    const nextCredentials = JSON.parse(next) as Record<string, AuthCredential>;

    for (const [provider, credential] of Object.entries(nextCredentials)) {
      if (credential.type !== 'oauth') continue;

      const previousCredential = previousCredentials[provider];
      if (JSON.stringify(previousCredential) === JSON.stringify(credential)) continue;

      send({
        type: 'oauth_credential_update',
        provider,
        credential,
        previousRefresh: previousCredential?.type === 'oauth' ? previousCredential.refresh : undefined,
      });
    }
  }
}

// ============================================================
// State
// ============================================================

let piSession: AgentSession | null = null;
let piModelRegistry: PiModelRegistry | null = null;
let moduleAuthStorage: PiAuthStorage | null = null;
let unsubscribeEvents: (() => void) | null = null;

// Init config (set on 'init' message)
let initConfig: Extract<InboundMessage, { type: 'init' }> | null = null;

// Mutable state
let currentUserMessage = '';

// Pending promises for async handshakes
const pendingPreToolUse = new Map<string, { resolve: (response: { action: string; input?: Record<string, unknown>; reason?: string }) => void }>();
const pendingToolExecutions = new Map<string, { resolve: (result: { content: string; isError: boolean }) => void }>();

// Pending proxied session tool calls for completion detection
const pendingSessionToolCalls = new Map<string, { toolName: string; arguments: Record<string, unknown> }>();

// Proxy tool definitions from main process
let proxyToolDefs: ProxyToolDef[] = [];

// Speculative prefetch for read-only tools (enables parallel execution despite Pi SDK's sequential loop).
// When the LLM emits multiple call_llm tool calls in a single message, we fire all requests
// to the main process in parallel on message_end (before executeToolCalls iterates sequentially).
// Each proxy tool's execute() then hits the cache instead of sending a new request.
const PREFETCHABLE_TOOLS = new Set(['call_llm']);
const prefetchCache = new Map<string, Promise<{ content: string; isError: boolean }>>();

function isPrefetchableTool(toolName: string): boolean {
  const stripped = toolName.replace(/^(mcp__session__|session__)/, '');
  return PREFETCHABLE_TOOLS.has(stripped);
}

// Flag: proxy tools changed since last session creation — session needs recreation
let toolsChanged = false;

// Context-meter inputs. The wire shapes are captured at session creation (the
// only moment the full tool set is assembled) and the system prompt at every
// prompt, because the main process rebuilds it per turn.
let activeToolWireShapes: ToolWireShape[] = [];
let activeSystemPrompt: string | undefined;
// Last payload sent, so an unchanged reading costs no IPC.
let lastContextUsageLine: string | null = null;

// Callback server for call_llm
let callbackServer: http.Server | null = null;
let callbackPort = 0;

// Resource loader attached to the ACTIVE session. Always present: it is the
// only attachment point for the skill catalog's loader seams, and Pi consults
// it on every system-prompt rebuild.
let activeLoader: BitlabResourceLoader | null = null;

// Whether the active session was created WITH MCP. A later update_mcp_config on
// a session created without it recreates the session instead of hot-reloading,
// mirroring the register_tools precedent.
let activeSessionHasMcp = false;

// Skill catalog and its bridge into Pi. The catalog is the single resolver for
// discovery, precedence, trust, and enablement; the bridge maps its snapshot
// onto the loader seams.
let skillCatalog: SkillCatalog | null = null;
let skillBridge: PiSkillBridge | null = null;

/**
 * Rebuild the context-meter's tool composition inputs from the session's live
 * tool list. Needed with MCP enabled: adapter tools (`mcp`, `mcp__<server>_<tool>`)
 * register dynamically after servers connect, so the creation-time snapshot
 * alone undercounts.
 */
function refreshActiveToolWireShapesFromSession(): void {
  if (!piSession) return;
  try {
    const tools = (piSession.agent.state.tools ?? []) as Array<{
      name: string;
      description?: string;
      parameters?: unknown;
    }>;
    activeToolWireShapes = tools.map(tool => ({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.parameters,
    }));
  } catch {
    // Meter only — never let it break the protocol.
  }
}

// ============================================================
// JSONL I/O
// ============================================================

function send(msg: OutboundMessage): void {
  const line = JSON.stringify(msg);
  process.stdout.write(line + '\n');
}

function debugLog(message: string): void {
  // Write debug messages to stderr so they don't interfere with JSONL protocol
  process.stderr.write(`[pi-server] ${message}\n`);
}

/**
 * Publish the current context-meter reading, skipping unchanged ones.
 *
 * Occupancy comes from the SDK, which anchors on the last assistant's provider
 * usage and only estimates the messages appended since — so a compaction shows
 * up immediately rather than waiting for the next request to report usage.
 * The breakdown is computed independently and is composition only.
 */
function sendContextUsage(): void {
  if (!piSession) return;
  const usage = piSession.getContextUsage();
  // Omitted when no model or context window is known; nothing to meter yet.
  if (!usage) return;

  const payload: OutboundContextUsage = {
    type: 'context_usage',
    tokens: usage.tokens,
    contextWindow: usage.contextWindow,
    percent: usage.percent,
    breakdown: computeContextBreakdown(
      activeSystemPrompt,
      activeToolWireShapes,
      piSession.messages,
    ),
  };

  const line = JSON.stringify(payload);
  if (line === lastContextUsageLine) return;
  lastContextUsageLine = line;
  send(payload);
}

/** Find the most recent .jsonl session file in a directory. */
function findMostRecentSessionFile(sessionDir: string): string | null {
  if (!existsSync(sessionDir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const entry of readdirSync(sessionDir)) {
    if (!entry.endsWith('.jsonl')) continue;
    const fullPath = join(sessionDir, entry);
    const mtime = statSync(fullPath).mtimeMs;
    if (!best || mtime > best.mtime) {
      best = { path: fullPath, mtime };
    }
  }
  return best?.path ?? null;
}

// ============================================================
// Loopback server used by the call_llm session tool
// ============================================================

async function startCallbackServer(): Promise<void> {
  if (callbackServer) return;

  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/call-llm') {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

      debugLog('Received call_llm request via callback server');
      const result = await preExecuteCallLlm(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLog(`call_llm via callback failed: ${msg}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      callbackPort = typeof addr === 'object' && addr ? addr.port : 0;
      debugLog(`Callback server listening on 127.0.0.1:${callbackPort}`);
      resolve();
    });
    server.on('error', reject);
  });

  callbackServer = server;
}

function stopCallbackServer(): void {
  if (callbackServer) {
    callbackServer.close();
    callbackServer = null;
    callbackPort = 0;
  }
}

// ============================================================
// Pi Session Management
// ============================================================

function resolvedCwd(): string {
  const wd = initConfig?.cwd || initConfig?.workingDirectory || process.cwd();
  if (wd.startsWith('~/')) return join(homedir(), wd.slice(2));
  if (wd === '~') return homedir();
  return wd;
}

// Helper: derive preferCustomEndpoint flag from init config
function shouldPreferCustomEndpoint(): boolean {
  return Boolean(initConfig?.customEndpoint && initConfig?.baseUrl?.trim());
}

/**
 * Expose the active Pi model API/provider/base URL to the interceptor process.
 * This gives the interceptor a robust routing hint (instead of brittle URL-only matching).
 */
function setInterceptorApiHints(model: { api?: string; provider?: string; baseUrl?: string } | undefined): void {
  if (!model) {
    delete process.env.BITLAB_PI_MODEL_API;
    delete process.env.BITLAB_PI_MODEL_PROVIDER;
    delete process.env.BITLAB_PI_MODEL_BASE_URL;
    return;
  }

  process.env.BITLAB_PI_MODEL_API = model.api || '';
  process.env.BITLAB_PI_MODEL_PROVIDER = model.provider || '';
  process.env.BITLAB_PI_MODEL_BASE_URL = model.baseUrl || '';

  debugLog(
    `[interceptor-hint] api=${process.env.BITLAB_PI_MODEL_API || '-'} provider=${process.env.BITLAB_PI_MODEL_PROVIDER || '-'} baseUrl=${process.env.BITLAB_PI_MODEL_BASE_URL || '-'}`,
  );
}

/**
 * Resolve the API key for custom endpoint auth.
 * Returns empty string for local endpoints (Ollama etc.) that don't need auth.
 */
function resolveCustomEndpointApiKey(): string {
  if (initConfig?.piAuth?.credential?.type === 'api_key') {
    return initConfig.piAuth.credential.key;
  }
  const key = initConfig?.apiKey || '';
  if (!key && initConfig?.baseUrl) {
    if (isLocalhostUrl(initConfig.baseUrl)) {
      // Local endpoints (Ollama, LM Studio) don't need auth.
      // Pi SDK requires a truthy apiKey to register models, so use a placeholder.
      return 'not-needed';
    }
    debugLog('[custom-endpoint] Warning: no API key found for non-localhost endpoint — requests will likely fail');
  }
  return key;
}

function isLocalhostUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const normalizedHostname = hostname.startsWith('[') && hostname.endsWith(']')
      ? hostname.slice(1, -1)
      : hostname;
    return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
  } catch {
    return false;
  }
}

/** Model IDs currently registered under the custom-endpoint provider */
let customEndpointModelIds: Set<string> = new Set();

/**
 * Register (or re-register) the custom-endpoint provider with the given models.
 * Note: registerProvider replaces the entire provider, so we maintain a Set of all
 * known model IDs and always pass the full set.
 */
const customModelOverrides = new Map<string, CustomEndpointModelOverrides>();

function registerCustomEndpointModels(
  registry: PiModelRegistry,
  api: CustomEndpointApi,
  baseUrl: string,
  models: CustomEndpointModelEntry[],
): void {
  for (const m of models) {
    customEndpointModelIds.add(m.id);
    if (m.contextWindow || m.supportsImages !== undefined || m.supportsThinking !== undefined) {
      customModelOverrides.set(m.id, {
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.supportsImages !== undefined ? { supportsImages: m.supportsImages } : {}),
        ...(m.supportsThinking !== undefined ? { supportsThinking: m.supportsThinking } : {}),
      });
    }
  }
  const allIds = [...customEndpointModelIds];
  registry.registerProvider('custom-endpoint', {
    baseUrl,
    apiKey: resolveCustomEndpointApiKey(),
    api,
    authHeader: true,
    models: allIds.map(id => buildCustomEndpointModelDef(
      id,
      {
        supportsImages: initConfig?.customEndpoint?.supportsImages === true,
        supportsThinking: initConfig?.customEndpoint?.supportsThinking === true,
      },
      customModelOverrides.get(id),
    )),
  });
  debugLog(`Registered custom endpoint: ${baseUrl} with ${allIds.length} model(s) [${allIds.join(', ')}], api: ${api}`);
}

/**
 * Create an in-memory auth storage pre-loaded with the user's credentials
 * and a model registry backed by it. Used by both the main session and
 * ephemeral queryLlm sessions.
 */
function createAuthenticatedRegistry(): {
  authStorage: PiAuthStorage;
  modelRegistry: PiModelRegistry;
} {
  // Reuse module-level authStorage if already created (allows token_update to mutate it).
  // Only create a new one on first call or after re-init.
  if (!moduleAuthStorage) {
    moduleAuthStorage = PiAuthStorage.fromStorage(new OAuthSyncAuthStorageBackend());
  }
  const authStorage = moduleAuthStorage;
  if (initConfig?.piAuth) {
    const { provider, credential } = initConfig.piAuth;
    // Pi's public credential type does not include 'iam', but auth storage accepts it at runtime
    // — the Bedrock provider module reads AWS env directly; this `set` keeps Pi SDK's
    // internal provider-tracking consistent regardless of credential shape.
    authStorage.set(provider, credential as unknown as AuthCredential);
    debugLog(`Injected ${credential.type} credential for provider: ${provider}`);
  } else if (initConfig?.apiKey) {
    authStorage.set('anthropic', { type: 'api_key', key: initConfig.apiKey });
    debugLog('Injected API key into auth storage (legacy fallback)');
  }

  const modelRegistry = PiModelRegistry.inMemory(authStorage);

  // Register custom endpoint models dynamically via Pi SDK's registerProvider API.
  // This makes arbitrary OpenAI/Anthropic-compatible endpoints work through the Pi SDK
  // by creating synthetic Model<Api> objects that the SDK requires.
  const hasCustomEndpoint = !!initConfig?.baseUrl?.trim();
  if (hasCustomEndpoint && initConfig?.customEndpoint) {
    const { api } = initConfig.customEndpoint;
    const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
      ? initConfig.customModels
      : [initConfig.model || 'default']
    ).map(normalizeCustomEndpointModelEntry);
    customEndpointModelIds = new Set();  // Reset on fresh registry creation
    registerCustomEndpointModels(modelRegistry, api, initConfig.baseUrl!.trim(), modelEntries);
  } else if (hasCustomEndpoint && !initConfig?.customEndpoint) {
    debugLog('Custom endpoint without protocol config — models may not resolve. Set customEndpoint.api for proper routing.');
  }

  return { authStorage, modelRegistry };
}

async function ensureSession(): Promise<AgentSession> {
  if (piSession) return piSession;
  if (!initConfig) throw new Error('Cannot create session: init not received');

  const cwd = resolvedCwd();

  const { authStorage, modelRegistry } = createAuthenticatedRegistry();
  // Store at module scope for set_model handler
  piModelRegistry = modelRegistry;

  // Build tools: coding tools + web tools wrapped with permission hooks + proxy tools.
  // Search provider comes from the user's explicit selection, or — under the
  // default 'auto' — from the LLM connection (see resolve-provider.ts).
  //
  // IMPORTANT: resolve dynamically on each search call so token_update and
  // search_config_update refreshes are used without recreating the session.
  const currentSearchOptions = () => ({
    piAuth: initConfig?.piAuth,
    searchConfig: initConfig?.searchConfig,
    resolveKey: (id: KeyedSearchProviderId) => initConfig?.searchApiKeys?.[id] ?? null,
  });
  const searchProvider = {
    get name() {
      return resolveSearchProvider(currentSearchOptions()).name;
    },
    async search(query: string, count: number) {
      return resolveSearchProvider(currentSearchOptions()).search(query, count);
    },
  };
  const searchTool = createSearchTool(searchProvider);
  const webFetchTool = createWebFetchTool(() =>
    initConfig ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId) : null
  );
  const webTools = [searchTool, webFetchTool];

  // Pi SDK 0.70.0 registration contract:
  //   - `customTools` accepts ToolDefinition[] — our hook-wrapped objects go here
  //   - `tools` is a string[] name allowlist — MUST include every tool we want active,
  //     otherwise Pi SDK defaults to the built-in [read, bash, edit, write] set and
  //     silently filters out everything else. Custom tool names with matching built-in
  //     names override the SDK's raw implementation inside _refreshToolRegistry, so
  //     our hooked versions take effect (permissions + large-response summarization).
  //   - Do NOT pass tool *objects* to `tools` — `allowedToolNames = new Set(options.tools)`
  //     then `.has(name)` returns false for every string lookup → zero tools active.
  //
  // MCP EXCEPTION: when MCP servers are configured we must OMIT `tools`
  // entirely. `_refreshToolRegistry` (agent-session.js) filters the whole tool
  // REGISTRY through `isAllowedTool(name) = allowedToolNames?.has(name)`; the
  // adapter's tools are dynamically named (`mcp`, `mcpScript`,
  // `mcp__<server>_<tool>` — the exact set is only known after servers connect)
  // so any static allowlist would silently filter them out. With `tools`
  // omitted the constructor's `_buildRuntime({ activeToolNames: ['read',
  // 'bash', 'edit', 'write'], includeAllExtensionTools: true })` activates ALL
  // customTools (our hook-wrapped builtins/web/proxy — they ride the same
  // `allCustomTools` list as extension tools) plus every extension tool, and
  // `_refreshToolRegistry`'s "new registry names" branch auto-activates MCP
  // tools registered later (post-connect). Nothing essential is restricted by
  // dropping the allowlist: it only ever contained our own customTools' names.
  const builtinDefs = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ];
  const proxyTools = buildProxyTools();
  const wrappedAll = wrapToolsWithHooks([...builtinDefs, ...webTools, ...proxyTools]);
  const toolAllowlist = wrappedAll.map(t => t.name);
  const mcpEnabled = hasMcpServers(initConfig.mcpConfig);
  debugLog(`Session tools: ${builtinDefs.length} builtin + ${webTools.length} web + ${proxyTools.length} proxy = ${wrappedAll.length} total${mcpEnabled ? ' (+ MCP extension tools)' : ''}`);

  // Build session options
  const sessionOptions: CreateAgentSessionOptions = {
    cwd,
    authStorage,
    modelRegistry,
    customTools: wrappedAll,
    // See the MCP EXCEPTION note above — omitted when MCP is enabled.
    ...(mcpEnabled ? {} : { tools: toolAllowlist }),
  };

  // Extension isolation: set agentDir to a temp directory under session path
  // to prevent loading global Pi extensions from ~/.pi/agent
  let agentDir: string | undefined;
  let settingsManager: PiSettingsManager | undefined;
  if (initConfig.sessionPath) {
    agentDir = initConfig.agentDir || join(initConfig.sessionPath, '.pi-agent');
    mkdirSync(agentDir, { recursive: true });
    sessionOptions.agentDir = agentDir;
    settingsManager = PiSettingsManager.create(cwd, agentDir);
    const shellPath = process.env.BITLAB_GIT_BASH_PATH?.trim();
    if (shellPath) settingsManager.applyOverrides({ shellPath });
    sessionOptions.settingsManager = settingsManager;

    // Session resume: use a per-Bitlab-session directory so the Pi SDK can
    // persist and resume its own session across subprocess restarts.
    // continueRecent() loads the existing session if one exists, otherwise
    // creates a new one — so this handles both first-run and resume.
    const sessionDir = join(initConfig.sessionPath, '.pi-sessions');
    mkdirSync(sessionDir, { recursive: true });

    if (initConfig.branchFromSessionPath) {
      // Branching: fork from the parent session's Pi session file.
      // Branches must not silently degrade to fresh sessions.
      const parentPiSessionDir = join(initConfig.branchFromSessionPath, '.pi-sessions');
      const parentPiSessionFile = findMostRecentSessionFile(parentPiSessionDir);
      if (!parentPiSessionFile) {
        throw new Error(`Pi branch preflight failed: no parent Pi session file found in ${parentPiSessionDir}`);
      }

      debugLog(`Forking Pi session from parent: ${parentPiSessionFile}`);
      const forkedSessionManager = PiSessionManager.forkFrom(parentPiSessionFile, cwd, sessionDir);

      // Strict branch cutoff: move leaf to the selected parent entry if provided.
      // This is Pi's equivalent of Claude resumeSessionAt.
      if (initConfig.branchFromSdkTurnId) {
        const anchorId = initConfig.branchFromSdkTurnId;
        const anchorEntry = forkedSessionManager.getEntry(anchorId);
        if (!anchorEntry) {
          throw new Error(`Pi branch preflight failed: branch anchor not found: ${anchorId}`);
        }
        forkedSessionManager.branch(anchorId);
        debugLog(`Applied Pi branch cutoff at entry: ${anchorId}`);
      }

      sessionOptions.sessionManager = forkedSessionManager;
    } else {
      sessionOptions.sessionManager = PiSessionManager.continueRecent(cwd, sessionDir);
    }

  }

  // The resource loader carries the skill catalog into Pi and, when MCP is on,
  // hosts the adapter extensions as well. It is always constructed: without one
  // the SDK builds its own internally, and there is then nowhere to attach the
  // skill seams — the catalog would never reach the model.
  //
  // The adapter also needs an isolated agent dir for its own state (metadata
  // cache at <agentDir>/mcp-cache.json, legacy OAuth import dir), the same way
  // the session isolates extensions; without it the adapter writes to
  // ~/.pi/agent. (The Pi SDK reads this env var too, but every path it guards
  // is one we already pass explicitly.)
  const loaderAgentDir = agentDir ?? join(mkdtempSync(join(tmpdir(), 'bitlab-pi-agent-')), 'pi-agent');
  mkdirSync(loaderAgentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = loaderAgentDir;
  const loaderSettingsManager = settingsManager ?? PiSettingsManager.create(cwd, loaderAgentDir);
  if (!settingsManager) {
    const shellPath = process.env.BITLAB_GIT_BASH_PATH?.trim();
    if (shellPath) loaderSettingsManager.applyOverrides({ shellPath });
  }

  skillCatalog = new SkillCatalog({
    workspaceRoot: initConfig.workspaceRootPath,
    projectRoot: initConfig.workingDirectory || cwd,
  });
  skillBridge = new PiSkillBridge({
    getSnapshot: () => skillCatalog?.snapshot() ?? null,
    getBasePrompt: () => activeSystemPrompt,
    debugLog,
  });

  setCurrentMcpConfig(mcpEnabled ? initConfig.mcpConfig ?? null : null);

  // The adapter's factory snapshots `currentMcpConfig` at invocation time, so
  // session.reload() (hot config update) rebuilds the MCP surface from the
  // latest config.
  const loader = new BitlabResourceLoader({
    cwd,
    agentDir: loaderAgentDir,
    settingsManager: loaderSettingsManager,
    skillSeams: skillBridge.seams(),
    ...(mcpEnabled
      ? {
          adapterExtension: buildAdapterExtension(undefined, debugLog),
          hostExtension: createMcpHostExtension({
            onStatusSnapshot: (snapshot) => {
              send({ type: 'mcp_status', snapshot });
              // The MCP tool surface changes as servers connect/disconnect — keep
              // the context meter's composition inputs current.
              refreshActiveToolWireShapesFromSession();
            },
            onApprovalRequest: (payload) => {
              send({ type: 'mcp_approval_request', ...payload });
            },
            onDebug: debugLog,
          }),
        }
      : {}),
  });
  // SDK contract: when a resourceLoader is passed, createAgentSession does
  // NOT reload it — the caller must do that first.
  await loader.reload();
  sessionOptions.resourceLoader = loader;
  activeLoader = loader;
  activeSessionHasMcp = mcpEnabled;
  if (mcpEnabled) {
    debugLog(`MCP enabled: ${Object.keys(initConfig.mcpConfig?.mcpServers ?? {}).length} server(s)`);
  }

  // Set model if specified
  if (initConfig.model) {
    try {
      const piModel = resolvePiModel(modelRegistry, initConfig.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (piModel) {
        // Verify resolved model's provider is compatible with the authenticated provider.
        // Without this, a model that resolves to a different provider would
        // cause "No API key found" at runtime.
        const resolvedProvider = (piModel as any)?.provider;
        const isCompatible = !initConfig.piAuth ||
          resolvedProvider === initConfig.piAuth.provider ||
          resolvedProvider === 'custom-endpoint';
        if (isCompatible) {
          sessionOptions.model = piModel;
          setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
        } else {
          debugLog(`Model ${initConfig.model} resolved to incompatible provider ${resolvedProvider} (expected ${initConfig.piAuth!.provider}), skipping`);
          setInterceptorApiHints(undefined);
        }
      } else {
        setInterceptorApiHints(undefined);
      }
    } catch {
      debugLog(`Could not resolve Pi model: ${initConfig.model}`);
      setInterceptorApiHints(undefined);
    }
  } else {
    setInterceptorApiHints(undefined);
  }

  // Set thinking level
  const piThinkingLevel = THINKING_TO_PI[initConfig.thinkingLevel as keyof typeof THINKING_TO_PI];
  if (piThinkingLevel) {
    sessionOptions.thinkingLevel = piThinkingLevel;
  }

  // Create the session — tools flow through customTools + allowlist (see comment above).
  const { session } = await createAgentSession(sessionOptions);
  piSession = session;

  // MCP: the Pi SDK only emits `session_start` to extensions from
  // `bindExtensions()` — the TUI entry point. An embedded SDK session never
  // calls it, and pi-mcp-adapter relies on that event to create its runtime
  // state (lazy servers initialize EXCLUSIVELY there; without it every proxy
  // and direct tool call returns "MCP not initialized"). We bind a minimal
  // uiContext bridge at the same time: its presence sets the adapter's
  // `state.ui`, which the one-shot browser OAuth flow requires.
  if (mcpEnabled) {
    try {
      const mcpUiBridge = createMcpUiBridge({
        onNotify: (message, level) => {
          send({ type: 'mcp_notify', message, level });
        },
        onDebug: debugLog,
      });
      await session.bindExtensions({ uiContext: mcpUiBridge as never });
      debugLog('MCP: session_start emitted + UI bridge bound — adapter state initializing');
    } catch (error) {
      debugLog(`MCP: bindExtensions failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  toolsChanged = false;
  activeToolWireShapes = wrappedAll.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  debugLog(`Created Pi session: ${session.sessionId} (${wrappedAll.length} tools)`);

  // Notify main process of session ID
  send({ type: 'session_id_update', sessionId: session.sessionId });

  return session;
}


// ============================================================
// Tool Wrapping (Permission Enforcement + Large Response Summarization)
// ============================================================

/**
 * Shared permission enforcement for both coding tools and proxy tools.
 * Checks mode-manager rules and, in Ask mode, prompts the user via the
 * pending-permissions handshake. Throws on deny or block.
 */
/**
 * Send pre_tool_use_request to main process and wait for response.
 * Returns the (potentially modified) input if approved, throws if blocked.
 * All permission checking and input transforms happen in the main process.
 */
async function requestPreToolUseApproval(
  sdkToolName: string,
  input: Record<string, unknown>,
  toolCallId?: string,
): Promise<Record<string, unknown>> {
  const requestId = `pi-ptu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  send({
    type: 'pre_tool_use_request',
    requestId,
    toolName: sdkToolName,
    ...(toolCallId ? { toolCallId } : {}),
    input,
  });

  const response = await new Promise<{ action: string; input?: Record<string, unknown>; reason?: string }>((resolve) => {
    pendingPreToolUse.set(requestId, { resolve });
  });

  if (response.action === 'block') {
    throw new Error(response.reason || `Tool "${sdkToolName}" is not allowed`);
  }

  return response.action === 'modify' && response.input ? response.input : input;
}

function wrapToolsWithHooks(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map(tool => wrapSingleTool(tool));
}

function makeErrorResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: 'text', text: message }],
    details: { isError: true },
  };
}

function wrapSingleTool(tool: ToolDefinition<any, any>): ToolDefinition<any, any> {
  const originalExecute = tool.execute;
  const parameters = allowBitlabMetadataProperties(tool.parameters);

  const wrappedExecute: ToolDefinition<any, any>['execute'] = async (
    toolCallId,
    params,
    signal,
    onUpdate,
    ctx,
  ) => {
    const sdkToolName = PI_TOOL_NAME_MAP[tool.name] || tool.name;
    let inputObj: Record<string, unknown> = { ...(params as Record<string, unknown>) };

    // Extract intent before main process strips metadata (used for summarization)
    const intent = typeof inputObj._intent === 'string' ? inputObj._intent : undefined;

    // Normalize Pi SDK parameter names: path → file_path
    if ((sdkToolName === 'Write' || sdkToolName === 'Edit' || sdkToolName === 'MultiEdit' || sdkToolName === 'NotebookEdit')
        && typeof inputObj.path === 'string' && !inputObj.file_path) {
      inputObj = { ...inputObj, file_path: inputObj.path };
    }

    // Send to main process for permission checking + transforms
    inputObj = await requestPreToolUseApproval(sdkToolName, inputObj, toolCallId);

    // Metadata is for Bitlab UI only. Keep a final defensive strip here so the
    // upstream Pi tool implementation always receives clean executable args,
    // even if a future pre-tool-use path returns `allow` without modification.
    inputObj = stripBitlabMetadata(inputObj);

    // Execute original tool with (potentially modified) input
    const result = await originalExecute(toolCallId, inputObj, signal, onUpdate, ctx);

    // --- Post-execute: large response summarization ---

    const resultText = result.content
      .filter((c): c is PiTextContent => c.type === 'text')
      .map(c => c.text)
      .join('');

    // Source the active model's contextWindow each call so the threshold
    // tracks set_model mid-session, not the model that was active at session
    // creation. Falls back to the fixed default when the model isn't set yet.
    const modelContextWindow = piSession?.agent.state.model?.contextWindow;
    if (estimateTokens(resultText) > tokenLimitFor(modelContextWindow) && initConfig) {
      try {
        const sessionPath = getSessionPath(
          initConfig.workspaceRootPath,
          initConfig.sessionId,
        );

        const largeResult = await handleLargeResponse({
          text: resultText,
          sessionPath,
          context: {
            toolName: sdkToolName,
            input: inputObj,
            intent,
            userRequest: currentUserMessage,
          },
          summarize: runMiniCompletion,
          contextWindow: modelContextWindow,
        });

        if (largeResult) {
          return {
            content: [{ type: 'text', text: largeResult.message }],
            details: result.details,
          };
        }
      } catch (error) {
        debugLog(
          `Large response handling failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return result;
  };

  return {
    ...tool,
    parameters,
    execute: wrappedExecute,
  };
}

// ============================================================
// Proxy Tools (tools executed in main process)
// ============================================================

function buildProxyTools(): ToolDefinition<any, any>[] {
  debugLog(`Building proxy tools from ${proxyToolDefs.length} definitions: ${proxyToolDefs.map(t => t.name).join(', ')}`);

  return proxyToolDefs.map<ToolDefinition<any, any>>(def => ({
    name: def.name,
    label: def.name
      .replace(/^mcp__.*?__/, '')
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2'),
    description: def.description,
    // Pi SDK omits tools without promptSnippet from the system prompt's
    // "Available tools" section, making them invisible to the LLM.
    // Derive a snippet from the description so proxy tools are listed.
    promptSnippet: def.description.length > 200
      ? def.description.slice(0, 197) + '...'
      : def.description,
    parameters: def.inputSchema,
    execute: async (
      toolCallId: string,
      params: any,
    ): Promise<AgentToolResult<any>> => {
      // Check speculative prefetch cache first (parallel call_llm optimization).
      // If this tool was prefetched on message_end, the request is already in-flight —
      // just await the result instead of sending a duplicate request.
      const prefetched = prefetchCache.get(toolCallId);
      if (prefetched) {
        prefetchCache.delete(toolCallId);
        debugLog(`Prefetch cache hit for ${def.name} (toolCallId: ${toolCallId})`);
        const result = await prefetched;
        return {
          content: [{ type: 'text', text: result.content }],
          details: result.isError ? { isError: true } : undefined,
        };
      }

      const inputObj = params as Record<string, unknown>;

      // Permission checking via main process
      const approvedInput = await requestPreToolUseApproval(def.name, inputObj, toolCallId);

      // Execute via main process
      const requestId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      send({
        type: 'tool_execute_request',
        requestId,
        toolName: def.name,
        args: approvedInput,
      });

      const result = await new Promise<{ content: string; isError: boolean }>((resolve) => {
        pendingToolExecutions.set(requestId, { resolve });
      });

      return {
        content: [{ type: 'text', text: result.content }],
        details: result.isError ? { isError: true } : undefined,
      };
    },
  }));
}

// ============================================================
// LLM Query (ephemeral session for call_llm + mini completions)
// ============================================================

async function queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
  if (!initConfig) throw new Error('Cannot run queryLlm: init not received');

  debugLog('[queryLlm] Starting');

  // Pick mini model. If the configured miniModel uses a different provider than
  // what the user authenticated with (e.g. gemini-2.5-pro when only anthropic
  // credentials exist), fall back to the default summarization model which uses
  // the same provider family.
  let model = request.model ?? initConfig.miniModel ?? getDefaultSummarizationModel();

  // Create authenticated registry upfront — used by both the provider guard and the ephemeral session.
  const { authStorage, modelRegistry } = createAuthenticatedRegistry();

  const piAuthProvider = initConfig.piAuth?.provider;

  // If piAuth is set, ensure the mini model uses the same provider.
  // Pi SDK will fail with "No API key found" if the model requires a different provider.
  // Exception: 'custom-endpoint' provider is always compatible because it has its own
  // API key configured via resolveCustomEndpointApiKey() and doesn't use authStorage.
  if (initConfig.piAuth) {
    const authProvider = initConfig.piAuth.provider;
    const bareModel = model.startsWith('pi/') ? model.slice(3) : model;
    const resolved = resolvePiModel(modelRegistry, bareModel, authProvider, shouldPreferCustomEndpoint());
    const resolvedProvider = (resolved as any)?.provider;
    const isCompatible = resolvedProvider === authProvider || resolvedProvider === 'custom-endpoint';
    if (!resolved || !isCompatible || isDeniedMiniModelId(model, piAuthProvider)) {
      // Anthropic: keep Haiku (the cheap/fast mini). For every other provider
      // Haiku is unresolvable, so walk PI_PREFERRED_DEFAULTS for a model that
      // actually works under the user's auth.
      const providerDefault = authProvider === 'anthropic'
        ? undefined
        : pickProviderAppropriateMiniModel(authProvider, modelRegistry, shouldPreferCustomEndpoint());
      const fallback = providerDefault ?? getDefaultSummarizationModel();
      debugLog(`[queryLlm] Model ${bareModel} incompatible with ${authProvider} (resolved: ${resolvedProvider}), falling back to ${fallback}`);
      model = fallback;
    }
  }

  const runQueryWithModel = async (modelId: string): Promise<string> => {
    debugLog(`[queryLlm] Using model: ${modelId}`);

    // Resolve model — fail fast if unresolvable so we don't let the Pi SDK
    // fall back to its own internal default (which may require a provider
    // the user hasn't authenticated with, surfacing as a misleading
    // "No API key found for <provider>" error).
    const piModel = resolvePiModel(modelRegistry, modelId, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
    if (!piModel) {
      throw new Error(
        `Could not resolve mini model "${modelId}" for provider "${initConfig!.piAuth?.provider ?? '(unknown)'}"`,
      );
    }

    // Create minimal ephemeral session
    const ephemeralOptions: CreateAgentSessionOptions = {
      cwd: resolvedCwd(),
      authStorage,
      modelRegistry,
      tools: [],
      sessionManager: PiSessionManager.inMemory(),
      model: piModel,
    };

    // The prompt reaches the session through its resource loader, which Pi
    // consults on every rebuild — so it survives `prompt()` resets without
    // reaching into session internals. No skills here: this is a one-shot
    // utility call, and with no tools active Pi would drop the catalog anyway.
    const promptForSession =
      request.systemPrompt ?? 'Reply with ONLY the requested text. No explanation.';
    const ephemeralLoader = new BitlabResourceLoader({
      cwd: resolvedCwd(),
      agentDir: mkdtempSync(join(tmpdir(), 'bitlab-pi-ephemeral-')),
      skillSeams: {
        noSkills: true,
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        systemPromptOverride: () => promptForSession,
      },
    });
    await ephemeralLoader.reload();
    ephemeralOptions.resourceLoader = ephemeralLoader;

    const { session: ephemeralSession } = await createAgentSession(ephemeralOptions);

    // Pi SDK ignores options.model for ephemeral sessions (same issue as options.tools).
    // Explicitly set the model after creation to ensure the mini model is used.
    try {
      await ephemeralSession.setModel(piModel);
    } catch {
      debugLog(`[queryLlm] Failed to set model on ephemeral session, proceeding with default`);
    }

    debugLog(`[queryLlm] Created ephemeral session: ${ephemeralSession.sessionId}`);

    // Collect response text and errors from events
    let result = '';
    let lastError = '';
    let completionResolve: () => void;
    const completionPromise = new Promise<void>((resolve) => {
      completionResolve = resolve;
    });

    const unsub = ephemeralSession.subscribe((event: AgentSessionEvent) => {
      if (event.type === 'message_end') {
        // Only capture assistant messages — Pi SDK emits message_end for user messages too
        const msg = event.message as {
          role?: string;
          content?: string | Array<{ type: string; text?: string }>;
          stopReason?: string;
          errorMessage?: string;
        };
        if (msg.role !== 'assistant') return;

        // Capture API errors from message_end (e.g. auth failures, model errors)
        if (msg.stopReason === 'error' && msg.errorMessage) {
          lastError = msg.errorMessage;
          debugLog(`[queryLlm] API error in message_end: ${msg.errorMessage}`);
        }

        if (typeof msg.content === 'string') {
          result = msg.content;
        } else if (Array.isArray(msg.content)) {
          result = msg.content
            .filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text!)
            .join('');
        }
      }
      if (event.type === 'agent_end') {
        completionResolve();
      }
    });

    try {
      await ephemeralSession.prompt(request.prompt);
      await withTimeout(
        completionPromise,
        LLM_QUERY_TIMEOUT_MS,
        `queryLlm timed out after ${LLM_QUERY_TIMEOUT_MS / 1000}s`
      );
      debugLog(`[queryLlm] Result length: ${result.trim().length}`);

      // If we got no text but captured an error, throw so callers see the real issue
      if (!result.trim() && lastError) {
        throw new Error(lastError);
      }

      return result.trim();
    } finally {
      unsub();
      ephemeralSession.dispose();
    }
  };

  const fallbackCandidates = [
    // Removed 'pi/gpt-5.1-codex-mini' (#596) — stale on several OpenAI catalogs.
    // The connection-configured miniModel is still tried via `initConfig.miniModel`.
    'pi/gpt-5-mini',
    initConfig.miniModel,
    getDefaultSummarizationModel(),
  ].filter((candidate): candidate is string => !!candidate && !isDeniedMiniModelId(candidate, piAuthProvider));

  const triedModels = new Set<string>();
  let currentModel = model;

  while (true) {
    triedModels.add(currentModel);
    try {
      const text = await runQueryWithModel(currentModel);
      return { text, model: currentModel };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const shouldRetry = isModelNotFoundError(errorMsg);

      if (!shouldRetry) {
        throw error;
      }

      const retryModel = fallbackCandidates.find(candidate => {
        if (triedModels.has(candidate)) return false;
        try {
          const resolved = resolvePiModel(modelRegistry, candidate, initConfig!.piAuth?.provider, shouldPreferCustomEndpoint());
          if (!resolved) return false;
          if (initConfig!.piAuth) {
            const rp = (resolved as any).provider;
            if (rp !== initConfig!.piAuth.provider && rp !== 'custom-endpoint') {
              return false;
            }
          }
          return true;
        } catch {
          return false;
        }
      });

      if (!retryModel) {
        throw error;
      }

      debugLog(`[queryLlm] Model ${currentModel} not found, retrying with ${retryModel}`);
      currentModel = retryModel;
    }
  }
}

async function preExecuteCallLlm(input: Record<string, unknown>): Promise<LLMQueryResult> {
  const sessionPath = initConfig
    ? getSessionPath(initConfig.workspaceRootPath, initConfig.sessionId)
    : undefined;
  const request = await buildCallLlmRequest(input, { backendName: 'Pi', sessionPath });
  return queryLlm(request);
}

async function runMiniCompletion(prompt: string): Promise<string | null> {
  try {
    const result = await queryLlm({ prompt });
    const text = result.text || null;
    debugLog(`[runMiniCompletion] Result: ${text ? `"${text.slice(0, 200)}"` : 'null'}`);
    return text;
  } catch (error) {
    debugLog(`[runMiniCompletion] Failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ============================================================
// Event Handling
// ============================================================

function extractToolExecutionMetadata(args: Record<string, unknown> | undefined): ToolExecutionMetadata | undefined {
  if (!args) return undefined;

  const intent = typeof args._intent === 'string' ? args._intent : undefined;
  const displayName = typeof args._displayName === 'string' ? args._displayName : undefined;

  if (!intent && !displayName) return undefined;

  return {
    intent,
    displayName,
    source: 'interceptor',
  };
}

function handleSessionEvent(event: AgentSessionEvent): void {
  let forwardedEvent: OutboundAgentEvent = event;

  // Log API errors for debugging and attach provider-native turn anchor for branch cutoffs.
  if (event.type === 'message_end') {
    const msg = event.message as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (msg?.stopReason === 'error') {
      debugLog(`API error in message_end: ${msg.errorMessage || 'unknown'}`);
    }

    if (msg?.role === 'assistant' && piSession) {
      // CRITICAL: do NOT read `getLeafId()` here.
      //
      // The Pi SDK fires `message_end` synchronously BEFORE calling
      // `appendMessage(event.message)` (see `agent-session.js:_processAgentEvent`).
      // At this moment the assistant entry does not yet exist in the
      // SessionManager — `leafId` still points at the *previous* leaf, which for
      // a plain text turn is the user message that triggered the response.
      // Recording that wrong anchor and using it for `branch()` makes the next
      // turn a sibling of the assistant message, dropping the assistant reply
      // from the LLM's view of history (bitlab-oss#782).
      //
      // Instead, attach the SDK's message id to the forwarded event so the main
      // process can correlate this turn, then queue a microtask to read the
      // correct leaf AFTER `appendMessage` has run. The microtask drains before
      // any subsequent SDK event is dispatched, so the follow-up
      // `pi_turn_anchor` event is delivered to the main process in the right
      // order (after this `message_end`, before the next event).
      const sdkMessageId = (msg as { id?: string }).id;
      if (sdkMessageId) {
        forwardedEvent = {
          ...(event as Record<string, unknown>),
          sdkMessageId,
        } as unknown as OutboundAgentEvent;

        const sessionManagerSnapshot = piSession.sessionManager;
        queueMicrotask(() => {
          // Defensive: session may have been disposed between the message_end
          // emit and the microtask drain.
          if (!piSession || piSession.sessionManager !== sessionManagerSnapshot) {
            return;
          }
          const sdkTurnAnchor = sessionManagerSnapshot.getLeafId();
          if (!sdkTurnAnchor) return;
          send({
            type: 'event',
            event: {
              type: 'pi_turn_anchor',
              sdkMessageId,
              sdkTurnAnchor,
            } as unknown as OutboundAgentEvent,
          });
        });
      }

      // Speculative prefetch: if the assistant message contains 2+ prefetchable tool calls,
      // fire all requests to the main process in parallel NOW, before executeToolCalls
      // iterates sequentially. Each proxy tool's execute() will hit the cache.
      const content = (msg as { content?: Array<{ type: string; id?: string; name?: string; arguments?: unknown }> }).content;
      if (Array.isArray(content)) {
        const prefetchableToolCalls = content.filter(
          (c) => c.type === 'toolCall' && c.name && isPrefetchableTool(c.name),
        );
        if (prefetchableToolCalls.length >= 2) {
          debugLog(`Prefetching ${prefetchableToolCalls.length} parallel ${prefetchableToolCalls[0]!.name} calls`);
          for (const tc of prefetchableToolCalls) {
            const requestId = `prefetch-${tc.id}`;
            const promise = new Promise<{ content: string; isError: boolean }>((resolve) => {
              pendingToolExecutions.set(requestId, { resolve });
            });
            send({
              type: 'tool_execute_request',
              requestId,
              toolName: tc.name!,
              args: (tc.arguments ?? {}) as Record<string, unknown>,
            });
            prefetchCache.set(tc.id!, promise);
          }
        }
      }
    }
  }

  // Detect session MCP tool completions + enrich tool starts with canonical metadata
  if (event.type === 'tool_execution_start') {
    const toolName = event.toolName;
    if (toolName.startsWith('session__') || toolName.startsWith('mcp__session__')) {
      const mcpToolName = toolName.replace(/^(mcp__session__|session__)/, '');
      pendingSessionToolCalls.set(event.toolCallId, {
        toolName: mcpToolName,
        arguments: (event.args ?? {}) as Record<string, unknown>,
      });
    }

    const toolMetadata = extractToolExecutionMetadata((event.args ?? {}) as Record<string, unknown>);
    if (toolMetadata) {
      forwardedEvent = {
        ...event,
        toolMetadata,
      };
    }
  }

  if (event.type === 'tool_execution_end') {
    const pending = pendingSessionToolCalls.get(event.toolCallId);
    if (pending) {
      pendingSessionToolCalls.delete(event.toolCallId);
      send({
        type: 'session_tool_completed',
        toolName: pending.toolName,
        args: pending.arguments,
        isError: !!event.isError,
      });
    }
  }

  // Forward all events to main process
  send({ type: 'event', event: forwardedEvent });

  // Republish the meter after anything that changes the conversation. The
  // SDK appends the message AFTER message_end fires, so read on the next
  // microtask to include the message that just settled.
  if (event.type === 'message_end' || event.type === 'tool_execution_end') {
    queueMicrotask(sendContextUsage);
  }
}

// ============================================================
// Command Handlers
// ============================================================

async function handleInit(msg: Extract<InboundMessage, { type: 'init' }>): Promise<void> {
  // Clean up any existing session from a previous init
  if (piSession) {
    if (unsubscribeEvents) {
      unsubscribeEvents();
      unsubscribeEvents = null;
    }
    piSession.dispose();
    piSession = null;
    moduleAuthStorage = null; // Reset so createAuthenticatedRegistry() creates fresh storage
    debugLog('Cleaned up existing session for re-init');
  }

  initConfig = msg;

  // Azure OpenAI requires a tenant-specific endpoint URL.
  // The Pi SDK (via Vercel AI SDK) reads AZURE_OPENAI_BASE_URL from env.
  if (msg.piAuth?.provider === 'azure-openai-responses' && msg.baseUrl) {
    process.env.AZURE_OPENAI_BASE_URL = msg.baseUrl;
    debugLog(`Set AZURE_OPENAI_BASE_URL=${msg.baseUrl}`);
  }

  // Start callback server for call_llm (idempotent — skips if already running)
  await startCallbackServer();

  send({
    type: 'ready',
    sessionId: null,
    callbackPort,
  });
}

/**
 * Wait for any in-flight compaction to finish before sending a prompt or
 * starting another compaction. Prevents a race in the Pi SDK where concurrent
 * _runAutoCompaction calls crash on a shared AbortController
 * (see bitlab-oss#464). Default timeout matches the RPC compact timeout
 * in PiAgent.requestCompact (300 s), since GPT compactions can legitimately
 * take 60–120 s.
 */
async function waitForCompaction(session: { isCompacting: boolean }, timeoutMs = 300_000): Promise<void> {
  if (!session.isCompacting) return;
  debugLog('Waiting for in-flight compaction to finish before prompt...');
  const start = Date.now();
  while (session.isCompacting) {
    if (Date.now() - start > timeoutMs) {
      debugLog(`Compaction wait timed out after ${Math.floor(timeoutMs / 1000)}s, proceeding anyway`);
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (Date.now() - start < timeoutMs) {
    debugLog('Compaction finished, proceeding with prompt');
  }
}

async function handlePrompt(msg: Extract<InboundMessage, { type: 'prompt' }>): Promise<void> {
  currentUserMessage = msg.message;

  try {
    // If proxy tools changed since last session creation, dispose and recreate.
    // This avoids calling _buildRuntime() for dynamic tool updates — instead
    // we create a fresh session via continueRecent() with all tools known upfront.
    if (toolsChanged && piSession) {
      debugLog('Recreating session due to tool changes');
      if (unsubscribeEvents) {
        unsubscribeEvents();
        unsubscribeEvents = null;
      }
      piSession.dispose();
      piSession = null;
    }

    const session = await ensureSession();

    // The prompt reaches Pi through the loader seam the bridge installed, so
    // publishing it here is enough — `refresh` makes Pi reassemble the prompt
    // around it, appending the current skill catalog in the process. The
    // catalog is checked too: a skill edited mid-session changes the prompt
    // even when the base prompt itself did not.
    const promptChanged = Boolean(msg.systemPrompt) && msg.systemPrompt !== activeSystemPrompt;
    const catalogChanged = skillCatalog?.snapshot().revision !== skillBridge?.revision;
    if (promptChanged) activeSystemPrompt = msg.systemPrompt;
    if (promptChanged || catalogChanged) skillBridge?.refresh(session);

    // Wire up event handler
    if (unsubscribeEvents) {
      unsubscribeEvents();
    }
    unsubscribeEvents = session.subscribe(handleSessionEvent);

    // Wait for any in-flight auto-compaction to avoid race (bitlab-oss#464)
    await waitForCompaction(session);

    // Fire prompt — use followUp when session is already streaming so the
    // message is queued instead of throwing "Agent is already processing".
    await session.prompt(msg.message, {
      images: msg.images && msg.images.length > 0 ? msg.images : undefined,
      streamingBehavior: 'followUp',
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);

    // No wrapper-side overflow recovery here. The Pi SDK's _checkCompaction
    // already runs `_runAutoCompaction("overflow", true)` on overflow and
    // calls agent.continue() to retry once. Running our own session.compact()
    // in parallel raced against the SDK and is the documented cause of the
    // AbortController crash in `_runAutoCompaction` (see
    // plans/fix-pi-gpt-compaction.md). PiEventAdapter holds the Bitlab event
    // queue open across the SDK's recovery flow so the recovered turn
    // reaches the UI.

    debugLog(`Prompt failed: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'prompt_error' });
    // Send synthetic agent_end so the main process event queue unblocks.
    // willRetry: false — this is the terminal error path, no retry follows.
    send({ type: 'event', event: { type: 'agent_end', messages: [], willRetry: false } });
  }
}

function handleRegisterTools(msg: Extract<InboundMessage, { type: 'register_tools' }>): void {
  // Merge: replace existing tools by name, add new ones
  const incoming = new Map(msg.tools.map(t => [t.name, t]));
  proxyToolDefs = [
    ...proxyToolDefs.filter(t => !incoming.has(t.name)),
    ...msg.tools,
  ];
  debugLog(`Registered ${msg.tools.length} proxy tools (total: ${proxyToolDefs.length}): ${msg.tools.map(t => t.name).join(', ')}`);

  // If session exists, mark for recreation on next prompt.
  // Don't dispose mid-generation — the flag is checked in handlePrompt().
  if (piSession) {
    toolsChanged = true;
    debugLog('Proxy tools changed — session will be recreated on next prompt');
  }
}

function handleToolExecuteResponse(msg: Extract<InboundMessage, { type: 'tool_execute_response' }>): void {
  const pending = pendingToolExecutions.get(msg.requestId);
  if (pending) {
    pendingToolExecutions.delete(msg.requestId);
    pending.resolve(msg.result);
  } else {
    debugLog(`No pending tool execution for requestId: ${msg.requestId}`);
  }
}

function handlePreToolUseResponse(msg: Extract<InboundMessage, { type: 'pre_tool_use_response' }>): void {
  const pending = pendingPreToolUse.get(msg.requestId);
  if (pending) {
    pendingPreToolUse.delete(msg.requestId);
    pending.resolve({ action: msg.action, input: msg.input, reason: msg.reason });
  } else {
    debugLog(`No pending pre_tool_use for requestId: ${msg.requestId}`);
  }
}

async function handleAbort(): Promise<void> {
  if (piSession) {
    try {
      await piSession.abort();
    } catch (error) {
      debugLog(`Abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Reject all pending pre-tool-use requests
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Aborted' });
  }
  pendingPreToolUse.clear();

  // Clear speculative prefetch cache — in-flight prefetches will resolve but never be consumed
  prefetchCache.clear();
}

async function handleMiniCompletion(msg: Extract<InboundMessage, { type: 'mini_completion' }>): Promise<void> {
  // Call queryLlm directly (not runMiniCompletion) so auth errors propagate
  // as 'error' messages instead of being swallowed and returned as null.
  // runMiniCompletion is kept for the summarize callback where null is acceptable.
  try {
    const result = await queryLlm({ prompt: msg.prompt });
    send({ type: 'mini_completion_result', id: msg.id, text: result.text || null });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleMiniCompletion] Error: ${errorMsg}`);
    send({ type: 'error', message: errorMsg, code: 'mini_completion_error' });
  }
}

// INVARIANT: the full LLMQueryRequest shape must pass through this RPC unchanged.
// Adding a field to LLMQueryRequest? Nothing to do here — we pass `msg.request`
// to queryLlm() verbatim. But verify queryLlm() actually honors the new field;
// request-propagation + request-honoring are independent (see #596).
async function handleLlmQuery(msg: Extract<InboundMessage, { type: 'llm_query' }>): Promise<void> {
  try {
    const result = await queryLlm(msg.request);
    send({ type: 'llm_query_result', id: msg.id, result });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[handleLlmQuery] Error: ${errorMsg}`);
    // Dual-emit: the generic error channel updates session state while the
    // targeted result rejects the pending promise for this specific call.
    send({ type: 'error', message: errorMsg, code: 'llm_query_error' });
    send({ type: 'llm_query_result', id: msg.id, result: null, errorMessage: errorMsg, errorCode: 'llm_query_error' });
  }
}

async function handleEnsureSessionReady(msg: Extract<InboundMessage, { type: 'ensure_session_ready' }>): Promise<void> {
  const session = await ensureSession();
  send({
    type: 'ensure_session_ready_result',
    id: msg.id,
    sessionId: session.sessionId || null,
  });
}

async function handleCompact(msg: Extract<InboundMessage, { type: 'compact' }>): Promise<void> {
  try {
    const session = await ensureSession();
    // Serialize manual /compact behind any in-flight auto-compaction. Public
    // session.compact() calls agent.abort() and uses its own controller; if
    // it runs while _runAutoCompaction is suspended, agent state churns and
    // the SDK's race surface widens. Wait for the auto-compaction to drain
    // before starting a manual one. waitForCompaction has its own timeout
    // fallback so we don't deadlock on a stuck subprocess.
    await waitForCompaction(session);
    const result = await session.compact(msg.customInstructions);
    send({
      type: 'compact_result',
      id: msg.id,
      success: true,
      result: {
        summary: result.summary,
        firstKeptEntryId: result.firstKeptEntryId,
        tokensBefore: result.tokensBefore,
      },
    });
    // Compaction reports no usage of its own, so publish the drop now rather
    // than leaving a stale reading until the next response.
    sendContextUsage();
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[compact] Failed: ${errorMsg}`);
    send({
      type: 'compact_result',
      id: msg.id,
      success: false,
      errorMessage: errorMsg,
    });
  }
}

async function handleSetAutoCompaction(msg: Extract<InboundMessage, { type: 'set_auto_compaction' }>): Promise<void> {
  try {
    const session = await ensureSession();
    session.setAutoCompactionEnabled(msg.enabled);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: true,
      enabled: session.autoCompactionEnabled,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_auto_compaction] Failed: ${errorMsg}`);
    send({
      type: 'set_auto_compaction_result',
      id: msg.id,
      success: false,
      enabled: msg.enabled,
      errorMessage: errorMsg,
    });
  }
}

async function handleUpdateRuntimeConfig(msg: RuntimeConfigUpdateMessage): Promise<void> {
  try {
    if (!initConfig) {
      throw new Error('Runtime config update received before init');
    }

    initConfig = {
      ...initConfig,
      model: msg.model,
      providerType: msg.providerType ?? initConfig.providerType,
      authType: msg.authType ?? initConfig.authType,
      baseUrl: msg.baseUrl,
      customEndpoint: msg.customEndpoint,
      customModels: msg.customModels,
    };

    if (piModelRegistry && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
      const modelEntries: CustomEndpointModelEntry[] = (initConfig.customModels?.length
        ? initConfig.customModels
        : [initConfig.model || 'default']
      ).map(normalizeCustomEndpointModelEntry);

      customEndpointModelIds = new Set();
      customModelOverrides.clear();
      registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), modelEntries);
    }

    if (piSession && piModelRegistry) {
      let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig.piAuth?.provider, shouldPreferCustomEndpoint());
      if (!piModel && initConfig.baseUrl?.trim() && initConfig.customEndpoint) {
        const bareId = stripPiPrefix(msg.model);
        registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl.trim(), [{ id: bareId }]);
        piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
        debugLog(`[runtime_config] Dynamically registered custom endpoint model: ${bareId}`);
      }

      if (!piModel) {
        throw new Error(`Could not resolve model after runtime update: ${msg.model}`);
      }

      await piSession.setModel(piModel);
      setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
      debugLog(`[runtime_config] Updated runtime config and active model: ${piModel.provider}/${piModel.id}`);
    } else {
      debugLog('[runtime_config] Stored update; no active session/model registry yet');
    }

    send({ type: 'update_runtime_config_result', id: msg.id, success: true, updated: true });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[runtime_config] Failed: ${errorMsg}`);
    send({ type: 'update_runtime_config_result', id: msg.id, success: false, updated: false, errorMessage: errorMsg });
  }
}

async function handleSetModel(msg: Extract<InboundMessage, { type: 'set_model' }>): Promise<void> {
  debugLog(`[set_model] Received: ${msg.model}`);
  if (!piSession || !piModelRegistry) {
    debugLog(`[set_model] No active session or model registry, ignoring`);
    return;
  }
  let piModel = resolvePiModel(piModelRegistry, msg.model, initConfig?.piAuth?.provider, shouldPreferCustomEndpoint());

  // For custom endpoints, dynamically register unknown models so mid-session switching works.
  // Uses registerCustomEndpointModels which accumulates into the existing model set
  // (registerProvider replaces, so we track all IDs and re-register the full set).
  if (!piModel && initConfig?.baseUrl?.trim() && initConfig?.customEndpoint) {
    const bareId = stripPiPrefix(msg.model);
    registerCustomEndpointModels(piModelRegistry, initConfig.customEndpoint.api, initConfig.baseUrl!.trim(), [{ id: bareId }]);
    piModel = piModelRegistry.find('custom-endpoint', bareId) ?? undefined;
    debugLog(`[set_model] Dynamically registered custom endpoint model: ${bareId}`);
  }

  if (!piModel) {
    debugLog(`[set_model] Could not resolve model: ${msg.model}`);
    setInterceptorApiHints(undefined);
    return;
  }
  try {
    await piSession.setModel(piModel);
    setInterceptorApiHints(piModel as { api?: string; provider?: string; baseUrl?: string });
    debugLog(`[set_model] Model changed to: ${msg.model} (resolved: ${piModel.provider}/${piModel.id})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_model] Failed to set model: ${errorMsg}`);
  }
}

async function handleSetThinkingLevel(msg: Extract<InboundMessage, { type: 'set_thinking_level' }>): Promise<void> {
  debugLog(`[set_thinking_level] Received: ${msg.level}`);

  if (!piSession) {
    debugLog('[set_thinking_level] No active session, ignoring');
    return;
  }

  const piLevel = THINKING_TO_PI[msg.level as keyof typeof THINKING_TO_PI];
  if (!piLevel) {
    debugLog(`[set_thinking_level] No Pi mapping for level: ${msg.level}`);
    return;
  }

  try {
    piSession.setThinkingLevel(piLevel);
    debugLog(`[set_thinking_level] Thinking level changed to: ${msg.level} (mapped: ${piLevel})`);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[set_thinking_level] Failed: ${errorMsg}`);
  }
}

/**
 * Hot MCP config update. The main process rebuilt the full adapter config
 * snapshot; apply it to the live session.
 *
 * When the session runs with the MCP resource loader we use `session.reload()`
 * (agent-session.js): it emits session_shutdown to the OLD extension runner
 * (the previous adapter instance gracefully stops its servers and publishes a
 * shutdown status snapshot), reloads the resource loader — which re-invokes
 * our inline factories, building a FRESH adapter from `currentMcpConfig` —
 * and rebuilds the tool registry with `includeAllExtensionTools: true` while
 * PRESERVING conversation state (agent, messages, model, active tool names
 * are untouched). Verified limitations, documented for posterity:
 *   - reload() re-reads settings from disk and drops applyOverrides()
 *     values (shellPath) — re-applied right after.
 *   - headless SDK sessions never emit session_start (only the TUI modes
 *     call bindExtensions), so after reload the fresh adapter initializes
 *     via its own load-time path: eager/keep-alive servers reconnect
 *     automatically; lazy servers reconnect on first use.
 *
 * When the session was created WITHOUT the loader (MCP first enabled after
 * session creation) extensions cannot be injected into a live session — mark
 * `toolsChanged` so the session is recreated on the next prompt (same
 * precedent as register_tools).
 */
/**
 * The catalog changed on disk. Drop the cached snapshot and rebuild the
 * session's system prompt, so the model's view moves to the same revision the
 * UI just moved to rather than lagging behind the cache TTL.
 */
function handleSkillsChanged(): void {
  if (!skillCatalog) return;
  skillCatalog.invalidate();
  if (piSession && skillBridge) {
    skillBridge.refresh(piSession);
    debugLog(`[skills_changed] catalog revision now ${skillBridge.revision ?? '(none)'}`);
  }
}

async function handleUpdateMcpConfig(msg: Extract<InboundMessage, { type: 'update_mcp_config' }>): Promise<void> {
  if (!initConfig) {
    debugLog('[update_mcp_config] received before init — ignored');
    return;
  }

  initConfig.mcpConfig = msg.mcpConfig;
  const serverCount = Object.keys(msg.mcpConfig.mcpServers ?? {}).length;
  debugLog(`[update_mcp_config] Received config with ${serverCount} server(s)`);

  if (!piSession) {
    // No session yet — the next ensureSession() builds with this config.
    return;
  }

  if (!activeSessionHasMcp) {
    toolsChanged = true;
    debugLog('[update_mcp_config] Session has no MCP loader — session will be recreated on next prompt');
    return;
  }

  const shellPath = process.env.BITLAB_GIT_BASH_PATH?.trim();
  setCurrentMcpConfig(msg.mcpConfig);
  try {
    await piSession.reload();
    // No explicit bindExtensions needed here: the session-bound uiContext (set
    // at creation) makes AgentSession.reload()'s hasBindings check pass, so
    // reload re-emits `session_start` itself and the adapter re-initializes
    // from the fresh config.
    // reload() re-reads settings from disk, dropping in-memory overrides.
    if (shellPath) piSession.settingsManager.applyOverrides({ shellPath });
    refreshActiveToolWireShapesFromSession();
    sendContextUsage();
    debugLog('[update_mcp_config] Session reloaded with new MCP config');
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    debugLog(`[update_mcp_config] reload failed: ${errorMsg}`);
    send({ type: 'error', message: `MCP config update failed: ${errorMsg}`, code: 'mcp_update_error' });
  }
}

/** Resolve a pending MCP tool-approval handshake from the main process. */
function handleMcpApprovalResponse(msg: Extract<InboundMessage, { type: 'mcp_approval_response' }>): void {
  const resolved = resolveMcpApproval(msg.requestId, msg.decision);
  if (!resolved) {
    debugLog(`No pending MCP approval for requestId: ${msg.requestId}`);
  } else {
    debugLog(`[mcp_approval_response] ${msg.decision} for ${msg.requestId}`);
  }
}

/**
 * Drive an MCP OAuth sign-in: run the adapter's `mcp` proxy tool with
 * `{ connect: server }`. On 401 (and autoAuth + the bound UI bridge), the
 * adapter opens the default browser, completes the flow on its localhost
 * callback, retries the connect, and stores tokens in the shared
 * MCP_OAUTH_DIR. The tool result's details.error carries the failure mode.
 */
async function handleMcpAuth(msg: Extract<InboundMessage, { type: 'mcp_auth' }>): Promise<void> {
  const fail = (message: string, code: string) => send({ type: 'mcp_op_result', id: msg.id, ok: false, message, code });
  try {
    if (!piSession) {
      fail('No session yet — MCP auth requires an initialized session', 'no_session');
      return;
    }
    const proxyTool = (piSession.agent.state.tools ?? []).find(tool => tool.name === 'mcp');
    if (!proxyTool) {
      fail('MCP proxy tool not registered (no MCP servers enabled?)', 'no_proxy_tool');
      return;
    }
    debugLog(`[mcp_auth] connecting to "${msg.serverName}" (auto OAuth on 401)`);
    // `connect` is a top-level proxy parameter, NOT an `action` value: the
    // adapter's dispatch only recognizes 'ui-messages' | 'auth-start' |
    // 'auth-complete' there, and `{ action: 'connect', server }` falls through
    // to its list mode, which never attempts a connection or OAuth.
    const result = await proxyTool.execute(
      `mcp-auth-${msg.id}`,
      { connect: msg.serverName } as never,
      undefined as never,
      undefined as never,
    );
    const { ok, message, code } = interpretMcpAuthResult(result as McpProxyToolResult | undefined);
    debugLog(`[mcp_auth] ${ok ? 'ok' : 'failed'}: ${message.slice(0, 300)}`);
    send({ type: 'mcp_op_result', id: msg.id, ok, message, ...(code ? { code } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[mcp_auth] threw: ${message}`);
    fail(message, 'connect_failed');
  }
}

/**
 * Clear one server's stored OAuth credentials and drop its connection.
 *
 * The adapter's `removeAuth` is not on its public surface; its `/mcp logout`
 * command is, and `AgentSession.prompt()` executes a registered extension
 * command in place (no LLM round-trip, nothing appended to the transcript).
 * The command reports through the UI bridge rather than a return value, so
 * the outcome is verified against the credential store afterwards.
 */
async function handleMcpLogout(msg: Extract<InboundMessage, { type: 'mcp_logout' }>): Promise<void> {
  const fail = (message: string, code: string) => send({ type: 'mcp_op_result', id: msg.id, ok: false, message, code });
  try {
    if (!piSession) {
      fail('No session yet — MCP sign-out requires an initialized session', 'no_session');
      return;
    }
    // Guard the prompt(): without the adapter's command registered, the text
    // would be sent to the model as an ordinary message.
    if (!(piSession.agent.state.tools ?? []).some(tool => tool.name === 'mcp')) {
      fail('MCP proxy tool not registered (no MCP servers enabled?)', 'no_proxy_tool');
      return;
    }
    debugLog(`[mcp_logout] clearing credentials for "${msg.serverName}"`);
    await piSession.prompt(`/mcp logout ${msg.serverName}`);
    const { inspectMcpOAuthTokensForUrl } = await import('pi-mcp-adapter/oauth');
    const status = inspectMcpOAuthTokensForUrl(msg.serverName, msg.url);
    if (status.status === 'present') {
      fail('Credentials are still stored for this server', 'logout_failed');
      return;
    }
    send({ type: 'mcp_op_result', id: msg.id, ok: true, message: `Signed out of "${msg.serverName}"` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    debugLog(`[mcp_logout] threw: ${message}`);
    fail(message, 'logout_failed');
  }
}

function handleShutdown(): void {
  debugLog('Shutdown requested');

  // Fail-close any MCP approval handshake still awaiting a main-process answer.
  clearPendingMcpApprovals();

  // Unsubscribe events
  if (unsubscribeEvents) {
    unsubscribeEvents();
    unsubscribeEvents = null;
  }

  // Dispose session
  if (piSession) {
    piSession.dispose();
    piSession = null;
  }

  // Stop callback server
  stopCallbackServer();

  // Reject pending promises
  for (const [, pending] of pendingPreToolUse) {
    pending.resolve({ action: 'block', reason: 'Server shutting down' });
  }
  pendingPreToolUse.clear();

  for (const [, pending] of pendingToolExecutions) {
    pending.resolve({ content: 'Server shutting down', isError: true });
  }
  pendingToolExecutions.clear();

  process.exit(0);
}

// ============================================================
// Main JSONL Reader Loop
// ============================================================

async function processMessage(msg: InboundMessage): Promise<void> {
  switch (msg.type) {
    case 'init':
      await handleInit(msg);
      break;

    case 'prompt':
      await handlePrompt(msg);
      break;

    case 'register_tools':
      handleRegisterTools(msg);
      break;

    case 'tool_execute_response':
      handleToolExecuteResponse(msg);
      break;

    case 'pre_tool_use_response':
      handlePreToolUseResponse(msg);
      break;

    case 'abort':
      await handleAbort();
      break;

    case 'mini_completion':
      await handleMiniCompletion(msg);
      break;

    case 'llm_query':
      await handleLlmQuery(msg);
      break;

    case 'ensure_session_ready':
      await handleEnsureSessionReady(msg);
      break;

    case 'set_model':
      await handleSetModel(msg);
      break;

    case 'set_thinking_level':
      await handleSetThinkingLevel(msg);
      break;

    case 'compact':
      await handleCompact(msg);
      break;

    case 'set_auto_compaction':
      await handleSetAutoCompaction(msg);
      break;

    case 'update_runtime_config':
      await handleUpdateRuntimeConfig(msg);
      break;

    case 'steer':
      if (piSession) {
        debugLog(`Steering with: "${msg.message.slice(0, 100)}"`);
        await piSession.steer(msg.message);
      } else {
        debugLog('Steer ignored — no active session');
      }
      break;

    case 'token_update':
      if (moduleAuthStorage) {
        const { provider, credential } = msg.piAuth;
        // See ambient comment at the initial `authStorage.set` call — same shape reason.
        moduleAuthStorage.set(provider, credential as unknown as AuthCredential);
        if (initConfig) {
          initConfig.piAuth = msg.piAuth;
        }
        debugLog(`Updated ${credential.type} credential for provider: ${provider}`);
      } else {
        debugLog('token_update received but no authStorage initialized');
      }
      break;

    case 'search_config_update':
      if (initConfig) {
        initConfig.searchConfig = msg.searchConfig;
        initConfig.searchApiKeys = msg.searchApiKeys;
        debugLog(`Updated search config: provider=${msg.searchConfig.provider}`);
      } else {
        debugLog('search_config_update received before init');
      }
      break;

    case 'update_mcp_config':
      await handleUpdateMcpConfig(msg);
      break;

    case 'skills_changed':
      handleSkillsChanged();
      break;

    case 'mcp_approval_response':
      handleMcpApprovalResponse(msg);
      break;

    case 'mcp_auth':
      await handleMcpAuth(msg);
      break;

    case 'mcp_logout':
      await handleMcpLogout(msg);
      break;

    case 'shutdown':
      handleShutdown();
      break;

    default:
      debugLog(`Unknown message type: ${(msg as any).type}`);
  }
}

// ============================================================
// One-shot MCP OAuth credential lookup (no session)
// ============================================================

/** CLI flags for the credential modes. Must match server-core's mcp-oauth. */
const MCP_OAUTH_TOKEN_FLAG = '--mcp-oauth-token';
const MCP_OAUTH_STATUS_FLAG = '--mcp-oauth-status';

/**
 * `--mcp-oauth-token <server> <url>` prints `{ accessToken }` and exits.
 *
 * MCP OAuth tokens live in the OS credential store behind pi-mcp-adapter,
 * which runs here and never in the main process. Settings' connection test
 * needs the same bearer the adapter would send, so it spawns this instead of
 * a whole session: no Pi session, no MCP connection, no browser — just a
 * credential read (the adapter refreshes an expired token on its own).
 */
async function runMcpOAuthTokenMode(serverName: string, url: string): Promise<void> {
  let accessToken: string | undefined;
  try {
    // Literal specifier (unlike the adapter root import in mcp/mcp-extension.ts):
    // the `oauth` subpath typechecks cleanly and bundles, so the lookup keeps
    // working where node_modules is not shipped. Imported lazily so a normal
    // session never loads the credential store.
    const { getMcpOAuthTokensForUrl } = await import('pi-mcp-adapter/oauth');
    accessToken = (await getMcpOAuthTokensForUrl(serverName, url))?.accessToken;
  } catch (error) {
    debugLog(`[mcp_oauth_token] lookup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The token itself is the only thing on stdout, and only ever the token —
  // never the error, which can quote the endpoint and its query.
  process.stdout.write(`${JSON.stringify(accessToken ? { accessToken } : {})}\n`);
  process.exit(0);
}

/**
 * `--mcp-oauth-status <server> <url>` prints whether credentials are stored
 * and when they expire — never the token itself. Reads only: no refresh, no
 * network, so Settings can render "signed in" without touching the server.
 */
async function runMcpOAuthStatusMode(serverName: string, url: string): Promise<void> {
  let payload: Record<string, unknown> = { status: 'absent' };
  try {
    const { inspectMcpOAuthTokensForUrl } = await import('pi-mcp-adapter/oauth');
    const status = inspectMcpOAuthTokensForUrl(serverName, url);
    payload = status.status === 'present'
      ? { status: 'present', ...(status.tokens.expiresAt ? { expiresAt: status.tokens.expiresAt } : {}) }
      : { status: status.status };
  } catch (error) {
    debugLog(`[mcp_oauth_status] lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    payload = { status: 'unavailable' };
  }
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(0);
}

function main(): void {
  const [flag, serverName, url] = process.argv.slice(2);
  if (flag === MCP_OAUTH_TOKEN_FLAG) {
    void runMcpOAuthTokenMode(serverName ?? '', url ?? '');
    return;
  }
  if (flag === MCP_OAUTH_STATUS_FLAG) {
    void runMcpOAuthStatusMode(serverName ?? '', url ?? '');
    return;
  }

  debugLog('Pi agent server starting');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as InboundMessage;
      processMessage(msg).catch((error) => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLog(`Error processing message: ${errorMsg}`);
        send({ type: 'error', message: errorMsg });
      });
    } catch (parseError) {
      debugLog(`Failed to parse JSONL: ${parseError}`);
    }
  });

  rl.on('close', () => {
    debugLog('stdin closed, shutting down');
    handleShutdown();
  });

  // Handle unexpected errors — process state is unreliable after these,
  // so we attempt to report and then exit immediately.
  // send() is wrapped in try/catch because stdout itself may be broken
  // (e.g. EFAULT from a closed pipe), and we must not let the error
  // report trigger another uncaughtException (which would loop).
  process.on('uncaughtException', (error) => {
    debugLog(`Uncaught exception: ${error.message}`);
    try {
      send({ type: 'error', message: `Uncaught exception: ${error.message}`, code: 'uncaught' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    debugLog(`Unhandled rejection: ${msg}`);
    try {
      send({ type: 'error', message: `Unhandled rejection: ${msg}`, code: 'unhandled_rejection' });
    } catch {
      // stdout may be broken — swallow to avoid re-triggering
    }
    process.exit(1);
  });
}

main();
