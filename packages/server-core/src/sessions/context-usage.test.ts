import { describe, expect, it } from 'bun:test'
import { resolveContextUsage } from './context-usage.ts'
import type { ContextUsageReading } from '@bitlab/core'

const LIVE: ContextUsageReading = {
  tokens: 94_700,
  contextWindow: 1_048_576,
  percent: 9.03,
  breakdown: { systemTokens: 6500, toolsTokens: 46_100, messageTokens: 6900, skillsTokens: 120 },
}

describe('resolveContextUsage', () => {
  it('prefers a live agent reading, composition included', () => {
    expect(resolveContextUsage({
      live: LIVE,
      contextTokens: 1,
      contextWindow: 2,
    })).toBe(LIVE)
  })

  it('reconstructs occupancy from durable state when no agent is running', () => {
    // The case that used to render nothing at all: a reopened session whose
    // subprocess has not been spawned yet.
    const reading = resolveContextUsage({
      live: undefined,
      contextTokens: 94_700,
      contextWindow: 1_048_576,
    })

    expect(reading).toEqual({
      tokens: 94_700,
      contextWindow: 1_048_576,
      percent: (94_700 / 1_048_576) * 100,
    })
  })

  it('omits composition rather than inventing or replaying one', () => {
    const reading = resolveContextUsage({
      live: undefined,
      contextTokens: 94_700,
      contextWindow: 131_072,
    })

    expect(reading?.breakdown).toBeUndefined()
  })

  it('reports nothing for a session that has never been measured', () => {
    // Zero would look authoritative while being badly wrong — the first request
    // already carries a system prompt and every tool definition.
    expect(resolveContextUsage({
      live: undefined,
      contextTokens: 0,
      contextWindow: 1_048_576,
    })).toBeUndefined()
  })

  it('reports nothing when no window can be resolved', () => {
    expect(resolveContextUsage({
      live: undefined,
      contextTokens: 94_700,
      contextWindow: undefined,
    })).toBeUndefined()
  })

  it('reflects a window resolved after a model swap, not the one last reported', () => {
    // Caller resolves the window from current config; a bigger model swapped in
    // while the app was closed must lower the percentage, not keep the old one.
    const reading = resolveContextUsage({
      live: undefined,
      contextTokens: 94_700,
      contextWindow: 1_048_576,
    })

    expect(reading?.percent).toBeLessThan(10)
  })
})
