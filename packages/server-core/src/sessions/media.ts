/**
 * Media probing for artifacts.
 *
 * Answers two questions about a file the agent produced, cheaply enough to run
 * over every media artifact each time the snapshot is rebuilt:
 *
 *   1. What is it really? The extension is a hint; the leading bytes are the
 *      answer. A `.png` holding HTML must not become an image card.
 *   2. How big is the picture? Read from the container header, not by decoding —
 *      the snapshot must not pull megapixels through an image processor.
 *
 * Duration is deliberately absent. Getting it means parsing every container we
 * accept, while the media element reports the real value the moment it loads
 * metadata. Guessing it from the file size would be a lie with a number on it.
 *
 * Results are cached on path + mtime + size, so a session with a hundred media
 * files probes each one once and re-reads only what actually changed.
 */

import { open, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import {
  mediaExtension,
  mediaTypeForPath,
  mimeTypeForPath,
  type GeneratedMediaType,
  type MediaMetadata,
} from '@bitlab/shared/protocol'

/** Enough for every header this module parses, and for the sniffing table. */
const HEADER_BYTES = 64

/** Poster frames written next to the media, per the session media layout. */
const POSTER_BASENAMES = ['poster.jpg', 'poster.jpeg', 'poster.png', 'poster.webp']

interface CacheEntry {
  key: string
  metadata: MediaMetadata
}

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRIES = 500

function remember(path: string, key: string, metadata: MediaMetadata): MediaMetadata {
  cache.delete(path)
  cache.set(path, { key, metadata })
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return metadata
}

/** Drop everything probed so far. Tests use it; nothing else needs to. */
export function clearMediaProbeCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// Sniffing
// ---------------------------------------------------------------------------

function startsWith(header: Buffer, bytes: number[], offset = 0): boolean {
  if (header.length < offset + bytes.length) return false
  return bytes.every((byte, index) => header[offset + index] === byte)
}

function ascii(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString('latin1')
}

/**
 * MIME type from the leading bytes, or null when the bytes say nothing.
 *
 * Only the containers we are willing to show inline are listed — an unknown
 * signature falls back to the extension, and a mismatch with the extension is
 * resolved in favour of the bytes.
 */
export function sniffMediaMimeType(header: Buffer): string | null {
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(header, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(header, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'
  if (startsWith(header, [0x42, 0x4d])) return 'image/bmp'
  if (ascii(header, 0, 4) === 'RIFF') {
    const form = ascii(header, 8, 4)
    if (form === 'WEBP') return 'image/webp'
    if (form === 'WAVE') return 'audio/wav'
    if (form === 'AVI ') return 'video/x-msvideo'
  }
  if (ascii(header, 4, 4) === 'ftyp') {
    const brand = ascii(header, 8, 4)
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif'
    if (brand.startsWith('heic') || brand.startsWith('heix') || brand.startsWith('mif1')) return 'image/heic'
    if (brand.startsWith('qt')) return 'video/quicktime'
    if (brand.startsWith('M4A')) return 'audio/mp4'
    return 'video/mp4'
  }
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm'
  if (ascii(header, 0, 4) === 'OggS') return 'audio/ogg'
  if (ascii(header, 0, 4) === 'fLaC') return 'audio/flac'
  if (ascii(header, 0, 3) === 'ID3' || startsWith(header, [0xff, 0xfb]) || startsWith(header, [0xff, 0xf3])) {
    return 'audio/mpeg'
  }
  if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
  return null
}

/**
 * Does this look like text rather than a container?
 *
 * The sniff table cannot know every valid media signature, so unknown bytes
 * fall back to the extension — except when they are plainly text. That is the
 * case worth catching: an error page, a JSON body or a log line saved under a
 * `.png` must not become a picture card that can only ever fail to load.
 */
function looksLikeText(header: Buffer): boolean {
  if (header.length === 0) return false
  for (const byte of header) {
    // NUL and most other C0 controls do not appear in text; tab, LF, CR do.
    if (byte === 0) return false
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * Pixel dimensions from an image header.
 *
 * PNG, GIF, BMP and the two WebP layouts we can read carry them in fixed
 * positions. JPEG needs a walk over its segments, so it gets its own pass over
 * a larger prefix. SVG has no intrinsic pixel size worth reporting and AVIF
 * hides it inside an ISO-BMFF box tree — both simply return nothing, and the
 * card lays out from the loaded element instead.
 */
function readImageSize(header: Buffer): { width: number; height: number } | undefined {
  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47]) && header.length >= 24) {
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
  }
  if (startsWith(header, [0x47, 0x49, 0x46, 0x38]) && header.length >= 10) {
    return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) }
  }
  if (startsWith(header, [0x42, 0x4d]) && header.length >= 26) {
    return { width: header.readInt32LE(18), height: Math.abs(header.readInt32LE(22)) }
  }
  if (ascii(header, 0, 4) === 'RIFF' && ascii(header, 8, 4) === 'WEBP' && header.length >= 30) {
    const chunk = ascii(header, 12, 4)
    // Lossy: 14-bit width/height after the 3-byte start code and "VP8 " keyframe header.
    if (chunk === 'VP8 ') {
      return { width: header.readUInt16LE(26) & 0x3fff, height: header.readUInt16LE(28) & 0x3fff }
    }
    // Extended: 24-bit canvas size minus one, little-endian, at offset 24.
    if (chunk === 'VP8X' && header.length >= 30) {
      const width = 1 + (header[24]! | (header[25]! << 8) | (header[26]! << 16))
      const height = 1 + (header[27]! | (header[28]! << 8) | (header[29]! << 16))
      return { width, height }
    }
  }
  return undefined
}

