import { describe, expect, it, mock } from 'bun:test'

mock.module('electron-log/main', () => ({
  default: {
    initialize: () => {},
    scope: () => console,
    transports: {
      file: { maxSize: 0, getFile: () => ({ path: '' }) },
      console: { level: false },
    },
  },
}))

const { parseDeepLink } = await import('../deep-link')

describe('parseDeepLink', () => {
  it('accepts retained session, Skill, and settings routes', () => {
    expect(parseDeepLink('bitlab://allSessions/session/session-1')?.view).toBe('allSessions/session/session-1')
    expect(parseDeepLink('bitlab://skills')?.view).toBe('skills')
    expect(parseDeepLink('bitlab://settings/connections')?.view).toBe('settings/connections')
  })

  it('accepts local workspace actions', () => {
    expect(parseDeepLink('bitlab://workspace/default/action/flag-session/session-1')).toMatchObject({
      workspaceId: 'default',
      action: 'flag-session',
      actionParams: { id: 'session-1' },
    })
  })

  it('rejects removed and foreign routes', () => {
    expect(parseDeepLink('bitlab://sources')).toBeNull()
    expect(parseDeepLink('bitlab://automations')).toBeNull()
    expect(parseDeepLink('https://example.com')).toBeNull()
  })
})
