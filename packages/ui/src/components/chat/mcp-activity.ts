export type McpActivityAction =
  | 'authorize'
  | 'callTool'
  | 'connect'
  | 'describeTool'
  | 'listTools'
  | 'readInstructions'
  | 'searchTools'
  | 'status'

export interface McpActivityPresentation {
  action: McpActivityAction
  serverName?: string
  toolName?: string
  detail?: string
}

interface McpActivitySource {
  toolName?: string
  toolInput?: Record<string, unknown>
  displayName?: string
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * Session tools use an MCP-shaped prefix for Pi registration, but they are
 * Bitlab's own tools and must not be presented as calls to an external server.
 */
export function isExternalMcpToolName(toolName?: string): boolean {
  return toolName === 'mcp'
    || Boolean(toolName?.startsWith('mcp__') && !toolName.startsWith('mcp__session__'))
}

function getProxyPresentation(toolInput: Record<string, unknown>): McpActivityPresentation {
  const serverName = nonEmptyString(toolInput.server) ?? nonEmptyString(toolInput.connect)
  const action = nonEmptyString(toolInput.action)
  const toolName = nonEmptyString(toolInput.tool)
  const search = nonEmptyString(toolInput.search)
  const describe = nonEmptyString(toolInput.describe)
  const instructions = nonEmptyString(toolInput.instructions)

  if (action === 'auth-start' || action === 'auth-complete') {
    return { action: 'authorize', serverName }
  }
  if (toolName) return { action: 'callTool', serverName, toolName }
  if (search) return { action: 'searchTools', serverName, detail: search }
  if (describe) return { action: 'describeTool', serverName, toolName: describe }
  if (instructions) return { action: 'readInstructions', serverName: instructions }
  if (toolInput.connect) return { action: 'connect', serverName }
  if (serverName) return { action: 'listTools', serverName }
  return { action: 'status' }
}

function getDirectPresentation(toolName: string, displayName?: string): McpActivityPresentation {
  const rawToolName = toolName.slice('mcp__'.length)
  const friendlyName = nonEmptyString(displayName)

  if (friendlyName) {
    const separatorIndex = friendlyName.indexOf(':')
    if (separatorIndex > 0) {
      const serverName = friendlyName.slice(0, separatorIndex).trim()
      const directToolName = friendlyName.slice(separatorIndex + 1).trim()
      if (serverName && directToolName) {
        return { action: 'callTool', serverName, toolName: directToolName }
      }
    }
  }

  return {
    action: 'callTool',
    toolName: rawToolName,
    detail: friendlyName && friendlyName !== toolName ? friendlyName : undefined,
  }
}

/** Build the stable, user-facing identity for proxy and directly registered MCP tools. */
export function getMcpActivityPresentation({
  toolName,
  toolInput = {},
  displayName,
}: McpActivitySource): McpActivityPresentation | null {
  if (!isExternalMcpToolName(toolName)) return null
  if (toolName === 'mcp') return getProxyPresentation(toolInput)
  if (!toolName) return null
  return getDirectPresentation(toolName, displayName)
}
