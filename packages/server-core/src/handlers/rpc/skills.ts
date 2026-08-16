import { join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { RPC_CHANNELS, type SkillFile } from '@bitlab/shared/protocol'
import { getWorkspaceByNameOrId } from '@bitlab/shared/config'
import type {
  CatalogSnapshot,
  InstallPlan,
  InstallSource,
  SkillCatalogContext,
  SkillSource,
} from '@bitlab/shared/skills'
import type { RpcServer } from '@bitlab/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.skills.GET,
  RPC_CHANNELS.skills.GET_FILES,
  RPC_CHANNELS.skills.DELETE,
  RPC_CHANNELS.skills.OPEN_EDITOR,
  RPC_CHANNELS.skills.OPEN_FINDER,
  RPC_CHANNELS.skills.SET_ENABLED,
  RPC_CHANNELS.skills.SET_PROJECT_TRUST,
  RPC_CHANNELS.skills.PREVIEW,
  RPC_CHANNELS.skills.IMPORT,
] as const

/** Empty snapshot for an unknown workspace, so callers always get a valid shape. */
const EMPTY_SNAPSHOT: CatalogSnapshot = {
  revision: '',
  entries: [],
  tiers: [],
  diagnostics: [],
}

export function registerSkillsHandlers(server: RpcServer, deps: HandlerDeps): void {
  /**
   * Catalog context for a workspace. The project tier follows the folder bound
   * to the workspace, and only when that folder actually exists — a stale
   * binding must not make project skills resolve against a missing directory.
   */
  function contextFor(workspaceId: string): SkillCatalogContext | null {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      deps.platform.logger?.error(`SKILLS: Workspace not found: ${workspaceId}`)
      return null
    }
    const projectRoot = workspace.folderPath && existsSync(workspace.folderPath)
      ? workspace.folderPath
      : undefined
    return { workspaceRoot: workspace.dataRoot, projectRoot }
  }

  // Full catalog state — winners, shadowed entries, tiers, trust, and revision.
  // The UI and the runtime consume the same snapshot, or they drift.
  server.handle(RPC_CHANNELS.skills.GET, async (_ctx, workspaceId: string) => {
    const ctx = contextFor(workspaceId)
    if (!ctx) return EMPTY_SNAPSHOT

    const { getSkillsSnapshot } = await import('@bitlab/shared/skills')
    const snapshot = getSkillsSnapshot(ctx.workspaceRoot, ctx.projectRoot)
    deps.platform.logger?.info(
      `SKILLS_GET: ${snapshot.entries.length} skill(s), revision ${snapshot.revision}`
    )
    return snapshot
  })

  // Files bundled with a skill (scripts/, references/, assets/).
  server.handle(RPC_CHANNELS.skills.GET_FILES, async (_ctx, workspaceId: string, skillId: string) => {
    const ctx = contextFor(workspaceId)
    if (!ctx) return []

    const { resolveSkillId } = await import('@bitlab/shared/skills')
    let skillDir: string
    try {
      skillDir = resolveSkillId(skillId, ctx).entryPath
    } catch (err) {
      deps.platform.logger?.warn(`SKILLS_GET_FILES: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }

    function scanDirectory(dirPath: string): SkillFile[] {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true })
        return entries
          .filter(entry => !entry.name.startsWith('.')) // Skip hidden files
          .map(entry => {
            const fullPath = join(dirPath, entry.name)
            if (entry.isDirectory()) {
              return {
                name: entry.name,
                type: 'directory' as const,
                children: scanDirectory(fullPath),
              }
            } else {
              const stats = statSync(fullPath)
              return {
                name: entry.name,
                type: 'file' as const,
                size: stats.size,
              }
            }
          })
          .sort((a, b) => {
            // Directories first, then files
            if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
      } catch (err) {
        deps.platform.logger?.error(`SKILLS_GET_FILES: Error scanning ${dirPath}:`, err)
        return []
      }
    }

    return scanDirectory(skillDir)
  })

  // Every mutating and revealing operation takes a skillId, never a bare slug:
  // the id carries its tier, and resolving it refuses any path that escapes
  // that tier's root before a filesystem call happens.
  server.handle(RPC_CHANNELS.skills.DELETE, async (_ctx, workspaceId: string, skillId: string) => {
    const ctx = contextFor(workspaceId)
    if (!ctx) throw new Error('Workspace not found')

    const { deleteSkillById } = await import('@bitlab/shared/skills')
    deleteSkillById(skillId, ctx)
    deps.platform.logger?.info(`Deleted skill: ${skillId}`)
  })

  server.handle(RPC_CHANNELS.skills.OPEN_EDITOR, async (_ctx, workspaceId: string, skillId: string) => {
    const ctx = contextFor(workspaceId)
    if (!ctx) throw new Error('Workspace not found')

    const { resolveSkillId } = await import('@bitlab/shared/skills')
    await deps.platform.openPath?.(resolveSkillId(skillId, ctx).filePath)
  })

  server.handle(RPC_CHANNELS.skills.OPEN_FINDER, async (_ctx, workspaceId: string, skillId: string) => {
    const ctx = contextFor(workspaceId)
    if (!ctx) throw new Error('Workspace not found')

    const { resolveSkillId } = await import('@bitlab/shared/skills')
    await deps.platform.showItemInFolder?.(resolveSkillId(skillId, ctx).entryPath)
  })

  // A disabled skill leaves the runtime candidate set entirely — it cannot be
  // selected by the model or invoked explicitly. Disabling the winner promotes
  // the next tier down.
  server.handle(
    RPC_CHANNELS.skills.SET_ENABLED,
    async (_ctx, workspaceId: string, skillId: string, enabled: boolean) => {
      const ctx = contextFor(workspaceId)
      if (!ctx) throw new Error('Workspace not found')

      // The shared catalog, not a fresh one: mutating a throwaway instance
      // would invalidate only its own cache, leaving every reader on the stale
      // snapshot until the TTL expired.
      const { getSkillCatalog } = await import('@bitlab/shared/skills')
      const catalog = getSkillCatalog(ctx.workspaceRoot, ctx.projectRoot)
      catalog.setEnabled(skillId, enabled)
      deps.platform.logger?.info(`Skill ${enabled ? 'enabled' : 'disabled'}: ${skillId}`)
      // Returned rather than left for the file watcher to notice: this is the
      // caller's own edit, and it should not have to wait for a filesystem
      // event to see it. The watcher still covers external edits.
      return catalog.snapshot()
    }
  )

  // Stage a source and describe what installing it would do. Nothing reaches a
  // tier here: the user has to be able to read the instructions that would run
  // on their behalf before they land on disk.
  server.handle(
    RPC_CHANNELS.skills.PREVIEW,
    async (_ctx, workspaceId: string, source: InstallSource, target: SkillSource) => {
      const ctx = contextFor(workspaceId)
      if (!ctx) throw new Error('Workspace not found')

      const { prepareInstall } = await import('@bitlab/shared/skills')
      const plan = prepareInstall(source, ctx, target)
      deps.platform.logger?.info(
        `SKILLS_PREVIEW: ${source.kind}:${source.location} → ${plan.rejection ?? plan.slug}`
      )
      return plan
    }
  )

  // Commit a previously previewed plan, or discard it.
  server.handle(
    RPC_CHANNELS.skills.IMPORT,
    async (_ctx, workspaceId: string, plan: InstallPlan, target: SkillSource, confirmed: boolean) => {
      const ctx = contextFor(workspaceId)
      if (!ctx) throw new Error('Workspace not found')

      const { commitInstall, discardPlan, getSkillCatalog } = await import('@bitlab/shared/skills')
      if (!confirmed) {
        discardPlan(plan)
        return getSkillCatalog(ctx.workspaceRoot, ctx.projectRoot).snapshot()
      }
      const skillId = commitInstall(plan, target, ctx)
      deps.platform.logger?.info(`SKILLS_IMPORT: installed ${skillId}`)
      const catalog = getSkillCatalog(ctx.workspaceRoot, ctx.projectRoot)
      catalog.invalidate()
      return catalog.snapshot()
    }
  )

  // Project-tier skills stay out of the runtime until their root is trusted.
  server.handle(
    RPC_CHANNELS.skills.SET_PROJECT_TRUST,
    async (_ctx, workspaceId: string, projectRoot: string, trusted: boolean) => {
      const ctx = contextFor(workspaceId)
      if (!ctx) throw new Error('Workspace not found')

      const { getSkillCatalog } = await import('@bitlab/shared/skills')
      const catalog = getSkillCatalog(ctx.workspaceRoot, ctx.projectRoot)
      catalog.setProjectTrust(projectRoot, trusted)
      deps.platform.logger?.info(`Project trust ${trusted ? 'granted' : 'revoked'}: ${projectRoot}`)
      return catalog.snapshot()
    }
  )
}
