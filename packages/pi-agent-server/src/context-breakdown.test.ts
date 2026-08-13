import { describe, expect, it } from 'bun:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  computeContextBreakdown,
  estimateMessageTokens,
  estimateSystemTokens,
  estimateToolsTokens,
} from './context-breakdown.ts';

const userMessage = (text: string): AgentMessage =>
  ({ role: 'user', content: text, timestamp: 0 }) as AgentMessage;

describe('estimateSystemTokens', () => {
  it('prices the prompt at the shared chars/4 density', () => {
    expect(estimateSystemTokens('a'.repeat(400))).toBe(100);
  });

  it('returns 0 before a prompt is known', () => {
    expect(estimateSystemTokens(undefined)).toBe(0);
    expect(estimateSystemTokens('')).toBe(0);
  });
});

describe('estimateToolsTokens', () => {
  it('returns 0 when no tool is active', () => {
    expect(estimateToolsTokens([])).toBe(0);
  });

  it('grows with the number of tools', () => {
    const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object' } };
    const one = estimateToolsTokens([tool]);
    const two = estimateToolsTokens([tool, { ...tool, name: 'write' }]);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
  });

  it('ignores local-only fields that never reach the wire', () => {
    const bare = { name: 'read', description: 'Read a file', parameters: {} };
    const decorated = {
      ...bare,
      label: 'Read'.repeat(500),
      promptSnippet: 'x'.repeat(5000),
      execute: () => undefined,
    };
    expect(estimateToolsTokens([decorated])).toBe(estimateToolsTokens([bare]));
  });
});

describe('estimateMessageTokens', () => {
  it('sums the SDK estimate over every message', () => {
    const messages = [userMessage('a'.repeat(400)), userMessage('b'.repeat(800))];
    expect(estimateMessageTokens(messages)).toBe(300);
  });

  it('returns 0 for an empty conversation', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});

describe('computeContextBreakdown', () => {
  it('reports the three parts independently', () => {
    const breakdown = computeContextBreakdown(
      's'.repeat(400),
      [{ name: 'read', description: 'Read a file', parameters: {} }],
      [userMessage('m'.repeat(800))],
    );
    expect(breakdown.systemTokens).toBe(100);
    expect(breakdown.messageTokens).toBe(200);
    expect(breakdown.toolsTokens).toBeGreaterThan(0);
  });
});
