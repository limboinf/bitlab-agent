/**
 * Pure render decisions for the chat-input model surfaces.
 *
 * `derivePickerMode` used to be a four-state truth table keyed on how many
 * models a connection advertised and whether the session had messages yet.
 * Both inputs were wrong to gate on:
 *
 * - **Catalog size is advisory.** A connection serving one advertised model can
 *   still serve others, and a connection advertising none may serve the one it
 *   is pointed at. Rendering a disabled row because `models.length <= 1` locked
 *   users out of a picker that had nothing wrong with it.
 * - **"Has messages" is not a capability.** A running turn holds its own
 *   snapshot of the route (see `model-selection.ts` on the host), so switching
 *   mid-session lands on the next turn instead of splitting the running one.
 *   There is nothing left for the old lock to protect.
 *
 * Note what does NOT appear below: `routable`. Whether a route can be served
 * decides if the COMPOSER goes inert, never whether the picker is usable — the
 * picker is the one control a block must leave live, because choosing a model
 * is what clears the block. Locking it too would leave the composer demanding
 * the only thing it prevents. That question has its own function.
 */

export type PickerMode = 'unavailable' | 'empty' | 'browse'

export interface PickerModeInput {
  /** Number of connections that loaded and can be offered. */
  groupCount: number
  /** Whether a directory load has ever settled (success or failure). */
  loaded: boolean
}

/**
 * Decide what the picker menu should render.
 *
 * @param input - the directory facts this decision is allowed to see.
 * @returns `browse` whenever there is anything to choose from.
 */
export function derivePickerMode(input: PickerModeInput): PickerMode {
  if (input.groupCount > 0) return 'browse'
  return input.loaded ? 'unavailable' : 'empty'
}

/**
 * Whether the composer must go inert because no connection can serve this
 * session's route.
 *
 * Reads `routable` and nothing else. A `null` — before the first load, or
 * after one failed — must never block, or a slow or unreachable host would
 * lock a composer that works fine. Catalog membership must never block either:
 * a route serving a model it stopped advertising is missing from the groups
 * yet perfectly usable.
 *
 * @param routable - the host's verdict, or null when not yet known.
 * @returns true only on a definite refusal.
 */
export function blocksComposer(routable: boolean | null): boolean {
  return routable === false
}
