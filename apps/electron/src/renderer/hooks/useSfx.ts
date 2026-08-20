/**
 * React access to the shared sound player.
 *
 * The controller itself is a module singleton (see `lib/sfx/player`), so these
 * hooks only bind preferences to it and own the one listener that has to live
 * on the document.
 */

import { useCallback, useEffect } from 'react'
import { useAtom } from 'jotai'
import { getSfx, type SfxController, type SfxPreferences } from '@/lib/sfx'
import { sfxPreferencesAtom } from '@/atoms/sfx'

/** The shared controller. Stable for the lifetime of the page. */
export function useSfx(): SfxController {
  return getSfx()
}

export function useSfxPreferences(): [SfxPreferences, (patch: Partial<SfxPreferences>) => void] {
  const [preferences, patch] = useAtom(sfxPreferencesAtom)
  const sfx = useSfx()

  const update = useCallback((next: Partial<SfxPreferences>) => {
    // Apply to the player first so muting silences running loops immediately,
    // before React gets around to re-rendering the toggle.
    if (next.enabled !== undefined) sfx.setEnabled(next.enabled)
    if (next.volume !== undefined) sfx.setVolume(next.volume)
    patch(next)
  }, [patch, sfx])

  return [preferences, update]
}

/** True for elements where an `input` event means "the user typed a character". */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target instanceof HTMLTextAreaElement) return true
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit'].includes(target.type)
  }
  return false
}

/**
 * Mounted once at the app root: keeps the player in sync with the stored
 * preferences and, when keystroke sounds are on, plays the short `typing` cue
 * for local text entry.
 */
export function useSfxRuntime(): void {
  const [preferences] = useAtom(sfxPreferencesAtom)
  const sfx = useSfx()

  useEffect(() => {
    sfx.setEnabled(preferences.enabled)
    sfx.setVolume(preferences.volume)
  }, [sfx, preferences.enabled, preferences.volume])

  useEffect(() => {
    if (!preferences.enabled || !preferences.typing) return

    const onInput = (event: Event) => {
      if (!isTextEntry(event.target)) return
      // Typing rides the keystroke that caused it, so it doubles as an unlock.
      // Deliberately not throttled — one cue per character is the point — and
      // deliberately without a volume override: `typing` already ships at 0.065,
      // and PlayOptions.volume replaces that default rather than scaling it.
      sfx.playGesture('typing')
    }

    document.addEventListener('input', onInput, { capture: true, passive: true })
    return () => document.removeEventListener('input', onInput, { capture: true })
  }, [sfx, preferences.enabled, preferences.typing])
}
