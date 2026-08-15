/**
 * MCP (Model Context Protocol) server configuration.
 *
 * Bitlab's config.json is the single source of truth for MCP servers.
 * The persisted schema here is mapped onto pi-mcp-adapter's in-memory
 * `McpConfig` snapshot (via `buildAdapterMcpConfig`) and injected into the
 * pi-agent-server subprocess, where the adapter runs as an inline extension.
 *
 * Types in this module intentionally mirror the adapter's shapes structurally
 * (ServerEntry / McpStatusSnapshot / approval decisions) so this package needs
 * no dependency on pi-mcp-adapter; pi-agent-server asserts compatibility at
 * the type level where the real adapter types are available.
 */

// ============================================================
// Persisted schema (config.json)
// ============================================================

export type McpTransportConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
      /**
       * Force OAuth for this endpoint. Omitted → auto-detection (OAuth when no
       * static Authorization header is configured); 'none' → never OAuth.
       */
      auth?: 'oauth' | 'none';
    };

/** Where a server entry came from. */
export type McpServerSource = 'user' | 'project' | 'import';

export interface BitlabMcpServer {
  /** Stable id (slug) — survives renames, used for RPC CRUD. */
  id: string;
  /** Server key in the adapter's `mcpServers` record. Must be unique. */
  name: string;
  /** Disabled servers are omitted from the adapter config entirely. */
  enabled: boolean;
  /**
   * Trusted servers skip the per-call approval prompt (Claude Desktop's
   * "Always Allow" equivalent). Untrusted servers require approval for
   * every tool call when `mcpSettings.requireApproval` is on.
   */
  trusted: boolean;
  transport: McpTransportConfig;
  source: McpServerSource;
  /** File a project/import server was discovered in (display + re-discovery). */
  originPath?: string;
  /** Glob filters on original or prefixed tool names (adapter semantics). */
  includeTools?: string[];
  excludeTools?: string[];
  /** Register tools individually instead of via the `mcp` proxy tool. */
  directTools?: boolean;
  /** Connection lifecycle override. Default: mcpSettings.lifecycle. */
  lifecycle?: McpLifecycle;
  /**
   * Tool-level approval gate (adapter semantics: globs over original or
   * prefixed tool names). Only meaningful on a trusted server — it narrows
   * "never ask" down to "never ask, except for these". An untrusted server
   * already asks for everything.
   */
  approveTools?: string[];
  /**
   * Per-call request timeout in milliseconds, overriding the global default.
   * This is what keeps one wedged server from stalling a turn indefinitely.
   */
  requestTimeoutMs?: number;
}

export type McpLifecycle = 'lazy' | 'lazy-keep-alive' | 'eager' | 'keep-alive';

export interface BitlabMcpSettings {
  /** Ask before every MCP tool call on untrusted servers (default: true). */
  requireApproval: boolean;
  /** Register per-server tools directly (default: true) alongside the `mcp` proxy tool. */
  directTools: boolean;
  /** Default connection lifecycle (default: 'lazy' — connect on first use). */
  lifecycle: McpLifecycle;
  /**
   * Default per-call request timeout in milliseconds (0 = the SDK default).
   * Servers can override it; without one, a hung server hangs the turn.
   */
  requestTimeoutMs: number;
}

/** 60s matches the tool timeout other agent hosts default to. */
export const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 60_000;

/** Bounds for a configured timeout: 1s is impatient, 10min is a hang. */
export const MIN_MCP_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_MCP_REQUEST_TIMEOUT_MS = 600_000;

export const DEFAULT_MCP_SETTINGS: BitlabMcpSettings = {
  requireApproval: true,
  directTools: true,
  lifecycle: 'lazy',
  requestTimeoutMs: DEFAULT_MCP_REQUEST_TIMEOUT_MS,
};

// ============================================================
// Runtime status DTO (from pi-agent-server → main → renderer)
// ============================================================

export type McpServerRuntimeStatus =
  | 'connected'
  | 'cached'
  | 'failed'
  | 'needs-auth'
  | 'not-connected'
  | 'disabled';

/** Mirrors pi-mcp-adapter's McpServerStatusSnapshot. */
export interface McpServerStatusDto {
  name: string;
  status: McpServerRuntimeStatus;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
}

