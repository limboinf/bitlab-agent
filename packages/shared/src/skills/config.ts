/**
 * Persistent skill state: `~/.bitlab/workspaces/<slug>/skills.json`.
 *
 * Holds what the filesystem cannot: which skills the user turned off, where an
 * installed skill came from, and which project roots may contribute skills at
 * all. Keyed by `skillId`, so same-named skills in different tiers are
 * independent (docs/skills-design.md §5.4).
 *
 * The filesystem stays the source of truth for what a skill IS; this file only
 * records decisions made about them.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { EMPTY_SKILLS_CONFIG, type SkillId, type SkillsConfigFile } from './types.ts';

/** Environment channel for granting project trust where no dialog exists (§5.15). */
export const TRUSTED_ROOTS_ENV = 'BITLAB_TRUSTED_PROJECT_ROOTS';

function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, 'skills.json');
}

function normalize(raw: unknown): SkillsConfigFile {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_SKILLS_CONFIG };
  const value = raw as Partial<SkillsConfigFile>;
  return {
    version: typeof value.version === 'number' ? value.version : 1,
    disabled: Array.isArray(value.disabled) ? value.disabled.filter((id): id is string => typeof id === 'string') : [],
    installed: value.installed && typeof value.installed === 'object' ? value.installed : {},
    trustedProjectRoots: Array.isArray(value.trustedProjectRoots)
      ? value.trustedProjectRoots.filter((p): p is string => typeof p === 'string')
      : [],
  };
}

/** Read persisted state. A missing or unparseable file reads as empty, never throws. */
export function readSkillsConfig(workspaceRoot: string): SkillsConfigFile {
  try {
    return normalize(JSON.parse(readFileSync(configPath(workspaceRoot), 'utf-8')));
  } catch {
    return { ...EMPTY_SKILLS_CONFIG };
  }
}

// ── Cross-process mutation ──────────────────────────────────────────────────
// Read-modify-write plus an atomic rename is not enough on its own: two windows
// that both read the old state before either writes will each persist their own
// view, and the later write silently drops the earlier one. `mkdir` is atomic
// on every platform we target, so a lock directory is the cheapest correct
// mutex — and a stale one (crashed holder) expires rather than wedging the app.

const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 3_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockDir: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          rmdirSync(lockDir);
          continue;
        }
      } catch {
        // The holder released it between our mkdir and stat — just retry.
      }
      if (Date.now() >= deadline) return false;
      sleepSync(LOCK_RETRY_MS);
    }
  }
}

/**
 * Apply `mutate` to the persisted state under a cross-process lock, so
 * concurrent writers cannot lose each other's changes. Returns the state
 * actually written.
 */
export function updateSkillsConfig(
  workspaceRoot: string,
  mutate: (config: SkillsConfigFile) => SkillsConfigFile
): SkillsConfigFile {
  mkdirSync(workspaceRoot, { recursive: true });
  const target = configPath(workspaceRoot);
  const lockDir = `${target}.lock`;
  const locked = acquireLock(lockDir);
  try {
    const next = mutate(readSkillsConfig(workspaceRoot));
    // Rename is atomic within a directory: a reader sees either the old file or
    // the complete new one, never a half-written mix.
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    renameSync(tmp, target);
    return next;
  } finally {
    if (locked) {
      try {
        rmdirSync(lockDir);
      } catch {
        // Already gone (expired and reclaimed) — nothing to release.
      }
    }
  }
}

/** Turn a skill on or off for this workspace. */
export function setSkillEnabled(workspaceRoot: string, skillId: SkillId, enabled: boolean): void {
  updateSkillsConfig(workspaceRoot, (config) => {
    const disabled = config.disabled.filter((id) => id !== skillId);
    if (!enabled) disabled.push(skillId);
    return { ...config, disabled };
  });
}

// ── Project trust ───────────────────────────────────────────────────────────

/**
 * Roots named by the environment. The headless server and WebUI have no dialog
 * to grant trust through, so without this channel project skills would be
 * permanently unavailable there — a regression dressed as a security feature.
 * Absence of a UI must not silently become "trust everything" either, which is
 * why the operator has to name roots explicitly (§5.15).
 */
function trustedRootsFromEnv(): string[] {
  const raw = process.env[TRUSTED_ROOTS_ENV]?.trim();
  if (!raw) return [];
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

/** Whether project-tier skills under `projectRoot` may reach the runtime. */
export function isProjectTrusted(workspaceRoot: string, projectRoot: string): boolean {
  const target = resolve(projectRoot);
  if (trustedRootsFromEnv().includes(target)) return true;
  return readSkillsConfig(workspaceRoot).trustedProjectRoots.some((root) => resolve(root) === target);
}

/** Grant or revoke trust for a project root. Both directions are explicit. */
export function setProjectTrust(workspaceRoot: string, projectRoot: string, trusted: boolean): void {
  const target = resolve(projectRoot);
  updateSkillsConfig(workspaceRoot, (config) => {
    const roots = config.trustedProjectRoots.filter((root) => resolve(root) !== target);
    if (trusted) roots.push(target);
    return { ...config, trustedProjectRoots: roots };
  });
}

/** True when a `skills.json` exists for this workspace. */
export function skillsConfigExists(workspaceRoot: string): boolean {
  return existsSync(configPath(workspaceRoot));
}
