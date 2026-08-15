#!/usr/bin/env bun
/**
 * @bitlab/server — standalone headless Bitlab server.
 *
 * Usage:
 *   BITLAB_SERVER_TOKEN=<secret> bun run packages/server/src/index.ts
 *
 * Environment:
 *   BITLAB_SERVER_TOKEN         — required bearer token for client auth
 *   BITLAB_RPC_HOST             — bind address (default: 127.0.0.1)
 *   BITLAB_RPC_PORT             — bind port (default: 9100)
 *   BITLAB_RPC_TLS_CERT         — path to PEM certificate file (enables TLS/wss)
 *   BITLAB_RPC_TLS_KEY          — path to PEM private key file (required with cert)
 *   BITLAB_RPC_TLS_CA           — path to PEM CA chain file (optional)
 *   BITLAB_APP_ROOT             — app root path (default: cwd)
 *   BITLAB_RESOURCES_PATH       — resources path (default: cwd/resources)
 *   BITLAB_IS_PACKAGED          — 'true' for production (default: false)
 *   BITLAB_VERSION              — app version (default: 0.0.0-dev)
 *   BITLAB_DEBUG                — 'true' for debug logging
 *   BITLAB_WEBUI_DIR            — path to built web UI assets (enables web UI on RPC port)
 *   BITLAB_WEBUI_PASSWORD       — optional shorter password for web login (falls back to BITLAB_SERVER_TOKEN)
 *   BITLAB_WEBUI_SECURE_COOKIE  — optional true/false override for the session cookie Secure flag
 *   BITLAB_WEBUI_WS_URL         — optional browser-facing ws:// or wss:// URL returned by /api/config
 *   BITLAB_WEBUI_REQUIRE_LOGIN  — 'true' to require the login page even from this machine
 */

import { join } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'
import { version as packageVersion } from '../package.json'
import { enableDebug } from '@bitlab/shared/utils/debug'
import { bootstrapServer, startHealthHttpServer, generateServerToken } from '@bitlab/server-core/bootstrap'
import { validateSession, createWebuiHandler, nodeHttpAdapter } from '@bitlab/server-core/webui'
import type { WebuiHandler } from '@bitlab/server-core/webui'
import { getCredentialManager } from '@bitlab/shared/credentials'
import { initializeBackendHostRuntime } from '@bitlab/shared/agent/backend'
import { ensureDefaultPermissions } from '@bitlab/shared/agent/permissions-config'
import {
  addWorkspace,
  ensurePresetThemes,
  ensureToolIcons,
  getAllPiModels,
  getPiModelsForAuthProvider,
  getWorkspaces,
  registerPiModelResolver,
} from '@bitlab/shared/config'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import { ensureDefaultWorkspace } from '@bitlab/shared/workspaces'

// --generate-token: print a crypto-random token and exit
if (process.argv.includes('--generate-token')) {
  console.log(generateServerToken())
  process.exit(0)
}
import type { WsRpcTlsOptions } from '@bitlab/server-core/transport'
import { registerCoreRpcHandlers, cleanupSessionFileWatchForClient } from '@bitlab/server-core/handlers/rpc'
import { SessionManager, setSessionPlatform, setSessionRuntimeHooks } from '@bitlab/server-core/sessions'
import { initModelRefreshService, setFetcherPlatform } from '@bitlab/server-core/model-fetchers'
import { setSearchPlatform, setImageProcessor } from '@bitlab/server-core/services'
import type { HandlerDeps } from '@bitlab/server-core/handlers'

process.env.BITLAB_IS_PACKAGED ??= 'false'

// Prevent unhandled rejections from crashing the server.
// SDK subprocess abort can reject promises that propagate up unhandled;
// Bun (unlike Node) terminates the process on unhandled rejections by default.
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  console.error(`[server] Unhandled rejection (caught, not crashing): ${msg}`)
})

if (process.env.BITLAB_DEBUG === 'true' || process.env.BITLAB_DEBUG === '1') {
  enableDebug()
}

function parseOptionalBooleanEnv(name: string, value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') return undefined

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false

  console.error(`Invalid ${name}: expected one of true/false/1/0/yes/no/on/off.`)
  process.exit(1)
}

