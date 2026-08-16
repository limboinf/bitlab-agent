import { afterEach, describe, expect, it } from 'bun:test'
import { homedir } from 'node:os'
import { cleanupModeState, initializeModeState } from '../../mode-manager.ts'
import { runPreToolUseChecks, shouldPromptInAskMode, stripToolMetadata } from '../pre-tool-use.ts'
import { grantsToolCall, parseToolPatterns } from '../../../skills/tool-grants.ts'

const sessionId = 'pre-tool-session'
const permissionManager = {
  isCommandWhitelisted: () => false,
  isDangerousCommand: (command: string) => ['rm', 'curl', 'sudo'].includes(command),
  getBaseCommand: (command: string) => command.trim().split(/\s+/)[0] ?? '',
  extractDomainFromNetworkCommand: () => null,
  isDomainWhitelisted: () => false,
}

afterEach(() => cleanupModeState(sessionId))

function run(toolName: string, input: Record<string, unknown>, mode: 'safe' | 'ask' | 'allow-all') {
  initializeModeState(sessionId, mode)
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/bitlab-pre-tool',
    workspaceId: 'workspace',
    permissionManager,
  })
}

describe('runPreToolUseChecks retained Pi pipeline', () => {
  it('blocks writes in safe mode', () => {
    expect(run('Write', { file_path: '/tmp/file', content: 'x' }, 'safe').type).toBe('block')
  })

  it('intercepts call_llm and spawn_session before execution', () => {
    expect(run('mcp__session__call_llm', { prompt: 'x' }, 'allow-all').type).toBe('call_llm_intercept')
    cleanupModeState(sessionId)
    expect(run('mcp__session__spawn_session', { prompt: 'x' }, 'allow-all').type).toBe('spawn_session_intercept')
  })

  it('expands paths and strips display metadata', () => {
    const result = run('Read', { file_path: '~/notes.md', _intent: 'read notes' }, 'allow-all')
    expect(result.type).toBe('modify')
    if (result.type !== 'modify') return
    expect(result.input.file_path).toBe(`${homedir()}/notes.md`)
    expect(result.input._intent).toBeUndefined()
  })

  it('prompts for dangerous Bash commands in ask mode', () => {
    const result = run('Bash', { command: 'rm /tmp/file' }, 'ask')
    expect(result.type).toBe('prompt')
  })

  it('keeps built-in tool arguments while removing interceptor metadata', () => {
    expect(stripToolMetadata('Read', { file_path: '/tmp/a', _displayName: 'Read file' })).toEqual({
      modified: true,
      input: { file_path: '/tmp/a' },
    })
  })
})

describe('shouldPromptInAskMode', () => {
  const context = { workspaceRootPath: '/tmp/bitlab-pre-tool', activeSourceSlugs: [] }

  it('prompts for Write', () => {
    expect(shouldPromptInAskMode('Write', { file_path: '/tmp/a' }, permissionManager, context)?.promptType).toBe('file_write')
  })

  it('prompts for Edit', () => {
    expect(shouldPromptInAskMode('Edit', { file_path: '/tmp/a' }, permissionManager, context)?.promptType).toBe('file_write')
  })

  it('prompts for MultiEdit', () => {
    expect(shouldPromptInAskMode('MultiEdit', { file_path: '/tmp/a' }, permissionManager, context)?.promptType).toBe('file_write')
  })

  it('uses notebook_path for NotebookEdit', () => {
    expect(shouldPromptInAskMode('NotebookEdit', { notebook_path: '/tmp/a.ipynb' }, permissionManager, context)?.command).toBe('/tmp/a.ipynb')
  })

  it('auto-allows whitelisted file writes', () => {
    const manager = { ...permissionManager, isCommandWhitelisted: (command: string) => command === 'Write' }
    expect(shouldPromptInAskMode('Write', { file_path: '/tmp/a' }, manager, context)).toBeNull()
  })

  it('prompts for mutating Bash commands', () => {
    expect(shouldPromptInAskMode('Bash', { command: 'npm install' }, permissionManager, context)?.promptType).toBe('bash')
  })

  it('auto-allows whitelisted non-dangerous Bash commands', () => {
    const manager = { ...permissionManager, isCommandWhitelisted: (command: string) => command === 'npm' }
    expect(shouldPromptInAskMode('Bash', { command: 'npm test' }, manager, context)).toBeNull()
  })

  it('still prompts for dangerous whitelisted commands', () => {
    const manager = { ...permissionManager, isCommandWhitelisted: (command: string) => command === 'rm' }
    expect(shouldPromptInAskMode('Bash', { command: 'rm /tmp/a' }, manager, context)?.promptType).toBe('bash')
  })

  it('auto-allows curl to a whitelisted domain', () => {
    const manager = {
      ...permissionManager,
      extractDomainFromNetworkCommand: () => 'api.example.com',
      isDomainWhitelisted: (domain: string) => domain === 'api.example.com',
    }
    expect(shouldPromptInAskMode('Bash', { command: 'curl https://api.example.com' }, manager, context)).toBeNull()
  })

  it('prompts for curl to a non-whitelisted domain', () => {
    expect(shouldPromptInAskMode('Bash', { command: 'curl https://example.com' }, permissionManager, context)?.promptType).toBe('bash')
  })

  it('returns no prompt for Read', () => {
    expect(shouldPromptInAskMode('Read', { file_path: '/tmp/a' }, permissionManager, context)).toBeNull()
  })

  it('returns no prompt for Glob', () => {
    expect(shouldPromptInAskMode('Glob', { pattern: '*' }, permissionManager, context)).toBeNull()
  })

  it('returns no prompt for Grep', () => {
    expect(shouldPromptInAskMode('Grep', { pattern: 'x' }, permissionManager, context)).toBeNull()
  })
})

