/**
 * Import entry point: pick a source, look at what it would install, decide.
 *
 * The preview is not optional. Every path here stages the source and stops,
 * because the point is that the user reads the instructions before they land
 * on disk (docs/skills-design.md §4, §7.1).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { toast } from 'sonner'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SkillInstallPreview } from './SkillInstallPreview'
import type { CatalogSnapshot, InstallPlan, InstallSource, SkillSource } from '../../../shared/types'

export interface SkillImportMenuProps {
  workspaceId: string
  /** Tiers the user may install into, in display order. */
  targets: readonly SkillSource[]
  onInstalled: (snapshot: CatalogSnapshot) => void
  trigger?: React.ReactNode
}

export function SkillImportMenu({ workspaceId, targets, onInstalled, trigger }: SkillImportMenuProps) {
  const { t } = useTranslation()
  const [plan, setPlan] = React.useState<InstallPlan | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [gitOpen, setGitOpen] = React.useState(false)
  const [gitUrl, setGitUrl] = React.useState('')

  const preview = React.useCallback(
    async (source: InstallSource) => {
      setBusy(true)
      try {
        setPlan(await window.electronAPI.previewSkillInstall(workspaceId, source, targets[0] ?? 'workspace'))
      } catch (error) {
        toast.error(t('skillInstall.failed'), {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setBusy(false)
      }
    },
    [workspaceId, targets, t]
  )

  const pickFolder = React.useCallback(async () => {
    const folder = await window.electronAPI.openFolderDialog()
    if (folder) void preview({ kind: 'folder', location: folder })
  }, [preview])

  const pickZip = React.useCallback(async () => {
    const files = await window.electronAPI.openFileDialog()
    const archive = files?.find((file) => file.toLowerCase().endsWith('.zip'))
    if (archive) void preview({ kind: 'zip', location: archive })
  }, [preview])

  const submitGit = React.useCallback(() => {
    const url = gitUrl.trim()
    if (!url) return
    setGitOpen(false)
    setGitUrl('')
    void preview({ kind: 'git', location: url })
  }, [gitUrl, preview])

  // Both outcomes go through the same call: the staging directory has to be
  // cleaned up whether or not the user went ahead.
  const resolve = React.useCallback(
    async (confirmed: boolean, target?: SkillSource) => {
      if (!plan) return
      setBusy(true)
      try {
        const snapshot = await window.electronAPI.importSkill(
          workspaceId,
          plan,
          target ?? targets[0] ?? 'workspace',
          confirmed
        )
        onInstalled(snapshot)
        if (confirmed) toast.success(t('skillInstall.installed', { name: plan.slug }))
      } catch (error) {
        toast.error(t('skillInstall.failed'), {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setBusy(false)
        setPlan(null)
      }
    },
    [plan, workspaceId, targets, onInstalled, t]
  )

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger ?? <HeaderIconButton icon={<Download className="h-4 w-4" />} tooltip={t('skillInstall.title')} />}
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="end" sideOffset={6}>
          <StyledDropdownMenuItem onSelect={() => void pickFolder()}>
            {t('skillInstall.addFolder')}
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={() => void pickZip()}>
            {t('skillInstall.addZip')}
          </StyledDropdownMenuItem>
          <StyledDropdownMenuItem onSelect={() => setGitOpen(true)}>
            {t('skillInstall.addGit')}
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>

      <Dialog open={gitOpen} onOpenChange={setGitOpen}>
        <DialogContent className="max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{t('skillInstall.addGit')}</DialogTitle>
          </DialogHeader>
          <input
            autoFocus
            value={gitUrl}
            onChange={(event) => setGitUrl(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submitGit() }}
            placeholder={t('skillInstall.gitPrompt')}
            className="w-full h-8 px-2.5 text-sm rounded-[8px] border border-border/60 bg-transparent focus:outline-none focus:border-foreground/30"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setGitOpen(false)}
              className="h-8 px-3 text-xs font-medium rounded-[8px] hover:bg-foreground/5 transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              type="button"
              onClick={submitGit}
              disabled={!gitUrl.trim()}
              className="h-8 px-3 text-xs font-medium rounded-[8px] bg-foreground/10 hover:bg-foreground/15 transition-colors disabled:opacity-50"
            >
              {t('common.continue')}
            </button>
          </div>
        </DialogContent>
      </Dialog>

      <SkillInstallPreview
        plan={plan}
        targets={targets}
        busy={busy}
        onConfirm={(target) => void resolve(true, target)}
        onCancel={() => void resolve(false)}
      />
    </>
  )
}
