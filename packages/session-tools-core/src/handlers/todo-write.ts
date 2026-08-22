/**
 * todo_write Handler
 *
 * Whole-list replacement for the agent's task checklist. Every call carries the
 * COMPLETE list and replaces the previous one — there are no partial updates.
 *
 * The handler deliberately stores nothing. The call itself is the state: the
 * transcript already persists each tool call with its input, so the checklist
 * the UI shows is a pure derivation of the last successful `todo_write` in the
 * current turn. One source of truth, identical on live stream and on reload,
 * and no extra protocol event to keep in sync.
 *
 * What the handler does own is the shape of that state. Anything that would
 * make the derived list unreadable — blank lines, duplicates, several tasks
 * claiming to be active at once — is rejected here rather than rendered.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoEntry {
  content: string;
  status: TodoStatus;
}

export interface TodoWriteArgs {
  todos: TodoEntry[];
}

export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

/**
 * Normalize the model's list, or explain what is wrong with it.
 *
 * Returns either the canonical list or a message written for the model to act
 * on — it gets one round trip to fix the call, so the message names the rule
 * it broke.
 */
export function normalizeTodos(
  todos: TodoEntry[]
): { ok: true; todos: TodoEntry[] } | { ok: false; error: string } {
  const normalized: TodoEntry[] = [];
  const seen = new Set<string>();
  let active = 0;

  for (const todo of todos) {
    const content = todo.content.trim();
    if (content.length === 0) {
      return { ok: false, error: 'Every task needs non-empty `content`.' };
    }
    if (seen.has(content)) {
      return { ok: false, error: `Duplicate task ${JSON.stringify(content)}. Each task must appear once.` };
    }
    seen.add(content);
    if (todo.status === 'in_progress') active++;
    normalized.push({ content, status: todo.status });
  }

  if (active > 1) {
    return {
      ok: false,
      error: `${active} tasks are marked in_progress. Exactly one task may be in_progress at a time — `
        + 'mark the one you are working on now, leave the rest pending.',
    };
  }

  return { ok: true, todos: normalized };
}

/** Per-status tally, used for the one-line summary the transcript shows. */
export function countTodos(todos: TodoEntry[]): TodoCounts {
  return {
    pending: todos.filter(todo => todo.status === 'pending').length,
    inProgress: todos.filter(todo => todo.status === 'in_progress').length,
    completed: todos.filter(todo => todo.status === 'completed').length,
  };
}

/**
 * Handle the todo_write tool call: validate, then report back what the list
 * now looks like so the model can see its own progress without re-reading.
 */
export async function handleTodoWrite(
  _ctx: SessionToolContext,
  args: TodoWriteArgs
): Promise<ToolResult> {
  const result = normalizeTodos(args.todos);
  if (!result.ok) return errorResponse(result.error);

  const { todos } = result;
  const counts = countTodos(todos);
  const active = todos.find(todo => todo.status === 'in_progress');

  const summary = `Task list updated: ${counts.completed} completed, `
    + `${counts.inProgress} in progress, ${counts.pending} pending.`;

  return {
    ...successResponse(active ? `${summary} Now working on: ${active.content}` : summary),
    structuredContent: { counts, total: todos.length },
  };
}
