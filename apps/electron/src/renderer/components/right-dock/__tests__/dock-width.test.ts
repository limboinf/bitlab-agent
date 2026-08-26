import { describe, expect, it } from 'bun:test'
import { DOCK_MIN_WIDTH } from '@/atoms/right-dock'
import { MIN_CONTENT_WIDTH, resolveRightDockWidth } from '../dock-width'

const NAV = 240

describe('resolveRightDockWidth', () => {
  it('leaves a comfortable window alone', () => {
    expect(resolveRightDockWidth({ storedWidth: 480, shellWidth: 1600, navigationWidth: NAV }))
      .toBe(480)
  })

  it('gives ground so the chat keeps its minimum', () => {
    expect(resolveRightDockWidth({ storedWidth: 480, shellWidth: 1100, navigationWidth: NAV }))
      .toBe(1100 - NAV - MIN_CONTENT_WIDTH)
  })

  it('never collapses below the dock minimum', () => {
    expect(resolveRightDockWidth({ storedWidth: 480, shellWidth: 800, navigationWidth: NAV }))
      .toBe(DOCK_MIN_WIDTH)
  })

  it('reclaims the space a hidden navigation panel frees', () => {
    expect(resolveRightDockWidth({ storedWidth: 480, shellWidth: 1100, navigationWidth: 0 }))
      .toBe(480)
  })

  it('trusts the stored width until the shell has been measured', () => {
    expect(resolveRightDockWidth({ storedWidth: 900, shellWidth: 0, navigationWidth: NAV }))
      .toBe(900)
  })
})
