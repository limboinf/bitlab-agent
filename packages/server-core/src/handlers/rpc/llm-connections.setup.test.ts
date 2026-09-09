import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const HANDLER_MODULE_PATH = pathToFileURL(join(import.meta.dir, 'llm-connections.ts')).href

function createConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'bitlab-setup-handler-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{
        id: 'ws-1',
        name: 'My Workspace',
        slug: 'my-workspace',
        kind: 'folder',
        folderPath: workspaceRoot,
        createdAt: Date.now(),
      }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      defaultLlmConnection: 'deepseek-preview',
      llmConnections: [{
        slug: 'deepseek-preview',
        name: 'OpenAI',
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://api.deepseek.com',
        piAuthProvider: 'openai',
        customEndpoint: { api: 'openai-completions' },
        models: [{ id: 'deepseek-v4-preview', contextWindow: 128_000 }],
        defaultModel: 'deepseek-v4-preview',
        modelSelectionMode: 'userDefined3Tier',
        midStreamBehavior: 'steer',
        createdAt: Date.now(),
      }],
    }, null, 2),
  )

  return { configDir, configPath }
}

describe('SETUP_LLM_CONNECTION persistence', () => {
  it('clears a legacy custom endpoint when an unlisted model is saved under DeepSeek', () => {
    const { configDir, configPath } = createConfigDir()
    const setup = {
      slug: 'deepseek-preview',
      credential: '••••••••',
      baseUrl: 'https://api.deepseek.com',
      piAuthProvider: 'deepseek',
      models: [{ id: 'deepseek-v4-preview', contextWindow: 128_000 }],
      defaultModel: 'deepseek-v4-preview',
      modelSelectionMode: 'userDefined3Tier',
    }

    const script = `
      import { RPC_CHANNELS } from '@bitlab/shared/protocol'
      import { registerLlmConnectionsHandlers } from ${JSON.stringify(HANDLER_MODULE_PATH)}

      const handlers = new Map()
      const server = {
        handle(channel, handler) { handlers.set(channel, handler) },
        push() {},
        async invokeClient() { throw new Error('Unexpected client invocation') },
        hasClientCapability() { return false },
        findClientsWithCapability() { return [] },
      }
      registerLlmConnectionsHandlers(server, {
        sessionManager: { async reinitializeAuth() {} },
        platform: {},
      })

      const handler = handlers.get(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION)
      if (!handler) throw new Error('SETUP_LLM_CONNECTION handler not registered')
      const result = await handler(
        { clientId: 'test', workspaceId: 'ws-1', webContentsId: null },
        ${JSON.stringify(setup)},
      )
      if (!result?.success) throw new Error(result?.error ?? 'Setup failed')
    `

    const run = Bun.spawnSync([process.execPath, '--eval', script], {
      cwd: join(import.meta.dir, '../../../../..'),
      env: { ...process.env, BITLAB_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(run.exitCode, run.stderr.toString()).toBe(0)

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const connection = config.llmConnections.find((item: { slug: string }) => item.slug === setup.slug)
    expect(connection).toMatchObject({
      slug: 'deepseek-preview',
      providerType: 'pi',
      authType: 'api_key',
      baseUrl: 'https://api.deepseek.com',
      piAuthProvider: 'deepseek',
      defaultModel: 'deepseek-v4-preview',
      modelSelectionMode: 'userDefined3Tier',
    })
    expect(connection.customEndpoint).toBeUndefined()
  })
})
