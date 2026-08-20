import { describe, expect, it, afterEach } from 'bun:test'
import { destroySfx, getSfx } from '../player'

// This suite runs without `window`, which is also what any server-side render
// would look like: the module must degrade to silence rather than reach for
// Web Audio.

afterEach(async () => {
  await destroySfx()
})

describe('shared player', () => {
  it('hands out one controller, however many components ask', () => {
    expect(getSfx()).toBe(getSfx())
  })

  it('survives a Strict Mode style mount / unmount / mount', async () => {
    const first = getSfx()
    await destroySfx()
    const second = getSfx()
    expect(second).not.toBe(first)
    expect(second.isEnabled()).toBe(true)
  })

  it('never creates audio or plays outside a browser', () => {
    const sfx = getSfx()
    expect(sfx.playGesture('send')).toBeNull()
    expect(sfx.playAsync('complete')).toBeNull()
    expect(() => sfx.setLoop('transport', 'connecting', true)).not.toThrow()
    expect(() => sfx.stopAll()).not.toThrow()
  })

  it('is safe to dispose more than once', async () => {
    getSfx()
    await destroySfx()
    await expect(destroySfx()).resolves.toBeUndefined()
  })
})
