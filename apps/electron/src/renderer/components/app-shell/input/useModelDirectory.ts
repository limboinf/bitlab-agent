/**
 * The session's model directory: the ONE state every model-selection surface
 * renders from, and the ONE place selections are submitted through.
 *
 * Ported from dsh's `ModelDirectory`, keeping its three load-bearing rules:
 *
 * 1. **`groups` is advisory; `routable` is the gate.** A connection can serve a
 *    model it stopped advertising — absent from the catalog yet perfectly
 *    usable — while a connection whose credentials are gone can serve nothing
 *    however complete its catalog looks. Anything that disables input must read
 *    `routable`, never "the current selection matches no row".
 *
 * 2. **`routable === null` never blocks.** Before the first load, or after one
 *    failed, the answer is unknown; treating unknown as "no" would let a slow
 *    or failing host lock a composer that works fine.
 *
 * 3. **Latest operation wins.** Loads and selections share a generation
 *    counter, so a slow response can never overwrite a newer one — the bug you
 *    get for free when a picker fires a load on every open.
 *
 * A failed load keeps the last good groups and the current selection, so a
 * transient error degrades the menu instead of emptying it.
 */
import * as React from 'react'
import type {
  SelectModelResult,
  SessionModels,
  SessionModelSelectionDto,
} from '@bitlab/shared/protocol'

/** What every selection surface renders from. */
export interface ModelDirectoryState {
  /** Selection the host reports for the next assembled turn; null before the first load. */
  current: SessionModelSelectionDto | null
  /** The resolved model id behind `current`, after connection defaults apply. */
  resolvedModel: string
  /**
   * Whether an authenticated connection serves `current` — null before the
   * first load, which is NOT the same as blocked. See rule 2 above.
   */
  routable: boolean | null
  /** Connections that loaded (last good load). */
  groups: SessionModels['groups']
  /** Connections that could not be offered; the rest stay usable. */
  failures: SessionModels['failures']
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

const INITIAL: ModelDirectoryState = {
  current: null,
  resolvedModel: '',
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}

export interface ModelDirectory {
  state: ModelDirectoryState
  /** Refresh the advisory directory; errors land on the state, never thrown. */
  load: () => void
  /**
   * Submit a complete selection.
   * @returns the host's outcome, or null when it refused (error is on state).
   */
  select: (selection: SessionModelSelectionDto) => Promise<SelectModelResult | null>
}

/**
 * Resolve the per-session model directory.
 *
 * @param sessionId - the owning session; a falsy id keeps the directory inert.
 * @param connectionsRevision - bump to refetch when connection config changes,
 * so a provider edited in Settings converges without reopening the session.
 * @returns the shared directory state and its two verbs.
 */
export function useModelDirectory(
  sessionId: string | undefined,
  connectionsRevision?: unknown,
): ModelDirectory {
  const [state, setState] = React.useState<ModelDirectoryState>(INITIAL)
  const generation = React.useRef(0)
  const disposed = React.useRef(false)

  React.useEffect(() => {
    disposed.current = false
    return () => { disposed.current = true }
  }, [])

  // A different session is a different directory: drop the previous
  // projection rather than showing it under the new session's name.
  React.useEffect(() => {
    generation.current += 1
    setState(INITIAL)
  }, [sessionId])

  const load = React.useCallback(() => {
    if (!sessionId || !window.electronAPI) return
    const own = ++generation.current
    setState(prev => ({ ...prev, status: 'loading', error: null }))
    void (async () => {
      try {
        const result = await window.electronAPI.sessionCommand(sessionId, { type: 'models' }) as SessionModels
        if (disposed.current || own !== generation.current) return
        setState({
          current: result.current,
          resolvedModel: result.resolvedModel,
          routable: result.routable,
          groups: result.groups,
          failures: result.failures,
          status: 'ready',
          error: null,
        })
      } catch (error) {
        if (disposed.current || own !== generation.current) return
        // Keep the last good groups and current selection: a failed refresh
        // must degrade the menu, not empty it.
        setState(prev => ({
          ...prev,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    })()
  }, [sessionId])

  const select = React.useCallback(async (selection: SessionModelSelectionDto) => {
    if (!sessionId || !window.electronAPI) return null
    const own = ++generation.current
    setState(prev => ({ ...prev, status: 'selecting', error: null }))
    try {
      const result = await window.electronAPI.sessionCommand(sessionId, {
        type: 'selectModel',
        selection,
      }) as SelectModelResult
      if (disposed.current || own !== generation.current) return result
      // The host validated the route before accepting it, so a selection that
      // landed is by construction one it can serve.
      setState(prev => ({
        ...prev,
        current: result.selected,
        routable: true,
        status: 'ready',
        error: null,
      }))
      return result
    } catch (error) {
      if (disposed.current || own !== generation.current) return null
      // Selection failed: the prior selection and directory stay intact.
      setState(prev => ({
        ...prev,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      }))
      return null
    }
  }, [sessionId])

  // Mount-time load resolves the trigger label; connection edits refetch.
  React.useEffect(() => {
    load()
  }, [load, connectionsRevision])

  return { state, load, select }
}
