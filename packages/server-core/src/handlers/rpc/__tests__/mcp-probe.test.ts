import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { probeMcpServer } from '../mcp'

const ECHO_SERVER = join(import.meta.dir, 'fixtures', 'echo-server.mjs')

/**
 * `mcp:test` integration: the probe talks to a real MCP server over stdio
 * using @modelcontextprotocol/sdk directly — no agent subprocess involved.
 */
describe('probeMcpServer (mcp:test)', () => {
  it('connects to the stdio echo fixture and lists its single tool', async () => {
    const result = await probeMcpServer({
      type: 'stdio',
      command: process.execPath,
      args: [ECHO_SERVER],
      env: { ECHO_TEST: '1' },
    })

    expect(result.ok).toBe(true)
    expect(result.toolCount).toBe(1)
    expect(result.tools).toEqual([
      { name: 'echo', description: 'Echoes the message back as text' },
    ])
    expect(result.error).toBeUndefined()
  }, 30_000)

  it('fails closed with an error when the command exits immediately', async () => {
    const result = await probeMcpServer({
      type: 'stdio',
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
    expect(result.error!.length).toBeGreaterThan(0)
    expect(result.tools).toBeUndefined()
  }, 30_000)

  it('rejects an unreachable http endpoint instead of hanging', async () => {
    const result = await probeMcpServer({
      type: 'http',
      // RFC 5737 test range — nothing listens here; the port is in the
      // reserved-and-unused range so it fails fast or via the 10s timeout.
      url: 'http://192.0.2.1:1/mcp',
    })

    expect(result.ok).toBe(false)
    expect(typeof result.error).toBe('string')
  }, 30_000)
})
