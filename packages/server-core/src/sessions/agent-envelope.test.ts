import { describe, expect, it } from 'bun:test'
import { buildInboundAgentMessage, buildSpawnedSessionPrompt } from './agent-envelope.ts'

// Two invariants hold for every envelope:
//  - the recipient model is told the sender's session id (nothing else routes a
//    reply back), and
//  - the badge covers exactly the header, so the transcript collapses the
//    plumbing without eating a character of the actual message.

describe('buildInboundAgentMessage', () => {
  it('names the sender and the reply call', () => {
    const { content } = buildInboundAgentMessage({ sessionId: 'sender-1', name: 'Monitor' }, 'ping')

    expect(content).toContain('[Message from session "sender-1" (Monitor)]')
    expect(content).toContain('send_agent_message using sessionId "sender-1"')
    expect(content.endsWith('---\n\nping')).toBe(true)
  })

  it('badges the header and nothing more', () => {
    const { content, badge } = buildInboundAgentMessage({ sessionId: 'sender-1', name: 'Monitor' }, 'ping')

    expect(badge.type).toBe('agent')
    expect(badge.label).toBe('Monitor')
    expect(badge.rawText).toBe('sender-1')
    expect(badge.start).toBe(0)
    expect(content.slice(badge.end)).toBe('ping')
  })

  it('falls back to the session id when the sender has no name', () => {
    const { badge } = buildInboundAgentMessage({ sessionId: 'sender-1' }, 'ping')

    expect(badge.label).toBe('sender-1')
  })
})

describe('buildSpawnedSessionPrompt', () => {
  const prompt = 'Research agent design philosophy in engineering blogs.'
  const supervisor = { sessionId: 'sess-parent', name: '多智能体协同' }

  it('hands the spawned session its supervisor address', () => {
    const { content, badge } = buildSpawnedSessionPrompt(supervisor, prompt, { canReply: true })

    expect(content).toContain('[Spawned by session "sess-parent" (多智能体协同)]')
    expect(content).toContain('send_agent_message with sessionId "sess-parent"')
    expect(content.slice(badge.end)).toBe(prompt)
  })

  it('omits the name when it is just the id again', () => {
    const { content } = buildSpawnedSessionPrompt(
      { sessionId: 'sess-parent', name: 'sess-parent' },
      prompt,
      { canReply: true },
    )

    expect(content).toContain('[Spawned by session "sess-parent"]')
    expect(content).not.toContain('(sess-parent)')
  })

  it('points at a file instead of a blocked tool in safe mode', () => {
    const { content, badge } = buildSpawnedSessionPrompt(supervisor, prompt, { canReply: false })

    expect(content).toContain('safe mode')
    expect(content).toContain('Write your result to a file')
    expect(content).not.toContain('send_agent_message with sessionId')
    expect(content.slice(badge.end)).toBe(prompt)
  })
})
