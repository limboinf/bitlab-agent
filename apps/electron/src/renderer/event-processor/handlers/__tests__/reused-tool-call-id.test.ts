import { describe, expect, it } from 'bun:test'
import { processEvent } from '../../processor'
import type { AgentEvent, SessionState } from '../../types'
import { groupMessagesByTurn, type AssistantTurn } from '@bitlab/ui/chat/turn-utils'

/**
 * OpenAI-compatible endpoints often restart tool call numbering on every
 * assistant message, so a multi-round turn reuses `call_1` for unrelated calls.
 * Matching by id alone made round 2 overwrite round 1 and the turn card kept
 * only the last round of tools.
 */
function run(events: AgentEvent[]): SessionState {
  let state: SessionState = {
    session: { id: 'reuse-session', messages: [], lastMessageAt: 1 } as never,
    streaming: null,
  }
  for (const event of events) state = processEvent(state, event).state
  return state
}

describe('providers that reuse tool call ids', () => {
  it('keeps every call when text and tools interleave across rounds', () => {
    const state = run([
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Read', toolUseId: 'call_1', toolInput: { path: 'a.md' }, timestamp: 10 },
      { type: 'tool_result', sessionId: 'reuse-session', toolName: 'Read', toolUseId: 'call_1', result: 'A', timestamp: 11 },
      { type: 'text_complete', sessionId: 'reuse-session', text: '读到 A，继续', isIntermediate: true, messageId: 'asst-1', timestamp: 12 },
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Edit', toolUseId: 'call_1', toolInput: { path: 'b.md' }, timestamp: 13 },
      { type: 'tool_result', sessionId: 'reuse-session', toolName: 'Edit', toolUseId: 'call_1', result: 'B', timestamp: 14 },
      { type: 'text_complete', sessionId: 'reuse-session', text: '改完了', isIntermediate: false, messageId: 'asst-2', timestamp: 15 },
      { type: 'complete', sessionId: 'reuse-session' },
    ])

    const tools = state.session.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.toolName).toBe('Read')
    expect(tools[0]?.toolResult).toBe('A')
    expect(tools[1]?.toolName).toBe('Edit')
    expect(tools[1]?.toolResult).toBe('B')

    // And both survive into the rendered turn card
    const turns = groupMessagesByTurn(state.session.messages, { isSessionProcessing: false })
    const assistant = turns.find(turn => turn.type === 'assistant') as AssistantTurn
    const toolActivities = assistant.activities.filter(activity => activity.type === 'tool')
    expect(toolActivities.map(activity => activity.toolName)).toEqual(['Read', 'Edit'])
  })

  it('still merges the two tool_start events the SDK sends per call', () => {
    const state = run([
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Read', toolUseId: 'call_1', toolInput: {}, timestamp: 10 },
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Read', toolUseId: 'call_1', toolInput: { path: 'a.md' }, toolDisplayName: '读取文件', timestamp: 10 },
    ])

    const tools = state.session.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.toolInput).toEqual({ path: 'a.md' })
    expect(tools[0]?.toolDisplayName).toBe('读取文件')
  })

  it('lets a late tool_start fill in a result-only stub', () => {
    const state = run([
      { type: 'tool_result', sessionId: 'reuse-session', toolName: 'Grep', toolUseId: 'call_9', result: 'hit', timestamp: 10 },
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Grep', toolUseId: 'call_9', toolInput: { pattern: 'foo' }, timestamp: 11 },
    ])

    const tools = state.session.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]?.toolInput).toEqual({ pattern: 'foo' })
    expect(tools[0]?.toolResult).toBe('hit')
  })

  it('routes background lifecycle updates to the most recent call', () => {
    const state = run([
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Bash', toolUseId: 'call_1', toolInput: { command: 'ls' }, timestamp: 10 },
      { type: 'tool_result', sessionId: 'reuse-session', toolName: 'Bash', toolUseId: 'call_1', result: 'done', timestamp: 11 },
      { type: 'tool_start', sessionId: 'reuse-session', toolName: 'Bash', toolUseId: 'call_1', toolInput: { command: 'sleep 60' }, timestamp: 12 },
      { type: 'tool_result', sessionId: 'reuse-session', toolName: 'Bash', toolUseId: 'call_1', result: 'started', timestamp: 13 },
      { type: 'shell_backgrounded', sessionId: 'reuse-session', toolUseId: 'call_1', shellId: 'shell-7', timestamp: 14 },
    ] as AgentEvent[])

    const tools = state.session.messages.filter(message => message.role === 'tool')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.toolStatus).toBe('completed')
    expect(tools[1]?.toolStatus).toBe('backgrounded')
    expect(tools[1]?.shellId).toBe('shell-7')
  })
})
