/**
 * Where a floating menu goes relative to its trigger.
 *
 * Pure geometry, kept out of the component so the interesting part — what
 * happens when the trigger sits near an edge — can be tested without a DOM.
 */

/** Breathing room kept between the menu and every viewport edge. */
export const VIEWPORT_MARGIN = 8
/** Gap between the trigger and the menu, on whichever side it opens. */
export const TRIGGER_GAP = 4
/** Floor for the height budget, so a cramped viewport still shows a scrollable menu. */
export const MIN_MENU_HEIGHT = 120

/** The trigger's box, in viewport coordinates. */
export interface TriggerRect {
  top: number
  bottom: number
  left: number
  right: number
}

export interface MenuPlacementInput {
  rect: TriggerRect
  /** Width the menu renders at — used to keep it inside the viewport. */
  menuWidth: number
  /** Measured content height, or 0 before the menu has mounted. */
  contentHeight: number
  align: 'start' | 'end'
  viewportWidth: number
  viewportHeight: number
}

/** Where the menu sits, plus how tall it may grow before scrolling. */
export interface MenuPosition {
  top: number
  left: number
  maxHeight: number
}

/**
 * Place a menu inside the viewport, flipping above the trigger when there is
 * more room there.
 *
 * A trigger sitting in a footer near the bottom of the window — a turn's action
 * row, just above the composer — has almost no room below it, so a menu that
 * only ever opens downward gets clipped and covers the input. When neither side
 * fits, the height budget lets the menu scroll rather than overflow.
 *
 * @param input - trigger box, menu size and viewport size.
 * @returns the menu's viewport coordinates and height budget.
 */
export function resolveMenuPlacement({
  rect,
  menuWidth,
  contentHeight,
  align,
  viewportWidth,
  viewportHeight,
}: MenuPlacementInput): MenuPosition {
  let left = align === 'end' ? rect.right - menuWidth : rect.left
  if (left + menuWidth > viewportWidth - VIEWPORT_MARGIN) {
    left = viewportWidth - menuWidth - VIEWPORT_MARGIN
  }
  // Clamped last so a menu wider than the viewport hugs the left edge rather
  // than being pushed off it.
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN

  const spaceBelow = viewportHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN
  const spaceAbove = rect.top - TRIGGER_GAP - VIEWPORT_MARGIN
  // Before the menu mounts its height is unknown, so it is assumed to fit
  // below; the caller re-runs this once the real measurement exists.
  const opensUp = contentHeight > spaceBelow && spaceAbove > spaceBelow
  const available = Math.max(opensUp ? spaceAbove : spaceBelow, MIN_MENU_HEIGHT)
  const height = contentHeight > 0 ? Math.min(contentHeight, available) : available

  // The height floor can exceed the room actually above the trigger in a very
  // short window. Losing the menu's top off-screen is worse than overlapping
  // the trigger, so the top edge is clamped and the menu scrolls.
  const top = Math.max(
    VIEWPORT_MARGIN,
    opensUp ? rect.top - TRIGGER_GAP - height : rect.bottom + TRIGGER_GAP,
  )

  return { top, left, maxHeight: available }
}
