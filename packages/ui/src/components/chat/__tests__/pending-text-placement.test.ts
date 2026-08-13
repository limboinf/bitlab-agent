/**
 * Where assistant text goes while its verdict is still pending.
 *
 * Text arriving via text_delta is flagged isPending because nobody yet knows
 * whether it is the answer or a remark between tool calls. It streams in the
 * chat column either way — the answer is what it usually turns out to be, and
 * the answer is worth reading as it is written, in the spot it will keep.
 *
 * The verdict only moves it in the losing case: text_complete calling it
 * commentary contracts the paragraph into a step row in the list above.
 */

import { describe, it, expect } from 'bun:test'
import { groupMessagesByTurn, deriveTurnPhase, type AssistantTurn } from '../turn-utils'
import type { Message } from '@bitlab/core'

function userMessage(): Message {
  return { id: 'u1', role: 'user', content: 'question', timestamp: 1000 }
}

function assistantTurn(messages: Message[]): AssistantTurn {
  const turn = groupMessagesByTurn(messages).find(t => t.type === 'assistant')
  expect(turn).toBeDefined()
  return turn as AssistantTurn
}

function pendingText(content: string, turnId = 'pi-turn-1__m0'): Message {
  return {
    id: 'a1',
    role: 'assistant',
    content,
    timestamp: 1100,
    isStreaming: true,
    isPending: true,
    turnId,
  }
}

function completedTool(): Message {
  return {
    id: 't1',
    role: 'tool',
    content: '',
    timestamp: 1050,
    toolName: 'Read',
    toolUseId: 'tu1',
    toolResult: 'file contents',
    toolStatus: 'completed',
    turnId: 'pi-turn-1__m0',
  }
}

describe('a turn with no steps yet', () => {
  it('streams the text as the response, not as an activity', () => {
    const turn = assistantTurn([userMessage(), pendingText('闭包是指一个函数能够')])

    expect(turn.response?.text).toBe('闭包是指一个函数能够')
    expect(turn.response?.isStreaming).toBe(true)
    expect(turn.activities).toHaveLength(0)
    expect(deriveTurnPhase(turn)).toBe('streaming')
  })

  it('grows the response across successive deltas', () => {
    const lengths = ['闭包', '闭包是指', '闭包是指一个函数'].map(
      content => assistantTurn([userMessage(), pendingText(content)]).response?.text.length
    )

    expect(lengths).toEqual([2, 4, 8])
  })

  it('keeps the text as the response when text_complete says it was final', () => {
    const final: Message = {
      id: 'a1',
      role: 'assistant',
      content: '闭包是指一个函数能够记住其定义环境。',
      timestamp: 1100,
      isStreaming: false,
      isPending: false,
      isIntermediate: false,
      turnId: 'pi-turn-1__m0',
    }

    const turn = assistantTurn([userMessage(), final])

    expect(turn.response?.text).toBe('闭包是指一个函数能够记住其定义环境。')
    expect(turn.response?.isStreaming).toBe(false)
    expect(turn.activities).toHaveLength(0)
  })
})

describe('a turn that has already produced steps', () => {
  it('streams the text in the chat column, below the step list', () => {
    const turn = assistantTurn([userMessage(), completedTool(), pendingText('这个文件里', 'pi-turn-1__m1')])

    expect(turn.response?.text).toBe('这个文件里')
    expect(turn.response?.isStreaming).toBe(true)
    expect(turn.activities).toHaveLength(1)
    expect(turn.activities[0].type).toBe('tool')
    expect(deriveTurnPhase(turn)).toBe('streaming')
  })

  it('streams in the chat column even behind an open reasoning block', () => {
    const reasoning: Message = {
      id: 'a0',
      role: 'assistant',
      content: 'Thinking about it',
      timestamp: 1050,
      isStreaming: true,
      isIntermediate: true,
      isThinking: true,
      turnId: 'pi-turn-1__t0',
    }

    const turn = assistantTurn([userMessage(), reasoning, pendingText('A closure is', 'pi-turn-1__m1')])

    expect(turn.response?.text).toBe('A closure is')
    expect(turn.activities).toHaveLength(1)
    expect(turn.activities[0].type).toBe('thinking')
  })

  it('contracts into a step when text_complete says it was commentary', () => {
    const commentary: Message = {
      id: 'a1',
      role: 'assistant',
      content: '我先看一下这个文件。',
      timestamp: 1100,
      isStreaming: false,
      isPending: false,
      isIntermediate: true,
      turnId: 'pi-turn-1__m1',
    }

    const turn = assistantTurn([userMessage(), completedTool(), commentary])

    // The one case the verdict moves text: out of the chat column, into a row
    expect(turn.response).toBeUndefined()
    expect(turn.activities).toHaveLength(2)
    expect(turn.activities[1].type).toBe('intermediate')
    expect(turn.activities[1].status).toBe('completed')
  })

  it('stays put when text_complete says it was final', () => {
    const final: Message = {
      id: 'a1',
      role: 'assistant',
      content: '这个文件里定义了棋盘逻辑。',
      timestamp: 1100,
      isStreaming: false,
      isPending: false,
      isIntermediate: false,
      turnId: 'pi-turn-1__m1',
    }

    const turn = assistantTurn([userMessage(), completedTool(), final])

    // Where it was already streaming — no movement
    expect(turn.response?.text).toBe('这个文件里定义了棋盘逻辑。')
    expect(turn.activities).toHaveLength(1)
    expect(deriveTurnPhase(turn)).toBe('complete')
  })

  it('streams reasoning as a thinking activity, never as the answer', () => {
    const reasoning: Message = {
      id: 'a1',
      role: 'assistant',
      content: 'The user is asking about closures',
      timestamp: 1100,
      isStreaming: true,
      isIntermediate: true,
      isThinking: true,
      turnId: 'pi-turn-1__t0',
    }

    const turn = assistantTurn([userMessage(), reasoning])

    expect(turn.response).toBeUndefined()
    expect(turn.activities).toHaveLength(1)
    expect(turn.activities[0].type).toBe('thinking')
    expect(turn.activities[0].status).toBe('running')
  })
})
