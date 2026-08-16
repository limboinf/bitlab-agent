/**
 * Bridge acceptance tests.
 *
 * Covers the numbered criteria from docs/skills-design.md that the bridge owns:
 * the catalog must be identical with MCP on and off (3), a missing `read` tool
 * must fail loudly instead of shipping a promptless catalog (8), and the loader
 * seams must still apply when MCP is disabled (9).
 *
 * These drive the real `BitlabResourceLoader` against the pinned SDK rather
 * than a stub, because what is being verified is precisely that the SDK honours
 * the seams.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { SkillCatalog, makeSkillId, setProjectTrust } from '@bitlab/shared/skills';
import { BitlabResourceLoader } from './resource-loader.ts';
import { PiSkillBridge } from './skill-bridge.ts';

// Not re-exported from the package root (its exports map only exposes "." and
// "./rpc-entry"), so load the module `_rebuildSystemPrompt` uses internally
// straight from the workspace's installed copy.
const { buildSystemPrompt } = (await import(
  pathToFileURL(
    join(
      import.meta.dir,
      '../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js'
    )
  ).href
)) as { buildSystemPrompt: (options: Record<string, unknown>) => string };

const BASE_PROMPT = 'BITLAB_BASE_PROMPT';

let tempDir: string;
let workspaceRoot: string;
let projectRoot: string;
let agentDir: string;
let globalRoot: string;

function writeSkill(skillsDir: string, slug: string, description: string): string {
  mkdirSync(join(skillsDir, slug), { recursive: true });
  const filePath = join(skillsDir, slug, 'SKILL.md');
  writeFileSync(filePath, `---\nname: ${slug}\ndescription: ${description}\n---\n\nbody\n`);
  return filePath;
}

function makeBridge(): PiSkillBridge {
  const catalog = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot });
  return new PiSkillBridge({
    getSnapshot: () => catalog.snapshot(),
    getBasePrompt: () => BASE_PROMPT,
  });
}

async function makeLoader(bridge: PiSkillBridge): Promise<BitlabResourceLoader> {
  const loader = new BitlabResourceLoader({
    cwd: projectRoot,
    agentDir,
    skillSeams: bridge.seams(),
  });
  await loader.reload();
  return loader;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skill-bridge-'));
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');
  agentDir = join(tempDir, 'agent');
  globalRoot = join(tempDir, 'global');
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(join(projectRoot, '.agents', 'skills'), { recursive: true });
  // Pi's own scan location — the canary that must never reach the model.
  mkdirSync(join(projectRoot, '.pi', 'skills'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(globalRoot, { recursive: true });
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

describe('acceptance 9: the seams apply without MCP', () => {
  it('hands the catalog to the session through the loader', async () => {
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    const loader = await makeLoader(makeBridge());

    expect(loader.getSkills().skills.map((skill) => skill.name)).toEqual(['alpha']);
    expect(loader.getSystemPrompt()).toBe(BASE_PROMPT);
  });

  it('suppresses Pi\'s own scan of .pi/skills', async () => {
    writeSkill(join(projectRoot, '.pi', 'skills'), 'leak', 'must never appear');
    const loader = await makeLoader(makeBridge());

    expect(loader.getSkills().skills.map((skill) => skill.name)).not.toContain('leak');
  });

  it('keeps Bitlab precedence rather than Pi\'s first-wins', async () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    writeSkill(join(workspaceRoot, 'skills'), 'deploy', 'workspace copy');
    writeSkill(join(projectRoot, '.agents', 'skills'), 'deploy', 'project copy');

    const loader = await makeLoader(makeBridge());
    const skills = loader.getSkills().skills;

    expect(skills).toHaveLength(1);
    expect(skills[0]!.description).toBe('project copy');
  });

  it('assembles a prompt carrying both the base prompt and the catalog', async () => {
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    const loader = await makeLoader(makeBridge());

    const prompt = buildSystemPrompt({
      customPrompt: loader.getSystemPrompt(),
      selectedTools: ['read', 'bash'],
      cwd: projectRoot,
      skills: loader.getSkills().skills,
    });

    expect(prompt).toContain(BASE_PROMPT);
    expect(prompt).toContain('<available_skills>');
    expect(prompt).toContain('workspace alpha');
  });
});

describe('acceptance 3: identical catalog with MCP on and off', () => {
  it('produces the same skills either way', async () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    writeSkill(join(projectRoot, '.agents', 'skills'), 'beta', 'project beta');

    const withoutMcp = await makeLoader(makeBridge());
    // The MCP path differs only in the inline extensions it adds to the loader.
    const withMcp = new BitlabResourceLoader({
      cwd: projectRoot,
      agentDir,
      skillSeams: makeBridge().seams(),
      adapterExtension: { name: 'noop-adapter', factory: () => ({}) } as never,
      hostExtension: { name: 'noop-host', factory: () => ({}) } as never,
    });
    await withMcp.reload();

    const shape = (loader: BitlabResourceLoader) =>
      loader.getSkills().skills.map((skill) => `${skill.name}:${skill.description}:${skill.filePath}`);

    expect(shape(withMcp)).toEqual(shape(withoutMcp));
  });
});

describe('acceptance 8: the read-tool gate', () => {
  it('fails loudly when `read` is absent', () => {
    expect(() => makeBridge().assertCatalogVisible(['bash', 'edit'])).toThrow(
      /Skill catalog would be dropped/
    );
  });

  it('passes when `read` is active', () => {
    expect(() => makeBridge().assertCatalogVisible(['read', 'bash'])).not.toThrow();
  });

  it('is guarding something real: Pi drops the catalog silently without `read`', async () => {
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    const loader = await makeLoader(makeBridge());

    const prompt = buildSystemPrompt({
      customPrompt: loader.getSystemPrompt(),
      selectedTools: ['bash'],
      cwd: projectRoot,
      skills: loader.getSkills().skills,
    });

    // No error, no warning — the block simply is not there.
    expect(prompt).not.toContain('<available_skills>');
    expect(prompt).toContain(BASE_PROMPT);
  });
});

describe('name collisions across directories', () => {
  it('keeps one skill per frontmatter name and reports the loser', async () => {
    setProjectTrust(workspaceRoot, projectRoot, true);
    // Different directories, same declared name — Pi would silently keep one.
    mkdirSync(join(workspaceRoot, 'skills', 'first'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'skills', 'first', 'SKILL.md'),
      '---\nname: shared\ndescription: first\n---\nbody\n'
    );
    mkdirSync(join(workspaceRoot, 'skills', 'second'), { recursive: true });
    writeFileSync(
      join(workspaceRoot, 'skills', 'second', 'SKILL.md'),
      '---\nname: shared\ndescription: second\n---\nbody\n'
    );

    const messages: string[] = [];
    const catalog = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot });
    const bridge = new PiSkillBridge({
      getSnapshot: () => catalog.snapshot(),
      getBasePrompt: () => BASE_PROMPT,
      debugLog: (message) => messages.push(message),
    });
    const loader = await makeLoader(bridge);

    expect(loader.getSkills().skills.filter((skill) => skill.name === 'shared')).toHaveLength(1);
    expect(messages.join('\n')).toContain('Skill name collision');
  });
});

describe('revision stamping', () => {
  it('records the catalog revision the session actually ran against', async () => {
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    const catalog = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot });
    const bridge = new PiSkillBridge({
      getSnapshot: () => catalog.snapshot(),
      getBasePrompt: () => BASE_PROMPT,
    });
    const loader = await makeLoader(bridge);

    // Stamped when Pi reads the catalog, not when the loader is built — what
    // matters is the revision that reached the prompt.
    expect(bridge.revision).toBeNull();
    loader.getSkills();

    expect(bridge.revision).toBe(catalog.snapshot().revision);
  });
});

describe('acceptance 5: the UI and the live session stay on one revision', () => {
  it('serves an edited skill without reloading the loader', async () => {
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'first description');
    const catalog = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot });
    const bridge = new PiSkillBridge({
      getSnapshot: () => catalog.snapshot(),
      getBasePrompt: () => BASE_PROMPT,
    });
    const loader = await makeLoader(bridge);
    expect(loader.getSkills().skills[0]!.description).toBe('first description');
    const before = catalog.snapshot().revision;

    // What the watcher does when a SKILL.md changes on disk.
    writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'second description');
    catalog.invalidate();

    // No loader.reload(): rebuilding the prompt is enough for the runtime to
    // see the edit, and both sides report the same revision.
    const uiRevision = catalog.snapshot().revision;
    expect(loader.getSkills().skills[0]!.description).toBe('second description');
    expect(bridge.revision).toBe(uiRevision);
    expect(uiRevision).not.toBe(before);
  });

  it('drops a skill from the runtime as soon as it is disabled', async () => {
    const file = writeSkill(join(workspaceRoot, 'skills'), 'alpha', 'workspace alpha');
    const catalog = new SkillCatalog({ workspaceRoot, projectRoot, globalRoot });
    const bridge = new PiSkillBridge({
      getSnapshot: () => catalog.snapshot(),
      getBasePrompt: () => BASE_PROMPT,
    });
    const loader = await makeLoader(bridge);
    expect(loader.getSkills().skills).toHaveLength(1);

    catalog.setEnabled(makeSkillId('workspace', file), false);

    expect(loader.getSkills().skills).toHaveLength(0);
    expect(bridge.revision).toBe(catalog.snapshot().revision);
  });
});
