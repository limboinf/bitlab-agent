import { describe, expect, it } from 'bun:test'
import { resolveEmptySessionsAction } from '../empty-sessions-surface'
import type { NavigationState } from '../../../../shared/types'

const listRoute: NavigationState = {
  navigator: 'sessions',
  filter: { kind: 'allSessions' },
  details: null,
}
const chatRoute: NavigationState = {
  ...listRoute,
  details: { type: 'session', sessionId: 's1' },
}

const base = {
  navState: listRoute,
  panelCount: 1,
  isSessionListLoaded: true,
  hasLiveOpenSession: false,
  visibleSessionCount: 0,
}

describe('resolveEmptySessionsAction', () => {
  it('creates a chat when the workspace has no sessions', () => {
    expect(resolveEmptySessionsAction(base)).toBe('newChat')
  })

  it('waits until the active workspace session list has loaded', () => {
    expect(resolveEmptySessionsAction({ ...base, isSessionListLoaded: false })).toBe('none')
  })

  it('leaves the welcome surface alone when every panel is closed', () => {
    expect(resolveEmptySessionsAction({ ...base, panelCount: 0 })).toBe('none')
  })

  it('leaves the in-flight New task draft alone', () => {
    expect(resolveEmptySessionsAction({
      ...base,
      navState: { ...listRoute, isNewSessionDraft: true },
    })).toBe('none')
  })

  it('leaves auto-selection to pick from an existing list', () => {
    expect(resolveEmptySessionsAction({ ...base, visibleSessionCount: 3 })).toBe('none')
  })

  it('does nothing while a live session is open', () => {
    expect(resolveEmptySessionsAction({
      ...base,
      navState: chatRoute,
      hasLiveOpenSession: true,
    })).toBe('none')
  })

  it('creates a chat when the open session was pruned and nothing is left', () => {
    expect(resolveEmptySessionsAction({ ...base, navState: chatRoute })).toBe('newChat')
  })

  it('falls back to the list when the open session was pruned but others remain', () => {
    expect(resolveEmptySessionsAction({
      ...base,
      navState: chatRoute,
      visibleSessionCount: 2,
    })).toBe('selectExisting')
  })

  it('keeps flagged and archived views browsable when empty', () => {
    for (const kind of ['flagged', 'archived'] as const) {
      expect(resolveEmptySessionsAction({
        ...base,
        navState: { ...listRoute, filter: { kind } },
      })).toBe('none')
    }
  })

  it('ignores non-session surfaces', () => {
    expect(resolveEmptySessionsAction({
      ...base,
      navState: { navigator: 'settings', subpage: 'app' },
    })).toBe('none')
  })
})
