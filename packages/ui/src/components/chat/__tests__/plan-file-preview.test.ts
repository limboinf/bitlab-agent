/**
 * Unit tests for plan file path detection.
 *
 * A plan message whose whole body is an absolute .md path is rendered inline
 * from the file; anything else renders as-is.
 */

import { describe, it, expect } from 'bun:test'
import { extractPlanFilePath } from '../plan-file-preview'

describe('extractPlanFilePath', () => {
  it('detects an absolute plan file path', () => {
    const path = '/Users/limbo/.bitlab/workspaces/mysite/sessions/260820-amber-harbor/plans/personal-site-plan.md'
    expect(extractPlanFilePath(path)).toBe(path)
    expect(extractPlanFilePath(`  ${path}\n`)).toBe(path)
  })

  it('accepts paths wrapped in backticks or angle brackets', () => {
    expect(extractPlanFilePath('`/tmp/plans/a.md`')).toBe('/tmp/plans/a.md')
    expect(extractPlanFilePath('</tmp/plans/a.md>')).toBe('/tmp/plans/a.md')
  })

  it('accepts Windows and ~-rooted paths', () => {
    expect(extractPlanFilePath('C:\\bitlab\\plans\\plan.md')).toBe('C:\\bitlab\\plans\\plan.md')
    expect(extractPlanFilePath('~/plans/plan.md')).toBe('~/plans/plan.md')
  })

  it('ignores plan bodies that are not a bare path', () => {
    expect(extractPlanFilePath('# Plan\n\n1. Do the thing')).toBeNull()
    expect(extractPlanFilePath('See /tmp/plans/a.md for details')).toBeNull()
    expect(extractPlanFilePath('/tmp/plans/a.md\n/tmp/plans/b.md')).toBeNull()
    expect(extractPlanFilePath('')).toBeNull()
  })

  it('ignores relative paths and non-markdown files', () => {
    expect(extractPlanFilePath('plans/plan.md')).toBeNull()
    expect(extractPlanFilePath('/tmp/plans/plan.txt')).toBeNull()
  })
})
