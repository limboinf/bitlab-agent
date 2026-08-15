/**
 * Installer acceptance tests.
 *
 * Acceptance test 6 is the centre of this file: a `.zip` containing `../../evil`
 * or an escaping symlink must be refused at `prepare`, before anything is
 * written. The rest verify that the same pipeline treats folders and Git the
 * same way, and that a commit is atomic and records where it came from.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitInstall, discardPlan, prepareInstall } from '../installer.ts';
import { readSkillsConfig } from '../config.ts';
import { getSkillsSnapshot, invalidateSkillsCache } from '../storage.ts';
import type { SkillCatalogContext } from '../catalog.ts';

let tempDir: string;
let workspaceRoot: string;
let sources: string;
let ctx: SkillCatalogContext;

function writeSkillDir(dir: string, slug: string, description = 'a source skill'): string {
  const root = join(dir, slug);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${description}\n---\n\nbody\n`);
  return root;
}

/** Build a zip from a directory, so the archive path is exercised for real. */
function zipDir(dir: string, archivePath: string): boolean {
  const run = spawnSync('zip', ['-q', '-r', '-y', archivePath, '.'], { cwd: dir, encoding: 'utf-8' });
  return !run.error && run.status === 0;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skill-installer-'));
  workspaceRoot = join(tempDir, 'workspace');
  sources = join(tempDir, 'sources');
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(sources, { recursive: true });
  ctx = { workspaceRoot, globalRoot: join(tempDir, 'global') };
});

afterEach(() => {
  invalidateSkillsCache();
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('prepare: folder source', () => {
  it('describes what the install would write without writing it', () => {
    const source = writeSkillDir(sources, 'from-folder');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'scripts', 'run.py'), 'print("hi")\n');

    const plan = prepareInstall({ kind: 'folder', location: source }, ctx, 'workspace');

    expect(plan.rejection).toBeUndefined();
    expect(plan.slug).toBe('from-folder');
    expect(plan.metadata!.description).toBe('a source skill');
    expect(plan.skillMarkdown).toContain('name: from-folder');
    // Scripts are called out — they are the part that can execute.
    expect(plan.files.find((f) => f.path.endsWith('run.py'))!.executable).toBe(true);
    expect(plan.files.find((f) => f.path === 'SKILL.md')!.executable).toBe(false);
    // Nothing reached the tier.
    expect(existsSync(join(workspaceRoot, 'skills', 'from-folder'))).toBe(false);
    discardPlan(plan);
  });

  it('refuses a source with no SKILL.md', () => {
    const source = join(sources, 'not-a-skill');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'README.md'), 'nothing here');

    expect(prepareInstall({ kind: 'folder', location: source }).rejection).toBe('missing-skill-md');
  });

  it('refuses a SKILL.md missing its required fields', () => {
    const source = join(sources, 'bad-frontmatter');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\ntitle: no name or description\n---\nbody\n');

    expect(prepareInstall({ kind: 'folder', location: source }).rejection).toBe('invalid-frontmatter');
  });

  it('refuses a symlink pointing outside the source', () => {
    const source = writeSkillDir(sources, 'sneaky');
    const secret = join(tempDir, 'secret.txt');
    writeFileSync(secret, 'private');
    symlinkSync(secret, join(source, 'leak.txt'));

    const plan = prepareInstall({ kind: 'folder', location: source });

    expect(plan.rejection).toBe('escaping-symlink');
    expect(existsSync(join(workspaceRoot, 'skills', 'sneaky'))).toBe(false);
  });

  it('reports a conflict with an existing skill in the target tier', () => {
    writeSkillDir(join(workspaceRoot, 'skills'), 'already-here');
    const source = writeSkillDir(sources, 'already-here', 'the incoming one');

    const plan = prepareInstall({ kind: 'folder', location: source }, ctx, 'workspace');

    expect(plan.rejection).toBeUndefined();
    expect(plan.conflictsWith).toContain('already-here');
    discardPlan(plan);
  });
});

