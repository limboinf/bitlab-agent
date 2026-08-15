import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Zap, AlertTriangle, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import type { EntityListGroup } from '@/components/ui/entity-list'
import { skillSelection } from '@/hooks/useEntitySelection'
import { SkillMenu } from './SkillMenu'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { getFileManagerName } from '@/lib/platform'
import { cn } from '@/lib/utils'
import type { CatalogEntry, CatalogSnapshot, SkillSource } from '../../../shared/types'

export interface SkillsListPanelProps {
  snapshot: CatalogSnapshot
  onDeleteSkill: (skillId: string) => void
  onToggleSkill: (skillId: string, enabled: boolean) => void
  onTrustProject: (projectRoot: string) => void
  onSkillClick: (skill: CatalogEntry) => void
  selectedSkillSlug?: string | null
  workspaceId?: string
  workspaceRootPath?: string
  className?: string
}

/** Tiers in the order the user should read them: the one that wins comes first. */
const TIER_ORDER: SkillSource[] = ['project', 'workspace', 'global', 'builtin']

const TIER_LABEL_KEY: Record<SkillSource, string> = {
  project: 'skillsList.tierProject',
  workspace: 'skillsList.tierWorkspace',
  global: 'skillsList.tierGlobal',
  builtin: 'skillsList.tierBuiltin',
}

/** The row itself is a button, so the toggle has to keep its clicks to itself. */
function EnabledToggle({
  enabled,
  disabled,
  label,
  onChange,
}: {
  enabled: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!enabled)
      }}
      className={cn(
        'shrink-0 h-[18px] w-[30px] rounded-full transition-colors relative',
        enabled ? 'bg-foreground/70' : 'bg-foreground/15',
        disabled && 'opacity-40 cursor-not-allowed'
      )}
    >
      <span
        className={cn(
          'absolute top-[2px] h-[14px] w-[14px] rounded-full bg-background shadow-minimal transition-all',
          enabled ? 'left-[14px]' : 'left-[2px]'
        )}
      />
    </button>
  )
}

export function SkillsListPanel({
  snapshot,
  onDeleteSkill,
  onToggleSkill,
  onTrustProject,
  onSkillClick,
  selectedSkillSlug,
  workspaceId,
  workspaceRootPath,
  className,
}: SkillsListPanelProps) {
  const { t } = useTranslation()
  const canRevealLocally = true

  // Grouping by tier is deliberate: the tier decides precedence, and precedence
  // is the thing users get wrong.
  const { items, groups, untrustedProjectRoot } = React.useMemo(() => {
    const byTier = new Map<SkillSource, CatalogEntry[]>()
    for (const entry of snapshot.entries) {
      const bucket = byTier.get(entry.source)
      if (bucket) bucket.push(entry)
      else byTier.set(entry.source, [entry])
    }

    const ordered: CatalogEntry[] = []
    const sections: EntityListGroup<CatalogEntry>[] = []
    for (const tier of TIER_ORDER) {
      const entries = byTier.get(tier)
      if (!entries?.length) continue
      entries.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
      ordered.push(...entries)
      sections.push({
        key: tier,
        label: `${t(TIER_LABEL_KEY[tier])} · ${entries.length}`,
        items: entries,
      })
    }

    const projectTier = snapshot.tiers.find((tier) => tier.source === 'project')
    return {
      items: ordered,
      groups: sections,
      untrustedProjectRoot:
        projectTier?.trust === 'untrusted' && byTier.get('project')?.length
          ? snapshot.projectRoot
          : undefined,
    }
  }, [snapshot, t])

  return (
    <div className={cn('flex flex-col flex-1 min-h-0', className)}>
      {untrustedProjectRoot && (
        <div className="mx-3 mt-2 rounded-[8px] border border-border/60 bg-foreground/[0.02] px-3 py-2.5">
          <div className="flex items-start gap-2">
            <ShieldAlert className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-foreground/80">{t('skillsList.untrustedProject')}</p>
              <button
                type="button"
                onClick={() => onTrustProject(untrustedProjectRoot)}
                className="mt-2 inline-flex items-center h-6 px-2.5 text-[11px] font-medium rounded-[6px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors"
              >
                {t('skillsList.trustProject')}
              </button>
            </div>
          </div>
        </div>
      )}
      <EntityPanel<CatalogEntry>
        items={items}
        groups={groups}
        getId={(s) => s.skillId}
        selection={skillSelection}
        selectedId={selectedSkillSlug}
        onItemClick={onSkillClick}
        containerProps={{ 'data-list-role': 'skills' }}
        emptyState={
          <EntityListEmptyScreen
            icon={<Zap />}
            title={t('skillsList.noSkillsConfigured')}
            description={t('skillsList.emptyDescription')}
            docKey="skills"
          >
            {workspaceRootPath && (
              <EditPopover
                align="center"
                trigger={
                  <button className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                    {t('skillsList.addSkill')}
                  </button>
                }
                {...getEditConfig('add-skill', workspaceRootPath)}
              />
            )}
          </EntityListEmptyScreen>
        }
        mapItem={(skill) => {
          const isUntrusted = skill.trust === 'untrusted'
          const isShadowed = Boolean(skill.shadowedBy)
          return {
            icon: <SkillAvatar skill={skill} size="sm" workspaceId={workspaceId} />,
            title: (
              <span className={cn('truncate', (!skill.enabled || isUntrusted) && 'text-muted-foreground')}>
                {skill.metadata.name}
              </span>
            ),
            badges: (
              <span className="flex items-center gap-1.5 min-w-0">
                {/* A shadowed skill is on disk but inert. Left unsaid, the
                    conflict is invisible and the user edits the wrong file. */}
                {isShadowed && (
                  <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    {t('skillsList.shadowed')}
                  </span>
                )}
                {isUntrusted && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-foreground/5 text-muted-foreground">
                    {t('skillsList.untrusted')}
                  </span>
                )}
                <span className="truncate">{skill.metadata.description}</span>
              </span>
            ),
            trailing: (
              <EnabledToggle
                enabled={skill.enabled}
                disabled={isUntrusted}
                label={t('skillsList.toggleSkill', { name: skill.metadata.name })}
                onChange={(next) => onToggleSkill(skill.skillId, next)}
              />
            ),
            menu: (
              <SkillMenu
                skillSlug={skill.slug}
                skillName={skill.metadata.name}
                onOpenInNewWindow={() => window.electronAPI.openUrl(`bitlab://skills/skill/${skill.slug}?window=focused`)}
                onShowInFinder={async () => {
                  if (!canRevealLocally) return
                  try {
                    await window.electronAPI.showInFolder(skill.path)
                  } catch (err) {
                    const message = err instanceof Error ? err.message : String(err)
                    toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
                      description: message,
                    })
                  }
                }}
                canShowInFinder={canRevealLocally}
                onDelete={skill.source === 'workspace' ? () => onDeleteSkill(skill.skillId) : undefined}
                canDelete={skill.source === 'workspace'}
                deleteLabel={skill.source === 'workspace' ? t('skillsList.deleteSkill') : t('skillsList.managedByProject')}
              />
            ),
          }
        }}
      />
    </div>
  )
}
