/**
 * Run-level execution metrics, owned by the session that executes the turn.
 *
 * The subprocess measures each model call; this module decides which run those
 * calls belong to, binds the messages they produced, and keeps the persisted
 * record authoritative. Every mutation bumps `revision` so a client can merge
 * out-of-order snapshots without inventing an ordering of its own.
 *
 * Kept out of SessionManager on purpose: the run state machine is small, has
 * exact invariants, and is far easier to test on its own.
 */

import type {
  AgentRunMetrics,
  ExecutionStatus,
  LlmRequestMetrics,
  Message,
} from '@bitlab/core/types'
import { RUN_METRICS_SCHEMA_VERSION, sanitizeRunMetrics, trimRunMetricsForBranch } from '@bitlab/core'
import type { BranchRetention } from '@bitlab/core'

/** Terminal states a request may not be moved out of once recorded. */
const TERMINAL: ReadonlySet<ExecutionStatus> = new Set(['completed', 'error', 'aborted', 'interrupted'])

function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The live control object for one execution.
 *
 * Holds the monotonic start so the run's wall time is measured, not derived
 * from message timestamps — those are ordering aids that can be nudged forward
 * to stay unique.
 */
export interface ActiveRun {
  runId: string
  /** The persisted user message that owns this run's metrics. */
  ownerMessageId: string
  /**
   * The id the client minted for that message before the server had one.
   *
   * A client keeps its optimistic id as the bubble's React identity — swapping
   * it would remount the bubble mid-turn — so every server event that addresses
   * a user message has to offer this id too, or the client cannot route it.
   */
  ownerOptimisticMessageId?: string
  /** Monotonic milliseconds at execution start. */
  startedMono: number
  /** The model call currently in flight, for binding produced messages. */
  currentRequestId?: string
  /** Set when the user asked to stop, so the run settles as `aborted`. */
  abortRequested: boolean
}

/**
 * Start a run and attach its record to the owning user message.
 *
 * Re-running the same user message appends a second run rather than replacing
 * the first: both executions happened, and the older readings stay honest.
 *
 * @param owner - the persisted user message that triggered the execution.
 * @param clock - epoch and monotonic clocks (injected for deterministic tests).
 * @param optimisticMessageId - the id the client knows that message by, if any.
 * @returns the live control object.
 */
export function beginRun(
  owner: Message,
  clock: { now: () => number; monotonic: () => number },
  optimisticMessageId?: string,
): ActiveRun {
  const run: AgentRunMetrics = {
    schemaVersion: RUN_METRICS_SCHEMA_VERSION,
    runId: newRunId(),
    revision: 1,
    status: 'running',
    coverage: 'full',
    startedAt: clock.now(),
    requests: [],
  }
  owner.agentRuns = [...(owner.agentRuns ?? []), run]
  owner.executionRef = { runId: run.runId }
  return {
    runId: run.runId,
    ownerMessageId: owner.id,
    ...(optimisticMessageId ? { ownerOptimisticMessageId: optimisticMessageId } : {}),
    startedMono: clock.monotonic(),
    abortRequested: false,
  }
}

/** Locate a run record by id across a transcript. */
export function findRun(messages: Message[], runId: string): { owner: Message; run: AgentRunMetrics } | undefined {
  for (const message of messages) {
    const run = message.agentRuns?.find(item => item.runId === runId)
    if (run) return { owner: message, run }
  }
  return undefined
}

/**
 * Record a model call that just opened.
 *
 * The sequence number is assigned here rather than trusted from the subprocess:
 * it must describe this run's ordering, and only the session knows the run.
 *
 * @param messages - the session transcript.
 * @param active - the live run.
 * @param request - the sampled request, still `running`.
 * @returns the updated run record, or undefined when the owner is gone.
 */
export function applyRequestStarted(
  messages: Message[],
  active: ActiveRun,
  request: LlmRequestMetrics,
): AgentRunMetrics | undefined {
  const found = findRun(messages, active.runId)
  if (!found) return undefined
  const { run } = found
  if (run.requests.some(item => item.requestId === request.requestId)) return run
  run.requests.push({
    ...request,
    sequence: run.requests.length + 1,
    status: 'running',
    messageIds: [],
    toolUseIds: [],
  })
  run.revision += 1
  active.currentRequestId = request.requestId
  return run
}

/**
 * Close a model call with the readings the sampler took.
 *
 * A second terminal event for the same call is dropped: the SDK can synthesize
 * a `message_end` after a rejection the wrapper already reported, and the first
 * reading is the one that was actually measured.
 *
 * @param messages - the session transcript.
 * @param active - the live run.
 * @param request - the settled request.
 * @returns the updated run record, or undefined when there is nothing to update.
 */
export function applyRequestCompleted(
  messages: Message[],
  active: ActiveRun,
  request: LlmRequestMetrics,
): AgentRunMetrics | undefined {
  const found = findRun(messages, active.runId)
  if (!found) return undefined
  const { run } = found
  const index = run.requests.findIndex(item => item.requestId === request.requestId)
  if (index === -1) return undefined
  const existing = run.requests[index]
  if (!existing || TERMINAL.has(existing.status)) return run

  const status = active.abortRequested && existing.status === 'running' && request.status === 'error'
    ? 'aborted'
    : request.status
  run.requests[index] = {
    ...request,
    sequence: existing.sequence,
    status,
    // Messages were bound while the call was open; the sampler never saw them.
    messageIds: [...existing.messageIds],
    toolUseIds: request.toolUseIds.length > 0 ? [...request.toolUseIds] : [...existing.toolUseIds],
  }
  run.revision += 1
  if (active.currentRequestId === request.requestId) active.currentRequestId = undefined
  return run
}

