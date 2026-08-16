/**
 * Catalog acceptance tests.
 *
 * These are the numbered acceptance criteria from docs/skills-design.md that
 * the catalog owns: precedence and shadowing, enablement fallthrough, the
 * project trust gate, path containment, MCP dependency resolution, and
 * concurrent writes to skills.json.
 *
 * Every tier — the global one included — is pointed at a temp directory, so no
 * assertion depends on what happens to be installed on the machine.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { setBundledAssetsRoot } from '../../utils/paths.ts';
import { SkillCatalog, makeSkillId, resolveSkillId, winnersOf } from '../catalog.ts';
import { deleteSkillById, getSkillCatalog, getSkillsSnapshot, invalidateSkillsCache } from '../storage.ts';
import { readSkillsConfig, setProjectTrust, setSkillEnabled } from '../config.ts';
import type { CatalogSnapshot } from '../types.ts';

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;
let globalDir: string;

const SLUG = 'acceptance-deploy';

function writeSkill(skillsDir: string, slug: string, description: string, extra = ''): string {
  const dir = join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${description}\n${extra}---\n\nbody\n`);
  return join(dir, 'SKILL.md');
}

function catalog(): SkillCatalog {
  return new SkillCatalog({ workspaceRoot, projectRoot, globalRoot: globalDir });
}

/** Entries for the slug under test. */
function ours(snapshot: CatalogSnapshot, slug = SLUG) {
  return snapshot.entries.filter((entry) => entry.slug === slug);
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-acceptance-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');
  globalDir = join(tempDir, 'global');
  // The built-in tier resolves from bundled assets, which must not depend on
  // where the test runner happens to be started from.
  setBundledAssetsRoot(join(tempDir, 'no-bundled-assets'));
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(join(projectRoot, '.agents', 'skills'), { recursive: true });
  mkdirSync(globalDir, { recursive: true });
});

afterEach(() => {
  invalidateSkillsCache();
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('acceptance 1: precedence and shadowing', () => {
  it('lets the project copy win and keeps the others as shadows', () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    const snapshot = catalog().snapshot();
    const entries = ours(snapshot);

    expect(entries).toHaveLength(2);
    const winner = entries.find((entry) => entry.winner);
    expect(winner!.source).toBe('project');

    // The shadowed copy is retained — it is what the per-tier UI listing and
    // the conflict warning are drawn from.
    const shadowed = entries.find((entry) => !entry.winner)!;
    expect(shadowed.source).toBe('workspace');
    expect(shadowed.shadowedBy).toBe(winner!.skillId);
  });
});

describe('acceptance 2: enablement fallthrough', () => {
  it('promotes the workspace copy when the winner is disabled', () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    const projectFile = writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    setSkillEnabled(workspaceRoot, makeSkillId('project', projectFile), false);

    const entries = ours(catalog().snapshot());
    const winner = entries.find((entry) => entry.winner);

    expect(winner!.source).toBe('workspace');
    expect(entries.find((entry) => entry.source === 'project')!.enabled).toBe(false);
  });

  it('removes the name from the runtime when every copy is disabled', () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    const workspaceFile = writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    const projectFile = writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    setSkillEnabled(workspaceRoot, makeSkillId('project', projectFile), false);
    setSkillEnabled(workspaceRoot, makeSkillId('workspace', workspaceFile), false);

    const snapshot = catalog().snapshot();

    expect(winnersOf(snapshot).filter((entry) => entry.slug === SLUG)).toHaveLength(0);
    // Still listed, so the UI can show them as off rather than losing them.
    expect(ours(snapshot)).toHaveLength(2);
  });
});

