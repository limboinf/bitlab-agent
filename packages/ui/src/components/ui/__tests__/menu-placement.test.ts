import { describe, it, expect } from 'bun:test'
import {
  MIN_MENU_HEIGHT,
  TRIGGER_GAP,
  VIEWPORT_MARGIN,
  resolveMenuPlacement,
  type TriggerRect,
} from '../menu-placement'

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900 }

function trigger(overrides: Partial<TriggerRect> = {}): TriggerRect {
  return { top: 400, bottom: 420, left: 100, right: 200, ...overrides }
}

function place(input: Partial<Parameters<typeof resolveMenuPlacement>[0]> = {}) {
  return resolveMenuPlacement({
    rect: trigger(),
    menuWidth: 320,
    contentHeight: 0,
    align: 'start',
    ...VIEWPORT,
    ...input,
  })
}

describe('resolveMenuPlacement', () => {
  it('opens below the trigger when there is room', () => {
    const position = place({ contentHeight: 300 })

    expect(position.top).toBe(420 + TRIGGER_GAP)
    expect(position.left).toBe(100)
  })

  it('flips above a trigger sitting near the bottom edge', () => {
    // A turn's action row just above the composer: ~60px below, plenty above.
    const position = place({ rect: trigger({ top: 800, bottom: 820 }), contentHeight: 400 })

    expect(position.top).toBe(800 - TRIGGER_GAP - 400)
    expect(position.top + 400).toBeLessThanOrEqual(800)
  })

  it('stays below when the menu fits, however close to the bottom', () => {
    const position = place({ rect: trigger({ top: 800, bottom: 820 }), contentHeight: 60 })

    expect(position.top).toBe(820 + TRIGGER_GAP)
  })

  it('caps the height so a menu taller than both sides scrolls instead of overflowing', () => {
    const position = place({ rect: trigger({ top: 430, bottom: 450 }), contentHeight: 5_000 })

    expect(position.maxHeight).toBeLessThanOrEqual(900)
    expect(position.top).toBeGreaterThanOrEqual(0)
    expect(position.top + position.maxHeight).toBeLessThanOrEqual(900)
  })

  it('keeps a floor on the height budget in a cramped viewport', () => {
    const position = place({ rect: trigger({ top: 40, bottom: 60 }), contentHeight: 400, viewportHeight: 90 })

    expect(position.maxHeight).toBe(MIN_MENU_HEIGHT)
  })

  it('pulls a wide menu back inside the right edge', () => {
    const position = place({ rect: trigger({ left: 1300, right: 1400 }), contentHeight: 200 })

    expect(position.left + 320).toBeLessThanOrEqual(1440 - VIEWPORT_MARGIN)
  })

  it('hugs the left edge when the menu is wider than the viewport', () => {
    const position = place({ menuWidth: 900, contentHeight: 200, viewportWidth: 400 })

    expect(position.left).toBe(VIEWPORT_MARGIN)
  })

  it('never puts the menu top off the top of the screen', () => {
    const position = place({ rect: trigger({ top: 40, bottom: 60 }), contentHeight: 400, viewportHeight: 90 })

    expect(position.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN)
  })

  it('right-aligns to the trigger when asked', () => {
    const position = place({ align: 'end', rect: trigger({ left: 600, right: 700 }), contentHeight: 200 })

    expect(position.left).toBe(700 - 320)
  })

  it('assumes a fit below before the menu has been measured', () => {
    const position = place({ rect: trigger({ top: 800, bottom: 820 }), contentHeight: 0 })

    expect(position.top).toBe(820 + TRIGGER_GAP)
  })
})
