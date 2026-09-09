import { describe, expect, it } from 'bun:test'
import type { AgentRunMetrics, LlmRequestMetrics } from '../../types/execution-metrics.ts'
import {
  deriveRunMetrics,
  isThroughputSample,
  sanitizeRunMetrics,
  trimRunMetricsForBranch,
} from '../execution-metrics.ts'

function request(overrides: Partial<LlmRequestMetrics> & { requestId: string; sequence: number }): LlmRequestMetrics {
  return {
    measurement: 'sdk-call-v1',
    status: 'completed',
    startedAt: 1_000_000,
    messageIds: [],
    toolUseIds: [],
    ...overrides,
  }
}

function run(requests: LlmRequestMetrics[], overrides: Partial<AgentRunMetrics> = {}): AgentRunMetrics {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 1,
    status: 'completed',
    coverage: 'full',
    startedAt: 1_000_000,
    durationMs: 56_000,
    requests,
    ...overrides,
  }
}

describe('deriveRunMetrics', () => {
  it('reports total time, first-call TTFT and throughput', () => {
    const summary = deriveRunMetrics(run([
      request({ requestId: 'a', sequence: 1, ttftMs: 600, decodeMs: 53_000, outputTokens: 6_360, durationMs: 53_600 }),
    ]))

    expect(summary?.totalDurationMs).toBe(56_000)
    expect(summary?.ttftMs).toBe(600)
    expect(summary?.tokensPerSecond).toBeCloseTo(120, 6)
    expect(summary?.sampledRequests).toBe(1)
    expect(summary?.totalRequests).toBe(1)
  })

  it('weights throughput by tokens, not by averaging per-call rates', () => {
    // A: 100 tok in 1 s (100 tok/s). B: 900 tok in 3 s (300 tok/s).
    // Averaging the rates gives 200; the honest answer is 1000 tok / 4 s.
    const summary = deriveRunMetrics(run([
      request({ requestId: 'a', sequence: 1, decodeMs: 1_000, outputTokens: 100 }),
      request({ requestId: 'b', sequence: 2, decodeMs: 3_000, outputTokens: 900 }),
    ]))

    expect(summary?.tokensPerSecond).toBeCloseTo(250, 6)
  })

  it('keeps the turn TTFT unknown when the FIRST call recorded none', () => {
    const summary = deriveRunMetrics(run([
      request({ requestId: 'a', sequence: 1, status: 'error' }),
      request({ requestId: 'b', sequence: 2, ttftMs: 400, decodeMs: 1_000, outputTokens: 100 }),
    ]))

    expect(summary?.ttftMs).toBeUndefined()
  })

  it('excludes failed and cancelled calls from the throughput sample', () => {
    const summary = deriveRunMetrics(run([
      request({ requestId: 'a', sequence: 1, status: 'aborted', decodeMs: 1_000, outputTokens: 5_000 }),
      request({ requestId: 'b', sequence: 2, decodeMs: 1_000, outputTokens: 100, ttftMs: 10 }),
    ]))

    expect(summary?.tokensPerSecond).toBeCloseTo(100, 6)
    expect(summary?.sampledRequests).toBe(1)
    expect(summary?.totalRequests).toBe(2)
  })

  it('leaves throughput unknown when no call qualifies', () => {
    const summary = deriveRunMetrics(run([
      request({ requestId: 'a', sequence: 1, durationMs: 900 }),
    ]))

    expect(summary?.tokensPerSecond).toBeUndefined()
    expect(summary?.totalDurationMs).toBe(56_000)
  })

  it('accepts a zero-token sample rather than dropping it', () => {
    expect(isThroughputSample(request({ requestId: 'a', sequence: 1, decodeMs: 500, outputTokens: 0 }))).toBe(true)
  })

  it('marks a branch-truncated run as partial', () => {
    const summary = deriveRunMetrics(run([request({ requestId: 'a', sequence: 1 })], {
      coverage: 'branch-prefix',
      durationMs: undefined,
    }))

    expect(summary?.isPartial).toBe(true)
    expect(summary?.totalDurationMs).toBeUndefined()
  })
})

