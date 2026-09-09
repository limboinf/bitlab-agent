import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentRunMetrics, Message } from '@bitlab/core/types'
import { messageToStored, storedToMessage } from '@bitlab/core/types'
import type { StoredSession } from '../types'
import { readSessionJsonl, writeSessionJsonl } from '../jsonl'

const tmpRoot = mkdtempSync(join(tmpdir(), 'bitlab-metrics-roundtrip-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

const run: AgentRunMetrics = {
  schemaVersion: 1,
  runId: 'run-1',
  revision: 4,
  status: 'completed',
  coverage: 'full',
  startedAt: 1_000_000,
  endedAt: 1_056_000,
  durationMs: 56_000,
  requests: [{
    requestId: 'req-1',
    sequence: 1,
    measurement: 'sdk-call-v1',
    status: 'completed',
    provider: 'openai',
    model: 'gpt-x',
    startedAt: 1_001_000,
    endedAt: 1_054_600,
    durationMs: 53_600,
    ttftMs: 600,
    decodeMs: 53_000,
    outputTokens: 6_360,
    finishReason: 'stop',
    messageIds: ['think-1', 'text-1'],
    toolUseIds: ['tool-1'],
  }],
}

function session(messages: Message[]): StoredSession {
  return {
    id: 'metrics-session',
    workspaceRootPath: tmpRoot,
    createdAt: 1,
    lastUsedAt: 2,
    messages: messages.map(messageToStored),
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      contextTokens: 0,
    },
  } as StoredSession
}

describe('execution metrics persistence', () => {
  it('survives Message → StoredMessage → JSONL → Message unchanged', () => {
    const file = join(tmpRoot, 'session.jsonl')
    const original: Message[] = [
      { id: 'user-1', role: 'user', content: 'hi', timestamp: 1, agentRuns: [run], executionRef: { runId: 'run-1' } },
      { id: 'text-1', role: 'assistant', content: 'answer', timestamp: 2, executionRef: { runId: 'run-1', requestId: 'req-1' } },
    ]

    writeSessionJsonl(file, session(original))
    const loaded = readSessionJsonl(file)?.messages.map(storedToMessage)

    expect(loaded?.[0]?.agentRuns).toEqual([run])
    expect(loaded?.[0]?.executionRef).toEqual({ runId: 'run-1' })
    expect(loaded?.[1]?.executionRef).toEqual({ runId: 'run-1', requestId: 'req-1' })
  })

  it('loads a transcript that predates the feature without inventing readings', () => {
    const file = join(tmpRoot, 'legacy.jsonl')
    writeSessionJsonl(file, session([
      { id: 'user-1', role: 'user', content: 'hi', timestamp: 1 },
      { id: 'text-1', role: 'assistant', content: 'answer', timestamp: 2 },
    ]))

    const loaded = readSessionJsonl(file)?.messages.map(storedToMessage)

    expect(loaded).toHaveLength(2)
    expect(loaded?.[0]?.agentRuns).toBeUndefined()
    expect(loaded?.[1]?.executionRef).toBeUndefined()
  })
})
