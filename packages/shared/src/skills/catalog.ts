/**
 * SkillCatalog — one catalog, one truth.
 *
 * Discovery across every tier, spec validation, trust filtering, enablement,
 * precedence, and shadow bookkeeping all live here. The UI renders the snapshot
 * it produces and `PiSkillBridge` feeds the snapshot's winners to Pi; two
 * resolvers would drift (docs/skills-design.md §3, §5.1).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, type Dirent } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import matter from 'gray-matter';
import {
  SKILL_TIER_ORDER,
  type CatalogEntry,
  type CatalogSnapshot,
  type CatalogTier,
  type McpRequirement,
  type SkillDiagnostic,
  type SkillId,
  type SkillMetadata,
  type SkillSource,
  type SkillTrustState,
} from './types.ts';
import {
  isProjectTrusted,
  readSkillsConfig,
  setProjectTrust as persistProjectTrust,
  setSkillEnabled as persistSkillEnabled,
} from './config.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import { getMcpServers } from '../config/storage.ts';
import { findIconFile, validateIconValue } from '../utils/icon.ts';

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Project-level agent skills, relative to the project root. */
export const PROJECT_AGENT_SKILLS_DIR = join('.agents', 'skills');

export interface SkillCatalogContext {
  /** Workspace data root — the workspace tier and `skills.json` both live under it. */
  workspaceRoot: string;
  /** Session working directory. Root of the project tier, when there is one. */
  projectRoot?: string;
  /** Skills shipped as app resources. Present from P2. */
  builtinRoot?: string;
  /**
   * Global tier root. Defaults to `~/.agents/skills`, the cross-tool directory
   * skills are portable through; overridable so a caller can point the tier
   * somewhere else rather than at the real user's home.
   */
  globalRoot?: string;
}

// ── Frontmatter ─────────────────────────────────────────────────────────────

/** Accepts the spec's space-separated form as well as a YAML list. */
function parseToolList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string');
    return items.length ? items : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const items = value.split(/\s+/).filter(Boolean);
  return items.length ? items : undefined;
}

/** The spec's `metadata` is a string→string map; coerce scalars, drop the rest. */
function parseMetadataMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export interface ParsedSkill {
  metadata: SkillMetadata;
  body: string;
  diagnostics: SkillDiagnostic[];
}

/**
 * Parse SKILL.md. Returns null when the file cannot serve as a skill at all —
 * everything softer is a diagnostic, matching Pi's lenient posture.
 *
 * Exported so an install validates against exactly the same rules the catalog
 * applies once the skill is on disk.
 */
export function parseSkillFrontmatter(content: string, filePath: string, slug: string): ParsedSkill | null {
  let data: Record<string, unknown>;
  let body: string;
  try {
    const parsed = matter(content);
    data = parsed.data as Record<string, unknown>;
    body = parsed.content;
  } catch {
    return null;
  }

  const name = typeof data.name === 'string' ? data.name : undefined;
  const description = typeof data.description === 'string' ? data.description : undefined;
  if (!name || !description) return null;

  const diagnostics: SkillDiagnostic[] = [];
  if (name !== slug) {
    diagnostics.push({
      level: 'warning',
      code: 'name-mismatch',
      message: `Skill name "${name}" does not match its directory "${slug}".`,
      path: filePath,
    });
  }

  const metadataMap = parseMetadataMap(data.metadata);
  // `bitlab.icon` is the standard-compliant home. The legacy top-level field is
  // still read because skills in the wild use it; the writer emits only the
  // namespaced form (§5.8).
  const icon = validateIconValue(metadataMap?.['bitlab.icon'] ?? data.icon, 'Skills');

  return {
    metadata: {
      name,
      description,
      license: typeof data.license === 'string' ? data.license : undefined,
      compatibility: typeof data.compatibility === 'string' ? data.compatibility : undefined,
      metadata: metadataMap,
      allowedTools: parseToolList(data['allowed-tools']),
      disallowedTools: parseToolList(data['disallowed-tools']),
      disableModelInvocation: data['disable-model-invocation'] === true,
      icon,
    },
    body,
    diagnostics,
  };
}

// ── Identity and containment ────────────────────────────────────────────────

/**
 * Canonicalise a path, resolving symlinks so a link escaping its tier root is
 * caught by the containment check rather than silently followed.
 *
 * A path that does not exist yet still has to canonicalise consistently with
 * one that does, or containment comparisons break: on macOS `/var` is a symlink
 * to `/private/var`, so realpath'ing only the existing side would make a
 * perfectly legal path look like an escape. Resolve the nearest existing
 * ancestor and re-attach the remainder.
 */
function canonical(path: string): string {
  const absolute = resolve(path);
  const segments: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return segments.length ? join(realpathSync(current), ...segments.reverse()) : realpathSync(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) return absolute;
      segments.push(basename(current));
      current = parent;
    }
  }
}

