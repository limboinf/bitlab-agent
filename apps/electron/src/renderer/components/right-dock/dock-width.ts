/**
 * How wide the right dock is allowed to be *right now*.
 *
 * The dock is a permanent column, so its stored width has to survive being
 * carried into a window too narrow for it. Without a cap, a default-open
 * 480px dock on a 900px window left the chat — the main surface — with a
 * couple of hundred pixels.
 *
 * The stored width is never rewritten: widen the window and the dock returns
 * to the size the user chose.
 */

import { DOCK_MIN_WIDTH } from '@/atoms/right-dock'

/** Chat stays at least this wide before the dock has to give ground. */
export const MIN_CONTENT_WIDTH = 460

export function resolveRightDockWidth({
  storedWidth,
  shellWidth,
  navigationWidth,
}: {
  storedWidth: number
  /** 0 while the shell has not been measured yet. */
  shellWidth: number
  navigationWidth: number
}): number {
  if (shellWidth <= 0) return storedWidth

  const available = shellWidth - navigationWidth - MIN_CONTENT_WIDTH
  return Math.max(DOCK_MIN_WIDTH, Math.min(storedWidth, available))
}
