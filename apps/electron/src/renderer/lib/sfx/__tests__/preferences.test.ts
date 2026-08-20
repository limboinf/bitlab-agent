import { describe, expect, it, beforeEach, afterAll } from 'bun:test'
import {
  DEFAULT_SFX_PREFERENCES,
  SFX_VOLUME_LEVELS,
  clampVolume,
  readSfxPreferences,
  volumeLevel,
  writeSfxPreferences,
} from '../preferences'

/** Minimal localStorage stand-in; this suite runs outside a browser. */
class MemoryStorage {
  map = new Map<string, string>()
  getItem(key: string) { return this.map.get(key) ?? null }
  setItem(key: string, value: string) { this.map.set(key, value) }
  removeItem(key: string) { this.map.delete(key) }
}

const globals = globalThis as { localStorage?: unknown }
const hadLocalStorage = 'localStorage' in globals
let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  globals.localStorage = store
})

afterAll(() => {
  if (!hadLocalStorage) delete globals.localStorage
})

describe('defaults', () => {
  it('ships enabled at a moderate volume with keystrokes off', () => {
    expect(DEFAULT_SFX_PREFERENCES).toEqual({ enabled: true, volume: 0.7, typing: false })
  })

  it('falls back to the defaults when nothing was ever stored', () => {
    expect(readSfxPreferences()).toEqual(DEFAULT_SFX_PREFERENCES)
  })

  it('falls back to the defaults with no storage at all (SSR / tests)', () => {
    delete globals.localStorage
    expect(readSfxPreferences()).toEqual(DEFAULT_SFX_PREFERENCES)
  })
})

describe('persistence', () => {
  it('round-trips a muted preference', () => {
    writeSfxPreferences({ enabled: false, volume: 0.4, typing: true })
    expect(readSfxPreferences()).toEqual({ enabled: false, volume: 0.4, typing: true })
  })

  it('keeps mute across a fresh read, which is what a reload does', () => {
    writeSfxPreferences({ ...DEFAULT_SFX_PREFERENCES, enabled: false })
    const reloaded = readSfxPreferences()
    expect(reloaded.enabled).toBe(false)
    expect(reloaded.volume).toBe(DEFAULT_SFX_PREFERENCES.volume)
  })

  it('namespaces its keys like the other device preferences', () => {
    writeSfxPreferences(DEFAULT_SFX_PREFERENCES)
    expect([...store.map.keys()].sort()).toEqual([
      'craft-sound-enabled',
      'craft-sound-typing',
      'craft-sound-volume',
    ])
  })

  it('repairs a corrupted stored volume instead of muting or blasting', () => {
    store.setItem('craft-sound-volume', '"loud please"')
    expect(readSfxPreferences().volume).toBe(DEFAULT_SFX_PREFERENCES.volume)

    writeSfxPreferences({ ...DEFAULT_SFX_PREFERENCES, volume: 12 })
    expect(readSfxPreferences().volume).toBe(1)
  })
})

describe('volume levels', () => {
  it('clamps into the audible range', () => {
    expect(clampVolume(-3)).toBe(0)
    expect(clampVolume(4)).toBe(1)
    expect(clampVolume(Number.NaN)).toBe(DEFAULT_SFX_PREFERENCES.volume)
  })

  it('always resolves a stored volume to a selectable level', () => {
    expect(volumeLevel(SFX_VOLUME_LEVELS.soft)).toBe('soft')
    expect(volumeLevel(SFX_VOLUME_LEVELS.medium)).toBe('medium')
    expect(volumeLevel(SFX_VOLUME_LEVELS.loud)).toBe('loud')
    expect(volumeLevel(0.62)).toBe('medium')
    expect(volumeLevel(0)).toBe('soft')
  })
})
