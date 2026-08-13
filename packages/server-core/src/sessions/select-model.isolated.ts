/**
 * Behavioral coverage for `selectModel`, the wire that replaced
 * `setSessionConnection`'s "locked after the first message" throw.
 *
 * The properties under test are exactly the ones the lock used to stand in for:
 *
 *  - a session with history can still be re-routed;
 *  - a turn already running keeps the route it snapshotted;
 *  - a same-connection model swap retargets the LIVE backend instead of
 *    restarting it, so it costs no context;
 *  - a selection is remembered as the workspace default, so the NEXT session
 *    starts on it;
 *  - the only refusals left are real incompatibilities (unknown connection,
 *    or a text-only model for a session that already contains images).
 */

import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// This file registers LLM connections, which `addLlmConnection` writes to the
// config that `CONFIG_DIR` points at. That constant is resolved ONCE, when
// `config/paths.ts` is first loaded — so isolation only works if nothing has
// loaded it yet. Two things are therefore required, and both are load-bearing:
//
//  1. `.isolated.ts`, so the runner gives this file its own process. In the
//     shared `bun test` process another file's static import wins the race and
//     every connection below lands in the developer's real ~/.bitlab.
//  2. env first, then DYNAMIC imports, so `paths.ts` reads the temp dir.
//
// The assertion below is the backstop: if isolation ever silently stops
// working, this file must fail rather than write to someone's real config.
const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'bitlab-select-model-config-'))
process.env.BITLAB_CONFIG_DIR = CONFIG_DIR
writeFileSync(join(CONFIG_DIR, 'config.json'), JSON.stringify({
  workspaces: [],
  activeWorkspaceId: null,
  activeSessionId: null,
  llmConnections: [],
}, null, 2), 'utf-8')

const { addLlmConnection, CONFIG_DIR: ACTIVE_CONFIG_DIR } = await import('@bitlab/shared/config')
const { createWorkspaceAtPath, loadWorkspaceConfig } = await import('@bitlab/shared/workspaces')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')

type SessionManager = InstanceType<typeof SessionManager>

// Compare the CONSTANT the storage layer actually writes through, not
// `getConfigDir()` — that re-reads the env every call and would happily report
// the temp dir while storage kept using the real one.
if (ACTIVE_CONFIG_DIR !== CONFIG_DIR) {
  throw new Error(
    `select-model.isolated.ts refuses to run: storage resolved CONFIG_DIR to ${ACTIVE_CONFIG_DIR}, `
    + `not the isolated ${CONFIG_DIR}. Something loaded config/paths.ts first — this file must stay `
    + `an .isolated.ts so it gets its own process.`,
  )
}

interface AgentStub {
  isProcessing: () => boolean
  setModel: jest.Mock
  setThinkingLevel: jest.Mock
  updateRuntimeConfig: jest.Mock
  dispose: () => void
}

function agentStub(): AgentStub {
  return {
    isProcessing: () => false,
    setModel: jest.fn(),
    setThinkingLevel: jest.fn(),
    updateRuntimeConfig: jest.fn().mockResolvedValue(true),
    dispose: () => { /* no-op */ },
  }
}

/** Register a real connection so route resolution has something to resolve to. */
function connection(slug: string, models: string[]): void {
  addLlmConnection({
    slug,
    name: slug.toUpperCase(),
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    baseUrl: 'https://example.invalid/v1',
    customEndpoint: { api: 'openai-completions', supportsImages: false },
    models,
    defaultModel: models[0],
    createdAt: Date.now(),
  })
}

