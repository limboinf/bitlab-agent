/**
 * Shared URL shape for the html-preview:// scheme.
 *
 * The renderer builds these URLs for the preview iframe; the main process
 * resolves them back to file paths (see main/html-preview-protocol.ts).
 */

export const HTML_PREVIEW_SCHEME = 'html-preview'

/**
 * Build the preview URL for an absolute file path.
 *
 * Each path segment is encoded individually so the URL stays hierarchical —
 * that is what lets relative references inside the page (./style.css, sibling
 * images) resolve against the file's own directory.
 *
 *   macOS/Linux: /Users/me/page/index.html → html-preview://local/Users/me/page/index.html
 *   Windows:     C:\me\page\index.html     → html-preview://local/C:/me/page/index.html
 */
export function buildHtmlPreviewUrl(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean).map(encodeURIComponent)
  return `${HTML_PREVIEW_SCHEME}://local/${segments.join('/')}`
}

/** Recover the absolute file path from a preview URL's pathname. */
export function htmlPreviewPathnameToFilePath(pathname: string): string {
  const decoded = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (decoded.length === 0) return ''
  // Windows paths start with a drive letter segment ("C:"); POSIX paths need the
  // leading slash restored.
  const isWindowsDrive = /^[a-zA-Z]:$/.test(decoded[0] ?? '')
  return isWindowsDrive ? decoded.join('/') : `/${decoded.join('/')}`
}
