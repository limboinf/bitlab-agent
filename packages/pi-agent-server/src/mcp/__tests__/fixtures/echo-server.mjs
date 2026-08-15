/**
 * Minimal stdio MCP server fixture for subprocess MCP integration tests.
 *
 * Registers a single tool (name from argv[2], default 'echo') that returns its
 * `message` input as text. Spawned by StdioClientTransport via the adapter:
 *   <execPath> echo-server.mjs [toolName]
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const toolName = process.argv[2] ?? 'echo'

const server = new McpServer({ name: `bitlab-fixture-${toolName}`, version: '1.0.0' })

server.registerTool(
  toolName,
  {
    title: toolName,
    description: `Fixture tool "${toolName}": echoes the message back as text`,
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `${toolName}:${message}` }],
  }),
)

await server.connect(new StdioServerTransport())
