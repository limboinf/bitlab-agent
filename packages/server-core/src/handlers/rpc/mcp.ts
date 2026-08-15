/**
 * MCP (Model Context Protocol) RPC handlers — Settings → MCP.
 *
 * config.json is the single source of truth (via @bitlab/shared/config
 * storage); after every write the new adapter config is hot-pushed to live
 * agent subprocesses through SessionManager.refreshMcpConfig(), and a
 * `mcp:changed` broadcast tells the UI to re-list.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import {
  discoverHostMcpConfigs,
  discoverProjectMcpServers,
  getMcpServers,
  getMcpSettings,
  getWorkspaceByNameOrId,
  isValidMcpServerName,
  mcpServerId,
  normalizeMcpServers,
  setMcpServers,
  setMcpSettings,
  type BitlabMcpServer,
  type BitlabMcpSettings,
  type DiscoveredHostConfig,
  type DiscoveredMcpServer,
  type McpTransportConfig,
} from '@bitlab/shared/config'
import type { RpcServer } from '@bitlab/server-core/transport'
import { readMcpCredentialStatus, readMcpOAuthAccessToken } from '../../services/mcp-oauth'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.mcp.LIST,
  RPC_CHANNELS.mcp.SAVE,
  RPC_CHANNELS.mcp.DELETE,
  RPC_CHANNELS.mcp.SAVE_SETTINGS,
  RPC_CHANNELS.mcp.TEST,
  RPC_CHANNELS.mcp.AUTH,
  RPC_CHANNELS.mcp.AUTH_CANCEL,
  RPC_CHANNELS.mcp.SIGN_OUT,
  RPC_CHANNELS.mcp.RECONNECT,
  RPC_CHANNELS.mcp.CREDENTIALS,
  RPC_CHANNELS.mcp.DISCOVER,
  RPC_CHANNELS.mcp.IMPORT,
] as const

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ============================================================
// TEST — one-shot connection probe (no agent subprocess)
// ============================================================

export interface McpTestToolInfo {
  name: string
  description?: string
}

/**
 * Outcome of a probe. `needs-auth` is deliberately not lumped in with
 * `failed`: an OAuth server that has never been signed into is not broken, and
 * the UI must offer sign-in instead of a red error (this mirrors Claude Code's
 * "Needs authentication" vs "Failed to connect" split).
 */
export type McpTestStatus = 'ok' | 'needs-auth' | 'failed'

export interface McpTestResult {
  ok: boolean
  status: McpTestStatus
  toolCount?: number
  tools?: McpTestToolInfo[]
  truncated?: boolean
  error?: string
}

const TEST_CONNECT_TIMEOUT_MS = 10_000
const TEST_MAX_TOOLS = 50

/** HTTP statuses that mean "wrong transport", not "server is down". */
const SSE_FALLBACK_STATUSES = new Set([400, 404, 405, 406, 415])

/** Extract the HTTP status a transport error carries, when it carries one. */
function httpStatusOf(error: unknown): number | undefined {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'number') return code
  const match = /\b(4\d\d|5\d\d)\b/.exec(error instanceof Error ? error.message : '')
  return match ? Number(match[1]) : undefined
}