/** Mirrors pi-mcp-adapter's McpStatusSnapshot. */
export interface McpStatusSnapshotDto {
  version: number;
  servers: McpServerStatusDto[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

/**
 * A snapshot together with the session that reported it.
 *
 * The reporting session has to travel with the snapshot: Settings keeps one
 * entry per session and replaces it when that session reports again, which is
 * the only way a server going away can degrade the display instead of leaving
 * a stale "connected" behind.
 */
export interface McpSessionStatusDto {
  sessionId: string;
  snapshot: McpStatusSnapshotDto;
}

/**
 * Outcome of an MCP operation driven through an agent (sign-in, sign-out).
 *
 * `code` is the adapter's own tag (`auth_required`, `connect_failed`,
 * `not_found`, `server_disabled`, …) or one the host adds (`no_session`,
 * `no_proxy_tool`, `logout_failed`, `cancelled`, `no_live_session`). The UI
 * renders the code; `message` is agent-facing prose kept only as a fallback.
 */
export interface McpOperationResult {
  ok: boolean;
  message: string;
  code?: string;
}

// ============================================================
// Tool approval DTO (chat approval flow)
// ============================================================

export type McpApprovalDecision = 'allow_once' | 'allow_for_session' | 'deny';

export interface McpApprovalRequestDto {
  requestId: string;
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
}

// ============================================================
// Adapter config payload (main → subprocess `init`/`update_mcp_config`)
// ============================================================

/**
 * Structural subset of pi-mcp-adapter's ServerEntry that Bitlab persists and
 * forwards. Field names must stay identical to the adapter's schema.
 */
export interface AdapterServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** OAuth/bearer mode (adapter semantics: 'oauth' forces the browser flow). */
  auth?: 'oauth' | 'bearer' | false;
  lifecycle?: McpLifecycle;
  directTools?: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  /** Approval gate for this server's tool calls (adapter semantics). */
  approveTools?: boolean | string[];
  /** Per-call request timeout in ms (adapter semantics; > 0 to apply). */
  requestTimeoutMs?: number;
}

/** Structural subset of pi-mcp-adapter's McpConfig. */
export interface AdapterMcpConfig {
  mcpServers: Record<string, AdapterServerEntry>;
  settings?: {
    toolPrefix?: 'server' | 'none' | 'short' | 'mcp';
    directTools?: boolean;
    scriptMode?: boolean;
    hostConfigDiscovery?: 'off' | 'prompt' | 'on';
    notifyOnStartupConnect?: boolean;
    showStatusIcon?: boolean;
    /** Default per-call request timeout in ms (adapter semantics; > 0 to apply). */
    requestTimeoutMs?: number;
    /**
     * One-shot OAuth on 401: opens the default browser and completes via the
     * localhost callback (adapter's attemptDirectAutoAuth). Requires the
     * subprocess UI bridge so `state.ui` exists.
     */
    autoAuth?: boolean;
  };
}

/**
 * Build the adapter's isolated in-memory config from Bitlab's persisted state.
 * Enabled servers only; tool prefix is pinned to 'mcp' so tool names come out
 * as `mcp__<server>_<tool>`, which the UI's tool-name parsing already handles.
 */
export function buildAdapterMcpConfig(
  servers: BitlabMcpServer[],
  settings: BitlabMcpSettings,
): AdapterMcpConfig {
  const mcpServers: Record<string, AdapterServerEntry> = {};
  for (const server of servers) {
    if (!server.enabled) continue;
    const entry: AdapterServerEntry = { ...server.transport.type === 'stdio' ? {
      command: server.transport.command,
      ...(server.transport.args ? { args: server.transport.args } : {}),
      ...(server.transport.env ? { env: server.transport.env } : {}),
    } : {
      url: server.transport.url,
      ...(server.transport.headers ? { headers: server.transport.headers } : {}),
      ...(server.transport.auth === 'oauth' ? { auth: 'oauth' as const } : {}),
      ...(server.transport.auth === 'none' ? { auth: false as const } : {}),
    } };
    entry.lifecycle = server.lifecycle ?? settings.lifecycle;
    entry.directTools = server.directTools ?? settings.directTools;
    if (server.includeTools?.length) entry.includeTools = server.includeTools;
    if (server.excludeTools?.length) entry.excludeTools = server.excludeTools;
    const requestTimeoutMs = server.requestTimeoutMs ?? settings.requestTimeoutMs;
    if (requestTimeoutMs > 0) entry.requestTimeoutMs = requestTimeoutMs;
    // Approval: untrusted servers prompt for everything when the global gate
    // is on; a trusted server prompts only for the tools it names (the
    // "read freely, ask before writes" middle ground), and otherwise never.
    // (When the gate is off nobody prompts — the app's PreToolUse permission
    // pipeline is the outer safety layer.)
    entry.approveTools = settings.requireApproval
      ? (server.trusted ? (server.approveTools?.length ? server.approveTools : false) : true)
      : false;
    mcpServers[server.name] = entry;
  }

  return {
    mcpServers,
    settings: {
      toolPrefix: 'mcp',
      directTools: settings.directTools,
      // The adapter's scripting tool is hidden for now — Bitlab's tool surface
      // stays limited to what its UI can render and gate.
      scriptMode: false,
      // Bitlab does its own explicit host-config import UX; ambient discovery off.
      hostConfigDiscovery: 'off',
      // Headless subprocess — TUI notifications are noise on stdout parsing.
      notifyOnStartupConnect: false,
      showStatusIcon: false,
      ...(settings.requestTimeoutMs > 0 ? { requestTimeoutMs: settings.requestTimeoutMs } : {}),
      // One-shot OAuth on 401 (browser + localhost callback) — the explicit
      // Sign-in entry in Settings → MCP drives the same path via connect.
      autoAuth: true,
    },
  };
}

// ============================================================
// Validation / normalization
// ============================================================

const SERVER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const LIFECYCLES: readonly McpLifecycle[] = ['lazy', 'lazy-keep-alive', 'eager', 'keep-alive'];

export function isValidMcpServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name) && name.length <= 64;
}

