import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { listSessions } from '../storage'
import { SessionPersistenceQueue } from '../persistence-queue'
import type { StoredSession } from '../types'

function makeSession(id: string, lastUsedAt: number, workspaceRootPath: string): StoredSession {
  return {
    id,
    workspaceRootPath,
    createdAt: lastUsedAt,
    lastUsedAt,
    messages: [],
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
      costUsd: 0,
    },
  }
}

describe('session list ordering', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps an older session from moving to the front when it is flushed on shutdown', async () => {
    const root = join(tmpdir(), `bitlab-session-order-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    roots.push(root)

    const older = makeSession('older-branch', 100, root)
    const newer = makeSession('newer-chat', 200, root)
    const queue = new SessionPersistenceQueue(0)
    queue.enqueue(older)
    await queue.flush(older.id)
    queue.enqueue(newer)
    await queue.flush(newer.id)

    // App shutdown flushes every session. Rewriting the old branch must not
    // change its activity timestamp or make it win the next startup sort.
    queue.enqueue(older)
    await queue.flush(older.id)

    expect(listSessions(root).map(session => session.id)).toEqual([
      'newer-chat',
      'older-branch',
    ])
  })

  it('does not let a legacy branch with a stale lastUsedAt outrank newer chats', async () => {
    const root = join(tmpdir(), `bitlab-session-order-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    roots.push(root)

    const legacyBranch = {
      ...makeSession('legacy-branch', 300, root),
      createdAt: 100,
      messages: [{
        id: 'old-message',
        type: 'user' as const,
        content: 'old branch',
        timestamp: 100,
      }],
    }
    const newer = makeSession('newer-chat', 200, root)
    const queue = new SessionPersistenceQueue(0)
    queue.enqueue(legacyBranch)
    await queue.flush(legacyBranch.id)
    queue.enqueue(newer)
    await queue.flush(newer.id)

    expect(listSessions(root).map(session => session.id)).toEqual([
      'newer-chat',
      'legacy-branch',
    ])
  })
})
