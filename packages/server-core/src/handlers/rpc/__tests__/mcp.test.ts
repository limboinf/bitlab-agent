import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'

const MCP_MODULE = pathToFileURL(join(import.meta.dir, '..', 'mcp.ts')).href

/**
 * The MCP handlers persist through @bitlab/shared/config storage, whose
 * CONFIG_DIR resolves at import time — so the case runs in a subprocess
 * pointed at a throwaway BITLAB_CONFIG_DIR (same pattern as the shared
 * config storage tests).
 */
function setup(): { run: (script: string) => any; configDir: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'bitlab-mcp-rpc-'))
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
  }, null, 2), 'utf-8')

  function run(script: string): any {
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: join(import.meta.dir, '..', '..', '..', '..'),
      // Isolate homedir too: `mcp:discover` scans the real user's Cursor /
      // Claude configs, which exist on dev machines and would make the
      // hosts-discovery assertions environment-dependent.
      env: { ...process.env, BITLAB_CONFIG_DIR: configDir, HOME: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(`subprocess failed:\n${result.stderr.toString()}`)
    return JSON.parse(result.stdout.toString())
  }

  return { run, configDir }
}

// The in-subprocess harness: registers the handlers into a map-based fake
// server with a recording session-manager stub, then runs a scripted
// sequence of invocations and reports everything the outer test asserts on.
const HARNESS = `
  import { readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { RPC_CHANNELS } from '@bitlab/shared/protocol'
  import { registerMcpHandlers } from ${JSON.stringify(MCP_MODULE)}

  const handlers = new Map()
  const pushes = []
  const server = {
    handle: (channel, handler) => handlers.set(channel, handler),
    push: (channel, target) => pushes.push({ channel, target }),
    invokeClient: async () => {},
    hasClientCapability: () => false,
    findClientsWithCapability: () => [],
  }
  const calls = { refresh: 0, statusSnapshots: [], auth: [], lastKnown: [], forgotten: [] }
  const deps = {
    sessionManager: {
      getMcpStatusSnapshots: () => [...calls.statusSnapshots],
      getLastKnownMcpStatuses: () => [...calls.lastKnown],
      forgetMcpStatus: (name) => { calls.forgotten.push(name) },
      refreshMcpConfig: () => { calls.refresh++ },
      authenticateMcpServer: (serverId) => {
        calls.auth.push(serverId)
        return serverId === 'known-http'
          ? Promise.resolve({ ok: true, message: 'authenticated' })
          : Promise.resolve({ ok: false, message: 'Server not found' })
      },
      getWorkspaces: () => [],
    },
    platform: {
      appRootPath: '/', resourcesPath: '/', isPackaged: false,
      appVersion: '0.0.0-test', isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    },
  }
  registerMcpHandlers(server, deps)
  const ctx = { clientId: 'client-1', workspaceId: null, webContentsId: null }
  const persisted = () => JSON.parse(readFileSync(join(process.env.BITLAB_CONFIG_DIR, 'config.json'), 'utf8')).mcpServers ?? []

  const results = {}
  results.listEmpty = await handlers.get(RPC_CHANNELS.mcp.LIST)(ctx)
  results.saveBadName = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    name: 'bad name!', enabled: true, trusted: false, source: 'user',
    transport: { type: 'stdio', command: 'node' },
  })
  results.saveBadTransport = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    name: 'good-name', transport: { type: 'http', url: 'ftp://nope' },
  })
  results.persistedAfterRejections = persisted()
  results.saveOk = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    name: 'My_Server-1', transport: { type: 'stdio', command: 'node', args: ['server.js'] },
  })
  results.persistedAfterSave = persisted()
  results.saveDuplicateName = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    name: 'My_Server-1', transport: { type: 'stdio', command: 'node' },
  })
  results.updateSameServer = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    id: 'my_server-1', name: 'My_Server-1', enabled: false, transport: { type: 'stdio', command: 'bun' },
  })
  results.persistedAfterUpdate = persisted()
  // Same transport, different flags: the remembered status still applies.
  results.updateFlagsOnly = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    id: 'my_server-1', name: 'My_Server-1', enabled: true, transport: { type: 'stdio', command: 'bun' },
  })
  results.forgottenAfterSaves = [...calls.forgotten]
  results.deleteUnknown = await handlers.get(RPC_CHANNELS.mcp.DELETE)(ctx, 'nope')
  results.deleteOk = await handlers.get(RPC_CHANNELS.mcp.DELETE)(ctx, 'my_server-1')
  results.persistedAfterDelete = persisted()
  results.saveSettings = await handlers.get(RPC_CHANNELS.mcp.SAVE_SETTINGS)(ctx, {
    requireApproval: false, directTools: false, lifecycle: 'eager',
  })
  results.importServers = await handlers.get(RPC_CHANNELS.mcp.IMPORT)(ctx, {
    servers: [
      { name: 'imported', transport: { type: 'stdio', command: 'node' }, originPath: '/x/.mcp.json' },
      { name: 'fresh', transport: { type: 'http', url: 'https://example.com' } },
      { name: 'imported', transport: { type: 'stdio', command: 'node' } },
    ],
  })
  results.persistedAfterImport = persisted()
  results.importCollisions = await handlers.get(RPC_CHANNELS.mcp.IMPORT)(ctx, {
    servers: [{ name: 'imported', transport: { type: 'stdio', command: 'node' } }],
  })
  // A save with an explicit id that does not own the colliding name is still
  // a duplicate, even though an id was supplied.
  results.saveDuplicateDifferentId = await handlers.get(RPC_CHANNELS.mcp.SAVE)(ctx, {
    id: 'some-other-id', name: 'imported', transport: { type: 'stdio', command: 'node' },
  })
  results.listAfterImport = await handlers.get(RPC_CHANNELS.mcp.LIST)(ctx)
  calls.statusSnapshots.push({ version: 1, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 })
  calls.lastKnown.push({ name: 'imported', status: 'connected', toolCount: 3, resourceCount: 0, tools: [] })
  results.listWithStatus = await handlers.get(RPC_CHANNELS.mcp.LIST)(ctx)
  results.authOk = await handlers.get(RPC_CHANNELS.mcp.AUTH)(ctx, { id: 'known-http' })
  results.authMissingId = await handlers.get(RPC_CHANNELS.mcp.AUTH)(ctx, {})
  results.authUnknown = await handlers.get(RPC_CHANNELS.mcp.AUTH)(ctx, { id: 'nope' })
  results.discover = await handlers.get(RPC_CHANNELS.mcp.DISCOVER)(ctx, '/nonexistent-workspace-root')

  console.log(JSON.stringify({ results, pushes, calls }))
`