function isUnauthorized(error: unknown): boolean {
  const status = httpStatusOf(error)
  if (status === 401 || status === 403 || status === 407) return true
  return /unauthorized|forbidden|invalid[_ -]token|oauth/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

/**
 * Strip anything credential-shaped out of a probe error before it reaches a
 * renderer, a toast or a log: transport errors happily quote the request URL
 * (which can carry a token in its query) and any header we sent.
 */
export function redactProbeError(
  message: string,
  transport: McpTransportConfig,
  accessToken?: string,
): string {
  let safe = message
  const secrets = transport.type === 'http'
    ? [...Object.values(transport.headers ?? {}), ...(accessToken ? [accessToken] : [])]
    : Object.values(transport.env ?? {})
  for (const secret of secrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join('***')
  }
  // Keep origin + path, drop query and fragment (both can carry credentials).
  return safe.replace(/https?:\/\/[^\s"']+/g, match => {
    try {
      const url = new URL(match)
      return `${url.origin}${url.pathname}`
    } catch {
      return match
    }
  })
}

/**
 * Connect to an MCP server directly with the SDK, list its tools, close.
 * Deliberately independent of the agent subprocess so Settings can probe a
 * server before it is ever saved or enabled.
 *
 * HTTP endpoints are tried as streamable HTTP first and then as legacy SSE,
 * because a server that only speaks SSE answers the streamable handshake with
 * a 4xx that would otherwise be reported as a dead server.
 *
 * `accessToken` is the bearer a signed-in OAuth server expects. Without it an
 * authenticated server answers the probe with 401 and the user is told the
 * sign-in they just completed did not work — see readMcpOAuthAccessToken for
 * where it comes from.
 */
export async function probeMcpServer(
  transport: McpTransportConfig,
  accessToken?: string,
): Promise<McpTestResult> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')

  // A configured Authorization header wins: it is what the runtime would send.
  const headers = transport.type === 'http'
    ? {
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(transport.headers ?? {}),
      }
    : {}
  const requestInit = Object.keys(headers).length ? { requestInit: { headers } } : {}

  let url: URL | null = null
  if (transport.type === 'http') {
    try {
      url = new URL(transport.url)
    } catch {
      return { ok: false, status: 'failed', error: `Invalid URL: ${transport.url}` }
    }
  }

  /** A probe attempt keeps the HTTP status internally to pick the fallback. */
  type ProbeAttempt = McpTestResult & { httpStatus?: number }

  const attempt = async (kind: 'stdio' | 'http' | 'sse'): Promise<ProbeAttempt> => {
    let transportImpl
    if (kind === 'stdio' && transport.type === 'stdio') {
      // Merge the default environment so `node`/`npx`/binaries on PATH resolve;
      // the user-provided env wins on conflicts.
      transportImpl = new StdioClientTransport({
        command: transport.command,
        ...(transport.args?.length ? { args: transport.args } : {}),
        env: { ...getDefaultEnvironment(), ...(transport.env ?? {}) },
        stderr: 'pipe',
      })
    } else if (kind === 'http') {
      transportImpl = new StreamableHTTPClientTransport(url!, requestInit)
    } else {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js')
      transportImpl = new SSEClientTransport(url!, requestInit)
    }

    const client = new Client({ name: 'bitlab-mcp-test', version: '0.0.0' })
    try {
      await client.connect(transportImpl, { timeout: TEST_CONNECT_TIMEOUT_MS })
      const { tools } = await client.listTools(undefined, { timeout: TEST_CONNECT_TIMEOUT_MS })
      return {
        ok: true,
        status: 'ok',
        toolCount: tools.length,
        tools: tools.slice(0, TEST_MAX_TOOLS).map(tool => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
        })),
        truncated: tools.length > TEST_MAX_TOOLS,
      }
    } catch (error) {
      return {
        ok: false,
        status: isUnauthorized(error) ? 'needs-auth' : 'failed',
        error: redactProbeError(describeError(error), transport, accessToken),
        ...(httpStatusOf(error) !== undefined ? { httpStatus: httpStatusOf(error) } : {}),
      }
    } finally {
      await client.close().catch(() => {})
    }
  }

  /** Drop the internal HTTP status before the result crosses the RPC boundary. */
  const publish = ({ httpStatus: _httpStatus, ...result }: ProbeAttempt): McpTestResult => result

  if (transport.type === 'stdio') return publish(await attempt('stdio'))

  const streamable = await attempt('http')
  if (streamable.ok || streamable.status === 'needs-auth') return publish(streamable)
  if (streamable.httpStatus !== undefined && !SSE_FALLBACK_STATUSES.has(streamable.httpStatus)) {
    return publish(streamable)
  }
  const sse = await attempt('sse')
  // The streamable error is the more meaningful one to report: SSE was only a
  // compatibility guess, so its failure says nothing new about the server.
  return publish(sse.ok || sse.status === 'needs-auth' ? sse : streamable)
}

// ============================================================
// Handlers
// ============================================================

