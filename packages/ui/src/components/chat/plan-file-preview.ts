/**
 * Plan file preview helpers.
 *
 * A submitted plan message carries only the plan file path as its content
 * (see SessionManager: role 'plan', content = planPath). Rendering that path
 * as a bare link forces the user to open an overlay just to read the plan, so
 * the chat message resolves the file and renders the markdown inline instead.
 *
 * Falls back to the plain path whenever the file cannot be read (e.g. WebUI
 * without a file-read bridge, or a deleted plan file).
 */

import { useEffect, useState } from 'react'
import { usePlatform } from '../../context/PlatformContext'

/** Matches an absolute POSIX/Windows path (or ~-rooted path) ending in .md */
const MARKDOWN_PATH_RE = /^(?:~|\/|[A-Za-z]:[\\/])[^\n]*\.md$/i

/**
 * Extract a markdown file path from a plan message body.
 *
 * Returns null unless the whole message is a single absolute path to a .md
 * file — plan messages that already contain the plan text render as-is.
 */
export function extractPlanFilePath(text: string): string | null {
  const trimmed = text.trim().replace(/^[`<(]+|[`>)]+$/g, '').trim()
  if (!trimmed || trimmed.includes('\n')) return null
  return MARKDOWN_PATH_RE.test(trimmed) ? trimmed : null
}

/**
 * Read the plan file content for inline rendering.
 *
 * Returns null while loading, when no path is given, or on any read failure —
 * callers then keep showing the original message text.
 */
export function usePlanFileContent(path: string | null): string | null {
  const { onReadFile } = usePlatform()
  const [content, setContent] = useState<string | null>(null)

  useEffect(() => {
    setContent(null)
    if (!path || !onReadFile) return
    let cancelled = false
    onReadFile(path)
      .then((fileContent) => {
        if (!cancelled) setContent(fileContent)
      })
      .catch((error) => {
        console.warn('[plan-file-preview] Failed to read plan file:', error)
      })
    return () => { cancelled = true }
  }, [path, onReadFile])

  return content
}
