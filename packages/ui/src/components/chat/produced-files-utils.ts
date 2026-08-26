/**
 * Which artifacts belong under which turn.
 *
 * The join is on `toolUseId`, not on `turnId`. A UI turn is everything between
 * two user messages — `groupMessagesByTurn` deliberately ignores backend turn
 * ids, and the backend hands out several of them per user question (plus
 * anchored variants like `pi-turn-2__m9` for individual texts). Matching those
 * strings would attribute almost nothing. The tool calls a card actually shows
 * are unambiguous, and every artifact revision names the one that produced it.
 *
 * Files found only by scanning the session's output folders carry no tool
 * provenance and therefore appear under no turn — attributing the current
 * directory contents to the last turn would look complete and be wrong.
 */

import type { ProducedFile } from './ProducedFilesRow'

/** The subset of a SessionArtifact this selection needs. */
export interface TurnArtifactSource {
  path: string
  name: string
  revisions: Array<{ toolUseId: string; timestamp: number }>
}

/** The subset of an ActivityItem this selection needs. */
export interface TurnActivitySource {
  toolUseId?: string
}

/**
 * Artifacts this turn produced, one row per path, in the order the turn first
 * wrote them.
 */
export function selectTurnProducedFiles(
  artifacts: TurnArtifactSource[],
  activities: TurnActivitySource[],
): ProducedFile[] {
  const turnToolUseIds = new Set<string>()
  for (const activity of activities) {
    if (activity.toolUseId) turnToolUseIds.add(activity.toolUseId)
  }
  if (turnToolUseIds.size === 0) return []

  const firstWrite: Array<{ file: ProducedFile; timestamp: number }> = []

  for (const artifact of artifacts) {
    let earliest: number | undefined
    for (const revision of artifact.revisions) {
      if (!turnToolUseIds.has(revision.toolUseId)) continue
      if (earliest === undefined || revision.timestamp < earliest) earliest = revision.timestamp
    }
    if (earliest === undefined) continue
    firstWrite.push({ file: { path: artifact.path, name: artifact.name }, timestamp: earliest })
  }

  return firstWrite
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(entry => entry.file)
}
