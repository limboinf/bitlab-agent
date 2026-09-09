import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '@bitlab/core/types'

const resources: Array<{ stop(): void }> = []
const tempDirs: string[] = []
const originalConfigDir = process.env.BITLAB_CONFIG_DIR

afterEach(() => {
  for (const resource of resources.splice(0)) resource.stop()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalConfigDir === undefined) delete process.env.BITLAB_CONFIG_DIR
  else process.env.BITLAB_CONFIG_DIR = originalConfigDir
})

function sse(chunks: unknown[]): Response {
  return new Response(
    chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  )
}

// Isolated because PiAgent and the config/credential managers retain process state.
describe('Unlisted models on a named provider', () => {
  it('uses the selected provider key and unlisted model IDs for queries and chat without Custom mode', async () => {
    const requests: Array<{ model: string; authorization: string | null }> = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        if (!new URL(request.url).pathname.endsWith('/chat/completions')) {
          return new Response('not found', { status: 404 })
        }
        const body = await request.json() as { model: string }
        requests.push({ model: body.model, authorization: request.headers.get('authorization') })
        return sse([
          { id: 'preview-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Preview verified.' } }] },
          { id: 'preview-chat', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
      },
    })
    resources.push(server)
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'bitlab-preview-flow-'))
    tempDirs.push(workspaceRoot)
    process.env.BITLAB_CONFIG_DIR = join(workspaceRoot, 'config')
    const { ensureConfigDir } = await import('../../config/storage.ts')
    ensureConfigDir()
    const { getCredentialManager } = await import('../../credentials/index.ts')
    const manager = getCredentialManager()
    const originalGetLlmApiKey = manager.getLlmApiKey
    manager.getLlmApiKey = async () => 'preview-test-key'
    const { PiAgent } = await import('../pi-agent.ts')
    const miniModel = 'deepseek-bitlab-mini-preview-regression'
    const chatModel = 'deepseek-bitlab-chat-preview-regression'
    const agent = new PiAgent({
      provider: 'pi',
      providerType: 'pi',
      authType: 'api_key',
      connectionSlug: 'deepseek-preview-test',
      model: chatModel,
      miniModel,
      workspace: {
        id: 'preview-workspace', name: 'Preview Workspace', slug: 'preview-workspace',
        kind: 'folder', folderPath: workspaceRoot, dataRoot: workspaceRoot, createdAt: 1,
      },
      session: {
        id: 'preview-session', workspaceRootPath: workspaceRoot,
        createdAt: 1, lastUsedAt: 1, permissionMode: 'allow-all',
      },
      isHeadless: true,
      skipConfigWatcher: true,
      runtime: {
        paths: { node: process.execPath, piServer: resolve(import.meta.dir, '../../../../pi-agent-server/src/index.ts') },
        piAuthProvider: 'deepseek',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        customModels: [miniModel, { id: chatModel, contextWindow: 200_000 }],
        // No customEndpoint: an unlisted model must not require Custom mode.
      },
    })
    try {
      const result = await agent.queryLlm({ prompt: 'Summarize this preview.' })
      expect(result).toMatchObject({ text: 'Preview verified.', model: miniModel })
      const events: AgentEvent[] = []
      for await (const event of agent.chat('Confirm this preview.')) events.push(event)
      expect(events.some(event => event.type === 'text_complete' && event.text.includes('Preview verified.'))).toBe(true)
      expect(events.at(-1)?.type).toBe('complete')
      expect(requests).toEqual([
        { model: miniModel, authorization: 'Bearer preview-test-key' },
        { model: chatModel, authorization: 'Bearer preview-test-key' },
      ])
    } finally {
      agent.destroy()
      manager.getLlmApiKey = originalGetLlmApiKey
    }
  }, 30_000)
})
