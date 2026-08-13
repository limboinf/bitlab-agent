import { describe, expect, it } from 'bun:test'
import { handleThinkingDelta, handleThinkingComplete } from '../thinking'
import { handleTextDelta } from '../text'
import type { SessionState, ThinkingDeltaEvent, ThinkingCompleteEvent } from '../../types'

function makeState(messages: any[] = []): SessionState {
  return {
    session: {
      id: 'session-1',
      messages,
      lastMessageAt: Date.now(),
    } as any,
    streaming: null,
  }
}

const delta = (d: string, turnId = 'pi-turn-1__t0'): ThinkingDeltaEvent => ({
  type: 'thinking_delta',
  sessionId: 'session-1',
  delta: d,
  turnId,
})

describe('thinking handlers', () => {
  it('accumulates deltas into one streaming reasoning message', () => {
    let state = makeState()
    state = handleThinkingDelta(state, delta('Let me '))
    state = handleThinkingDelta(state, delta('reason.'))

    const messages = state.session.messages as any[]
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Let me reason.')
    expect(messages[0].isThinking).toBe(true)
    expect(messages[0].isIntermediate).toBe(true)
    expect(messages[0].isStreaming).toBe(true)
  })

  it('finalizes the streamed message and adopts the authoritative id', () => {
    let state = makeState()
    state = handleThinkingDelta(state, delta('Let me reason.'))

    const event: ThinkingCompleteEvent = {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'Let me reason.',
      turnId: 'pi-turn-1__t0',
      messageId: 'msg-main-1',
      timestamp: 500,
    }
    const messages = handleThinkingComplete(state, event).session.messages as any[]

    expect(messages).toHaveLength(1)
    expect(messages[0].id).toBe('msg-main-1')
    expect(messages[0].isStreaming).toBe(false)
    expect(messages[0].timestamp).toBe(500)
  })

  it('creates the message when reasoning never streamed', () => {
    const event: ThinkingCompleteEvent = {
      type: 'thinking_complete',
      sessionId: 'session-1',
      text: 'Reasoned quietly',
      turnId: 'pi-turn-1__t0',
      messageId: 'msg-main-1',
      timestamp: 500,
    }
    const messages = handleThinkingComplete(makeState(), event).session.messages as any[]

    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('Reasoned quietly')
    expect(messages[0].isThinking).toBe(true)
    expect(messages[0].isStreaming).toBe(false)
  })

  it('keeps reasoning and answer text in separate messages while both stream', () => {
    // Providers interleave the two channels; a loose lookup would splice the
    // answer into the reasoning message (or vice versa).
    let state = makeState()
    state = handleThinkingDelta(state, delta('Reasoning'))
    state = handleTextDelta(state, {
      type: 'text_delta',
      sessionId: 'session-1',
      delta: 'Answer',
      turnId: 'pi-turn-1__m0',
    })
    state = handleThinkingDelta(state, delta(' more'))

    const messages = state.session.messages as any[]
    expect(messages).toHaveLength(2)
    expect(messages[0].content).toBe('Reasoning more')
    expect(messages[0].isThinking).toBe(true)
    expect(messages[1].content).toBe('Answer')
    expect(messages[1].isThinking).toBeUndefined()
  })
})
