import { describe, expect, it } from 'bun:test'
import type { ContentBadge } from '@bitlab/core'
import { splitUserMessageBadges } from '../user-message-badges'

// The agent envelope is written by the backend (server-core/sessions/agent-envelope.ts)
// and the model needs every word of it. The reader does not: if the split ever stops
// cutting the badged range, inter-session plumbing shows up in the transcript as if
// the user had typed it.

const envelope = '[Message from session "sender-1" (Monitor)]\nReply with send_agent_message using sessionId "sender-1".\n\n---\n\n'
const body = 'Found 3 papers on multi-turn tool use.'

function agentBadge(end: number): ContentBadge {
  return { type: 'agent', label: 'Monitor', rawText: 'sender-1', start: 0, end }
}

describe('splitUserMessageBadges', () => {
  it('passes content through untouched when there are no badges', () => {
    const result = splitUserMessageBadges(body)

    expect(result.displayContent).toBe(body)
    expect(result.detached).toEqual([])
    expect(result.inline).toEqual([])
    expect(result.isFromAgent).toBe(false)
  })

  it('collapses the agent envelope and keeps only the message', () => {
    const result = splitUserMessageBadges(envelope + body, [agentBadge(envelope.length)])

    expect(result.displayContent).toBe(body)
    expect(result.isFromAgent).toBe(true)
    expect(result.detached).toHaveLength(1)
    expect(result.inline).toEqual([])
  })

  it('keeps inline badges inline while detaching the envelope', () => {
    const skill: ContentBadge = {
      type: 'skill',
      label: 'Research',
      rawText: '@research',
      start: envelope.length,
      end: envelope.length + 9,
    }
    const result = splitUserMessageBadges(envelope + '@research this', [agentBadge(envelope.length), skill])

    expect(result.detached.map(b => b.type)).toEqual(['agent'])
    expect(result.inline.map(b => b.type)).toEqual(['skill'])
    expect(result.displayContent).toBe('@research this')
  })

  it('removes multiple detached ranges without shifting the earlier ones', () => {
    const content = 'HEAD-ONE middle HEAD-TWO tail'
    const first: ContentBadge = { type: 'agent', label: 'a', rawText: 'a', start: 0, end: 9 }
    const second: ContentBadge = {
      type: 'context',
      label: 'edit',
      rawText: '<edit_request>x</edit_request>',
      start: 16,
      end: 25,
    }
    // Given out of order on purpose — the split must not depend on badge order.
    const result = splitUserMessageBadges(content, [second, first])

    expect(result.displayContent).toBe('middle tail')
    expect(result.detached).toHaveLength(2)
  })

  it('does not mark ordinary edit requests as agent messages', () => {
    const editRequest: ContentBadge = {
      type: 'context',
      label: 'Edit',
      rawText: '<edit_request>tone</edit_request>',
      start: 0,
      end: 5,
    }
    const result = splitUserMessageBadges('HEAD tail', [editRequest])

    expect(result.isFromAgent).toBe(false)
    expect(result.displayContent).toBe('tail')
  })
})
