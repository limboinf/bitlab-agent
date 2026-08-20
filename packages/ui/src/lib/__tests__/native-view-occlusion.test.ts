/**
 * The signal that lets renderer overlays get out from under a native view.
 *
 * The counter is the whole contract: a leaked acquire leaves the Electron
 * browser dock detached forever, and a double release lets the dock paint over
 * an overlay that is still open. Both have shipped as bugs before.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import {
  acquireNativeViewOcclusion,
  isOccludingNativeViews,
  resetNativeViewOcclusionForTests,
  subscribeNativeViewOcclusion,
} from '../native-view-occlusion'

afterEach(() => resetNativeViewOcclusionForTests())

describe('native view occlusion', () => {
  it('is quiet until something claims the screen', () => {
    expect(isOccludingNativeViews()).toBe(false)
  })

  it('reports the current state to a new subscriber right away', () => {
    acquireNativeViewOcclusion()

    const seen: boolean[] = []
    subscribeNativeViewOcclusion((occluding) => seen.push(occluding))

    expect(seen).toEqual([true])
  })

  it('stays occluded until the last overlay closes', () => {
    const seen: boolean[] = []
    subscribeNativeViewOcclusion((occluding) => seen.push(occluding))

    const releaseOuter = acquireNativeViewOcclusion()
    const releaseInner = acquireNativeViewOcclusion()
    releaseInner()

    expect(isOccludingNativeViews()).toBe(true)

    releaseOuter()
    expect(isOccludingNativeViews()).toBe(false)
    expect(seen).toEqual([false, true, true, true, false])
  })

  it('ignores a release called twice', () => {
    const releaseFirst = acquireNativeViewOcclusion()
    acquireNativeViewOcclusion()

    releaseFirst()
    releaseFirst()

    expect(isOccludingNativeViews()).toBe(true)
  })

  it('stops notifying once unsubscribed', () => {
    const seen: boolean[] = []
    const unsubscribe = subscribeNativeViewOcclusion((occluding) => seen.push(occluding))
    unsubscribe()

    acquireNativeViewOcclusion()

    expect(seen).toEqual([false])
  })
})
