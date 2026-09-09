import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentRunMetrics } from '@bitlab/core/types'
import { SessionPersistenceQueue } from '../persistence-queue'
import type { StoredSession } from '../types'

const tmpRoot = mkdtempSync(join(tmpdir(), 'bitlab-queue-writer-'))
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

function makeSession(id: string, runs?: AgentRunMetrics[]): StoredSession {
  return {
    id,
    workspaceRootPath: tmpRoot,
    createdAt: 1,
    lastUsedAt: 2,
    messages: [{
      id: 'user-1',
      type: 'user',
      content: 'hi',
      timestamp: 1,
      ...(runs ? { agentRuns: runs } : {}),
    }],
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

function runningRun(): AgentRunMetrics {
  return {
    schemaVersion: 1,
    runId: 'run-1',
    revision: 1,
    status: 'running',
    coverage: 'full',
    startedAt: 1_000,
    requests: [],
  }
}

function readMessages(sessionId: string): Array<Record<string, unknown>> {
  const file = join(tmpRoot, 'sessions', sessionId, 'session.jsonl')
  return readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .slice(1)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('session persistence writer', () => {
  it('commits the transcript as it stood at enqueue, not as it drifted after', async () => {
    const queue = new SessionPersistenceQueue(10_000)
    const run = runningRun()
    queue.enqueue(makeSession('drift', [run]))

    // The turn keeps running: a call lands and the run settles, mutating the
    // very objects the caller handed over.
    run.requests.push({
      requestId: 'later',
      sequence: 1,
      measurement: 'sdk-call-v1',
      status: 'completed',
      startedAt: 2_000,
      messageIds: [],
      toolUseIds: [],
    })
    run.status = 'completed'
    run.revision = 9

    await queue.flush('drift')

    const stored = readMessages('drift')[0]?.agentRuns as AgentRunMetrics[]
    expect(stored[0]?.revision).toBe(1)
    expect(stored[0]?.status).toBe('running')
    expect(stored[0]?.requests).toEqual([])
  })

  it('serializes a debounced write and an explicit flush onto one writer', async () => {
    const queue = new SessionPersistenceQueue(0)
    queue.enqueue(makeSession('serial'))
    // The timer fires on the next tick; flushing right after used to start a
    // second write into the same .tmp file.
    const flushed = queue.flush('serial')
    queue.enqueue(makeSession('serial'))
    await Promise.all([flushed, queue.flush('serial')])

    expect(readMessages('serial')).toHaveLength(1)
    expect(queue.hasPending('serial')).toBe(false)
  })

  it('waits for an in-flight write even with nothing left queued', async () => {
    const queue = new SessionPersistenceQueue(0)
    queue.enqueue(makeSession('inflight'))
    await new Promise(resolve => setTimeout(resolve, 5))

    await queue.flush('inflight')

    expect(() => readMessages('inflight')).not.toThrow()
  })

  it('flushAll drains sessions whose write already left the queue', async () => {
    const queue = new SessionPersistenceQueue(0)
    queue.enqueue(makeSession('all-1'))
    queue.enqueue(makeSession('all-2'))

    await queue.flushAll()

    expect(readMessages('all-1')).toHaveLength(1)
    expect(readMessages('all-2')).toHaveLength(1)
  })
})
