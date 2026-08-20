import { loadShellEnv } from './shell-env'
loadShellEnv()

import { app, BrowserWindow, dialog, ipcMain, nativeImage, nativeTheme, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { delimiter, join } from 'node:path'
import { bootstrapServer } from '@bitlab/server-core/bootstrap'
import { cleanupSessionFileWatchForClient } from '@bitlab/server-core/handlers/rpc'
import { initModelRefreshService, setFetcherPlatform } from '@bitlab/server-core/model-fetchers'
import { setImageProcessor, setSearchPlatform } from '@bitlab/server-core/services'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@bitlab/server-core/sessions'
import {
  addWorkspace,
  ensurePresetThemes,
  ensureToolIcons,
  getPersistedUiLanguage,
  getWorkspaces,
  registerPiModelResolver,
  setPersistedUiLanguage,
} from '@bitlab/shared/config'
import { getCredentialManager } from '@bitlab/shared/credentials'
import { initializeDocs } from '@bitlab/shared/docs'
import { setupI18n, i18n, SUPPORTED_LANGUAGE_CODES, type LanguageCode } from '@bitlab/shared/i18n'
import { ensureDefaultPermissions } from '@bitlab/shared/agent/permissions-config'
import { initializeBackendHostRuntime } from '@bitlab/shared/agent/backend'
import { getAllPiModels, getPiModelsForAuthProvider } from '@bitlab/shared/config'
import { ensureDefaultWorkspace } from '@bitlab/shared/workspaces'
import { setBundledAssetsRoot } from '@bitlab/shared/utils'
import { BrowserPaneManager } from './browser-pane-manager'
import { registerAllRpcHandlers } from './handlers'
import type { HandlerDeps } from './handlers/handler-deps'
import { mainLog } from './logger'
import { createElectronPlatform } from './platform'
import { WindowManager } from './window-manager'
import { checkForUpdatesOnLaunch, setAutoUpdateEventSink } from './auto-update'
import { handleDeepLink } from './deep-link'
import { createApplicationMenu, rebuildMenu, setMenuEventSink } from './menu'
import { registerThumbnailHandler, THUMBNAIL_PRIVILEGED_SCHEME } from './thumbnail-protocol'
import { registerHtmlPreviewHandler, HTML_PREVIEW_PRIVILEGED_SCHEME } from './html-preview-protocol'
import { applyConfiguredProxySettings } from './network-proxy'

setupI18n()
const persistedUiLanguage = getPersistedUiLanguage()
if (persistedUiLanguage) void i18n.changeLanguage(persistedUiLanguage)
app.setName(process.env.BITLAB_APP_NAME || 'Bitlab')

// One call registers the whole custom-scheme registry — a second call would
// replace it, so every scheme is listed here.
protocol.registerSchemesAsPrivileged([
  THUMBNAIL_PRIVILEGED_SCHEME,
  HTML_PREVIEW_PRIVILEGED_SCHEME,
])

let stopServer: (() => Promise<void>) | null = null
let windowManager: WindowManager | null = null
let browserPaneManager: BrowserPaneManager | null = null
let eventSink: ReturnType<WindowManager['getRpcEventSink']> = null
let resolveClientId: ((webContentsId: number) => string | undefined) | null = null
let pendingDeepLink: string | null = null
let isQuitting = false

function findDeepLink(args: string[]): string | undefined {
  return args.find(argument => argument.startsWith('bitlab://'))
}

function registerProtocolHandler() {
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('bitlab', process.execPath, [process.argv[1]])
    return
  }
  app.setAsDefaultProtocolClient('bitlab')
}

async function routeDeepLink(url: string) {
  if (!windowManager) {
    pendingDeepLink = url
    return
  }
  const result = await handleDeepLink(url, windowManager, eventSink ?? undefined, resolveClientId ?? undefined)
  if (!result.success) mainLog.warn('Unable to route deep link', { url, error: result.error })
}

