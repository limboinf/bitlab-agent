import { describe, expect, it } from 'bun:test'
import { handleTextComplete } from '../text'
import type { SessionState, TextCompleteEvent } from '../../types'

/**
 * Pi reuses one sub-turn id for several assistant messages of the same user
 * turn, so a final text_complete can land on the turnId of the commentary that
 * preceded a tool call. The completed intermediate must keep its own message —
 * otherwise the reasoning/commentary row vanishes from the turn card the moment
 * the final answer arrives.
 */
function makeState(messages: any[]): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

const completedIntermediate = {
  id: 'msg-intermediate-1',
  role: 'assistant',
  content: 'Let me search first',
  isStreaming: false,
  isPending: false,
  isIntermediate: true,
  turnId: 'pi-turn-1__m0',
  timestamp: 100,
}

describe('handleTextComplete keeps completed intermediate messages', () => {
  it('appends the final text instead of overwriting the intermediate with the same turnId', () => {
    const state = makeState([completedIntermediate])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'Here is the answer',
      isIntermediate: false,
      turnId: 'pi-turn-1__m0',
      messageId: 'msg-final-1',
      timestamp: 300,
    }

    const messages = handleTextComplete(state, event).session.messages as any[]

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('Let me search first')
    expect(messages[0].isIntermediate).toBe(true)
    expect(messages[1].id).toBe('msg-final-1')
    expect(messages[1].content).toBe('Here is the answer')
    expect(messages[1].isIntermediate).toBe(false)
  })

  it('still finalizes the streaming message that carries the same turnId', () => {
    const state = makeState([
      completedIntermediate,
      {
        id: 'msg-local-temp-1',
        role: 'assistant',
        content: 'Here is',
        isStreaming: true,
        isPending: true,
        turnId: 'pi-turn-1__m0',
        timestamp: 200,
      },
    ])

    const event: TextCompleteEvent = {
      type: 'text_complete',
      sessionId: 'session-1',
      text: 'Here is the answer',
      isIntermediate: false,
      turnId: 'pi-turn-1__m0',
      messageId: 'msg-final-1',
      timestamp: 300,
    }

    const messages = handleTextComplete(state, event).session.messages as any[]

    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('Let me search first')
    expect(messages[1].id).toBe('msg-final-1')
    expect(messages[1].isStreaming).toBe(false)
  })
})