describe('mcp RPC handlers', () => {
  it('validates SAVE input (bad name, bad transport, duplicate) and persists valid servers', () => {
    const { run, configDir } = setup()
    try {
      const { results, pushes, calls } = run(HARNESS)

      // LIST on a fresh config: empty servers, default settings, no statuses.
      expect(results.listEmpty).toEqual({
        servers: [],
        settings: { requireApproval: true, directTools: true, lifecycle: 'lazy', requestTimeoutMs: 60_000 },
        statuses: [],
        lastKnown: [],
      })

      // Validation rejections — none of these may persist or broadcast.
      expect(results.saveBadName.success).toBe(false)
      expect(results.saveBadName.error).toContain('Invalid server name')
      expect(results.saveBadTransport.success).toBe(false)
      expect(results.saveBadTransport.error).toContain('Invalid MCP server')
      expect(results.persistedAfterRejections).toEqual([])

      // Valid save: id derived from the name, defaults filled, persisted.
      expect(results.saveOk.success).toBe(true)
      expect(results.saveOk.server).toEqual({
        id: 'my_server-1',
        name: 'My_Server-1',
        enabled: true,
        trusted: false,
        source: 'user',
        transport: { type: 'stdio', command: 'node', args: ['server.js'] },
      })
      expect(results.persistedAfterSave).toHaveLength(1)

      // Same name under a different (generated) id is a duplicate…
      expect(results.saveDuplicateName.success).toBe(false)
      expect(results.saveDuplicateName.error).toContain('already exists')
      // …but re-saving with the same id updates in place.
      expect(results.updateSameServer.success).toBe(true)
      expect(results.persistedAfterUpdate[0].enabled).toBe(false)
      expect(results.persistedAfterUpdate[0].transport.command).toBe('bun')

      // A remembered status is retired when the server is new or its transport
      // moved (node → bun), but survives a flag-only edit.
      expect(results.updateFlagsOnly.success).toBe(true)
      expect(results.forgottenAfterSaves).toEqual(['My_Server-1', 'My_Server-1'])

      // DELETE by stable id.
      expect(results.deleteUnknown.success).toBe(false)
      expect(results.deleteOk.success).toBe(true)
      expect(results.persistedAfterDelete).toEqual([])
      // Deleting a server forgets its status too.
      expect(calls.forgotten).toEqual(['My_Server-1', 'My_Server-1', 'My_Server-1'])

      // SAVE_SETTINGS persists normalized settings.
      expect(results.saveSettings.success).toBe(true)
      expect(results.saveSettings.settings).toEqual({
        requireApproval: false, directTools: false, lifecycle: 'eager', requestTimeoutMs: 60_000,
      })

      // IMPORT adds non-colliding entries with source 'import' and reports
      // skipped names (including intra-batch duplicates).
      expect(results.importServers.success).toBe(true)
      expect(results.importServers.added).toBe(2)
      expect(results.importServers.skipped).toEqual(['imported'])
      expect(results.persistedAfterImport.map((s: { name: string }) => s.name)).toEqual(['imported', 'fresh'])
      expect(results.persistedAfterImport.every((s: { source: string }) => s.source === 'import')).toBe(true)
      expect(results.importCollisions.added).toBe(0)
      expect(results.importCollisions.skipped).toEqual(['imported'])
      expect(results.saveDuplicateDifferentId.success).toBe(false)
      expect(results.saveDuplicateDifferentId.error).toContain('already exists')

      // LIST shape with persisted servers and cached statuses.
      expect(results.listAfterImport.servers.map((s: { name: string }) => s.name)).toEqual(['imported', 'fresh'])
      expect(results.listWithStatus.statuses).toHaveLength(1)
      expect(results.listWithStatus.lastKnown).toEqual([
        { name: 'imported', status: 'connected', toolCount: 3, resourceCount: 0, tools: [] },
      ])

      // AUTH routes to sessionManager.authenticateMcpServer by server id.
      expect(results.authOk).toEqual({ ok: true, message: 'authenticated' })
      expect(results.authMissingId.ok).toBe(false)
      expect(results.authMissingId.message).toContain('Missing server id')
      expect(results.authUnknown).toEqual({ ok: false, message: 'Server not found' })
      expect(calls.auth).toEqual(['known-http', 'nope'])

      // Every successful write broadcast mcp:changed and pushed a live refresh:
      // save + update + flag-only update + delete + saveSettings + import batch = 6.
      expect(pushes).toHaveLength(6)
      expect(pushes.every((p: { channel: string; target: { to: string } }) =>
        p.channel === RPC_CHANNELS.mcp.CHANGED && p.target.to === 'all')).toBe(true)
      expect(calls.refresh).toBe(6)

      // DISCOVER with a root lacking .mcp.json: empty project list, hosts array.
      expect(results.discover).toEqual({ project: [], hosts: [] })
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })
})
