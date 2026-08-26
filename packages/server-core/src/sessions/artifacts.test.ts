import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import nodePath, { join } from 'node:path'
import type { Message } from '@bitlab/core/types'
import type { ArtifactRevision } from '@bitlab/shared/protocol'
import {
  buildSessionArtifactsSnapshot,
  classifyCandidate,
  deriveToolCandidates,
  resolveToolPath,
  toArtifactKind,
  toRelativePath,
  type ArtifactContext,
} from './artifacts.ts'

let seq = 0
function toolMessage(overrides: Partial<Message>): Message {
  seq += 1
  return {
    id: `msg-${seq}`,
    role: 'tool',
    content: '',
    timestamp: 1_000 + seq,
    toolName: 'Write',
    toolUseId: `tu-${seq}`,
    toolStatus: 'completed',
    turnId: 'turn-1',
    ...overrides,
  } as Message
}

describe('deriveToolCandidates', () => {
  const context: ArtifactContext = { sessionFolderPath: '/ws/sessions/s1', cwd: '/project' }

  it('accepts the four structured write tools', () => {
    const messages = [
      toolMessage({ toolName: 'Write', toolInput: { file_path: '/project/a.md' } }),
      toolMessage({ toolName: 'Edit', toolInput: { file_path: '/project/b.md' } }),
      toolMessage({ toolName: 'MultiEdit', toolInput: { file_path: '/project/c.md' } }),
      toolMessage({ toolName: 'NotebookEdit', toolInput: { notebook_path: '/project/d.ipynb' } }),
    ]
    expect([...deriveToolCandidates(messages, context).keys()].sort()).toEqual([
      '/project/a.md', '/project/b.md', '/project/c.md', '/project/d.ipynb',
    ])
  })

  it('ignores reads, shell commands and unfinished or failed writes', () => {
    const messages = [
      toolMessage({ toolName: 'Read', toolInput: { file_path: '/project/read.md' } }),
      toolMessage({ toolName: 'Bash', toolInput: { command: 'echo hi > /project/shell.txt' } }),
      toolMessage({ toolName: 'Write', toolStatus: 'error', toolInput: { file_path: '/project/failed.md' } }),
      toolMessage({ toolName: 'Write', toolStatus: 'executing', toolInput: { file_path: '/project/running.md' } }),
      toolMessage({ toolName: 'Write', toolStatus: 'backgrounded', toolInput: { file_path: '/project/bg.md' } }),
      toolMessage({ toolName: 'Write', isError: true, toolInput: { file_path: '/project/errored.md' } }),
    ]
    expect(deriveToolCandidates(messages, context).size).toBe(0)
  })

  it('resolves relative paths against the session cwd', () => {
    const candidates = deriveToolCandidates(
      [toolMessage({ toolInput: { file_path: 'docs/report.md' } })],
      context,
    )
    expect([...candidates.keys()]).toEqual(['/project/docs/report.md'])
  })

  it('merges repeated writes to one path and keeps revisions in order', () => {
    const candidates = deriveToolCandidates([
      toolMessage({ toolInput: { file_path: '/project/a.md' }, timestamp: 300, toolUseId: 'tu-b' }),
      toolMessage({ toolInput: { file_path: '/project/a.md' }, timestamp: 100, toolUseId: 'tu-a' }),
    ], context)

    const candidate = candidates.get('/project/a.md')!
    expect(candidate.revisions.map(r => r.timestamp)).toEqual([100, 300])
  })

  it('counts a tool use once even if the transcript repeats it', () => {
    const candidates = deriveToolCandidates([
      toolMessage({ toolUseId: 'tu-dup', toolInput: { file_path: '/project/a.md' } }),
      toolMessage({ toolUseId: 'tu-dup', toolInput: { file_path: '/project/a.md' } }),
    ], context)
    expect(candidates.get('/project/a.md')!.revisions).toHaveLength(1)
  })

  it('keeps same-basename files in different folders apart', () => {
    const candidates = deriveToolCandidates([
      toolMessage({ toolInput: { file_path: '/project/one/report.md' } }),
      toolMessage({ toolInput: { file_path: '/project/two/report.md' } }),
    ], context)
    expect(candidates.size).toBe(2)
  })

  it('drops session caches, attachments and hidden files', () => {
    const candidates = deriveToolCandidates([
      toolMessage({ toolInput: { file_path: '/ws/sessions/s1/attachments/in.png' } }),
      toolMessage({ toolInput: { file_path: '/ws/sessions/s1/long_responses/r.md' } }),
      toolMessage({ toolInput: { file_path: '/ws/sessions/s1/downloads/x.pdf' } }),
      toolMessage({ toolInput: { file_path: '/ws/sessions/s1/session.jsonl' } }),
      toolMessage({ toolInput: { file_path: '/ws/sessions/s1/.cache/x.json' } }),
    ], context)
    expect(candidates.size).toBe(0)
  })

  it('refuses unusable paths', () => {
    expect(resolveToolPath('', context)).toBeNull()
    expect(resolveToolPath('  ', context)).toBeNull()
    expect(resolveToolPath('a\0b', context)).toBeNull()
    expect(resolveToolPath(undefined, context)).toBeNull()
    expect(resolveToolPath(42, context)).toBeNull()
  })

  it('resolves Windows paths with the Windows path implementation', () => {
    const winContext: ArtifactContext = {
      sessionFolderPath: 'C:\\ws\\sessions\\s1',
      cwd: 'C:\\project',
      path: nodePath.win32,
    }
    const candidates = deriveToolCandidates([
      toolMessage({ toolInput: { file_path: 'docs\\report.md' } }),
      toolMessage({ toolInput: { file_path: 'C:\\ws\\sessions\\s1\\attachments\\in.png' } }),
    ], winContext)

    expect([...candidates.keys()]).toEqual(['C:\\project\\docs\\report.md'])
  })
})

