/**
 * Interface-sound preference state.
 *
 * A plain atom seeded from localStorage rather than `atomWithStorage`, because
 * the player is built before React mounts and has to read the very same value
 * — `lib/sfx/preferences` is the single seam that both sides go through.
 */

import { atom } from 'jotai'
import {
  clampVolume,
  readSfxPreferences,
  writeSfxPreferences,
  type SfxPreferences,
} from '@/lib/sfx'

const stateAtom = atom<SfxPreferences>(readSfxPreferences())

/** Read the preferences; write a partial patch (persisted on every write). */
export const sfxPreferencesAtom = atom(
  (get) => get(stateAtom),
  (get, set, patch: Partial<SfxPreferences>) => {
    const next = { ...get(stateAtom), ...patch }
    next.volume = clampVolume(next.volume)
    set(stateAtom, next)
    writeSfxPreferences(next)
  },
)
