/**
 * Splitting a user message's badges into the two ways they render.
 *
 * Most badges sit inline where their text was. Two kinds instead REPLACE their
 * marked range: an edit request, and the envelope header on a message another
 * session sent (see the `agent` badge type). Those render above the bubble and
 * their range is cut from the displayed text — the model still receives the full
 * content, the reader is spared the plumbing.
 */

import type { ContentBadge } from '@bitlab/core'

/** Edit requests are context badges carrying an `<edit_request>` payload. */
export function isEditRequestBadge(badge: ContentBadge): boolean {
  return badge.type === 'context' && !!badge.rawText?.includes('<edit_request>')
}

/** A message that arrived from another session rather than from the user. */
export function isAgentBadge(badge: ContentBadge): boolean {
  return badge.type === 'agent'
}

/** Badges rendered above the bubble, with their marked range cut from the text. */
export function isDetachedBadge(badge: ContentBadge): boolean {
  return isEditRequestBadge(badge) || isAgentBadge(badge)
}

export interface SplitUserMessageBadges {
  /** Rendered above the bubble, in the order given. */
  detached: ContentBadge[]
  /** Rendered inline, at their position in the text. */
  inline: ContentBadge[]
  /** Text to show, with every detached range removed. */
  displayContent: string
  /** Whether this message came from another session. */
  isFromAgent: boolean
}

export function splitUserMessageBadges(
  content: string,
  badges?: ContentBadge[],
): SplitUserMessageBadges {
  const detached = badges?.filter(isDetachedBadge) ?? []
  const inline = badges?.filter(badge => !isDetachedBadge(badge)) ?? []

  let displayContent = content
  if (detached.length > 0) {
    // Remove back to front so each cut leaves the earlier offsets valid.
    for (const badge of [...detached].sort((a, b) => b.start - a.start)) {
      displayContent = displayContent.slice(0, badge.start) + displayContent.slice(badge.end)
    }
    displayContent = displayContent.trim()
  }

  return { detached, inline, displayContent, isFromAgent: detached.some(isAgentBadge) }
}
