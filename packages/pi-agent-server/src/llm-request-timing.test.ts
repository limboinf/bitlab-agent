import { describe, expect, it } from 'bun:test';
import type { LlmRequestMetrics } from '@bitlab/core/types';
import { LlmRequestTracker, instrumentStreamFn, isEffectiveFirstOutput } from './llm-request-timing.ts';

/** A tracker driven by a fake clock, so assertions are exact millisecond facts. */
function makeTracker() {
  let mono = 0;
  let wall = 1_700_000_000_000;
  let ids = 0;
  const started: LlmRequestMetrics[] = [];
  const completed: LlmRequestMetrics[] = [];
  const tracker = new LlmRequestTracker({
    monotonic: () => mono,
    now: () => wall,
    newRequestId: () => `req-${++ids}`,
    onStarted: request => started.push(request),
    onCompleted: request => completed.push(request),
  });
  return {
    tracker,
    started,
    completed,
    advance(ms: number) { mono += ms; wall += ms; },
    /** A wall clock that jumped backwards while the monotonic one kept going. */
    rewindWallClock(ms: number) { wall -= ms; },
  };
}

describe('isEffectiveFirstOutput', () => {
  it('counts non-empty text, reasoning and tool-argument deltas', () => {
    expect(isEffectiveFirstOutput({ type: 'text_delta', delta: 'a' })).toBe(true);
    expect(isEffectiveFirstOutput({ type: 'thinking_delta', delta: 'a' })).toBe(true);
    expect(isEffectiveFirstOutput({ type: 'toolcall_delta', delta: '{' })).toBe(true);
  });

  it('ignores stream metadata and empty deltas', () => {
    expect(isEffectiveFirstOutput({ type: 'start' })).toBe(false);
    expect(isEffectiveFirstOutput({ type: 'text_start' })).toBe(false);
    expect(isEffectiveFirstOutput({ type: 'text_delta', delta: '' })).toBe(false);
    expect(isEffectiveFirstOutput(undefined)).toBe(false);
  });

  it('treats a tool call as output only once the provider named it', () => {
    expect(isEffectiveFirstOutput({ type: 'toolcall_start', partial: { content: [{ type: 'toolCall' }] } })).toBe(false);
    expect(isEffectiveFirstOutput({
      type: 'toolcall_start',
      partial: { content: [{ type: 'toolCall', name: 'read' }] },
    })).toBe(true);
  });
});

