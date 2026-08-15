/**
 * SkillInstaller — every way a skill can arrive, through one door.
 *
 * Folder, archive, and Git share every hazard: a path that climbs out of its
 * destination, a symlink pointing somewhere else, an archive that expands
 * without bound, a SKILL.md that is not one. So they share one pipeline —
 * fetch into isolated staging, validate, and only then let the user decide
 * (docs/skills-design.md §5.9, §7.1).
 *
 * Nothing reaches a tier until `commit`. A skill is executable instruction
 * text; showing it before it lands on disk is the whole security story.
 */

import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, relative, resolve, sep } from 'path';
import {
  isContainedIn,
  makeSkillId,
  parseSkillFrontmatter,
  tierRoot,
  type SkillCatalogContext,
} from './catalog.ts';
import { updateSkillsConfig } from './config.ts';
import { invalidateSkillsCache } from './storage.ts';
import type {
  InstallFile,
  InstallPlan,
  InstallSource,
  SkillDiagnostic,
  SkillId,
  SkillSource,
} from './types.ts';

/**
 * Bounds on what may be staged. Generous for a skill, small enough that an
 * archive bomb is refused rather than unpacked.
 */
const MAX_FILES = 500;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 8;

/** Extensions treated as executable when listing what an install would write. */
const SCRIPT_EXTENSIONS = ['.sh', '.bash', '.zsh', '.py', '.rb', '.pl', '.js', '.mjs', '.ts'];

function isScript(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return SCRIPT_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function stagingRoot(): string {
  return mkdtempSync(join(tmpdir(), 'bitlab-skill-install-'));
}

/**
 * Walk a staged tree, refusing anything that escapes it.
 *
 * The checks run against the staging directory rather than the destination, so
 * a hostile entry is refused while it is still in a temp directory nobody
 * reads from.
 */
function collectFiles(
  root: string,
  dir: string,
  depth: number,
  files: InstallFile[]
): InstallPlan['rejection'] | undefined {
  if (depth > MAX_DEPTH) return 'too-deep';

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);

    // lstat, not stat: a symlink must be judged by where it points, not by
    // what it points at.
    const link = lstatSync(absolute);
    if (link.isSymbolicLink()) {
      // readlinkSync returns the link's target; readFileSync would follow it
      // and hand back the contents of whatever it points at.
      const target = resolve(dirname(absolute), readlinkSync(absolute));
      if (!isContainedIn(target, root)) return 'escaping-symlink';
      continue;
    }

    const relativePath = relative(root, absolute);
    if (relativePath.startsWith('..') || relativePath.includes(`..${sep}`)) return 'path-traversal';

    if (entry.isDirectory()) {
      const rejection = collectFiles(root, absolute, depth + 1, files);
      if (rejection) return rejection;
      continue;
    }

    if (files.length >= MAX_FILES) return 'too-many-files';
    files.push({
      path: relativePath,
      bytes: statSync(absolute).size,
      executable: isScript(relativePath),
    });
  }
  return undefined;
}

/**
 * Find the skill root inside a staged tree. An archive or repository commonly
 * wraps the skill in one directory, so a single wrapping level is unwrapped;
 * anything deeper is the author's structure and left alone.
 */
function findSkillRoot(staged: string): string | undefined {
  if (existsSync(join(staged, 'SKILL.md'))) return staged;
  const entries = readdirSync(staged, { withFileTypes: true }).filter(
    (entry) => !entry.name.startsWith('.')
  );
  if (entries.length === 1 && entries[0]!.isDirectory()) {
    const nested = join(staged, entries[0]!.name);
    if (existsSync(join(nested, 'SKILL.md'))) return nested;
  }
  return undefined;
}

function sha256Of(files: InstallFile[], root: string): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(readFileSync(join(root, file.path)));
  }
  return hash.digest('hex');
}

// ── Fetching ────────────────────────────────────────────────────────────────

function fetchFolder(source: InstallSource, staged: string): SkillDiagnostic[] {
  if (!existsSync(source.location) || !statSync(source.location).isDirectory()) {
    return [{ level: 'error', code: 'fetch-failed', message: `Not a directory: ${source.location}` }];
  }
  // Symlinks are copied as links so the containment walk can judge them, rather
  // than silently dereferenced into the staging directory.
  cpSync(source.location, staged, { recursive: true, verbatimSymlinks: true });
  return [];
}

function fetchZip(source: InstallSource, staged: string): SkillDiagnostic[] {
  if (!existsSync(source.location)) {
    return [{ level: 'error', code: 'fetch-failed', message: `No such archive: ${source.location}` }];
  }
  // `unzip` is present on macOS and Linux. Extraction is bounded by the checks
  // that run afterwards, and staging is a temp directory either way.
  const run = spawnSync('unzip', ['-q', '-o', source.location, '-d', staged], { encoding: 'utf-8' });
  if (run.error || run.status !== 0) {
    return [
      {
        level: 'error',
        code: 'fetch-failed',
        message: run.error?.message ?? run.stderr?.trim() ?? 'unzip failed',
      },
    ];
  }
  return [];
}

function fetchGit(source: InstallSource, staged: string): SkillDiagnostic[] {
  const args = ['clone', '--depth', '1', '--quiet'];
  if (source.ref) args.push('--branch', source.ref);
  args.push(source.location, staged);
  const run = spawnSync('git', args, { encoding: 'utf-8' });
  if (run.error || run.status !== 0) {
    return [
      {
        level: 'error',
        code: 'fetch-failed',
        message: run.error?.message ?? run.stderr?.trim() ?? 'git clone failed',
      },
    ];
  }
  // The history is not part of the skill and would dominate the file count.
  rmSync(join(staged, '.git'), { recursive: true, force: true });
  return [];
}

