/**
 * Viewport-fixed style for inline @ / / menus.
 *
 * Callers must portal the menu to document.body. If the menu stays inside a
 * transformed ancestor (e.g. empty-chat `-translate-y-*`), `position: fixed`
 * is relative to that box while caret coords stay viewport-relative — the
 * popup then jumps to the top-right.
 */
export function getInlineMenuFixedStyle(
  position: { x: number; y: number },
  viewportHeight: number,
  options?: { offsetX?: number; gap?: number },
): { left: number; bottom: number } {
  const offsetX = options?.offsetX ?? 10
  const gap = options?.gap ?? 8
  return {
    left: Math.round(position.x) - offsetX,
    bottom: viewportHeight - Math.round(position.y) + gap,
  }
}