/** True when `target` is the root itself or sits underneath it. */
export function isContainedIn(target: string, root: string): boolean {
  const t = resolve(target);
  const r = resolve(root);
  return t === r || t.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** `skillId := "<source>:<canonical path to SKILL.md>"` (§5.3). */
export function makeSkillId(source: SkillSource, skillFilePath: string): SkillId {
  return `${source}:${canonical(skillFilePath)}`;
}

/** Split a skillId without touching the filesystem. */
export function parseSkillId(skillId: SkillId): { source: SkillSource; filePath: string } | null {
  const separator = skillId.indexOf(':');
  if (separator <= 0) return null;
  const source = skillId.slice(0, separator) as SkillSource;
  const filePath = skillId.slice(separator + 1);
  if (!SKILL_TIER_ORDER.includes(source) || !filePath) return null;
  return { source, filePath };
}

/** Absolute skills directory for a tier, or undefined when the tier is absent. */
export function tierRoot(source: SkillSource, ctx: SkillCatalogContext): string | undefined {
  switch (source) {
    case 'global':
      return ctx.globalRoot ?? GLOBAL_AGENT_SKILLS_DIR;
    case 'workspace':
      return getWorkspaceSkillsPath(ctx.workspaceRoot);
    case 'project':
      return ctx.projectRoot ? join(ctx.projectRoot, PROJECT_AGENT_SKILLS_DIR) : undefined;
    case 'builtin':
      return ctx.builtinRoot;
  }
}

/**
 * Resolve a skillId to real paths, refusing anything that escapes its tier
 * root. Every mutating or revealing operation goes through this: the delete
 * path in particular used to join an unvalidated slug straight onto the skills
 * directory, so a crafted value traversed out of it (§1.5, §5.3).
 */
export function resolveSkillId(
  skillId: SkillId,
  ctx: SkillCatalogContext
): { entryPath: string; filePath: string; source: SkillSource } {
  const parsed = parseSkillId(skillId);
  if (!parsed) throw new Error(`Malformed skill id: ${skillId}`);

  const root = tierRoot(parsed.source, ctx);
  if (!root) throw new Error(`No ${parsed.source} skills directory in this context`);

  const filePath = canonical(parsed.filePath);
  if (!isContainedIn(filePath, canonical(root))) {
    throw new Error(`Skill path escapes its ${parsed.source} directory: ${parsed.filePath}`);
  }
  return { entryPath: join(filePath, '..'), filePath, source: parsed.source };
}

// ── Discovery ───────────────────────────────────────────────────────────────

interface RawSkill {
  slug: string;
  metadata: SkillMetadata;
  content: string;
  path: string;
  filePath: string;
  iconPath?: string;
  source: SkillSource;
  diagnostics: SkillDiagnostic[];
}

function discoverTier(skillsDir: string | undefined, source: SkillSource): RawSkill[] {
  if (!skillsDir || !existsSync(skillsDir)) return [];

  const found: RawSkill[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    const skillDir = join(skillsDir, entry.name);
    const filePath = join(skillDir, 'SKILL.md');
    try {
      if (!statSync(skillDir).isDirectory() || !existsSync(filePath)) continue;
    } catch {
      continue;
    }

    // A symlinked skill directory is fine; one pointing outside the tier is not.
    const canonicalFile = canonical(filePath);
    if (!isContainedIn(canonicalFile, canonical(skillsDir))) continue;

    let content: string;
    try {
      content = readFileSync(canonicalFile, 'utf-8');
    } catch {
      continue;
    }

    const parsed = parseSkillFrontmatter(content, canonicalFile, entry.name);
    if (!parsed) continue;

    found.push({
      slug: entry.name,
      metadata: parsed.metadata,
      content: parsed.body,
      path: skillDir,
      filePath: canonicalFile,
      iconPath: findIconFile(skillDir),
      source,
      diagnostics: parsed.diagnostics,
    });
  }

  return found;
}

// ── MCP dependencies ────────────────────────────────────────────────────────

/** Declared as `metadata['bitlab.requiresMcp']`, comma-separated (§5.11). */
function resolveMcpRequirements(metadata: SkillMetadata): McpRequirement[] | undefined {
  const declared = metadata.metadata?.['bitlab.requiresMcp'];
  if (!declared) return undefined;

  const names = declared
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) return undefined;

  let servers: ReturnType<typeof getMcpServers>;
  try {
    servers = getMcpServers();
  } catch {
    servers = [];
  }

  return names.map((server) => {
    const configured = servers.find((candidate) => candidate.name === server);
    if (!configured) return { server, state: 'missing' as const };
    return { server, state: configured.enabled ? ('satisfied' as const) : ('disabled' as const) };
  });
}

// ── Snapshot assembly ───────────────────────────────────────────────────────

/**
 * Revision changes whenever the snapshot's observable content changes, and only
 * then — the UI and the live session compare it to detect drift (§5.7, §5.14).
 */
