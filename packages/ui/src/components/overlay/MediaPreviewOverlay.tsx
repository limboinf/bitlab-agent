/**
 * MediaPreviewOverlay — the large view for a video or a sound.
 *
 * Images already have one: ImagePreviewOverlay, with zoom, navigation and copy.
 * Time-based media needs none of that and needs one thing images do not — a
 * transport that keeps playing while the user reads the path — so it gets its
 * own overlay rather than a zoom control that would do nothing.
 *
 * The overlay does not read the file. It is handed a URL the host can stream
 * from, which is what makes seeking work; a host with no such URL never opens
 * this overlay, it sends the user to the system application instead.
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioLines, Video } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { claimAudioPlayback, releaseAudioPlayback } from '../chat/media/audio-playback'

export interface MediaPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  /** 'video' or 'audio'. Images go to ImagePreviewOverlay. */
  mediaType: 'video' | 'audio'
  /** Streamable URL for the file, or null when the host cannot serve one. */
  sourceUrl: string | null
  /** Poster frame data URL, when one exists. */
  poster?: string | null
  theme?: 'light' | 'dark'
}

export function MediaPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  mediaType,
  sourceUrl,
  poster,
  theme = 'light',
}: MediaPreviewOverlayProps) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement>(null)

  // Closing the overlay stops the sound. Nothing should keep playing behind a
  // dismissed dialog.
  useEffect(() => {
    if (isOpen) return
    const element = mediaRef.current
    if (!element) return
    element.pause()
    releaseAudioPlayback(element)
  }, [isOpen])

  useEffect(() => { setError(null) }, [filePath])

  const headerActions = (
    <CopyButton content={filePath} title={t('common.copyPath')} className="bg-background shadow-minimal" />
  )

  const unavailable = !sourceUrl ? t('media.playbackUnavailable') : null

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: mediaType === 'video' ? Video : AudioLines,
        label: mediaType === 'video' ? 'Video' : 'Audio',
        variant: 'purple',
      }}
      filePath={filePath}
      error={error || unavailable ? { label: 'Playback Failed', message: error ?? unavailable ?? '' } : undefined}
      headerActions={headerActions}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        {sourceUrl && mediaType === 'video' && (
          <video
            ref={mediaRef as React.RefObject<HTMLVideoElement>}
            data-testid="media-overlay-video"
            src={sourceUrl}
            {...(poster ? { poster } : {})}
            controls
            playsInline
            preload="metadata"
            className="max-h-full max-w-full rounded-sm bg-black"
            onError={() => setError(t('media.playbackFailed'))}
          />
        )}

        {sourceUrl && mediaType === 'audio' && (
          <audio
            ref={mediaRef as React.RefObject<HTMLAudioElement>}
            data-testid="media-overlay-audio"
            src={sourceUrl}
            controls
            preload="metadata"
            className="w-full max-w-xl"
            onPlay={(event) => claimAudioPlayback(event.currentTarget)}
            onPause={(event) => releaseAudioPlayback(event.currentTarget)}
            onEnded={(event) => releaseAudioPlayback(event.currentTarget)}
            onError={() => setError(t('media.playbackFailed'))}
          />
        )}
      </div>
    </PreviewOverlay>
  )
}
