/**
 * SkillInfoPage
 *
 * Displays comprehensive skill details including metadata and instructions.
 * Uses the Info_ component system for consistent styling with SourceInfoPage.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useEffect, useState, useCallback } from 'react'

import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { toast } from 'sonner'
import { SkillMenu } from '@/components/app-shell/SkillMenu'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { routes, navigate } from '@/lib/navigate'
import { getFileManagerName } from '@/lib/platform'
import {
  Info_Page,
  Info_Section,
  Info_Table,
  Info_Markdown,
} from '@/components/info'
import type { LoadedSkill } from '../../shared/types'

interface SkillInfoPageProps {
  skillSlug: string
  workspaceId: string
}

export default function SkillInfoPage({ skillSlug, workspaceId }: SkillInfoPageProps) {
  const { t } = useTranslation()
  const [skill, setSkill] = useState<LoadedSkill | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const canRevealLocally = true

  // Load skill data
  useEffect(() => {
    let isMounted = true
    setLoading(true)
    setError(null)

    const loadSkill = async () => {
      try {
        const snapshot = await window.electronAPI.getSkills(workspaceId)

        if (!isMounted) return

        // The route addresses a skill by slug; the winning entry is the one in effect.
        const found = snapshot.entries.find((entry) => entry.slug === skillSlug && entry.winner)
          ?? snapshot.entries.find((entry) => entry.slug === skillSlug)
        if (found) {
          setSkill(found)
        } else {
          setError(t('skillInfo.notFound'))
        }
      } catch (err) {
        if (!isMounted) return
        setError(err instanceof Error ? err.message : t('skillInfo.failedToLoad'))
      } finally {
        if (isMounted) setLoading(false)
      }
    }

    loadSkill()

    // Subscribe to skill changes
    const unsubscribe = window.electronAPI.onSkillsChanged?.((changedWorkspaceId, snapshot) => {
      if (changedWorkspaceId !== workspaceId) return
      const updated = snapshot.entries.find((entry) => entry.slug === skillSlug && entry.winner)
        ?? snapshot.entries.find((entry) => entry.slug === skillSlug)
      if (updated) {
        setSkill(updated)
      }
    })

    return () => {
      isMounted = false
      unsubscribe?.()
    }
  }, [workspaceId, skillSlug])

  // Handle open in finder
  const handleOpenInFinder = useCallback(async () => {
    if (!skill || !canRevealLocally) return
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: message,
      })
    }
  }, [canRevealLocally, skill, t])

  // Handle delete
  const handleDelete = useCallback(async () => {
    if (!skill) return

    try {
      if (skill.source !== 'workspace') return
      await window.electronAPI.deleteSkill(workspaceId, skill.skillId)
      toast.success(t('skillInfo.deletedSkill', { name: skill.metadata.name }))
      navigate(routes.view.skills())
    } catch (err) {
      toast.error(t('skillInfo.failedToDelete'), {
        description: err instanceof Error ? err.message : undefined,
      })
    }
  }, [skill, workspaceId, skillSlug])

  // Handle opening in new window
  const handleOpenInNewWindow = useCallback(() => {
    window.electronAPI.openUrl(`bitlab://skills/skill/${skillSlug}?window=focused`)
  }, [skillSlug])

  // Jump to a new chat with this skill pre-filled as an input mention chip
  const handleTrySkill = useCallback(() => {
    navigate(routes.action.newSession({ input: `[skill:${skillSlug}] ` }))
  }, [skillSlug])

  // Get skill name for header
  const skillName = skill?.metadata.name || skillSlug
  const canDeleteSkill = skill?.source === 'workspace'

  // Format path to show just the skill-relative portion (skills/{slug}/)
  const formatPath = (path: string) => {
    const skillsIndex = path.indexOf('/skills/')
    if (skillsIndex !== -1) {
      return path.slice(skillsIndex + 1) // Remove leading slash, keep "skills/{slug}/..."
    }
    return path
  }

  // Open the skill folder in Finder
  const handleLocationClick = async () => {
    if (!skill || !canRevealLocally) return
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: message,
      })
    }
  }

  return (
    <Info_Page
      loading={loading}
      error={error ?? undefined}
      empty={!skill && !loading && !error ? t('skillInfo.notFound') : undefined}
    >
      <Info_Page.Header
        title={skillName}
        titleMenu={
          <SkillMenu
            skillSlug={skillSlug}
            skillName={skillName}
            onOpenInNewWindow={handleOpenInNewWindow}
            onShowInFinder={handleOpenInFinder}
            canShowInFinder={canRevealLocally}
            onDelete={canDeleteSkill ? handleDelete : undefined}
            canDelete={canDeleteSkill}
            deleteLabel={canDeleteSkill ? t('skillInfo.deleteSkill') : t('skillInfo.managedByProject')}
          />
        }
      />

      {skill && (
        <Info_Page.Content>
          {/* Hero: Avatar, title, description + try action */}
          <div className="flex items-start gap-3">
            <Info_Page.Hero
              className="min-w-0 flex-1"
              avatar={<SkillAvatar skill={skill} fluid workspaceId={workspaceId} />}
              title={skill.metadata.name}
              tagline={skill.metadata.description}
            />
            <button
              type="button"
              onClick={handleTrySkill}
              className="shrink-0 rounded-full border border-border/70 bg-background px-3.5 py-1.5 text-[13px] font-medium text-foreground shadow-minimal transition-colors hover:bg-foreground/[0.03] active:bg-foreground/[0.05]"
            >
              {t('skillInfo.tryIt')}
            </button>
          </div>

          {/* Metadata */}
          <Info_Section
            title={t('skillInfo.metadata')}
            actions={
              // EditPopover for AI-assisted metadata editing (name, description in frontmatter)
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('skill-metadata', skill.path)}
                secondaryAction={{
                  label: t('common.editFile'),
                  filePath: `${skill.path}/SKILL.md`,
                }}
              />
            }
          >
            <Info_Table>
              <Info_Table.Row label={t('common.slug')} value={skill.slug} />
              <Info_Table.Row label={t('common.name')}>{skill.metadata.name}</Info_Table.Row>
              <Info_Table.Row label={t('common.description')}>
                {skill.metadata.description}
              </Info_Table.Row>
              <Info_Table.Row label={t('skillInfo.origin')}>
                {skill.source === 'project' ? t('skillInfo.sourceProject') :
                 skill.source === 'global' ? t('skillInfo.sourceGlobal') :
                 t('skillInfo.sourceWorkspace')}
              </Info_Table.Row>
              <Info_Table.Row label={t('common.location')}>
                <button
                  onClick={handleLocationClick}
                  className="hover:underline cursor-pointer text-left"
                >
                  {formatPath(skill.path)}
                </button>
              </Info_Table.Row>
              {skill.metadata.license && (
                <Info_Table.Row label={t('skillInfo.license')}>{skill.metadata.license}</Info_Table.Row>
              )}
              {skill.metadata.compatibility && (
                <Info_Table.Row label={t('skillInfo.compatibility')}>
                  {skill.metadata.compatibility}
                </Info_Table.Row>
              )}
            </Info_Table>
          </Info_Section>

          {/* Declared MCP dependencies. Shown whether or not they are met: an
              unmet one still installs and still runs, it just degrades — and a
              user staring at a skill that half-works deserves to see why. */}
          {skill.mcpRequirements && skill.mcpRequirements.length > 0 && (
            <Info_Section title={t('skillInfo.requiredMcp')}>
              <Info_Table>
                {skill.mcpRequirements.map((requirement) => (
                  <Info_Table.Row key={requirement.server} label={requirement.server}>
                    <span
                      className={
                        requirement.state === 'satisfied'
                          ? 'text-foreground/80'
                          : 'text-muted-foreground'
                      }
                    >
                      {requirement.state === 'satisfied'
                        ? t('skillInfo.mcpSatisfied')
                        : requirement.state === 'disabled'
                          ? t('skillInfo.mcpDisabled')
                          : t('skillInfo.mcpMissing')}
                    </span>
                  </Info_Table.Row>
                ))}
              </Info_Table>
            </Info_Section>
          )}

          {/* Instructions */}
          <Info_Section
            title={t('skillInfo.instructions')}
            actions={
              // EditPopover for AI-assisted editing with "Edit File" as secondary action
              <EditPopover
                trigger={<EditButton />}
                {...getEditConfig('skill-instructions', skill.path)}
                secondaryAction={{
                  label: t('common.editFile'),
                  filePath: `${skill.path}/SKILL.md`,
                }}
              />
            }
          >
            <Info_Markdown maxHeight={540} fullscreen>
              {skill.content || t('skillInfo.noInstructions')}
            </Info_Markdown>
          </Info_Section>

        </Info_Page.Content>
      )}
    </Info_Page>
  )
}
