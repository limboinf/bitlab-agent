import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import type { McpApprovalRequestDto, McpServerStatusDto, McpStatusSnapshotDto } from '@bitlab/shared/config'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import { McpRuntimeState, MCP_APPROVAL_AUTO_DENY_MS } from './mcp-runtime.ts'

function snapshot(version: number): McpStatusSnapshotDto {
  return { version, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 }
}

function serverStatus(
  name: string,
  status: McpServerStatusDto['status'],
  toolCount = 0,
): McpServerStatusDto {
  return { name, status, toolCount, resourceCount: 0, disabled: status === 'disabled' }
}

function snapshotOf(version: number, servers: McpServerStatusDto[]): McpStatusSnapshotDto {
  return {
    version,
    servers,
    totalTools: servers.reduce((sum, server) => sum + server.toolCount, 0),
    totalResources: 0,
    connectedCount: servers.filter(server => server.status === 'connected').length,
    disabledCount: servers.filter(server => server.status === 'disabled').length,
  }
}

function approval(overrides: Partial<McpApprovalRequestDto> = {}): McpApprovalRequestDto {
  return {
    requestId: 'req-1',
    serverName: 'srv',
    originalToolName: 'echo',
    prefixedToolName: 'mcp__srv_echo',
    args: { message: 'hi' },
    ...overrides,
  }
}