/**
 * Clamp a stored timeout into the supported range. 0 is kept as "no timeout,
 * use the SDK default"; anything else outside the range is a typo, not a
 * choice, so it falls back to the default rather than to an extreme.
 */
export function normalizeMcpRequestTimeout(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value === 0) return 0;
  if (value < MIN_MCP_REQUEST_TIMEOUT_MS || value > MAX_MCP_REQUEST_TIMEOUT_MS) return fallback;
  return Math.round(value);
}

export function normalizeMcpSettings(stored: Partial<BitlabMcpSettings> | undefined): BitlabMcpSettings {
  return {
    requireApproval: stored?.requireApproval ?? DEFAULT_MCP_SETTINGS.requireApproval,
    directTools: stored?.directTools ?? DEFAULT_MCP_SETTINGS.directTools,
    lifecycle: stored?.lifecycle && (LIFECYCLES as readonly string[]).includes(stored.lifecycle)
      ? stored.lifecycle
      : DEFAULT_MCP_SETTINGS.lifecycle,
    requestTimeoutMs: normalizeMcpRequestTimeout(stored?.requestTimeoutMs, DEFAULT_MCP_SETTINGS.requestTimeoutMs),
  };
}

/** Drop malformed entries; keeps the persisted array load-bearing-safe. */
export function normalizeMcpServers(stored: BitlabMcpServer[] | undefined): BitlabMcpServer[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const result: BitlabMcpServer[] = [];
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue;
    const name = typeof raw.name === 'string' ? raw.name : '';
    if (!isValidMcpServerName(name) || seen.has(name)) continue;
    const transport = normalizeTransport(raw.transport);
    if (!transport) continue;
    seen.add(name);
    result.push({
      id: typeof raw.id === 'string' && raw.id ? raw.id : mcpServerId(name),
      name,
      enabled: raw.enabled !== false,
      trusted: raw.trusted === true,
      transport,
      source: raw.source === 'project' || raw.source === 'import' ? raw.source : 'user',
      ...(raw.originPath ? { originPath: raw.originPath } : {}),
      ...(Array.isArray(raw.includeTools) && raw.includeTools.length ? { includeTools: raw.includeTools.filter(t => typeof t === 'string') } : {}),
      ...(Array.isArray(raw.excludeTools) && raw.excludeTools.length ? { excludeTools: raw.excludeTools.filter(t => typeof t === 'string') } : {}),
      ...(typeof raw.directTools === 'boolean' ? { directTools: raw.directTools } : {}),
      ...(raw.lifecycle && (LIFECYCLES as readonly string[]).includes(raw.lifecycle) ? { lifecycle: raw.lifecycle } : {}),
      ...(Array.isArray(raw.approveTools) && raw.approveTools.length ? { approveTools: raw.approveTools.filter(t => typeof t === 'string') } : {}),
      ...(typeof raw.requestTimeoutMs === 'number' && normalizeMcpRequestTimeout(raw.requestTimeoutMs, -1) >= 0
        ? { requestTimeoutMs: normalizeMcpRequestTimeout(raw.requestTimeoutMs, 0) }
        : {}),
    });
  }
  return result;
}

