/**
 * Turns element picks into composer attachments.
 *
 * Annotation mode deliberately has no note UI of its own. Each pick lands in
 * the composer as a numbered screenshot plus a `#n` marker, so several picks
 * batch naturally and the send button stays the only way to send — the
 * ambiguity Codex hit by overloading Enter never arises here.
 */

import { useEffect, useRef } from 'react'
import type { BrowserAnnotationPick } from '../../../shared/types'

/** `data:` URL → File, so picks ride the same path as a pasted screenshot. */
function pickToFile(pick: BrowserAnnotationPick, index: number): File {
  const binary = atob(pick.imageBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

  const extension = pick.mimeType === 'image/jpeg' ? 'jpg' : 'png'
  // The label is page-authored and already sanitized in main; the slug here
  // just keeps the filename readable.
  const slug = pick.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 32)

  return new File([bytes], `annotation-${index}${slug ? `-${slug}` : ''}.${extension}`, {
    type: pick.mimeType,
  })
}

export function useAnnotationPicks(sessionId?: string | null): void {
  // Numbering restarts per session so "#1" always means "the first one I picked
  // in this conversation".
  const nextIndexRef = useRef(1)

  useEffect(() => {
    nextIndexRef.current = 1
  }, [sessionId])

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api?.onAnnotationPicked) return

    return api.onAnnotationPicked((pick) => {
      const index = nextIndexRef.current
      nextIndexRef.current += 1

      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: { files: [pickToFile(pick, index)], sessionId: sessionId ?? undefined },
      }))

      window.dispatchEvent(new CustomEvent('craft:insert-text', {
        detail: { text: `#${index} `, append: true, sessionId: sessionId ?? undefined },
      }))
    })
  }, [sessionId])
}
