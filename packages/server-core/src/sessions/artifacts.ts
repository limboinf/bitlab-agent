/**
 * Session artifacts — a read-only projection, not a store.
 *
 * Two facts feed it, and only two:
 *
 *   1. Successful file-writing tool messages in the persisted transcript.
 *      They carry provenance: which turn, which tool, when.
 *   2. Files that really exist in the session's declared output folders
 *      (`plans/`, `data/`). They catch what Bash and Python wrote — we do not
 *      parse shell commands to guess, we look at what landed.
 *
 * What the model *says* in its final answer is not a fact source. A path
 * mentioned in prose changes nothing about its classification.
 *
 * Artifact or change is decided by *what the agent did to the file*, not by
 * where the file sits. Location looked like the right axis on paper, but in
 * practice the agent works in a folder it makes under the workspace root and
 * the session directory holds only runtime bookkeeping — so a location rule
 * classified every real deliverable as a change.
 */

import { readdir, stat } from 'node:fs/promises'
import nodePath from 'node:path'
import type { Message } from '@bitlab/core/types'
import type {
  ArtifactKind,
  ArtifactRevision,
  SessionArtifact,
  SessionArtifactsSnapshot,
} from '@bitlab/shared/protocol'

/** The subset of `node:path` this module needs — injectable so tests can run win32 fixtures on POSIX. */
export type PathApi = Pick<typeof nodePath, 'resolve' | 'isAbsolute' | 'basename' | 'relative' | 'join' | 'sep'>

/** Structured write tools, mapped to the input field holding their target path. */
const WRITE_TOOL_PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/** Session subfolders that hold inputs or caches — never deliverables. */
const RESERVED_SESSION_ENTRIES = ['attachments', 'long_responses', 'downloads', 'session.jsonl']

/** Folders the agent is explicitly told to write results into. */
export const SESSION_OUTPUT_DIRS = ['plans', 'data']

export interface ArtifactContext {
  /** Absolute path of the session directory. */
  sessionFolderPath: string
  /** Session working directory — the base for relative tool paths. */
  cwd?: string
  /** Path implementation; defaults to the host's. */
  path?: PathApi
}

