import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const emptyState = (): SessionState => ({
  session: { id: 'ctx-session', messages: [], lastMessageAt: 1 } as never,
  streaming: null,
})

const reading = (tokens: number | null, percent: number | null) => ({
  tokens,
  contextWindow: 1_000_000,
  percent,
  breakdown: { systemTokens: 772, toolsTokens: 1918, messageTokens: 7 },
})

describe('context_usage', () => {
  it('stores the reading whole on the session', () => {
    const event: AgentEvent = {
      type: 'context_usage',
      sessionId: 'ctx-session',
      contextUsage: reading(2936, 0.2936),
    }

    const { state } = processEvent(emptyState(), event)

    expect(state.session.contextUsage).toEqual(reading(2936, 0.2936))
  })

  it('replaces the previous reading rather than merging it', () => {
    let state = emptyState()
    state = processEvent(state, {
      type: 'context_usage',
      sessionId: 'ctx-session',
      contextUsage: reading(2936, 0.2936),
    }).state

    // A compaction leaves occupancy unknown until the next response; the stale
    // number must not survive underneath.
    state = processEvent(state, {
      type: 'context_usage',
      sessionId: 'ctx-session',
      contextUsage: reading(null, null),
    }).state

    expect(state.session.contextUsage?.tokens).toBeNull()
    expect(state.session.contextUsage?.percent).toBeNull()
  })

  it('leaves the billing figures in tokenUsage untouched', () => {
    const start: SessionState = {
      session: {
        id: 'ctx-session',
        messages: [],
        lastMessageAt: 1,
        tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, contextTokens: 0, costUsd: 1 },
      } as never,
      streaming: null,
    }

    const { state } = processEvent(start, {
      type: 'context_usage',
      sessionId: 'ctx-session',
      contextUsage: reading(2936, 0.2936),
    })

    expect(state.session.tokenUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      contextTokens: 0,
      costUsd: 1,
    })
  })
})
