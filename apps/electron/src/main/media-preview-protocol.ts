/**
 * Media Preview Protocol Handler
 *
 * Serves local media files to in-message `<video>`, `<audio>` and `<img>`
 * elements over a custom `media-preview://` scheme.
 *
 * Why not a data URL: generated media runs to tens of megabytes. A data URL
 * would move every one of those bytes through the RPC channel and hold them in
 * the document, for a card the user may never press play on. A URL lets the
 * media element fetch what it needs, when it needs it — and lets it seek, which
 * needs byte ranges the RPC channel has no way to express.
 *
 * Why not `file://`: that hands the renderer the whole filesystem. This scheme
 * serves media extensions only, and only from paths that pass the same
 * allowed-root and sensitive-file checks as every other file read in the app.
 *
 * URL format: media-preview://local/<absolute path, one URL segment per part>
 */

import { protocol } from 'electron'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { Readable } from 'stream'
import { mediaTypeForPath, mimeTypeForPath } from '@bitlab/shared/protocol'
import { validateFilePath } from '@bitlab/server-core/handlers'
import { MEDIA_PREVIEW_SCHEME, mediaPreviewPathnameToFilePath } from '../shared/media-preview-url'
import { parseByteRange } from './media-preview-utils'
import { mainLog } from './logger'

/**
 * Privileged scheme description for media-preview://.
 *
 * Registered by the caller alongside every other custom scheme —
 * `protocol.registerSchemesAsPrivileged` replaces the whole registry on each
 * call, so all schemes must go in one call before app.whenReady().
 */
export const MEDIA_PREVIEW_PRIVILEGED_SCHEME: Electron.CustomScheme = {
  scheme: MEDIA_PREVIEW_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    // Media elements issue ranged requests; without stream support Chromium
    // buffers the whole response before it will play or seek.
    stream: true,
    supportFetchAPI: true,
    corsEnabled: true,
  },
}

/** Register the media-preview:// request handler. Call after app.whenReady(). */
export function registerMediaPreviewHandler(): void {
  protocol.handle(MEDIA_PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const requestedPath = mediaPreviewPathnameToFilePath(url.pathname)

      if (!requestedPath || !isAbsolute(requestedPath)) {
        return new Response(null, { status: 400 })
      }

      // Only media, and only the formats a renderer can decode. Everything
      // else belongs to the system application, not to this scheme.
      if (!mediaTypeForPath(requestedPath)) {
        return new Response(null, { status: 404 })
      }
      const contentType = mimeTypeForPath(requestedPath)
      if (!contentType) {
        return new Response(null, { status: 404 })
      }

      // Same gate as every other file read: allowed roots, resolved symlinks,
      // sensitive-file denylist.
      let filePath: string
      try {
        filePath = await validateFilePath(requestedPath)
      } catch {
        return new Response(null, { status: 403 })
      }

      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) {
        return new Response(null, { status: 404 })
      }

      const size = fileStat.size
      const range = parseByteRange(request.headers.get('range'), size)

      const headers: Record<string, string> = {
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        // The agent may rewrite the file between plays.
        'Cache-Control': 'no-store',
      }

      if (range) {
        const stream = createReadStream(filePath, { start: range.start, end: range.end })
        return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
          status: 206,
          headers: {
            ...headers,
            'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
            'Content-Length': String(range.end - range.start + 1),
          },
        })
      }

      const stream = createReadStream(filePath)
      return new Response(Readable.toWeb(stream) as unknown as ReadableStream, {
        headers: { ...headers, 'Content-Length': String(size) },
      })
    } catch (error) {
      mainLog.error('Media preview protocol error:', error)
      return new Response(null, { status: 500 })
    }
  })

  mainLog.info('Registered media-preview:// protocol handler')
}
