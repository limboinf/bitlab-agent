/**
 * SfxController — the rules around the player.
 *
 * Owns three things the raw uisfx player deliberately doesn't:
 *  - the unlock gate (async cues stay silent until a real gesture armed audio,
 *    so a reconnect that happened before the user touched anything can't fire
 *    stale feedback the moment they finally click something),
 *  - the loop registry (one handle per logical process, idempotent starts,
 *    guaranteed stops),
 *  - a small per-cue cooldown, because several sessions can finish at once.
 *
 * It talks to a `SfxPlayerLike`, never to `createUISFX`, so it is testable
 * without Web Audio.
 */

import type { CueName, PackName, PlayOptions, PlayingSFX } from 'uisfx'

export interface SfxPlayerLike {
  play: (cue: CueName, options?: PlayOptions) => PlayingSFX | null
  setPack: (pack: PackName) => void
  setVolume: (volume: number) => void
  setEnabled: (enabled: boolean) => void
  stopAll: () => void
  unlock: () => Promise<boolean>
  destroy: () => Promise<void>
}

/** Loops we can start, keyed by the process they represent. */
export type LoopKey = 'transport'

/**
 * Cues that can fire twice for one intent: several sessions changing state in
 * the same tick, or a control that answers both pointer and keyboard
 * activation. `typing` is deliberately absent — one cue per character is the
 * point of it.
 */
const COOLDOWN_MS: Partial<Record<CueName, number>> = {
  send: 150,
  queued: 150,
  complete: 400,
  error: 400,
  warning: 400,
  stop: 400,
  connect: 400,
  disconnect: 400,
  delete: 200,
}

export interface SfxControllerOptions {
  player: SfxPlayerLike
  enabled: boolean
  volume: number
  /** Injectable clock so cooldown behaviour is testable. */
  now?: () => number
}

export class SfxController {
  private readonly player: SfxPlayerLike
  private readonly now: () => number
  private readonly loops = new Map<LoopKey, PlayingSFX>()
  private readonly lastPlayedAt = new Map<CueName, number>()
  private enabled: boolean
  private unlocked = false
  private disposed = false

  constructor({ player, enabled, volume, now = () => Date.now() }: SfxControllerOptions) {
    this.player = player
    this.now = now
    this.enabled = enabled
    player.setEnabled(enabled)
    player.setVolume(volume)
  }

  isEnabled(): boolean {
    return this.enabled
  }

  isUnlocked(): boolean {
    return this.unlocked
  }

  /**
   * Arm Web Audio from a genuine user gesture. Safe to call on every gesture;
   * only the first one does work.
   */
  unlock(): void {
    if (this.unlocked || this.disposed) return
    this.unlocked = true
    void this.player.unlock().catch(() => {
      // A blocked resume just means the next gesture gets another chance.
      this.unlocked = false
    })
  }

  /**
   * Play a cue that a user gesture is directly causing. Must be called
   * synchronously inside the pointer/keyboard handler, before any await.
   */
  playGesture(cue: CueName, options?: PlayOptions): PlayingSFX | null {
    this.unlocked = true
    return this.emit(cue, options)
  }

  /**
   * Play a cue for something that resolved on its own schedule (agent events,
   * connection changes, settled promises). Silent until audio is unlocked.
   */
  playAsync(cue: CueName, options?: PlayOptions): PlayingSFX | null {
    if (!this.unlocked) return null
    return this.emit(cue, options)
  }

  /**
   * Drive a loop from the visible state of a process. Idempotent in both
   * directions: repeated `true` keeps the single existing handle.
   */
  setLoop(key: LoopKey, cue: CueName, active: boolean): void {
    if (!active || !this.enabled || !this.unlocked || this.disposed) {
      this.stopLoop(key)
      return
    }
    if (this.loops.has(key)) return
    const handle = this.player.play(cue, { loop: true })
    if (handle) this.loops.set(key, handle)
  }

  stopLoop(key: LoopKey): void {
    const handle = this.loops.get(key)
    if (!handle) return
    this.loops.delete(key)
    handle.stop()
  }

  stopAllLoops(): void {
    for (const key of [...this.loops.keys()]) this.stopLoop(key)
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      // Mute has to be immediate: kill loops and tails before the player mutes,
      // otherwise a running loop keeps its handle and its voice.
      this.stopAllLoops()
      this.player.stopAll()
    }
    this.player.setEnabled(enabled)
  }

  setVolume(volume: number): void {
    this.player.setVolume(volume)
  }

  setPack(pack: PackName): void {
    this.player.setPack(pack)
  }

  /** Global reset for hard transitions (workspace switch, logout, teardown). */
  stopAll(): void {
    this.stopAllLoops()
    this.player.stopAll()
  }

  async destroy(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.stopAllLoops()
    this.player.stopAll()
    await this.player.destroy()
  }

  private emit(cue: CueName, options?: PlayOptions): PlayingSFX | null {
    if (!this.enabled || this.disposed) return null

    const cooldown = COOLDOWN_MS[cue]
    if (cooldown) {
      const last = this.lastPlayedAt.get(cue)
      const now = this.now()
      if (last !== undefined && now - last < cooldown) return null
      this.lastPlayedAt.set(cue, now)
    }

    return this.player.play(cue, options)
  }
}