describe('LlmRequestTracker', () => {
  it('measures duration, TTFT and decode across one call', () => {
    const h = makeTracker();
    h.tracker.startRun();
    h.tracker.beginRequest({ id: 'gpt-x', provider: 'openai' });
    h.advance(600);
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: 'hi' });
    h.advance(10_000);
    h.tracker.completeRequest('completed', { usage: { output: 1_000 }, finishReason: 'stop' });

    const request = h.completed[0]!;
    expect(request.durationMs).toBe(10_600);
    expect(request.ttftMs).toBe(600);
    expect(request.decodeMs).toBe(10_000);
    expect(request.outputTokens).toBe(1_000);
    expect(request.model).toBe('gpt-x');
    expect(request.provider).toBe('openai');
  });

  it('stamps TTFT from reasoning and does not reset it when text starts', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(200);
    h.tracker.observeStreamEvent({ type: 'thinking_delta', delta: 'hmm' });
    h.advance(300);
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: 'answer' });
    h.advance(500);
    h.tracker.completeRequest('completed');

    expect(h.completed[0]!.ttftMs).toBe(200);
  });

  it('ignores leading metadata frames when stamping TTFT', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(50);
    h.tracker.observeStreamEvent({ type: 'start' });
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: '' });
    h.advance(450);
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: 'x' });
    h.tracker.completeRequest('completed');

    expect(h.completed[0]!.ttftMs).toBe(500);
  });

  it('keeps the duration but no TTFT when nothing streamed', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(4_000);
    h.tracker.completeRequest('completed', { usage: { output: 42 } });

    const request = h.completed[0]!;
    expect(request.durationMs).toBe(4_000);
    expect(request.ttftMs).toBeUndefined();
    expect(request.decodeMs).toBeUndefined();
  });

  it('settles a call exactly once, whatever arrives afterwards', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(100);
    h.tracker.completeRequest('error');
    h.tracker.completeRequest('completed', { usage: { output: 10 } });

    expect(h.completed).toHaveLength(1);
    expect(h.completed[0]!.status).toBe('error');
  });

  it('reports a stopped call as cancelled rather than as a provider failure', () => {
    const h = makeTracker();
    h.tracker.startRun();
    h.tracker.beginRequest();
    h.tracker.markAborted();
    h.advance(300);
    h.tracker.completeRequest('error');

    expect(h.completed[0]!.status).toBe('aborted');
  });

  it('numbers calls within a run and restarts at 1 for the next run', () => {
    const h = makeTracker();
    h.tracker.startRun();
    h.tracker.beginRequest();
    h.tracker.completeRequest('completed');
    h.tracker.beginRequest();
    h.tracker.completeRequest('completed');
    h.tracker.startRun();
    h.tracker.beginRequest();

    expect(h.started.map(item => item.sequence)).toEqual([1, 2, 1]);
    expect(new Set(h.started.map(item => item.requestId)).size).toBe(3);
  });

  it('survives a backwards wall-clock jump without a negative duration', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(2_000);
    h.rewindWallClock(60_000);
    h.tracker.completeRequest('completed');

    expect(h.completed[0]!.durationMs).toBe(2_000);
  });

  it('closes an open call when the session goes away', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(500);
    h.tracker.interrupt();

    expect(h.completed[0]!.status).toBe('interrupted');
    expect(h.tracker.hasActiveRequest).toBe(false);
  });

  it('preserves a length-truncated finish reason', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    h.advance(100);
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: 'x' });
    h.advance(900);
    h.tracker.completeRequest('completed', { usage: { output: 4_096 }, finishReason: 'length' });

    expect(h.completed[0]!.finishReason).toBe('length');
    expect(h.completed[0]!.status).toBe('completed');
  });
});

describe('instrumentStreamFn', () => {
  it('brackets the original call and passes its result through untouched', async () => {
    const h = makeTracker();
    const stream = { marker: 'stream' };
    const wrapped = instrumentStreamFn(
      async () => { h.advance(700); return stream; },
      h.tracker,
      () => true,
    );

    await expect(wrapped({ id: 'm' })).resolves.toBe(stream);
    expect(h.started).toHaveLength(1);
    expect(h.completed).toHaveLength(0);
  });

  it('closes the call and rethrows when the SDK call rejects', async () => {
    const h = makeTracker();
    const wrapped = instrumentStreamFn(
      async () => { h.advance(120); throw new Error('boom'); },
      h.tracker,
      () => true,
    );

    await expect(wrapped({ id: 'm' })).rejects.toThrow('boom');
    expect(h.completed[0]!.status).toBe('error');
    expect(h.completed[0]!.durationMs).toBe(120);
  });

  it('leaves untracked calls unsampled but still working', async () => {
    const h = makeTracker();
    const wrapped = instrumentStreamFn(async () => 'compacted', h.tracker, () => false);

    await expect(wrapped({ id: 'm' })).resolves.toBe('compacted');
    expect(h.started).toHaveLength(0);
  });
});

describe('empty-response guard', () => {
  it('reports no output seen while a call has streamed nothing', () => {
    const h = makeTracker();
    h.tracker.beginRequest();
    expect(h.tracker.sawOutput).toBe(false);
    h.tracker.observeStreamEvent({ type: 'text_delta', delta: 'x' });
    expect(h.tracker.sawOutput).toBe(true);
  });
});
