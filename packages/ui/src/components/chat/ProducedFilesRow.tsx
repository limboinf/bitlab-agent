/**
 * ProducedFilesRow — the artifacts one finished turn produced.
 *
 * It sits under the final response as the closing move of a turn: the agent
 * says what it did, and right there is the thing it made. Membership comes
 * from successful write tools in that turn, never from the answer's prose — a
 * model claiming "I created report.html" does not make a file appear.
 *
 * Deliberately small: six chips, one line, no scrolling. When there is more
 * than that, "view all" hands off to the dock, which is built for browsing.
 */

import { useTranslation } from 'react-i18next'
import { cn } from '../../lib/utils'

/** The subset of a SessionArtifact this row needs. */
export interface ProducedFile {
  path: string
  name: string
}

/** Chips beyond this go behind the overflow count; the row must stay one line. */
export const MAX_PRODUCED_CHIPS = 6

export interface ProducedFilesRowProps {
  files: ProducedFile[]
  onOpenFile?: (path: string) => void
  /** Opens the artifacts panel. Omitted when there is nowhere to send the user. */
  onViewAll?: () => void
  className?: string
}

export function ProducedFilesRow({ files, onOpenFile, onViewAll, className }: ProducedFilesRowProps) {
  const { t } = useTranslation()

  if (files.length === 0) return null

  const visible = files.slice(0, MAX_PRODUCED_CHIPS)
  const overflow = files.length - visible.length

  return (
    <div
      data-testid="produced-files-row"
      className={cn('mt-2 flex min-w-0 items-center gap-2 text-[11px]', className)}
    >
      <span className="shrink-0 select-none text-muted-foreground">
        {t('artifacts.producedLabel')}
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
        {visible.map((file) => (
          <button
            key={file.path}
            type="button"
            onClick={() => onOpenFile?.(file.path)}
            title={file.path}
            className={cn(
              'flex min-w-0 max-w-[180px] items-center rounded-md bg-foreground/[0.06] px-2 py-0.5',
              'text-foreground/80 transition-colors hover:bg-foreground/10',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            )}
          >
            <span className="truncate">{file.name}</span>
          </button>
        ))}

        {overflow > 0 && (
          <span className="shrink-0 select-none px-1 text-muted-foreground">
            {t('artifacts.moreFiles', { count: overflow })}
          </span>
        )}
      </div>

      {onViewAll && (
        <button
          type="button"
          onClick={onViewAll}
          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:underline"
        >
          {t('artifacts.viewAll')}
        </button>
      )}
    </div>
  )
}
