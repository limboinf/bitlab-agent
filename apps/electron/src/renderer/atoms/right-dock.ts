/**
 * Right Dock Atoms
 *
 * One dock owns the window's right-hand column. It is a permanent fixture, not
 * a drawer you summon: artifacts, changes and session files stack in it as
 * collapsible sections you can have open at once, because "what did it make"
 * and "what did it touch" are usually the same question.
 *
 * The browser is the one thing that cannot be a section. It is a native
 * WebContentsView pinned to a rect the main process paints over the renderer;
 * a box whose height changes as siblings expand would drag it around and could
 * not be positioned at all with two sections open. So it takes over the dock as
 * a mode instead.
 *
 * The renderer owns dock geometry outright: it measures a placeholder div and
 * pushes bounds/visibility to the main process. Nothing in main guesses layout.
 */

import { atom } from 'jotai'
import * as storage from '@/lib/local-storage'

export const DOCK_MIN_WIDTH = 360
export const DOCK_MAX_WIDTH = 1100
export const DOCK_DEFAULT_WIDTH = 480

/** Stacked, independently collapsible content. Order matches the rendered column. */
export const RIGHT_DOCK_SECTIONS = ['artifacts', 'changes', 'files'] as const
export type RightDockSection = (typeof RIGHT_DOCK_SECTIONS)[number]

/** Sections, or the browser taking over the whole column. */
export type RightDockMode = 'sections' | 'browser'

type SectionExpansion = Record<RightDockSection, boolean>

/** Artifacts lead — the deliverables are what a finished task is judged by. */
const DEFAULT_EXPANSION: SectionExpansion = { artifacts: true, changes: false, files: false }

function clampDockWidth(width: number): number {
  return Math.min(DOCK_MAX_WIDTH, Math.max(DOCK_MIN_WIDTH, Math.round(width)))
}

function readStoredExpansion(): SectionExpansion {
  const stored = storage.get<Partial<SectionExpansion>>(storage.KEYS.rightDockSections, {})
  return { ...DEFAULT_EXPANSION, ...stored }
}

const rightDockOpenBaseAtom = atom(storage.get(storage.KEYS.rightDockOpen, true))

/** Dock column mounted and on screen. Open by default, and the choice sticks. */
export const rightDockOpenAtom = atom(
  (get) => get(rightDockOpenBaseAtom),
  (_get, set, open: boolean) => {
    set(rightDockOpenBaseAtom, open)
    storage.set(storage.KEYS.rightDockOpen, open)
  },
)

const rightDockModeBaseAtom = atom<RightDockMode>(
  storage.get<RightDockMode>(storage.KEYS.rightDockMode, 'sections') === 'browser'
    ? 'browser'
    : 'sections',
)

export const rightDockModeAtom = atom(
  (get) => get(rightDockModeBaseAtom),
  (_get, set, mode: RightDockMode) => {
    set(rightDockModeBaseAtom, mode)
    storage.set(storage.KEYS.rightDockMode, mode)
  },
)

const rightDockSectionsBaseAtom = atom<SectionExpansion>(readStoredExpansion())

export const rightDockSectionsAtom = atom(
  (get) => get(rightDockSectionsBaseAtom),
  (get, set, section: RightDockSection, expanded?: boolean) => {
    const current = get(rightDockSectionsBaseAtom)
    const next = { ...current, [section]: expanded ?? !current[section] }
    set(rightDockSectionsBaseAtom, next)
    storage.set(storage.KEYS.rightDockSections, next)
  },
)

/** Show one section: open the dock, leave the browser, expand that section. */
export const openRightDockSectionAtom = atom(null, (_get, set, section: RightDockSection) => {
  set(rightDockOpenAtom, true)
  set(rightDockModeAtom, 'sections')
  set(rightDockSectionsAtom, section, true)
})

/** Hand the column to the browser. */
export const openRightDockBrowserAtom = atom(null, (_get, set) => {
  set(rightDockOpenAtom, true)
  set(rightDockModeAtom, 'browser')
})

const dockWidthBaseAtom = atom<number>(
  clampDockWidth(Number(storage.get(storage.KEYS.rightDockWidth, DOCK_DEFAULT_WIDTH))),
)

/** Persisted dock width; clamped on both read and write. Shared by every mode. */
export const rightDockWidthAtom = atom(
  (get) => get(dockWidthBaseAtom),
  (_get, set, width: number) => {
    const next = clampDockWidth(width)
    set(dockWidthBaseAtom, next)
    storage.set(storage.KEYS.rightDockWidth, next)
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
