/**
 * ImageMediaAdapter — a generated picture, as a tile in the message.
 *
 * The tile shows a host-resized thumbnail, never the original: a turn that
 * produced four 4K renders would otherwise pull sixteen megapixels into the
 * message list for four 160px squares. The full image is read only when the
 * user opens the preview overlay.
 *
 * A thumbnail the host cannot produce degrades to a file icon rather than an
 * empty box — the picture still exists and still opens.
 */

import { useTranslation } from 'react-i18next'
import { ImageIcon } from 'lucide-react'
import type { MessageMedia } from '@bitlab/shared/protocol'
import { cn } from '../../../lib/utils'
import { useMediaThumbnail } from './MediaSourceLoader'

export interface ImageMediaAdapterProps {
  media: MessageMedia
  onOpen: (path: string) => void
  className?: string
}

export function ImageMediaAdapter({ media, onOpen, className }: ImageMediaAdapterProps) {
  const { t } = useTranslation()
  const thumbnail = useMediaThumbnail(media.artifactPath, media.metadata)

  const { width, height } = media.metadata
  const dimensions = width && height ? `${width}×${height}` : null

  return (
    <button
      type="button"
      data-testid="media-image-card"
      onClick={() => onOpen(media.artifactPath)}
      title={media.name}
      className={cn(
        'group relative flex aspect-square min-w-0 items-center justify-center overflow-hidden',
        'rounded-lg border border-border/60 bg-foreground/[0.03]',
        'transition-colors hover:border-border focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        className,
      )}
    >
      {thumbnail
        ? (
          <img
            src={thumbnail}
            alt={media.name}
            className="size-full object-cover"
            draggable={false}
          />
        )
        : <ImageIcon className="size-5 text-muted-foreground" aria-label={t('media.imageLabel')} />}

      {/* Name and size ride on a scrim so they stay readable over any picture. */}
      <span
        className={cn(
          'absolute inset-x-0 bottom-0 flex flex-col items-start gap-0.5 px-1.5 py-1 text-left text-[10px] leading-tight',
          'bg-gradient-to-t from-black/70 to-transparent text-white opacity-0 transition-opacity',
          'group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      >
        <span className="w-full truncate">{media.name}</span>
        {dimensions && <span className="text-white/75">{dimensions}</span>}
      </span>
    </button>
  )
}