/**
 * Bind a message the model just produced to the call that produced it.
 *
 * @param messages - the session transcript.
 * @param active - the live run.
 * @param messageId - the persisted message id.
 * @returns the updated run record, or undefined when no call is open.
 */
export function bindMessageToRequest(
  messages: Message[],
  active: ActiveRun,
  messageId: string,
): AgentRunMetrics | undefined {
  if (!active.currentRequestId) return undefined
  const found = findRun(messages, active.runId)
  if (!found) return undefined
  const request = found.run.requests.find(item => item.requestId === active.currentRequestId)
  if (!request || request.messageIds.includes(messageId)) return undefined
  request.messageIds.push(messageId)
  found.run.revision += 1
  return found.run
}

/**
 * Settle a run: this is the only place its total duration is written.
 *
 * The wall time deliberately covers tools, approvals, compaction and retries —
 * it answers "how long did this take me", which is not the same question as
 * "how fast is the model".
 *
 * @param messages - the session transcript.
 * @param active - the live run.
 * @param status - the outcome of the execution.
 * @param clock - epoch and monotonic clocks.
 * @returns the settled run record, or undefined when the owner is gone.
 */
export function settleRun(
  messages: Message[],
  active: ActiveRun,
  status: ExecutionStatus,
  clock: { now: () => number; monotonic: () => number },
): AgentRunMetrics | undefined {
  const found = findRun(messages, active.runId)
  if (!found) return undefined
  const { run } = found
  if (TERMINAL.has(run.status)) return run

  // A call still open when the run ends never reported a terminal state.
  for (const request of run.requests) {
    if (request.status !== 'running') continue
    request.status = active.abortRequested ? 'aborted' : 'interrupted'
  }

  run.status = active.abortRequested && status !== 'error' ? 'aborted' : status
  run.endedAt = clock.now()
  run.durationMs = Math.max(0, clock.monotonic() - active.startedMono)
  run.revision += 1
  return run
}

/**
 * Mark every unsettled run in a loaded transcript as interrupted.
 *
 * A `running` record in a file means the process that was measuring it is gone.
 * We can say it stopped; we cannot say when — so no end time is invented, and
 * downtime never lands in a duration.
 *
 * Idempotent: a second load finds nothing left to change and bumps no revision.
 *
 * @param messages - the loaded transcript.
 * @returns true when anything changed.
 */
export function markStaleRunsInterrupted(messages: Message[]): boolean {
  let changed = false
  for (const message of messages) {
    if (!message.agentRuns) continue
    for (const run of message.agentRuns) {
      let runChanged = false
      for (const request of run.requests) {
        if (request.status !== 'running') continue
        request.status = 'interrupted'
        runChanged = true
      }
      if (run.status === 'running') {
        run.status = 'interrupted'
        runChanged = true
      }
      if (runChanged) {
        run.revision += 1
        changed = true
      }
    }
  }
  return changed
}

/**
 * Drop metrics that cannot be trusted, so a corrupt or future-schema record
 * degrades to "not recorded" instead of breaking the transcript.
 *
 * @param messages - the loaded transcript, mutated in place.
 */
export function sanitizeTranscriptMetrics(messages: Message[]): void {
  for (const message of messages) {
    if (!message.agentRuns) continue
    const runs = message.agentRuns
      .map(sanitizeRunMetrics)
      .filter((run): run is AgentRunMetrics => run !== undefined)
    if (runs.length > 0) message.agentRuns = runs
    else delete message.agentRuns
  }
}

/** The shape branch trimming needs: identity, tool identity, and metrics. */
interface BranchableMessage {
  id: string
  toolUseId?: string
  agentRuns?: AgentRunMetrics[]
}

/**
 * Rebuild a branched transcript's metrics so they describe only what the
 * branch kept.
 *
 * Pure: returns new message objects with freshly built run arrays, so nothing
 * of the source session — down to the nested request arrays — stays shared with
 * the branch.
 *
 * @param messages - the sliced transcript the branch will keep.
 * @returns the transcript with metrics trimmed to the prefix.
 */
export function trimTranscriptMetricsForBranch<T extends BranchableMessage>(messages: T[]): T[] {
  const retention: BranchRetention = {
    messageIds: new Set(messages.map(message => message.id)),
    toolUseIds: new Set(
      messages
        .map(message => message.toolUseId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  }
  return messages.map(message => {
    if (!message.agentRuns || message.agentRuns.length === 0) return message
    const runs = message.agentRuns
      .map(run => trimRunMetricsForBranch(run, retention))
      .filter((run): run is AgentRunMetrics => run !== undefined)
    const next = { ...message }
    if (runs.length > 0) next.agentRuns = runs
    else delete next.agentRuns
    return next
  })
}
