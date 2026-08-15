import { describe, expect, it } from 'bun:test'
import type {
  BitlabMcpServer,
  McpServerRuntimeStatus,
  McpServerStatusDto,
  McpSessionStatusDto,
} from '@bitlab/shared/config'
import {
  countRunningServers,
  filterServers,
  humanizeMcpMessage,
  mcpOperationErrorKey,
  mergeServerDisplays,
  sumAvailableTools,
  transportSummary,
  type McpServerDisplay,
} from '../mcp-derive'
import { isMcpServerCommand, mcpServerOfCommand } from '@/components/ui/slash-command-menu'

function server(overrides: Partial<BitlabMcpServer> = {}): BitlabMcpServer {
  return {
    id: 'demo',
    name: 'demo',
    enabled: true,
    trusted: false,
    source: 'user',
    transport: { type: 'stdio', command: 'npx' },
    ...overrides,
  }
}

function status(name: string, status: McpServerRuntimeStatus, toolCount = 0): McpServerStatusDto {
  return { name, status, toolCount, disabled: status === 'disabled' }
}

function snapshot(servers: McpServerStatusDto[], sessionId = 's1'): McpSessionStatusDto {
  return {
    sessionId,
    snapshot: { version: 1, servers, totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 },
  }
}

function display(status: McpServerDisplay['status'], toolCount = 0, cached = false): McpServerDisplay {
  return { status, cached, toolCount }
}

