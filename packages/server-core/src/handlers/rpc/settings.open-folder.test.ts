import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import { CLIENT_OPEN_FILE_DIALOG } from '@bitlab/server-core/transport'
import type { HandlerFn, RequestContext, RpcServer } from '@bitlab/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerSettingsHandlers } from './settings'

function createHarness(dialogResult: { canceled: boolean; filePaths: string[] }) {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient(_clientId, channel) {
      expect(channel).toBe(CLIENT_OPEN_FILE_DIALOG)
      return dialogResult
    },
    hasClientCapability() { return true },
    findClientsWithCapability() { return ['client-1'] },
  }

  registerSettingsHandlers(server, {
    sessionManager: {} as HandlerDeps['sessionManager'],
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
  })

  const openFolder = handlers.get(RPC_CHANNELS.dialog.OPEN_FOLDER)
  if (!openFolder) throw new Error('OPEN_FOLDER handler not registered')

  const context: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'workspace-1',
    webContentsId: 1,
  }

  return { openFolder, context }
}

describe('OPEN_FOLDER', () => {
  it('returns the selected folder from the client dialog result', async () => {
    const { openFolder, context } = createHarness({
      canceled: false,
      filePaths: ['/tmp/selected-workspace'],
    })

    expect(await openFolder(context)).toBe('/tmp/selected-workspace')
  })

  it('returns null when the client dialog is canceled', async () => {
    const { openFolder, context } = createHarness({ canceled: true, filePaths: [] })

    expect(await openFolder(context)).toBeNull()
  })
})
