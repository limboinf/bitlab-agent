/**
 * Model-call timing, sampled where the call is actually made.
 *
 * The wrapper around the SDK's `streamFn` is the only place that sees the exact
 * moment a request is dispatched, so latency is measured here and travels to
 * the main process as a finished number. Nothing subtracts a monotonic clock
 * across a process boundary, and nothing infers a duration from message
 * timestamps.
 *
 * The tracker owns the whole state machine so `index.ts` only has to install it
 * and hand it events.
 */

import type { LlmRequestMetrics, ExecutionStatus } from '@bitlab/core/types';

/** A pi-ai streaming event, narrowed to what first-output detection needs. */
interface AssistantStreamEvent {
  type: string;
  delta?: string;
  partial?: { content?: Array<{ type?: string; name?: string }> };
}

/** Provider usage as pi-ai reports it on a finished assistant message. */
export interface RequestUsage {
  input?: number;
  output?: number;
}

/** How the tracker reaches the outside world. Injected so tests can drive a
 *  fake clock and deterministic ids. */
export interface LlmRequestTrackerOptions {
  /** Epoch milliseconds, for human-readable `startedAt` / `endedAt`. */
  now?: () => number;
  /** Monotonic milliseconds, the only clock durations are measured against. */
  monotonic?: () => number;
  /** Unique id per call. */
  newRequestId?: () => string;
  onStarted: (request: LlmRequestMetrics) => void;
  onCompleted: (request: LlmRequestMetrics) => void;
}

interface ActiveRequest {
  requestId: string;
  sequence: number;
  provider?: string;
  model?: string;
  startedAt: number;
  startedMono: number;
  firstOutputMono?: number;
}

/**
 * Does this streaming event carry real model output?
 *
 * Role markers, stream `start`, empty deltas and usage frames all arrive before
 * the model has produced anything — counting them as the first token would
 * report a TTFT of nearly zero on every provider that opens with a preamble.
 *
 * @param event - one pi-ai assistant streaming event.
 * @returns true when the event is the model's first real output.
 */
export function isEffectiveFirstOutput(event: AssistantStreamEvent | undefined): boolean {
  if (!event) return false;
  switch (event.type) {
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return typeof event.delta === 'string' && event.delta.length > 0;
    case 'toolcall_start': {
      // No name on the event itself — the provider has only really committed to
      // a tool call once the partial message carries its name.
      const content = event.partial?.content;
      const last = Array.isArray(content) ? content[content.length - 1] : undefined;
      return last?.type === 'toolCall' && typeof last.name === 'string' && last.name.length > 0;
    }
    default:
      return false;
  }
}

