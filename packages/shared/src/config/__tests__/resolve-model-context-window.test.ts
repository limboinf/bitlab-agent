import { describe, expect, it } from 'bun:test'
import { resolveModelContextWindow } from '../llm-connections.ts'
import type { LlmConnection } from '../llm-connections.ts'

type ConnectionInput = Pick<LlmConnection, 'providerType' | 'models' | 'piAuthProvider'>

const customEndpointConnection = (
  models: LlmConnection['models'],
): ConnectionInput => ({
  providerType: 'pi_compat',
  piAuthProvider: 'openai',
  models,
})

describe('resolveModelContextWindow', () => {
  it("reads the window off the connection's own model entry", () => {
    // The only place a hand-typed model's capabilities are recorded — the
    // shared catalog has never heard of this ID.
    const connection = customEndpointConnection([
      { id: 'stealth/ox-alpha', contextWindow: 1_048_576 } as never,
    ])

    expect(resolveModelContextWindow(connection, 'stealth/ox-alpha')).toBe(1_048_576)
  })

  it('returns undefined when the connection stores bare IDs and nothing else knows', () => {
    // Honest absence: the caller decides between a stale reading and none,
    // rather than being handed an invented default.
    const connection = customEndpointConnection(['stealth/ox-alpha'])

    expect(resolveModelContextWindow(connection, 'stealth/ox-alpha')).toBeUndefined()
  })

  it('ignores a model entry that carries no window', () => {
    const connection = customEndpointConnection([
      { id: 'stealth/ox-alpha', supportsImages: true } as never,
    ])

    expect(resolveModelContextWindow(connection, 'stealth/ox-alpha')).toBeUndefined()
  })

  it('does not answer for a model the connection does not list', () => {
    const connection = customEndpointConnection([
      { id: 'other/model', contextWindow: 999 } as never,
    ])

    expect(resolveModelContextWindow(connection, 'stealth/ox-alpha')).toBeUndefined()
  })

  it('returns undefined without a model ID', () => {
    expect(resolveModelContextWindow(undefined, undefined)).toBeUndefined()
  })

  it('tolerates a missing connection', () => {
    expect(resolveModelContextWindow(undefined, 'stealth/ox-alpha')).toBeUndefined()
  })
})
