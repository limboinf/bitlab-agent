/**
 * AudioMediaAdapter — a generated sound, as a card in the message.
 *
 * Native `<audio controls>` on purpose. A hand-built transport would need
 * scrubbing, buffering states and keyboard handling to reach parity with what
 * the browser already ships, and the design explicitly rules out the one thing
 * a custom player would buy us — a decorative waveform nobody sampled.
 *
 * `preload="metadata"` fetches the header, which is what makes the duration
 * appear without downloading the audio. Starting a card pauses whichever card
 * was playing (see audio-playback.ts).
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioLines } from 'lucide-react'
import type { MessageMedia } from '@bitlab/shared/protocol'
import { cn } from '../../../lib/utils'
import { MediaFallbackCard } from './MediaFallbackCard'
import { useMediaSourceUrl } from './MediaSourceLoader'
import { claimAudioPlayback, releaseAudioPlayback } from './audio-playback'

export interface AudioMediaAdapterProps {
  media: MessageMedia
  className?: string
}

/** mm:ss, or h:mm:ss past the hour. */
export function formatMediaDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`
}

export function AudioMediaAdapter({ media, className }: AudioMediaAdapterProps) {
  const { t } = useTranslation()
  const audioRef = useRef<HTMLAudioElement>(null)
  const sourceUrl = useMediaSourceUrl(media.artifactPath)

  // The probe does not decode containers, so duration arrives from the element
  // itself once it has read the header. Server-side metadata wins when present.
  const [duration, setDuration] = useState<number | null>(
    media.metadata.durationMs ? media.metadata.durationMs / 1000 : null,
  )
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = audioRef.current
    return () => {
      if (!element) return
      element.pause()
      releaseAudioPlayback(element)
    }
  }, [sourceUrl])

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
      data-testid="media-audio-card"
      className={cn(
        'flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/60 bg-foreground/[0.02] px-2.5 py-2',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        <AudioLines className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground/80" title={media.name}>{media.name}</span>
        {duration !== null && (
          <span className="shrink-0 tabular-nums text-muted-foreground">{formatMediaDuration(duration)}</span>
        )}
      </div>

      <audio
        ref={audioRef}
        data-testid="media-audio-element"
        src={sourceUrl}
        controls
        preload="metadata"
        className="h-8 w-full"
        onPlay={(event) => claimAudioPlayback(event.currentTarget)}
        onPause={(event) => releaseAudioPlayback(event.currentTarget)}
        onEnded={(event) => releaseAudioPlayback(event.currentTarget)}
        onLoadedMetadata={(event) => {
          const value = event.currentTarget.duration
          if (Number.isFinite(value)) setDuration(value)
        }}
        onError={() => setError(t('media.playbackFailed'))}
      />
    </div>
  )
}