describe('McpRuntimeState', () => {
  it('keeps only the latest snapshot per session', () => {
    const state = new McpRuntimeState()
    state.recordStatus('a', snapshot(1))
    state.recordStatus('a', snapshot(2))
    state.recordStatus('b', snapshot(3))
    expect(state.getStatusSnapshots().map(s => s.snapshot.version).sort()).toEqual([2, 3])
  })

  it('auto-denies an unanswered approval after the timeout', async () => {
    const state = new McpRuntimeState()
    const denied: string[] = []
    state.scheduleApprovalAutoDeny('s', 'req-1', () => denied.push('req-1'), 5)
    expect(state.hasPendingApproval('s', 'req-1')).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(denied).toEqual(['req-1'])
    expect(state.hasPendingApproval('s', 'req-1')).toBe(false)
  })

  it('clears the timer when the approval is resolved in time', async () => {
    const state = new McpRuntimeState()
    const denied: string[] = []
    state.scheduleApprovalAutoDeny('s', 'req-1', () => denied.push('deny'), 5)
    state.clearApprovalTimer('s', 'req-1')
    expect(state.hasPendingApproval('s', 'req-1')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(denied).toEqual([])
  })

  it('clearSession drops cached status and pending timers', async () => {
    const state = new McpRuntimeState()
    const denied: string[] = []
    state.recordStatus('s', snapshot(1))
    state.scheduleApprovalAutoDeny('s', 'req-1', () => denied.push('deny'), 5)
    state.scheduleApprovalAutoDeny('s', 'req-2', () => denied.push('deny'), 5)
    state.clearSession('s')
    expect(state.getStatusSnapshots()).toEqual([])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(denied).toEqual([])
  })

  it('remembers the last informative status per server across sessions', () => {
    const state = new McpRuntimeState()
    state.recordStatus('a', snapshotOf(1, [serverStatus('notion', 'connected', 12)]))
    state.clearSession('a')
    // A lazy session parks every server at not-connected; that must not erase
    // what an earlier session actually discovered.
    state.recordStatus('b', snapshotOf(2, [
      serverStatus('notion', 'not-connected'),
      serverStatus('linear', 'needs-auth'),
      serverStatus('legacy', 'disabled'),
    ]))
    expect(state.getLastKnownStatuses()).toEqual([
      serverStatus('notion', 'connected', 12),
      serverStatus('linear', 'needs-auth'),
    ])
  })

  it('forgetLastKnown drops a reconfigured server, clearAll drops everything', () => {
    const state = new McpRuntimeState()
    state.recordStatus('a', snapshotOf(1, [
      serverStatus('notion', 'connected', 12),
      serverStatus('linear', 'failed'),
    ]))
    state.forgetLastKnown('notion')
    expect(state.getLastKnownStatuses().map(server => server.name)).toEqual(['linear'])
    state.clearAll()
    expect(state.getLastKnownStatuses()).toEqual([])
  })

  it('uses the 120s fail-closed deadline by default', () => {
    expect(MCP_APPROVAL_AUTO_DENY_MS).toBe(120_000)
  })

  it('remembers an always-allow answer per session and tool', () => {
    const state = new McpRuntimeState()
    state.scheduleApprovalAutoDeny('a', 'req-1', () => {}, 5_000, { serverName: 'srv', originalToolName: 'echo' })
    state.rememberApproval('a', 'req-1')

    expect(state.isApproved('a', 'srv', 'echo')).toBe(true)
    // Scoped: another tool, another server and another session all still ask.
    expect(state.isApproved('a', 'srv', 'write')).toBe(false)
    expect(state.isApproved('a', 'other', 'echo')).toBe(false)
    expect(state.isApproved('b', 'srv', 'echo')).toBe(false)

    state.clearSession('a')
    expect(state.isApproved('a', 'srv', 'echo')).toBe(false)
  })

  it('ignores an always-allow answer for a request it never saw', () => {
    const state = new McpRuntimeState()
    state.rememberApproval('a', 'unknown-req')
    expect(state.isApproved('a', 'srv', 'echo')).toBe(false)
  })
})

// ============================================================
// SessionManager wiring
// ============================================================

interface RecordingAgent {
  onMcpStatus: ((snapshot: McpStatusSnapshotDto) => void) | null
  onMcpApprovalRequest: ((request: McpApprovalRequestDto) => void) | null
  refreshMcpConfigCalls: number
  resolved: Array<{ requestId: string; decision: string }>
  responded: Array<{ requestId: string; allowed: boolean; alwaysAllow: boolean }>
  destroy(): void
  refreshMcpConfig(): void
  resolveMcpApproval(requestId: string, decision: string): void
  respondToPermission(requestId: string, allowed: boolean, alwaysAllow: boolean): void
  requestMcpAuth(serverName: string): Promise<{ ok: boolean; message: string; code?: string }>
  connects: string[]
}

function createRecordingAgent(): RecordingAgent {
  return {
    onMcpStatus: null,
    onMcpApprovalRequest: null,
    refreshMcpConfigCalls: 0,
    resolved: [],
    responded: [],
    destroy() {},
    connects: [],
    refreshMcpConfig() { this.refreshMcpConfigCalls++ },
    requestMcpAuth(serverName: string) {
      this.connects.push(serverName)
      return Promise.resolve({ ok: true, message: 'connected' })
    },
    resolveMcpApproval(requestId, decision) { this.resolved.push({ requestId, decision }) },
    respondToPermission(requestId, allowed, alwaysAllow) { this.responded.push({ requestId, allowed, alwaysAllow }) },
  }
}

interface CapturedEvent {
  channel: string
  target: unknown
  payload: any
}

function injectSession(sm: SessionManager, id: string, agent: unknown) {
  const workspace = {
    id: 'ws_test', name: 'Test', slug: 'test', kind: 'folder' as const,
    folderPath: '/tmp/ws', dataRoot: '/tmp/ws-data', createdAt: Date.now(),
  }
  const managed = createManagedSession({ id, name: id }, workspace as never, { messagesLoaded: true })
  ;(managed as unknown as { agent: unknown }).agent = agent
  const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
  sessions.set(id, managed)
  return managed
}

describe('SessionManager MCP wiring', () => {
  it('caches statuses and forwards them as mcp_status session events', () => {
    const sm = new SessionManager()
    const events: CapturedEvent[] = []
    sm.setEventSink((channel, target, payload) => events.push({ channel, target, payload }))
    const managed = injectSession(sm, 'sess-1', createRecordingAgent())

    ;(sm as unknown as { handleMcpStatus: (m: unknown, s: McpStatusSnapshotDto) => void })
      .handleMcpStatus(managed, snapshot(7))

    expect(sm.getMcpStatusSnapshots().map(s => s.snapshot.version)).toEqual([7])
    expect(events).toEqual([
      {
        channel: RPC_CHANNELS.sessions.EVENT,
        target: { to: 'workspace', workspaceId: 'ws_test' },
        payload: { type: 'mcp_status', sessionId: 'sess-1', snapshot: snapshot(7) },
      },
      // Settings → MCP is workspace-agnostic, so the snapshot is also
      // broadcast to every client on the dedicated MCP channel.
      {
        channel: RPC_CHANNELS.mcp.STATUS,
        target: { to: 'all' },
        payload: { sessionId: 'sess-1', snapshot: snapshot(7) },
      },
    ])
  })

  it('forwards approval requests through the permission_request pipeline and auto-denies unanswered ones', async () => {
    const sm = new SessionManager()
    const events: CapturedEvent[] = []
    sm.setEventSink((channel, target, payload) => events.push({ channel, target, payload }))
    const agent = createRecordingAgent()
    const managed = injectSession(sm, 'sess-1', agent)
    // Speed the fail-closed timer up for the test via the runtime seam.
    const runtime = (sm as unknown as { mcpRuntime: McpRuntimeState }).mcpRuntime
    const originalSchedule = runtime.scheduleApprovalAutoDeny.bind(runtime)
    ;(runtime as unknown as { scheduleApprovalAutoDeny: typeof originalSchedule })
      .scheduleApprovalAutoDeny = (sessionId, requestId, deny) => originalSchedule(sessionId, requestId, deny, 5)

    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval())

    // MCP approvals must ride the STANDARD permission_request wire shape
    // (DTO nested under `request`): the renderer queues them in the same
    // pendingPermissions map and renders them in the inline permission
    // prompt (PermissionRequest.tsx). A bespoke event type would need a
    // second, parallel approval UI — exactly what this avoids.
    expect(events).toEqual([{
      channel: RPC_CHANNELS.sessions.EVENT,
      target: { to: 'workspace', workspaceId: 'ws_test' },
      payload: {
        type: 'permission_request',
        sessionId: 'sess-1',
        request: {
          sessionId: 'sess-1',
          requestId: 'req-1',
          toolName: 'mcp__srv_echo',
          command: '{\n  "message": "hi"\n}',
          description: 'MCP tool call on server "srv"',
          type: 'mcp',
        },
      },
    }])

    // Never answered → the agent receives a fail-closed deny.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(agent.resolved).toEqual([{ requestId: 'req-1', decision: 'deny' }])
  })

  it('omits the command preview for MCP calls without arguments', () => {
    const sm = new SessionManager()
    const events: CapturedEvent[] = []
    sm.setEventSink((channel, target, payload) => events.push({ channel, target, payload }))
    const managed = injectSession(sm, 'sess-1', createRecordingAgent())

    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval({ requestId: 'req-2', args: {} }))

    expect(events[0].payload.request.command).toBeUndefined()
    expect(sm.resolveMcpApproval('sess-1', 'req-2', 'deny')).toBe(true)
  })

  it('respondToPermission routes MCP-pending requestIds to the adapter decision set', async () => {
    const sm = new SessionManager()
    const agent = createRecordingAgent()
    const managed = injectSession(sm, 'sess-1', agent)
    const runtime = (sm as unknown as { mcpRuntime: McpRuntimeState }).mcpRuntime
    const originalSchedule = runtime.scheduleApprovalAutoDeny.bind(runtime)
    ;(runtime as unknown as { scheduleApprovalAutoDeny: typeof originalSchedule })
      .scheduleApprovalAutoDeny = (sessionId, requestId, deny) => originalSchedule(sessionId, requestId, deny, 5)

    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval({ requestId: 'mcp-req' }))

    // The inline prompt's buttons map onto the adapter decisions:
    // Allow → allow_once, Always Allow → allow_for_session, Deny → deny.
    expect(sm.respondToPermission('sess-1', 'mcp-req', true, false)).toBe(true)
    expect(agent.resolved).toEqual([{ requestId: 'mcp-req', decision: 'allow_once' }])
    // A coexisting non-MCP permission keeps routing to the agent pipeline.
    expect(sm.respondToPermission('sess-1', 'pi-perm-9', true, true)).toBe(true)
    expect(agent.responded).toEqual([{ requestId: 'pi-perm-9', allowed: true, alwaysAllow: true }])

    // allow_for_session and deny map the same way for fresh requests. A
    // repeat resolution of an already-answered request is a no-op here; the
    // fall-through hits the agent pipeline, which ignores unknown ids.
    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval({ requestId: 'mcp-req-2' }))
    expect(sm.respondToPermission('sess-1', 'mcp-req-2', true, true)).toBe(true)
    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval({ requestId: 'mcp-req-3' }))
    expect(sm.respondToPermission('sess-1', 'mcp-req-3', false, false)).toBe(true)
    expect(agent.resolved.slice(1)).toEqual([
      { requestId: 'mcp-req-2', decision: 'allow_for_session' },
      { requestId: 'mcp-req-3', decision: 'deny' },
    ])

    // The cancelled timers must not fire later.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(agent.resolved).toHaveLength(3)
  })

  it('respondToPermission keeps routing non-MCP requestIds to the agent', () => {
    const sm = new SessionManager()
    const agent = createRecordingAgent()
    injectSession(sm, 'sess-1', agent)

    expect(sm.respondToPermission('sess-1', 'pi-perm-1', true, true)).toBe(true)
    expect(agent.responded).toEqual([{ requestId: 'pi-perm-1', allowed: true, alwaysAllow: true }])

    expect(sm.respondToPermission('missing', 'pi-perm-1', true, false)).toBe(false)
  })

  it('resolveMcpApproval routes the decision and cancels the auto-deny timer', async () => {
    const sm = new SessionManager()
    const agent = createRecordingAgent()
    const managed = injectSession(sm, 'sess-1', agent)
    const runtime = (sm as unknown as { mcpRuntime: McpRuntimeState }).mcpRuntime
    const originalSchedule = runtime.scheduleApprovalAutoDeny.bind(runtime)
    ;(runtime as unknown as { scheduleApprovalAutoDeny: typeof originalSchedule })
      .scheduleApprovalAutoDeny = (sessionId, requestId, deny) => originalSchedule(sessionId, requestId, deny, 5)

    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval({ requestId: 'req-9' }))

    expect(sm.resolveMcpApproval('sess-1', 'req-9', 'allow_for_session')).toBe(true)
    expect(agent.resolved).toEqual([{ requestId: 'req-9', decision: 'allow_for_session' }])
    expect(runtime.hasPendingApproval('sess-1', 'req-9')).toBe(false)

    // The cancelled timer must not fire later.
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(agent.resolved).toHaveLength(1)

    // Unknown session / MCP-incapable agent → false, fail closed upstream.
    expect(sm.resolveMcpApproval('missing', 'req-9', 'deny')).toBe(false)
    injectSession(sm, 'no-mcp', { isProcessing: () => false })
    expect(sm.resolveMcpApproval('no-mcp', 'req-9', 'deny')).toBe(false)
  })

  it('auto-approves MCP calls while the session runs with full access', () => {
    const sm = new SessionManager()
    const events: CapturedEvent[] = []
    sm.setEventSink((channel, target, payload) => events.push({ channel, target, payload }))
    const agent = createRecordingAgent()
    const managed = injectSession(sm, 'sess-1', agent)
    ;(managed as unknown as { permissionMode: string }).permissionMode = 'allow-all'

    ;(sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest(managed, approval())

    // No prompt at all — full access means the user already answered.
    expect(events).toEqual([])
    expect(agent.resolved).toEqual([{ requestId: 'req-1', decision: 'allow_for_session' }])
  })

  it('stops asking for a tool the session already always-allowed', () => {
    const sm = new SessionManager()
    const events: CapturedEvent[] = []
    sm.setEventSink((channel, target, payload) => events.push({ channel, target, payload }))
    const agent = createRecordingAgent()
    const managed = injectSession(sm, 'sess-1', agent)
    const request = (sm as unknown as { handleMcpApprovalRequest: (m: unknown, r: McpApprovalRequestDto) => void })
      .handleMcpApprovalRequest.bind(sm)

    request(managed, approval({ requestId: 'req-1' }))
    expect(sm.respondToPermission('sess-1', 'req-1', true, true)).toBe(true)

    // Same server + tool, new call — and the adapter state may well have been
    // rebuilt in between, which is exactly what this memory covers.
    request(managed, approval({ requestId: 'req-2' }))
    expect(events).toHaveLength(1)
    expect(agent.resolved).toEqual([
      { requestId: 'req-1', decision: 'allow_for_session' },
      { requestId: 'req-2', decision: 'allow_for_session' },
    ])

    // A different tool on the same server still asks.
    request(managed, approval({ requestId: 'req-3', originalToolName: 'write', prefixedToolName: 'mcp__srv_write' }))
    expect(events).toHaveLength(2)
  })

  it('reconnects a server in the live chat sessions, not in a utility session', async () => {
    const sm = new SessionManager()
    sm.setEventSink(() => {})
    const agent = createRecordingAgent()
    injectSession(sm, 'chat-1', agent)
    injectSession(sm, 'no-mcp', { isProcessing: () => false })
    // The server has to exist in config for the id lookup to resolve; the
    // handler-level tests cover that path, so this asserts the empty case.
    const missing = await sm.reconnectMcpServer('nope')
    expect(missing).toEqual({ ok: false, message: 'Server not found', code: 'not_found' })
    expect(agent.connects).toEqual([])
  })

  it('reports no_live_session when nothing is running to reconnect in', async () => {
    const sm = new SessionManager()
    sm.setEventSink(() => {})
    // No sessions at all: there is nothing to reconnect, and saying "ok" would
    // be a lie the user would only discover on their next tool call.
    const result = await sm.reconnectMcpServer('nope')
    expect(result.ok).toBe(false)
  })

  it('refreshMcpConfig pushes to every MCP-capable live agent', () => {
    const sm = new SessionManager()
    const agent = createRecordingAgent()
    injectSession(sm, 'with-mcp', agent)
    injectSession(sm, 'without-mcp', { isProcessing: () => false })
    sm.refreshMcpConfig()
    expect(agent.refreshMcpConfigCalls).toBe(1)
  })

  it('deleteSession drops the cached MCP status', async () => {
    const sm = new SessionManager()
    sm.setEventSink(() => {})
    const managed = injectSession(sm, 'sess-1', createRecordingAgent())
    ;(sm as unknown as { handleMcpStatus: (m: unknown, s: McpStatusSnapshotDto) => void })
      .handleMcpStatus(managed, snapshot(1))
    expect(sm.getMcpStatusSnapshots()).toHaveLength(1)

    // deleteSession touches the session store; the MCP cache must go with it.
    // (Works on a manager that never initialized workspaces because the
    // session was injected directly.)
    await sm.deleteSession('sess-1')
    expect(sm.getMcpStatusSnapshots()).toHaveLength(0)
  })
})
