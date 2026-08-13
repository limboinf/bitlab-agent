/**
 * The selection tiers are what replaced `connectionLocked`, so the properties
 * that used to be enforced by a lock are pinned here instead:
 *
 *  - a session that ran keeps running what it ran, even as defaults move;
 *  - a blank session tracks a default saved after it was created;
 *  - an explicit choice outranks the log, because it is the later act;
 *  - every tier answers as a WHOLE, so no connection is ever paired with
 *    another connection's model.
 */

import { describe, test, expect } from 'bun:test'
import type { Message } from '@bitlab/core/types'
import {
  crossesConnection,
  currentSelection,
  effectiveSelection,
  loggedSelection,
  sameRoute,
  type SelectionSource,
} from './model-selection'

function dispatched(connection: string, model: string, thinkingLevel?: string): Message {
  return {
    id: `m-${connection}-${model}`,
    role: 'user',
    content: 'hi',
    timestamp: 1,
    modelSelection: { connection, model, thinkingLevel },
  }
}

function source(overrides: Partial<SelectionSource> = {}): SelectionSource {
  return { messages: [], ...overrides }
}

describe('loggedSelection', () => {
  test('reads the most recent dispatched route', () => {
    const messages = [dispatched('a', 'm1'), dispatched('b', 'm2')]
    expect(loggedSelection(messages)).toMatchObject({ connection: 'b', model: 'm2' })
  })

  test('ignores messages that never drove a turn', () => {
    const messages: Message[] = [
      dispatched('a', 'm1'),
      { id: 'x', role: 'assistant', content: 'reply', timestamp: 2 },
    ]
    expect(loggedSelection(messages)).toMatchObject({ connection: 'a', model: 'm1' })
  })

  test('normalizes a legacy thinking level', () => {
    // 'think' is the pre-rename value; it must not leak through as-is.
    expect(loggedSelection([dispatched('a', 'm1', 'think')])?.thinkingLevel).toBe('medium')
  })

  test('drops an unrecognized thinking level rather than passing it on', () => {
    expect(loggedSelection([dispatched('a', 'm1', 'bogus')])?.thinkingLevel).toBeUndefined()
  })

  test('returns undefined when nothing was dispatched', () => {
    expect(loggedSelection([])).toBeUndefined()
  })
})

describe('currentSelection tiers', () => {
  test('an in-process pick wins over everything', () => {
    const result = currentSelection(
      source({
        pickedSelection: { connection: 'picked', model: 'pm' },
        llmConnection: 'explicit',
        messages: [dispatched('logged', 'lm')],
      }),
      'ws-default',
    )
    expect(result).toMatchObject({ connection: 'picked', model: 'pm' })
  })

  test('an explicit persisted choice outranks the log', () => {
    // Choosing after a turn ran is the later act; the log must not undo it.
    const result = currentSelection(
      source({ llmConnection: 'explicit', model: 'em', messages: [dispatched('logged', 'lm')] }),
      'ws-default',
    )
    expect(result).toMatchObject({ connection: 'explicit', model: 'em' })
  })

  test('a session that ran keeps its route when the workspace default moves', () => {
    // The whole point of the log tier: existing history is never re-routed by
    // a default that changed underneath it.
    const result = currentSelection(
      source({ messages: [dispatched('ran-under', 'rm')] }),
      'new-default',
    )
    expect(result).toMatchObject({ connection: 'ran-under', model: 'rm' })
  })

  test('a blank unnamed session tracks a default saved after it was created', () => {
    const result = currentSelection(source(), 'saved-later')
    expect(result.connection).toBe('saved-later')
    expect(result.model).toBeUndefined()
  })

  test('tiers resolve as a whole — a connection never inherits another one\'s model', () => {
    // The explicit tier names only a connection. If tiers fell back field by
    // field, the logged model 'lm' (which belongs to 'logged') would be paired
    // with connection 'explicit' and sent somewhere it does not exist.
    const result = currentSelection(
      source({ llmConnection: 'explicit', messages: [dispatched('logged', 'lm')] }),
      'ws-default',
    )
    expect(result.connection).toBe('explicit')
    expect(result.model).toBeUndefined()
  })

  test('a session-level thinking level overrides the logged one', () => {
    const result = currentSelection(
      source({ thinkingLevel: 'high', messages: [dispatched('a', 'm', 'low')] }),
    )
    expect(result.thinkingLevel).toBe('high')
  })
})

describe('effectiveSelection', () => {
  test('a running turn keeps its snapshot even after current moves', () => {
    // This is the property that made the lock unnecessary: switching mid-turn
    // cannot re-route the turn that is already assembling.
    const snapshot = { connection: 'snapshotted', model: 'sm' }
    const result = effectiveSelection(
      source({ pickedSelection: { connection: 'switched-to', model: 'nm' } }),
      snapshot,
      'ws-default',
    )
    expect(result).toBe(snapshot)
  })

  test('no snapshot resolves through the tiers', () => {
    const result = effectiveSelection(
      source({ pickedSelection: { connection: 'picked', model: 'pm' } }),
      undefined,
      'ws-default',
    )
    expect(result).toMatchObject({ connection: 'picked', model: 'pm' })
  })
})

describe('route comparison', () => {
  test('sameRoute ignores the thinking level', () => {
    expect(sameRoute(
      { connection: 'a', model: 'm', thinkingLevel: 'low' },
      { connection: 'a', model: 'm', thinkingLevel: 'max' },
    )).toBe(true)
  })

  test('sameRoute separates different models on one connection', () => {
    expect(sameRoute({ connection: 'a', model: 'm1' }, { connection: 'a', model: 'm2' })).toBe(false)
  })

  test('crossesConnection is false for a model swap within one connection', () => {
    // A same-connection swap retargets the live backend; only a connection
    // change forces the restart that costs context.
    expect(crossesConnection({ connection: 'a', model: 'm1' }, { connection: 'a', model: 'm2' })).toBe(false)
  })

  test('crossesConnection is true when the connection changes', () => {
    expect(crossesConnection({ connection: 'a', model: 'm' }, { connection: 'b', model: 'm' })).toBe(true)
  })
})
