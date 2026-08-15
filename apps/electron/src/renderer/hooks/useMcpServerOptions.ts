/**
 * Enabled MCP servers with their live status, for the composer's `/mcp` and
 * `@` pickers.
 *
 * Reads the same two sources Settings does (`mcp:list` for the servers plus
 * the backend's memory of earlier sessions, `mcp:status` for live snapshots)
 * so the picker cannot disagree with the settings page about what is
 * connected. Loaded lazily: nothing is fetched until a caller asks for it,
 * which for the composer means the first time the slash menu opens.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { McpSessionStatusDto } from '@bitlab/shared/config'
import { getMcpApi, type McpListResult } from '@/lib/mcp-rpc'
import { mergeServerDisplays, type McpServerDisplay } from '@/lib/mcp-derive'

export interface McpServerOption {
  name: string
  display: McpServerDisplay | undefined
}

export interface McpServerOptions {
  /** Enabled servers, name-sorted. Empty when MCP is unavailable or unused. */
  servers: McpServerOption[]
  /** Re-read the list (after a config change elsewhere). */
  refresh: () => void
}

export function useMcpServerOptions(active: boolean): McpServerOptions {
  const [list, setList] = useState<McpListResult | null>(null)
  const [liveStatuses, setLiveStatuses] = useState<Record<string, McpSessionStatusDto>>({})

  const refresh = useCallback(() => {
    const api = getMcpApi()
    if (!api) return
    void api.list()
      .then((result) => {
        setList(result)
        setLiveStatuses(Object.fromEntries(result.statuses.map((entry) => [entry.sessionId, entry])))
      })
      // The picker degrades to "no servers"; the composer must not break here.
      .catch(() => setList(null))
  }, [])

  useEffect(() => {
    if (active) refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!active) return
    const api = getMcpApi()
    if (!api?.onStatus) return
    return api.onStatus((payload) => {
      setLiveStatuses((current) => ({ ...current, [payload.sessionId]: payload }))
    })
  }, [active])

  // A `mcp:changed` broadcast means servers were added, removed or toggled.
  useEffect(() => {
    if (!active) return
    const api = getMcpApi()
    if (!api) return
    return api.onChanged(refresh)
  }, [active, refresh])

  const servers = useMemo(() => {
    const displays = mergeServerDisplays(Object.values(liveStatuses), list?.lastKnown ?? [])
    return (list?.servers ?? [])
      .filter((server) => server.enabled)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((server) => ({ name: server.name, display: displays.get(server.name) }))
  }, [list, liveStatuses])

  return { servers, refresh }
}
