import { describe, expect, it } from 'bun:test'
import type { LlmRequestMetrics, Message } from '@bitlab/core/types'
import {
  applyRequestCompleted,
  applyRequestStarted,
  beginRun,
  bindMessageToRequest,
  findRun,
  markStaleRunsInterrupted,
  sanitizeTranscriptMetrics,
  settleRun,
  trimTranscriptMetricsForBranch,
} from './run-metrics.ts'

/** A clock the test drives by hand, so durations are exact. */
function makeClock(startMono = 0, startWall = 1_700_000_000_000) {
  let mono = startMono
  let wall = startWall
  return {
    clock: { now: () => wall, monotonic: () => mono },
    advance(ms: number) { mono += ms; wall += ms },
  }
}

function userMessage(id = 'user-1'): Message {
  return { id, role: 'user', content: 'hello', timestamp: 1 }
}

function sampled(requestId: string, overrides: Partial<LlmRequestMetrics> = {}): LlmRequestMetrics {
  return {
    requestId,
    sequence: 1,
    measurement: 'sdk-call-v1',
    status: 'completed',
    startedAt: 1,
    messageIds: [],
    toolUseIds: [],
    ...overrides,
  }
}

describe('run lifecycle', () => {
  it('attaches the run to the user message that triggered it', () => {
    const owner = userMessage()
    const { clock } = makeClock()
    const active = beginRun(owner, clock)

    expect(owner.agentRuns).toHaveLength(1)
    expect(owner.agentRuns?.[0]?.status).toBe('running')
    expect(owner.executionRef).toEqual({ runId: active.runId })
  })

  it('appends a second run on re-execution instead of overwriting the first', () => {
    const owner = userMessage()
    const { clock } = makeClock()
    const first = beginRun(owner, clock)
    const second = beginRun(owner, clock)

    expect(owner.agentRuns?.map(run => run.runId)).toEqual([first.runId, second.runId])
  })

  it('numbers calls by run order, not by what the sampler guessed', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a', { sequence: 99 }))
    applyRequestCompleted(messages, active, sampled('a', { sequence: 99, durationMs: 10 }))
    applyRequestStarted(messages, active, sampled('b', { sequence: 99 }))

    expect(findRun(messages, active.runId)?.run.requests.map(item => item.sequence)).toEqual([1, 2])
  })

  it('binds produced messages to the call that was open', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a'))
    bindMessageToRequest(messages, active, 'think-1')
    bindMessageToRequest(messages, active, 'text-1')
    applyRequestCompleted(messages, active, sampled('a', { durationMs: 500, outputTokens: 40 }))

    const request = findRun(messages, active.runId)?.run.requests[0]
    expect(request?.messageIds).toEqual(['think-1', 'text-1'])
    expect(request?.outputTokens).toBe(40)
  })

  it('binds nothing once the call has settled', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a'))
    applyRequestCompleted(messages, active, sampled('a', { durationMs: 5 }))
    bindMessageToRequest(messages, active, 'tool-message')

    expect(findRun(messages, active.runId)?.run.requests[0]?.messageIds).toEqual([])
  })

  it('refuses to move a settled call to another terminal state', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a'))
    applyRequestCompleted(messages, active, sampled('a', { status: 'error', durationMs: 5 }))
    applyRequestCompleted(messages, active, sampled('a', { status: 'completed', durationMs: 900 }))

    const request = findRun(messages, active.runId)?.run.requests[0]
    expect(request?.status).toBe('error')
    expect(request?.durationMs).toBe(5)
  })

  it('measures the run total across tools and approvals, and bumps the revision', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock, advance } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a'))
    advance(2_000)
    applyRequestCompleted(messages, active, sampled('a', { durationMs: 2_000 }))
    advance(54_000) // tool execution + an approval wait
    const settled = settleRun(messages, active, 'completed', clock)

    expect(settled?.durationMs).toBe(56_000)
    expect(settled?.status).toBe('completed')
    expect(settled?.revision).toBeGreaterThan(1)
  })

  it('settles as cancelled and closes the open call when the user stops it', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock, advance } = makeClock()
    const active = beginRun(owner, clock)

    applyRequestStarted(messages, active, sampled('a'))
    active.abortRequested = true
    advance(300)
    const settled = settleRun(messages, active, 'completed', clock)

    expect(settled?.status).toBe('aborted')
    expect(settled?.requests[0]?.status).toBe('aborted')
  })

  it('settles once; a second call changes nothing', () => {
    const owner = userMessage()
    const messages = [owner]
    const { clock, advance } = makeClock()
    const active = beginRun(owner, clock)

    advance(1_000)
    settleRun(messages, active, 'completed', clock)
    advance(9_000)
    const again = settleRun(messages, active, 'error', clock)

    expect(again?.durationMs).toBe(1_000)
    expect(again?.status).toBe('completed')
  })
})

describe('recovery', () => {
  it('marks a run left running by a dead process as interrupted, with no invented end time', () => {
    const owner = userMessage()
    const { clock } = makeClock()
    const active = beginRun(owner, clock)
    applyRequestStarted([owner], active, sampled('a'))

    expect(markStaleRunsInterrupted([owner])).toBe(true)

    const run = owner.agentRuns?.[0]
    expect(run?.status).toBe('interrupted')
    expect(run?.requests[0]?.status).toBe('interrupted')
    expect(run?.endedAt).toBeUndefined()
    expect(run?.durationMs).toBeUndefined()
  })

  it('is idempotent: a second load changes nothing', () => {
    const owner = userMessage()
    const { clock } = makeClock()
    beginRun(owner, clock)
    markStaleRunsInterrupted([owner])
    const revision = owner.agentRuns?.[0]?.revision

    expect(markStaleRunsInterrupted([owner])).toBe(false)
    expect(owner.agentRuns?.[0]?.revision).toBe(revision as number)
  })

  it('drops a run whose schema this build does not understand, keeping the message', () => {
    const owner = { ...userMessage(), agentRuns: [{ schemaVersion: 7, runId: 'x' }] } as unknown as Message
    sanitizeTranscriptMetrics([owner])

    expect(owner.agentRuns).toBeUndefined()
    expect(owner.content).toBe('hello')
  })
})

describe('branch trimming', () => {
  it('rebuilds metrics from the kept prefix without touching the source', () => {
    const owner = userMessage()
    const { clock } = makeClock()
    const active = beginRun(owner, clock)
    const messages: Message[] = [owner]
    applyRequestStarted(messages, active, sampled('q1'))
    bindMessageToRequest(messages, active, 'text-1')
    applyRequestCompleted(messages, active, sampled('q1', { durationMs: 1_000 }))
    applyRequestStarted(messages, active, sampled('q2'))
    bindMessageToRequest(messages, active, 'text-2')
    applyRequestCompleted(messages, active, sampled('q2', { durationMs: 2_000 }))
    settleRun(messages, active, 'completed', clock)

    const transcript: Message[] = [
      owner,
      { id: 'text-1', role: 'assistant', content: 'a', timestamp: 2 },
      { id: 'text-2', role: 'assistant', content: 'b', timestamp: 3 },
    ]
    const before = JSON.stringify(transcript)
    const branched = trimTranscriptMetricsForBranch(transcript.slice(0, 2))

    expect(branched[0]?.agentRuns?.[0]?.requests.map(item => item.requestId)).toEqual(['q1'])
    expect(branched[0]?.agentRuns?.[0]?.coverage).toBe('branch-prefix')
    expect(JSON.stringify(transcript)).toBe(before)
  })
})
