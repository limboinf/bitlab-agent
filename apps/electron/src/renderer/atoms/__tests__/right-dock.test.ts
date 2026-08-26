import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  acquireDockSuppressionAtom,
  browserDockSuppressCountAtom,
  browserDockSuppressedAtom,
  releaseDockSuppressionAtom,
} from '../browser-dock'

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
