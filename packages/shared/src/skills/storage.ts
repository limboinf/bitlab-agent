/**
 * Skills Storage
 *
 * Filesystem operations and the slug-oriented helpers the rest of the app
 * calls. Discovery, precedence, and validation all belong to `SkillCatalog` —
 * this module is a thin layer over it, so there is never a second resolver
 * disagreeing about which skill wins (docs/skills-design.md §3).
 */

import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  SkillCatalog,
  isContainedIn,
  makeSkillId,
  resolveSkillId,
  tierRoot,
  winnersOf,
  type SkillCatalogContext,
} from './catalog.ts';
import type { CatalogEntry, CatalogSnapshot, SkillId } from './types.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { downloadIcon, findIconFile, needsIconDownload } from '../utils/icon.ts';

export { GLOBAL_AGENT_SKILLS_DIR, PROJECT_AGENT_SKILLS_DIR };

// ── Snapshot cache ──────────────────────────────────────────────────────────
// Discovery reads up to four directories (~100ms) and the result rarely changes
// during a session. Cached per (workspaceRoot, projectRoot); the watcher calls
// invalidateSkillsCache() on skill file events, and the TTL is only a backstop
// for platforms where filesystem watching is unavailable.

const catalogs = new Map<string, { catalog: SkillCatalog; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000;

function contextKey(ctx: SkillCatalogContext): string {
  return `${ctx.workspaceRoot}::${ctx.projectRoot ?? ''}::${ctx.builtinRoot ?? ''}`;
}

/** Shared catalog for a context, so every caller observes the same revision. */
export function getSkillCatalog(workspaceRoot: string, projectRoot?: string): SkillCatalog {
  const ctx: SkillCatalogContext = { workspaceRoot, projectRoot };
  const key = contextKey(ctx);
  const now = Date.now();
  const cached = catalogs.get(key);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) return cached.catalog;

  const catalog = new SkillCatalog(ctx);
  catalogs.set(key, { catalog, ts: now });
  return catalog;
}

/** Invalidate every cached catalog. Call on working-dir change or skill file events. */
export function invalidateSkillsCache(): void {
  for (const { catalog } of catalogs.values()) catalog.invalidate();
  catalogs.clear();
}

/** Full catalog state — winners, shadowed entries, tiers, trust, and revision. */
export function getSkillsSnapshot(workspaceRoot: string, projectRoot?: string): CatalogSnapshot {
  return getSkillCatalog(workspaceRoot, projectRoot).snapshot();
}

// ── Load operations ─────────────────────────────────────────────────────────

/**
 * Skills the runtime may actually use: highest eligible tier per name, with
 * disabled and untrusted entries already filtered out.
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string): CatalogEntry[] {
  return winnersOf(getSkillsSnapshot(workspaceRoot, projectRoot));
}

/** Every discovered skill, shadowed copies included. Backs the per-tier listing. */
export function loadAllSkillEntries(workspaceRoot: string, projectRoot?: string): CatalogEntry[] {
  return getSkillsSnapshot(workspaceRoot, projectRoot).entries;
}

/** The winning skill for a slug, or null when no eligible copy exists. */
export function loadSkillBySlug(
  workspaceRoot: string,
  slug: string,
  projectRoot?: string
): CatalogEntry | null {
  return loadAllSkills(workspaceRoot, projectRoot).find((skill) => skill.slug === slug) ?? null;
}

/** Look up one entry by its stable id, shadowed entries included. */
export function loadSkillById(
  workspaceRoot: string,
  skillId: SkillId,
  projectRoot?: string
): CatalogEntry | null {
  return loadAllSkillEntries(workspaceRoot, projectRoot).find((skill) => skill.skillId === skillId) ?? null;
}

/** Workspace-tier skill by slug. */
export function loadSkill(workspaceRoot: string, slug: string): CatalogEntry | null {
  return (
    loadAllSkillEntries(workspaceRoot).find(
      (skill) => skill.slug === slug && skill.source === 'workspace'
    ) ?? null
  );
}

/** Every workspace-tier skill, shadowed or not. */
export function loadWorkspaceSkills(workspaceRoot: string): CatalogEntry[] {
  return loadAllSkillEntries(workspaceRoot).filter((skill) => skill.source === 'workspace');
}

// ── Mutations ───────────────────────────────────────────────────────────────

/**
 * Delete a skill by its stable id.
 *
 * `resolveSkillId` is what makes this safe: it canonicalises the path and
 * refuses anything outside the tier root, so a crafted id cannot reach a
 * directory that is not a skill (§5.3).
 */
export function deleteSkillById(
  skillId: SkillId,
  ctx: SkillCatalogContext
): boolean {
  const { entryPath, source } = resolveSkillId(skillId, ctx);
  // Built-in skills are app resources, replaced wholesale on update. Deleting
  // one would remove a file the installation owns, so it is refused here
  // rather than only in the UI. Disable it instead.
  if (source === 'builtin') {
    throw new Error('Built-in skills cannot be deleted. Disable it instead.');
  }
  if (!existsSync(entryPath)) return false;
  try {
    rmSync(entryPath, { recursive: true });
    invalidateSkillsCache();
    return true;
  } catch {
    return false;
  }
}

/** Delete a workspace-tier skill by slug. */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  const root = getWorkspaceSkillsPath(workspaceRoot);
  const target = join(root, slug, 'SKILL.md');
  // A slug is user input: refuse one that traverses out of the skills directory
  // before it reaches a recursive delete.
  if (!isContainedIn(target, root)) return false;
  return deleteSkillById(makeSkillId('workspace', target), { workspaceRoot });
}

// ── Utilities ───────────────────────────────────────────────────────────────

/** Icon path for a workspace-tier skill. */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillDir = join(getWorkspaceSkillsPath(workspaceRoot), slug);
  if (!isContainedIn(skillDir, getWorkspaceSkillsPath(workspaceRoot)) || !existsSync(skillDir)) {
    return null;
  }
  return findIconFile(skillDir) || null;
}

export function skillExists(workspaceRoot: string, slug: string): boolean {
  return loadWorkspaceSkills(workspaceRoot).some((skill) => skill.slug === slug);
}

export function listSkillSlugs(workspaceRoot: string): string[] {
  return loadWorkspaceSkills(workspaceRoot).map((skill) => skill.slug);
}

/** Absolute skills directory for a tier in this context. */
export { tierRoot };

// ── Icons ───────────────────────────────────────────────────────────────────

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(skillDir: string, iconUrl: string): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: CatalogEntry): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

export { isIconUrl } from '../utils/icon.ts';