function parseOptionalWebSocketUrl(name: string, value: string | undefined): string | undefined {
  if (value == null || value.trim() === '') return undefined

  try {
    const url = new URL(value)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error('must use ws:// or wss://')
    }
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Invalid ${name}: ${message}`)
    process.exit(1)
  }
}

// In dev (monorepo), bundled assets root is the repo root (4 levels up from this file).
// In packaged mode, use BITLAB_BUNDLED_ASSETS_ROOT env or cwd.
const bundledAssetsRoot = process.env.BITLAB_BUNDLED_ASSETS_ROOT
  ?? join(import.meta.dir, '..', '..', '..', '..')

registerPiModelResolver(provider => provider ? getPiModelsForAuthProvider(provider) : getAllPiModels())
initializeBackendHostRuntime({
  hostRuntime: {
    appRootPath: process.env.BITLAB_APP_ROOT ?? bundledAssetsRoot,
    resourcesPath: process.env.BITLAB_RESOURCES_PATH ?? bundledAssetsRoot,
    isPackaged: process.env.BITLAB_IS_PACKAGED === 'true',
  },
})

// TLS configuration — when cert + key paths are provided, server listens on wss://
let tls: WsRpcTlsOptions | undefined
const tlsCertPath = process.env.BITLAB_RPC_TLS_CERT
const tlsKeyPath = process.env.BITLAB_RPC_TLS_KEY
if (tlsCertPath || tlsKeyPath) {
  if (!tlsCertPath || !tlsKeyPath) {
    console.error('TLS requires both BITLAB_RPC_TLS_CERT and BITLAB_RPC_TLS_KEY.')
    process.exit(1)
  }
  tls = {
    cert: readFileSync(tlsCertPath),
    key: readFileSync(tlsKeyPath),
    ...(process.env.BITLAB_RPC_TLS_CA ? { ca: readFileSync(process.env.BITLAB_RPC_TLS_CA) } : {}),
  }
}

// Web UI configuration
const webuiDir = process.env.BITLAB_WEBUI_DIR || undefined
const webuiEnabled = webuiDir && existsSync(webuiDir)
const webuiSecureCookies = parseOptionalBooleanEnv('BITLAB_WEBUI_SECURE_COOKIE', process.env.BITLAB_WEBUI_SECURE_COOKIE)
const webuiWsUrl = parseOptionalWebSocketUrl('BITLAB_WEBUI_WS_URL', process.env.BITLAB_WEBUI_WS_URL)
const serverToken = process.env.BITLAB_SERVER_TOKEN

// Mirrors headless-start's own default so the bind address is known before
// bootstrap runs — the WebUI handler is built first and needs it.
const rpcHostForBind = process.env.BITLAB_RPC_HOST ?? '127.0.0.1'

/**
 * Whether a request arriving from 127.0.0.1 can be trusted as "someone sitting
 * at this machine", which is what lets the local browser skip the login page.
 *
 * Off whenever loopback stops implying that:
 *  - bound to a non-loopback address: the box is reachable from the network, and
 *    a local foothold shouldn't inherit full agent access without a token;
 *  - a reverse proxy is in front (BITLAB_WEBUI_WS_URL): every proxied request
 *    arrives from 127.0.0.1, so the bypass would apply to the whole internet.
 * Also off on explicit opt-out via BITLAB_WEBUI_REQUIRE_LOGIN.
 */
function resolveLoopbackBypass(): boolean {
  if (parseOptionalBooleanEnv('BITLAB_WEBUI_REQUIRE_LOGIN', process.env.BITLAB_WEBUI_REQUIRE_LOGIN)) {
    return false
  }
  if (webuiWsUrl) return false
  return rpcHostForBind === '127.0.0.1'
    || rpcHostForBind === 'localhost'
    || rpcHostForBind === '::1'
}

const allowLoopbackWithoutAuth = resolveLoopbackBypass()

// ---------------------------------------------------------------------------
// Create WebUI handler early so it can be embedded in the WsRpcServer.
// The handler is a pure function — it doesn't need the session manager yet
// because health checks are injected lazily via getHealthCheck().
// ---------------------------------------------------------------------------

let webuiHandler: WebuiHandler | null = null
let webuiNodeHandler: ReturnType<typeof nodeHttpAdapter> | undefined

// Health check is injected lazily — the session manager isn't ready until
// after bootstrap completes, but the handler captures the closure.
let healthCheckFn: (() => { status: string }) | null = null

if (webuiEnabled && serverToken) {
  const rpcPort = parseInt(process.env.BITLAB_RPC_PORT ?? '9100', 10)
  const rpcProtocol = tls ? 'wss' as const : 'ws' as const

  webuiHandler = createWebuiHandler({
    webuiDir: webuiDir!,
    secret: serverToken,
    password: process.env.BITLAB_WEBUI_PASSWORD || undefined,
    secureCookies: webuiSecureCookies,
    publicWsUrl: webuiWsUrl,
    allowLoopbackWithoutAuth,
    wsProtocol: rpcProtocol,
    // WebUI is served on the same port as WS — wsPort matches the RPC port
    wsPort: rpcPort,
    getHealthCheck: () => healthCheckFn?.() ?? { status: 'starting' },
    logger: { info: console.log, warn: console.warn, error: console.error } as any,
  })

  webuiNodeHandler = nodeHttpAdapter(webuiHandler.fetch)
}

const instance = await (async () => {
  try {
    return await bootstrapServer<SessionManager, HandlerDeps>({
      bundledAssetsRoot,
      serverVersion: process.env.BITLAB_VERSION ?? packageVersion,
      tls,
      // When web UI is enabled, accept JWT session cookies on WebSocket upgrade
      validateSessionCookie: webuiEnabled && serverToken
        ? async (cookieHeader) => {
            const session = await validateSession(cookieHeader, serverToken)
            return session !== null
          }
        : undefined,
      allowLoopbackWithoutAuth: webuiEnabled ? allowLoopbackWithoutAuth : false,
      // Embed the WebUI HTTP handler on the WS server's port
      httpHandler: webuiNodeHandler,
      applyPlatformToSubsystems: (platform) => {
        setFetcherPlatform(platform)
        setSessionPlatform(platform)
        setSessionRuntimeHooks({
          updateBadgeCount: () => {},
          captureException: (error) => {
            const err = error instanceof Error ? error : new Error(String(error))
            platform.captureError?.(err)
          },
        })
        setSearchPlatform(platform)
        setImageProcessor(platform.imageProcessor)
      },
      initModelRefreshService: () => initModelRefreshService(async (slug: string) => {
        const manager = getCredentialManager()
        const apiKey = await manager.getLlmApiKey(slug).catch(() => null)
        return { apiKey: apiKey ?? undefined }
      }),
      createSessionManager: () => {
        ensureDefaultPermissions()
        ensureToolIcons()
        ensurePresetThemes()
        ensureDefaultWorkspace()
        if (getWorkspaces().length === 0) {
          addWorkspace({
            name: 'Default',
            kind: 'default',
            folderPath: null,
            lastAccessedAt: Date.now(),
          })
        }
        return new SessionManager()
      },
      bindRpcServer: (sm, server) => sm.setRpcServer(server),
      createHandlerDeps: ({ sessionManager, platform }) => ({ sessionManager, platform }),
      registerAllRpcHandlers: (server, deps, serverCtx) => {
        registerCoreRpcHandlers(server, deps, serverCtx)
        server.handle(RPC_CHANNELS.notification.GET_ENABLED, async () => {
          const { getNotificationsEnabled } = await import('@bitlab/shared/config/storage')
          return getNotificationsEnabled()
        })
        server.handle(RPC_CHANNELS.notification.SET_ENABLED, async (_ctx, enabled: boolean) => {
          const { setNotificationsEnabled } = await import('@bitlab/shared/config/storage')
          setNotificationsEnabled(enabled)
        })
      },
      setSessionEventSink: (sessionManager, sink) => sessionManager.setEventSink(sink),
      initializeSessionManager: async (sessionManager) => {
        await sessionManager.initialize()
      },
      cleanupSessionManager: async (sessionManager) => {
        try {
          await sessionManager.flushAllSessions()
        } finally {
          sessionManager.cleanup()
        }
      },
      cleanupClientResources: cleanupSessionFileWatchForClient,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
})()

// Wire up the lazy health check now that the session manager is ready
if (webuiHandler) {
  const { getHealthCheck } = await import('@bitlab/server-core/handlers/rpc/server')
  const depsLike = { sessionManager: instance.sessionManager } as any
  healthCheckFn = () => getHealthCheck(depsLike)

}

// Start HTTP health endpoint if BITLAB_HEALTH_PORT is set
const healthPort = parseInt(process.env.BITLAB_HEALTH_PORT ?? '0', 10)
const healthServer = await startHealthHttpServer({
  port: healthPort,
  deps: { sessionManager: instance.sessionManager },
  wsServer: instance.wsServer,
  platform: instance.platform,
})

const serverProto = instance.protocol === 'wss' ? 'https' : 'http'
console.log(`BITLAB_SERVER_URL=${instance.protocol}://${instance.host}:${instance.port}`)
console.log(`BITLAB_SERVER_TOKEN=${instance.token}`)
if (webuiHandler) {
  // Report the address actually bound, not a hardcoded 0.0.0.0 — that wording
  // read as "exposed to the whole network" when the default binds to loopback.
  console.log(`BITLAB_WEBUI_URL=${serverProto}://${instance.host}:${instance.port}`)
  console.log(
    allowLoopbackWithoutAuth
      ? 'BITLAB_WEBUI_LOCAL_LOGIN=skipped (loopback requests are trusted)'
      : 'BITLAB_WEBUI_LOCAL_LOGIN=required',
  )
}

// Block binding to a non-localhost address without TLS — tokens would be sent in cleartext.
// Override with --allow-insecure-bind for explicitly trusted networks.
const isLocalBind = instance.host === '127.0.0.1' || instance.host === 'localhost' || instance.host === '::1'
if (!isLocalBind && instance.protocol === 'ws') {
  if (process.argv.includes('--allow-insecure-bind')) {
    console.warn(
      '\n⚠️  WARNING: Server is listening on a network address without TLS.\n' +
      '   Authentication tokens will be sent in cleartext.\n' +
      '   Set BITLAB_RPC_TLS_CERT and BITLAB_RPC_TLS_KEY to enable wss://.\n'
    )
  } else {
    console.error(
      '\n❌  Refusing to bind to a network address without TLS.\n' +
      '   Authentication tokens would be sent in cleartext.\n\n' +
      '   Options:\n' +
      '     1. Set BITLAB_RPC_TLS_CERT and BITLAB_RPC_TLS_KEY to enable wss://\n' +
      '     2. Pass --allow-insecure-bind to override (NOT recommended for production)\n'
    )
    await instance.stop()
    process.exit(1)
  }
}

const shutdown = async () => {
  webuiHandler?.dispose()
  healthServer?.stop()
  await instance.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
