import { describe, expect, it } from 'bun:test'
import { messageToStored, storedToMessage } from '@bitlab/core/types'
import type { Message } from '@bitlab/core/types'
import { applyTranscriptEvent } from './persist-transcript.ts'

function persistAndReload(messages: Message[]): Message[] {
  return messages.map(messageToStored).map(storedToMessage)
}

describe('applyTranscriptEvent — tools survive reload', () => {
  it('keeps tool calls and intermediate text after persist → reload', () => {
    let messages: Message[] = []

    messages = applyTranscriptEvent(messages, {
      type: 'text_complete',
      text: '我先看看本地 skills',
      isIntermediate: true,
      turnId: 'turn-1',
    }, { id: 'asst-1', timestamp: 1 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'tu-read',
      input: { path: '~/.agents/skills' },
      intent: '查看 ~/.agents/skills 下有哪些技能',
      displayName: '列出全局技能目录',
      turnId: 'turn-1',
    }, { id: 'tool-1', timestamp: 2 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_result',
      toolUseId: 'tu-read',
      toolName: 'Read',
      result: 'smart-search\nresearch',
      isError: false,
      turnId: 'turn-1',
    }, { id: 'tool-1b', timestamp: 3 })

    messages = applyTranscriptEvent(messages, {
      type: 'text_complete',
      text: '全局目录里有 smart-search。',
      isIntermediate: false,
      turnId: 'turn-1',
    }, { id: 'asst-2', timestamp: 4 })

    const reloaded = persistAndReload(messages)
    const tool = reloaded.find(message => message.role === 'tool' && message.toolUseId === 'tu-read')
    expect(tool?.toolName).toBe('Read')
    expect(tool?.toolStatus).toBe('completed')
    expect(tool?.toolResult).toBe('smart-search\nresearch')
    expect(tool?.toolDisplayName).toBe('列出全局技能目录')
    expect(reloaded.find(message => message.id === 'asst-1')?.isIntermediate).toBe(true)
    expect(reloaded.find(message => message.id === 'asst-2')?.isIntermediate).toBe(false)
  })

  it('updates an existing tool_start instead of duplicating it', () => {
    let messages: Message[] = applyTranscriptEvent([], {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: {},
      turnId: 'turn-1',
    }, { id: 'tool-1', timestamp: 1 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'tu-1',
      input: { path: '/tmp/a.md' },
      displayName: '读取文件',
      turnId: 'turn-1',
    }, { id: 'tool-2', timestamp: 2 })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.toolInput).toEqual({ path: '/tmp/a.md' })
    expect(messages[0]?.toolDisplayName).toBe('读取文件')
  })

  // OpenAI-compatible endpoints often restart tool call numbering on every
  // assistant message, so round 2 reuses round 1's id. Each call must keep its
  // own message instead of overwriting the earlier one.
  it('keeps both calls when a provider reuses a tool call id', () => {
    let messages: Message[] = []

    messages = applyTranscriptEvent(messages, {
      type: 'tool_start',
      toolName: 'Read',
      toolUseId: 'call_1',
      input: { path: '/tmp/a.md' },
      turnId: 'turn-1',
    }, { id: 'tool-1', timestamp: 1 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_result',
      toolUseId: 'call_1',
      toolName: 'Read',
      result: 'A',
      isError: false,
      turnId: 'turn-1',
    }, { id: 'tool-1b', timestamp: 2 })

    messages = applyTranscriptEvent(messages, {
      type: 'text_complete',
      text: '读到了 A，接着看 B',
      isIntermediate: true,
      turnId: 'turn-1',
    }, { id: 'asst-1', timestamp: 3 })

    // Second round — same id, different call
    messages = applyTranscriptEvent(messages, {
      type: 'tool_start',
      toolName: 'Edit',
      toolUseId: 'call_1',
      input: { path: '/tmp/b.md' },
      turnId: 'turn-2',
    }, { id: 'tool-2', timestamp: 4 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_result',
      toolUseId: 'call_1',
      toolName: 'Edit',
      result: 'B',
      isError: false,
      turnId: 'turn-2',
    }, { id: 'tool-2b', timestamp: 5 })

    const tools = messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.toolName).toBe('Read')
    expect(tools[0]?.toolResult).toBe('A')
    expect(tools[1]?.toolName).toBe('Edit')
    expect(tools[1]?.toolResult).toBe('B')
  })

  it('lets a late tool_start fill in a result-only stub', () => {
    let messages: Message[] = applyTranscriptEvent([], {
      type: 'tool_result',
      toolUseId: 'call_9',
      toolName: 'Grep',
      result: 'hit',
      isError: false,
      turnId: 'turn-1',
    }, { id: 'tool-1', timestamp: 1 })

    messages = applyTranscriptEvent(messages, {
      type: 'tool_start',
      toolName: 'Grep',
      toolUseId: 'call_9',
      input: { pattern: 'foo' },
      displayName: '搜索 foo',
      turnId: 'turn-1',
    }, { id: 'tool-2', timestamp: 2 })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.toolInput).toEqual({ pattern: 'foo' })
    expect(messages[0]?.toolDisplayName).toBe('搜索 foo')
    expect(messages[0]?.toolResult).toBe('hit')
  })
})