describe('classifyCandidate', () => {
  const context: ArtifactContext = { sessionFolderPath: '/ws/sessions/s1', cwd: '/project' }
  const revision = (toolName: string, timestamp: number): ArtifactRevision =>
    ({ messageId: `m-${timestamp}`, toolUseId: `t-${timestamp}`, toolName, timestamp })
  const candidate = (
    path: string,
    sources: Array<'tool' | 'session-output'>,
    revisions: ArtifactRevision[] = [],
  ) => ({ path, sources, revisions })

  it('calls a file the agent wrote a deliverable, wherever it sits', () => {
    // The real case that broke the old location rule: the agent works in a
    // folder under the workspace root, never in the session directory.
    expect(classifyCandidate(
      candidate('/project/agent-team-research/report.md', ['tool'], [revision('Write', 100)]),
      context,
    )).toEqual({ scope: 'workspace', classification: 'artifact' })

    expect(classifyCandidate(
      candidate('/ws/sessions/s1/plans/p.md', ['tool'], [revision('Write', 100)]),
      context,
    )).toEqual({ scope: 'session', classification: 'artifact' })
  })

  it('calls a file the agent only edited a change', () => {
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(classifyCandidate(
        candidate('/project/src/index.ts', ['tool'], [revision(tool, 100)]),
        context,
      )).toEqual({ scope: 'workspace', classification: 'change' })
    }
  })

  it('decides on the first write, not the last', () => {
    // Edited first, rewritten later: the file predates the session either way.
    expect(classifyCandidate(
      candidate('/project/src/index.ts', ['tool'], [revision('Edit', 100), revision('Write', 200)]),
      context,
    ).classification).toBe('change')

    // Written first, tweaked later: the agent still authored it.
    expect(classifyCandidate(
      candidate('/project/out.md', ['tool'], [revision('Write', 100), revision('Edit', 200)]),
      context,
    ).classification).toBe('artifact')
  })

  it('treats an output-folder file with no provenance as a deliverable', () => {
    expect(classifyCandidate(candidate('/ws/sessions/s1/data/r.json', ['session-output']), context))
      .toEqual({ scope: 'session', classification: 'artifact' })
  })
})

describe('toArtifactKind', () => {
  it('maps by extension and falls back to other', () => {
    expect(toArtifactKind('/a/report.html')).toBe('html')
    expect(toArtifactKind('/a/notes.md')).toBe('markdown')
    expect(toArtifactKind('/a/out.pdf')).toBe('pdf')
    expect(toArtifactKind('/a/chart.png')).toBe('image')
    expect(toArtifactKind('/a/data.json')).toBe('json')
    expect(toArtifactKind('/a/deck.pptx')).toBe('office')
    expect(toArtifactKind('/a/main.ts')).toBe('code')
    expect(toArtifactKind('/a/log.txt')).toBe('text')
    expect(toArtifactKind('/a/Makefile')).toBe('other')
  })
})

