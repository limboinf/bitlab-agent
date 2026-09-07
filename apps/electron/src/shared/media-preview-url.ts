/**
 * Shared URL shape for the media-preview:// scheme.
 *
 * The renderer mints these for `<video>` / `<audio>` / `<img>` sources; the main
 * process resolves them back to file paths and streams the bytes with range
 * support (see main/media-preview-protocol.ts).
 *
 * Why a scheme rather than a data URL: a video is tens of megabytes, and a data
 * URL would push all of it through the RPC channel and into the document before
 * the first frame plays. A URL lets the media element ask for the bytes it
 * needs, when it needs them.
 */

export const MEDIA_PREVIEW_SCHEME = 'media-preview'

/**
 * Build the media URL for an absolute file path.
 *
 *   macOS/Linux: /Users/me/data/clip.mp4 → media-preview://local/Users/me/data/clip.mp4
 *   Windows:     C:\\me\\data\\clip.mp4    → media-preview://local/C:/me/data/clip.mp4
 */
export function buildMediaPreviewUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean).map(encodeURIComponent)
  return `${MEDIA_PREVIEW_SCHEME}://local/${segments.join('/')}`
}

/** Recover the absolute file path from a media URL's pathname. */
export function mediaPreviewPathnameToFilePath(pathname: string): string {
  const decoded = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (decoded.length === 0) return ''
  const isWindowsDrive = /^[a-zA-Z]:$/.test(decoded[0] ?? '')
  return isWindowsDrive ? decoded.join('/') : `/${decoded.join('/')}`
}
