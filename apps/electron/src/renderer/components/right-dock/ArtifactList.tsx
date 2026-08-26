/**
 * The row list shared by the Artifacts and Changes panels.
 *
 * Rows never read files. Clicking one calls the same `onOpenFile` the chat
 * transcript uses, so the interceptor decides preview vs. system opener — there
 * is no second behaviour where the dock can show something the chat cannot.
 *
 * Renders inline — the surrounding section owns scrolling.
 */

import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Code2,
  FileJson,
  FileText,
  FileType2,
  Globe,
  Image as ImageIcon,
  MoreHorizontal,
  File as GenericFile,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import type { SessionArtifact } from '../../../shared/types'
import { getFileManagerName } from '@/lib/platform'
import { useAppShellContext } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'

const KIND_ICONS: Record<SessionArtifact['kind'], typeof GenericFile> = {
  html: Globe,
  markdown: FileText,
  pdf: FileType2,
  image: ImageIcon,
  json: FileJson,
  code: Code2,
  text: FileText,
  office: FileType2,
  other: GenericFile,
}

/** Short, human relative time. Precision beyond "when roughly" is noise here. */
function formatRelativeTime(timestamp: number | undefined, locale: string): string {
  if (!timestamp) return ''
  const deltaMinutes = Math.round((timestamp - Date.now()) / 60_000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })

  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, 'minute')
  const deltaHours = Math.round(deltaMinutes / 60)
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, 'hour')
  return formatter.format(Math.round(deltaHours / 24), 'day')
}

function lastTouchedAt(artifact: SessionArtifact): number | undefined {
  if (artifact.modifiedAt !== undefined) return artifact.modifiedAt
  return artifact.revisions[artifact.revisions.length - 1]?.timestamp
}

interface ArtifactRowProps {
  artifact: SessionArtifact
  onOpen: (path: string) => void
}

function ArtifactRow({ artifact, onOpen }: ArtifactRowProps) {
  const { t, i18n } = useTranslation()
  const Icon = KIND_ICONS[artifact.kind]

  // A remote WebUI has no Finder to talk to; only offer it when the host does.
  const canReveal = window.electronAPI.isChannelAvailable(RPC_CHANNELS.shell.SHOW_IN_FOLDER)

  const handleCopyPath = useCallback(() => {
    void navigator.clipboard.writeText(artifact.path)
    toast.success(t('artifacts.pathCopied'))
  }, [artifact.path, t])

  const subtitle = [
    artifact.relativePath,
    artifact.exists ? formatRelativeTime(lastTouchedAt(artifact), i18n.language) : t('artifacts.missing'),
    artifact.revisions.length > 1 ? t('artifacts.revisions', { count: artifact.revisions.length }) : '',
  ].filter(Boolean).join(' · ')

  return (
    <div className="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-foreground/[0.04]">
      <button
        type="button"
        onClick={() => artifact.exists && onOpen(artifact.path)}
        disabled={!artifact.exists}
        title={artifact.path}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 text-left',
          artifact.exists ? 'cursor-pointer' : 'cursor-default opacity-50',
        )}
      >
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-foreground/90">{artifact.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{subtitle}</span>
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('artifacts.moreActions')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-foreground/40 opacity-0 transition-opacity hover:bg-foreground/[0.06] focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <StyledDropdownMenuContent align="end">
          <StyledDropdownMenuItem
            onClick={() => onOpen(artifact.path)}
            disabled={!artifact.exists}
          >
            {t('artifacts.open')}
          </StyledDropdownMenuItem>
          {canReveal && (
            <StyledDropdownMenuItem
              onClick={() => window.electronAPI.showInFolder(artifact.path)}
              disabled={!artifact.exists}
            >
              {t('artifacts.showInFileManager', { fileManager: getFileManagerName() })}
            </StyledDropdownMenuItem>
          )}
          <StyledDropdownMenuItem onClick={handleCopyPath}>
            {t('artifacts.copyPath')}
          </StyledDropdownMenuItem>
        </StyledDropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export interface ArtifactListProps {
  artifacts: SessionArtifact[]
  emptyTitle: string
  emptyDescription: string
}

export function ArtifactList({ artifacts, emptyTitle, emptyDescription }: ArtifactListProps) {
  const { onOpenFile } = useAppShellContext()

  // Inline empty state, not a centered hero: the list sits inside an expanded
  // section with siblings under it, so it has to occupy the space it needs and
  // no more.
  if (artifacts.length === 0) {
    return (
      <div className="px-4 pb-1">
        <p className="text-[11px] leading-relaxed text-foreground/45">
          <span className="text-foreground/60">{emptyTitle}</span>
          {' · '}
          {emptyDescription}
        </p>
      </div>
    )
  }

  return (
    <div className="grid gap-0.5 px-2">
      {artifacts.map((artifact) => (
        <ArtifactRow key={artifact.path} artifact={artifact} onOpen={onOpenFile} />
      ))}
    </div>
  )
}
