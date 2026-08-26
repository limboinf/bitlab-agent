/**
 * Envelopes for messages one session sends to another.
 *
 * Two sessions talk through `sendMessage`, so an agent-to-agent message arrives
 * as an ordinary user message. Two things follow from that:
 *
 * 1. The model needs to be TOLD who is talking to it and how to answer —
 *    `parentSessionId` routes nothing, and a spawned session that is not handed
 *    its supervisor's id can only leave results on disk and hope. The envelope
 *    borrows pi-intercom's `replyHint`: hand the recipient the exact call it
 *    needs to reply with, so replying costs no guesswork.
 * 2. The reader must not be shown that plumbing as if the user had typed it.
 *    Each envelope therefore comes with an `agent` content badge covering the
 *    header, which collapses it in the transcript into a "from <session>" chip.
 *    The model still receives the full text — the badge is display metadata.
 */

import type { ContentBadge } from '@bitlab/core/types'

export interface AgentEnvelopeSender {
  /** Session doing the talking — this is the reply address. */
  sessionId: string
  /** Display name of that session, when it has one. */
  name?: string
}

export interface AgentEnvelope {
  /** Full text the recipient model receives, header included. */
  content: string
  /** Covers the header so the transcript shows a chip instead of plumbing. */
  badge: ContentBadge
}

/** `"sess-1" (Monitor)`, or just `"sess-1"` when the name adds nothing. */
function senderLabel(sender: AgentEnvelopeSender): string {
  return sender.name && sender.name !== sender.sessionId
    ? `"${sender.sessionId}" (${sender.name})`
    : `"${sender.sessionId}"`
}

function wrap(sender: AgentEnvelopeSender, header: string[], body: string): AgentEnvelope {
  const content = [...header, '', '---', '', body].join('\n')
  return {
    content,
    badge: {
      type: 'agent',
      label: sender.name?.trim() || sender.sessionId,
      rawText: sender.sessionId,
      start: 0,
      // Everything up to the body, so the body itself stays visible.
      end: content.length - body.length,
    },
  }
}

/** A message sent to a live session via `send_agent_message`. */
export function buildInboundAgentMessage(sender: AgentEnvelopeSender, message: string): AgentEnvelope {
  return wrap(sender, [
    `[Message from session ${senderLabel(sender)}]`,
    `Reply with send_agent_message using sessionId "${sender.sessionId}".`,
  ], message)
}

/**
 * The opening prompt of a session created by `spawn_session`.
 *
 * `canReply` is false when the spawned session runs in safe mode, where
 * `send_agent_message` is blocked — promising a reply channel it cannot use
 * would send it chasing a tool that is not there.
 */
export function buildSpawnedSessionPrompt(
  supervisor: AgentEnvelopeSender,
  prompt: string,
  options: { canReply: boolean },
): AgentEnvelope {
  const header = options.canReply
    ? [
        'Report back when you finish — and as soon as you are blocked and need a decision:',
        `  send_agent_message with sessionId "${supervisor.sessionId}" and your result or question as the message.`,
        'Nothing else notifies your supervisor; without that call it can only poll the filesystem for your output.',
      ]
    : [
        'This session runs in safe mode, so send_agent_message is unavailable.',
        'Write your result to a file in the working directory instead — that file is the only way your supervisor sees it.',
      ]

  return wrap(supervisor, [`[Spawned by session ${senderLabel(supervisor)}]`, ...header], prompt)
}
