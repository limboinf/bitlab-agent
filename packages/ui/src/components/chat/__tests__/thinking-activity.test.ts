/**
 * Reasoning blocks must group into the turn as their own activity type, so the
 * turn card renders them as thinking steps rather than as model commentary —
 * and never mistakes one for the final answer.
 */

import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'
import type { Message } from '@bitlab/core'

function thinking(content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'think-1',
    role: 'assistant',
    content,
    timestamp: 200,
    isIntermediate: true,
    isThinking: true,
    turnId: 'pi-turn-1__t0',
    ...overrides,
  }
}

const user: Message = { id: 'u1', role: 'user', content: 'hi', timestamp: 100 }

describe('thinking activities', () => {
  it('groups a thinking message as a thinking activity, not commentary', () => {
    const turns = groupMessagesByTurn([
      user,
      thinking('Let me reason about this'),
      {
        id: 'a1',
        role: 'assistant',
        content: 'The answer',
        timestamp: 300,
        turnId: 'pi-turn-1__m0',
      },
    ])

    const turn = turns[1] as AssistantTurn
    expect(turn.type).toBe('assistant')
    expect(turn.activities).toHaveLength(1)
    expect(turn.activities[0].type).toBe('thinking')
    expect(turn.activities[0].content).toBe('Let me reason about this')
    expect(turn.response?.text).toBe('The answer')
  })

  it('marks a streaming thinking block as running', () => {
    const turns = groupMessagesByTurn(
      [user, thinking('Halfway through', { isStreaming: true })],
      { isSessionProcessing: true }
    )

    const turn = turns[1] as AssistantTurn
    expect(turn.activities[0].status).toBe('running')
  })

  it('never promotes reasoning to the turn response', () => {
    // Turn ends on reasoning with no answer text (interrupted mid-flight).
    // The "promote last intermediate to response" path must skip thinking —
    // reasoning is not an answer to show as the model's reply.
    const turns = groupMessagesByTurn(
      [user, thinking('Reasoning that never became an answer')],
      { isSessionProcessing: false }
    )

    const turn = turns[1] as AssistantTurn
    expect(turn.response).toBeUndefined()
    expect(turn.activities[0].type).toBe('thinking')
  })
})
