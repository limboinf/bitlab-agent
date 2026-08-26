import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  acquireDockSuppressionAtom,
  browserDockSuppressCountAtom,
  browserDockSuppressedAtom,
  DOCK_MAX_WIDTH,
  DOCK_MIN_WIDTH,
  openRightDockBrowserAtom,
  openRightDockSectionAtom,
  releaseDockSuppressionAtom,
  rightDockModeAtom,
  rightDockOpenAtom,
  rightDockSectionsAtom,
  rightDockWidthAtom,
} from '../right-dock'

describe('dock suppression counter', () => {
  it('is not suppressed by default', () => {
    const store = createStore()
    expect(store.get(browserDockSuppressedAtom)).toBe(false)
  })

  it('stays suppressed until every overlay releases', () => {
    const store = createStore()

    store.set(acquireDockSuppressionAtom)
    store.set(acquireDockSuppressionAtom)
    expect(store.get(browserDockSuppressedAtom)).toBe(true)

    // A menu inside a dialog closing must not un-suppress the dialog itself.
    store.set(releaseDockSuppressionAtom)
    expect(store.get(browserDockSuppressedAtom)).toBe(true)

    store.set(releaseDockSuppressionAtom)
    expect(store.get(browserDockSuppressedAtom)).toBe(false)
  })

  it('never drops below zero on unbalanced releases', () => {
    // A stray release must not leave a negative count that swallows the next
    // real suppression — the dock would then paint over an open dialog.
    const store = createStore()

    store.set(releaseDockSuppressionAtom)
    store.set(releaseDockSuppressionAtom)
    expect(store.get(browserDockSuppressCountAtom)).toBe(0)

    store.set(acquireDockSuppressionAtom)
    expect(store.get(browserDockSuppressedAtom)).toBe(true)
  })
})

describe('right dock sections and modes', () => {
  it('is a permanent column: open by default', () => {
    expect(createStore().get(rightDockOpenAtom)).toBe(true)
  })

  it('leads with artifacts expanded and the rest folded away', () => {
    expect(createStore().get(rightDockSectionsAtom)).toEqual({
      artifacts: true,
      changes: false,
      files: false,
    })
  })

  it('opens a section without folding the ones already open', () => {
    const store = createStore()

    store.set(openRightDockSectionAtom, 'changes')
    expect(store.get(rightDockSectionsAtom)).toEqual({
      artifacts: true,
      changes: true,
      files: false,
    })
  })

  it('toggles a section on repeat clicks', () => {
    const store = createStore()

    store.set(rightDockSectionsAtom, 'artifacts')
    expect(store.get(rightDockSectionsAtom).artifacts).toBe(false)
    store.set(rightDockSectionsAtom, 'artifacts')
    expect(store.get(rightDockSectionsAtom).artifacts).toBe(true)
  })

  it('hands the whole column to the browser, and takes it back', () => {
    const store = createStore()
    expect(store.get(rightDockModeAtom)).toBe('sections')

    store.set(openRightDockBrowserAtom)
    expect(store.get(rightDockModeAtom)).toBe('browser')
    expect(store.get(rightDockOpenAtom)).toBe(true)

    // Asking for a section is also how you leave the browser.
    store.set(openRightDockSectionAtom, 'artifacts')
    expect(store.get(rightDockModeAtom)).toBe('sections')
  })

  it('reopens a closed dock when a section is requested', () => {
    const store = createStore()

    store.set(rightDockOpenAtom, false)
    store.set(openRightDockSectionAtom, 'files')
    expect(store.get(rightDockOpenAtom)).toBe(true)
    expect(store.get(rightDockSectionsAtom).files).toBe(true)
  })

  it('clamps the width every mode shares', () => {
    const store = createStore()

    store.set(rightDockWidthAtom, 10)
    expect(store.get(rightDockWidthAtom)).toBe(DOCK_MIN_WIDTH)

    store.set(rightDockWidthAtom, 99_999)
    expect(store.get(rightDockWidthAtom)).toBe(DOCK_MAX_WIDTH)
  })
})
