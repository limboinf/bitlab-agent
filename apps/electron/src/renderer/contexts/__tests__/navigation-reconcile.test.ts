import { describe, expect, it } from 'bun:test'
import { parseRouteToNavigationState } from '../../../shared/route-parser'
import { routes } from '../../../shared/routes'
import { normalizePanelRouteForReconcile } from '../navigation-reconcile'
import { shouldAutoSelectSession } from '../new-session-intent'
import type { NavigationState } from '../../../shared/types'

describe('normalizePanelRouteForReconcile', () => {
  it('auto-selects session details for filter-only session routes', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions/session/s1')
  })

  it('keeps explicit session details unchanged', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    const normalized = normalizePanelRouteForReconcile('allSessions/session/s2', resolver)
    expect(normalized).toBe('allSessions/session/s2')
  })

  it('normalizes each session panel route independently', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        const sessionId = state.filter.kind === 'flagged' ? 'flagged-1' : 'all-1'
        return {
          ...state,
          details: { type: 'session', sessionId },
        }
      }
      return state
    }

    const routes = ['allSessions', 'flagged'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/all-1', 'flagged/session/flagged-1'])
  })

  it('keeps route unchanged when resolver leaves state without details', () => {
    const resolver = (state: NavigationState): NavigationState => state

    const normalized = normalizePanelRouteForReconcile('allSessions', resolver)
    expect(normalized).toBe('allSessions')
  })

  it('keeps non-session routes unchanged with session-only resolver', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if (state.navigator === 'sessions' && !state.details) {
        return {
          ...state,
          details: { type: 'session', sessionId: 's1' },
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('settings', resolver)).toBe('settings')
    expect(normalizePanelRouteForReconcile('skills', resolver)).toBe('skills')
  })

  it('keeps explicit detail route even if resolver tries to rewrite it', () => {
    const resolver = (state: NavigationState): NavigationState => {
      if ('details' in state) {
        if (state.navigator === 'sessions') {
          return { ...state, details: { type: 'session', sessionId: 'rewritten' } }
        }
        if (state.navigator === 'skills') {
          return { ...state, details: { type: 'skill', skillSlug: 'rewritten' } }
        }
      }
      return state
    }

    expect(normalizePanelRouteForReconcile('allSessions/session/s2', resolver)).toBe('allSessions/session/s2')
    expect(normalizePanelRouteForReconcile('skills/skill/commit', resolver)).toBe('skills/skill/commit')
  })

  it('keeps explicit detail routes distinct across multiple panels', () => {
    const resolver = (_state: NavigationState): NavigationState => {
      return {
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: { type: 'session', sessionId: 'same' },
      }
    }

    const routes = ['allSessions/session/left', 'allSessions/session/right'] as const
    const normalized = routes.map((route) => normalizePanelRouteForReconcile(route, resolver))

    expect(normalized).toEqual(['allSessions/session/left', 'allSessions/session/right'])
  })

  // The draft route is a live handoff between "New task" and the session it
  // creates. Auto-selection must not touch it while that handoff is in flight,
  // but a URL still carrying it (reload, Back) is stale: nothing is coming to
  // fill that panel in, so reconciliation drops back to the normal list.
  it('parses the new-task draft route as a detail-less draft state', () => {
    expect(parseRouteToNavigationState(routes.view.newSessionDraft())).toEqual({
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: null,
      isNewSessionDraft: true,
    })
  })

  it('refuses to auto-select on a draft state', () => {
    const draftState = parseRouteToNavigationState(routes.view.newSessionDraft())
    expect(shouldAutoSelectSession(draftState as NavigationState)).toBe(false)
  })

  it('downgrades a stale draft route from the URL to the resolved list route', () => {
    const resolver = (state: NavigationState): NavigationState =>
      shouldAutoSelectSession(state)
        ? { ...state, details: { type: 'session', sessionId: 'last-selected-session' } }
        : state

    expect(normalizePanelRouteForReconcile(routes.view.newSessionDraft(), resolver))
      .toBe('allSessions/session/last-selected-session')
  })

  it('downgrades a stale draft route to the bare list when nothing can be selected', () => {
    expect(normalizePanelRouteForReconcile(routes.view.newSessionDraft(), (state) => state))
      .toBe('allSessions')
  })
})
