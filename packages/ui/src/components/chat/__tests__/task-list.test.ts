/**
 * Tests for the task list derived from `todo_write` calls: what the transcript
 * turns into, and what the strip above the composer is allowed to show.
 */

import { describe, it, expect, beforeAll } from 'bun:test'
import i18n from 'i18next'
import { groupMessagesByTurn, getCurrentTaskList } from '../turn-utils'
import { formatTaskListSummary, countTaskList, formatTaskListProgress } from '../task-list-utils'
import type { Message } from '@bitlab/core'

beforeAll(async () => {
  // The progress line is translated; without resources every key renders empty
  // and the wording assertions below would pass on any key at all.
  await i18n.init({
    lng: 'en',
    resources: {
      en: {
        translation: {
          'taskList.progressDone_one': '{{count}} done',
          'taskList.progressDone_other': '{{count}} done',
          'taskList.progressActive_one': '{{count}} in progress',
          'taskList.progressActive_other': '{{count}} in progress',
          'taskList.progressStopped': 'Stopped · {{done}}/{{total}}',
          'taskList.progressPending_one': '{{count}} pending',
          'taskList.progressPending_other': '{{count}} pending',
        },
      },
    },
  })
})

let seq = 0
const at = () => 1_000 + ++seq

function userMessage(content: string): Message {
  return { id: `u-${seq}`, role: 'user', content, timestamp: at() }
}

function todoWrite(
  todos: Array<{ content: string; status: string }>,
  overrides: Partial<Message> = {},
): Message {
  return {
    id: `t-${seq}`,
    role: 'tool',
    content: 'Task list updated.',
    timestamp: at(),
    toolUseId: `tool-${seq}`,
    toolName: 'mcp__session__todo_write',
    toolInput: { todos },
    toolStatus: 'completed',
    ...overrides,
  } as Message
}

function assistantMessage(content: string): Message {
  return { id: `a-${seq}`, role: 'assistant', content, timestamp: at() }
}

function errorMessage(content: string): Message {
  return { id: `e-${seq}`, role: 'error', content, timestamp: at() } as Message
}

describe('getCurrentTaskList', () => {
  it('returns the list written by the turn in progress', () => {
    const turns = groupMessagesByTurn([
      userMessage('do the thing'),
      todoWrite([
        { content: 'Research', status: 'completed' },
        { content: 'Implement', status: 'in_progress' },
      ]),
    ])

    expect(getCurrentTaskList(turns)).toEqual([
      { content: 'Research', status: 'completed' },
      { content: 'Implement', status: 'in_progress' },
    ])
  })

  it('keeps only the newest write — each call replaces the whole list', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Old plan', status: 'pending' }]),
      todoWrite([{ content: 'New plan', status: 'in_progress' }]),
    ])

    expect(getCurrentTaskList(turns)).toEqual([{ content: 'New plan', status: 'in_progress' }])
  })

  it('keeps the finished checklist visible after the turn ends', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Ship it', status: 'completed' }]),
      assistantMessage('Done.'),
    ])

    expect(getCurrentTaskList(turns)).toEqual([{ content: 'Ship it', status: 'completed' }])
  })

  it('goes quiet the moment the user opens a new turn', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Ship it', status: 'completed' }]),
      assistantMessage('Done.'),
      userMessage('now something else'),
    ])

    expect(getCurrentTaskList(turns)).toBeUndefined()
  })

  it('ignores a rejected write — it never became the list', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Bad', status: 'in_progress' }], {
        isError: true,
        toolResult: '[ERROR] 2 tasks are marked in_progress.',
      } as Partial<Message>),
    ])

    expect(getCurrentTaskList(turns)).toBeUndefined()
  })

  it('ignores a malformed payload rather than rendering junk', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Fine', status: 'nonsense' }]),
    ])

    expect(getCurrentTaskList(turns)).toBeUndefined()
  })

  it("ignores a subagent's own checklist", () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Main plan', status: 'in_progress' }]),
      todoWrite([{ content: 'Helper plan', status: 'in_progress' }], {
        parentToolUseId: 'parent-task',
      } as Partial<Message>),
    ])

    expect(getCurrentTaskList(turns)).toEqual([{ content: 'Main plan', status: 'in_progress' }])
  })

  it('survives the error that ended the turn', () => {
    // The empty-completion guard files an error message after the assistant
    // turn. That error is exactly when "how far did it get" matters.
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([
        { content: 'Set up', status: 'in_progress' },
        { content: 'Ship it', status: 'pending' },
      ]),
      errorMessage('Empty Response: the model returned nothing.'),
    ])

    expect(getCurrentTaskList(turns)).toEqual([
      { content: 'Set up', status: 'in_progress' },
      { content: 'Ship it', status: 'pending' },
    ])
  })

  it('still goes quiet when the user speaks after an error', () => {
    const turns = groupMessagesByTurn([
      userMessage('go'),
      todoWrite([{ content: 'Set up', status: 'in_progress' }]),
      errorMessage('Empty Response: the model returned nothing.'),
      userMessage('never mind'),
    ])

    expect(getCurrentTaskList(turns)).toBeUndefined()
  })

  it('has nothing to show before the agent plans anything', () => {
    expect(getCurrentTaskList(groupMessagesByTurn([userMessage('hi')]))).toBeUndefined()
  })
})

describe('task list formatting', () => {
  it('counts each status', () => {
    expect(countTaskList([
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
      { content: 'd', status: 'pending' },
    ])).toEqual({ pending: 2, inProgress: 1, completed: 1, total: 4 })
  })

  it('summarizes a row as progress plus the active task', () => {
    expect(formatTaskListSummary([
      { content: 'a', status: 'completed' },
      { content: 'Write the docs', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ])).toBe('1/3 · Write the docs')
  })

  it('drops the active clause when nothing is running', () => {
    expect(formatTaskListSummary([{ content: 'a', status: 'completed' }])).toBe('1/1')
  })

  it('tallies each status while the agent is working', () => {
    const todos = [
      { content: 'a', status: 'completed' as const },
      { content: 'b', status: 'in_progress' as const },
      { content: 'c', status: 'pending' as const },
    ]

    expect(formatTaskListProgress(todos, { live: true })).toBe('1 done · 1 in progress · 1 pending')
  })

  it('reports how far a stopped turn got instead of what is running', () => {
    const todos = [
      { content: 'a', status: 'completed' as const },
      { content: 'b', status: 'in_progress' as const },
      { content: 'c', status: 'pending' as const },
    ]

    const stopped = formatTaskListProgress(todos, { live: false })
    expect(stopped).toBe('Stopped · 1/3')
    expect(stopped).not.toContain('in progress')
  })

  it('calls a finished checklist done, not stopped', () => {
    const todos = [
      { content: 'a', status: 'completed' as const },
      { content: 'b', status: 'completed' as const },
    ]

    expect(formatTaskListProgress(todos, { live: false })).toBe('2 done')
  })

  it('falls back to nothing for input it cannot read', () => {
    expect(formatTaskListSummary(undefined)).toBe('')
    expect(formatTaskListSummary('not a list')).toBe('')
    expect(formatTaskListSummary([])).toBe('')
  })
})
