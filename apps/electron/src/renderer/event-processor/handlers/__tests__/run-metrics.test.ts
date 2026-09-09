import { describe, expect, it } from 'bun:test'
import type { AgentRunMetrics } from '@bitlab/core/types'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'

const stateWithOwner = (agentRuns?: AgentRunMetrics[]): SessionState => ({
  session: {
    id: 'metrics-session',
    messages: [{ id: 'user-1', role: 'user', content: 'hi', timestamp: 1, ...(agentRuns ? { agentRuns } : {}) }],
    lastMessageAt: 1,
  } as never,
  streaming: null,
})

const run = (revision: number, durationMs?: number): AgentRunMetrics => ({
  schemaVersion: 1,
  runId: 'run-1',
  revision,
  status: durationMs === undefined ? 'running' : 'completed',
  coverage: 'full',
  startedAt: 1_000,
  ...(durationMs === undefined ? {} : { durationMs }),
  requests: [],
})

const event = (payload: AgentRunMetrics): AgentEvent => ({
  type: 'run_metrics_updated',
  sessionId: 'metrics-session',
  ownerMessageId: 'user-1',
  run: payload,
})

describe('run_metrics_updated', () => {
  it('attaches the run to its owner message', () => {
    const { state } = processEvent(stateWithOwner(), event(run(1)))

    expect(state.session.messages[0].agentRuns).toEqual([run(1)])
  })

  it('replaces an older revision with a newer one', () => {
    const { state } = processEvent(stateWithOwner([run(1)]), event(run(4, 56_000)))

    expect(state.session.messages[0].agentRuns?.[0].revision).toBe(4)
    expect(state.session.messages[0].agentRuns?.[0].durationMs).toBe(56_000)
  })

  it('ignores a snapshot that arrived out of order', () => {
    const { state } = processEvent(stateWithOwner([run(4, 56_000)]), event(run(2)))

    expect(state.session.messages[0].agentRuns?.[0].revision).toBe(4)
    expect(state.session.messages[0].agentRuns?.[0].durationMs).toBe(56_000)
  })

  it('is idempotent for a duplicate delivery of the same revision', () => {
    const first = processEvent(stateWithOwner([run(4, 56_000)]), event(run(4, 56_000))).state
    const second = processEvent(first, event(run(4, 56_000))).state

    expect(second.session.messages[0].agentRuns).toEqual([run(4, 56_000)])
  })

  it('routes to a user message this client still knows by its optimistic id', () => {
    // handleUserMessage deliberately keeps the optimistic id as the bubble's
    // identity, so a live turn's owner never carries the server's canonical id.
    // Matching only that id dropped every snapshot of a just-typed turn.
    const state: SessionState = {
      session: {
        id: 'metrics-session',
        messages: [{ id: 'optimistic-9', role: 'user', content: 'hi', timestamp: 1 }],
        lastMessageAt: 1,
      } as never,
      streaming: null,
    }

    const { state: next } = processEvent(state, {
      ...event(run(4, 56_000)),
      ownerMessageId: 'msg-server-canonical',
      ownerOptimisticMessageId: 'optimistic-9',
    } as AgentEvent)

    expect(next.session.messages[0].agentRuns?.[0].durationMs).toBe(56_000)
  })

  it('drops a snapshot whose owner has not loaded rather than inventing a message', () => {
    const { state } = processEvent(
      stateWithOwner(),
      { ...event(run(1)), ownerMessageId: 'not-here', ownerOptimisticMessageId: 'also-not-here' } as AgentEvent,
    )

    expect(state.session.messages).toHaveLength(1)
    expect(state.session.messages[0].agentRuns).toBeUndefined()
  })
})
