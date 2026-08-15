/**
 * Pure derivation helpers for MCP state.
 *
 * The status-snapshot join, overview stats, search filtering and outcome
 * wording live here — plain data in, plain data out, no React or RPC imports —
 * so they stay unit-testable without mounting renderer components, and so both
 * the settings page and the composer's `/mcp` picker read the same state the
 * same way.
 */

import type {
  BitlabMcpServer,
  McpServerRuntimeStatus,
  McpServerStatusDto,
  McpSessionStatusDto,
} from '@bitlab/shared/config'

/**
 * What the page shows for one server.
 *
 * `unknown` is the honest answer when nothing has ever reported on a server:
 * with lazy lifecycle no session touches a server until a tool needs it, so
 * claiming `not-connected` (a checked, negative result) would be a guess.
 */
export type McpDisplayStatus = McpServerRuntimeStatus | 'unknown'

export interface McpServerDisplay {
  status: McpDisplayStatus
  /** The status came from memory of an earlier session, not a live one. */
  cached: boolean
  /** Tools discovered by whichever report the status came from. */
  toolCount?: number
}

/** Display statuses that count as "running" in the overview. */
const RUNNING_STATUSES = new Set<McpDisplayStatus>(['connected', 'cached'])

/** stdio: `command arg…` · http: host of the url. */
export function transportSummary(server: BitlabMcpServer): string {
  const t = server.transport
  if (t.type === 'stdio') {
    return [t.command, ...(t.args ?? [])].filter(Boolean).join(' ')
  }
  try {
    return new URL(t.url).host
  } catch {
    return t.url
  }
}

/**
 * How informative a runtime status is, best first. Used to reconcile a server
 * that several sessions report differently.
 */
const STATUS_RANK: Record<McpServerRuntimeStatus, number> = {
  connected: 0,
  cached: 1,
  'needs-auth': 2,
  failed: 3,
  'not-connected': 4,
  disabled: 5,
}

/**
 * Join live session snapshots and remembered statuses into one per-server view.
 *
 * Live snapshots carry no timestamp and arrive one per session in no
 * meaningful order, so "the last one" is not "the newest one": a lazily
 * connecting session reports `not-connected` for a server another session has
 * already connected. The best-ranked report wins instead.
 *
 * `lastKnown` is what the backend remembers past a session's lifetime, and it
 * is all Settings has after a sign-in (whose session is transient and gone by
 * the time the page re-lists). It joins the same ranking, tagged `cached` so
 * the UI can say the state is remembered rather than observed.
 */
export function mergeServerDisplays(
  sessionStatuses: McpSessionStatusDto[],
  lastKnown: McpServerStatusDto[] = [],
): Map<string, McpServerDisplay> {
  const map = new Map<string, McpServerDisplay>()
  const consider = (serverStatus: McpServerStatusDto, cached: boolean) => {
    const current = map.get(serverStatus.name)
    if (current && STATUS_RANK[serverStatus.status] >= STATUS_RANK[current.status as McpServerRuntimeStatus]) return
    map.set(serverStatus.name, {
      status: serverStatus.status,
      cached,
      ...(serverStatus.toolCount !== undefined ? { toolCount: serverStatus.toolCount } : {}),
    })
  }
  for (const { snapshot } of sessionStatuses) {
    for (const serverStatus of snapshot.servers) consider(serverStatus, false)
  }
  for (const serverStatus of lastKnown) consider(serverStatus, true)
  return map
}

/** Enabled servers whose latest status is `connected` or `cached`. */
export function countRunningServers(
  servers: BitlabMcpServer[],
  displayByName: Map<string, McpServerDisplay>,
): number {
  return servers.filter((server) => {
    if (!server.enabled) return false
    const status = displayByName.get(server.name)?.status
    return status !== undefined && RUNNING_STATUSES.has(status)
  }).length
}

/** Sum of `toolCount` over enabled servers; missing values count as zero. */
export function sumAvailableTools(
  servers: BitlabMcpServer[],
  displayByName: Map<string, McpServerDisplay>,
): number {
  return servers.reduce(
    (total, server) =>
      server.enabled ? total + (displayByName.get(server.name)?.toolCount ?? 0) : total,
    0,
  )
}

/**
 * Name-sorted server list filtered by a case-insensitive query over name,
 * transport summary and localized source label.
 */
export function filterServers(
  servers: BitlabMcpServer[],
  query: string,
  sourceLabel: (source: BitlabMcpServer['source']) => string,
): BitlabMcpServer[] {
  const normalized = query.trim().toLocaleLowerCase()
  return [...servers]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((server) => {
      if (!normalized) return true
      return [server.name, transportSummary(server), sourceLabel(server.source)]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized)
    })
}

// ============================================
// Operation outcomes (sign-in, sign-out, reconnect)
// ============================================

/**
 * Outcome codes the UI has its own wording for. Anything else falls back to
 * the adapter's message, which is written for the agent that called it.
 */
const KNOWN_OPERATION_CODES = new Set([
  'auth_required',
  'aborted',
  'cancelled',
  'connect_failed',
  'logout_failed',
  'no_live_session',
  'no_proxy_tool',
  'no_session',
  'not_connected',
  'not_found',
  'not_http',
  'oauth_not_supported',
  'server_disabled',
])

/** i18n key for an outcome code, or null when there is no wording for it. */
export function mcpOperationErrorKey(code: string | undefined): string | null {
  return code && KNOWN_OPERATION_CODES.has(code) ? `settings.mcp.opError.${code}` : null
}

/**
 * Make an adapter message fit for a settings panel.
 *
 * The adapter talks to the model: its failures end in instructions like
 * `Use mcp({ connect: "notion" })` or `/mcp reconnect notion`, neither of
 * which exists in this UI. Those sentences are dropped, and URLs lose their
 * query (a redirect URL can carry a code or a token).
 */
export function humanizeMcpMessage(message: string): string {
  return message
    .split(/(?<=[.!?])\s+/)
    // The slash-command patterns need a leading boundary, or the `/mcp` in a
    // URL host (`https://mcp.example.com`) would swallow the whole sentence.
    .filter((sentence) => !/mcp\(|(?:^|\s)\/(?:mcp|reload)\b/.test(sentence))
    .join(' ')
    .replace(/https?:\/\/[^\s"']+/g, (match) => {
      try {
        const url = new URL(match)
        return `${url.origin}${url.pathname}`
      } catch {
        return match
      }
    })
    .trim()
}
