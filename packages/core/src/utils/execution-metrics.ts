/**
 * Pure derivations over persisted execution metrics.
 *
 * Everything here is a fold over facts that were measured elsewhere: nothing in
 * this file reads a clock, and no derived figure is ever written back to disk.
 * Renderer, WebUI and any server-side summary share these formulas so a turn
 * cannot show two different speeds.
 */

import type {
  AgentRunMetrics,
  ExecutionStatus,
  LlmRequestMetrics,
} from '../types/execution-metrics.ts';
import { RUN_METRICS_SCHEMA_VERSION } from '../types/execution-metrics.ts';

/** A number that survives arithmetic: finite, not NaN, not negative. */
function isMeasurement(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Displayable summary of one Run. Every field is optional on purpose: a
 *  missing reading must render as "unknown", never as 0. */
export interface RunMetricsSummary {
  runId: string;
  status: ExecutionStatus;
  /** True while the Run has not settled — the UI shows a running label. */
  isRunning: boolean;
  /** Whether this Run's request list is the whole execution. */
  isPartial: boolean;
  /** Wall time of the whole execution, including tools and approvals. */
  totalDurationMs?: number;
  /** TTFT of the Run's FIRST model call; absent when that call recorded none. */
  ttftMs?: number;
  /** Output tokens ÷ summed decode time over qualifying calls. */
  tokensPerSecond?: number;
  /** Output tokens summed over the calls that qualified for TPS. */
  sampledOutputTokens?: number;
  /** Calls that contributed a TPS sample. */
  sampledRequests: number;
  /** Calls recorded in this Run, whatever their state. */
  totalRequests: number;
}

/**
 * Whether a request can contribute to the Run's throughput reading.
 *
 * Only completed calls with a finite output-token count and a positive decode
 * window qualify. An aborted or failed call still shows its own duration in the
 * detail list — it just cannot speak for the model's speed.
 *
 * @param request - one recorded model call.
 * @returns true when the call is a usable throughput sample.
 */
export function isThroughputSample(request: LlmRequestMetrics): boolean {
  return (
    request.status === 'completed' &&
    isMeasurement(request.outputTokens) &&
    isMeasurement(request.decodeMs) &&
    (request.decodeMs as number) > 0
  );
}

/**
 * Fold one Run's requests into the figures the turn footer shows.
 *
 * Throughput sums tokens and decode time before dividing — averaging the
 * per-call rates would let a fast 100-token call outvote a slow 900-token one.
 *
 * @param run - the persisted Run, or undefined when the owner has none.
 * @returns the summary, or undefined when there is nothing to show.
 */
export function deriveRunMetrics(run: AgentRunMetrics | undefined): RunMetricsSummary | undefined {
  if (!run) return undefined;

  const requests = [...run.requests].sort((a, b) => a.sequence - b.sequence);
  let decodeMs = 0;
  let outputTokens = 0;
  let sampledRequests = 0;
  for (const request of requests) {
    if (!isThroughputSample(request)) continue;
    decodeMs += request.decodeMs as number;
    outputTokens += request.outputTokens as number;
    sampledRequests += 1;
  }

  const first = requests[0];
  const summary: RunMetricsSummary = {
    runId: run.runId,
    status: run.status,
    isRunning: run.status === 'running',
    isPartial: run.coverage === 'branch-prefix',
    sampledRequests,
    totalRequests: requests.length,
  };
  if (isMeasurement(run.durationMs)) summary.totalDurationMs = run.durationMs;
  if (first && isMeasurement(first.ttftMs)) summary.ttftMs = first.ttftMs;
  if (sampledRequests > 0 && decodeMs > 0) {
    summary.tokensPerSecond = outputTokens / (decodeMs / 1000);
    summary.sampledOutputTokens = outputTokens;
  }
  return summary;
}

/**
 * Drop readings that cannot be trusted so a corrupt file degrades to "not
 * recorded" instead of rendering NaN, Infinity or a negative duration.
 *
 * @param value - a candidate Run parsed from disk or received over IPC.
 * @returns a cleaned Run, or undefined when the shape is unusable.
 */
export function sanitizeRunMetrics(value: unknown): AgentRunMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const run = value as Partial<AgentRunMetrics>;
  if (run.schemaVersion !== RUN_METRICS_SCHEMA_VERSION) return undefined;
  if (typeof run.runId !== 'string' || !run.runId) return undefined;
  if (!isMeasurement(run.startedAt)) return undefined;
  if (!Array.isArray(run.requests)) return undefined;

  const requests: LlmRequestMetrics[] = [];
  for (const candidate of run.requests) {
    const request = sanitizeRequestMetrics(candidate);
    if (request) requests.push(request);
  }

  return {
    schemaVersion: RUN_METRICS_SCHEMA_VERSION,
    runId: run.runId,
    revision: isMeasurement(run.revision) ? run.revision : 0,
    status: normalizeStatus(run.status),
    coverage: run.coverage === 'branch-prefix' ? 'branch-prefix' : 'full',
    startedAt: run.startedAt,
    ...(isMeasurement(run.endedAt) ? { endedAt: run.endedAt } : {}),
    ...(isMeasurement(run.durationMs) ? { durationMs: run.durationMs } : {}),
    requests,
  };
}

