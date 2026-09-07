/**
 * VideoMediaAdapter — a generated clip, as a poster in the message.
 *
 * The message list never loads a video. It shows a poster frame (persisted
 * beside the file when the producer made one, a plain icon otherwise) and only
 * mounts a `<video>` after the user presses play. That single rule is what keeps
 * a turn with three clips from pulling a hundred megabytes into a scroll view.
 *
 * Playback is muted and never automatic: a video that starts talking because a
 * message scrolled into view is a bug in every product that has ever shipped it.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Play, Video } from 'lucide-react'
import type { MessageMedia } from '@bitlab/shared/protocol'
import { cn } from '../../../lib/utils'
import { MediaFallbackCard } from './MediaFallbackCard'
import { useMediaSourceUrl, useMediaThumbnail } from './MediaSourceLoader'

export interface VideoMediaAdapterProps {
  media: MessageMedia
  /** Opens the full preview. Undefined hides the expand affordance. */
  onOpen?: (path: string) => void
  className?: string
}

export function VideoMediaAdapter({ media, onOpen, className }: VideoMediaAdapterProps) {
  const { t } = useTranslation()
  const [isPlaying, setIsPlaying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)

  const sourceUrl = useMediaSourceUrl(media.artifactPath)
  const poster = useMediaThumbnail(media.metadata.posterPath ?? null, media.metadata)

  // Leaving the message — a session switch, a collapsed turn — stops playback.
  useEffect(() => () => { videoRef.current?.pause() }, [])

  // No streamable URL means this host cannot play local media at all. Say so
  // instead of rendering a player that would sit at zero forever.
  if (!sourceUrl) {
    return (
      <MediaFallbackCard
        media={{ ...media, status: 'unsupported', errorCode: 'codec_unsupported' }}
        reason={t('media.playbackUnavailable')}
        className={className}
      />
    )
  }

  if (error) {
    return (
      <MediaFallbackCard
        media={{ ...media, status: 'error', errorCode: 'read_failed' }}
        reason={error}
        className={className}
      />
    )
  }

  return (
    <div
      data-testid="media-video-card"
      className={cn(
        'relative overflow-hidden rounded-lg border border-border/60 bg-foreground/[0.03]',
        className,
      )}
    >
      {isPlaying
        ? (
          <video
            ref={videoRef}
            data-testid="media-video-element"
            src={sourceUrl}
            {...(poster ? { poster } : {})}
            controls
            muted
            playsInline
            preload="metadata"
            className="aspect-video w-full bg-black object-contain"
            onError={() => setError(t('media.playbackFailed'))}
          />
        )
        : (
          <button
            type="button"
            onClick={() => setIsPlaying(true)}
            title={media.name}
            className="group relative flex aspect-video w-full items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {poster
              ? <img src={poster} alt={media.name} className="size-full object-cover" draggable={false} />
              : <Video className="size-6 text-muted-foreground" />}
            <span className="absolute inset-0 flex items-center justify-center bg-black/20 transition-colors group-hover:bg-black/30">
              <span className="flex size-9 items-center justify-center rounded-full bg-black/60 text-white">
                <Play className="size-4 translate-x-[1px]" fill="currentColor" />
              </span>
            </span>
          </button>
        )}

      <div className="flex items-center gap-2 px-2.5 py-1.5 text-[11px]">
        <span className="min-w-0 flex-1 truncate text-foreground/80" title={media.name}>{media.name}</span>
        {onOpen && (
          <button
            type="button"
            onClick={() => onOpen(media.artifactPath)}
            title={t('media.openPreview')}
            className="shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <Maximize2 className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}
