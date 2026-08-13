import { describe, expect, it, mock } from 'bun:test'

mock.module('../../config/preferences.ts', () => ({
  formatPreferencesForPrompt: () => '',
}))
mock.module('../../config/storage.ts', () => ({
  getBrowserToolEnabled: () => true,
}))

import { getMiniAgentSystemPrompt, getSystemPrompt } from '../system.ts'

describe('Bitlab system prompt', () => {
  it('uses the retained backend-neutral tool guidance', () => {
    const prompt = getSystemPrompt('', undefined, '/tmp/workspace', undefined, 'default', 'Pi')
    expect(prompt).toContain('Bitlab')
    expect(prompt).toContain('rg')
    expect(prompt).not.toContain('Sources')
    expect(prompt).not.toContain('Automations')
  })

  it('keeps the Craft mini-agent configuration workflow', () => {
    const prompt = getMiniAgentSystemPrompt('/tmp/workspace')
    expect(prompt).toContain('skills/{slug}/SKILL.md')
    expect(prompt).toContain('config_validate')
    expect(prompt).toContain('/tmp/workspace')
  })

  it('uses backend-neutral debug log querying guidance', () => {
    const prompt = getSystemPrompt(undefined, { enabled: true, logFilePath: '/tmp/main.log' }, '/tmp/workspace', '/tmp/workspace')
    expect(prompt).toContain('Use Bash with `rg`/`grep` to search logs efficiently:')
    expect(prompt).toContain('rg -n "session" "/tmp/main.log"')
    expect(prompt).not.toContain('Use the Grep tool (if available)')
  })

  it('does not claim call_llm has Grep', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace')
    expect(prompt).toContain('The subtask needs file/shell tools (for example, Read or Bash)')
    expect(prompt).not.toContain('The subtask needs tools (Read, Bash, Grep)')
  })
})

describe('git commit conventions', () => {
  it('does not instruct the agent to add a co-author trailer', () => {
    const prompt = getSystemPrompt(undefined, undefined, '/tmp/workspace', '/tmp/workspace')
    expect(prompt).not.toContain('## Git Conventions')
    expect(prompt).not.toContain('Co-Authored-By')
  })
})
