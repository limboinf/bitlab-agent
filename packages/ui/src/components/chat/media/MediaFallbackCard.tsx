/**
 * The card a media file gets when it cannot be shown.
 *
 * Four reasons, four sentences, one shared shell — because "preview failed" for
 * everything is what makes a broken card unactionable. A file this host has no
 * codec for still opens in the system application, and the card says so; a file
 * that is gone offers nothing, because there is nothing to offer.
 */

import { useTranslation } from 'react-i18next'
import { AlertTriangle, ExternalLink, FileQuestion, FileX, Loader2 } from 'lucide-react'
import type { MessageMedia } from '@bitlab/shared/protocol'
import { cn } from '../../../lib/utils'
import { usePlatform } from '../../../context/PlatformContext'

export interface MediaFallbackCardProps {
  media: MessageMedia
  /** Reason text overriding the status default — a player's own load error. */
  reason?: string
  className?: string
}

const STATUS_ICON = {
  generating: Loader2,
  missing: FileX,
  unsupported: FileQuestion,
  error: AlertTriangle,
  ready: AlertTriangle,
} as const

export function MediaFallbackCard({ media, reason, className }: MediaFallbackCardProps) {
  const { t } = useTranslation()
  const { onOpenFileExternal } = usePlatform()

  const Icon = STATUS_ICON[media.status]
  const message = reason ?? {
    generating: t('media.generating'),
    missing: t('artifacts.missing'),
    unsupported: t('media.unsupported'),
    error: t('media.loadFailed'),
    ready: t('media.loadFailed'),
  }[media.status]

  // Nothing to open when the file is gone; everything else is still a real file
  // on disk that some application can handle.
  const canOpenExternally = media.status !== 'missing' && media.status !== 'generating' && !!onOpenFileExternal

  return (
    <div
      data-testid="media-fallback-card"
      data-status={media.status}
      className={cn(
        'flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-foreground/[0.02] px-2.5 py-2 text-[11px]',
        className,
      )}
    >
      <Icon className={cn('size-4 shrink-0 text-muted-foreground', media.status === 'generating' && 'animate-spin')} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-foreground/80" title={media.name}>{media.name}</div>
        <div className="truncate text-muted-foreground">{message}</div>
      </div>
      {canOpenExternally && (
        <button
          type="button"
          onClick={() => onOpenFileExternal?.(media.artifactPath)}
          className={cn(
            'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground',
            'transition-colors hover:bg-foreground/10 hover:text-foreground',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
        >
          <ExternalLink className="size-3" />
          {t('media.openExternally')}
        </button>
      )}
    </div>
  )
}
