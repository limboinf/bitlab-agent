/**
 * How grouped turns pick up the execution metrics of the run they belong to.
 */

import { describe, it, expect } from 'bun:test'
import type { AgentRunMetrics, Message } from '@bitlab/core'
import { groupMessagesByTurn, type AssistantTurn } from '../turn-utils'

function run(runId: string, durationMs: number): AgentRunMetrics {
  return {
    schemaVersion: 1,
    runId,
    revision: 3,
    status: 'completed',
    coverage: 'full',
    startedAt: 1_000,
    durationMs,
    requests: [],
  }
}

function assistantTurns(messages: Message[]): AssistantTurn[] {
  return groupMessagesByTurn(messages, { isSessionProcessing: false })
    .filter((turn): turn is AssistantTurn => turn.type === 'assistant')
}

describe('turn run metrics', () => {
  it('carries the run of the user message that started the turn', () => {
    const turns = assistantTurns([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1, agentRuns: [run('run-1', 56_000)] },
      { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2, executionRef: { runId: 'run-1' } },
    ])

    expect(turns[0]?.runMetrics?.runId).toBe('run-1')
    expect(turns[0]?.runMetrics?.durationMs).toBe(56_000)
  })

  it('uses the newest run when a message was executed twice', () => {
    const turns = assistantTurns([
      {
        id: 'u1',
        role: 'user',
        content: 'hi',
        timestamp: 1,
        agentRuns: [run('run-1', 10_000), run('run-2', 20_000)],
      },
      { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2 },
    ])

    expect(turns[0]?.runMetrics?.runId).toBe('run-2')
  })

  it('shows one run once, on the last card it split into', () => {
    // A steered message joins the run in flight and splits the transcript into
    // two cards; repeating the same total on both would read as two turns.
    const turns = assistantTurns([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1, agentRuns: [run('run-1', 56_000)] },
      { id: 'a1', role: 'assistant', content: 'first', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'actually…', timestamp: 3, executionRef: { runId: 'run-1' } },
      { id: 'a2', role: 'assistant', content: 'second', timestamp: 4 },
    ])

    expect(turns.map(turn => turn.runMetrics?.runId)).toEqual([undefined, 'run-1'])
  })

  it('does not lend a run to the turn after a queued message', () => {
    const turns = assistantTurns([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1, agentRuns: [run('run-1', 5_000)] },
      { id: 'a1', role: 'assistant', content: 'first', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'next', timestamp: 3 },
      { id: 'a2', role: 'assistant', content: 'second', timestamp: 4 },
    ])

    expect(turns.map(turn => turn.runMetrics?.runId)).toEqual(['run-1', undefined])
  })

  it('leaves old transcripts without metrics rather than faking them', () => {
    const turns = assistantTurns([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hello', timestamp: 2 },
    ])

    expect(turns[0]?.runMetrics).toBeUndefined()
  })

  it('keeps the entry on a turn that only ran tools', () => {
    const turns = assistantTurns([
      { id: 'u1', role: 'user', content: 'hi', timestamp: 1, agentRuns: [run('run-1', 3_000)] },
      {
        id: 't1',
        role: 'tool',
        content: '',
        timestamp: 2,
        toolName: 'read',
        toolUseId: 'tool-1',
        toolStatus: 'completed',
        toolResult: 'ok',
      },
    ])

    expect(turns[0]?.response).toBeUndefined()
    expect(turns[0]?.runMetrics?.runId).toBe('run-1')
  })
})
