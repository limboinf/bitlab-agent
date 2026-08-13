/**
 * HTML Preview Protocol Handler
 *
 * Serves local files to the in-app HTML preview iframe over a custom
 * `html-preview://` scheme.
 *
 * Why not `srcDoc`: an iframe filled via srcDoc inherits the embedder's CSP.
 * The renderer runs under `script-src 'self' 'unsafe-inline'`, so a page loading
 * p5.js from cdnjs, a Google font, or any other third-party asset silently got
 * blocked. Loading the page from a real URL gives it its own document with no
 * inherited CSP, so external sources work — and relative paths (./style.css,
 * sibling images) resolve against the file's own directory instead of breaking.
 *
 * URL format: html-preview://local/<absolute path, one URL segment per part>
 *   macOS/Linux: html-preview://local/Users/me/page/index.html
 *   Windows:     html-preview://local/C:/Users/me/page/index.html
 *
 * The path stays hierarchical (rather than percent-encoded whole) precisely so
 * the browser can resolve relative references inside the page.
 *
 * Scope: read-only, and only the static asset types a page loads. There is no
 * directory allowlist yet — any readable file with a served extension is
 * reachable from a preview. The iframe's sandbox (no allow-same-origin) keeps
 * the page out of the app's own origin, but a page can still fetch what this
 * scheme serves, so a workspace-rooted allowlist is the obvious next tightening.
 */

import { protocol } from 'electron'
import { readFile, stat } from 'fs/promises'
import { isAbsolute } from 'path'
import { HTML_PREVIEW_SCHEME, htmlPreviewPathnameToFilePath } from '../shared/html-preview-url'
import { mainLog } from './logger'

/** Content types for the static assets a previewed page may pull in. */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['htm', 'text/html; charset=utf-8'],
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['mjs', 'text/javascript; charset=utf-8'],
  ['json', 'application/json; charset=utf-8'],
  ['svg', 'image/svg+xml'],
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
  ['ico', 'image/x-icon'],
  ['bmp', 'image/bmp'],
  ['woff', 'font/woff'],
  ['woff2', 'font/woff2'],
  ['ttf', 'font/ttf'],
  ['otf', 'font/otf'],
  ['eot', 'application/vnd.ms-fontobject'],
  ['mp4', 'video/mp4'],
  ['webm', 'video/webm'],
  ['mp3', 'audio/mpeg'],
  ['wav', 'audio/wav'],
  ['txt', 'text/plain; charset=utf-8'],
  ['csv', 'text/csv; charset=utf-8'],
  ['md', 'text/markdown; charset=utf-8'],
  ['wasm', 'application/wasm'],
])

/**
 * Privileged scheme description for html-preview://.
 *
 * Registered by the caller alongside every other custom scheme —
 * `protocol.registerSchemesAsPrivileged` replaces the whole registry on each
 * call, so all schemes must go in one call before app.whenReady().
 */
export const HTML_PREVIEW_PRIVILEGED_SCHEME: Electron.CustomScheme = {
  scheme: HTML_PREVIEW_SCHEME,
  privileges: {
    // Standard scheme so relative URLs inside the page resolve correctly
    standard: true,
    // The previewed page may fetch() its own sibling assets
    supportFetchAPI: true,
    // Treated as a secure context, so modules/workers behave as on https
    secure: true,
    stream: true,
  },
}

/** Register the html-preview:// request handler. Call after app.whenReady(). */
export function registerHtmlPreviewHandler(): void {
  protocol.handle(HTML_PREVIEW_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      const filePath = htmlPreviewPathnameToFilePath(url.pathname)

      if (!filePath || !isAbsolute(filePath)) {
        return new Response(null, { status: 400 })
      }

      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
      const contentType = CONTENT_TYPES.get(ext)
      if (!contentType) {
        return new Response(null, { status: 404 })
      }

      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) {
        return new Response(null, { status: 404 })
      }

      const data = await readFile(filePath)
      return new Response(new Uint8Array(data), {
        headers: {
          'Content-Type': contentType,
          // Always re-read: the agent may rewrite the file between previews
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      mainLog.error('HTML preview protocol error:', error)
      return new Response(null, { status: 500 })
    }
  })

  mainLog.info('Registered html-preview:// protocol handler')
}
