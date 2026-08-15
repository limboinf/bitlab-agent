/**
 * Tests for the workspace slug utilities
 *
 * extractWorkspaceSlug (packages/shared/src/utils/workspace.ts) derives the
 * workspace slug from the workspace data root; readPluginName reads the SDK
 * plugin name that backs it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractWorkspaceSlug, readPluginName } from '../../utils/workspace.ts'

// ============================================================================
// readPluginName — reads SDK plugin name from .claude-plugin/plugin.json
// ============================================================================

describe('readPluginName', () => {
  const testDir = join(tmpdir(), `plugin-name-test-${Date.now()}`)

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('reads plugin name from .claude-plugin/plugin.json', () => {
    const wsDir = join(testDir, 'ws-with-plugin')
    mkdirSync(join(wsDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(wsDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'craft-workspace-default', version: '1.0.0' }))
    expect(readPluginName(wsDir)).toBe('craft-workspace-default')
  })

  it('returns null when .claude-plugin/plugin.json does not exist', () => {
    const wsDir = join(testDir, 'ws-no-plugin')
    mkdirSync(wsDir, { recursive: true })
    expect(readPluginName(wsDir)).toBeNull()
  })

  it('returns null when plugin.json has no name field', () => {
    const wsDir = join(testDir, 'ws-no-name')
    mkdirSync(join(wsDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(wsDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }))
    expect(readPluginName(wsDir)).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    const wsDir = join(testDir, 'ws-bad-json')
    mkdirSync(join(wsDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(wsDir, '.claude-plugin', 'plugin.json'), 'not json')
    expect(readPluginName(wsDir)).toBeNull()
  })
})
// ============================================================================
// extractWorkspaceSlug — reads plugin name, falls back to basename
// ============================================================================

describe('workspace slug extraction', () => {
  const fallback = 'fallback-id'

  it('reads plugin name from plugin.json when available', () => {
    const testDir2 = join(tmpdir(), `slug-plugin-test-${Date.now()}`)
    const wsDir = join(testDir2, 'bd1675ea-4ba1-96e0-3de4-22c803b11e0d')
    mkdirSync(join(wsDir, '.claude-plugin'), { recursive: true })
    writeFileSync(join(wsDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'craft-workspace-default', version: '1.0.0' }))
    expect(extractWorkspaceSlug(wsDir, fallback)).toBe('craft-workspace-default')
    rmSync(testDir2, { recursive: true, force: true })
  })

  it('extracts slug from normal path', () => {
    expect(extractWorkspaceSlug('/Users/foo/my-workspace', fallback)).toBe('my-workspace')
  })

  it('extracts slug from path with trailing slash', () => {
    expect(extractWorkspaceSlug('/path/workspace/', fallback)).toBe('workspace')
  })

  it('extracts slug from deep path', () => {
    expect(extractWorkspaceSlug('/a/b/c/d/workspace', fallback)).toBe('workspace')
  })

  it('extracts slug from single-component path', () => {
    expect(extractWorkspaceSlug('/workspace', fallback)).toBe('workspace')
  })

  it('returns fallback for root path /', () => {
    // split('/').filter(Boolean) on '/' gives []
    // [].at(-1) is undefined, so fallback is used
    expect(extractWorkspaceSlug('/', fallback)).toBe(fallback)
  })

  it('returns fallback for empty string', () => {
    // split('/').filter(Boolean) on '' gives []
    expect(extractWorkspaceSlug('', fallback)).toBe(fallback)
  })

  it('handles Windows-style paths with forward slashes', () => {
    expect(extractWorkspaceSlug('C:/Users/foo/workspace', fallback)).toBe('workspace')
  })

  it('handles Windows-style paths with backslashes', () => {
    expect(extractWorkspaceSlug('C:\\Users\\ghalmos\\.bitlab\\workspaces\\my-workspace', fallback)).toBe('my-workspace')
  })

  it('handles Windows paths with tilde and backslashes', () => {
    expect(extractWorkspaceSlug('~\\.bitlab\\workspaces\\my-workspace', fallback)).toBe('my-workspace')
  })

  it('handles hyphenated workspace names', () => {
    expect(extractWorkspaceSlug('/path/to/my-cool-workspace', fallback)).toBe('my-cool-workspace')
  })

  it('handles dotted workspace names', () => {
    expect(extractWorkspaceSlug('/path/to/my.workspace-name', fallback)).toBe('my.workspace-name')
  })

  it('handles workspace names with underscores', () => {
    expect(extractWorkspaceSlug('/path/to/my_workspace', fallback)).toBe('my_workspace')
  })

  it('handles paths with spaces in components', () => {
    expect(extractWorkspaceSlug('/Users/John Smith/My Workspace', fallback)).toBe('My Workspace')
  })

  it('handles multiple trailing slashes', () => {
    // filter(Boolean) removes empty strings from split
    expect(extractWorkspaceSlug('/path/workspace///', fallback)).toBe('workspace')
  })
})
