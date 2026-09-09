import { writeFile, rename, unlink } from 'fs/promises'
import { dirname } from 'path'
import type { StoredSession, SessionHeader } from './types.js'
import { getSessionFilePath, ensureSessionsDir, ensureSessionDir } from './storage.js'
import { toPortablePath } from '../utils/paths.js'
import { createSessionHeader, makeSessionPathPortable, readSessionHeader } from './jsonl.js'
import { debug } from '../utils/debug.js'

interface PendingWrite {
  data: StoredSession
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Detach the parts of a session that keep being mutated after it is queued.
 *
 * Execution metrics are updated in place all through a turn — a request pushed,
 * a revision bumped, a duration written on settle. A queued write holds the
 * caller's own arrays, so without this the bytes that reach disk would be
 * whatever the transcript looked like when the timer fired, not what the caller
 * asked to save. Only messages that carry metrics are copied; the rest (large
 * tool results, attachments) stay shared, since nothing rewrites them.
 *
 * @param session - the session being queued.
 * @returns a session safe to serialize later.
 */
function snapshotForCommit(session: StoredSession): StoredSession {
  let copied = false
  const messages = session.messages.map(message => {
    if (!message.agentRuns) return message
    copied = true
    return {
      ...message,
      agentRuns: message.agentRuns.map(run => ({
        ...run,
        requests: run.requests.map(request => ({
          ...request,
          messageIds: [...request.messageIds],
          toolUseIds: [...request.toolUseIds],
        })),
      })),
    }
  })
  return copied ? { ...session, messages } : session
}

interface HeaderMetadataSignature {
  name?: string
  isFlagged?: boolean
  permissionMode?: string
  hasUnread?: boolean
  lastReadMessageId?: string
}

function getHeaderMetadataSignature(header: SessionHeader): string {
  const signature: HeaderMetadataSignature = {
    name: header.name,
    isFlagged: header.isFlagged,
    permissionMode: header.permissionMode,
    hasUnread: header.hasUnread,
    lastReadMessageId: header.lastReadMessageId,
  }
  return JSON.stringify(signature)
}

function mergeHeaderWithExternalMetadata(localHeader: SessionHeader, diskHeader: SessionHeader): SessionHeader {
  return {
    ...localHeader,
    name: diskHeader.name,
    isFlagged: diskHeader.isFlagged,
    permissionMode: diskHeader.permissionMode,
    hasUnread: diskHeader.hasUnread,
    lastReadMessageId: diskHeader.lastReadMessageId,
  }
}

/**
 * Debounced async session persistence queue.
 * Prevents main thread blocking by using async writes and coalescing
 * rapid successive persist calls into a single write.
 *
 * IMPORTANT: Writes are serialized per-session to prevent race conditions
 * when rapid successive flushes (e.g., clearSessionForRecovery + onSdkSessionIdUpdate)
 * would otherwise write to the same .tmp file concurrently.
 */
class SessionPersistenceQueue {
  private pending = new Map<string, PendingWrite>()
  /**
   * The tail of each session's write chain. Timed writes and explicit flushes
   * append to the same chain, so two of them can never be inside the same
   * `.tmp` file at once — the race that made a debounced write and a flush
   * clobber each other.
   */
  private writeChain = new Map<string, Promise<void>>()
  private lastWrittenHeaderSignature = new Map<string, string>()
  private debounceMs: number

  constructor(debounceMs = 500) {
    this.debounceMs = debounceMs
  }

  /**
   * Queue a session for persistence. If a write is already pending for this
   * session, it will be replaced with the new data and the timer reset.
   */
  enqueue(session: StoredSession): void {
    const existing = this.pending.get(session.id)
    if (existing?.timer) clearTimeout(existing.timer)

    const timer = setTimeout(() => {
      void this.schedule(session.id).catch(error => {
        // A background write has no caller to report to; surface it and keep the
        // queue alive rather than raising an unhandled rejection.
        console.error(`[PersistenceQueue] Background write failed for ${session.id}:`, error)
      })
    }, this.debounceMs)

    this.pending.set(session.id, { data: snapshotForCommit(session), timer })
  }

