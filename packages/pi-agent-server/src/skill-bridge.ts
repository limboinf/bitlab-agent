/**
 * PiSkillBridge — the only place the skill catalog meets the Pi SDK.
 *
 * Pi assembles the `<available_skills>` block itself, inside
 * `_rebuildSystemPrompt`, by reading its resource loader. So the way to get
 * Bitlab's catalog in front of the model is to make the loader answer with our
 * data, not to stamp a finished prompt onto the session: a stamped prompt is
 * exactly what discards the catalog Pi just assembled.
 *
 * Three loader seams carry everything (docs/skills-design.md §5.2):
 *   noSkills            Pi stops scanning, so `.pi/skills` cannot contribute
 *                       unreviewed skills and the ordering stays ours.
 *   skillsOverride      the catalog's winners, verbatim and in order — Pi's
 *                       own first-wins collision rule never runs.
 *   systemPromptOverride Bitlab's prompt enters as `customPrompt`, so Pi keeps
 *                       appending the catalog on every rebuild.
 */

import {
  createSyntheticSourceInfo,
  type AgentSession,
  type ResourceDiagnostic,
  type Skill,
} from '@earendil-works/pi-coding-agent';
import type { CatalogEntry, CatalogSnapshot } from '@bitlab/shared/skills';
import { winnersOf } from '@bitlab/shared/skills';

/**
 * The subset of `DefaultResourceLoaderOptions` this bridge owns. The overrides
 * keep the SDK's shape — they take the value the loader would otherwise have
 * produced — even though the catalog replaces it outright.
 */
export interface SkillLoaderSeams {
  noSkills: true;
  skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
  };
  systemPromptOverride: (base: string | undefined) => string | undefined;
}

export interface PiSkillBridgeOptions {
  /** Current catalog state. Called on every rebuild, so edits are picked up. */
  getSnapshot: () => CatalogSnapshot | null;
  /** Bitlab's base system prompt. Changes per turn, hence a getter. */
  getBasePrompt: () => string | undefined;
  debugLog?: (message: string) => void;
}

/** Pi's own notion of scope. The workspace tier is a Bitlab concept with no
 *  equivalent, so it presents as user-scoped — which is what it is from Pi's
 *  point of view: not part of the project checkout. */
const PI_SCOPE: Record<CatalogEntry['source'], 'user' | 'project'> = {
  global: 'user',
  workspace: 'user',
  builtin: 'user',
  project: 'project',
};

/**
 * Pi identifies a skill by its frontmatter `name`; Bitlab identifies it by
 * `skillId` and resolves precedence on the directory slug. Reconciling the two
 * belongs here rather than in the catalog (§5.2).
 */
function toPiSkill(entry: CatalogEntry): Skill {
  return {
    name: entry.metadata.name,
    description: entry.metadata.description,
    filePath: entry.filePath,
    baseDir: entry.path,
    sourceInfo: createSyntheticSourceInfo(entry.filePath, {
      source: `bitlab:${entry.source}`,
      scope: PI_SCOPE[entry.source],
      baseDir: entry.path,
    }),
    disableModelInvocation: entry.metadata.disableModelInvocation ?? false,
  };
}

export class PiSkillBridge {
  private lastRevision: string | null = null;

  constructor(private readonly options: PiSkillBridgeOptions) {}

  /** Catalog revision the session most recently ran against (§5.14). */
  get revision(): string | null {
    return this.lastRevision;
  }

  /** Spread into `DefaultResourceLoaderOptions` when constructing the loader. */
  seams(): SkillLoaderSeams {
    return {
      noSkills: true,
      skillsOverride: () => ({ skills: this.piSkills(), diagnostics: [] }),
      systemPromptOverride: () => this.options.getBasePrompt(),
    };
  }

  private piSkills(): Skill[] {
    const snapshot = this.options.getSnapshot();
    if (!snapshot) return [];
    this.lastRevision = snapshot.revision;

    const skills: Skill[] = [];
    const claimed = new Map<string, CatalogEntry>();
    for (const entry of winnersOf(snapshot)) {
      // Two skills in different directories can still declare the same
      // frontmatter name. Pi would silently keep whichever arrived first, so
      // drop the loser here and say why rather than letting the catalog and the
      // model disagree about what is available.
      const existing = claimed.get(entry.metadata.name);
      if (existing) {
        this.options.debugLog?.(
          `Skill name collision: "${entry.metadata.name}" declared by ${existing.skillId} and ${entry.skillId}; using the former`
        );
        continue;
      }
      claimed.set(entry.metadata.name, entry);
      skills.push(toPiSkill(entry));
    }
    return skills;
  }

  /**
   * Rebuild the session's system prompt so a changed catalog or base prompt
   * takes effect.
   *
   * `setActiveToolsByName` is the cheap public path into `_rebuildSystemPrompt`
   * — unlike `session.reload()`, which tears the extension runtime down and
   * back up, disturbing live MCP connections for what is only a prompt change.
   */
  refresh(session: AgentSession): void {
    session.setActiveToolsByName(session.getActiveToolNames());
  }

  /**
   * Pi appends the catalog only when the `read` tool is active — without it the
   * entire `<available_skills>` block vanishes from the prompt and the model
   * simply never learns any skill exists. Nothing surfaces that failure at
   * runtime, so assert it at wiring time instead of shipping a promptless
   * catalog (§5.2, acceptance test 8).
   */
  assertCatalogVisible(activeToolNames: string[]): void {
    if (activeToolNames.includes('read')) return;
    throw new Error(
      'Skill catalog would be dropped from the system prompt: Pi only appends <available_skills> when the `read` tool is active, ' +
        `but the active tool set is [${activeToolNames.join(', ')}].`
    );
  }
}
