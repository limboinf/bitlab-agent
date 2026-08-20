/**
 * Keeps the main process's native browser view parked on the dock placeholder.
 *
 * The placeholder is an empty div in normal flow — it never renders anything.
 * Its rect is the contract: whatever it measures, the WebContentsView occupies.
 * That keeps layout entirely in CSS (flex, sashes, animations) instead of
 * duplicating geometry math in the main process.
 *
 * Pushes are coalesced to one per frame because a sash drag fires resize
 * observations far faster than the compositor can move a native view.
 */

import { useEffect, useRef, type RefObject } from 'react'
import type { BrowserDockStatePayload } from '../../../shared/types'

interface DockSyncInput {
  visible: boolean
  suppressed: boolean
  activeInstanceId: string | null
}

function boundsEqual(
  a: BrowserDockStatePayload['bounds'],
  b: BrowserDockStatePayload['bounds'],
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

export function useDockBoundsSync(
  placeholderRef: RefObject<HTMLElement | null>,
  { visible, suppressed, activeInstanceId }: DockSyncInput,
): void {
  // Latest desired state, read by the rAF flush. Kept in a ref so the observer
  // callback never closes over a stale render.
  const desiredRef = useRef<DockSyncInput>({ visible, suppressed, activeInstanceId })
  const lastSentRef = useRef<BrowserDockStatePayload | null>(null)
  const frameRef = useRef(0)

  desiredRef.current = { visible, suppressed, activeInstanceId }

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api?.setDockState) return

    const measure = (): BrowserDockStatePayload => {
      const el = placeholderRef.current
      const { visible: isVisible, suppressed: isSuppressed, activeInstanceId: active } = desiredRef.current

      // No element, or a collapsed one, means "nothing to paint" rather than a
      // zero-size rect — main treats a null rect as unmeasured and detaches.
      const rect = el && isVisible ? el.getBoundingClientRect() : null
      const bounds = rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : null

      return { visible: isVisible, suppressed: isSuppressed, activeInstanceId: active, bounds }
    }

    const flush = () => {
      frameRef.current = 0
      const next = measure()
      const prev = lastSentRef.current

      if (
        prev
        && prev.visible === next.visible
        && prev.suppressed === next.suppressed
        && prev.activeInstanceId === next.activeInstanceId
        && boundsEqual(prev.bounds, next.bounds)
      ) {
        return
      }

      lastSentRef.current = next
      void api.setDockState(next)
    }

    const schedule = () => {
      if (frameRef.current) return
      frameRef.current = requestAnimationFrame(flush)
    }

    schedule()

    const observer = new ResizeObserver(schedule)
    if (placeholderRef.current) observer.observe(placeholderRef.current)

    // The placeholder can move without resizing (sidebar collapse, window move),
    // so window-level changes have to re-measure too.
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    return () => {
      if (frameRef.current) cancelAnimationFrame(frameRef.current)
      frameRef.current = 0
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
    }
  }, [placeholderRef])

  // Any state change (tab switch, dialog opening, dock closing) re-measures on
  // the next frame — the effect above only re-runs when the ref identity does.
  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api?.setDockState) return

    const frame = requestAnimationFrame(() => {
      const el = placeholderRef.current
      const rect = el && visible ? el.getBoundingClientRect() : null
      const bounds = rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
        : null

      const next: BrowserDockStatePayload = { visible, suppressed, activeInstanceId, bounds }
      lastSentRef.current = next
      void api.setDockState(next)
    })

    return () => cancelAnimationFrame(frame)
  }, [visible, suppressed, activeInstanceId, placeholderRef])

  // Detach on unmount so a closed dock never leaves an orphaned native view.
  useEffect(() => {
    return () => {
      void window.electronAPI?.browserPane?.setDockState?.({
        visible: false,
        suppressed: false,
        activeInstanceId: null,
        bounds: null,
      })
    }
  }, [])
}
