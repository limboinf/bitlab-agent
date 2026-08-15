/**
 * Install preview — the security surface.
 *
 * A skill is executable instruction text. Nothing is written to disk until the
 * user has seen the instructions that will run on their behalf, which is why
 * the full SKILL.md is rendered here rather than summarised
 * (docs/skills-design.md §4, §7.1).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, FileCode2, ShieldAlert } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { InstallPlan, SkillSource } from '../../../shared/types'

export interface SkillInstallPreviewProps {
  plan: InstallPlan | null
  /** Tiers the user may install into, in display order. */
  targets: readonly SkillSource[]
  busy?: boolean
  onConfirm: (target: SkillSource) => void
  onCancel: () => void
}

const TIER_LABEL_KEY: Record<SkillSource, string> = {
  project: 'skillsList.tierProject',
  workspace: 'skillsList.tierWorkspace',
  global: 'skillsList.tierGlobal',
  builtin: 'skillsList.tierBuiltin',
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function SkillInstallPreview({
  plan,
  targets,
  busy,
  onConfirm,
  onCancel,
}: SkillInstallPreviewProps) {
  const { t } = useTranslation()
  const [target, setTarget] = React.useState<SkillSource>(targets[0] ?? 'workspace')

  React.useEffect(() => {
    if (targets.length) setTarget(targets[0]!)
  }, [targets, plan])

  if (!plan) return null

  const scripts = plan.files.filter((file) => file.executable)
  const errors = plan.diagnostics.filter((d) => d.level === 'error')
  const warnings = plan.diagnostics.filter((d) => d.level === 'warning')

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onCancel() }}>
      <DialogContent className="max-w-[720px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {plan.metadata?.icon && <span aria-hidden>{plan.metadata.icon}</span>}
            {plan.slug || t('skillInstall.title')}
          </DialogTitle>
          <DialogDescription>
            {plan.metadata?.description ?? t('skillInstall.rejectedDescription')}
          </DialogDescription>
        </DialogHeader>

        {plan.rejection ? (
          <div className="rounded-[8px] border border-destructive/30 bg-destructive/5 px-3 py-2.5 flex items-start gap-2">
            <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm text-foreground/85">{t(`skillInstall.rejection.${plan.rejection}`)}</p>
              {errors.map((diagnostic) => (
                <p key={diagnostic.code} className="mt-1 text-xs text-muted-foreground break-words">
                  {diagnostic.message}
                </p>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 min-h-0">
            {/* What the skill asks for. The grant lasts one turn and widens
                only — safe mode and dangerous commands still prompt. */}
            {plan.metadata?.allowedTools?.length ? (
              <div className="rounded-[8px] border border-border/60 px-3 py-2.5">
                <p className="text-xs text-foreground/70">{t('skillInstall.declaresTools')}</p>
                <p className="mt-1 font-mono text-[11px] text-foreground/80 break-words">
                  {plan.metadata.allowedTools.join('  ')}
                </p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">{t('skillInstall.toolsScope')}</p>
              </div>
            ) : null}

            {plan.metadata?.disallowedTools?.length ? (
              <div className="rounded-[8px] border border-border/60 px-3 py-2.5">
                <p className="text-xs text-foreground/70">{t('skillInstall.declaresDisallowed')}</p>
                <p className="mt-1 font-mono text-[11px] text-foreground/80 break-words">
                  {plan.metadata.disallowedTools.join('  ')}
                </p>
              </div>
            ) : null}

            {plan.metadata?.compatibility && (
              <p className="text-xs text-muted-foreground">
                {t('skillInfo.compatibility')}: {plan.metadata.compatibility}
              </p>
            )}

            <div className="grid grid-cols-2 gap-3 min-h-0">
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground/70 mb-1.5">
                  {t('skillInstall.contents', { count: plan.files.length })}
                </p>
                <div className="rounded-[8px] border border-border/60 max-h-[220px] overflow-y-auto">
                  {plan.files.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] border-b border-border/30 last:border-b-0"
                    >
                      <span className="flex items-center gap-1.5 min-w-0 truncate">
                        {file.executable && <FileCode2 className="h-3 w-3 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{file.path}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {formatBytes(file.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
                {scripts.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-muted-foreground">
                    {t('skillInstall.scriptsNote', { count: scripts.length })}
                  </p>
                )}
              </div>

              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground/70 mb-1.5">{t('skillInstall.source')}</p>
                <pre className="rounded-[8px] border border-border/60 max-h-[220px] overflow-auto px-2.5 py-2 text-[11px] leading-relaxed whitespace-pre-wrap break-words">
                  {plan.skillMarkdown}
                </pre>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-foreground/70 mb-1.5">{t('skillInstall.installTo')}</p>
              <div className="flex flex-wrap gap-1.5">
                {targets.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    onClick={() => setTarget(tier)}
                    className={cn(
                      'h-7 px-3 text-xs rounded-[8px] border transition-colors',
                      tier === target
                        ? 'border-foreground/30 bg-foreground/5 text-foreground'
                        : 'border-border/60 text-muted-foreground hover:bg-foreground/[0.03]'
                    )}
                  >
                    {t(TIER_LABEL_KEY[tier])}
                  </button>
                ))}
              </div>
            </div>

            {plan.conflictsWith && (
              <div className="rounded-[8px] border border-border/60 bg-foreground/[0.02] px-3 py-2 flex items-start gap-2">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                <p className="text-xs text-foreground/75">
                  {t('skillInstall.conflict', { name: plan.slug })}
                </p>
              </div>
            )}

            {warnings.map((diagnostic) => (
              <p key={diagnostic.code} className="text-[11px] text-muted-foreground">
                {diagnostic.message}
              </p>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 px-3 text-xs font-medium rounded-[8px] hover:bg-foreground/5 transition-colors"
          >
            {t('common.cancel')}
          </button>
          {!plan.rejection && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onConfirm(target)}
              className="h-8 px-3 text-xs font-medium rounded-[8px] bg-foreground/10 hover:bg-foreground/15 transition-colors disabled:opacity-50"
            >
              {t('skillInstall.install')}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
