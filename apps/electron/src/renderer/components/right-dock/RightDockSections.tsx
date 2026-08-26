/**
 * The dock's stacked, collapsible sections.
 *
 * Shared by the desktop column and the compact sheet — the layout around them
 * changes, the content does not.
 *
 * Artifacts and changes render inline and let the column scroll as one. The
 * file tree keeps its own bounded scroll: it is the one section that can run to
 * hundreds of rows, and letting it push the others off-screen would defeat the
 * point of having them side by side.
 */

import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SessionArtifact } from '../../../shared/types'
import type { RightDockSection } from '@/atoms/right-dock'
import { SessionFilesSection } from '../right-sidebar/SessionFilesSection'
import { cn } from '@/lib/utils'
import { ArtifactList } from './ArtifactList'

interface SectionProps {
  label: string
  count?: number
  isExpanded: boolean
  onToggle: () => void
  children: React.ReactNode
}

function Section({ label, count, isExpanded, onToggle, children }: SectionProps) {
  return (
    <section className="border-b border-border/30 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full items-center gap-1.5 px-2 py-2 text-left transition-colors hover:bg-foreground/[0.03]"
      >
        <ChevronRight
          className={cn('h-3 w-3 shrink-0 text-foreground/40 transition-transform', isExpanded && 'rotate-90')}
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/70">{label}</span>
        {count !== undefined && count > 0 && (
          <span className="shrink-0 rounded-[4px] bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] tabular-nums text-foreground/60">
            {count}
          </span>
        )}
      </button>

      {isExpanded && <div className="pb-2">{children}</div>}
    </section>
  )
}

export interface RightDockSectionsProps {
  activeSessionId?: string | null
  artifacts: SessionArtifact[]
  changes: SessionArtifact[]
  expanded: Record<RightDockSection, boolean>
  onToggleSection: (section: RightDockSection) => void
}

export function RightDockSections({
  activeSessionId,
  artifacts,
  changes,
  expanded,
  onToggleSection,
}: RightDockSectionsProps) {
  const { t } = useTranslation()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <Section
        label={t('artifacts.title')}
        count={artifacts.length}
        isExpanded={expanded.artifacts}
        onToggle={() => onToggleSection('artifacts')}
      >
        <ArtifactList
          artifacts={artifacts}
          emptyTitle={t('artifacts.empty')}
          emptyDescription={t('artifacts.emptyDescription')}
        />
      </Section>

      <Section
        label={t('artifacts.changesTab')}
        count={changes.length}
        isExpanded={expanded.changes}
        onToggle={() => onToggleSection('changes')}
      >
        <ArtifactList
          artifacts={changes}
          emptyTitle={t('artifacts.changesEmpty')}
          emptyDescription={t('artifacts.changesEmptyDescription')}
        />
      </Section>

      <Section
        label={t('artifacts.filesTab')}
        isExpanded={expanded.files}
        onToggle={() => onToggleSection('files')}
      >
        {/* Capped rather than fixed: a two-file session should not reserve
            320px of blank column under it. */}
        <div className="flex max-h-[min(45vh,320px)] flex-col overflow-hidden">
          <SessionFilesSection sessionId={activeSessionId ?? undefined} hideHeader />
        </div>
      </Section>
    </div>
  )
}
