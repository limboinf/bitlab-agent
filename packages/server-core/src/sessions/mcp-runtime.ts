/**
 * MCP runtime state bridging.
 *
 * Two concerns live here so they can be unit-tested without a live agent:
 *   1. The per-session status-snapshot cache that `mcp:list` serves from
 *      (latest snapshot per live session, dropped when the session ends).
 *   2. Fail-closed auto-deny timers for forwarded approval requests.
 *
 * On (2): pi-mcp-adapter's tool-approval broker is fail-closed for requests
 * that are never *claimed* (decision "abstain" → `approval_required_headless`
 * → tool call rejected) and on abort (signal aborted → "deny"). But once a
 * broker handler IS claimed — which is exactly what the subprocess bridge
 * does when it forwards the request here — the adapter awaits that handler
 * indefinitely (`abortable(Promise.resolve().then(handler), signal)` in
 * node_modules/pi-mcp-adapter/tool-approval.ts); only an aborted turn unblocks
 * it. A renderer that never answers would therefore hang the tool call
 * forever, so every forwarded request gets a 120s auto-deny timer here.
 */

import type {
  McpApprovalRequestDto,
  McpServerRuntimeStatus,
  McpServerStatusDto,
  McpSessionStatusDto,
  McpStatusSnapshotDto,
} from '@bitlab/shared/config'

/**
 * Session-event payloads forwarded on `sessions.EVENT` for MCP.
 *
 * These are NOT in shared's `SessionEvent` union yet — the union is a closed
 * type in @bitlab/shared/protocol/dto.ts and this package may not extend it.
 * The event sink's payload parameter is untyped (`...args: any[]`), so the
 * wire envelope is declared here instead; the renderer contract matches
 * `permission_request` (DTO wrapped in `request`, `sessionId` both outside
 * and inside) and `context_usage` (payload object under a named key).
 */
export interface McpStatusSessionEvent {
  type: 'mcp_status'
  sessionId: string
  snapshot: McpStatusSnapshotDto
}

/**
 * Pretty-print MCP tool args for the permission prompt's command preview.
 * Omitted entirely when the call takes no arguments.
 */