describe('buildSessionArtifactsSnapshot', () => {
  let root: string
  let sessionFolderPath: string
  let cwd: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bitlab-artifacts-'))
    sessionFolderPath = join(root, 'sessions', 's1')
    cwd = join(root, 'project')
    mkdirSync(join(sessionFolderPath, 'plans'), { recursive: true })
    mkdirSync(join(sessionFolderPath, 'data'), { recursive: true })
    mkdirSync(join(sessionFolderPath, 'downloads'), { recursive: true })
    mkdirSync(join(cwd, 'src'), { recursive: true })
  })

  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const build = (messages: Message[]) =>
    buildSessionArtifactsSnapshot({ sessionId: 's1', messages, context: { sessionFolderPath, cwd } })

  it('finds files a script left in the output folders, with no tool provenance', async () => {
    writeFileSync(join(sessionFolderPath, 'data', 'report.html'), '<h1>hi</h1>')
    writeFileSync(join(sessionFolderPath, 'downloads', 'input.pdf'), 'cached')

    const snapshot = await build([])
    expect(snapshot.artifacts.map(a => a.name)).toEqual(['report.html'])
    expect(snapshot.artifacts[0]!.sources).toEqual(['session-output'])
    expect(snapshot.artifacts[0]!.revisions).toEqual([])
  })

  it('separates what the agent wrote from what it only edited', async () => {
    const artifactPath = join(cwd, 'agent-team-research', 'report.md')
    const changePath = join(cwd, 'src', 'index.ts')
    mkdirSync(join(cwd, 'agent-team-research'), { recursive: true })
    writeFileSync(artifactPath, '# report')
    writeFileSync(changePath, 'export {}')

    const snapshot = await build([
      toolMessage({ toolInput: { file_path: artifactPath } }),
      toolMessage({ toolName: 'Edit', toolInput: { file_path: changePath } }),
    ])

    expect(snapshot.artifacts.map(a => a.path)).toEqual([artifactPath])
    expect(snapshot.artifacts[0]!.sources).toEqual(['tool'])
    expect(snapshot.changes.map(a => a.path)).toEqual([changePath])
    expect(snapshot.changes[0]!.scope).toBe('workspace')
  })

  it('keeps a deleted file that a tool wrote, and drops a scan-only one', async () => {
    const written = join(cwd, 'gone.md')
    const snapshot = await build([toolMessage({ toolInput: { file_path: written } })])

    expect(snapshot.artifacts).toHaveLength(1)
    expect(snapshot.artifacts[0]!.exists).toBe(false)
    expect(snapshot.artifacts[0]!.size).toBeUndefined()
    expect(snapshot.artifacts[0]!.revisions).toHaveLength(1)
  })

  it('still records both sources when a write lands in an output folder', async () => {
    const path = join(sessionFolderPath, 'data', 'report.html')
    writeFileSync(path, '<h1>hi</h1>')

    const snapshot = await build([toolMessage({ toolInput: { file_path: path } })])
    expect(snapshot.artifacts[0]!.sources).toEqual(['tool', 'session-output'])
  })

  it('does not promote a path just because the response mentions it', async () => {
    const mentioned = join(cwd, 'src', 'index.ts')
    writeFileSync(mentioned, 'export {}')

    const snapshot = await build([
      toolMessage({ toolName: 'Edit', toolInput: { file_path: mentioned } }),
      {
        id: 'assistant-1',
        role: 'assistant',
        content: `I generated ${mentioned} for you.`,
        timestamp: 9_000,
      } as Message,
    ])

    expect(snapshot.artifacts).toHaveLength(0)
    expect(snapshot.changes.map(a => a.path)).toEqual([mentioned])
  })

  it('sorts by most recent change and reports metadata', async () => {
    const older = join(sessionFolderPath, 'plans', 'older.md')
    const newer = join(sessionFolderPath, 'data', 'newer.json')
    writeFileSync(older, '# older')
    await Bun.sleep(10)
    writeFileSync(newer, '{}')

    const snapshot = await build([])
    expect(snapshot.artifacts.map(a => a.name)).toEqual(['newer.json', 'older.md'])
    expect(snapshot.artifacts[0]!.kind).toBe('json')
    expect(snapshot.artifacts[0]!.exists).toBe(true)
    expect(snapshot.artifacts[0]!.size).toBe(2)
  })

  it('rebuilds identically from the same transcript', async () => {
    const path = join(sessionFolderPath, 'data', 'report.html')
    writeFileSync(path, '<h1>hi</h1>')
    const messages = [
      toolMessage({ toolInput: { file_path: path }, timestamp: 100, toolUseId: 'tu-x' }),
      toolMessage({ toolName: 'Edit', toolInput: { file_path: path }, timestamp: 200, toolUseId: 'tu-y' }),
    ]

    const first = await build(messages)
    const second = await build(messages)
    expect(second).toEqual(first)
    expect(first.artifacts[0]!.revisions).toHaveLength(2)
  })
})

describe('toRelativePath', () => {
  const context: ArtifactContext = { sessionFolderPath: '/ws/sessions/s1', cwd: '/project' }

  it('prefers the session folder, then the cwd, then gives up', () => {
    expect(toRelativePath('/ws/sessions/s1/data/report.html', context)).toBe('data/report.html')
    expect(toRelativePath('/project/src/index.ts', context)).toBe('src/index.ts')
    expect(toRelativePath('/elsewhere/note.md', context)).toBe('/elsewhere/note.md')
  })
})
