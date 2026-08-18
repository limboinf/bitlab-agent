import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  AlertTriangle,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  Search,
  ShieldAlert,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { SkillImportMenu } from '@/components/app-shell/SkillImportMenu'
import { Info_Markdown } from '@/components/info'
import { useAppShellContext } from '@/context/AppShellContext'
import { getFileManagerName } from '@/lib/platform'
import { navigate, routes } from '@/lib/navigate'
import { SKILL_SOURCE_LABEL_KEY } from '@/lib/skill-labels'
import { cn } from '@/lib/utils'
import type { CatalogEntry, SkillSource } from '../../shared/types'

type SkillFilter = 'all' | 'enabled'

function formatSkillPath(path: string) {
  const skillsIndex = path.indexOf('/skills/')
  return skillsIndex === -1 ? path : path.slice(skillsIndex + 1)
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/** "edited {{count}}m/h/d ago" from SKILL.md's mtime, for hand-authored skills. */
function formatSkillAge(t: TranslateFn, modifiedAt: number | undefined): string | null {
  if (!modifiedAt) return null
  const diffMs = Date.now() - modifiedAt
  if (diffMs < 0) return null
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return t('skillsList.ageMinutes', { count: Math.max(1, minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('skillsList.ageHours', { count: hours })
  return t('skillsList.ageDays', { count: Math.floor(hours / 24) })
}

/** Which tier's entry is currently winning over a shadowed skill, for the "被 X 层遮蔽" message. */
function resolveShadowedByLabel(
  entry: CatalogEntry,
  allEntries: CatalogEntry[],
  t: TranslateFn,
): string | null {
  if (!entry.shadowedBy) return null
  const winner = allEntries.find((candidate) => candidate.skillId === entry.shadowedBy)
  if (!winner) return t('skillsList.shadowed')
  return t('skillsList.shadowedBy', { tier: t(SKILL_SOURCE_LABEL_KEY[winner.source]) })
}

/** A skill installed under the project/workspace tier only applies there; global/builtin apply everywhere. */
function isWorkspaceScoped(source: SkillSource): boolean {
  return source === 'project' || source === 'workspace'
}

function SkillToggle({
  skill,
  onChange,
}: {
  skill: CatalogEntry
  onChange: (enabled: boolean) => void
}) {
  const { t } = useTranslation()
  const disabled = skill.trust === 'untrusted'
  return (
    <Switch
      checked={skill.enabled}
      aria-label={t('skillsList.toggleSkill', { name: skill.metadata.name })}
      disabled={disabled}
      onCheckedChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  )
}

function SkillActions({
  skill,
  onDelete,
}: {
  skill: CatalogEntry
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const reveal = async () => {
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (error) {
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('common.more')}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent align="end">
        <StyledDropdownMenuItem onSelect={() => void reveal()}>
          <FolderOpen className="size-4" />
          {t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })}
        </StyledDropdownMenuItem>
        {onDelete && (
          <>
            <StyledDropdownMenuSeparator />
            <StyledDropdownMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-4" />
              {t('skillsList.deleteSkill')}
            </StyledDropdownMenuItem>
          </>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

function SkillCard({
  skill,
  allEntries,
  workspaceId,
  onOpen,
  onToggle,
  onDelete,
}: {
  skill: CatalogEntry
  allEntries: CatalogEntry[]
  workspaceId: string
  onOpen: () => void
  onToggle: (enabled: boolean) => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()
  const source = t(SKILL_SOURCE_LABEL_KEY[skill.source])
  const isAvailable = skill.enabled && skill.trust !== 'untrusted'
  const age = formatSkillAge(t, skill.modifiedAt)
  const shadowedByLabel = resolveShadowedByLabel(skill, allEntries, t)

  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={t('skillsCatalog.viewDetails', { name: skill.metadata.name })}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className="group relative flex min-h-36 cursor-pointer gap-3.5 bg-background px-4 py-4 outline-none transition-colors hover:bg-foreground/[0.025] focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-foreground/[0.045]">
        <SkillAvatar skill={skill} size="md" workspaceId={workspaceId} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold tracking-[-0.015em]">
            {skill.metadata.name}
          </h3>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
              isAvailable
                ? 'bg-success/10 text-success'
                : 'bg-foreground/[0.055] text-muted-foreground',
            )}
          >
            <span className="size-1 rounded-full bg-current" />
            {isAvailable ? t('skillInfo.enabled') : t('skillInfo.disabled')}
          </span>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
          {skill.metadata.description}
        </p>
        <div className="mt-auto flex items-end justify-between gap-3 pt-3">
          <div className="min-w-0 truncate text-[10px] text-muted-foreground/75">
            <span>{source}</span>
            {age && <span className="ml-2">· {age}</span>}
            {shadowedByLabel && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3" />
                {shadowedByLabel}
              </span>
            )}
          </div>
          <div
            className="flex shrink-0 items-center gap-1.5"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            {isAvailable && (
              <button
                type="button"
                onClick={() => navigate(routes.action.newSession({ input: `[skill:${skill.slug}] ` }))}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <MessageSquarePlus className="size-3.5" />
                {t('skillsCatalog.use')}
              </button>
            )}
            <SkillToggle skill={skill} onChange={onToggle} />
            <SkillActions skill={skill} onDelete={onDelete} />
          </div>
        </div>
      </div>
    </article>
  )
}

function SkillDetailDialog({
  skill,
  allEntries,
  workspaceId,
  onClose,
  onToggle,
  onDelete,
}: {
  skill: CatalogEntry | null
  allEntries: CatalogEntry[]
  workspaceId: string
  onClose: () => void
  onToggle: (skill: CatalogEntry, enabled: boolean) => void
  onDelete: (skill: CatalogEntry) => void
}) {
  const { t } = useTranslation()
  if (!skill) return null

  const isAvailable = skill.enabled && skill.trust !== 'untrusted'
  const source = t(SKILL_SOURCE_LABEL_KEY[skill.source])
  const age = formatSkillAge(t, skill.modifiedAt)
  const shadowedByLabel = resolveShadowedByLabel(skill, allEntries, t)
  const scopeLabel = isWorkspaceScoped(skill.source)
    ? t('skillInfo.scopeCurrentWorkspace')
    : t('skillInfo.scopeAllWorkspaces')

  const reveal = async () => {
    try {
      await window.electronAPI.showInFolder(skill.path)
    } catch (error) {
      toast.error(t('toast.failedToReveal', { fileManager: getFileManagerName() }), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const useSkill = () => {
    onClose()
    navigate(routes.action.newSession({ input: `[skill:${skill.slug}] ` }))
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="h-[88vh] max-h-[900px] sm:max-w-6xl grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/50 px-6 py-5 pr-14">
          <div className="flex items-start gap-3.5">
            <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-foreground/[0.045]">
              <SkillAvatar skill={skill} size="md" workspaceId={workspaceId} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {t('skillInfo.capabilityEyebrow')}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="truncate text-xl tracking-[-0.025em]">
                  {skill.metadata.name}
                </DialogTitle>
                <span
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium',
                    isAvailable
                      ? 'bg-success/10 text-success'
                      : 'bg-foreground/[0.055] text-muted-foreground',
                  )}
                >
                  <span className="size-1 rounded-full bg-current" />
                  {isAvailable ? t('skillInfo.enabled') : t('skillInfo.disabled')}
                </span>
              </div>
              <DialogDescription className="mt-1.5 max-w-2xl text-xs leading-5">
                {skill.metadata.description}
              </DialogDescription>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button size="sm" onClick={useSkill} disabled={!isAvailable} className="gap-1.5">
              <MessageSquarePlus className="size-3.5" />
              {t('skillInfo.tryIt')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void reveal()} className="gap-1.5">
              <FolderOpen className="size-3.5" />
              {t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })}
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <SkillToggle
                skill={skill}
                onChange={(enabled) => onToggle(skill, enabled)}
              />
              {skill.source === 'workspace' && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="gap-1.5 text-destructive hover:bg-destructive/10"
                  onClick={() => {
                    onClose()
                    onDelete(skill)
                  }}
                >
                  <Trash2 className="size-3.5" />
                  {t('skillsList.deleteSkill')}
                </Button>
              )}
            </div>
          </div>
        </DialogHeader>

        <ScrollArea className="h-full min-h-0">
          <div className="space-y-6 px-6 py-5">
            {shadowedByLabel && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.055] px-3 py-2.5 text-xs leading-5">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span>{shadowedByLabel}</span>
              </div>
            )}

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('skillInfo.metadata')}
                </h3>
                <EditPopover
                  trigger={<Button size="sm" variant="ghost">{t('common.editFile')}</Button>}
                  {...getEditConfig('skill-metadata', skill.path)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: skill.filePath,
                  }}
                />
              </div>
              <dl className="grid overflow-hidden rounded-xl border border-border/60 sm:grid-cols-2">
                {[
                  [t('common.slug'), skill.slug],
                  [t('skillInfo.origin'), source],
                  [t('skillInfo.scope'), scopeLabel],
                  [t('common.location'), formatSkillPath(skill.path)],
                  ...(age ? [[t('common.modified'), age]] : []),
                  ...(skill.metadata.license
                    ? [[t('skillInfo.license'), skill.metadata.license]]
                    : []),
                  ...(skill.metadata.compatibility
                    ? [[t('skillInfo.compatibility'), skill.metadata.compatibility]]
                    : []),
                ].map(([label, value]) => (
                  <div key={label} className="border-b border-border/50 px-4 py-3 last:border-b-0 sm:odd:border-r">
                    <dt className="text-[10px] font-medium text-muted-foreground">{label}</dt>
                    <dd className="mt-1 break-words text-xs leading-5 text-foreground/85">{value}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {t('skillInfo.usage')}
              </h3>
              <ul className="space-y-2 rounded-xl border border-border/60 bg-foreground/[0.018] px-4 py-3.5">
                {[
                  t('skillInfo.usageMention'),
                  t('skillInfo.usageAutoRefresh'),
                  t('skillInfo.usageWorkspaceBoundary'),
                ].map((line) => (
                  <li key={line} className="flex items-start gap-2 text-xs leading-5 text-foreground/85">
                    <span className="mt-1.5 size-1 shrink-0 rounded-full bg-foreground/40" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </section>

            {skill.mcpRequirements && skill.mcpRequirements.length > 0 && (
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('skillInfo.requiredMcp')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {skill.mcpRequirements.map((requirement) => (
                    <span
                      key={requirement.server}
                      className="inline-flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-xs"
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          requirement.state === 'satisfied' ? 'bg-success' : 'bg-amber-500',
                        )}
                      />
                      <span className="font-medium">{requirement.server}</span>
                      <span className="text-muted-foreground">
                        {requirement.state === 'satisfied'
                          ? t('skillInfo.mcpSatisfied')
                          : requirement.state === 'disabled'
                            ? t('skillInfo.mcpDisabled')
                            : t('skillInfo.mcpMissing')}
                      </span>
                    </span>
                  ))}
                </div>
              </section>
            )}

            {skill.diagnostics.length > 0 && (
              <section className="space-y-2">
                {skill.diagnostics.map((diagnostic) => (
                  <div
                    key={`${diagnostic.code}:${diagnostic.message}`}
                    className="flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.055] px-3 py-2.5 text-xs leading-5"
                  >
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>{diagnostic.message}</span>
                  </div>
                ))}
              </section>
            )}

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  {t('skillInfo.instructions')}
                </h3>
                <EditPopover
                  trigger={<Button size="sm" variant="ghost">{t('common.editFile')}</Button>}
                  {...getEditConfig('skill-instructions', skill.path)}
                  secondaryAction={{
                    label: t('common.editFile'),
                    filePath: skill.filePath,
                  }}
                />
              </div>
              <div className="overflow-hidden rounded-xl border border-border/60 bg-foreground/[0.018]">
                <Info_Markdown maxHeight={420} fullscreen className="px-4 py-4">
                  {skill.content || t('skillInfo.noInstructions')}
                </Info_Markdown>
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

export default function SkillsCatalogPage() {
  const { t } = useTranslation()
  const {
    workspaces,
    activeWorkspaceId,
    skillsSnapshot,
    onSkillsSnapshotChange,
    onDeleteSkill,
    onToggleSkill,
    onTrustProjectSkills,
  } = useAppShellContext()
  const [filter, setFilter] = React.useState<SkillFilter>('all')
  const [query, setQuery] = React.useState('')
  const [selectedSkillId, setSelectedSkillId] = React.useState<string | null>(null)

  const snapshot = skillsSnapshot
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId)
  const selectedSkill = snapshot?.entries.find((entry) => entry.skillId === selectedSkillId) ?? null
  const entries = React.useMemo(() => {
    if (!snapshot) return []
    const needle = query.trim().toLocaleLowerCase()
    return snapshot.entries
      .filter((entry) => {
        if (filter === 'enabled' && (!entry.enabled || entry.trust === 'untrusted')) return false
        if (!needle) return true
        return [entry.metadata.name, entry.metadata.description, entry.slug, entry.source]
          .join(' ')
          .toLocaleLowerCase()
          .includes(needle)
      })
      .sort((a, b) => {
        if (a.winner !== b.winner) return a.winner ? -1 : 1
        return a.metadata.name.localeCompare(b.metadata.name)
      })
  }, [filter, query, snapshot])

  const enabledCount = snapshot?.entries.filter(
    (entry) => entry.enabled && entry.trust !== 'untrusted',
  ).length ?? 0
  const installTargets = snapshot?.tiers
    .map((tier) => tier.source)
    .filter((source) => source !== 'builtin') ?? []
  const projectTier = snapshot?.tiers.find((tier) => tier.source === 'project')
  // The root to offer trust for — set only when there is something to trust.
  const untrustedProjectRoot =
    projectTier?.trust === 'untrusted' && snapshot?.entries.some((entry) => entry.source === 'project')
      ? snapshot.projectRoot
      : undefined

  if (!snapshot || !activeWorkspaceId) return null

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title={t('sidebar.allSkills')} />
      <div className="min-h-0 flex-1 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-5xl px-5 py-8 @md/panel:px-8 @lg/panel:py-10">
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              {t('skillsCatalog.eyebrow')}
            </div>
            <div className="flex flex-col gap-5 @md/panel:flex-row @md/panel:items-end @md/panel:justify-between">
              <div>
                <h2 className="max-w-2xl text-3xl font-semibold leading-[1.08] tracking-[-0.045em] @lg/panel:text-4xl">
                  {t('skillsCatalog.title')}
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {t('skillsCatalog.description')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {activeWorkspace?.dataRoot && (
                  <EditPopover
                    trigger={
                      <Button size="sm" variant="outline" className="gap-1.5">
                        <Plus className="size-3.5" />
                        {t('skillsList.addSkill')}
                      </Button>
                    }
                    {...getEditConfig('add-skill', activeWorkspace.dataRoot)}
                  />
                )}
                <SkillImportMenu
                  workspaceId={activeWorkspaceId}
                  targets={installTargets}
                  onInstalled={(next) => onSkillsSnapshotChange?.(next)}
                  trigger={
                    <Button size="sm" className="gap-1.5">
                      <Plus className="size-3.5" />
                      {t('skillsCatalog.import')}
                    </Button>
                  }
                />
              </div>
            </div>

            <div className="mt-8 flex flex-col gap-2 @md/panel:flex-row @md/panel:items-center">
              <div className="inline-flex w-fit rounded-lg border border-border/60 bg-foreground/[0.025] p-0.5">
                {([
                  ['all', t('skillsCatalog.filterAll', { count: snapshot.entries.length })],
                  ['enabled', t('skillsCatalog.filterEnabled', { count: enabledCount })],
                ] as Array<[SkillFilter, string]>).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setFilter(id)}
                    className={cn(
                      'h-7 rounded-md px-3 text-xs font-medium transition-colors',
                      filter === id
                        ? 'bg-background text-foreground shadow-minimal'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="flex h-9 min-w-48 flex-1 items-center gap-2 rounded-lg border border-border/60 bg-background px-3 focus-within:border-foreground/25">
                <Search className="size-3.5 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('skillsList.searchPlaceholder')}
                  className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                />
                {query && (
                  <button type="button" onClick={() => setQuery('')} aria-label={t('common.clear')}>
                    <X className="size-3.5 text-muted-foreground" />
                  </button>
                )}
              </label>
            </div>

            {untrustedProjectRoot && (
              <div className="mt-5 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/[0.055] px-4 py-3">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs leading-5 text-foreground/80">{t('skillsList.untrustedProject')}</p>
                  <button
                    type="button"
                    onClick={() => onTrustProjectSkills?.(untrustedProjectRoot)}
                    className="mt-2 text-xs font-medium text-foreground underline underline-offset-4"
                  >
                    {t('skillsList.trustProject')}
                  </button>
                </div>
              </div>
            )}

            <div className="mt-7 flex items-baseline justify-between gap-4">
              <h3 className="text-sm font-semibold">{t('skillsCatalog.allSkills')}</h3>
              <span className="text-[11px] text-muted-foreground">
                {t('skillsCatalog.resultCount', { count: entries.length })}
              </span>
            </div>

            {entries.length === 0 ? (
              <div className="mt-3 grid min-h-56 place-items-center rounded-xl border border-dashed border-border/70">
                <div className="text-center">
                  <Zap className="mx-auto size-5 text-muted-foreground" />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {query ? t('skillsList.noMatches') : t('skillsList.noSkillsConfigured')}
                  </p>
                </div>
              </div>
            ) : (
              <div className="mt-3 grid overflow-hidden rounded-xl border border-border/60 bg-border/60 @lg/panel:grid-cols-2">
                {entries.map((skill) => (
                  <SkillCard
                    key={skill.skillId}
                    skill={skill}
                    allEntries={snapshot.entries}
                    workspaceId={activeWorkspaceId}
                    onOpen={() => setSelectedSkillId(skill.skillId)}
                    onToggle={(enabled) => onToggleSkill?.(skill.skillId, enabled)}
                    onDelete={
                      skill.source === 'workspace'
                        ? () => onDeleteSkill?.(skill.skillId)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
      <SkillDetailDialog
        skill={selectedSkill}
        allEntries={snapshot.entries}
        workspaceId={activeWorkspaceId}
        onClose={() => setSelectedSkillId(null)}
        onToggle={(skill, enabled) => onToggleSkill?.(skill.skillId, enabled)}
        onDelete={(skill) => onDeleteSkill?.(skill.skillId)}
      />
    </div>
  )
}