function sanitizeRequestMetrics(value: unknown): LlmRequestMetrics | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const request = value as Partial<LlmRequestMetrics>;
  if (typeof request.requestId !== 'string' || !request.requestId) return undefined;
  if (request.measurement !== 'sdk-call-v1') return undefined;
  if (!isMeasurement(request.startedAt)) return undefined;

  return {
    requestId: request.requestId,
    sequence: isMeasurement(request.sequence) ? request.sequence : 1,
    measurement: 'sdk-call-v1',
    status: normalizeStatus(request.status),
    ...(typeof request.provider === 'string' ? { provider: request.provider } : {}),
    ...(typeof request.model === 'string' ? { model: request.model } : {}),
    startedAt: request.startedAt,
    ...(isMeasurement(request.endedAt) ? { endedAt: request.endedAt } : {}),
    ...(isMeasurement(request.durationMs) ? { durationMs: request.durationMs } : {}),
    ...(isMeasurement(request.ttftMs) ? { ttftMs: request.ttftMs } : {}),
    ...(isMeasurement(request.decodeMs) ? { decodeMs: request.decodeMs } : {}),
    ...(isMeasurement(request.inputTokens) ? { inputTokens: request.inputTokens } : {}),
    ...(isMeasurement(request.outputTokens) ? { outputTokens: request.outputTokens } : {}),
    ...(typeof request.finishReason === 'string' ? { finishReason: request.finishReason } : {}),
    messageIds: Array.isArray(request.messageIds) ? request.messageIds.filter(isNonEmptyString) : [],
    toolUseIds: Array.isArray(request.toolUseIds) ? request.toolUseIds.filter(isNonEmptyString) : [],
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function normalizeStatus(value: unknown): ExecutionStatus {
  return value === 'completed' || value === 'error' || value === 'aborted' || value === 'interrupted'
    ? value
    : 'running';
}

/** What a branch kept: the persisted ids that survive the cut. */
export interface BranchRetention {
  /** Message ids present in the branched transcript. */
  messageIds: ReadonlySet<string>;
  /** Tool-use ids whose tool message survived the cut. */
  toolUseIds: ReadonlySet<string>;
}

/**
 * Trim a Run so it describes only what the branch kept.
 *
 * A branch slices the transcript at a message; the Run recorded on the owning
 * user message may still describe calls made after that point. Copying it whole
 * would give the branch a total duration and a token count for work it does not
 * contain. This rebuilds the Run from the retained ids instead — deep-copying
 * throughout, so the source session's arrays are never shared or mutated.
 *
 * A call is kept whole only when every message and tool call it produced
 * survived the cut, or a later whole-kept call proves it finished first.
 * Anything else keeps its identity and loses its readings.
 *
 * @param run - the Run recorded on the source session's owner message.
 * @param retention - ids the branch kept.
 * @returns the trimmed Run, or undefined when nothing of it survives.
 */
export function trimRunMetricsForBranch(
  run: AgentRunMetrics,
  retention: BranchRetention,
): AgentRunMetrics | undefined {
  const ordered = [...run.requests].sort((a, b) => a.sequence - b.sequence);

  // Pass 1: a call is self-evidently whole when everything it produced is kept.
  const whole = new Set<string>();
  const touched = new Set<string>();
  for (const request of ordered) {
    const keptMessages = request.messageIds.filter(id => retention.messageIds.has(id));
    const keptTools = request.toolUseIds.filter(id => retention.toolUseIds.has(id));
    if (keptMessages.length > 0 || keptTools.length > 0) touched.add(request.requestId);
    const producedAnything = request.messageIds.length + request.toolUseIds.length > 0;
    if (
      producedAnything &&
      keptMessages.length === request.messageIds.length &&
      keptTools.length === request.toolUseIds.length
    ) {
      whole.add(request.requestId);
    }
  }

  // Pass 2: a call that produced nothing visible (an empty or failed response)
  // is provably finished when a later call was kept whole.
  let latestWholeSequence = -Infinity;
  for (const request of ordered) {
    if (whole.has(request.requestId)) latestWholeSequence = request.sequence;
  }
  for (const request of ordered) {
    if (whole.has(request.requestId) || touched.has(request.requestId)) continue;
    if (request.messageIds.length + request.toolUseIds.length > 0) continue;
    if (request.sequence < latestWholeSequence) whole.add(request.requestId);
  }

  const requests: LlmRequestMetrics[] = [];
  let trimmed = false;
  for (const request of ordered) {
    if (whole.has(request.requestId)) {
      requests.push({
        ...request,
        messageIds: [...request.messageIds],
        toolUseIds: [...request.toolUseIds],
      });
      continue;
    }
    const keptMessages = request.messageIds.filter(id => retention.messageIds.has(id));
    const keptTools = request.toolUseIds.filter(id => retention.toolUseIds.has(id));
    if (keptMessages.length === 0 && keptTools.length === 0) {
      // Nothing of this call is in the branch — it belongs to the future.
      trimmed = true;
      continue;
    }
    // Half a call: keep the association, drop every reading that describes the
    // half that is gone.
    trimmed = true;
    requests.push({
      requestId: request.requestId,
      sequence: request.sequence,
      measurement: request.measurement,
      status: 'interrupted',
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.model ? { model: request.model } : {}),
      startedAt: request.startedAt,
      messageIds: keptMessages,
      toolUseIds: keptTools,
    });
  }

  if (requests.length === 0) return undefined;
  if (!trimmed && run.coverage === 'full') {
    return { ...run, requests };
  }

  return {
    schemaVersion: run.schemaVersion,
    runId: run.runId,
    revision: run.revision,
    status: run.status,
    coverage: 'branch-prefix',
    startedAt: run.startedAt,
    requests,
  };
}