function computeRevision(entries: CatalogEntry[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.skillId);
    hash.update('\0');
    hash.update(entry.metadata.description);
    hash.update('\0');
    hash.update(entry.content);
    hash.update(`\0${entry.enabled}\0${entry.trust}\0${entry.winner}\0`);
  }
  return hash.digest('hex').slice(0, 16);
}

/** Skills the runtime may actually use. */
export function winnersOf(snapshot: CatalogSnapshot): CatalogEntry[] {
  return snapshot.entries.filter((entry) => entry.winner);
}

export class SkillCatalog {
  private cached: CatalogSnapshot | null = null;

  constructor(private readonly ctx: SkillCatalogContext) {}

  /** Drop the cached snapshot. The next `snapshot()` re-reads every tier. */
  invalidate(): void {
    this.cached = null;
  }

  setEnabled(skillId: SkillId, enabled: boolean): void {
    // Validate before persisting: an id that escapes its tier must not be able
    // to leave a permanent entry in skills.json.
    resolveSkillId(skillId, this.ctx);
    persistSkillEnabled(this.ctx.workspaceRoot, skillId, enabled);
    this.invalidate();
  }

  setProjectTrust(projectRoot: string, trusted: boolean): void {
    persistProjectTrust(this.ctx.workspaceRoot, projectRoot, trusted);
    this.invalidate();
  }

  snapshot(): CatalogSnapshot {
    if (this.cached) return this.cached;

    const config = readSkillsConfig(this.ctx.workspaceRoot);
    const disabled = new Set(config.disabled);
    const projectTrusted =
      this.ctx.projectRoot !== undefined && isProjectTrusted(this.ctx.workspaceRoot, this.ctx.projectRoot);

    const tiers: CatalogTier[] = [];
    const raw: RawSkill[] = [];
    for (const source of SKILL_TIER_ORDER) {
      const root = tierRoot(source, this.ctx);
      if (!root) continue;
      tiers.push({
        source,
        path: root,
        trust: trustOf(source, projectTrusted),
      });
      raw.push(...discoverTier(root, source));
    }

    const entries: CatalogEntry[] = raw.map((skill) => {
      const skillId = makeSkillId(skill.source, skill.filePath);
      const trust = trustOf(skill.source, projectTrusted);
      return {
        skillId,
        slug: skill.slug,
        metadata: skill.metadata,
        content: skill.content,
        path: skill.path,
        filePath: skill.filePath,
        iconPath: skill.iconPath,
        source: skill.source,
        enabled: !disabled.has(skillId),
        trust,
        // Provisional: precedence runs below, after the eligibility filters.
        winner: false,
        diagnostics: skill.diagnostics,
        install: config.installed[skillId],
        mcpRequirements: resolveMcpRequirements(skill.metadata),
      };
    });

    assignWinners(entries);

    const snapshot: CatalogSnapshot = {
      revision: computeRevision(entries),
      entries,
      tiers,
      diagnostics: [],
      projectRoot: this.ctx.projectRoot,
    };
    this.cached = snapshot;
    return snapshot;
  }
}

/** Trust gates the project tier only; every other tier is always eligible. */
function trustOf(source: SkillSource, projectTrusted: boolean): SkillTrustState {
  if (source !== 'project') return 'not-applicable';
  return projectTrusted ? 'trusted' : 'untrusted';
}

/**
 * Resolve collisions across tiers.
 *
 * Keyed on the directory slug, not the frontmatter `name`: the slug is what the
 * user manipulates on disk and what `[skill:slug]` addresses, so putting a
 * directory of the same name in a higher tier is how overriding is expressed.
 * The spec requires the two to match anyway, and a mismatch already earns a
 * diagnostic. Pi keys on `name` instead — reconciling that is the bridge's job
 * (§1.3, §5.2).
 *
 * Precedence is computed AFTER the enablement and trust filters, not before:
 * disabling the winner has to promote the next tier down, and an untrusted
 * project skill must not shadow the workspace copy that should be running
 * instead (§5.4, §5.6).
 */
function assignWinners(entries: CatalogEntry[]): void {
  const rank = (entry: CatalogEntry) => SKILL_TIER_ORDER.indexOf(entry.source);
  const eligible = (entry: CatalogEntry) => entry.enabled && entry.trust !== 'untrusted';

  const bySlug = new Map<string, CatalogEntry[]>();
  for (const entry of entries) {
    const group = bySlug.get(entry.slug);
    if (group) group.push(entry);
    else bySlug.set(entry.slug, [entry]);
  }

  for (const group of bySlug.values()) {
    const winner = group
      .filter(eligible)
      .sort((a, b) => rank(b) - rank(a))[0];
    if (!winner) continue;
    winner.winner = true;
    for (const entry of group) {
      if (entry !== winner) entry.shadowedBy = winner.skillId;
    }
  }
}
