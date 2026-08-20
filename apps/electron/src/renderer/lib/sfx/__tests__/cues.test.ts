import { describe, expect, it } from 'bun:test'
import { cueNames, getPlaybackMode, packNames, renderRecipe, createRecipe } from 'uisfx'
import { SFX_PACK } from '../cues'
import {
  PERMISSION_REQUEST_CUE,
  SESSION_DELETED_CUE,
  permissionResponseCue,
  submitCue,
  transportSfx,
  turnOutcomeCue,
} from '../cues'

describe('turn outcome cues', () => {
  it('maps each turn ending to the cue that describes what happened', () => {
    expect(turnOutcomeCue('complete')).toBe('complete')
    expect(turnOutcomeCue('error')).toBe('error')
    expect(turnOutcomeCue('typed_error')).toBe('error')
    expect(turnOutcomeCue('interrupted')).toBe('stop')
  })

  it('stays silent for events that do not end a turn', () => {
    for (const event of ['text_delta', 'tool_start', 'status', 'name_changed', 'usage_update']) {
      expect(turnOutcomeCue(event)).toBeNull()
    }
  })
})

describe('submit cue', () => {
  it('distinguishes a started turn from a queued one', () => {
    expect(submitCue(false)).toBe('send')
    expect(submitCue(true)).toBe('queued')
  })
})

describe('approval cues', () => {
  it('announces a pause that needs review', () => {
    expect(PERMISSION_REQUEST_CUE).toBe('warning')
  })

  it('picks the cue from the decision, not from the button', () => {
    expect(permissionResponseCue(true)).toBe('unlock')
    expect(permissionResponseCue(false)).toBe('cancel')
  })

  it('commits deletion with the destructive cue', () => {
    expect(SESSION_DELETED_CUE).toBe('delete')
  })
})

describe('transport cues', () => {
  it('never sounds for local transports', () => {
    expect(transportSfx(null, 'reconnecting', 'local')).toEqual({ loop: false, cue: null })
    expect(transportSfx('reconnecting', 'connected', 'local')).toEqual({ loop: false, cue: null })
  })

  it('loops while connecting and stops with an outcome', () => {
    expect(transportSfx('connected', 'reconnecting', 'remote')).toEqual({ loop: true, cue: null })
    expect(transportSfx('reconnecting', 'connected', 'remote')).toEqual({ loop: false, cue: 'connect' })
    expect(transportSfx('reconnecting', 'failed', 'remote')).toEqual({ loop: false, cue: 'disconnect' })
    expect(transportSfx('connected', 'disconnected', 'remote')).toEqual({ loop: false, cue: 'disconnect' })
  })

  it('says nothing on the first successful connect', () => {
    expect(transportSfx(null, 'connected', 'remote')).toEqual({ loop: false, cue: null })
    expect(transportSfx('idle', 'connected', 'remote')).toEqual({ loop: false, cue: null })
  })

  it('keeps the loop running without re-announcing on repeated states', () => {
    expect(transportSfx('reconnecting', 'reconnecting', 'remote')).toEqual({ loop: true, cue: null })
    expect(transportSfx('connected', 'connected', 'remote')).toEqual({ loop: false, cue: null })
  })
})

describe('catalog agreement', () => {
  const used = [
    'send', 'queued', 'complete', 'error', 'stop', 'warning', 'unlock', 'cancel',
    'delete', 'connect', 'disconnect', 'connecting', 'typing', 'toggle-on',
    'toggle-off', 'volume-change',
  ] as const

  it('uses the pack we actually shipped', () => {
    expect(packNames).toContain(SFX_PACK)
  })

  it('only names cues the catalog defines', () => {
    for (const cue of used) expect(cueNames).toContain(cue)
  })

  it('loops only the cue the catalog says is a loop', () => {
    expect(getPlaybackMode('connecting')).toBe('loop')
    for (const cue of used.filter(c => c !== 'connecting')) {
      expect(getPlaybackMode(cue)).toBe('one-shot')
    }
  })

  it('renders audible audio for every cue we reference', () => {
    for (const cue of used) {
      const rendered = renderRecipe(createRecipe(SFX_PACK, cue))
      expect(rendered.duration).toBeGreaterThan(0)
      expect(rendered.peak).toBeGreaterThan(0)
    }
  })
})
