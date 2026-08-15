import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Plug } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getMcpApi } from '@/lib/mcp-rpc'
import {
  mergeServerDisplays,
  transportSummary,
  type McpDisplayStatus,
} from '@/lib/mcp-derive'
import type { BitlabMcpServer } from '@bitlab/shared/config'

export interface McpListPanelProps {
  onSelectServer?: (server: BitlabMcpServer) => void
  onAddConnector?: () => void
  className?: string
}

export function McpListPanel({
  onSelectServer,
  onAddConnector,
  className,
}: McpListPanelProps) {
  const { t } = useTranslation()
  const [servers, setServers] = React.useState<BitlabMcpServer[]>([])
  const [statusByName, setStatusByName] = React.useState<Map<string, McpDisplayStatus>>(new Map())
  const [unavailable, setUnavailable] = React.useState(false)

  const refresh = React.useCallback(async () => {
    const api = getMcpApi()
    if (!api) {
      setUnavailable(true)
      setServers([])
      return
    }
    setUnavailable(false)
    try {
      const result = await api.list()
      setServers(result.servers)
      const displays = mergeServerDisplays(result.statuses, result.lastKnown ?? [])
      const next = new Map<string, McpDisplayStatus>()
      for (const [name, display] of displays) {
        next.set(name, display.status)
      }
      setStatusByName(next)
    } catch (error) {
      console.error('[McpListPanel] Failed to list servers:', error)
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const api = getMcpApi()
    if (!api) return
    return api.onChanged(() => {
      void refresh()
    })
  }, [refresh])

  if (unavailable) {
    return (
      <EntityListEmptyScreen
        icon={<Plug />}
        title={t('settings.mcp.error.unavailable')}
        description={t('mcpList.emptyDescription')}
        className={className}
      />
    )
  }

  if (servers.length === 0) {
    return (
      <EntityListEmptyScreen
        icon={<Plug />}
        title={t('mcpList.noConnectors')}
        description={t('mcpList.emptyDescription')}
        className={className}
      >
        {onAddConnector && (
          <button
            type="button"
            onClick={onAddConnector}
            className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-md bg-foreground/[0.04] hover:bg-foreground/[0.07] transition-colors"
          >
            {t('mcpList.addConnector')}
          </button>
        )}
      </EntityListEmptyScreen>
    )
  }

  const sorted = [...servers].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <ScrollArea className={cn('flex-1 min-h-0', className)}>
      <div className="flex flex-col py-1" role="listbox" aria-label={t('sidebar.connectors')}>
        {sorted.map((server) => {
          const status = !server.enabled
            ? 'disabled'
            : (statusByName.get(server.name) ?? 'unknown')
          return (
            <button
              key={server.id}
              type="button"
              role="option"
              onClick={() => onSelectServer?.(server)}
              className={cn(
                'mx-2 flex items-center gap-2 rounded-md px-2 py-[7px] text-left',
                'outline-none transition-colors hover:bg-foreground/[0.04]',
                'focus-visible:ring-1 focus-visible:ring-ring',
              )}
            >
              <StatusDot status={status} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/90">
                {server.name}
              </span>
              <span className="max-w-[40%] truncate text-[11px] text-muted-foreground">
                {transportSummary(server)}
              </span>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}

function StatusDot({ status }: { status: McpDisplayStatus | 'disabled' }) {
  const tone =
    status === 'connected' || status === 'cached'
      ? 'bg-success'
      : status === 'failed' || status === 'needs-auth'
        ? 'bg-destructive'
        : 'bg-foreground/25'

  return <span className={cn('size-1.5 shrink-0 rounded-full', tone)} aria-hidden="true" />
}