  /**
   * Append one write to this session's chain and return when it has run.
   *
   * The chain — not the pending entry — is what a flush waits on: a write that
   * has already been taken off the queue is still in flight, and returning
   * before it lands would report data as saved that is not.
   *
   * @param sessionId - session to write.
   * @returns a promise for that write's completion.
   */
  private schedule(sessionId: string): Promise<void> {
    const previous = this.writeChain.get(sessionId) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* a failed earlier write must not cancel this one */ })
      .then(() => this.write(sessionId))
    this.writeChain.set(sessionId, next)
    void next
      .catch(() => { /* the awaiting caller owns this rejection */ })
      .finally(() => {
        // Drop the chain once this session's last write has settled, so an app
        // with thousands of sessions doesn't retain a promise per session.
        if (this.writeChain.get(sessionId) === next) this.writeChain.delete(sessionId)
      })
    return next
  }

  /**
   * Write a session to disk immediately in JSONL format.
   * Uses atomic write (write-to-temp-then-rename) to prevent corruption on crash.
   */
  private async write(sessionId: string): Promise<void> {
    const entry = this.pending.get(sessionId)
    if (!entry) return

    if (entry.timer) clearTimeout(entry.timer)
    this.pending.delete(sessionId)

    try {
      const { data } = entry
      ensureSessionsDir(data.workspaceRootPath)
      ensureSessionDir(data.workspaceRootPath, sessionId)

      const filePath = getSessionFilePath(data.workspaceRootPath, sessionId)

      // Prepare session with portable paths for cross-machine compatibility
      const storageSession: StoredSession = {
        ...data,
        workspaceRootPath: toPortablePath(data.workspaceRootPath),
        workingDirectory: data.workingDirectory ? toPortablePath(data.workingDirectory) : undefined,
        sdkCwd: data.sdkCwd ? toPortablePath(data.sdkCwd) : undefined,
      }

      // Create JSONL content: header + messages (one per line).
      // Keep tool calls and intermediate commentary so reload can rebuild TurnCard.
      const localHeader = createSessionHeader(storageSession)
      const localSig = getHeaderMetadataSignature(localHeader)
      const diskHeader = readSessionHeader(filePath)
      const previousSig = this.lastWrittenHeaderSignature.get(sessionId)
      const diskSig = diskHeader ? getHeaderMetadataSignature(diskHeader) : undefined

      // Queue writes should never clobber session metadata changed externally
      // (watcher edits, direct header edits, other instances), but they must
      // still persist local metadata updates (e.g. generated title).
      //
      // Preserve disk metadata only when disk diverged from our last written
      // signature, which indicates an external mutation.
      const hasMetadataMismatch = !!diskHeader && !!diskSig && diskSig !== localSig
      const hasExternalMetadataChange = !!diskHeader && !!diskSig && !!previousSig && diskSig !== previousSig
      const header = hasExternalMetadataChange && diskHeader
        ? mergeHeaderWithExternalMetadata(localHeader, diskHeader)
        : localHeader

      if (hasMetadataMismatch) {
        const baseline = previousSig ? `, previousSig=${previousSig.slice(0, 12)}` : ', previousSig=<none>'
        const mode = hasExternalMetadataChange ? 'disk preserved' : 'local preserved'
        debug(`[PersistenceQueue] Session ${sessionId} metadata mismatch detected (${mode}${baseline})`)
      }

      const persistableMessages = storageSession.messages
      // Use original absolute sessionDir (before toPortablePath) for path replacement
      const sessionDir = dirname(filePath)
      const lines = [
        makeSessionPathPortable(JSON.stringify(header), sessionDir),
        ...persistableMessages.map(m => makeSessionPathPortable(JSON.stringify(m), sessionDir)),
      ]

      // Atomic write: write to .tmp then rename over the real file.
      // If the process crashes mid-write, only the .tmp is corrupted —
      // the original session.jsonl remains intact.
      //
      // Update signature BEFORE the write so that fs.watch events fired
      // during unlink/rename are correctly identified as self-writes.
      // Without this, onSessionMetadataChange sees the stale signature
      // and reverts in-memory metadata on idle sessions.
      const finalSignature = getHeaderMetadataSignature(header)
      this.lastWrittenHeaderSignature.set(sessionId, finalSignature)

      const tmpFile = filePath + '.tmp'
      await writeFile(tmpFile, lines.join('\n') + '\n', 'utf-8')
      // rename() replaces the target atomically on POSIX. Deleting first would
      // open a window where a crash leaves no session file at all; only Windows
      // needs the unlink, and only when the replace itself was refused.
      try {
        await rename(tmpFile, filePath)
      } catch (renameError) {
        if (process.platform !== 'win32') throw renameError
        await unlink(filePath).catch(() => { /* nothing to replace */ })
        await rename(tmpFile, filePath)
      }
      debug(`[PersistenceQueue] Wrote session ${sessionId}`)
    } catch (error) {
      console.error(`[PersistenceQueue] Failed to write session ${sessionId}:`, error)
    }
  }

  /**
   * Immediately flush a specific session if pending.
   * Waits for any in-progress write to complete before starting a new one
   * to prevent race conditions on the shared .tmp file.
   */
  async flush(sessionId: string): Promise<void> {
    if (this.pending.has(sessionId)) {
      await this.schedule(sessionId)
      return
    }
    // Nothing queued, but an earlier write may still be running — a caller that
    // flushes to read the file back must not overtake it.
    const inFlight = this.writeChain.get(sessionId)
    if (inFlight) await inFlight
  }

  /**
   * Cancel a pending write for a session (e.g., when deleting the session).
   */
  cancel(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer)
      this.pending.delete(sessionId)
      debug(`[PersistenceQueue] Cancelled pending write for session ${sessionId}`)
    }
    this.writeChain.delete(sessionId)
    this.lastWrittenHeaderSignature.delete(sessionId)
  }

  /**
   * Flush all pending sessions. Call this on app quit.
   */
  async flushAll(): Promise<void> {
    const sessionIds = new Set([...this.pending.keys(), ...this.writeChain.keys()])
    await Promise.all([...sessionIds].map(id => this.flush(id)))
  }

  /**
   * Check if a session has a pending write.
   */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * Get the metadata signature of the last header we wrote for a session.
   * Used by ConfigWatcher to suppress self-triggered metadata change events.
   */
  getLastWrittenSignature(sessionId: string): string | undefined {
    return this.lastWrittenHeaderSignature.get(sessionId)
  }

  /**
   * Get count of pending writes.
   */
  get pendingCount(): number {
    return this.pending.size
  }
}

// Singleton instance
export const sessionPersistenceQueue = new SessionPersistenceQueue()

// Named exports for testing/customization
export { SessionPersistenceQueue, getHeaderMetadataSignature, mergeHeaderWithExternalMetadata }