/** A path plus everything we know about how it came to be. */
export interface ArtifactCandidate {
  path: string
  sources: Array<'tool' | 'session-output'>
  revisions: ArtifactRevision[]
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function isWithin(parent: string, child: string, path: PathApi): boolean {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function segmentsFrom(parent: string, child: string, path: PathApi): string[] {
  return path.relative(parent, child).split(/[\\/]/).filter(Boolean)
}

/**
 * Resolve a tool's raw path against the session cwd.
 * Returns null for anything we cannot turn into a usable absolute path.
 */
export function resolveToolPath(rawPath: unknown, context: ArtifactContext): string | null {
  const path = context.path ?? nodePath
  if (typeof rawPath !== 'string') return null
  const trimmed = rawPath.trim()
  if (!trimmed || trimmed.includes('\0')) return null

  try {
    if (path.isAbsolute(trimmed)) return path.resolve(trimmed)
    const base = context.cwd ?? context.sessionFolderPath
    return path.resolve(base, trimmed)
  } catch {
    return null
  }
}

/** Session-internal paths we refuse to surface at all: hidden files, caches, the transcript. */
function isExcludedSessionPath(absolutePath: string, context: ArtifactContext): boolean {
  const path = context.path ?? nodePath
  if (!isWithin(context.sessionFolderPath, absolutePath, path)) return false
  const segments = segmentsFrom(context.sessionFolderPath, absolutePath, path)
  if (segments.some(segment => segment.startsWith('.'))) return true
  return RESERVED_SESSION_ENTRIES.includes(segments[0] ?? '')
}

/** Display path: relative to whichever known root contains the file. */
export function toRelativePath(absolutePath: string, context: ArtifactContext): string {
  const path = context.path ?? nodePath
  for (const root of [context.sessionFolderPath, context.cwd]) {
    if (root && isWithin(root, absolutePath, path)) return path.relative(root, absolutePath)
  }
  return absolutePath
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Collect write-tool provenance from a persisted transcript.
 *
 * Only completed structured write tools count. Reads, searches, shell commands,
 * failed calls and calls still executing contribute nothing.
 */
export function deriveToolCandidates(
  messages: Message[],
  context: ArtifactContext,
): Map<string, ArtifactCandidate> {
  const path = context.path ?? nodePath
  const candidates = new Map<string, ArtifactCandidate>()
  const seenToolUseIds = new Set<string>()

  for (const message of messages) {
    if (message.role !== 'tool' || message.toolStatus !== 'completed') continue
    if (message.isError) continue

    const field = message.toolName ? WRITE_TOOL_PATH_FIELDS[message.toolName] : undefined
    if (!field) continue

    const toolUseId = message.toolUseId ?? message.id
    if (seenToolUseIds.has(toolUseId)) continue

    const resolved = resolveToolPath(message.toolInput?.[field], context)
    if (!resolved) continue
    if (isExcludedSessionPath(resolved, context)) continue

    seenToolUseIds.add(toolUseId)

    const existing = candidates.get(resolved)
    const revision: ArtifactRevision = {
      messageId: message.id,
      toolUseId,
      toolName: message.toolName!,
      ...(message.turnId ? { turnId: message.turnId } : {}),
      timestamp: message.timestamp,
    }

    if (existing) {
      existing.revisions.push(revision)
    } else {
      candidates.set(resolved, { path: path.resolve(resolved), sources: ['tool'], revisions: [revision] })
    }
  }

  for (const candidate of candidates.values()) {
    candidate.revisions.sort((a, b) => a.timestamp - b.timestamp)
  }

  return candidates
}

/** Merge output-directory scan results into the tool-derived candidates. */
export function mergeOutputScan(
  candidates: Map<string, ArtifactCandidate>,
  scannedPaths: string[],
  context: ArtifactContext,
): Map<string, ArtifactCandidate> {
  for (const scanned of scannedPaths) {
    if (isExcludedSessionPath(scanned, context)) continue
    const existing = candidates.get(scanned)
    if (existing) {
      if (!existing.sources.includes('session-output')) existing.sources.push('session-output')
    } else {
      candidates.set(scanned, { path: scanned, sources: ['session-output'], revisions: [] })
    }
  }
  return candidates
}

const KIND_BY_EXTENSION: Record<string, ArtifactKind> = {
  html: 'html', htm: 'html',
  md: 'markdown', mdx: 'markdown',
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  json: 'json', jsonc: 'json', json5: 'json',
  docx: 'office', doc: 'office', xlsx: 'office', xls: 'office', pptx: 'office', ppt: 'office',
  txt: 'text', log: 'text', csv: 'text', tsv: 'text',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', rb: 'code', rs: 'code', go: 'code', java: 'code', kt: 'code', swift: 'code',
  c: 'code', cpp: 'code', h: 'code', hpp: 'code', cs: 'code', php: 'code', lua: 'code', r: 'code',
  css: 'code', scss: 'code', less: 'code', xml: 'code', yaml: 'code', yml: 'code', toml: 'code',
  sh: 'code', bash: 'code', zsh: 'code', sql: 'code', graphql: 'code', vue: 'code', svelte: 'code',
  ipynb: 'code',
}

export function toArtifactKind(filePath: string, path: PathApi = nodePath): ArtifactKind {
  const name = path.basename(filePath)
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0) return 'other'
  return KIND_BY_EXTENSION[name.slice(dotIndex + 1).toLowerCase()] ?? 'other'
}

/**
 * Artifact or change?
 *
 * A file the agent authored is a deliverable; a file that was already there and
 * got edited is a change the user may want to review. `Write` replaces a whole
 * file, so the first `Write` in a session is the agent producing that file.
 * `Edit`, `MultiEdit` and `NotebookEdit` can only target a file that already
 * exists, so leading with one of them proves the file predates this session.
 *
 * The approximation: a `Write` that overwrites a pre-existing file reads as
 * authorship. Distinguishing the two would mean recording existence before
 * every write, and the mistake is benign — an overwritten file is presented as
 * something the agent made, which it now is.
 */
export function classifyCandidate(
  candidate: ArtifactCandidate,
  context: ArtifactContext,
): Pick<SessionArtifact, 'scope' | 'classification'> {
  const path = context.path ?? nodePath
  const scope = isWithin(context.sessionFolderPath, candidate.path, path) ? 'session' : 'workspace'

  // No tool provenance means an output-folder scan found it — a deliverable by
  // construction, since nothing else is supposed to write there.
  const firstWrite = candidate.revisions[0]
  if (!firstWrite) return { scope, classification: 'artifact' }

  return { scope, classification: firstWrite.toolName === 'Write' ? 'artifact' : 'change' }
}

// ---------------------------------------------------------------------------
// Snapshot assembly
// ---------------------------------------------------------------------------

/** Recursively list real, non-hidden files under a directory. Missing dirs yield nothing. */
async function scanOutputDirectory(dirPath: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const files: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = nodePath.join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...await scanOutputDirectory(fullPath))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }
  return files
}