/** JPEG carries its size in a start-of-frame marker; find the first one. */
function readJpegSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (!startsWith(buffer, [0xff, 0xd8, 0xff])) return undefined

  let offset = 2
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue }
    const marker = buffer[offset + 1]!
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
    const length = buffer.readUInt16BE(offset + 2)
    // SOF0..SOF15, minus the two that are not frame headers (DHT 0xc4, DAC 0xcc).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) }
    }
    if (length < 2) return undefined
    offset += 2 + length
  }
  return undefined
}

/** How much of the file the size pass needs. JPEG segments can run long. */
const IMAGE_SCAN_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

async function findPosterPath(mediaPath: string): Promise<string | undefined> {
  const dir = nodePath.dirname(mediaPath)
  for (const basename of POSTER_BASENAMES) {
    const candidate = nodePath.join(dir, basename)
    if (candidate === mediaPath) continue
    try {
      const stats = await stat(candidate)
      if (stats.isFile()) return candidate
    } catch {
      // No poster by that name; try the next.
    }
  }
  return undefined
}

export interface ProbeOptions {
  /** Pre-fetched stat results, when the caller already has them. */
  byteSize?: number
  modifiedAt?: number
  /** Look for a sibling poster frame. Off for the poster files themselves. */
  withPoster?: boolean
}

/**
 * Probe one media file.
 *
 * Returns null when the path is not media, when the file is gone, or when the
 * bytes contradict the extension badly enough that showing a player would be
 * wrong (a `.mp4` that is really a PNG is not a video).
 */
export async function probeMediaMetadata(
  absolutePath: string,
  options: ProbeOptions = {},
): Promise<MediaMetadata | null> {
  const declaredType = mediaTypeForPath(absolutePath)
  if (!declaredType) return null

  let byteSize = options.byteSize
  let modifiedAt = options.modifiedAt
  if (byteSize === undefined || modifiedAt === undefined) {
    try {
      const stats = await stat(absolutePath)
      if (!stats.isFile()) return null
      byteSize = stats.size
      modifiedAt = stats.mtimeMs
    } catch {
      return null
    }
  }

  const cacheKey = `${modifiedAt}:${byteSize}`
  const cached = cache.get(absolutePath)
  if (cached?.key === cacheKey) return cached.metadata

  const extension = mediaExtension(absolutePath)
  const isImage = declaredType === 'image'
  // SVG is text; sniffing it as a binary container tells us nothing useful.
  const wantsBytes = extension !== 'svg' && byteSize > 0

  let header = Buffer.alloc(0)
  let scan = Buffer.alloc(0)
  if (wantsBytes) {
    try {
      const handle = await open(absolutePath, 'r')
      try {
        const length = isImage ? Math.min(IMAGE_SCAN_BYTES, byteSize) : Math.min(HEADER_BYTES, byteSize)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, 0)
        scan = buffer.subarray(0, bytesRead)
        header = scan.subarray(0, Math.min(HEADER_BYTES, bytesRead))
      } finally {
        await handle.close()
      }
    } catch {
      return null
    }
  }

  const sniffed = wantsBytes ? sniffMediaMimeType(header) : null
  // Bytes win over the extension, but only within the same media family: a
  // `.mov` that sniffs as `video/mp4` is still the video the card promised,
  // while a `.png` that sniffs as `video/webm` is not an image at all.
  const declaredMime = mimeTypeForPath(absolutePath) ?? `${declaredType}/octet-stream`
  const sniffedFamily = sniffed?.split('/')[0]
  if (sniffed && sniffedFamily !== declaredType && !(sniffedFamily === 'audio' && declaredType === 'video')) {
    return null
  }
  if (!sniffed && looksLikeText(header)) return null
  const mimeType = sniffed ?? declaredMime

  const size = isImage ? (readImageSize(header) ?? readJpegSize(scan)) : undefined
  const posterPath = options.withPoster === false ? undefined : await findPosterPath(absolutePath)

  const metadata: MediaMetadata = {
    mimeType,
    byteSize,
    ...(size ? { width: size.width, height: size.height } : {}),
    ...(posterPath ? { posterPath } : {}),
  }

  return remember(absolutePath, cacheKey, metadata)
}

/** The media type a probed artifact belongs to, from its probed MIME. */
export function mediaTypeForMimeType(mimeType: string): GeneratedMediaType | null {
  const family = mimeType.split('/')[0]
  return family === 'image' || family === 'video' || family === 'audio' ? family : null
}
