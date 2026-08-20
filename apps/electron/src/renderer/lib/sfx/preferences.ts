/**
 * Sound preferences.
 *
 * Stored next to the app's other device-scoped preferences (theme, appearance)
 * in localStorage rather than in the main-process settings file: speakers are a
 * property of the machine you're sitting at, so a Desktop window and a WebUI tab
 * on a phone should be free to disagree.
 */

import * as storage from '../local-storage'

export interface SfxPreferences {
  /** Master switch for all interface sounds. */
  enabled: boolean
  /** 0..1, applied to the player's master gain. */
  volume: number
  /** Per-keystroke `typing` cue. Off unless explicitly asked for. */
  typing: boolean
}

export const DEFAULT_SFX_PREFERENCES: SfxPreferences = {
  enabled: true,
  volume: 0.7,
  typing: false,
}

/** The three levels offered in Settings. */
export const SFX_VOLUME_LEVELS = {
  soft: 0.4,
  medium: 0.7,
  loud: 1,
} as const

export type SfxVolumeLevel = keyof typeof SFX_VOLUME_LEVELS

export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return DEFAULT_SFX_PREFERENCES.volume
  return Math.min(1, Math.max(0, volume))
}

/** Nearest named level for a stored volume, so the control always has a value. */
export function volumeLevel(volume: number): SfxVolumeLevel {
  let closest: SfxVolumeLevel = 'medium'
  let distance = Infinity
  for (const [level, value] of Object.entries(SFX_VOLUME_LEVELS) as [SfxVolumeLevel, number][]) {
    const next = Math.abs(value - volume)
    if (next < distance) {
      distance = next
      closest = level
    }
  }
  return closest
}

export function readSfxPreferences(): SfxPreferences {
  return {
    enabled: storage.get(storage.KEYS.soundEnabled, DEFAULT_SFX_PREFERENCES.enabled),
    volume: clampVolume(storage.get(storage.KEYS.soundVolume, DEFAULT_SFX_PREFERENCES.volume)),
    typing: storage.get(storage.KEYS.soundTyping, DEFAULT_SFX_PREFERENCES.typing),
  }
}

export function writeSfxPreferences(preferences: SfxPreferences): void {
  storage.set(storage.KEYS.soundEnabled, preferences.enabled)
  storage.set(storage.KEYS.soundVolume, clampVolume(preferences.volume))
  storage.set(storage.KEYS.soundTyping, preferences.typing)
}
