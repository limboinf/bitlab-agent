import { describe, it, expect } from 'bun:test';
import { handleTodoWrite, normalizeTodos, type TodoEntry } from './todo-write.ts';
import type { SessionToolContext } from '../context.ts';

const ctx = {} as SessionToolContext;

function list(...entries: [string, TodoEntry['status']][]): TodoEntry[] {
  return entries.map(([content, status]) => ({ content, status }));
}

describe('normalizeTodos', () => {
  it('trims content so the rendered strip has no ragged edges', () => {
    const result = normalizeTodos(list(['  Ship the thing  ', 'pending']));
    expect(result).toEqual({ ok: true, todos: list(['Ship the thing', 'pending']) });
  });

  it('rejects blank content', () => {
    const result = normalizeTodos(list(['   ', 'pending']));
    expect(result.ok).toBe(false);
  });

  it('rejects duplicates — the strip keys rows by content', () => {
    const result = normalizeTodos(list(['Same', 'pending'], ['Same', 'completed']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Duplicate');
  });

  it('rejects two active tasks and says how to fix it', () => {
    const result = normalizeTodos(list(['A', 'in_progress'], ['B', 'in_progress']));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('one task may be in_progress');
  });

  it('accepts a list with no active task — the finished state', () => {
    const result = normalizeTodos(list(['A', 'completed'], ['B', 'completed']));
    expect(result.ok).toBe(true);
  });

  it('accepts an empty list — an explicit "no plan any more"', () => {
    expect(normalizeTodos([])).toEqual({ ok: true, todos: [] });
  });
});

describe('handleTodoWrite', () => {
  it('reports the tally and names the active task', async () => {
    const result = await handleTodoWrite(ctx, {
      todos: list(['Research', 'completed'], ['Implement', 'in_progress'], ['Test', 'pending']),
    });

    expect(result.isError).toBe(false);
    expect(result.content[0]?.text).toContain('1 completed, 1 in progress, 1 pending');
    expect(result.content[0]?.text).toContain('Now working on: Implement');
    expect(result.structuredContent).toEqual({
      counts: { pending: 1, inProgress: 1, completed: 1 },
      total: 3,
    });
  });

  it('omits the active clause when nothing is running', async () => {
    const result = await handleTodoWrite(ctx, { todos: list(['Done', 'completed']) });
    expect(result.content[0]?.text).not.toContain('Now working on');
  });

  it('surfaces validation failures as tool errors, not silent fixes', async () => {
    const result = await handleTodoWrite(ctx, { todos: list(['A', 'in_progress'], ['B', 'in_progress']) });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('[ERROR]');
  });
});