export function formatMcpApprovalCommand(args: Record<string, unknown> | undefined): string | undefined {
  if (!args || typeof args !== 'object' || Object.keys(args).length === 0) return undefined
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

/** How long a forwarded approval may sit unanswered before we deny it. */
export const MCP_APPROVAL_AUTO_DENY_MS = 120_000

/**
 * Statuses worth remembering after the reporting session is gone.
 *
 * `not-connected` is the resting state of a lazy server that nobody has used
 * yet, and `disabled` is config, not runtime — remembering either would let a
 * freshly started session erase what a previous one actually discovered.
 */
const REMEMBERED_STATUSES = new Set<McpServerRuntimeStatus>([
  'connected',
  'cached',
  'needs-auth',
  'failed',
])

const timerKey = (sessionId: string, requestId: string): string => `${sessionId}\u0000${requestId}`

/** Identity an "always allow" decision is remembered under: server + tool. */
const toolKey = (serverName: string, originalToolName: string): string => `${serverName}\u0000${originalToolName}`

export class McpRuntimeState {
  private statusBySession = new Map<string, McpStatusSnapshotDto>()
  private lastKnownByName = new Map<string, McpServerStatusDto>()
  private approvalTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private pendingTools = new Map<string, string>()
  private approvedBySession = new Map<string, Set<string>>()

  /** Cache the latest snapshot for a session (served by `mcp:list`). */
  recordStatus(sessionId: string, snapshot: McpStatusSnapshotDto): void {
    this.statusBySession.set(sessionId, snapshot)
    for (const server of snapshot.servers) {
      if (REMEMBERED_STATUSES.has(server.status)) {
        this.lastKnownByName.set(server.name, server)
      }
    }
  }

  /**
   * What each server was last seen doing, kept beyond the reporting session's
   * lifetime so Settings can show a real state (and tool count) with no chat
   * session open — the alternative is claiming every server is "not connected".
   */
  getLastKnownStatuses(): McpServerStatusDto[] {
    return [...this.lastKnownByName.values()]
  }

  /** Drop a remembered status whose server was reconfigured or removed. */
  forgetLastKnown(serverName: string): void {
    this.lastKnownByName.delete(serverName)
  }

  /** Whether a snapshot was already recorded for this session. */
  hasStatus(sessionId: string): boolean {
    return this.statusBySession.has(sessionId)
  }

  /** Latest snapshot per live session, tagged with the reporting session. */
  getStatusSnapshots(): McpSessionStatusDto[] {
    return [...this.statusBySession.entries()].map(([sessionId, snapshot]) => ({ sessionId, snapshot }))
  }

  /**
   * Start the fail-closed timer for a forwarded approval request. `deny` is
   * invoked once if the request is not resolved before the deadline.
   * (`timeoutMs` exists for tests; production always uses the 120s default.)
   *
   * `tool` is the identity an "always allow" answer will be remembered under —
   * the renderer answers by requestId only, so the pairing is kept here.
   */
  scheduleApprovalAutoDeny(
    sessionId: string,
    requestId: string,
    deny: () => void,
    timeoutMs: number = MCP_APPROVAL_AUTO_DENY_MS,
    tool?: { serverName: string; originalToolName: string },
  ): void {
    this.clearApprovalTimer(sessionId, requestId)
    const timer = setTimeout(() => {
      this.approvalTimers.delete(timerKey(sessionId, requestId))
      this.pendingTools.delete(timerKey(sessionId, requestId))
      deny()
    }, timeoutMs)
    // Do not hold the process open just for a pending denial.
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref()
    this.approvalTimers.set(timerKey(sessionId, requestId), timer)
    if (tool) this.pendingTools.set(timerKey(sessionId, requestId), toolKey(tool.serverName, tool.originalToolName))
  }

  /** Stop the timer for a request that was answered in time. */
  clearApprovalTimer(sessionId: string, requestId: string): void {
    const key = timerKey(sessionId, requestId)
    const timer = this.approvalTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.approvalTimers.delete(key)
    }
    this.pendingTools.delete(key)
  }

  hasPendingApproval(sessionId: string, requestId: string): boolean {
    return this.approvalTimers.has(timerKey(sessionId, requestId))
  }

  /**
   * Remember an "always allow" answer for the tool behind a pending request.
   *
   * The adapter has its own per-session cache, but that cache lives in the
   * extension state, which is rebuilt whenever the agent session is recreated
   * (a tool-surface change, an MCP config push) — so a decision kept only
   * there is forgotten mid-conversation and the user is asked again. This
   * memory outlives those rebuilds and is dropped with the session.
   */
  rememberApproval(sessionId: string, requestId: string): void {
    const tool = this.pendingTools.get(timerKey(sessionId, requestId))
    if (!tool) return
    const approved = this.approvedBySession.get(sessionId) ?? new Set<string>()
    approved.add(tool)
    this.approvedBySession.set(sessionId, approved)
  }

  /** Whether this session already answered "always allow" for this tool. */
  isApproved(sessionId: string, serverName: string, originalToolName: string): boolean {
    return this.approvedBySession.get(sessionId)?.has(toolKey(serverName, originalToolName)) === true
  }

  /** Drop all cached status, pending timers and approvals for a session. */
  clearSession(sessionId: string): void {
    this.statusBySession.delete(sessionId)
    this.approvedBySession.delete(sessionId)
    const prefix = `${sessionId}\u0000`
    for (const key of this.approvalTimers.keys()) {
      if (key.startsWith(prefix)) {
        clearTimeout(this.approvalTimers.get(key))
        this.approvalTimers.delete(key)
        this.pendingTools.delete(key)
      }
    }
  }

  clearAll(): void {
    this.statusBySession.clear()
    this.lastKnownByName.clear()
    for (const timer of this.approvalTimers.values()) clearTimeout(timer)
    this.approvalTimers.clear()
    this.pendingTools.clear()
    this.approvedBySession.clear()
  }
}