describe('sanitizeRunMetrics', () => {
  it('drops NaN, Infinity and negative readings instead of rendering them', () => {
    const cleaned = sanitizeRunMetrics({
      ...run([request({ requestId: 'a', sequence: 1 })]),
      durationMs: Number.NaN,
      requests: [{
        ...request({ requestId: 'a', sequence: 1 }),
        ttftMs: Number.POSITIVE_INFINITY,
        decodeMs: -5,
        outputTokens: Number.NaN,
      }],
    })

    expect(cleaned?.durationMs).toBeUndefined()
    expect(cleaned?.requests[0]?.ttftMs).toBeUndefined()
    expect(cleaned?.requests[0]?.decodeMs).toBeUndefined()
    expect(cleaned?.requests[0]?.outputTokens).toBeUndefined()
  })

  it('refuses an unknown schema rather than guessing a migration', () => {
    expect(sanitizeRunMetrics({ ...run([]), schemaVersion: 2 })).toBeUndefined()
  })
})

describe('trimRunMetricsForBranch', () => {
  const source = run([
    request({ requestId: 'q1', sequence: 1, messageIds: ['think-1', 'text-1'], toolUseIds: ['tool-1'], durationMs: 1_000, outputTokens: 100, decodeMs: 900 }),
    request({ requestId: 'q2', sequence: 2, messageIds: ['think-2', 'text-2'], durationMs: 2_000, outputTokens: 200, decodeMs: 1_900 }),
  ])

  it('keeps calls fully contained in the prefix and drops later ones', () => {
    const trimmed = trimRunMetricsForBranch(source, {
      messageIds: new Set(['think-1', 'text-1']),
      toolUseIds: new Set(['tool-1']),
    })

    expect(trimmed?.requests.map(item => item.requestId)).toEqual(['q1'])
    expect(trimmed?.requests[0]?.durationMs).toBe(1_000)
    expect(trimmed?.coverage).toBe('branch-prefix')
    // The original execution ran past the cut, so its total no longer applies.
    expect(trimmed?.durationMs).toBeUndefined()
    expect(trimmed?.endedAt).toBeUndefined()
  })

  it('strips readings from a call cut between its reasoning and its answer', () => {
    const trimmed = trimRunMetricsForBranch(source, {
      messageIds: new Set(['think-1', 'text-1', 'think-2']),
      toolUseIds: new Set(['tool-1']),
    })

    const partial = trimmed?.requests.find(item => item.requestId === 'q2')
    expect(partial?.messageIds).toEqual(['think-2'])
    expect(partial?.durationMs).toBeUndefined()
    expect(partial?.outputTokens).toBeUndefined()
    expect(partial?.status).toBe('interrupted')
  })

  it('leaves the source untouched, nested arrays included', () => {
    const before = JSON.stringify(source)
    const trimmed = trimRunMetricsForBranch(source, {
      messageIds: new Set(['think-1', 'text-1']),
      toolUseIds: new Set(['tool-1']),
    })
    trimmed?.requests[0]?.messageIds.push('mutated')

    expect(JSON.stringify(source)).toBe(before)
  })

  it('keeps a whole run whole when the cut is past its end', () => {
    const trimmed = trimRunMetricsForBranch(source, {
      messageIds: new Set(['think-1', 'text-1', 'think-2', 'text-2']),
      toolUseIds: new Set(['tool-1']),
    })

    expect(trimmed?.coverage).toBe('full')
    expect(trimmed?.durationMs).toBe(56_000)
    expect(trimmed?.requests).toHaveLength(2)
  })

  it('keeps a text-less call only when a later kept call proves it finished', () => {
    const withEmpty = run([
      request({ requestId: 'q0', sequence: 1, durationMs: 300 }),
      request({ requestId: 'q1', sequence: 2, messageIds: ['text-1'], durationMs: 1_000 }),
      request({ requestId: 'q9', sequence: 3, durationMs: 400 }),
    ])

    const trimmed = trimRunMetricsForBranch(withEmpty, {
      messageIds: new Set(['text-1']),
      toolUseIds: new Set(),
    })

    expect(trimmed?.requests.map(item => item.requestId)).toEqual(['q0', 'q1'])
  })
})
