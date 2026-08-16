/**
 * Skills Types — the catalog contract.
 *
 * One vocabulary shared by every consumer: `SkillCatalog` produces a
 * `CatalogSnapshot`, the UI renders it, and `PiSkillBridge` feeds its winner
 * subset to Pi. Both consumers read the same snapshot or they drift.
 *
 * Frontmatter follows the Agent Skills specification (six fields, no dialect).
 * Bitlab-specific data lives under `metadata['bitlab.*']`.
 * See docs/skills-design.md §5.1, §5.8.
 */

/**
 * Skill tier. Determines precedence: project > workspace > global > builtin.
 *
 * Named `SkillSource` for historical reasons; docs/skills-design.md calls the
 * same concept a "tier". They are the same thing — do not introduce a second
 * vocabulary.
 */
export type SkillSource = 'global' | 'workspace' | 'project' | 'builtin';

/** Precedence order, lowest first. Later entries win. */
export const SKILL_TIER_ORDER: readonly SkillSource[] = ['builtin', 'global', 'workspace', 'project'];

/**
 * Stable identity for every mutating or revealing operation.
 *
 *     skillId := "<source>:<canonical absolute path to SKILL.md>"
 *
 * Distinguishes same-named skills across tiers, survives renames of the
 * display `name`, and hands every filesystem operation an already-canonical
 * path to containment-check. Never pass a bare slug across a boundary.
 * See docs/skills-design.md §5.3.
 */
export type SkillId = string;

/**
 * Skill metadata from SKILL.md YAML frontmatter.
 *
 * Only the six specification fields are modelled. `globs` and `alwaysAllow`
 * were a Bitlab dialect with no consumer anywhere in the codebase; they are
 * deleted rather than migrated (§5.8).
 */
export interface SkillMetadata {
  /** Skill name. Spec: <=64 chars, [a-z0-9-], should match the directory name. */
  name: string;
  /** Spec: <=1024 chars; says what it does AND when to use it. */
  description: string;
  /** License name or a bundled file reference. */
  license?: string;
  /** Environment prerequisites, <=500 chars. Surfaced in the install preview. */
  compatibility?: string;
  /**
   * Free-form string→string map — the spec's designated escape hatch for
   * client-specific data. Bitlab keys are namespaced `bitlab.*`
   * (e.g. `bitlab.icon`, `bitlab.requiresMcp`).
   */
  metadata?: Record<string, string>;
  /**
   * Pre-approved tools, parsed from the space-separated `allowed-tools` field.
   * Experimental in the spec. Displayed but grants nothing before P2 (§7.2).
   */
  allowedTools?: string[];
  /** Narrowing counterpart to `allowed-tools`. Not in the spec; Claude Code supports it. */
  disallowedTools?: string[];
  /**
   * `disable-model-invocation`. Pi treats this as prompt visibility only — the
   * skill stays loaded and explicitly invocable. Bitlab's enable/disable is a
   * separate, stronger mechanism that acts in the catalog (§5.4).
   */
  disableModelInvocation?: boolean;
  /**
   * Resolved icon — emoji or URL only. Read from `metadata['bitlab.icon']`,
   * falling back to the legacy top-level `icon` field for one release.
   * The writer emits the standard form only.
   */
  icon?: string;
}

/** Severity of a catalog diagnostic. */
export type SkillDiagnosticLevel = 'error' | 'warning';

/**
 * A validation or discovery problem. `error` means the skill was rejected;
 * `warning` means it loaded with a caveat (e.g. `name` mismatching its
 * directory, which the validator warns about rather than failing — matching
 * Pi's lenient posture).
 */
export interface SkillDiagnostic {
  level: SkillDiagnosticLevel;
  /** Machine-readable code, e.g. 'name-mismatch', 'missing-description'. */
  code: string;
  message: string;
  /** Absolute path the diagnostic refers to, when it has one. */
  path?: string;
}

/**
 * Trust state of a skill's tier. Project-tier skills default to untrusted and
 * are withheld from the runtime until the user grants trust for that project
 * root (§5.6). Other tiers are always `not-applicable` — trust gates the
 * project tier only.
 */
export type SkillTrustState = 'trusted' | 'untrusted' | 'not-applicable';

/** Whether a skill's declared MCP dependency is available in this workspace. */
export type McpRequirementState = 'satisfied' | 'missing' | 'disabled';

/** One declared MCP server dependency, resolved against workspace config (§5.11). */
export interface McpRequirement {
  server: string;
  state: McpRequirementState;
}

/**
 * Provenance for an installed skill. Recorded in `skills.json`, never written
 * back into a third-party SKILL.md — doing so would invalidate the very hash
 * used to verify it. Hand-authored skills have no record; that is valid (§5.4).
 */
export interface InstallRecord {
  /** e.g. 'git:github.com/acme/skills@v1.2.0', 'zip:local', 'market:<id>'. */
  source: string;
  version?: string;
  /** ISO 8601. */
  installedAt: string;
  sha256?: string;
}

/**
 * One discovered skill — winner or shadowed. The snapshot carries both, so the
 * UI can show a conflict that would otherwise be invisible.
 */
