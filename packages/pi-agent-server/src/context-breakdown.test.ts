import { describe, expect, it } from 'bun:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  computeContextBreakdown,
  estimateMessageTokens,
  estimateSkillCatalogTokens,
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

describe('estimateSkillCatalogTokens', () => {
  const CATALOG = [
    '',
    '',
    'The following skills provide specialized instructions for specific tasks.',
    'Use the read tool to load a skill\'s file when the task matches its description.',
    '',
    '<available_skills>',
    '  <skill>',
    '    <name>alpha</name>',
    '    <description>does alpha things</description>',
    '    <location>/skills/alpha/SKILL.md</location>',
    '  </skill>',
    '</available_skills>',
  ].join('\n');

  it('is zero when the prompt carries no catalog', () => {
    expect(estimateSkillCatalogTokens('a prompt with no skills at all')).toBe(0);
    expect(estimateSkillCatalogTokens(undefined)).toBe(0);
  });

  it('prices the block including its instruction lines', () => {
    const prompt = `BASE PROMPT${CATALOG}\nCurrent date: 2026-01-01`;
    const tokens = estimateSkillCatalogTokens(prompt);

    // The whole block, and nothing outside it.
    expect(tokens).toBe(Math.ceil(CATALOG.trimStart().length / 4));
  });

  it('stays a subset of the system prompt figure', () => {
    const prompt = `BASE PROMPT${CATALOG}`;

    expect(estimateSkillCatalogTokens(prompt)).toBeLessThan(estimateSystemTokens(prompt));
  });

  it('grows with the catalog', () => {
    const one = `BASE${CATALOG}`;
    const two = `BASE${CATALOG.replace('</available_skills>', '  <skill>\n    <name>beta</name>\n    <description>does beta things</description>\n  </skill>\n</available_skills>')}`;

    expect(estimateSkillCatalogTokens(two)).toBeGreaterThan(estimateSkillCatalogTokens(one));
  });
});
