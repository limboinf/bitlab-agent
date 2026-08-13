/**
 * Unit tests for the inline (expand-in-place) tool row detail.
 *
 * A tool row unfolds under the cursor instead of opening the full-screen
 * overlay. These functions decide what that unfolded body shows: the lines an
 * edit changed, or the output a command printed.
 */

import { describe, it, expect } from 'bun:test'
import { diffChangedLines, getInlineToolDetail } from '../tool-detail'
import type { ActivityItem } from '../TurnCard'

function toolActivity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    id: 't1',
    type: 'tool',
    status: 'completed',
    timestamp: 1000,
    toolName: 'Bash',
    ...overrides,
  }
}

describe('diffChangedLines', () => {
  it('keeps only the appended lines when an edit adds to the end', () => {
    const before = '  .overlay-title { font-size: 36px; }\n}'
    const after = '  .overlay-title { font-size: 36px; }\n}\n\n/* reviewed by bitlab */'

    expect(diffChangedLines(before, after)).toEqual({
      removed: [],
      added: ['', '/* reviewed by bitlab */'],
    })
  })

  it('trims context on both sides of a middle change', () => {
    const before = 'a\nb\nOLD\nd\ne'
    const after = 'a\nb\nNEW\nd\ne'

    expect(diffChangedLines(before, after)).toEqual({
      removed: ['OLD'],
      added: ['NEW'],
    })
  })

  it('reports a pure deletion', () => {
    expect(diffChangedLines('keep\ngone\nkeep2', 'keep\nkeep2')).toEqual({
      removed: ['gone'],
      added: [],
    })
  })

  it('returns nothing changed for identical text', () => {
    expect(diffChangedLines('same\ntext', 'same\ntext')).toEqual({
      removed: [],
      added: [],
    })
  })

  it('does not double-count a line shared by the head and tail scans', () => {
    // 'x' matches as both a leading and a trailing line; it must be consumed once
    expect(diffChangedLines('x', 'x\ny')).toEqual({
      removed: [],
      added: ['y'],
    })
  })
})

describe('getInlineToolDetail', () => {
  it('prefers the edit diff over the tool result for Edit calls', () => {
    const detail = getInlineToolDetail(toolActivity({
      toolName: 'Edit',
      toolInput: { file_path: 'a.css', old_string: 'a\nb', new_string: 'a\nb\nc' },
      content: 'Successfully replaced 1 block(s) in a.css.',
    }))

    expect(detail).toEqual({ kind: 'diff', removed: [], added: ['c'], lineCount: 1 })
  })

  it('falls back to the result when an edit changed nothing', () => {
    const detail = getInlineToolDetail(toolActivity({
      toolName: 'Edit',
      toolInput: { old_string: 'same', new_string: 'same' },
      content: 'No changes made.',
    }))

    expect(detail).toEqual({ kind: 'text', lines: ['No changes made.'], lineCount: 1 })
  })

  it('shows command output as text lines', () => {
    const detail = getInlineToolDetail(toolActivity({
      content: '432 game.js\n46 index.html\n256 style.css',
    }))

    expect(detail).toEqual({
      kind: 'text',
      lines: ['432 game.js', '46 index.html', '256 style.css'],
      lineCount: 3,
    })
  })

  it('shows the error ahead of anything else', () => {
    const detail = getInlineToolDetail(toolActivity({
      status: 'error',
      error: 'command not found: fooo',
      content: 'ignored output',
    }))

    expect(detail).toEqual({
      kind: 'text',
      lines: ['command not found: fooo'],
      lineCount: 1,
    })
  })

  it('returns null when there is nothing to unfold', () => {
    expect(getInlineToolDetail(toolActivity({ content: '' }))).toBeNull()
    expect(getInlineToolDetail(toolActivity({ content: '   \n  ' }))).toBeNull()
    expect(getInlineToolDetail(toolActivity())).toBeNull()
  })
})