export function registerMcpHandlers(server: RpcServer, deps: HandlerDeps): void {
  const broadcastChanged = () => {
    server.push(RPC_CHANNELS.mcp.CHANGED, { to: 'all' })
  }

  // servers + global settings + live statuses + what each server was last
  // seen doing (the latter is all Settings has when no session is open)
  server.handle(RPC_CHANNELS.mcp.LIST, async () => ({
    servers: getMcpServers(),
    settings: getMcpSettings(),
    statuses: deps.sessionManager.getMcpStatusSnapshots(),
    lastKnown: deps.sessionManager.getLastKnownMcpStatuses(),
  }))

  // add-or-update a single server
  server.handle(RPC_CHANNELS.mcp.SAVE, async (_ctx, input: Partial<BitlabMcpServer>) => {
    try {
      const name = typeof input?.name === 'string' ? input.name : ''
      if (!isValidMcpServerName(name)) {
        return { success: false, error: `Invalid server name "${name}": use letters, digits, "_" or "-", starting with a letter or digit (max 64 chars).` }
      }
      // normalizeMcpServers doubles as the transport-shape validator.
      const [candidate] = normalizeMcpServers([{ ...(input as BitlabMcpServer), name }])
      if (!candidate) {
        return { success: false, error: 'Invalid MCP server: transport must be stdio { command, args?, env? } or http { url, headers? }.' }
      }

      const servers = getMcpServers()
      // An explicit id means add-or-update; no id means add — and since ids
      // are derived from names, an add colliding on name must be rejected
      // rather than silently rewriting the existing server.
      const explicitId = typeof input.id === 'string' && input.id ? input.id : null
      const duplicate = servers.find(server => server.name === candidate.name)
      if (duplicate && duplicate.id !== explicitId) {
        return { success: false, error: `A server named "${candidate.name}" already exists.` }
      }
      const id = explicitId ?? candidate.id

      const saved: BitlabMcpServer = { ...candidate, id }
      setMcpServers([...servers.filter(server => server.id !== id && server.name !== saved.name), saved])
      // A reachable-at-the-time status says nothing about a server that now
      // points somewhere else, so retire it — display falls back to "unknown"
      // until something connects again. Flag-only edits keep their status.
      const previous = servers.find(server => server.id === id)
      if (!previous || JSON.stringify(previous.transport) !== JSON.stringify(saved.transport)) {
        deps.sessionManager.forgetMcpStatus(saved.name)
      }
      deps.platform.logger.info(`[MCP] saved server "${saved.name}" (enabled=${saved.enabled}, trusted=${saved.trusted}, transport=${saved.transport.type})`)
      broadcastChanged()
      deps.sessionManager.refreshMcpConfig()
      return { success: true, server: saved }
    } catch (error) {
      return { success: false, error: describeError(error) }
    }
  })

  // delete by stable id
  server.handle(RPC_CHANNELS.mcp.DELETE, async (_ctx, id: string) => {
    try {
      const servers = getMcpServers()
      const removed = servers.find(server => server.id === id)
      if (!removed) {
        return { success: false, error: 'Server not found' }
      }
      setMcpServers(servers.filter(server => server.id !== id))
      deps.sessionManager.forgetMcpStatus(removed.name)
      broadcastChanged()
      deps.sessionManager.refreshMcpConfig()
      return { success: true }
    } catch (error) {
      return { success: false, error: describeError(error) }
    }
  })

  // global settings (approval gate, direct tools, default lifecycle)
  server.handle(RPC_CHANNELS.mcp.SAVE_SETTINGS, async (_ctx, settings: BitlabMcpSettings) => {
    try {
      setMcpSettings(settings)
      broadcastChanged()
      deps.sessionManager.refreshMcpConfig()
      return { success: true, settings: getMcpSettings() }
    } catch (error) {
      return { success: false, error: describeError(error) }
    }
  })

  // one-shot connection probe without the agent subprocess
  server.handle(RPC_CHANNELS.mcp.TEST, async (_ctx, input: { transport?: McpTransportConfig } & Partial<BitlabMcpServer>) => {
    const transport = input?.transport
    const [normalized] = transport ? normalizeMcpServers([{ name: 'probe', transport } as BitlabMcpServer]) : []
    if (!normalized) {
      return { ok: false, status: 'failed', error: 'Invalid MCP server: transport must be stdio { command, args?, env? } or http { url, headers? }.' } satisfies McpTestResult
    }
    const accessToken = await resolveProbeAccessToken(deps, input, normalized.transport)
    const result = await probeMcpServer(normalized.transport, accessToken)
    deps.platform.logger.info(`[MCP] test ${normalized.transport.type} "${normalized.transport.type === 'stdio' ? normalized.transport.command : normalized.transport.url}" → ${result.ok ? `ok (${result.toolCount} tools)` : `${result.status}: ${result.error}`}`)
    return result
  })

  // project .mcp.json + other apps' configs for the import list
  server.handle(RPC_CHANNELS.mcp.DISCOVER, async (ctx, workspaceRoot?: string): Promise<{ project: DiscoveredMcpServer[]; hosts: DiscoveredHostConfig[] }> => {
    const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf-8'))
    const root = resolveWorkspaceRoot(deps, ctx.workspaceId, workspaceRoot)
    return {
      project: root ? discoverProjectMcpServers(root, readJson) : [],
      hosts: discoverHostMcpConfigs(homedir(), existsSync, readJson),
    }
  })

  // bulk-add discovered servers (source 'import'; name collisions skipped)
  server.handle(RPC_CHANNELS.mcp.IMPORT, async (_ctx, input: { servers: DiscoveredMcpServer[] }) => {
    try {
      const incoming = Array.isArray(input?.servers) ? input.servers : []
      const existing = getMcpServers()
      const existingNames = new Set(existing.map(server => server.name))
      const added: BitlabMcpServer[] = []
      const skipped: string[] = []
      const seen = new Set<string>()

      for (const discovered of incoming) {
        const [candidate] = normalizeMcpServers([{
          id: mcpServerId(discovered.name),
          name: discovered.name,
          enabled: true,
          trusted: false,
          transport: discovered.transport,
          source: 'import',
          ...(discovered.originPath ? { originPath: discovered.originPath } : {}),
        } as BitlabMcpServer])
        if (!candidate) continue
        if (existingNames.has(candidate.name) || seen.has(candidate.name)) {
          skipped.push(candidate.name)
          continue
        }
        seen.add(candidate.name)
        existingNames.add(candidate.name)
        added.push(candidate)
      }

      if (added.length) {
        setMcpServers([...existing, ...added])
        broadcastChanged()
        deps.sessionManager.refreshMcpConfig()
      }
      return { success: true, added: added.length, skipped }
    } catch (error) {
      return { success: false, added: 0, skipped: [], error: describeError(error) }
    }
  })

  /** `{ id }` / `{ serverId }` — both spellings are accepted by the UI layer. */
  const serverIdOf = (input: { id?: string; serverId?: string } | undefined): string | null => {
    const serverId = input?.id ?? input?.serverId
    return typeof serverId === 'string' && serverId ? serverId : null
  }

  // browser OAuth sign-in for an HTTP server (runs in the MCP utility session)
  server.handle(RPC_CHANNELS.mcp.AUTH, async (_ctx, input: { id?: string; serverId?: string }) => {
    const serverId = serverIdOf(input)
    if (!serverId) return { ok: false, message: 'Missing server id', code: 'not_found' }
    deps.platform.logger.info(`[MCP] sign-in requested for server id ${serverId}`)
    return deps.sessionManager.authenticateMcpServer(serverId)
  })

  // abandon an in-flight sign-in (the browser flow lives in that session)
  server.handle(RPC_CHANNELS.mcp.AUTH_CANCEL, async () => deps.sessionManager.cancelMcpAuth())

  // clear a server's stored OAuth credentials
  server.handle(RPC_CHANNELS.mcp.SIGN_OUT, async (_ctx, input: { id?: string; serverId?: string }) => {
    const serverId = serverIdOf(input)
    if (!serverId) return { ok: false, message: 'Missing server id', code: 'not_found' }
    deps.platform.logger.info(`[MCP] sign-out requested for server id ${serverId}`)
    return deps.sessionManager.signOutMcpServer(serverId)
  })

  // reconnect a server in every live chat session
  server.handle(RPC_CHANNELS.mcp.RECONNECT, async (_ctx, input: { id?: string; serverId?: string }) => {
    const serverId = serverIdOf(input)
    if (!serverId) return { ok: false, message: 'Missing server id', code: 'not_found' }
    return deps.sessionManager.reconnectMcpServer(serverId)
  })

  // stored-credential status for one HTTP server (no connection is made)
  server.handle(RPC_CHANNELS.mcp.CREDENTIALS, async (_ctx, input: { id?: string; serverId?: string }) => {
    const serverId = serverIdOf(input)
    const target = serverId ? getMcpServers().find(item => item.id === serverId) : undefined
    if (!target || target.transport.type !== 'http') return { status: 'absent' }
    return readMcpCredentialStatus(deps.platform, target.name, target.transport.url)
  })
}