function configureBundledTools() {
  const root = app.isPackaged ? join(process.resourcesPath, 'app') : process.cwd()
  const resources = app.isPackaged
    ? join(root, 'dist', 'resources')
    : join(root, 'apps', 'electron', 'resources')
  const platformKey = `${process.platform}-${process.arch}`
  const uvDir = join(resources, 'bin', platformKey)
  const binDir = join(resources, 'bin')
  const scriptsDir = join(resources, 'scripts')
  const uv = join(uvDir, process.platform === 'win32' ? 'uv.exe' : 'uv')
  const bun = join(root, 'vendor', 'bun', process.platform === 'win32' ? 'bun.exe' : 'bun')
  process.env.BITLAB_IS_PACKAGED = app.isPackaged ? '1' : '0'
  process.env.BITLAB_RESOURCES_BASE = root
  process.env.BITLAB_APP_ROOT = app.isPackaged ? app.getAppPath() : process.cwd()
  process.env.BITLAB_UV = existsSync(uv) ? uv : 'uv'
  if (existsSync(bun)) process.env.BITLAB_BUN = bun
  process.env.BITLAB_SCRIPTS = scriptsDir
  process.env.PATH = `${binDir}${delimiter}${uvDir}${delimiter}${process.env.PATH ?? ''}`
  setBundledAssetsRoot(app.isPackaged ? join(root, 'dist') : join(root, 'apps', 'electron'))
  initializeBackendHostRuntime({ hostRuntime: { appRootPath: process.env.BITLAB_APP_ROOT, resourcesPath: root, isPackaged: app.isPackaged } })
}

function ensureLocalWorkspace() {
  ensureDefaultWorkspace()
  if (getWorkspaces().length > 0) return
  addWorkspace({
    name: 'Default',
    kind: 'default',
    folderPath: null,
    lastAccessedAt: Date.now(),
  })
}

