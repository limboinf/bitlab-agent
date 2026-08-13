import type { AgentEvent, Message } from '@bitlab/core/types'
import { findToolStartTargetIndex, findOpenToolMessageIndex } from '@bitlab/core/utils'

type TranscriptEvent = Extract<AgentEvent, { type: 'text_complete' | 'thinking_complete' | 'tool_start' | 'tool_result' }>

export interface TranscriptIds {
  id: string
  timestamp: number
}

function isToolError(result: string | undefined, isError?: boolean): boolean {
  return isError === true || /^\s*(\[ERROR\]|Error:|error:)/.test(result || '')
}

/**
 * Apply a live agent event onto the persisted transcript.
 *
 * SessionManager used to emit tool_start / tool_result to the renderer only.
 * After restart or renderer remount the UI reloads from managed.messages, so
 * those tools vanished. Keep the same shape the renderer already understands.
 */
export function applyTranscriptEvent(
  messages: Message[],
  event: TranscriptEvent,
  ids: TranscriptIds,
): Message[] {
  switch (event.type) {
    case 'tool_start': {
      const index = findToolStartTargetIndex(messages, event.toolUseId)
      if (index !== -1) {
        const current = messages[index]
        if (!current) return messages
        const next = messages.slice()
        next[index] = {
          ...current,
          toolInput: event.input,
          toolIntent: event.intent,
          toolDisplayName: event.displayName,
          toolDisplayMeta: event.toolDisplayMeta,
          turnId: event.turnId ?? current.turnId,
          parentToolUseId: event.parentToolUseId ?? current.parentToolUseId,
        }
        return next
      }

      return [
        ...messages,
        {
          id: ids.id,
          role: 'tool',
          content: '',
          timestamp: ids.timestamp,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          toolInput: event.input,
          toolStatus: 'executing',
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
          toolIntent: event.intent,
          toolDisplayName: event.displayName,
          toolDisplayMeta: event.toolDisplayMeta,
        },
      ]
    }

    case 'tool_result': {
      const index = findOpenToolMessageIndex(messages, event.toolUseId)
      const inferredError = isToolError(event.result, event.isError)

      if (index !== -1) {
        const current = messages[index]
        if (!current) return messages
        const isBackgrounded = current.toolStatus === 'backgrounded' || current.isBackground
        const next = messages.slice()
        next[index] = {
          ...current,
          toolResult: event.result,
          toolStatus: isBackgrounded ? 'backgrounded' : (inferredError ? 'error' : 'completed'),
          isError: inferredError,
        }
        return next
      }

      return [
        ...messages,
        {
          id: ids.id,
          role: 'tool',
          content: '',
          timestamp: ids.timestamp,
          toolUseId: event.toolUseId,
          toolName: event.toolName ?? 'tool',
          toolResult: event.result,
          toolStatus: inferredError ? 'error' : 'completed',
          isError: inferredError,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        },
      ]
    }

    case 'text_complete':
      return [
        ...messages,
        {
          id: ids.id,
          role: 'assistant',
          content: event.text,
          timestamp: ids.timestamp,
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        },
      ]

    case 'thinking_complete':
      return [
        ...messages,
        {
          id: ids.id,
          role: 'assistant',
          content: event.text,
          timestamp: ids.timestamp,
          // Reasoning is never a final answer — isIntermediate keeps it out of
          // unread badges, previews and search, isThinking drives the rendering.
          isIntermediate: true,
          isThinking: true,
          turnId: event.turnId,
        },
      ]
  }
}