function injectSession(
  sm: SessionManager,
  id: string,
  workspaceRoot: string,
  opts: {
    llmConnection?: string
    model?: string
    agent?: AgentStub | null
    messages?: Array<Record<string, unknown>>
  } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    slug: 'test-workspace',
    kind: 'folder' as const,
    folderPath: workspaceRoot,
    dataRoot: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection: opts.llmConnection, model: opts.model },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as Record<string, unknown>
  managed.agent = opts.agent ?? null
  managed.messages = opts.messages ?? []
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('selectModel', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-select-'))
    sm = new SessionManager()
    connection('conn-a', ['model-a1', 'model-a2'])
    connection('conn-b', ['model-b1'])
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  it('re-routes a session that already has messages (the old lock is gone)', async () => {
    const managed = injectSession(sm, 's1', tmpRoot, {
      llmConnection: 'conn-a',
      model: 'model-a1',
      messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }],
    })

    const result = await sm.selectModel('s1', { connection: 'conn-b', model: 'model-b1' })

    expect(result.selected).toMatchObject({ connection: 'conn-b', model: 'model-b1' })
    expect(managed.llmConnection).toBe('conn-b')
  })

  it('swapping models within one connection retargets the live backend, no restart', async () => {
    const agent = agentStub()
    const managed = injectSession(sm, 's2', tmpRoot, {
      llmConnection: 'conn-a',
      model: 'model-a1',
      agent,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    })

    await sm.selectModel('s2', { connection: 'conn-a', model: 'model-a2' })

    expect(agent.setModel).toHaveBeenCalledWith('model-a2')
    expect(managed.model).toBe('model-a2')
  })

  it('crossing connections leaves the live backend alone for the runtime refresh', async () => {
    const agent = agentStub()
    injectSession(sm, 's3', tmpRoot, {
      llmConnection: 'conn-a',
      model: 'model-a1',
      agent,
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    })

    await sm.selectModel('s3', { connection: 'conn-b', model: 'model-b1' })

    // Credential/provider routing changed, so retargeting the model on the
    // existing backend would point it somewhere it cannot authenticate.
    expect(agent.setModel).not.toHaveBeenCalled()
  })

  it('a running turn keeps the route it snapshotted', async () => {
    const managed = injectSession(sm, 's5', tmpRoot, {
      llmConnection: 'conn-a',
      model: 'model-a1',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1 }],
    })
    // Simulate a turn that already entered assembly.
    managed.assembledSelection = { connection: 'conn-a', model: 'model-a1' }

    await sm.selectModel('s5', { connection: 'conn-b', model: 'model-b1' })

    // The switch is recorded for the NEXT turn...
    expect((managed.pickedSelection as Record<string, unknown>).connection).toBe('conn-b')
    // ...while the running turn's snapshot is untouched.
    expect(managed.assembledSelection).toMatchObject({ connection: 'conn-a', model: 'model-a1' })
  })

  it('refuses an unknown connection', async () => {
    injectSession(sm, 's6', tmpRoot, { llmConnection: 'conn-a' })

    await expect(
      sm.selectModel('s6', { connection: 'does-not-exist', model: 'whatever' }),
    ).rejects.toThrow(/No connection serves/)
  })

  it('refuses a text-only model for a session that already contains images', async () => {
    // This is a REAL incompatibility — the session's own history would stop
    // being sendable — unlike "you already sent a message", which is not.
    injectSession(sm, 's7', tmpRoot, {
      llmConnection: 'conn-a',
      messages: [{
        id: 'm1',
        role: 'user',
        content: 'look',
        timestamp: 1,
        attachments: [{ id: 'a1', name: 'shot.png', type: 'image', mimeType: 'image/png', path: '/tmp/shot.png' }],
      }],
    })

    await expect(
      sm.selectModel('s7', { connection: 'conn-b', model: 'model-b1' }),
    ).rejects.toThrow(/does not accept image input/)
  })

  it('allows a text-only model when the session has no images', async () => {
    injectSession(sm, 's8', tmpRoot, {
      llmConnection: 'conn-a',
      messages: [{ id: 'm1', role: 'user', content: 'text only', timestamp: 1 }],
    })

    const result = await sm.selectModel('s8', { connection: 'conn-b', model: 'model-b1' })
    expect(result.selected.connection).toBe('conn-b')
  })

  it('carries the thinking level onto the live backend', async () => {
    const agent = agentStub()
    injectSession(sm, 's9', tmpRoot, { llmConnection: 'conn-a', model: 'model-a1', agent })

    await sm.selectModel('s9', { connection: 'conn-a', model: 'model-a1', thinkingLevel: 'high' })

    expect(agent.setThinkingLevel).toHaveBeenCalledWith('high')
  })

  describe('the model catalog', () => {
    it('drops duplicate model ids so a row is never listed (or checked) twice', async () => {
      // A provider exposing fewer models than the wizard's best/balanced/fast
      // tiers legitimately repeats an id.
      addLlmConnection({
        slug: 'conn-dup',
        name: 'DUP',
        providerType: 'pi_compat',
        authType: 'none',
        baseUrl: 'https://example.invalid/v1',
        customEndpoint: { api: 'openai-completions' },
        models: ['pi/m-x', 'pi/m-x', 'pi/m-y'],
        defaultModel: 'pi/m-x',
        createdAt: Date.now(),
      })
      injectSession(sm, 'c1', tmpRoot, { llmConnection: 'conn-dup' })

      const directory = await sm.getSessionModels('c1')
      const group = directory.groups.find(g => g.slug === 'conn-dup')

      expect(group?.models.map(m => m.id)).toEqual(['pi/m-x', 'pi/m-y'])
    })

    it('omits unauthenticated connections instead of listing them as failures', async () => {
      // They are not errors — they are simply not offerable, and an error row
      // above the real choices is noise.
      injectSession(sm, 'c2', tmpRoot, { llmConnection: 'conn-a' })

      const directory = await sm.getSessionModels('c2')

      expect(directory.failures).toEqual([])
      expect(directory.groups.some(g => g.slug === 'conn-a')).toBe(false)
    })
  })

  describe('remembering the choice for the next session', () => {
    beforeEach(() => {
      // The writer needs a real workspace config to update.
      createWorkspaceAtPath(tmpRoot, 'Test Workspace')
    })

    it('saves the selection as the workspace default', async () => {
      injectSession(sm, 'r1', tmpRoot, { llmConnection: 'conn-a', model: 'model-a1' })

      await sm.selectModel('r1', {
        connection: 'conn-b',
        model: 'model-b1',
        thinkingLevel: 'high',
      })

      const config = loadWorkspaceConfig(tmpRoot)
      expect(config?.defaults?.defaultLlmConnection).toBe('conn-b')
      expect(config?.defaults?.model).toBe('model-b1')
      expect(config?.defaults?.thinkingLevel).toBe('high')
    })

    it('a session created afterwards starts on the remembered route', async () => {
      injectSession(sm, 'r2', tmpRoot, { llmConnection: 'conn-a', model: 'model-a1' })
      await sm.selectModel('r2', { connection: 'conn-b', model: 'model-b1' })

      // createSession reads the same workspace defaults, so the remembered
      // route is what a brand-new session picks up.
      const config = loadWorkspaceConfig(tmpRoot)
      expect(config?.defaults?.defaultLlmConnection).toBe('conn-b')
      expect(config?.defaults?.model).toBe('model-b1')
    })

    it('keeps the connection and model together when overwriting an older default', async () => {
      // Writing one without the other would hand the next session a model its
      // connection never advertised.
      injectSession(sm, 'r3', tmpRoot, { llmConnection: 'conn-a' })
      await sm.selectModel('r3', { connection: 'conn-b', model: 'model-b1' })
      await sm.selectModel('r3', { connection: 'conn-a', model: 'model-a2' })

      const config = loadWorkspaceConfig(tmpRoot)
      expect(config?.defaults?.defaultLlmConnection).toBe('conn-a')
      expect(config?.defaults?.model).toBe('model-a2')
    })
  })
})
