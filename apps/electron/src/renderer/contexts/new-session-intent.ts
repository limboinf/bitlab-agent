import {
  isSessionsNavigation,
  type NavigationState,
  type SessionsNavigationState,
} from '../../shared/types'

/**
 * Whether a sessions route without an explicit detail should resolve to the
 * last/first session.
 *
 * The `allSessions/new` draft route is deliberately excluded: it is the frame
 * "New task" parks on while the real session is being created, and letting
 * auto-selection touch it is exactly how a new task used to snap back to the
 * previously open session.
 */
export function shouldAutoSelectSession(
  state: NavigationState,
  skipAutoSelect = false,
): state is SessionsNavigationState {
  return (
    isSessionsNavigation(state) &&
    !state.details &&
    !state.isNewSessionDraft &&
    !skipAutoSelect
  )
}