/** Last time this file changed, as far as the projection can tell. */
function sortKey(artifact: SessionArtifact): number {
  if (artifact.modifiedAt !== undefined) return artifact.modifiedAt
  const last = artifact.revisions[artifact.revisions.length - 1]
  return last?.timestamp ?? 0
}

export interface BuildSnapshotOptions {
  sessionId: string
  messages: Message[]
  context: ArtifactContext
}

/**
 * Build the artifact snapshot for one session.
 *
 * Reads directory metadata only — never file contents. Files that a tool wrote
 * but that have since been deleted stay in the list as `exists: false`; files
 * only ever seen by a directory scan simply disappear with the file.
 */
export async function buildSessionArtifactsSnapshot(
  options: BuildSnapshotOptions,
): Promise<SessionArtifactsSnapshot> {
  const { sessionId, messages, context } = options
  const path = context.path ?? nodePath

  const candidates = deriveToolCandidates(messages, context)

  const scanned = (
    await Promise.all(
      SESSION_OUTPUT_DIRS.map(dir => scanOutputDirectory(path.join(context.sessionFolderPath, dir))),
    )
  ).flat()
  mergeOutputScan(candidates, scanned, context)

  const artifacts: SessionArtifact[] = []
  const changes: SessionArtifact[] = []

  for (const candidate of candidates.values()) {
    const { scope, classification } = classifyCandidate(candidate, context)

    let exists = false
    let size: number | undefined
    let modifiedAt: number | undefined
    try {
      const stats = await stat(candidate.path)
      exists = stats.isFile()
      if (exists) {
        size = stats.size
        modifiedAt = stats.mtimeMs
      }
    } catch {
      exists = false
    }

    // A scan-only entry with no provenance and no file left is not a fact any more.
    if (!exists && !candidate.sources.includes('tool')) continue

    const artifact: SessionArtifact = {
      path: candidate.path,
      relativePath: toRelativePath(candidate.path, context),
      name: path.basename(candidate.path),
      kind: toArtifactKind(candidate.path, path),
      scope,
      classification,
      exists,
      ...(size !== undefined ? { size } : {}),
      ...(modifiedAt !== undefined ? { modifiedAt } : {}),
      sources: candidate.sources.includes('tool') && candidate.sources.includes('session-output')
        ? ['tool', 'session-output']
        : candidate.sources,
      revisions: candidate.revisions,
    }

    if (classification === 'artifact') artifacts.push(artifact)
    else changes.push(artifact)
  }

  const byRecency = (a: SessionArtifact, b: SessionArtifact) => sortKey(b) - sortKey(a)
  artifacts.sort(byRecency)
  changes.sort(byRecency)

  return { sessionId, artifacts, changes }
}