describe('transportSummary', () => {
  it('joins stdio command and args', () => {
    expect(
      transportSummary(
        server({ transport: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'] } }),
      ),
    ).toBe('npx -y pkg')
  })

  it('reduces http urls to their host', () => {
    expect(
      transportSummary(server({ transport: { type: 'http', url: 'https://api.example.com/mcp' } })),
    ).toBe('api.example.com')
  })

  it('falls back to the raw url when it is not parseable', () => {
    expect(transportSummary(server({ transport: { type: 'http', url: 'not a url' } }))).toBe(
      'not a url',
    )
  })
})

describe('mergeServerDisplays', () => {
  it('keeps the best-ranked report for a server across sessions', () => {
    const map = mergeServerDisplays([
      snapshot([status('a', 'connected', 4)], 's1'),
      snapshot([status('a', 'not-connected'), status('b', 'connected', 3)], 's2'),
    ])
    expect(map.get('a')?.status).toBe('connected')
    expect(map.get('a')?.toolCount).toBe(4)
    expect(map.get('b')?.toolCount).toBe(3)
  })

  it('ranks needs-auth above failed and not-connected', () => {
    const map = mergeServerDisplays([
      snapshot([status('a', 'failed'), status('b', 'not-connected')], 's1'),
      snapshot([status('a', 'needs-auth'), status('b', 'needs-auth')], 's2'),
    ])
    expect(map.get('a')?.status).toBe('needs-auth')
    expect(map.get('b')?.status).toBe('needs-auth')
  })

  it('unions servers reported by different sessions', () => {
    const map = mergeServerDisplays([
      snapshot([status('a', 'cached')], 's1'),
      snapshot([status('b', 'failed')], 's2'),
    ])
    expect([...map.keys()].sort()).toEqual(['a', 'b'])
  })

  it('falls back to a remembered status when no session reports one', () => {
    const map = mergeServerDisplays([], [status('a', 'connected', 31)])
    expect(map.get('a')).toEqual({ status: 'connected', cached: true, toolCount: 31 })
  })

  it('prefers a live report over a remembered one of the same rank', () => {
    const map = mergeServerDisplays(
      [snapshot([status('a', 'connected', 5)])],
      [status('a', 'connected', 31)],
    )
    expect(map.get('a')).toEqual({ status: 'connected', cached: false, toolCount: 5 })
  })

  it('lets a remembered connect outrank a lazy session reporting not-connected', () => {
    const map = mergeServerDisplays(
      [snapshot([status('a', 'not-connected')])],
      [status('a', 'connected', 31)],
    )
    expect(map.get('a')).toEqual({ status: 'connected', cached: true, toolCount: 31 })
  })

  it('returns an empty map for no snapshots', () => {
    expect(mergeServerDisplays([]).size).toBe(0)
  })
})

describe('countRunningServers', () => {
  const displayByName = new Map<string, McpServerDisplay>([
    ['connected-srv', display('connected')],
    ['cached-srv', display('cached')],
    ['failed-srv', display('failed')],
    ['disabled-srv', display('disabled')],
    ['enabled-offline', display('not-connected')],
  ])

  it('counts enabled connected/cached servers only', () => {
    const servers = [
      server({ name: 'connected-srv' }),
      server({ name: 'cached-srv' }),
      server({ name: 'failed-srv' }),
      server({ name: 'disabled-srv' }),
      server({ name: 'enabled-offline' }),
      server({ name: 'missing-status' }),
    ]
    expect(countRunningServers(servers, displayByName)).toBe(2)
  })

  it('ignores stale live statuses on disabled servers', () => {
    const servers = [server({ name: 'connected-srv', enabled: false })]
    expect(countRunningServers(servers, displayByName)).toBe(0)
  })
})

describe('sumAvailableTools', () => {
  it('sums toolCount of enabled servers, treating missing as zero', () => {
    const displayByName = new Map<string, McpServerDisplay>([
      ['a', display('connected', 5)],
      ['b', display('connected', 2)],
    ])
    const servers = [
      server({ name: 'a' }),
      server({ name: 'b' }),
      server({ name: 'missing' }), // no status entry
      server({ name: 'c', enabled: false }), // disabled — skipped
    ]
    displayByName.set('c', display('connected', 100))
    expect(sumAvailableTools(servers, displayByName)).toBe(7)
  })
})

describe('filterServers', () => {
  const servers = [
    server({ id: 'b', name: 'brave', transport: { type: 'stdio', command: 'npx', args: ['-y', 'brave-mcp'] } }),
    server({ id: 'a', name: 'api-gateway', source: 'project', transport: { type: 'http', url: 'https://gw.example.com/mcp' } }),
    server({ id: 'c', name: 'context7', source: 'import', transport: { type: 'stdio', command: 'bunx' } }),
  ]
  const sourceLabel = (source: BitlabMcpServer['source']) => source

  it('returns all servers name-sorted when the query is blank', () => {
    expect(filterServers(servers, '   ', sourceLabel).map((s) => s.name)).toEqual([
      'api-gateway',
      'brave',
      'context7',
    ])
  })

  it('matches name, transport summary and source case-insensitively', () => {
    expect(filterServers(servers, 'BRAVE', sourceLabel).map((s) => s.name)).toEqual(['brave'])
    expect(filterServers(servers, 'gw.example.com', sourceLabel).map((s) => s.name)).toEqual(['api-gateway'])
    expect(filterServers(servers, 'project', sourceLabel).map((s) => s.name)).toEqual(['api-gateway'])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterServers(servers, 'nope', sourceLabel)).toEqual([])
  })
})

describe('mcpOperationErrorKey', () => {
  it('maps known codes to their own wording', () => {
    expect(mcpOperationErrorKey('auth_required')).toBe('settings.mcp.opError.auth_required')
    expect(mcpOperationErrorKey('no_live_session')).toBe('settings.mcp.opError.no_live_session')
  })

  it('returns null for codes the UI has no wording for', () => {
    expect(mcpOperationErrorKey('some_new_adapter_code')).toBeNull()
    expect(mcpOperationErrorKey(undefined)).toBeNull()
  })
})

describe('humanizeMcpMessage', () => {
  it('drops the sentences that tell an agent which tool to call', () => {
    expect(
      humanizeMcpMessage('Server "notion" requires OAuth. Use mcp({ connect: "notion" }) to retry.'),
    ).toBe('Server "notion" requires OAuth.')
    expect(
      humanizeMcpMessage('Server "linear" is not connected. Run /mcp reconnect linear to retry.'),
    ).toBe('Server "linear" is not connected.')
  })

  it('strips query strings, which can carry a code or a token', () => {
    expect(humanizeMcpMessage('Callback failed: https://mcp.example.com/cb?code=abc123&state=x'))
      .toBe('Callback failed: https://mcp.example.com/cb')
  })

  it('leaves an ordinary message alone', () => {
    expect(humanizeMcpMessage('Connection refused')).toBe('Connection refused')
  })
})

describe('mcp command ids', () => {
  it('reads the server name out of a /mcp command', () => {
    expect(mcpServerOfCommand('mcp:notion')).toBe('notion')
    expect(mcpServerOfCommand('mcp:okx-trade-mcp')).toBe('okx-trade-mcp')
  })

  it('recognizes MCP commands and leaves other commands alone', () => {
    expect(isMcpServerCommand('mcp:notion')).toBe(true)
    expect(isMcpServerCommand('compact')).toBe(false)
    expect(isMcpServerCommand('allow-all')).toBe(false)
  })
})
