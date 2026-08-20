/**
 * Browser Dock Atoms
 *
 * The dock is the right-hand browser column. It is global to the window — one
 * dock, N tabs — not per chat panel, so its state lives here rather than in the
 * panel stack.
 *
 * The renderer owns dock geometry outright: it measures a placeholder div and
 * pushes bounds/visibility to the main process, which parks the native
 * WebContentsView on that rect. Nothing in main guesses layout.
 */

import { atom } from 'jotai'
import * as storage from '@/lib/local-storage'

export const DOCK_MIN_WIDTH = 360
export const DOCK_MAX_WIDTH = 1100
export const DOCK_DEFAULT_WIDTH = 480

function clampDockWidth(width: number): number {
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)))
}

/** Dock column mounted and on screen. */
export const browserDockOpenAtom = atom(false)

const dockWidthBaseAtom = atom<number>(
  clampDockWidth(Number(storage.get(storage.KEYS.browserDockWidth, DOCK_DEFAULT_WIDTH))),
)

/** Persisted dock width; clamped on both read and write. */
export const browserDockWidthAtom = atom(
  (get) => get(dockWidthBaseAtom),
  (_get, set, width: number) => {
    const next = clampDockWidth(width)
    set(dockWidthBaseAtom, next)
    storage.set(storage.KEYS.browserDockWidth, next)
  },
)

/**
 * Count of renderer overlays currently covering the dock rect.
 *
 * Native views always paint above renderer content — there is no z-index that
 * reaches them — so any dialog or menu that would be swallowed by the browser
 * view has to ask us to detach it first. A counter (not a boolean) because
 * overlays nest: a menu inside a dialog must not un-suppress on its own close.
 */
export const browserDockSuppressCountAtom = atom(0)

export const browserDockSuppressedAtom = atom((get) => get(browserDockSuppressCountAtom) > 0)

/** Acquire/release helpers so callers never touch the raw counter. */
export const acquireDockSuppressionAtom = atom(null, (get, set) => {
  set(browserDockSuppressCountAtom, get(browserDockSuppressCountAtom) + 1)
})

export const releaseDockSuppressionAtom = atom(null, (get, set) => {
  set(browserDockSuppressCountAtom, Math.max(0, get(browserDockSuppressCountAtom) - 1))
})
