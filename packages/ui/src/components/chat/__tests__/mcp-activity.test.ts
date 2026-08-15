import { describe, expect, test } from 'bun:test'
import {
  getMcpActivityPresentation,
  isExternalMcpToolName,
} from '../mcp-activity'

describe('MCP activity presentation', () => {
  test('recognizes the proxy tool and external direct tools', () => {
    expect(isExternalMcpToolName('mcp')).toBe(true)
    expect(isExternalMcpToolName('mcp__notion_search')).toBe(true)
  })

  test('does not mislabel Bitlab session tools as external MCP calls', () => {
    expect(isExternalMcpToolName('mcp__session__call_llm')).toBe(false)
    expect(isExternalMcpToolName('Read')).toBe(false)
  })

  test('describes proxy tool calls with server and tool names', () => {
    expect(getMcpActivityPresentation({
      toolName: 'mcp',
      toolInput: { server: 'notion', tool: 'search', args: { query: 'MCP' } },
    })).toEqual({
      action: 'callTool',
      serverName: 'notion',
      toolName: 'search',
    })
  })

  test('describes proxy discovery actions', () => {
    expect(getMcpActivityPresentation({
      toolName: 'mcp',
      toolInput: { search: 'icon' },
    })).toEqual({
      action: 'searchTools',
      serverName: undefined,
      detail: 'icon',
    })
  })

  test('uses display metadata for directly registered tools', () => {
    expect(getMcpActivityPresentation({
      toolName: 'mcp__notion_search',
      displayName: 'Notion: search',
    })).toEqual({
      action: 'callTool',
      serverName: 'Notion',
      toolName: 'search',
    })
  })

  test('keeps an unambiguous raw identity when direct tool metadata is absent', () => {
    expect(getMcpActivityPresentation({
      toolName: 'mcp__better_icons_search_icons',
    })).toEqual({
      action: 'callTool',
      toolName: 'better_icons_search_icons',
      detail: undefined,
    })
  })

  test('maps OAuth proxy actions to authorization activity', () => {
    expect(getMcpActivityPresentation({
      toolName: 'mcp',
      toolInput: { action: 'auth-start', server: 'notion' },
    })).toEqual({
      action: 'authorize',
      serverName: 'notion',
    })
  })
})
