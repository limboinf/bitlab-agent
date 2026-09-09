/**
 * Run Metrics Handler
 *
 * Merges execution-metrics snapshots onto the user message that owns them.
 * Pure function, no side effects.
 */

import type { AgentRunMetrics } from '@bitlab/core/types'
import type { SessionState, RunMetricsUpdatedEvent } from '../types'

/**
 * Upsert a run snapshot by `revision`.
 *
 * The server bumps `revision` on every authoritative change, so a snapshot that
 * arrives out of order — a reconnect replaying an old one, a session reload
 * racing a live event — is simply the smaller number and loses. Equal revisions
 * are idempotent, which keeps a duplicate delivery from re-rendering the turn.
 *
 * The owner is matched on either id the event carries. A user message keeps the
 * optimistic id this client minted for it — handleUserMessage deliberately does
 * not swap in the server's canonical id, because that would remount the bubble
 * and wipe its local state — so matching only the canonical id would drop every
 * snapshot of a turn the user just typed.
 *
 * When neither id is present the event is dropped rather than stashed: the next
 * session snapshot carries the metrics with the message, and a second store for
 * pending runs would only ever drift from that one.
 *
 * @param state - current session state.
 * @param event - the incoming snapshot.
 * @returns new state, always a fresh session reference.
 */
export function handleRunMetricsUpdated(
  state: SessionState,
  event: RunMetricsUpdatedEvent
): SessionState {
  const { session } = state
  const index = session.messages.findIndex(message =>
    message.id === event.ownerMessageId ||
    (event.ownerOptimisticMessageId !== undefined && message.id === event.ownerOptimisticMessageId)
  )
  if (index === -1) return { ...state, session: { ...session } }

  const owner = session.messages[index]
  const runs = owner.agentRuns ?? []
  const existingIndex = runs.findIndex(run => run.runId === event.run.runId)
  if (existingIndex !== -1 && runs[existingIndex].revision >= event.run.revision) {
    return { ...state, session: { ...session } }
  }

  const nextRuns: AgentRunMetrics[] = existingIndex === -1
    ? [...runs, event.run]
    : runs.map((run, i) => (i === existingIndex ? event.run : run))

  const messages = session.messages.slice()
  messages[index] = { ...owner, agentRuns: nextRuns }
  return { ...state, session: { ...session, messages } }
}