describe('acceptance 4: project trust gate', () => {
  it('contributes zero winners while untrusted, but still lists the skills', () => {
    writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    const snapshot = catalog().snapshot();
    const entries = ours(snapshot);

    expect(entries).toHaveLength(1);
    expect(entries[0]!.trust).toBe('untrusted');
    expect(entries[0]!.winner).toBe(false);
    expect(winnersOf(snapshot).filter((entry) => entry.slug === SLUG)).toHaveLength(0);
  });

  it('does not let an untrusted project skill shadow the workspace copy', () => {
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    const winner = ours(catalog().snapshot()).find((entry) => entry.winner);

    expect(winner!.source).toBe('workspace');
  });

  it('promotes the project copy once trust is granted', () => {
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    writeSkill(join(projectRoot, '.agents', 'skills'), SLUG, 'project copy');

    const before = ours(catalog().snapshot()).find((entry) => entry.winner)!.source;
    setProjectTrust(workspaceRoot, projectRoot, true);
    const after = ours(catalog().snapshot()).find((entry) => entry.winner)!.source;

    expect(before).toBe('workspace');
    expect(after).toBe('project');
  });
});

describe('acceptance 7: path containment', () => {
  it('refuses a skillId whose path escapes its tier root', () => {
    const outside = join(tempDir, 'outside', 'evil', 'SKILL.md');
    mkdirSync(join(tempDir, 'outside', 'evil'), { recursive: true });
    writeFileSync(outside, '---\nname: evil\ndescription: nope\n---\n');

    expect(() => resolveSkillId(`workspace:${outside}`, { workspaceRoot, projectRoot })).toThrow(
      /escapes its workspace directory/
    );
  });

  it('refuses a traversal expressed with ..', () => {
    const traversal = join(workspaceRoot, 'skills', '..', '..', 'SKILL.md');

    expect(() => resolveSkillId(`workspace:${traversal}`, { workspaceRoot, projectRoot })).toThrow(
      /escapes its workspace directory/
    );
  });

  it('refuses a malformed skillId', () => {
    expect(() => resolveSkillId('not-an-id', { workspaceRoot, projectRoot })).toThrow(/Malformed skill id/);
  });

  it('accepts a legitimate skillId and returns canonical paths', () => {
    const file = writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');

    const resolved = resolveSkillId(makeSkillId('workspace', file), { workspaceRoot, projectRoot });

    expect(resolved.source).toBe('workspace');
    expect(existsSync(resolved.filePath)).toBe(true);
  });

  it('skips a skill directory symlinked outside its tier root', () => {
    const outsideSkill = join(tempDir, 'outside', 'sneaky');
    mkdirSync(outsideSkill, { recursive: true });
    writeFileSync(join(outsideSkill, 'SKILL.md'), '---\nname: sneaky\ndescription: from outside\n---\n');
    symlinkSync(outsideSkill, join(workspaceRoot, 'skills', 'sneaky'));

    const snapshot = catalog().snapshot();

    expect(snapshot.entries.filter((entry) => entry.slug === 'sneaky')).toHaveLength(0);
  });
});

describe('acceptance 12: MCP dependencies', () => {
  it('reports an unconfigured server as missing', () => {
    writeSkill(
      join(workspaceRoot, 'skills'),
      SLUG,
      'needs a server',
      'metadata:\n  bitlab.requiresMcp: "definitely-not-configured"\n'
    );

    const entry = ours(catalog().snapshot())[0]!;

    expect(entry.mcpRequirements).toEqual([{ server: 'definitely-not-configured', state: 'missing' }]);
  });

  it('leaves requirements undefined when none are declared', () => {
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'no dependencies');

    expect(ours(catalog().snapshot())[0]!.mcpRequirements).toBeUndefined();
  });
});

describe('acceptance 13: concurrent skills.json writes', () => {
  it('does not lose either write when two processes toggle different skills', async () => {
    const first = makeSkillId('workspace', join(workspaceRoot, 'skills', 'first', 'SKILL.md'));
    const second = makeSkillId('workspace', join(workspaceRoot, 'skills', 'second', 'SKILL.md'));

    // Real processes, because the failure being guarded against is two windows
    // reading the same state before either writes.
    const writer = (skillId: string) =>
      Bun.spawn([
        'bun',
        '-e',
        `import { setSkillEnabled } from ${JSON.stringify(join(import.meta.dir, '..', 'config.ts'))};
         setSkillEnabled(${JSON.stringify(workspaceRoot)}, ${JSON.stringify(skillId)}, false);`,
      ]);

    const [a, b] = [writer(first), writer(second)];
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);

    const disabled = readSkillsConfig(workspaceRoot).disabled;
    expect(disabled).toContain(first);
    expect(disabled).toContain(second);
    // Spawning two real runtimes is slow on a loaded machine; the generous
    // timeout keeps a busy CI from reading that as a lost write.
  }, 30_000);
});

