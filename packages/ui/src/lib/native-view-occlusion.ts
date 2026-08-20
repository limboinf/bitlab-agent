/**
 * Reports that a renderer overlay is covering the whole window.
 *
 * Electron paints native views — the browser dock's WebContentsView — above
 * every pixel the renderer draws; no z-index reaches over them. So a fullscreen
 * overlay cannot cover the dock by stacking. The host has to step the native
 * view aside for as long as the overlay is up.
 *
 * This module is the seam. The shared UI knows nothing about native views: it
 * only says "an overlay is up". Whoever owns native views subscribes and acts.
 * In the web build nobody subscribes and the counter is inert.
 *
 * A counter, not a boolean, because overlays stack — closing the top one must
 * not un-suppress while another is still open.
 */

import { useEffect } from 'react'

type OcclusionListener = (occluding: boolean) => void

let occluderCount = 0
const listeners = new Set<OcclusionListener>()

function notify(): void {
  const occluding = occluderCount > 0
  for (const listener of listeners) listener(occluding)
}

export function isOccludingNativeViews(): boolean {
  return occluderCount > 0
}

/** Subscribes to the signal; fires immediately with the current state. */
export function subscribeNativeViewOcclusion(listener: OcclusionListener): () => void {
  listeners.add(listener)
  listener(occluderCount > 0)
  return () => {
    listeners.delete(listener)
  }
}

/** Claims one occluder; the returned function gives it back. */
export function acquireNativeViewOcclusion(): () => void {
  occluderCount += 1
  notify()

  let released = false
  return () => {
    if (released) return
    released = true
    occluderCount = Math.max(0, occluderCount - 1)
    notify()
  }
}

/** Counts the caller as a window-covering overlay for as long as `active` holds. */
export function useNativeViewOcclusion(active: boolean): void {
  useEffect(() => {
    if (!active) return
    return acquireNativeViewOcclusion()
  }, [active])
}

/** Test-only: drops every subscriber and resets the count. */
export function resetNativeViewOcclusionForTests(): void {
  listeners.clear()
  occluderCount = 0
}
