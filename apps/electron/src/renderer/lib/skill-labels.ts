/**
 * Tier naming shared by every surface that shows where a skill lives — the
 * catalog, the install preview, and anything that grows out of them. Keeping
 * one map means a tier renamed in the locale file renames everywhere.
 */

import type { SkillSource } from '../../shared/types'

export const SKILL_SOURCE_LABEL_KEY: Record<SkillSource, string> = {
  project: 'skillsList.tierProject',
  workspace: 'skillsList.tierWorkspace',
  global: 'skillsList.tierGlobal',
  builtin: 'skillsList.tierBuiltin',
}
