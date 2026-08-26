import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNELS, type Session } from '@bitlab/shared/protocol'
import type { Message } from '@bitlab/core/types'
import type { HandlerFn, RequestContext, RpcServer } from '@bitlab/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSessionsHandlers } from './sessions'

const CONTEXT: RequestContext = { clientId: 'client-1', workspaceId: 'workspace-1', webContentsId: 1 }

function createHarness(sessionManager: Partial<HandlerDeps['sessionManager']>) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() { return undefined },
    hasClientCapability() { return true },
    findClientsWithCapability() { return [] },
  }

  registerSessionsHandlers(server, {
    sessionManager: sessionManager as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      imageProcessor: {
        async getMetadata() { return null },
        async process() { return Buffer.from('') },
      },
    },
  } as HandlerDeps)

  const getArtifacts = handlers.get(RPC_CHANNELS.sessions.GET_ARTIFACTS)
  if (!getArtifacts) throw new Error('GET_ARTIFACTS handler not registered')
  return getArtifacts
}

describe('sessions:getArtifacts', () => {
  let root: string
  let sessionFolderPath: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bitlab-artifacts-rpc-'))
    sessionFolderPath = join(root, 'sessions', 's1')
    mkdirSync(join(sessionFolderPath, 'data'), { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const managerFor = (messages: Message[] = []): Partial<HandlerDeps['sessionManager']> => ({
    getSessionPath: (id: string) => (id === 's1' ? sessionFolderPath : null),
    getSession: async (id: string) =>
      id === 's1'
        ? ({ id, messages, workingDirectory: join(root, 'project') } as unknown as Session)
        : null,
  })

  it('fails loudly for an unknown session instead of returning an empty list', async () => {
    const getArtifacts = createHarness(managerFor())
    expect(getArtifacts(CONTEXT, 'missing')).rejects.toThrow('Session not found: missing')
  })

  it('returns empty arrays for a session with nothing produced', async () => {
    const getArtifacts = createHarness(managerFor())
    expect(await getArtifacts(CONTEXT, 's1')).toEqual({ sessionId: 's1', artifacts: [], changes: [] })
  })

  it('returns metadata only — never file contents', async () => {
    writeFileSync(join(sessionFolderPath, 'data', 'report.html'), '<h1>secret</h1>')
    const getArtifacts = createHarness(managerFor())

    const snapshot = await getArtifacts(CONTEXT, 's1') as { artifacts: Array<Record<string, unknown>> }
    expect(snapshot.artifacts).toHaveLength(1)
    expect(JSON.stringify(snapshot)).not.toContain('secret')
    expect(Object.keys(snapshot.artifacts[0]!).sort()).toEqual(
      ['classification', 'exists', 'kind', 'modifiedAt', 'name', 'path', 'relativePath', 'revisions', 'scope', 'size', 'sources'],
    )
  })

  it('gives each caller its own arrays', async () => {
    writeFileSync(join(sessionFolderPath, 'data', 'report.html'), '<h1>hi</h1>')
    const getArtifacts = createHarness(managerFor())

    const first = await getArtifacts(CONTEXT, 's1') as { artifacts: unknown[] }
    const second = await getArtifacts(CONTEXT, 's1') as { artifacts: unknown[] }
    first.artifacts.length = 0
    expect(second.artifacts).toHaveLength(1)
  })
})
