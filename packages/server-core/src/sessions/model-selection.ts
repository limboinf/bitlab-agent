/**
 * Session model selection: the ONE fact that says which connection, model and
 * thinking level the session's NEXT assembled turn will run under.
 *
 * Ported from dsh's `installModelSelection` / `selectionFor` pair. Two ideas
 * carry the whole design, and both replace a lock:
 *
 * 1. `current` vs `assembled`. A turn snapshots `current` into `assembled` the
 *    moment it starts assembling its request, and the backend resolution reads
 *    `assembled` only. A switch made while a turn is running therefore lands on
 *    the NEXT turn instead of splitting the running one across two routes —
 *    which is the entire reason the old code locked the connection after the
 *    first message.
 *
 * 2. `current` is DERIVED on every read, never seeded once. Precedence is: a
 *    selection made in this process, else the selection recorded on the
 *    session's latest dispatched user message, else the workspace default.
 *    Re-reading keeps the tiers exact in both directions — a session with
 *    history derives from its own log, while a blank session picks up a
 *    workspace default that changed after it was created.
 *
 * Every field is optional on purpose: `undefined` means "follow the tier
 * below", which is what lets a blank session track a default it never named.
 * Resolution to a concrete connection/model stays in `resolveBackendContext`.
 */

import type { Message } from '@bitlab/core/types'
import { normalizeThinkingLevel, type ThinkingLevel } from '@bitlab/shared/agent/thinking-levels'

/** What the user picked, as intent — unset fields follow the tier below. */
export interface SessionModelSelection {
  /** Connection slug; unset follows the workspace default. */
  connection?: string
  /** Model id; unset follows the connection's own default model. */
  model?: string
  /** Thinking level; unset follows the session default. */
  thinkingLevel?: ThinkingLevel
}

/** Mutable selection plus the value captured for the running turn. */
export interface ModelSelectionRef {
  /** Selection for the next turn that enters assembly. */
  current: SessionModelSelection
  /** Selection captured when the running turn entered assembly. */
  assembled: SessionModelSelection | undefined
}

/** The session state this module reads; a narrow slice of ManagedSession. */
export interface SelectionSource {
  messages: Message[]
  /** Selection chosen in this process, if any. */
  pickedSelection?: SessionModelSelection
  /** The persisted explicit choice; these fields are also the legacy form. */
  llmConnection?: string
  model?: string
  thinkingLevel?: ThinkingLevel
}

/**
 * The selection recorded on the latest user message that was actually
 * dispatched. This is the log-derived tier: it answers "what is this session
 * running under" from the history itself rather than a field that can drift
 * out of sync with it.
 *
 * @param messages - the session transcript, oldest first.
 * @returns the recorded selection, or undefined when nothing was dispatched yet.
 */
export function loggedSelection(messages: Message[]): SessionModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const recorded = messages[index]?.modelSelection
    if (!recorded) continue
    // The persisted level is opaque and may predate the current vocabulary.
    return {
      connection: recorded.connection,
      model: recorded.model,
      thinkingLevel: normalizeThinkingLevel(recorded.thinkingLevel),
    }
  }
  return undefined
}

/**
 * Resolve the session's current selection through the three tiers.
 *
 * @param source - the session slice to read.
 * @param workspaceDefaultConnection - the workspace's default connection slug.
 * @returns the selection the next assembled turn would use.
 */
export function currentSelection(
  source: SelectionSource,
  workspaceDefaultConnection?: string,
): SessionModelSelection {
  // Each tier answers as a WHOLE. Falling back field by field would pair one
  // connection with another's model, because a model id only means anything
  // inside the connection that advertises it.
  if (source.pickedSelection) return source.pickedSelection

  // An explicit persisted choice outranks the log: it is the later act. A
  // session that named no connection has none here and falls through.
  if (source.llmConnection !== undefined || source.model !== undefined) {
    return {
      connection: source.llmConnection,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
    }
  }

  // A session that ran keeps running what it ran, so changing the workspace
  // default never re-routes history that already exists.
  const logged = loggedSelection(source.messages)
  if (logged) return { ...logged, thinkingLevel: source.thinkingLevel ?? logged.thinkingLevel }

  // Blank and unnamed: track the workspace default, including one saved after
  // this session was created.
  return { connection: workspaceDefaultConnection, thinkingLevel: source.thinkingLevel }
}

/**
 * The selection a turn must run under: what it snapshotted, or — for a turn
 * that never snapshotted, such as a runtime refresh outside a turn — what is
 * current now.
 *
 * @param source - the session slice to read.
 * @param assembled - the running turn's snapshot, if a turn is running.
 * @param workspaceDefaultConnection - the workspace's default connection slug.
 * @returns the selection to resolve a backend context from.
 */
export function effectiveSelection(
  source: SelectionSource,
  assembled: SessionModelSelection | undefined,
  workspaceDefaultConnection?: string,
): SessionModelSelection {
  return assembled ?? currentSelection(source, workspaceDefaultConnection)
}

/** Whether two selections name the same route (thinking level excluded). */
export function sameRoute(a: SessionModelSelection, b: SessionModelSelection): boolean {
  return a.connection === b.connection && a.model === b.model
}

/** Whether switching from `a` to `b` changes the connection, not just the model. */
export function crossesConnection(
  a: SessionModelSelection,
  b: SessionModelSelection,
): boolean {
  return a.connection !== b.connection
}