function defaultRequestId(): string {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Tracks one model call at a time for a single Pi session.
 *
 * The SDK runs calls strictly one after another inside a session, so a single
 * active slot is enough — and it is what keeps a stray terminal event from
 * closing a call it does not belong to.
 */
export class LlmRequestTracker {
  private readonly now: () => number;
  private readonly monotonic: () => number;
  private readonly newRequestId: () => string;
  private readonly onStarted: (request: LlmRequestMetrics) => void;
  private readonly onCompleted: (request: LlmRequestMetrics) => void;

  private active: ActiveRequest | null = null;
  private sequence = 0;
  /** Set when the user asked to stop, so the call that unwinds is reported as
   *  aborted rather than as a provider error. */
  private abortRequested = false;

  constructor(options: LlmRequestTrackerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.monotonic = options.monotonic ?? (() => performance.now());
    this.newRequestId = options.newRequestId ?? defaultRequestId;
    this.onStarted = options.onStarted;
    this.onCompleted = options.onCompleted;
  }

  /** Whether a call is currently in flight. */
  get hasActiveRequest(): boolean {
    return this.active !== null;
  }

  /** Whether the call in flight has produced any real output yet. */
  get sawOutput(): boolean {
    return this.active?.firstOutputMono !== undefined;
  }

  /** Reset per-run state at the start of a new execution. */
  startRun(): void {
    this.sequence = 0;
    this.abortRequested = false;
  }

  /** Record the user's stop request; the call unwinding next is `aborted`. */
  markAborted(): void {
    this.abortRequested = true;
  }

  /**
   * Open a call. Emitted before the SDK's own `streamFn` runs, so the reading
   * includes auth, header assembly and every provider-internal retry.
   *
   * @param model - the model this call is dispatched against.
   * @returns the id assigned to this call.
   */
  beginRequest(model?: { id?: string; provider?: string }): string {
    // Defensive: a previous call that never settled would otherwise leak its
    // slot and swallow this one's terminal event.
    if (this.active) this.settle('interrupted');

    this.sequence += 1;
    this.active = {
      requestId: this.newRequestId(),
      sequence: this.sequence,
      provider: model?.provider,
      model: model?.id,
      startedAt: this.now(),
      startedMono: this.monotonic(),
    };
    this.onStarted(this.snapshot(this.active, 'running'));
    return this.active.requestId;
  }

  /** Feed one streaming event; the first effective one stamps TTFT. */
  observeStreamEvent(event: AssistantStreamEvent | undefined): void {
    const active = this.active;
    if (!active || active.firstOutputMono !== undefined) return;
    if (!isEffectiveFirstOutput(event)) return;
    active.firstOutputMono = this.monotonic();
  }

  /**
   * Close the active call.
   *
   * Repeat terminal events are ignored: the SDK can synthesize a `message_end`
   * after the wrapper has already reported the rejection that produced it, and
   * the first reading is the honest one.
   *
   * @param status - the outcome the caller observed.
   * @param details - provider usage and finish reason, when known.
   */
  completeRequest(
    status: ExecutionStatus,
    details?: { usage?: RequestUsage; finishReason?: string; toolUseIds?: string[] },
  ): void {
    if (!this.active) return;
    this.settle(status, details);
  }

  /** Close anything still open because the session is going away. */
  interrupt(): void {
    if (this.active) this.settle('interrupted');
  }

  private settle(
    status: ExecutionStatus,
    details?: { usage?: RequestUsage; finishReason?: string; toolUseIds?: string[] },
  ): void {
    const active = this.active;
    if (!active) return;
    this.active = null;

    const effectiveStatus = this.abortRequested && status === 'error' ? 'aborted' : status;
    if (effectiveStatus === 'aborted') this.abortRequested = false;

    const endedMono = this.monotonic();
    const durationMs = Math.max(0, endedMono - active.startedMono);
    const request = this.snapshot(active, effectiveStatus);
    request.endedAt = this.now();
    request.durationMs = durationMs;
    if (active.firstOutputMono !== undefined) {
      request.ttftMs = Math.max(0, active.firstOutputMono - active.startedMono);
      request.decodeMs = Math.max(0, endedMono - active.firstOutputMono);
    }
    const output = details?.usage?.output;
    const input = details?.usage?.input;
    if (typeof output === 'number' && Number.isFinite(output) && output >= 0) request.outputTokens = output;
    if (typeof input === 'number' && Number.isFinite(input) && input >= 0) request.inputTokens = input;
    if (details?.finishReason) request.finishReason = details.finishReason;
    if (details?.toolUseIds?.length) request.toolUseIds = [...details.toolUseIds];
    this.onCompleted(request);
  }

  private snapshot(active: ActiveRequest, status: ExecutionStatus): LlmRequestMetrics {
    return {
      requestId: active.requestId,
      sequence: active.sequence,
      measurement: 'sdk-call-v1',
      status,
      ...(active.provider ? { provider: active.provider } : {}),
      ...(active.model ? { model: active.model } : {}),
      startedAt: active.startedAt,
      messageIds: [],
      toolUseIds: [],
    };
  }
}

/**
 * Wrap a session's `streamFn` so every SDK call is timed.
 *
 * The original function keeps doing auth, headers, timeouts and provider
 * retries; the wrapper only brackets it. The returned stream object is passed
 * through untouched — consuming it here would steal events from the agent loop.
 *
 * @param original - the SDK's own stream function.
 * @param tracker - the tracker to bracket each call with.
 * @param shouldTrack - gate for calls that are not part of the chat turn
 *   (compaction, title generation); those still run, they just aren't sampled.
 * @returns the wrapped stream function.
 */
export function instrumentStreamFn<Fn>(
  original: Fn,
  tracker: LlmRequestTracker,
  shouldTrack: () => boolean,
): Fn {
  const call = original as unknown as (
    this: unknown,
    model: { id?: string; provider?: string },
    ...rest: unknown[]
  ) => Promise<unknown>;
  const wrapped = async function (
    this: unknown,
    model: { id?: string; provider?: string },
    ...rest: unknown[]
  ) {
    if (!shouldTrack()) return call.call(this, model, ...rest);
    tracker.beginRequest(model);
    try {
      return await call.call(this, model, ...rest);
    } catch (error) {
      tracker.completeRequest('error');
      throw error;
    }
  };
  return wrapped as unknown as Fn;
}
