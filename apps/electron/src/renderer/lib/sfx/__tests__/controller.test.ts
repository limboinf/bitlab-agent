import { describe, expect, it, beforeEach } from 'bun:test'
import type { CueName, PlayOptions, PlayingSFX } from 'uisfx'
import { SfxController, type SfxPlayerLike } from '../controller'

interface PlayCall {
  cue: CueName
  options?: PlayOptions
}

class FakePlayer implements SfxPlayerLike {
  played: PlayCall[] = []
  handles: { cue: CueName; stopped: boolean }[] = []
  stopAllCount = 0
  enabled: boolean | null = null
  volume: number | null = null
  pack: string | null = null
  unlockCount = 0
  destroyed = false
  /** When set, play() reports failure the way a locked context does. */
  returnsNull = false

  play(cue: CueName, options?: PlayOptions): PlayingSFX | null {
    this.played.push({ cue, options })
    if (this.returnsNull) return null
    const handle = { cue, stopped: false }
    this.handles.push(handle)
    return {
      stop: () => { handle.stopped = true },
      ended: Promise.resolve(),
    }
  }
  setPack(pack: string) { this.pack = pack }
  setVolume(volume: number) { this.volume = volume }
  setEnabled(enabled: boolean) { this.enabled = enabled }
  stopAll() { this.stopAllCount += 1 }
  async unlock() { this.unlockCount += 1; return true }
  async destroy() { this.destroyed = true }

  cues() { return this.played.map(p => p.cue) }
  liveLoops() { return this.handles.filter(h => !h.stopped) }
}

let player: FakePlayer
let clock: number
const controller = (enabled = true) =>
  new SfxController({ player, enabled, volume: 0.7, now: () => clock })

beforeEach(() => {
  player = new FakePlayer()
  clock = 0
})

describe('construction', () => {
  it('pushes the stored preference into the player up front', () => {
    controller(false)
    expect(player.enabled).toBe(false)
    expect(player.volume).toBe(0.7)
  })
})

describe('unlock gate', () => {
  it('suppresses asynchronous cues until a gesture armed audio', () => {
    const sfx = controller()
    expect(sfx.playAsync('complete')).toBeNull()
    expect(player.cues()).toEqual([])
  })

  it('does not queue the suppressed cue for later', () => {
    const sfx = controller()
    sfx.playAsync('complete')
    sfx.playGesture('send')
    expect(player.cues()).toEqual(['send'])
  })

  it('lets asynchronous cues through once unlocked', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.playAsync('complete')
    expect(player.cues()).toEqual(['complete'])
    expect(player.unlockCount).toBe(1)
  })

  it('resumes the context only once across repeated gestures', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.unlock()
    sfx.unlock()
    expect(player.unlockCount).toBe(1)
    expect(sfx.isUnlocked()).toBe(true)
  })

  it('stays silent while disabled, gesture or not', () => {
    const sfx = controller(false)
    expect(sfx.playGesture('send')).toBeNull()
    expect(player.cues()).toEqual([])
  })
})

describe('cooldown', () => {
  it('collapses a burst of the same outcome from parallel sessions', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.playAsync('complete')
    sfx.playAsync('complete')
    sfx.playAsync('complete')
    expect(player.cues()).toEqual(['complete'])
  })

  it('lets the cue through again once the window passes', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.playAsync('complete')
    clock += 500
    sfx.playAsync('complete')
    expect(player.cues()).toEqual(['complete', 'complete'])
  })

  it('plays once when a control answers both pointer and keyboard activation', () => {
    const sfx = controller()
    sfx.playGesture('send')  // click
    clock += 5
    sfx.playGesture('send')  // keydown on the same activation
    expect(player.cues()).toEqual(['send'])
  })

  it('still allows a deliberate second send', () => {
    const sfx = controller()
    sfx.playGesture('send')
    clock += 800
    sfx.playGesture('send')
    expect(player.cues()).toEqual(['send', 'send'])
  })

  it('never throttles typing', () => {
    const sfx = controller()
    for (let i = 0; i < 5; i++) sfx.playGesture('typing')
    expect(player.cues()).toEqual(['typing', 'typing', 'typing', 'typing', 'typing'])
  })
})

describe('loops', () => {
  it('starts at most one voice per process however often it is asked', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)
    sfx.setLoop('transport', 'connecting', true)
    sfx.setLoop('transport', 'connecting', true)
    expect(player.cues()).toEqual(['connecting'])
    expect(player.played[0].options).toEqual({ loop: true })
  })

  it('stops the loop when the process ends', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)
    sfx.setLoop('transport', 'connecting', false)
    expect(player.liveLoops()).toEqual([])
  })

  it('clears the handle so a later start works again', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)
    sfx.setLoop('transport', 'connecting', false)
    sfx.setLoop('transport', 'connecting', true)
    expect(player.cues()).toEqual(['connecting', 'connecting'])
    expect(player.liveLoops()).toHaveLength(1)
  })

  it('refuses to start a loop that would be inaudible and invisible', () => {
    const locked = controller()
    locked.setLoop('transport', 'connecting', true)
    expect(player.cues()).toEqual([])

    const muted = controller(false)
    muted.unlock()
    muted.setLoop('transport', 'connecting', true)
    expect(player.cues()).toEqual([])
  })

  it('survives a player that hands back no handle', () => {
    const sfx = controller()
    sfx.unlock()
    player.returnsNull = true
    sfx.setLoop('transport', 'connecting', true)
    expect(() => sfx.stopLoop('transport')).not.toThrow()
  })

  it('stops every loop on explicit teardown', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)
    sfx.stopAllLoops()
    expect(player.liveLoops()).toEqual([])
  })
})

describe('mute', () => {
  it('silences running loops and tails before the player mutes', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)

    sfx.setEnabled(false)

    expect(player.liveLoops()).toEqual([])
    expect(player.stopAllCount).toBe(1)
    expect(player.enabled).toBe(false)
    expect(sfx.isEnabled()).toBe(false)
  })

  it('does not resurrect the loop when sound comes back', () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)
    sfx.setEnabled(false)
    sfx.setEnabled(true)
    expect(player.liveLoops()).toEqual([])
  })

  it('forwards volume and pack changes', () => {
    const sfx = controller()
    sfx.setVolume(0.4)
    sfx.setPack('minimal')
    expect(player.volume).toBe(0.4)
    expect(player.pack).toBe('minimal')
  })
})

describe('destroy', () => {
  it('stops loops, kills voices and disposes the player once', async () => {
    const sfx = controller()
    sfx.unlock()
    sfx.setLoop('transport', 'connecting', true)

    await sfx.destroy()
    await sfx.destroy()

    expect(player.liveLoops()).toEqual([])
    expect(player.destroyed).toBe(true)
    expect(player.stopAllCount).toBe(1)
  })

  it('goes quiet after disposal instead of throwing', async () => {
    const sfx = controller()
    sfx.unlock()
    await sfx.destroy()
    expect(sfx.playGesture('send')).toBeNull()
    sfx.setLoop('transport', 'connecting', true)
    expect(player.cues()).toEqual([])
  })
})
