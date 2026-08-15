/**
 * MCP RPC client wrapper
 *
 * Thin, defensive accessor for the `mcp:*` RPC channels
 * (packages/shared/src/protocol/channels.ts → RPC_CHANNELS.mcp).
 *
 * The RPC surface is exposed on `window.electronAPI.mcp` via dotted
 * channel-map entries (the same mechanism as `search.*` / `browserPane.*`):
 *
 *   'mcp.list':            invoke(RPC_CHANNELS.mcp.LIST)
 *   'mcp.save':            invoke(RPC_CHANNELS.mcp.SAVE)
 *   'mcp.delete':          invoke(RPC_CHANNELS.mcp.DELETE)
 *   'mcp.saveSettings':    invoke(RPC_CHANNELS.mcp.SAVE_SETTINGS)
 *   'mcp.test':            invoke(RPC_CHANNELS.mcp.TEST)
 *   'mcp.discover':        invoke(RPC_CHANNELS.mcp.DISCOVER)
 *   'mcp.import':          invoke(RPC_CHANNELS.mcp.IMPORT)
 *   'mcp.onChanged':       listener(RPC_CHANNELS.mcp.CHANGED)
 *   'mcp.onStatus':        listener(RPC_CHANNELS.mcp.STATUS)
 *
 * `getMcpApi()` returns null while the mcp channel-map entries are absent
 * (older main process / preload), so callers can degrade gracefully.
 */

import type {
  BitlabMcpServer,
  BitlabMcpSettings,
  DiscoveredHostConfig,
  DiscoveredMcpServer,
  McpOperationResult,
  McpServerStatusDto,
  McpSessionStatusDto,
  McpStatusSnapshotDto,
} from '@bitlab/shared/config'

/** Whether a server has stored OAuth credentials (`mcp:credentials`). */
export interface McpCredentialStatus {
  status: 'present' | 'absent' | 'unavailable'
  /** Unix seconds, when the stored token carries an expiry. */
  expiresAt?: number
}

/** One tool listing entry returned by `mcp:test`. */
export interface McpTestToolInfo {
  name: string
  description?: string
}

export type McpTestResult =
  | { ok: true; status: 'ok'; toolCount: number; tools: McpTestToolInfo[]; truncated?: boolean }
  | { ok: false; status: 'needs-auth' | 'failed'; error: string }

/** Response shape of `mcp:list`. */
export interface McpListResult {
  servers: BitlabMcpServer[]
  settings: BitlabMcpSettings
  /** One snapshot per live session (empty when no session is open). */
  statuses: McpSessionStatusDto[]
  /**
   * What each server was last seen doing, remembered by the main process
   * beyond the reporting session's lifetime — the only real state Settings
   * has when no session is open.
   */
  lastKnown?: McpServerStatusDto[]
}

/** Response shape of `mcp:discover`. */
export interface McpDiscoverResult {
  project: DiscoveredMcpServer[]
  hosts: DiscoveredHostConfig[]
}

/** The renderer-facing MCP RPC surface (namespace on window.electronAPI). */
export interface McpApi {
  list(): Promise<McpListResult>
  save(server: BitlabMcpServer): Promise<unknown>
  delete(params: { id: string }): Promise<unknown>
  saveSettings(settings: BitlabMcpSettings): Promise<unknown>
  test(server: BitlabMcpServer): Promise<McpTestResult>
  /** Browser OAuth sign-in (HTTP servers; opens the default browser). */
  auth(params: { id: string }): Promise<McpOperationResult>
  /** Abandon an in-flight sign-in. */
  cancelAuth?(): Promise<{ ok: boolean }>
  /** Clear a server's stored OAuth credentials. */
  signOut?(params: { id: string }): Promise<McpOperationResult>
  /** Reconnect a server in every live chat session. */
  reconnect?(params: { id: string }): Promise<McpOperationResult>
  /** Stored-credential status (no connection is made). */
  credentials?(params: { id: string }): Promise<McpCredentialStatus>
  discover(params: { workspaceRoot?: string }): Promise<McpDiscoverResult>
  import(params: { servers: BitlabMcpServer[] }): Promise<unknown>
  /** Broadcast subscription (mcp:changed). Returns cleanup fn. */
  onChanged(callback: () => void): () => void
  /** Broadcast subscription (mcp:notify — auth progress and notices). */
  onNotify(callback: (notice: { sessionId: string; message: string; level: 'info' | 'warning' | 'error' }) => void): () => void
  /** Broadcast subscription (mcp:status — live runtime snapshots). */
  onStatus?(callback: (payload: { sessionId: string; snapshot: McpStatusSnapshotDto }) => void): () => void
}

/**
 * Get the MCP RPC namespace, or null when the transport does not expose it.
 * Callers should treat null as "MCP unavailable" rather than crash.
 */
export function getMcpApi(): McpApi | null {
  if (typeof window === 'undefined' || !window.electronAPI) return null
  const mcp = (window.electronAPI as unknown as { mcp?: McpApi }).mcp
  if (!mcp || typeof mcp.list !== 'function' || typeof mcp.save !== 'function') {
    return null
  }
  return mcp
}
