import { describe, expect, it } from 'bun:test'
import { selectTurnProducedMedia, type TurnMediaArtifact } from '../media-utils'
import { MAX_MEDIA_TILES } from '../MessageMediaPreview'

const artifact = (
  name: string,
  overrides: Partial<TurnMediaArtifact> = {},
): TurnMediaArtifact => ({
  path: `/session/data/${name}`,
  name,
  kind: name.endsWith('.mp4') ? 'video' : name.endsWith('.mp3') ? 'audio' : 'image',
  exists: true,
  media: { mimeType: 'image/png', byteSize: 10 },
  revisions: [{ messageId: 'm1', toolUseId: 'a', timestamp: 100 }],
  ...overrides,
})

const turn = (...toolUseIds: string[]) => toolUseIds.map(toolUseId => ({ toolUseId }))

describe('selectTurnProducedMedia', () => {
  it('claims only the media this turn produced', () => {
    const artifacts = [
      artifact('mine.png'),
      artifact('theirs.png', { revisions: [{ messageId: 'm2', toolUseId: 'other', timestamp: 100 }] }),
      artifact('scanned.png', { revisions: [] }),
    ]

    expect(selectTurnProducedMedia(artifacts, turn('a')).map(m => m.name)).toEqual(['mine.png'])
  })

  it('leaves non-media artifacts to the produced-files row', () => {
    const artifacts = [
      artifact('report.md', { kind: 'markdown', media: undefined }),
      artifact('render.png'),
    ]

    expect(selectTurnProducedMedia(artifacts, turn('a')).map(m => m.name)).toEqual(['render.png'])
  })

  it('binds each card to the message that produced it, not to the last one', () => {
    const artifacts = [
      artifact('a.png', { revisions: [{ messageId: 'tool-msg-7', toolUseId: 'a', timestamp: 100 }] }),
    ]

    expect(selectTurnProducedMedia(artifacts, turn('a'))[0]!.messageId).toBe('tool-msg-7')
  })

  it('shows a repeatedly written file once, at its first write', () => {
    const artifacts = [
      artifact('a.png', {
        revisions: [
          { messageId: 'm2', toolUseId: 'a2', timestamp: 400 },
          { messageId: 'm1', toolUseId: 'a1', timestamp: 100 },
        ],
      }),
      artifact('b.png', { revisions: [{ messageId: 'm3', toolUseId: 'b', timestamp: 200 }] }),
    ]

    const selected = selectTurnProducedMedia(artifacts, turn('a1', 'a2', 'b'))
    expect(selected.map(m => m.name)).toEqual(['a.png', 'b.png'])
    expect(selected[0]!.messageId).toBe('m1')
  })

  it('does not merge same-named files from different directories', () => {
    const artifacts = [
      artifact('shot.png', { path: '/session/data/one/shot.png' }),
      artifact('shot.png', {
        path: '/session/data/two/shot.png',
        revisions: [{ messageId: 'm2', toolUseId: 'b', timestamp: 200 }],
      }),
    ]

    expect(selectTurnProducedMedia(artifacts, turn('a', 'b'))).toHaveLength(2)
  })

  it('distinguishes the four ways a card can fail to render', () => {
    const artifacts = [
      artifact('ready.png'),
      artifact('gone.png', { exists: false, revisions: [{ messageId: 'm', toolUseId: 'b', timestamp: 200 }] }),
      artifact('lying.png', { media: undefined, revisions: [{ messageId: 'm', toolUseId: 'c', timestamp: 300 }] }),
      artifact('raw.mkv', {
        kind: 'video',
        media: { mimeType: 'video/x-matroska' },
        revisions: [{ messageId: 'm', toolUseId: 'd', timestamp: 400 }],
      }),
    ]

    const byName = new Map(
      selectTurnProducedMedia(artifacts, turn('a', 'b', 'c', 'd')).map(m => [m.name, m]),
    )

    expect(byName.get('ready.png')!.status).toBe('ready')
    expect(byName.get('gone.png')).toMatchObject({ status: 'missing', errorCode: 'file_missing' })
    expect(byName.get('lying.png')).toMatchObject({ status: 'error', errorCode: 'read_failed' })
    expect(byName.get('raw.mkv')).toMatchObject({ status: 'unsupported', errorCode: 'codec_unsupported' })
  })

  it('carries no bytes into the message — only a reference and probed facts', () => {
    const [media] = selectTurnProducedMedia([artifact('render.png')], turn('a'))

    expect(media!.artifactPath).toBe('/session/data/render.png')
    expect(JSON.stringify(media)).not.toContain('base64')
    expect(JSON.stringify(media)).not.toContain('http')
  })

  it('produces nothing when the turn ran no tools', () => {
    expect(selectTurnProducedMedia([artifact('a.png')], [])).toEqual([])
  })
})

describe('MAX_MEDIA_TILES', () => {
  it('keeps the first screen bounded', () => {
    expect(MAX_MEDIA_TILES).toBe(4)
  })
})
