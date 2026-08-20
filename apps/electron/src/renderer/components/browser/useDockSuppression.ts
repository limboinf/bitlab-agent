/**
 * Detaches the browser dock's native view for as long as the caller is mounted.
 *
 * Native views paint above every pixel the renderer draws — there is no z-index
 * that reaches over them. So anything that must appear on top of the browser
 * (modal dialogs, the command palette) has to ask for the view to step aside
 * instead of trying to out-stack it.
 *
 * Scope this to overlays that genuinely cover the dock. Suppressing on every
 * tooltip would make the browser flicker constantly.
 */

import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { subscribeNativeViewOcclusion } from '@bitlab/ui'
import { acquireDockSuppressionAtom, releaseDockSuppressionAtom } from '@/atoms/browser-dock'

export function useDockSuppression(active = true): void {
  const acquire = useSetAtom(acquireDockSuppressionAtom)
  const release = useSetAtom(releaseDockSuppressionAtom)

  useEffect(() => {
    if (!active) return
    acquire()
    return () => release()
  }, [active, acquire, release])
}

/**
 * Mount-scoped version of the hook, for overlay libraries that decide
 * visibility by mounting rather than by a prop.
 *
 * This exists because the hook is easy to place wrong: Radix renders a closed
 * dialog's component body and only gates the *portal* on open state, so calling
 * `useDockSuppression()` in a content component suppresses the dock forever.
 * Render this inside the portal instead, where mounting means "actually open".
 */
export function DockSuppressor(): null {
  useDockSuppression()
  return null
}

/**
 * Mirrors the shared UI's fullscreen-overlay signal into dock suppression.
 *
 * Preview overlays (image, markdown, diff, PDF...) live in `@bitlab/ui` and are
 * shared with the web build, so they know nothing about native views — they
 * only report that something is covering the window. Mount this once next to
 * the dock to translate that report into a detach.
 */
export function useOverlayOcclusionSuppression(): void {
  const acquire = useSetAtom(acquireDockSuppressionAtom)
  const release = useSetAtom(releaseDockSuppressionAtom)

  useEffect(() => {
    let held = false

    const unsubscribe = subscribeNativeViewOcclusion((occluding) => {
      if (occluding === held) return
      held = occluding
      if (occluding) acquire()
      else release()
    })

    return () => {
      unsubscribe()
      if (held) release()
    }
  }, [acquire, release])
}