/**
 * The stored OAuth bearer to probe a saved HTTP server with, if any.
 *
 * Only saved servers qualify: credentials are keyed by server name, so a
 * server being typed into the add dialog has none yet. A static Authorization
 * header or `auth: 'none'` means the endpoint was never meant to use OAuth.
 */
async function resolveProbeAccessToken(
  deps: HandlerDeps,
  input: Partial<BitlabMcpServer>,
  transport: McpTransportConfig,
): Promise<string | undefined> {
  if (transport.type !== 'http' || transport.auth === 'none') return undefined
  if (Object.keys(transport.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) return undefined
  const name = typeof input?.name === 'string' ? input.name : ''
  if (!name || !getMcpServers().some(server => server.name === name)) return undefined
  return readMcpOAuthAccessToken(deps.platform, name, transport.url)
}

/**
 * Resolve the root for project-level `.mcp.json` discovery: the explicit
 * argument wins, then the requesting client's workspace folder, then the
 * first workspace that has a bound folder.
 */
function resolveWorkspaceRoot(
  deps: HandlerDeps,
  workspaceId: string | null,
  explicit?: string,
): string | null {
  if (explicit && typeof explicit === 'string') return explicit
  if (workspaceId) {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (workspace?.folderPath) return workspace.folderPath
  }
  for (const workspace of deps.sessionManager.getWorkspaces()) {
    if (workspace.folderPath) return workspace.folderPath
  }
  return null
}
