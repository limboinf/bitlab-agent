/**
 * The app's single sound player.
 *
 * Module-level, not component-level: React Strict Mode double-mounts and panel
 * remounts must never end up with two AudioContexts fighting over the same
 * cues. Created lazily on first use and disposed once, at page teardown.
 *
 * Nothing here plays on load. Web Audio is armed from the first genuine pointer
 * or key gesture, which also unblocks the asynchronous cues (agent finished,
 * approval needed) that are the whole point of the feature.
 */

import { createUISFX } from 'uisfx'
import { SfxController, type SfxPlayerLike } from './controller'
import { SFX_PACK } from './cues'
import { readSfxPreferences } from './preferences'

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined'

/** Stand-in for non-browser contexts (unit tests, any future SSR pass). */
function createSilentPlayer(): SfxPlayerLike {
  return {
    play: () => null,
    setPack: () => {},
    setVolume: () => {},
    setEnabled: () => {},
    stopAll: () => {},
    unlock: async () => false,
    destroy: async () => {},
  }
}

let controller: SfxController | null = null
let detachListeners: (() => void) | null = null

function installLifecycleListeners(instance: SfxController): void {
  const arm = () => instance.unlock()
  const teardown = () => { void destroySfx() }

  // Capture phase so the context resumes even if a handler stops propagation.
  document.addEventListener('pointerdown', arm, { capture: true, passive: true })
  document.addEventListener('keydown', arm, { capture: true, passive: true })
  window.addEventListener('pagehide', teardown)

  detachListeners = () => {
    document.removeEventListener('pointerdown', arm, { capture: true })
    document.removeEventListener('keydown', arm, { capture: true })
    window.removeEventListener('pagehide', teardown)
  }
}

/** The shared controller. Cheap to call; builds the player on first use. */
export function getSfx(): SfxController {
  if (controller) return controller

  const preferences = readSfxPreferences()
  const player: SfxPlayerLike = isBrowser()
    ? createUISFX({
        pack: SFX_PACK,
        volume: preferences.volume,
        enabled: preferences.enabled,
      })
    : createSilentPlayer()

  controller = new SfxController({
    player,
    enabled: preferences.enabled,
    volume: preferences.volume,
  })

  if (isBrowser()) installLifecycleListeners(controller)

  return controller
}

/**
 * App-level disposal. Not for component unmount — the controller outlives every
 * component on purpose.
 */
export async function destroySfx(): Promise<void> {
  const instance = controller
  controller = null
  detachListeners?.()
  detachListeners = null
  await instance?.destroy()
}
