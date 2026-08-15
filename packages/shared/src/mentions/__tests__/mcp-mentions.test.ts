/**
 * Tests for `[mcp:server]` mentions — the composer's "use this MCP server"
 * chip. The token names the tool the user wants used; it resolves into an
 * explicit instruction, because a model that is merely *offered* an MCP
 * server will happily answer from a web search instead.
 */
import { describe, it, expect } from 'bun:test'
import { formatMcpDirective, parseMentions, resolveMcpMentions } from '../index.ts'

describe('parseMentions with MCP mentions', () => {
  it('collects mentioned server names', () => {
    expect(parseMentions('[mcp:notion] 查一下上周的会议纪要', []).mcpServers).toEqual(['notion'])
  })

  it('accepts the name characters MCP server names allow', () => {
    expect(parseMentions('[mcp:okx-trade-mcp] [mcp:better_icons]', []).mcpServers)
      .toEqual(['okx-trade-mcp', 'better_icons'])
  })

  it('de-duplicates repeats and leaves other mention types alone', () => {
    const parsed = parseMentions('[mcp:notion] [skill:commit] [mcp:notion] [file:src/a.ts]', ['commit'])
    expect(parsed.mcpServers).toEqual(['notion'])
    expect(parsed.skills).toEqual(['commit'])
    expect(parsed.files).toEqual(['src/a.ts'])
  })

  it('reports none when there is no MCP mention', () => {
    expect(parseMentions('plain text about mcp servers', []).mcpServers).toEqual([])
  })
})

describe('resolveMcpMentions', () => {
  it('turns the token into a readable instruction', () => {
    expect(resolveMcpMentions('[mcp:notion] 查一下会议纪要'))
      .toBe('[Use the "notion" MCP server for this request] 查一下会议纪要')
  })

  it('leaves other mentions in place', () => {
    expect(resolveMcpMentions('[mcp:notion] [skill:commit] [file:a.ts]'))
      .toBe('[Use the "notion" MCP server for this request] [skill:commit] [file:a.ts]')
  })

  it('leaves a token alone when it names a server that is not configured', () => {
    // Passing the known set in guards against a stale draft turning into an
    // instruction to use something that no longer exists.
    expect(resolveMcpMentions('[mcp:ghost] hi', ['notion'])).toBe('[mcp:ghost] hi')
  })
})

describe('formatMcpDirective', () => {
  it('names the server and closes the usual escape hatches', () => {
    const directive = formatMcpDirective(['okx-trade-mcp'])
    expect(directive).toContain('"okx-trade-mcp"')
    // The observed failure was a web search standing in for the server.
    expect(directive).toContain('web search')
    expect(directive).toContain('say so')
  })

  it('handles several servers and stays empty without any', () => {
    expect(formatMcpDirective(['a', 'b'])).toContain('these MCP servers')
    expect(formatMcpDirective([])).toBe('')
  })
})
