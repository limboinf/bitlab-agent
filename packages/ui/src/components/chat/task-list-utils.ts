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
 * Header line.
 *
 * While the agent works, it tallies the statuses that actually have tasks, so a
 * fresh list reads "5 待处理" instead of "0 已完成 · 0 进行中 · 5 待处理".
 *
 * Once the turn ends (`live: false`) nothing is running any more, and a
 * status-by-status tally still invites the eye to read leftover work as work in
 * flight. So it collapses to the outcome — "已停止 · 0/5" — or to the plain done
 * count when the agent got through everything.
 */
export function formatTaskListProgress(
  todos: readonly TodoItem[],
  options: { live?: boolean } = {},
): string {
  const { pending, inProgress, completed, total } = countTaskList(todos)

  if (options.live === false) {
    return completed === total
      ? i18n.t('taskList.progressDone', { count: completed })
      : i18n.t('taskList.progressStopped', { done: completed, total })
  }

  return [
    ...completed > 0 ? [i18n.t('taskList.progressDone', { count: completed })] : [],
    ...inProgress > 0 ? [i18n.t('taskList.progressActive', { count: inProgress })] : [],
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
