/**
 * MessageMediaPreview — the media one finished turn produced, in the message.
 *
 * Sits where the produced-files row sits, and for the same reason: the agent
 * says what it made, and right there is the thing it made. The difference is
 * that a picture, a clip and a sound are worth showing rather than naming, so
 * media gets a container of its own and the remaining files keep the chip row.
 *
 * This is the only component that knows how media is loaded. TurnCard, the
 * dock and the file tree hand it a list and a way to open a path; they do not
 * each grow an `<img>`, a `<video>` and an `<audio>` of their own. Inside, one
 * adapter per type — because a video player that also has to be an image grid
 * is how you end up with an audio file that opens a lightbox.
 *
 * Deliberately bounded: four cards on first screen, the rest behind a count. A
 * message is not a gallery, and the dock is built for browsing.
 */

import { useTranslation } from 'react-i18next'
import type { MessageMedia } from '@bitlab/shared/protocol'
import { cn } from '../../lib/utils'
import { ImageMediaAdapter } from './media/ImageMediaAdapter'
import { VideoMediaAdapter } from './media/VideoMediaAdapter'
import { AudioMediaAdapter } from './media/AudioMediaAdapter'
import { MediaFallbackCard } from './media/MediaFallbackCard'

/** Cards shown before the overflow count takes over. */
export const MAX_MEDIA_TILES = 4

export interface MessageMediaPreviewProps {
  media: MessageMedia[]
  /** Tighter layout for narrow panels. */
  compact?: boolean
  /** Opens one media file through the app's single file-preview entry point. */
  onOpenArtifact: (path: string) => void
  /** Opens the artifacts panel. Omitted when there is nowhere to send the user. */
  onViewAll?: () => void
  className?: string
}

/** Split by what the card has to be, not by what the file is called. */
function partition(media: MessageMedia[]) {
  const images: MessageMedia[] = []
  const videos: MessageMedia[] = []
  const audios: MessageMedia[] = []
  const fallbacks: MessageMedia[] = []

  for (const item of media) {
    // Anything not ready shows its reason, whatever type it would have been.
    if (item.status !== 'ready') { fallbacks.push(item); continue }
    if (item.mediaType === 'image') images.push(item)
    else if (item.mediaType === 'video') videos.push(item)
    else audios.push(item)
  }

  return { images, videos, audios, fallbacks }
}

export function MessageMediaPreview({
  media,
  compact = false,
  onOpenArtifact,
  onViewAll,
  className,
}: MessageMediaPreviewProps) {
  const { t } = useTranslation()

  if (media.length === 0) return null

  // The cap is on cards, not on any one type: four pictures and four clips in
  // one message is eight things to load, whatever the mix.
  const visible = media.slice(0, MAX_MEDIA_TILES)
  const overflow = media.length - visible.length
  const { images, videos, audios, fallbacks } = partition(visible)

  return (
    <div
      data-testid="message-media-preview"
      className={cn('mt-2 flex min-w-0 flex-col gap-2', className)}
    >
      {images.length > 0 && (
        <div className={cn('grid gap-1.5', compact ? 'grid-cols-3' : 'grid-cols-4')}>
          {images.map(item => (
            <ImageMediaAdapter key={item.id} media={item} onOpen={onOpenArtifact} />
          ))}
        </div>
      )}

      {videos.map(item => (
        <VideoMediaAdapter key={item.id} media={item} onOpen={onOpenArtifact} />
      ))}

      {audios.map(item => (
        <AudioMediaAdapter key={item.id} media={item} />
      ))}

      {fallbacks.map(item => (
        <MediaFallbackCard key={item.id} media={item} />
      ))}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0 select-none">{t('media.count', { count: media.length })}</span>
        {overflow > 0 && (
          <span className="shrink-0 select-none">{t('media.more', { count: overflow })}</span>
        )}
        {onViewAll && (
          <button
            type="button"
            onClick={onViewAll}
            className="ml-auto shrink-0 transition-colors hover:text-foreground focus:outline-none focus-visible:underline"
          >
            {t('artifacts.viewAll')}
          </button>
        )}
      </div>
    </div>
  )
}