function normalizeTransport(raw: unknown): McpTransportConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Partial<McpTransportConfig> & { type?: string };
  if (t.type === 'stdio' && typeof t.command === 'string' && t.command.trim()) {
    return {
      type: 'stdio',
      command: t.command,
      ...(Array.isArray(t.args) ? { args: t.args.map(String) } : {}),
      ...(t.env && typeof t.env === 'object' ? { env: Object.fromEntries(Object.entries(t.env).map(([k, v]) => [k, String(v)])) } : {}),
    };
  }
  if (t.type === 'http' && typeof t.url === 'string' && /^https?:\/\//.test(t.url)) {
    const auth = t.auth === 'oauth' || t.auth === 'none' ? t.auth : undefined;
    return {
      type: 'http',
      url: t.url,
      ...(auth ? { auth } : {}),
      ...(t.headers && typeof t.headers === 'object' ? { headers: Object.fromEntries(Object.entries(t.headers).map(([k, v]) => [k, String(v)])) } : {}),
    };
  }
  return null;
}

export function mcpServerId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

// ============================================================
// Discovery: project .mcp.json + host app configs
// ============================================================

export interface DiscoveredMcpServer {
  name: string;
  transport: McpTransportConfig;
  originPath: string;
}

export interface DiscoveredHostConfig {
  /** Host app the config file belongs to (display label). */
  app: 'cursor' | 'claude-code' | 'claude-desktop';
  path: string;
  servers: DiscoveredMcpServer[];
}

interface RawMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Legacy field in some hosts' configs. */
  type?: string;
}

function parseRawServerEntry(name: string, raw: RawMcpServerEntry, originPath: string): DiscoveredMcpServer | null {
  if (!isValidMcpServerName(name)) return null;
  if (typeof raw.url === 'string' && /^https?:\/\//.test(raw.url)) {
    return { name, transport: { type: 'http', url: raw.url, ...(raw.headers ? { headers: raw.headers } : {}) }, originPath };
  }
  if (typeof raw.command === 'string' && raw.command.trim()) {
    return {
      name,
      transport: { type: 'stdio', command: raw.command, ...(raw.args ? { args: raw.args } : {}), ...(raw.env ? { env: raw.env } : {}) },
      originPath,
    };
  }
  return null;
}

function parseMcpServersBlock(block: unknown, originPath: string): DiscoveredMcpServer[] {
  const servers = (block as { mcpServers?: Record<string, RawMcpServerEntry> } | null)?.mcpServers;
  if (!servers || typeof servers !== 'object') return [];
  const result: DiscoveredMcpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    if (!raw || typeof raw !== 'object') continue;
    const parsed = parseRawServerEntry(name, raw as RawMcpServerEntry, originPath);
    if (parsed) result.push(parsed);
  }
  return result;
}

/**
 * Read `<workspaceRoot>/.mcp.json` (Cursor / Claude Code project format).
 * Entries are surfaced in Settings → MCP for explicit approval; nothing is
 * auto-enabled.
 */
export function discoverProjectMcpServers(workspaceRoot: string, readJson: (path: string) => unknown): DiscoveredMcpServer[] {
  const path = joinPath(workspaceRoot, '.mcp.json');
  let parsed: unknown;
  try {
    parsed = readJson(path);
  } catch {
    return [];
  }
  return parseMcpServersBlock(parsed, path);
}

/** Well-known host config locations (macOS-first; guarded by existence checks). */
/**
 * Browser-safe path join. This module is imported by the renderer (types +
 * small pure helpers), so it must not pull in node:path — vite externalizes
 * that and breaks the renderer build. Node's fs APIs accept forward slashes
 * on every platform, including Windows, so joining with '/' is safe for the
 * discovery read paths built here.
 */
function joinPath(base: string, ...rest: string[]): string {
  return [base.replace(/[\\/]+$/, ''), ...rest].join('/');
}

export function hostMcpConfigPaths(homedir: string): Array<{ app: DiscoveredHostConfig['app']; path: string; top?: string }> {
  return [
    { app: 'cursor', path: joinPath(homedir, '.cursor', 'mcp.json') },
    // Claude Code keeps project-scoped servers inside ~/.claude.json under the
    // top-level `mcpServers` key (global scope).
    { app: 'claude-code', path: joinPath(homedir, '.claude.json') },
    { app: 'claude-desktop', path: joinPath(homedir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json') },
  ];
}

/**
 * Scan other apps' MCP configs for the Settings → MCP import list.
 * Never mutates the source files.
 */
export function discoverHostMcpConfigs(
  homedir: string,
  exists: (path: string) => boolean,
  readJson: (path: string) => unknown,
): DiscoveredHostConfig[] {
  const result: DiscoveredHostConfig[] = [];
  for (const { app, path } of hostMcpConfigPaths(homedir)) {
    if (!exists(path)) continue;
    let servers: DiscoveredMcpServer[];
    try {
      servers = parseMcpServersBlock(readJson(path), path);
    } catch {
      continue;
    }
    if (servers.length) result.push({ app, path, servers });
  }
  return result;
}