describe('the shared catalog instance', () => {
  // The regression this guards: a mutation applied through a throwaway
  // SkillCatalog invalidates only that instance, so every reader keeps serving
  // the pre-change snapshot until the cache TTL expires — the UI shows nothing
  // happening while the write has in fact landed on disk.
  it('reflects a mutation in the very next read', () => {
    const file = writeSkill(join(workspaceRoot, 'skills'), SLUG, 'workspace copy');
    const skillId = makeSkillId('workspace', file);
    const shared = getSkillCatalog(workspaceRoot, projectRoot);
    expect(shared.snapshot().entries.find((e) => e.skillId === skillId)!.enabled).toBe(true);

    shared.setEnabled(skillId, false);

    expect(getSkillsSnapshot(workspaceRoot, projectRoot).entries.find((e) => e.skillId === skillId)!.enabled).toBe(
      false
    );
  });

  it('hands every caller the same instance for one context', () => {
    expect(getSkillCatalog(workspaceRoot, projectRoot)).toBe(getSkillCatalog(workspaceRoot, projectRoot));
  });
});

describe('revision', () => {
  it('is stable across re-reads and changes when a skill changes', () => {
    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'first description');

    const first = catalog().snapshot().revision;
    expect(catalog().snapshot().revision).toBe(first);

    writeSkill(join(workspaceRoot, 'skills'), SLUG, 'second description');
    expect(catalog().snapshot().revision).not.toBe(first);
  });

  it('changes when a skill is disabled', () => {
    const file = writeSkill(join(workspaceRoot, 'skills'), SLUG, 'a description');
    const before = catalog().snapshot().revision;

    setSkillEnabled(workspaceRoot, makeSkillId('workspace', file), false);

    expect(catalog().snapshot().revision).not.toBe(before);
  });
});

describe('built-in tier', () => {
  it('refuses to delete a built-in skill', () => {
    const builtinRoot = join(tempDir, 'builtin');
    mkdirSync(join(builtinRoot, 'shipped'), { recursive: true });
    writeFileSync(
      join(builtinRoot, 'shipped', 'SKILL.md'),
      '---\nname: shipped\ndescription: ships with the app\n---\nbody\n'
    );
    const builtinCtx = { workspaceRoot, projectRoot, globalRoot: globalDir, builtinRoot };
    const skillId = makeSkillId('builtin', join(builtinRoot, 'shipped', 'SKILL.md'));

    // It loads like any other skill...
    const entry = new SkillCatalog(builtinCtx).snapshot().entries.find((e) => e.slug === 'shipped');
    expect(entry!.source).toBe('builtin');

    // ...but the file belongs to the installation.
    expect(() => deleteSkillById(skillId, builtinCtx)).toThrow(/cannot be deleted/);
    expect(existsSync(join(builtinRoot, 'shipped', 'SKILL.md'))).toBe(true);
  });

  it('lets a workspace skill shadow a built-in one', () => {
    const builtinRoot = join(tempDir, 'builtin2');
    mkdirSync(join(builtinRoot, 'overridable'), { recursive: true });
    writeFileSync(
      join(builtinRoot, 'overridable', 'SKILL.md'),
      '---\nname: overridable\ndescription: the shipped version\n---\nbody\n'
    );
    writeSkill(join(workspaceRoot, 'skills'), 'overridable', 'the user version');

    const entries = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot: globalDir, builtinRoot })
      .snapshot()
      .entries.filter((e) => e.slug === 'overridable');

    expect(entries.find((e) => e.winner)!.source).toBe('workspace');
    expect(entries.find((e) => e.source === 'builtin')!.shadowedBy).toBeDefined();
  });
});
