/**
 * Task list helpers shared by the two places a `todo_write` call is shown:
 * the one-line row in the transcript and the strip above the composer.
 *
 * Both read the same derived list, so both count it the same way here rather
 * than each rolling its own tally that can drift.
 */

import i18n from 'i18next'
import type { TodoItem } from './TurnCard'

export interface TaskListCounts {
  pending: number
  inProgress: number
  completed: number
  total: number
}

export function countTaskList(todos: readonly TodoItem[]): TaskListCounts {
  return {
    pending: todos.filter(todo => todo.status === 'pending').length,
    inProgress: todos.filter(todo => todo.status === 'in_progress').length,
    completed: todos.filter(todo => todo.status === 'completed').length,
    total: todos.length,
  }
}

/**
 * Header line: only the statuses that actually have tasks, so a fresh list
 * reads "5 待处理" instead of "0 已完成 · 0 进行中 · 5 待处理".
 *
 * Once the agent stops (`live: false`), a task still marked in_progress is not
 * in progress any more — nothing is running. It reads as unfinished, which is
 * what actually happened: the agent ended its turn without ticking it off.
 */
export function formatTaskListProgress(
  todos: readonly TodoItem[],
  options: { live?: boolean } = {},
): string {
  const { pending, inProgress, completed } = countTaskList(todos)
  const activeKey = options.live === false ? 'taskList.progressUnfinished' : 'taskList.progressActive'
  return [
    ...completed > 0 ? [i18n.t('taskList.progressDone', { count: completed })] : [],
    ...inProgress > 0 ? [i18n.t(activeKey, { count: inProgress })] : [],
    ...pending > 0 ? [i18n.t('taskList.progressPending', { count: pending })] : [],
  ].join(' · ')
}

/**
 * Transcript row summary: "3/5 · 正在做 X". Takes the raw tool input because
 * a mid-stream or rejected call can carry anything; anything unrecognizable
 * falls back to the generic tool-input rendering.
 */
export function formatTaskListSummary(todos: unknown): string {
  if (!Array.isArray(todos)) return ''

  const entries = todos.filter(
    (todo): todo is { content: string; status: string } =>
      typeof todo === 'object' && todo !== null
      && typeof (todo as { content?: unknown }).content === 'string'
  )
  if (entries.length === 0) return ''

  const done = entries.filter(todo => todo.status === 'completed').length
  const active = entries.find(todo => todo.status === 'in_progress')
  const progress = `${done}/${entries.length}`

  return active ? `${progress} · ${active.content}` : progress
}
