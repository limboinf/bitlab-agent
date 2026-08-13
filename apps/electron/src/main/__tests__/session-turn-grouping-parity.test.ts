/**
 * Tests for turn grouping stability across persist → reload.
 *
 * Verifies that messages run through the persistence pipeline
 * (centralized messageToStored → filter intermediate → centralized storedToMessage)
 * produce the same turn structure when grouped.
 *
 * Imports groupMessagesByTurn (pure function) from turn-utils.
 */
import { describe, it, expect, beforeEach } from 'bun:test'
import { groupMessagesByTurn, type AssistantTurn } from '@bitlab/ui/chat/turn-utils'
import { messageToStored, storedToMessage } from '@bitlab/core'
import type { Message, MessageRole } from '@bitlab/core'

// ============================================================================
// Mirror: persistence pipeline (two-stage filter)
// ============================================================================

function simulatePersistAndReload(messages: Message[]): Message[] {
  // Match SessionPersistenceQueue: status is dropped before store; tools and
  // intermediate commentary stay so TurnCard can rebuild the activity list.
  const afterStatusFilter = messages.filter(m => m.role !== 'status')
  return afterStatusFilter.map(messageToStored).map(storedToMessage)
}

// ============================================================================
// Test Helpers
// ============================================================================

let idCounter = 0
function resetCounters() { idCounter = 0 }

function createMessage(role: MessageRole, overrides: Partial<Message> = {}): Message {
  const id = `msg-${++idCounter}`
  return {
    id,
    role,
    content: overrides.content ?? `Content ${id}`,
    timestamp: Date.now() + idCounter * 100,
    ...overrides,
  }
}

function getAssistantTurns(turns: ReturnType<typeof groupMessagesByTurn>): AssistantTurn[] {
  return turns.filter(t => t.type === 'assistant') as AssistantTurn[]
}

// ============================================================================
// Tests
// ============================================================================