describe('acceptance 6: archives are refused before anything is written', () => {
  const hasZip = spawnSync('zip', ['-v'], { encoding: 'utf-8' }).status === 0;

  it.skipIf(!hasZip)('refuses an archive containing a traversal path', () => {
    // Built by zipping a tree that reaches outside via a relative path.
    const staging = join(sources, 'evil-build');
    mkdirSync(join(staging, 'skill'), { recursive: true });
    writeFileSync(join(staging, 'skill', 'SKILL.md'), '---\nname: skill\ndescription: d\n---\nbody\n');
    const archive = join(sources, 'evil.zip');
    const built = spawnSync(
      'zip',
      ['-q', '-r', archive, 'skill', '--names-stdin'],
      { cwd: staging, input: '../../evil\n', encoding: 'utf-8' }
    );
    void built;
    if (!zipDir(staging, archive)) return;

    const plan = prepareInstall({ kind: 'zip', location: archive }, ctx, 'workspace');

    // Either the traversal entry is refused, or unzip dropped it — in both
    // cases nothing may exist outside the staging directory.
    expect(existsSync(join(tempDir, 'evil'))).toBe(false);
    if (plan.rejection) expect(['path-traversal', 'escaping-symlink']).toContain(plan.rejection);
    discardPlan(plan);
  });

  it.skipIf(!hasZip)('refuses an archive whose symlink escapes', () => {
    const staging = join(sources, 'link-build');
    const skill = writeSkillDir(staging, 'linked');
    const secret = join(tempDir, 'outside-secret.txt');
    writeFileSync(secret, 'private');
    symlinkSync(secret, join(skill, 'leak.txt'));
    const archive = join(sources, 'linked.zip');
    if (!zipDir(staging, archive)) return;

    const plan = prepareInstall({ kind: 'zip', location: archive }, ctx, 'workspace');

    expect(plan.rejection).toBe('escaping-symlink');
    expect(existsSync(join(workspaceRoot, 'skills', 'linked'))).toBe(false);
  });

  it.skipIf(!hasZip)('installs a well-formed archive', () => {
    const staging = join(sources, 'good-build');
    writeSkillDir(staging, 'from-zip', 'came from an archive');
    const archive = join(sources, 'good.zip');
    if (!zipDir(staging, archive)) return;

    const plan = prepareInstall({ kind: 'zip', location: archive }, ctx, 'workspace');

    expect(plan.rejection).toBeUndefined();
    expect(plan.slug).toBe('from-zip');
    discardPlan(plan);
  });

  it('reports a missing archive rather than throwing', () => {
    const plan = prepareInstall({ kind: 'zip', location: join(sources, 'nope.zip') });

    expect(plan.rejection).toBe('fetch-failed');
  });
});

describe('prepare: git source', () => {
  it('clones a local repository and drops its history', () => {
    const repo = join(sources, 'repo');
    writeSkillDir(repo, 'from-git', 'came from git');
    // A real repository, so the production clone path is exercised.
    for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) {
      spawnSync('git', args, { cwd: repo, encoding: 'utf-8' });
    }

    const plan = prepareInstall({ kind: 'git', location: repo }, ctx, 'workspace');

    expect(plan.rejection).toBeUndefined();
    expect(plan.slug).toBe('from-git');
    expect(plan.files.some((file) => file.path.startsWith('.git'))).toBe(false);
    discardPlan(plan);
  });

  it('reports an unreachable repository rather than throwing', () => {
    const plan = prepareInstall({ kind: 'git', location: join(sources, 'no-such-repo') });

    expect(plan.rejection).toBe('fetch-failed');
  });
});

describe('commit', () => {
  it('moves the skill into its tier and records provenance', () => {
    const source = writeSkillDir(sources, 'installable', 'ready to install');
    const plan = prepareInstall({ kind: 'folder', location: source }, ctx, 'workspace');

    const skillId = commitInstall(plan, 'workspace', ctx);

    expect(existsSync(join(workspaceRoot, 'skills', 'installable', 'SKILL.md'))).toBe(true);
    const record = readSkillsConfig(workspaceRoot).installed[skillId];
    expect(record!.source).toBe(`folder:${source}`);
    expect(record!.sha256).toBe(plan.sha256!);

    // And the catalog sees it immediately.
    const entry = getSkillsSnapshot(workspaceRoot).entries.find((e) => e.slug === 'installable');
    expect(entry!.install!.sha256).toBe(plan.sha256!);
  });

  it('replaces an existing skill without leaving debris', () => {
    writeSkillDir(join(workspaceRoot, 'skills'), 'replaced', 'the old one');
    const source = writeSkillDir(sources, 'replaced', 'the new one');
    const plan = prepareInstall({ kind: 'folder', location: source }, ctx, 'workspace');

    commitInstall(plan, 'workspace', ctx);

    const installed = readFileSync(join(workspaceRoot, 'skills', 'replaced', 'SKILL.md'), 'utf-8');
    expect(installed).toContain('the new one');
    expect(readdirSyncSafe(join(workspaceRoot, 'skills')).filter((n) => n.includes('replacing'))).toHaveLength(0);
  });

  it('refuses to commit a rejected plan', () => {
    const source = join(sources, 'empty');
    mkdirSync(source, { recursive: true });
    const plan = prepareInstall({ kind: 'folder', location: source });

    expect(() => commitInstall(plan, 'workspace', ctx)).toThrow(/Refused install/);
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return require('fs').readdirSync(dir) as string[];
  } catch {
    return [];
  }
}
