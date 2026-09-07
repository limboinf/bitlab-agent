/**
 * MediaSourceLoader — the one place media bytes are asked for.
 *
 * Every card needs the same three things and would otherwise each invent them:
 * a bounded thumbnail, a streamable URL, and a way to stop caring when the card
 * goes away mid-request. Centralising it also gives the guarantees the design
 * asks for almost for free:
 *
 *   - one request per path, shared by every card showing that path;
 *   - a reply that lost the race is dropped, never rendered;
 *   - a failed thumbnail degrades to an icon instead of retrying forever.
 *
 * The cache key includes the probed byte size, so a file regenerated at the
 * same path gets a fresh thumbnail rather than the previous run's.
 */

import { useEffect, useState } from 'react'
import type { MediaMetadata } from '@bitlab/shared/protocol'
import { usePlatform } from '../../../context/PlatformContext'

/** Longest edge of a thumbnail in the message list. */
export const MEDIA_THUMBNAIL_MAX_EDGE = 256

type ThumbnailResult = { url: string } | { failed: true }

const thumbnailCache = new Map<string, ThumbnailResult>()
const inFlight = new Map<string, Promise<ThumbnailResult>>()

function cacheKey(path: string, metadata?: MediaMetadata): string {
  return `${path}|${metadata?.byteSize ?? ''}`
}

/** Drop every cached thumbnail. Tests use it; nothing else needs to. */
export function clearMediaThumbnailCache(): void {
  thumbnailCache.clear()
  inFlight.clear()
}

/**
 * A bounded thumbnail data URL for one image path.
 *
 * Returns null while loading and after a failure — the caller shows a file-type
 * icon in both cases, which is the documented fallback.
 */
export function useMediaThumbnail(
  path: string | null,
  metadata?: MediaMetadata,
  enabled = true,
): string | null {
  const { onReadFilePreviewDataUrl } = usePlatform()
  const key = path ? cacheKey(path, metadata) : ''
  const [url, setUrl] = useState<string | null>(() => {
    const cached = key ? thumbnailCache.get(key) : undefined
    return cached && 'url' in cached ? cached.url : null
  })

  useEffect(() => {
    if (!path || !enabled || !onReadFilePreviewDataUrl) {
      setUrl(null)
      return
    }

    const cached = thumbnailCache.get(key)
    if (cached) {
      setUrl('url' in cached ? cached.url : null)
      return
    }

    let cancelled = false
    const pending = inFlight.get(key) ?? onReadFilePreviewDataUrl(path, MEDIA_THUMBNAIL_MAX_EDGE)
      .then<ThumbnailResult>(dataUrl => ({ url: dataUrl }))
      .catch<ThumbnailResult>(() => ({ failed: true }))
      .then((result) => {
        thumbnailCache.set(key, result)
        inFlight.delete(key)
        return result
      })
    inFlight.set(key, pending)

    void pending.then((result) => {
      if (!cancelled) setUrl('url' in result ? result.url : null)
    })

    return () => { cancelled = true }
  }, [path, key, enabled, onReadFilePreviewDataUrl])

  return url
}

/**
 * The URL a media element can stream this file from, or null when the host
 * cannot serve one.
 *
 * Null is the honest answer, not a bug: a WebUI has no local file to stream,
 * and the card offers the system application instead of a dead player.
 */
export function useMediaSourceUrl(path: string | null): string | null {
  const { getMediaSourceUrl } = usePlatform()
  if (!path || !getMediaSourceUrl) return null
  return getMediaSourceUrl(path)
}
