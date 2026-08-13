/**
 * What an expanded tool activity row shows.
 *
 * Lives outside TurnCard.tsx so it stays pure and directly testable — the
 * component module pulls in the whole markdown/attachment stack.
 */

import type { ActivityItem } from './TurnCard'

/**
 * Line budget for an unfolded tool row.
 *
 * Enough to read a short command's output in place; past it the row would
 * dominate the transcript, so the remainder moves to the overlay.
 */
export const INLINE_DETAIL_MAX_LINES = 16

/**
 * Drop the shared head and tail of an edit so only the changed lines remain.
 *
 * Edits usually resend a chunk of surrounding context on both sides; showing
 * it verbatim would bury the two lines that actually changed.
 */
export function diffChangedLines(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n')
  const b = after.split('\n')

  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++

  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++

  return {
    removed: a.slice(head, a.length - tail),
    added: b.slice(head, b.length - tail),
  }
}

export type InlineToolDetail =
  | { kind: 'diff'; removed: string[]; added: string[]; lineCount: number }
  | { kind: 'text'; lines: string[]; lineCount: number }

/**
 * What an expanded tool row shows.
 *
 * An edit is judged by what it changed, everything else by what it printed.
 * Returns null when the row has nothing worth unfolding, so the caller can
 * skip the expand affordance entirely.
 */
export function getInlineToolDetail(activity: ActivityItem): InlineToolDetail | null {
  if (activity.error) {
    const lines = activity.error.split('\n')
    return { kind: 'text', lines, lineCount: lines.length }
  }

  const oldText = activity.toolInput?.old_string
  const newText = activity.toolInput?.new_string
  if (typeof oldText === 'string' && typeof newText === 'string') {
    const { removed, added } = diffChangedLines(oldText, newText)
    if (removed.length || added.length) {
      return { kind: 'diff', removed, added, lineCount: removed.length + added.length }
    }
  }

  const output = activity.content?.trim()
  if (output) {
    const lines = output.split('\n')
    return { kind: 'text', lines, lineCount: lines.length }
  }

  return null
}
