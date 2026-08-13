import { describe, expect, it } from 'bun:test'
import { getInlineMenuFixedStyle } from '../inline-menu-position'

describe('getInlineMenuFixedStyle', () => {
  it('pins the menu above a mid-screen caret using viewport bottom', () => {
    expect(getInlineMenuFixedStyle({ x: 320, y: 480 }, 900)).toEqual({
      left: 310,
      bottom: 428,
    })
  })

  it('places the menu near the top when the caret is in the empty-chat hero', () => {
    // Empty-chat input sits around the vertical center. Using viewport height
    // (not a transformed ancestor) keeps bottom small enough to sit above it.
    const style = getInlineMenuFixedStyle({ x: 360, y: 520 }, 1040)
    expect(style.left).toBe(350)
    expect(style.bottom).toBe(528)
    expect(style.bottom).toBeLessThan(1040)
  })
})
