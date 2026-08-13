/**
 * Truth table for the picker's render decisions.
 *
 * The old table gated on catalog size and "session has messages", which is
 * what trapped users on a single-model connection mid-session (#727 and the
 * lock that survived it). These tests pin the replacement rules so a future
 * reshuffle can't quietly reintroduce either gate:
 *
 *  - anything to list ⇒ the picker is usable, full stop;
 *  - only a definite `routable === false` blocks the composer, and it still
 *    leaves the picker live, because picking is what clears the block.
 */

import { describe, test, expect } from 'bun:test'
import { blocksComposer, derivePickerMode, type PickerModeInput } from '../picker-mode'

function input(overrides: Partial<PickerModeInput> = {}): PickerModeInput {
  return { groupCount: 1, loaded: true, ...overrides }
}

describe('derivePickerMode', () => {
  test('any offerable connection → browse', () => {
    expect(derivePickerMode(input({ groupCount: 1 }))).toBe('browse')
    expect(derivePickerMode(input({ groupCount: 7 }))).toBe('browse')
  })

  test('a single-model connection is still browsable (the old locked-single trap)', () => {
    // The catalog having exactly one row is not a reason to disable the menu:
    // the connection may serve models it no longer advertises, and the user
    // must still be able to reach other connections.
    expect(derivePickerMode(input({ groupCount: 1, loaded: true }))).toBe('browse')
  })

  test('nothing loaded yet → empty, not unavailable', () => {
    // "Not read yet" must never render as "nothing works".
    expect(derivePickerMode(input({ groupCount: 0, loaded: false }))).toBe('empty')
  })

  test('load settled with no offerable connection → unavailable', () => {
    expect(derivePickerMode(input({ groupCount: 0, loaded: true }))).toBe('unavailable')
  })
})

describe('blocksComposer', () => {
  test('definite refusal blocks', () => {
    expect(blocksComposer(false)).toBe(true)
  })

  test('serving route does not block', () => {
    expect(blocksComposer(true)).toBe(false)
  })

  test('unknown never blocks — a slow host must not lock a working composer', () => {
    expect(blocksComposer(null)).toBe(false)
  })
})