export interface CatalogEntry {
  /** Stable identity. See {@link SkillId}. */
  skillId: SkillId;
  /** Directory name. Not an identity — two tiers can hold the same slug. */
  slug: string;
  metadata: SkillMetadata;
  /** SKILL.md body, frontmatter stripped. */
  content: string;
  /** Absolute path to the skill directory. */
  path: string;
  /** Absolute canonical path to SKILL.md. */
  filePath: string;
  /** Absolute path to a local icon file, when one exists. */
  iconPath?: string;
  /** Which tier this was loaded from. */
  source: SkillSource;
  /** User enablement (§5.4). A disabled skill is fully excluded from the runtime. */
  enabled: boolean;
  /** Trust state of this entry's tier. */
  trust: SkillTrustState;
  /**
   * True when this entry is the active skill for its name. Computed AFTER the
   * enablement and trust filters, so disabling a winner promotes the next tier
   * down (§5.4).
   */
  winner: boolean;
  /** When `winner` is false, the skillId that beat this entry. */
  shadowedBy?: SkillId;
  /** Per-entry validation problems. */
  diagnostics: SkillDiagnostic[];
  /** Provenance, when this skill was installed rather than hand-authored. */
  install?: InstallRecord;
  /** Declared MCP dependencies, resolved against workspace config. */
  mcpRequirements?: McpRequirement[];
  /**
   * SKILL.md's last modification time, epoch ms. Shown as "edited 4h ago" for
   * hand-authored skills, which have no install record to date them by.
   */
  modifiedAt?: number;
}

/**
 * A tier's root directory, for the UI's group headers — shown even when the
 * tier holds no skills, so the user knows where to put one.
 */
export interface CatalogTier {
  source: SkillSource;
  /** Absolute path to the tier's skills directory. */
  path: string;
  trust: SkillTrustState;
}

/**
 * The single truth. Produced by `SkillCatalog.snapshot()`, consumed by the UI
 * and by `PiSkillBridge` (winner subset only).
 */
export interface CatalogSnapshot {
  /**
   * Changes whenever the catalog's observable content changes. The UI and the
   * live session must report the same revision, or they have drifted (§5.7).
   * Also stamped into session metadata per turn to make drift debuggable (§5.14).
   */
  revision: string;
  /** Every discovered skill — winners and shadowed alike. */
  entries: CatalogEntry[];
  /** Tier roots, in precedence order (lowest first). */
  tiers: CatalogTier[];
  /** Catalog-level problems not attributable to one skill. */
  diagnostics: SkillDiagnostic[];
  /** The project root this snapshot was computed against, when there is one. */
  projectRoot?: string;
}

/**
 * On-disk shape of `~/.bitlab/workspaces/<slug>/skills.json`.
 *
 * Keyed by `skillId`, so same-named skills in different tiers toggle
 * independently. Written read-modify-write with an atomic rename, because two
 * windows toggling different skills must not clobber each other (§5.4).
 */
export interface SkillsConfigFile {
  /** Schema version, for future migrations. */
  version: number;
  /** skillIds the user turned off. */
  disabled: SkillId[];
  /** Provenance, keyed by skillId. */
  installed: Record<SkillId, InstallRecord>;
  /** Project roots the user granted skill trust to (§5.6). */
  trustedProjectRoots: string[];
}

/** Empty config, used when the file is absent or unparseable. */
export const EMPTY_SKILLS_CONFIG: SkillsConfigFile = {
  version: 1,
  disabled: [],
  installed: {},
  trustedProjectRoots: [],
};

/**
 * @deprecated Use {@link CatalogEntry}. Retained as an alias so existing
 * consumers keep compiling while the catalog rolls out; delete once
 * base-agent, the RPC layer, and the renderer have all moved over.
 */
export type LoadedSkill = CatalogEntry;

/**
 * Plugin name for project-level and global skills.
 *
 * The SDK derives plugin names from `path.basename()` of the registered plugin
 * directory. Both `{project}/.agents/` and `~/.agents/` share the basename
 * `.agents`, so skills from either tier resolve to `.agents:skillSlug`.
 */
export const AGENTS_PLUGIN_NAME = '.agents';

// ── Installation ────────────────────────────────────────────────────────────

/** Where a skill is being installed from. */
export type InstallSourceKind = 'folder' | 'zip' | 'git';

export interface InstallSource {
  kind: InstallSourceKind;
  /** Directory path, archive path, or clone URL. */
  location: string;
  /** Git ref to check out. Git sources only. */
  ref?: string;
}

/** One file the install would write, relative to the skill directory. */
export interface InstallFile {
  path: string;
  bytes: number;
  /** Scripts are called out separately — they are the part that can execute. */
  executable: boolean;
}

/**
 * Why an install was refused. These are checked during `prepare`, before
 * anything reaches its destination (§5.9).
 */
export type InstallRejection =
  | 'missing-skill-md'
  | 'invalid-frontmatter'
  | 'path-traversal'
  | 'escaping-symlink'
  | 'too-many-files'
  | 'too-large'
  | 'too-deep'
  | 'fetch-failed';

/**
 * A staged, validated install awaiting the user's decision. Nothing is written
 * to a tier until `commit`, because a skill is executable instruction text and
 * the user has to be able to read it first (§7.1).
 */
export interface InstallPlan {
  /** The temp directory to delete on discard. */
  stagingRoot: string;
  /** The skill root inside staging — the directory that becomes the install. */
  stagingDir: string;
  source: InstallSource;
  /** Directory name the skill would take in its tier. */
  slug: string;
  /** Parsed frontmatter, when the skill is valid. */
  metadata?: SkillMetadata;
  /** Full SKILL.md text — the security surface, rendered before install. */
  skillMarkdown?: string;
  /** Everything the install would write. */
  files: InstallFile[];
  totalBytes: number;
  /** Spec validation problems. Warnings do not block; errors do. */
  diagnostics: SkillDiagnostic[];
  /** Set when the plan cannot be committed. */
  rejection?: InstallRejection;
  /** A skill with this slug already exists in the chosen tier. */
  conflictsWith?: SkillId;
  sha256?: string;
}
