/**
 * Completion bridge for background sub-agents.
 *
 * The payload shape here is the extension's `buildEventData` (dist/index.js):
 * `{ id, type, description, result, error, status, toolUses, durationMs, tokens }`.
 * It is a third-party contract on a stringly-typed event bus, so a rename on
 * either side fails silently — the launcher would simply never learn its
 * background work finished. These tests pin the translation.
 */

import { describe, expect, it } from 'bun:test';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createSubagentsHostExtension, type SubagentSettledPayload } from './subagents-extension.ts';

type Handler = (data: unknown) => void;

function mountBridge() {
  const handlers = new Map<string, Handler[]>();
  const settled: SubagentSettledPayload[] = [];
  const pi = {
    events: {
      emit: (channel: string, data: unknown) => {
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
      on: (channel: string, handler: Handler) => {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => {
          handlers.set(channel, (handlers.get(channel) ?? []).filter(h => h !== handler));
        };
      },
    },
  } as unknown as ExtensionAPI;

  const extension = createSubagentsHostExtension(payload => settled.push(payload));
  extension.factory(pi);
  return { pi, settled, extension };
}

describe('sub-agent completion bridge', () => {
  it('forwards a completed agent with its result as the summary', () => {
    const { pi, settled } = mountBridge();

    pi.events.emit('subagents:completed', {
      id: '741c2af3-adc3-449',
      type: 'Explore',
      description: '调研Pi多agent实现',
      result: '  调研完成。以下为报告。  ',
      status: 'completed',
      toolUses: 10,
      durationMs: 35_400,
    });

    expect(settled).toEqual([{
      agentId: '741c2af3-adc3-449',
      status: 'completed',
      description: '调研Pi多agent实现',
      summary: '调研完成。以下为报告。',
    }]);
  });

  it('maps an errored agent to failed and carries the error', () => {
    const { pi, settled } = mountBridge();

    pi.events.emit('subagents:failed', {
      id: 'deadbeef-1',
      type: 'Explore',
      status: 'error',
      error: 'boom',
    });

    expect(settled[0]).toMatchObject({ agentId: 'deadbeef-1', status: 'failed', summary: 'boom' });
  });

  it('keeps stopped distinct from failed', () => {
    const { pi, settled } = mountBridge();

    pi.events.emit('subagents:failed', { id: 'halted-1', status: 'stopped' });

    expect(settled[0]).toMatchObject({ agentId: 'halted-1', status: 'stopped' });
  });

  it('ignores payloads without an agent id', () => {
    const { pi, settled } = mountBridge();

    pi.events.emit('subagents:completed', { status: 'completed' });
    pi.events.emit('subagents:completed', null);

    expect(settled).toEqual([]);
  });

  it('detaches the previous subscription when a reload remounts it', () => {
    const { pi, settled, extension } = mountBridge();

    // A session reload builds a new instance on the SAME bus.
    const second: SubagentSettledPayload[] = [];
    const rebuilt = createSubagentsHostExtension(payload => second.push(payload));
    rebuilt.factory(pi);

    pi.events.emit('subagents:completed', { id: 'once-1', status: 'completed' });

    expect(second).toHaveLength(1);
    expect(settled).toHaveLength(0); // the first instance must not double-forward
    expect(extension.name).toBe('bitlab-subagents-host');
  });
});
