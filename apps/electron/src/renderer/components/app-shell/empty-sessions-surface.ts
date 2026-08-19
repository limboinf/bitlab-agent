import { isSessionsNavigation, type NavigationState } from '../../../shared/types'

/**
 * What the shell should do when the sessions surface has no live chat to show.
 *
 * - `newChat` — materialise a session. An empty workspace is not a screen of
 *   its own: it is a New task waiting to be typed into, with the same composer.
 * - `selectExisting` — the route points at a session that is gone (empty
 *   sessions are pruned on navigate-away, which can happen while the workspace
 *   sits in the background). Drop back to the list route and let auto-selection
 *   pick a live one.
 * - `none` — leave the surface alone.
 */
export type EmptySessionsAction = 'none' | 'newChat' | 'selectExisting'

export function resolveEmptySessionsAction({
  navState,
  panelCount,
  isSessionListLoaded,
  hasLiveOpenSession,
  visibleSessionCount,
}: {
  navState: NavigationState
  panelCount: number
  /** Session metadata for the *active* workspace has arrived. */
  isSessionListLoaded: boolean
  /** The route's session id resolves to a session of the active workspace. */
  hasLiveOpenSession: boolean
  /** Sessions listed under the current filter. */
  visibleSessionCount: number
}): EmptySessionsAction {
  // Before the list arrives, "no sessions" is indistinguishable from "not
  // loaded yet" — acting here would spawn a stray session on every switch.
  if (!isSessionListLoaded) return 'none'
  // Closing every panel is a deliberate destination, not an empty state.
  if (panelCount === 0) return 'none'
  if (!isSessionsNavigation(navState)) return 'none'
  // The draft route means a session is already being created.
  if (navState.isNewSessionDraft) return 'none'
  // Flagged/archived stay browsable when empty — a new chat is in neither.
  if (navState.filter.kind !== 'allSessions') return 'none'

  if (navState.details) {
    if (hasLiveOpenSession) return 'none'
    if (visibleSessionCount > 0) return 'selectExisting'
  } else if (visibleSessionCount > 0) {
    // Auto-selection (NavigationContext) owns this case.
    return 'none'
  }

  return 'newChat'
}
