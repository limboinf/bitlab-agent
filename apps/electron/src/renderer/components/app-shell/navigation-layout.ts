export const NAVIGATION_PANEL_DEFAULT_WIDTH = 240
export const NAVIGATION_PANEL_MIN_WIDTH = 220
export const NAVIGATION_PANEL_MAX_WIDTH = 360

export function clampNavigationPanelWidth(width: number): number {
  return Math.min(
    Math.max(width, NAVIGATION_PANEL_MIN_WIDTH),
    NAVIGATION_PANEL_MAX_WIDTH,
  )
}

export function resolveNavigationPanelWidth({
  width,
  hidden,
}: {
  width: number
  hidden: boolean
}): number {
  return hidden ? 0 : clampNavigationPanelWidth(width)
}

/** Snapshot of the sessions surface to restore when leaving skills/settings. */
export type SessionsReturnTarget =
  | { kind: 'welcome' }
  | { kind: 'route'; route: string; skipAutoSelect: boolean }

/**
 * Capture where "返回" should land after skills/settings.
 * - empty panel stack → welcome surface
 * - session detail route → same chat
 * - bare list route → same list, without auto-selecting another session
 */
export function captureSessionsReturnTarget({
  route,
  panelCount,
}: {
  route: string
  panelCount: number
}): SessionsReturnTarget {
  if (panelCount === 0) return { kind: 'welcome' }
  return {
    kind: 'route',
    route,
    skipAutoSelect: !route.includes('/session/'),
  }
}