async function start() {
  // Before anything reaches the network: without this the proxy only ever took
  // effect in the session where it was saved.
  await applyConfiguredProxySettings()
  registerThumbnailHandler()
  registerHtmlPreviewHandler()
  configureBundledTools()
  initializeDocs()
  ensureDefaultPermissions()
  ensureToolIcons()
  ensurePresetThemes()
  registerPiModelResolver(provider => provider ? getPiModelsForAuthProvider(provider) : getAllPiModels())

  windowManager = new WindowManager()
  createApplicationMenu(windowManager)
  browserPaneManager = new BrowserPaneManager()
  browserPaneManager.setWindowManager(windowManager)
  browserPaneManager.registerCapabilityIpc()

  const platform = createElectronPlatform({
    app,
    nativeImage,
    nativeTheme,
    shell,
    logger: mainLog,
    isDebugMode: !app.isPackaged,
  })
  const clients = new Map<number, string>()
  const token = randomUUID()
  const instance = await bootstrapServer<SessionManager, HandlerDeps>({
    serverToken: token,
    rpcHost: '127.0.0.1',
    rpcPort: 0,
    serverId: 'desktop',
    serverVersion: app.getVersion(),
    bundledAssetsRoot: app.isPackaged ? app.getAppPath() : process.cwd(),
    platformFactory: () => platform,
    applyPlatformToSubsystems: current => {
      setFetcherPlatform(current)
      setSessionPlatform(current)
      setSessionRuntimeHooks({ captureException: () => {} })
      setSearchPlatform(current)
      setImageProcessor(current.imageProcessor)
    },
    initModelRefreshService: () => initModelRefreshService(async slug => ({
      apiKey: await getCredentialManager().getLlmApiKey(slug).catch(() => null) ?? undefined,
    })),
    createSessionManager: () => {
      ensureLocalWorkspace()
      const manager = new SessionManager()
      manager.setBrowserPaneManager(browserPaneManager!)
      return manager
    },
    bindRpcServer: (manager, server) => manager.setRpcServer(server),
    createHandlerDeps: ({ sessionManager, platform: current }) => ({
      sessionManager,
      platform: current,
      windowManager: windowManager!,
      browserPaneManager: browserPaneManager!,
      onThemePreferencesChanged: preferences => browserPaneManager!.setThemeMode(preferences.mode),
    }),
    registerAllRpcHandlers,
    setSessionEventSink: (manager, sink) => manager.setEventSink(sink),
    initializeSessionManager: manager => manager.initialize(),
    cleanupSessionManager: async manager => {
      await manager.flushAllSessions()
      manager.cleanup()
    },
    onClientConnected: ({ clientId, webContentsId }) => {
      if (webContentsId !== null) clients.set(webContentsId, clientId)
    },
    cleanupClientResources: clientId => {
      cleanupSessionFileWatchForClient(clientId)
      for (const [webContentsId, id] of clients) if (id === clientId) clients.delete(webContentsId)
    },
  })
  stopServer = instance.stop
  const sink = instance.wsServer.push.bind(instance.wsServer)
  eventSink = sink
  resolveClientId = id => clients.get(id)
  windowManager.setRpcEventSink(sink, id => clients.get(id))
  setMenuEventSink(sink, id => clients.get(id))
  browserPaneManager.onStateChange(info => sink('browser-pane:state-changed', { to: 'all' }, info))
  browserPaneManager.onRemoved(id => sink('browser-pane:removed', { to: 'all' }, id))
  browserPaneManager.onShowRequest(payload => sink('browser-pane:show-request', { to: 'all' }, payload))
  browserPaneManager.setSessionPathResolver(id => instance.sessionManager.getSessionPath(id))
  setAutoUpdateEventSink(sink)

  ipcMain.on('__get-web-contents-id', event => { event.returnValue = event.sender.id })
  ipcMain.on('__get-workspace-id', event => { event.returnValue = windowManager!.getWorkspaceForWindow(event.sender.id) ?? getWorkspaces()[0]!.id })
  ipcMain.on('__get-ws-port', event => { event.returnValue = instance.port })
  ipcMain.on('__get-ws-token', event => { event.returnValue = instance.token })
  ipcMain.handle('__dialog:showMessageBox', (event, options) => dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender)!, options))
  ipcMain.handle('__dialog:showOpenDialog', (event, options) => dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender)!, options))
  ipcMain.handle('__i18n:changeLanguage', async (_event, language: unknown) => {
    if (typeof language === 'string' && SUPPORTED_LANGUAGE_CODES.includes(language as LanguageCode)) {
      await i18n.changeLanguage(language)
      setPersistedUiLanguage(language as LanguageCode)
      await rebuildMenu()
    }
  })

  const workspace = getWorkspaces()[0]!
  windowManager.createWindow({ workspaceId: workspace.id })
  if (pendingDeepLink) {
    const url = pendingDeepLink
    pendingDeepLink = null
    await routeDeepLink(url)
  }
  if (app.isPackaged) void checkForUpdatesOnLaunch()
}

registerProtocolHandler()
app.on('open-url', (event, url) => {
  event.preventDefault()
  void routeDeepLink(url)
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_event, commandLine) => {
    const url = findDeepLink(commandLine)
    if (url) void routeDeepLink(url)
    else windowManager?.getLastActiveWindow()?.focus()
  })
  app.whenReady().then(start).catch(error => {
    mainLog.error('Desktop startup failed', error)
    app.quit()
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && windowManager) {
    const workspace = getWorkspaces()[0]
    if (workspace) windowManager.createWindow({ workspaceId: workspace.id })
  }
})
app.on('before-quit', event => {
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  windowManager?.setAppQuitting(true)
  browserPaneManager?.destroyAll()
  void (async () => {
    try {
      await stopServer?.()
    } catch (error) {
      mainLog.error('Desktop shutdown failed', error)
    } finally {
      app.quit()
    }
  })()
})
