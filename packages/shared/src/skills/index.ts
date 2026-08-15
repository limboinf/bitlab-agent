/**
 * Skills Module
 *
 * Skills are specialized instruction sets that extend the agent's capabilities.
 * `SkillCatalog` owns discovery and precedence; everything else reads its
 * snapshot.
 */

export * from './types.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  SkillCatalog,
  isContainedIn,
  makeSkillId,
  parseSkillId,
  resolveSkillId,
  tierRoot,
  winnersOf,
  type SkillCatalogContext,
} from './catalog.ts';
export {
  TRUSTED_ROOTS_ENV,
  isProjectTrusted,
  readSkillsConfig,
  setProjectTrust,
  setSkillEnabled,
  skillsConfigExists,
  updateSkillsConfig,
} from './config.ts';
export {
  deleteSkill,
  deleteSkillById,
  downloadSkillIcon,
  getSkillCatalog,
  getSkillIconPath,
  getSkillsSnapshot,
  invalidateSkillsCache,
  isIconUrl,
  listSkillSlugs,
  loadAllSkillEntries,
  loadAllSkills,
  loadSkill,
  loadSkillById,
  loadSkillBySlug,
  loadWorkspaceSkills,
  skillExists,
  skillNeedsIconDownload,
} from './storage.ts';
