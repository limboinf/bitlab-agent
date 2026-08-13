import { describe, expect, it } from 'bun:test'
import {
  NAVIGATION_PANEL_DEFAULT_WIDTH,
  NAVIGATION_PANEL_MAX_WIDTH,
  NAVIGATION_PANEL_MIN_WIDTH,
  captureSessionsReturnTarget,
  clampNavigationPanelWidth,
  resolveNavigationPanelWidth,
} from '../navigation-layout'

describe('navigation layout', () => {
  it('uses a single 240px navigation domain by default', () => {
    expect(NAVIGATION_PANEL_DEFAULT_WIDTH).toBe(240)
  })

  it('clamps user-resized widths to the supported range', () => {
    expect(clampNavigationPanelWidth(120)).toBe(NAVIGATION_PANEL_MIN_WIDTH)
    expect(clampNavigationPanelWidth(300)).toBe(300)
    expect(clampNavigationPanelWidth(640)).toBe(NAVIGATION_PANEL_MAX_WIDTH)
  })

  it('collapses the entire navigation domain when hidden', () => {
    expect(resolveNavigationPanelWidth({ width: 300, hidden: true })).toBe(0)
    expect(resolveNavigationPanelWidth({ width: 300, hidden: false })).toBe(300)
  })
})

describe('captureSessionsReturnTarget', () => {
  it('returns welcome when the panel stack is empty', () => {
    expect(
      captureSessionsReturnTarget({ route: 'allSessions', panelCount: 0 }),
    ).toEqual({ kind: 'welcome' })
  })

  it('returns the active chat route when a session is open', () => {
    expect(
      captureSessionsReturnTarget({
        route: 'allSessions/session/abc',
        panelCount: 1,
      }),
    ).toEqual({
      kind: 'route',
      route: 'allSessions/session/abc',
      skipAutoSelect: false,
    })
  })

  it('skips auto-select for bare list routes', () => {
    expect(
      captureSessionsReturnTarget({ route: 'flagged', panelCount: 1 }),
    ).toEqual({
      kind: 'route',
      route: 'flagged',
      skipAutoSelect: true,
    })
  })
})
