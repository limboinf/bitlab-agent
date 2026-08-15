/**
 * MCP OAuth credential access for the main process.
 *
 * pi-mcp-adapter keeps MCP OAuth tokens in the OS credential store and only
 * runs inside the pi-agent-server bundle, so the main process cannot read them
 * directly. The bundle therefore exposes two one-shot modes — one printing the
 * bearer for a server, one printing whether credentials exist and when they
 * expire — and this module drives them. No chat session is created and no MCP
 * connection is made: a Settings connection test or a credential badge must
 * never open a browser or mutate runtime state.
 */

import { execFile } from 'node:child_process'
import { resolvePiServerRuntime } from '@bitlab/shared/agent/backend'
import { ensureMcpOAuthDir } from '@bitlab/shared/config'
import type { PlatformServices } from '../runtime/platform'

/** The bundle's one-shot modes. Must match pi-agent-server. */
export const MCP_OAUTH_TOKEN_FLAG = '--mcp-oauth-token'
export const MCP_OAUTH_STATUS_FLAG = '--mcp-oauth-status'

/** A stored token is a local read; anything slower than this is a hang. */
const LOOKUP_TIMEOUT_MS = 10_000

/**
 * Whether a server has usable stored credentials.
 *
 * `unavailable` is deliberately distinct from `absent`: a locked or broken
 * credential store is not the same as "never signed in", and telling the user
 * to sign in again would not fix it.
 */
export interface McpCredentialStatus {
  status: 'present' | 'absent' | 'unavailable'
  /** Unix seconds, when the stored token carries an expiry. */
  expiresAt?: number
}

/** Run one credential mode of the bundle and parse its single JSON line. */
async function runCredentialMode(
  platform: PlatformServices,
  flag: string,
  serverName: string,
  url: string,
): Promise<Record<string, unknown> | null> {
  const { piServerPath, runtimePath } = resolvePiServerRuntime({
    hostRuntime: {
      appRootPath: platform.appRootPath,
      resourcesPath: platform.resourcesPath,
      isPackaged: platform.isPackaged,
    },
  })
  if (!piServerPath || !runtimePath) return null

  const stdout = await new Promise<string>(resolve => {
    execFile(
      runtimePath,
      [piServerPath, flag, serverName, url],
      {
        timeout: LOOKUP_TIMEOUT_MS,
        env: { ...process.env, MCP_OAUTH_DIR: ensureMcpOAuthDir() },
      },
      (error, out) => resolve(error ? '' : out),
    )
  })

  try {
    return JSON.parse(stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>
  } catch {
    platform.logger.debug(`[MCP] credential lookup returned nothing for "${serverName}"`)
    return null
  }
}

/**
 * The access token pi-mcp-adapter would send for `serverName` at `url`, or
 * undefined when the server was never signed into (or the lookup failed —
 * a missing credential is not an error worth surfacing, the probe simply
 * reports `needs-auth` as it would for an expired one).
 */
export async function readMcpOAuthAccessToken(
  platform: PlatformServices,
  serverName: string,
  url: string,
): Promise<string | undefined> {
  const parsed = await runCredentialMode(platform, MCP_OAUTH_TOKEN_FLAG, serverName, url)
  const token = parsed?.accessToken
  return typeof token === 'string' && token ? token : undefined
}

/** Whether `serverName` has stored credentials, and when they run out. */
export async function readMcpCredentialStatus(
  platform: PlatformServices,
  serverName: string,
  url: string,
): Promise<McpCredentialStatus> {
  const parsed = await runCredentialMode(platform, MCP_OAUTH_STATUS_FLAG, serverName, url)
  const status = parsed?.status
  if (status !== 'present' && status !== 'unavailable') return { status: 'absent' }
  const expiresAt = parsed?.expiresAt
  return {
    status,
    ...(typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? { expiresAt } : {}),
  }
}
