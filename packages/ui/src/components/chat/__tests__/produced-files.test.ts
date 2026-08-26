import { describe, expect, it } from 'bun:test'
import { selectTurnProducedFiles, type TurnArtifactSource } from '../produced-files-utils'
import { MAX_PRODUCED_CHIPS } from '../ProducedFilesRow'

const artifact = (
  name: string,
  revisions: Array<{ toolUseId: string; timestamp: number }>,
): TurnArtifactSource => ({ path: `/session/data/${name}`, name, revisions })

const turn = (...toolUseIds: string[]) => toolUseIds.map(toolUseId => ({ toolUseId }))

describe('selectTurnProducedFiles', () => {
  it('keeps the order the turn first wrote each file', () => {
    const artifacts = [
      artifact('c.md', [{ toolUseId: 'c', timestamp: 300 }]),
      artifact('a.md', [{ toolUseId: 'a', timestamp: 100 }]),
      artifact('b.md', [{ toolUseId: 'b', timestamp: 200 }]),
    ]

    expect(selectTurnProducedFiles(artifacts, turn('a', 'b', 'c')).map(f => f.name))
      .toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('shows a repeatedly written file once, at its first write', () => {
    const artifacts = [
      artifact('a.md', [{ toolUseId: 'a1', timestamp: 100 }, { toolUseId: 'a2', timestamp: 400 }]),
      artifact('b.md', [{ toolUseId: 'b', timestamp: 200 }]),
    ]

    expect(selectTurnProducedFiles(artifacts, turn('a1', 'a2', 'b')).map(f => f.name))
      .toEqual(['a.md', 'b.md'])
  })

  it('claims only the writes this turn actually made', () => {
    const artifacts = [
      artifact('mine.md', [{ toolUseId: 'mine', timestamp: 100 }]),
      artifact('theirs.md', [{ toolUseId: 'theirs', timestamp: 100 }]),
      artifact('scanned.md', []),
    ]

    expect(selectTurnProducedFiles(artifacts, turn('mine')).map(f => f.name)).toEqual(['mine.md'])
  })

  it('matches the same file across turns by write, not by file identity', () => {
    // The plan file rewritten in three consecutive turns belongs to each of them
    // once — the row under turn 2 must not show turn 3's write.
    const plan = artifact('plan.md', [
      { toolUseId: 'w2', timestamp: 200 },
      { toolUseId: 'w3', timestamp: 300 },
    ])

    expect(selectTurnProducedFiles([plan], turn('w2'))).toEqual([
      { path: '/session/data/plan.md', name: 'plan.md' },
    ])
    expect(selectTurnProducedFiles([plan], turn('w4'))).toEqual([])
  })

  it('returns nothing for a turn with no tool calls', () => {
    const artifacts = [artifact('a.md', [{ toolUseId: 'a', timestamp: 1 }])]
    expect(selectTurnProducedFiles(artifacts, [])).toEqual([])
    expect(selectTurnProducedFiles(artifacts, [{ toolUseId: undefined }])).toEqual([])
  })

  it('caps the row at six chips and counts the rest', () => {
    const artifacts = Array.from({ length: 9 }, (_, index) =>
      artifact(`f${index}.md`, [{ toolUseId: `t${index}`, timestamp: index }]))

    const selected = selectTurnProducedFiles(artifacts, turn(...artifacts.map((_, i) => `t${i}`)))
    expect(selected).toHaveLength(9)
    expect(selected.length - MAX_PRODUCED_CHIPS).toBe(3)
  })
})