describe('turn grouping stability across reload', () => {
  beforeEach(resetCounters)

  it('simple conversation: user + assistant', () => {
    const turnId = 'turn-1'
    const messages: Message[] = [
      createMessage('user', { content: 'Hello' }),
      createMessage('assistant', { content: 'Hi there!', turnId }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // Same number of turns
    expect(reloadGrouping).toHaveLength(liveGrouping.length)

    // Same turn types
    expect(reloadGrouping.map(t => t.type)).toEqual(liveGrouping.map(t => t.type))

    // Assistant response text preserved
    const liveAssistant = getAssistantTurns(liveGrouping)[0]
    const reloadAssistant = getAssistantTurns(reloadGrouping)[0]
    expect(reloadAssistant?.response?.text).toBe(liveAssistant?.response?.text)
  })

  it('persisted tools still render as activities after reload', () => {
    const turnId = 'turn-tools-survive'
    const messages: Message[] = [
      createMessage('user', { content: '看下本地 skill' }),
      createMessage('assistant', {
        content: '我先列出目录', isIntermediate: true, turnId,
      }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-skills', toolStatus: 'completed',
        toolResult: 'smart-search', toolDisplayName: '列出全局技能目录',
        toolIntent: '查看 ~/.agents/skills', turnId,
      }),
      createMessage('assistant', {
        content: '全局目录里有 smart-search。', isIntermediate: false, turnId,
      }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const turns = groupMessagesByTurn(reloaded)
    const assistant = getAssistantTurns(turns)[0]

    expect(reloaded.some(message => message.role === 'tool')).toBe(true)
    expect(assistant?.activities.filter(activity => activity.type === 'tool')).toHaveLength(1)
    expect(assistant?.activities.some(activity => activity.type === 'intermediate')).toBe(true)
    expect(assistant?.response?.text).toBe('全局目录里有 smart-search。')
  })

  it('multi-tool turn: tools appear as activities, assistant as response', () => {
    const turnId = 'turn-2'
    const messages: Message[] = [
      createMessage('user', { content: 'Read two files' }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-1', toolStatus: 'completed',
        toolResult: 'File 1', turnId,
      }),
      createMessage('assistant', {
        content: 'Let me read the second file', isIntermediate: true, turnId,
      }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-2', toolStatus: 'completed',
        toolResult: 'File 2', turnId,
      }),
      createMessage('assistant', { content: 'Here are both files.', turnId }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // After reload, intermediate text is filtered out but turns should still work
    const liveAssistants = getAssistantTurns(liveGrouping)
    const reloadAssistants = getAssistantTurns(reloadGrouping)

    // Should have at least one assistant turn with the final response
    expect(reloadAssistants.length).toBeGreaterThan(0)

    // Final response text preserved
    const lastLive = liveAssistants[liveAssistants.length - 1]
    const lastReload = reloadAssistants[reloadAssistants.length - 1]
    expect(lastReload?.response?.text).toBe(lastLive?.response?.text)
  })

  it('background task turn: taskId, shellId, isBackground survive', () => {
    const turnId = 'turn-3'
    const messages: Message[] = [
      createMessage('user', { content: 'Run in background' }),
      createMessage('tool', {
        toolName: 'Task', toolUseId: 'tu-task-1', toolStatus: 'backgrounded',
        taskId: 'agent-123', isBackground: true, turnId,
      }),
      createMessage('assistant', { content: 'Task running in background.', turnId }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const bgTool = reloaded.find(m => m.role === 'tool')

    expect(bgTool?.taskId).toBe('agent-123')
    expect(bgTool?.isBackground).toBe(true)
    expect(bgTool?.toolStatus).toBe('backgrounded')
  })

  it('nested subagent tools: parentToolUseId survives and groups correctly', () => {
    const turnId = 'turn-4'
    const messages: Message[] = [
      createMessage('user', { content: 'Use subagent' }),
      createMessage('tool', {
        toolName: 'Task', toolUseId: 'tu-parent', toolStatus: 'completed',
        toolResult: 'Agent result', turnId,
      }),
      createMessage('tool', {
        toolName: 'Read', toolUseId: 'tu-child-1', toolStatus: 'completed',
        toolResult: 'File contents', parentToolUseId: 'tu-parent',
        isIntermediate: true, turnId,
      }),
      createMessage('assistant', { content: 'Done with subagent.', turnId }),
    ]

    const reloaded = simulatePersistAndReload(messages)

    // Parent tool survives
    const parentTool = reloaded.find(m => m.toolUseId === 'tu-parent')
    expect(parentTool).toBeDefined()
    expect(parentTool?.parentToolUseId).toBeUndefined()

    // Child tool is persisted (even if marked intermediate) so the tree can rebuild
    const childTool = reloaded.find(m => m.toolUseId === 'tu-child-1')
    expect(childTool).toBeDefined()
    expect(childTool?.parentToolUseId).toBe('tu-parent')

    // Grouping still produces valid turns
    const reloadGrouping = groupMessagesByTurn(reloaded)
    const assistantTurns = getAssistantTurns(reloadGrouping)
    expect(assistantTurns.length).toBeGreaterThan(0)
  })

  it('intermediate text survives reload and stays on the same turn', () => {
    const turnId = 'turn-5'
    const messages: Message[] = [
      createMessage('user', { content: 'Do something' }),
      createMessage('assistant', {
        content: 'Let me think...', isIntermediate: true, turnId,
      }),
      createMessage('tool', {
        toolName: 'Grep', toolUseId: 'tu-grep', toolStatus: 'completed',
        toolResult: 'Found matches', turnId,
      }),
      createMessage('assistant', {
        content: 'Here are the results.', isIntermediate: false, turnId,
      }),
    ]

    const liveGrouping = groupMessagesByTurn(messages)
    const reloaded = simulatePersistAndReload(messages)
    const reloadGrouping = groupMessagesByTurn(reloaded)

    // Intermediate commentary stays so the activity list can show the reasoning step
    expect(reloaded.find(m => m.isIntermediate)?.content).toBe('Let me think...')

    const reloadAssistants = getAssistantTurns(reloadGrouping)
    expect(reloadAssistants.length).toBeGreaterThan(0)
    expect(reloadAssistants[0]?.activities.some(activity => activity.type === 'intermediate')).toBe(true)

    const lastReload = reloadAssistants[reloadAssistants.length - 1]
    expect(lastReload?.response?.text).toBe('Here are the results.')
  })

  it('plan message turn: planPath survives reload', () => {
    const messages: Message[] = [
      createMessage('user', { content: 'Plan it' }),
      createMessage('plan', {
        content: '# Implementation Plan\n\n1. Do thing',
        planPath: '/sessions/123/plans/plan.md',
      }),
      createMessage('user', { content: 'Looks good, execute' }),
      createMessage('assistant', { content: 'Done.', turnId: 'turn-6' }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const planMsg = reloaded.find(m => m.role === 'plan')

    expect(planMsg).toBeDefined()
    expect(planMsg?.planPath).toBe('/sessions/123/plans/plan.md')
  })

  it('error turn: typed error fields survive reload', () => {
    const messages: Message[] = [
      createMessage('user', { content: 'Do something' }),
      createMessage('error', {
        content: 'Connection Failed: Could not connect',
        errorCode: 'network_error',
        errorTitle: 'Connection Failed',
        errorDetails: ['DNS lookup failed'],
        errorOriginal: 'ENOTFOUND',
        errorCanRetry: true,
      }),
    ]

    const reloaded = simulatePersistAndReload(messages)
    const errorMsg = reloaded.find(m => m.role === 'error')

    expect(errorMsg).toBeDefined()
    expect(errorMsg?.errorCode).toBe('network_error')
    expect(errorMsg?.errorTitle).toBe('Connection Failed')
    expect(errorMsg?.errorDetails).toEqual(['DNS lookup failed'])
    expect(errorMsg?.errorOriginal).toBe('ENOTFOUND')
    expect(errorMsg?.errorCanRetry).toBe(true)
  })
})