const FETCHERS: Record<InstallSource['kind'], (source: InstallSource, staged: string) => SkillDiagnostic[]> = {
  folder: fetchFolder,
  zip: fetchZip,
  git: fetchGit,
};

// ── Prepare / commit ────────────────────────────────────────────────────────

function rejected(
  stagingRoot: string,
  source: InstallSource,
  rejection: InstallPlan['rejection'],
  diagnostics: SkillDiagnostic[]
): InstallPlan {
  return {
    stagingRoot,
    stagingDir: stagingRoot,
    source,
    slug: '',
    files: [],
    totalBytes: 0,
    diagnostics,
    rejection,
  };
}

/**
 * Fetch a source into isolated staging and describe what installing it would
 * do. Never writes to a tier.
 */
export function prepareInstall(source: InstallSource, ctx?: SkillCatalogContext, targetTier?: SkillSource): InstallPlan {
  const stagingDir = stagingRoot();
  const fetchDiagnostics = FETCHERS[source.kind](source, stagingDir);
  if (fetchDiagnostics.length) return rejected(stagingDir, source, 'fetch-failed', fetchDiagnostics);

  const skillRoot = findSkillRoot(stagingDir);
  if (!skillRoot) {
    return rejected(stagingDir, source, 'missing-skill-md', [
      { level: 'error', code: 'missing-skill-md', message: 'No SKILL.md found in the source.' },
    ]);
  }

  const files: InstallFile[] = [];
  const rejection = collectFiles(skillRoot, skillRoot, 1, files);
  if (rejection) {
    return rejected(stagingDir, source, rejection, [
      { level: 'error', code: rejection, message: `Refused: ${rejection.replace(/-/g, ' ')}.` },
    ]);
  }

  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return rejected(stagingDir, source, 'too-large', [
      { level: 'error', code: 'too-large', message: `Source exceeds ${MAX_TOTAL_BYTES} bytes.` },
    ]);
  }

  const skillMarkdown = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const slug = basename(skillRoot);
  const parsed = parseSkillFrontmatter(skillMarkdown, join(skillRoot, 'SKILL.md'), slug);
  if (!parsed) {
    return rejected(stagingDir, source, 'invalid-frontmatter', [
      {
        level: 'error',
        code: 'invalid-frontmatter',
        message: 'SKILL.md is missing a name or description.',
      },
    ]);
  }

  const plan: InstallPlan = {
    stagingRoot: stagingDir,
    stagingDir: skillRoot,
    source,
    slug: parsed.metadata.name || slug,
    metadata: parsed.metadata,
    skillMarkdown,
    files,
    totalBytes,
    diagnostics: parsed.diagnostics,
    sha256: sha256Of(files, skillRoot),
  };

  // Surfaced before the write, so overwriting is a decision rather than a
  // discovery.
  if (ctx && targetTier) {
    const root = tierRoot(targetTier, ctx);
    if (root && existsSync(join(root, plan.slug, 'SKILL.md'))) {
      plan.conflictsWith = makeSkillId(targetTier, join(root, plan.slug, 'SKILL.md'));
    }
  }
  return plan;
}

/**
 * Move a prepared install into its tier and record where it came from.
 *
 * Provenance is written to `skills.json`, never back into the SKILL.md — doing
 * so would invalidate the very hash used to verify it (§5.4).
 */
export function commitInstall(
  plan: InstallPlan,
  target: SkillSource,
  ctx: SkillCatalogContext
): SkillId {
  if (plan.rejection) throw new Error(`Refused install: ${plan.rejection}`);

  const root = tierRoot(target, ctx);
  if (!root) throw new Error(`No ${target} skills directory in this context`);

  const destination = join(root, plan.slug);
  if (!isContainedIn(destination, root)) {
    throw new Error(`Install destination escapes the ${target} directory: ${plan.slug}`);
  }

  mkdirSync(root, { recursive: true });
  const previous = existsSync(destination) ? `${destination}.replacing-${process.pid}` : undefined;
  if (previous) renameSync(destination, previous);

  try {
    // Rename where possible; staging may sit on another filesystem, in which
    // case a copy is the only option.
    try {
      renameSync(plan.stagingDir, destination);
    } catch {
      cpSync(plan.stagingDir, destination, { recursive: true, verbatimSymlinks: true });
    }
  } catch (error) {
    if (previous) renameSync(previous, destination);
    throw error;
  }
  if (previous) rmSync(previous, { recursive: true, force: true });

  const skillId = makeSkillId(target, join(destination, 'SKILL.md'));
  updateSkillsConfig(ctx.workspaceRoot, (config) => ({
    ...config,
    installed: {
      ...config.installed,
      [skillId]: {
        source: `${plan.source.kind}:${plan.source.location}${plan.source.ref ? `@${plan.source.ref}` : ''}`,
        installedAt: new Date().toISOString(),
        sha256: plan.sha256,
      },
    },
  }));
  invalidateSkillsCache();
  return skillId;
}

/** Drop a staging directory. Safe to call on an already-committed plan. */
export function discardPlan(plan: InstallPlan): void {
  rmSync(plan.stagingRoot, { recursive: true, force: true });
}
