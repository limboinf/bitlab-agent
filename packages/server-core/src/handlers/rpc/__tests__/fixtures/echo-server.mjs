/**
 * Minimal stdio MCP server used by the `mcp:test` handler tests.
 *
 * Registers a single `echo` tool that returns its input as text, exactly the
 * surface the one-shot TEST probe needs: connect → listTools → 1 tool.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'bitlab-echo-server', version: '1.0.0' })

server.registerTool(
  'echo',
  {
    title: 'Echo',
    description: 'Echoes the message back as text',
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: message }],
  }),
)

await server.connect(new StdioServerTransport())
