/**
 * Execution metrics — per-model-call latency facts for one agent run.
 *
 * A Run is one backend execution of a user request; a Request is one SDK
 * `streamFn` call inside it (provider-internal HTTP retries live inside a
 * single Request). Messages point back at the Request that produced them, so a
 * thinking block and the answer that followed it never double-count usage.
 *
 * Durations are measured with a monotonic clock inside the process that made
 * the call and persisted as plain millisecond numbers. `startedAt` / `endedAt`
 * are epoch milliseconds and exist for inspection only — never subtract them to
 * recompute a duration.
 */

/** Terminal (or running) state of a Run or Request. */
export type ExecutionStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'aborted'
  | 'interrupted';

/**
 * Whether a Run's request list is the whole execution, or only the prefix a
 * branch kept. `branch-prefix` runs carry no total duration — the original
 * execution ended after the branch point, so its wall time describes work this
 * session never contained.
 */
export type ExecutionCoverage = 'full' | 'branch-prefix';

/** The measurement contract these readings were taken under. */
export type ExecutionMeasurement = 'sdk-call-v1';

/** One model call: the SDK-call unit, not one physical HTTP request. */
export interface LlmRequestMetrics {
  /** Unique within the owning session. */
  requestId: string;
  /** 1-based order inside the Run; failed and text-less calls take a number too. */
  sequence: number;
  measurement: ExecutionMeasurement;
  status: ExecutionStatus;
  provider?: string;
  model?: string;
  /** Epoch ms when the SDK call started. */
  startedAt: number;
  /** Epoch ms when the call settled. */
  endedAt?: number;
  /** Monotonic call duration: dispatch → terminal state. */
  durationMs?: number;
  /** Dispatch → first effective output delta. Absent when nothing streamed. */
  ttftMs?: number;
  /** First effective delta → terminal state. Absent when nothing streamed. */
  decodeMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider finish reason, e.g. 'stop' | 'toolUse' | 'length'. */
  finishReason?: string;
  /** Persisted message ids this call produced (thinking + text). */
  messageIds: string[];
  /** Tool-call ids this response asked for. */
  toolUseIds: string[];
}

/** One backend execution of a user request. */
export interface AgentRunMetrics {
  schemaVersion: 1;
  runId: string;
  /** Bumped on every authoritative change; clients merge by taking the max. */
  revision: number;
  status: ExecutionStatus;
  coverage: ExecutionCoverage;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  requests: LlmRequestMetrics[];
}

/** Back-pointer from a produced message to the execution that produced it. */
export interface MessageExecutionRef {
  runId: string;
  requestId?: string;
}

/** Schema version this build writes and understands. */
export const RUN_METRICS_SCHEMA_VERSION = 1;
