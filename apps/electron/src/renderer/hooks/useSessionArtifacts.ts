/**
 * Live artifact snapshot for one session.
 *
 * There is no ARTIFACT_CREATED push event and there shouldn't be: the two
 * events that already exist — a tool finishing, and the session directory
 * changing — cover every way the facts can move. Adding a third would only
 * create ordering problems between them.
 *
 * One store per session, shared by every subscriber (the dock and each chat
 * panel), because the snapshot is a property of the session and not of whoever
 * happens to be looking. That is also what keeps the guarantees cheap:
 * refreshes coalesce over 100 ms, one request is in flight at a time, and a
 * reply that lost the race is dropped rather than shown.
 */

import { useEffect, useState } from 'react'
import type { SessionArtifactsSnapshot } from '../../shared/types'

const REFRESH_DEBOUNCE_MS = 100

const EMPTY_ARTIFACTS: SessionArtifactsSnapshot['artifacts'] = []

function emptySnapshot(sessionId: string): SessionArtifactsSnapshot {
  return { sessionId, artifacts: EMPTY_ARTIFACTS, changes: EMPTY_ARTIFACTS }
}

interface SessionArtifactStore {
  snapshot: SessionArtifactsSnapshot
  listeners: Set<(snapshot: SessionArtifactsSnapshot) => void>
  timer: ReturnType<typeof setTimeout> | null
  /** Bumped per request; a reply from an older generation is stale. */
  generation: number
  inFlight: boolean
  teardown: () => void
}

const stores = new Map<string, SessionArtifactStore>()

function scheduleRefresh(sessionId: string, store: SessionArtifactStore): void {
  if (store.timer) return

  store.timer = setTimeout(() => {
    store.timer = null
    if (store.inFlight) {
      // Something changed mid-request; the reply is already stale, so ask again.
      store.generation += 1
      scheduleRefresh(sessionId, store)
      return
    }

    const generation = store.generation
    store.inFlight = true

    window.electronAPI.getSessionArtifacts(sessionId)
      .then((next) => {
        if (generation !== store.generation) return
        store.snapshot = next
        for (const listener of store.listeners) listener(next)
      })
      .catch((error) => {
        console.warn('[artifacts] failed to load snapshot:', error)
      })
      .finally(() => { store.inFlight = false })
  }, REFRESH_DEBOUNCE_MS)
}

function createStore(sessionId: string): SessionArtifactStore {
  const store: SessionArtifactStore = {
    snapshot: emptySnapshot(sessionId),
    listeners: new Set(),
    timer: null,
    generation: 0,
    inFlight: false,
    teardown: () => {},
  }

  const refresh = () => scheduleRefresh(sessionId, store)

  const unsubscribeEvents = window.electronAPI.onSessionEvent((event) => {
    if (event.sessionId === sessionId && event.type === 'tool_result') refresh()
  })
  const unsubscribeFiles = window.electronAPI.onSessionFilesChanged((changed) => {
    if (changed === sessionId) refresh()
  })
  const unsubscribeReconnect = window.electronAPI.onReconnected(() => refresh())

  store.teardown = () => {
    unsubscribeEvents()
    unsubscribeFiles()
    unsubscribeReconnect()
    if (store.timer) clearTimeout(store.timer)
    // Any reply still in flight belongs to a store nobody reads any more.
    store.generation += 1
  }

  refresh()
  return store
}

export function useSessionArtifacts(sessionId?: string | null): SessionArtifactsSnapshot {
  const [snapshot, setSnapshot] = useState<SessionArtifactsSnapshot>(() =>
    sessionId ? stores.get(sessionId)?.snapshot ?? emptySnapshot(sessionId) : emptySnapshot(''),
  )

  useEffect(() => {
    if (!sessionId) {
      setSnapshot(emptySnapshot(''))
      return
    }

    const existing = stores.get(sessionId)
    const store = existing ?? createStore(sessionId)
    if (!existing) stores.set(sessionId, store)

    // Never leave the previous session's rows under a new session's header.
    setSnapshot(store.snapshot)
    store.listeners.add(setSnapshot)

    return () => {
      store.listeners.delete(setSnapshot)
      if (store.listeners.size === 0) {
        store.teardown()
        stores.delete(sessionId)
      }
    }
  }, [sessionId])

  return snapshot
}
