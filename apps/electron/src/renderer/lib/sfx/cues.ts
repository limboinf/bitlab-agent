/**
 * Semantic cue mapping.
 *
 * Every entry answers "what happened?", never "what did the user click?".
 * Kept free of React and of the player so it can be unit-tested on its own.
 */

import type { CueName } from 'uisfx'

/** The pack chosen for Bitlab — dry, precise, almost invisible. */
export const SFX_PACK = 'minimal' as const

/**
 * Agent turn outcomes. These arrive asynchronously, long after the gesture
 * that started the turn, which is exactly why they are worth sonifying: the
 * user has usually looked away by then.
 */
const TURN_OUTCOME_CUES = {
  complete: 'complete',
  error: 'error',
  typed_error: 'error',
  interrupted: 'stop',
} as const satisfies Record<string, CueName>

export type TurnOutcomeEvent = keyof typeof TURN_OUTCOME_CUES

/** Cue for a session event that ends an agent turn, or null if it doesn't end one. */
export function turnOutcomeCue(eventType: string): CueName | null {
  return TURN_OUTCOME_CUES[eventType as TurnOutcomeEvent] ?? null
}

/**
 * Submitting a prompt. Mid-stream sends are queued rather than started, and
 * the catalog has a cue that says precisely that.
 */
export function submitCue(isProcessing: boolean): CueName {
  return isProcessing ? 'queued' : 'send'
}

/**
 * The agent paused and needs a human decision (tool permission or admin
 * approval). "A risky or consequential state needs review."
 */
export const PERMISSION_REQUEST_CUE: CueName = 'warning'

/** Outcome of the approval itself — played after the response is acknowledged. */
export function permissionResponseCue(allowed: boolean): CueName {
  return allowed ? 'unlock' : 'cancel'
}

/** A session was removed, after the deletion is committed. */
export const SESSION_DELETED_CUE: CueName = 'delete'

export interface TransportSfx {
  /** Whether the `connecting` loop should be running. */
  loop: boolean
  /** One-shot to play on this transition, if any. */
  cue: CueName | null
}

const SILENT_TRANSPORT: TransportSfx = { loop: false, cue: null }

/**
 * Connection state for remote (WebUI / remote server) transports.
 *
 * Local transports never drop, so they stay silent. The first successful
 * connect is silent too: nothing was lost, so there is nothing to announce.
 */
export function transportSfx(
  previous: string | null,
  next: string,
  mode: 'local' | 'remote',
): TransportSfx {
  if (mode === 'local') return SILENT_TRANSPORT
  if (previous === next) return { loop: next === 'connecting' || next === 'reconnecting', cue: null }

  switch (next) {
    case 'connecting':
    case 'reconnecting':
      return { loop: true, cue: null }
    case 'connected':
      // Only worth a cue if we audibly lost the connection first.
      return { loop: false, cue: previous === null || previous === 'idle' ? null : 'connect' }
    case 'disconnected':
    case 'failed':
      return { loop: false, cue: 'disconnect' }
    default:
      return SILENT_TRANSPORT
  }
}
