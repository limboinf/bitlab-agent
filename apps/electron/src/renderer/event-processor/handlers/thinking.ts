/**
 * Thinking Event Handlers
 *
 * Handles thinking_delta and thinking_complete events — the model's reasoning
 * stream, rendered as its own step in the turn card.
 *
 * Lookup is strictly by turnId. Unlike text, there is no "last streaming
 * assistant" fallback: reasoning and answer text stream concurrently on some
 * providers, and a loose fallback would splice one into the other.
 */

import type { SessionState, ThinkingDeltaEvent, ThinkingCompleteEvent } from '../types'
import type { Message } from '../../../shared/types'
import { updateMessageAt, appendMessage, generateMessageId } from '../helpers'

/** Find a thinking message by turnId, streaming or not. */
function findThinkingMessage(messages: Message[], turnId?: string): number {
  if (!turnId) return -1
  return messages.findIndex(m => m.isThinking && m.turnId === turnId)
}

/**
 * Handle thinking_delta - accumulate streaming reasoning
 */
export function handleThinkingDelta(
  state: SessionState,
  event: ThinkingDeltaEvent
): SessionState {
  const { session } = state
  const index = findThinkingMessage(session.messages, event.turnId)

  if (index !== -1) {
    const current = session.messages[index]
    return {
      ...state,
      session: updateMessageAt(session, index, { content: current.content + event.delta }),
    }
  }

  const newMessage: Message = {
    id: generateMessageId(),
    role: 'assistant',
    content: event.delta,
    timestamp: Date.now(),
    isStreaming: true,
    isIntermediate: true,
    isThinking: true,
    turnId: event.turnId,
  }

  return { ...state, session: appendMessage(session, newMessage, false) }
}

/**
 * Handle thinking_complete - finalize the reasoning block
 *
 * Creates the message when no delta arrived first (endpoints that deliver
 * reasoning only on the finished message).
 */
export function handleThinkingComplete(
  state: SessionState,
  event: ThinkingCompleteEvent
): SessionState {
  const { session } = state
  const index = findThinkingMessage(session.messages, event.turnId)

  if (index !== -1) {
    const current = session.messages[index]
    return {
      ...state,
      session: updateMessageAt(session, index, {
        ...(event.messageId ? { id: event.messageId } : {}),
        // Streamed deltas are the fuller record when the SDK reports no text
        content: event.text || current.content,
        isStreaming: false,
        ...(event.timestamp ? { timestamp: event.timestamp } : {}),
      }),
    }
  }

  const newMessage: Message = {
    id: event.messageId ?? generateMessageId(),
    role: 'assistant',
    content: event.text,
    timestamp: event.timestamp ?? Date.now(),
    isStreaming: false,
    isIntermediate: true,
    isThinking: true,
    turnId: event.turnId,
  }

  return { ...state, session: appendMessage(session, newMessage, false) }
}
