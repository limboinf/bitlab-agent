/**
 * Which media belongs under which turn.
 *
 * Same join as the produced-files row, and for the same reason: `toolUseId`,
 * never `turnId`, because a UI turn spans several backend turn ids and matching
 * those strings would attribute almost nothing. See produced-files-utils.ts.
 *
 * Media is a projection of the artifact snapshot — this module reads it, it
 * never derives files of its own. Anything the artifact layer refuses to call a
 * media artifact does not become a card here.
 */

import type { MessageMedia, MediaPreviewStatus, MediaErrorCode, MediaMetadata } from '@bitlab/shared/protocol'
import { isInlinePlayableMedia } from '@bitlab/shared/protocol'

/** The subset of a SessionArtifact this selection needs. */
export interface TurnMediaArtifact {
  path: string
  name: string
  kind: string
  exists: boolean
  media?: MediaMetadata
  revisions: Array<{ messageId: string; toolUseId: string; timestamp: number }>
}

/** The subset of an ActivityItem this selection needs. */
export interface TurnMediaActivity {
  toolUseId?: string
}

const MEDIA_KINDS = new Set(['image', 'video', 'audio'])

/**
 * How the card should present one artifact.
 *
 * Four distinct outcomes, because conflating them is what makes a broken
 * preview unexplainable: the file is gone, the bytes are not what the name
 * claimed, this host has no codec for it, or it is fine.
 */
function deriveStatus(artifact: TurnMediaArtifact): { status: MediaPreviewStatus; errorCode?: MediaErrorCode } {
  if (!artifact.exists) return { status: 'missing', errorCode: 'file_missing' }
  // The probe returns nothing when the leading bytes contradict the extension.
  // Showing a player for that would be a promise the file cannot keep.
  if (!artifact.media) return { status: 'error', errorCode: 'read_failed' }
  if (!isInlinePlayableMedia(artifact.path)) {
    return { status: 'unsupported', errorCode: 'codec_unsupported' }
  }
  return { status: 'ready' }
}

/**
 * Media this turn produced, one card per path, in the order the turn first
 * wrote them.
 *
 * The message id comes from the tool message that produced the earliest write
 * in this turn — the persisted fact that the media exists — rather than from
 * whichever assistant message happens to be last.
 */
export function selectTurnProducedMedia(
  artifacts: TurnMediaArtifact[],
  activities: TurnMediaActivity[],
): MessageMedia[] {
  const turnToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (activity.toolUseId) turnToolUseIds.add(activity.toolUseId)
  }
  if (turnToolUseIds.size === 0) return []

  const selected: Array<{ media: MessageMedia; timestamp: number }> = []
  const seenPaths = new Set<string>()

  for (const artifact of artifacts) {
    if (!MEDIA_KINDS.has(artifact.kind)) continue
    if (seenPaths.has(artifact.path)) continue

    let earliest: { messageId: string; timestamp: number } | undefined
    for (const revision of artifact.revisions) {
      if (!turnToolUseIds.has(revision.toolUseId)) continue
      if (!earliest || revision.timestamp < earliest.timestamp) {
        earliest = { messageId: revision.messageId, timestamp: revision.timestamp }
      }
    }
    if (!earliest) continue

    seenPaths.add(artifact.path)
    const { status, errorCode } = deriveStatus(artifact)

    selected.push({
      timestamp: earliest.timestamp,
      media: {
        id: artifact.path,
        messageId: earliest.messageId,
        artifactPath: artifact.path,
        name: artifact.name,
        mediaType: artifact.kind as MessageMedia['mediaType'],
        metadata: artifact.media ?? { mimeType: 'application/octet-stream' },
        status,
        ...(errorCode ? { errorCode } : {}),
      },
    })
  }

  return selected
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(entry => entry.media)
}