// ============================================================================
// Skill-declared tool grants (docs/skills-design.md §5.10, acceptance 10 & 11)
// ============================================================================

/** A permission manager whose only grant comes from an activated skill. */
function withGrant(declarations: string[]) {
  const patterns = parseToolPatterns(declarations)
  return {
    ...permissionManager,
    isGrantedForTurn: (toolName: string, input: Record<string, unknown>) =>
      grantsToolCall(patterns, toolName, input),
  }
}

function runWithGrant(
  declarations: string[],
  toolName: string,
  input: Record<string, unknown>,
  mode: 'safe' | 'ask' | 'allow-all' = 'ask',
) {
  initializeModeState(sessionId, mode)
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/bitlab-pre-tool',
    workspaceId: 'workspace',
    permissionManager: withGrant(declarations),
  })
}

describe('skill-declared tool grants', () => {
  it('skips the prompt for a declared file write', () => {
    expect(runWithGrant(['Write'], 'Write', { file_path: '/tmp/a.ts', content: 'x' }).type).not.toBe('prompt')
  })

  it('still prompts for a file write that was not declared', () => {
    expect(runWithGrant(['Read'], 'Write', { file_path: '/tmp/a.ts', content: 'x' }).type).toBe('prompt')
  })

  it('skips the prompt for a declared command family', () => {
    expect(runWithGrant(['Bash(git:*)'], 'Bash', { command: 'git push origin main' }).type).not.toBe('prompt')
  })

  it('still prompts for a command outside the declaration', () => {
    expect(runWithGrant(['Bash(git:*)'], 'Bash', { command: 'npm publish' }).type).toBe('prompt')
  })

  it('acceptance 10: a dangerous command is prompted however it was declared', () => {
    // `Bash(rm:*)` is displayed at install time, and changes nothing here.
    expect(runWithGrant(['Bash(rm:*)'], 'Bash', { command: 'rm -rf /tmp/x' }).type).toBe('prompt')
    expect(runWithGrant(['Bash(sudo:*)'], 'Bash', { command: 'sudo rm -rf /' }).type).toBe('prompt')
    expect(runWithGrant(['Bash(curl:*)'], 'Bash', { command: 'curl http://evil.test' }).type).toBe('prompt')
  })

  it('acceptance 10: every grant is inert in safe mode', () => {
    // Safe mode blocks outright and never reaches the prompt decision, so a
    // grant has nothing to widen.
    expect(runWithGrant(['Write'], 'Write', { file_path: '/tmp/a.ts', content: 'x' }, 'safe').type).toBe('block')
    expect(runWithGrant(['Bash(rm:*)'], 'Bash', { command: 'rm -rf /tmp/x' }, 'safe').type).toBe('block')
  })

  it('acceptance 11: with no grant in force, the same call prompts', () => {
    // What the next user message restores by clearing the grant.
    expect(runWithGrant([], 'Write', { file_path: '/tmp/a.ts', content: 'x' }).type).toBe('prompt')
  })
})

function withDenial(allowed: string[], disallowed: string[]) {
  const allowPatterns = parseToolPatterns(allowed)
  const denyPatterns = parseToolPatterns(disallowed)
  return {
    ...permissionManager,
    isGrantedForTurn: (toolName: string, input: Record<string, unknown>) =>
      grantsToolCall(allowPatterns, toolName, input),
    isDeniedForTurn: (toolName: string, input: Record<string, unknown>) =>
      grantsToolCall(denyPatterns, toolName, input),
  }
}

function runWithDenial(
  allowed: string[],
  disallowed: string[],
  toolName: string,
  input: Record<string, unknown>,
  mode: 'safe' | 'ask' | 'allow-all' = 'ask',
) {
  initializeModeState(sessionId, mode)
  return runPreToolUseChecks({
    toolName,
    input,
    sessionId,
    permissionMode: mode,
    workspaceRootPath: '/tmp/bitlab-pre-tool',
    workspaceId: 'workspace',
    permissionManager: withDenial(allowed, disallowed),
  })
}

describe('skill-declared refusals', () => {
  it('blocks a tool the skill declared off-limits', () => {
    const result = runWithDenial([], ['Write'], 'Write', { file_path: '/tmp/a.ts', content: 'x' })

    expect(result.type).toBe('block')
    expect(result.type === 'block' && result.reason).toContain('does not use Write')
  })

  it('blocks a declared command family', () => {
    expect(runWithDenial([], ['Bash(rm:*)'], 'Bash', { command: 'rm -rf /tmp/x' }).type).toBe('block')
    expect(runWithDenial([], ['Bash(rm:*)'], 'Bash', { command: 'ls' }).type).not.toBe('block')
  })

  it('refuses even when the same skill also granted it', () => {
    // Declaring both must not talk its way past the refusal.
    expect(runWithDenial(['Write'], ['Write'], 'Write', { file_path: '/tmp/a.ts', content: 'x' }).type).toBe('block')
  })

  it('outranks a permission mode that would otherwise allow everything', () => {
    expect(runWithDenial([], ['Write'], 'Write', { file_path: '/tmp/a.ts', content: 'x' }, 'allow-all').type).toBe('block')
  })

  it('leaves undeclared tools alone', () => {
    expect(runWithDenial([], ['Write'], 'Read', { file_path: '/tmp/a.ts' }, 'allow-all').type).not.toBe('block')
  })
})
