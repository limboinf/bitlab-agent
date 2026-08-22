/**
 * TaskListStrip — the agent's current checklist, docked above the composer.
 *
 * It holds no state of its own. The list is derived from the turn in progress
 * (see `getCurrentTaskList`), which is why the strip is empty between turns and
 * why it can never disagree with the transcript: there is one list, written by
 * one tool call, read in two places.
 *
 * Open by default — watching the checklist advance is the point. Long lists
 * scroll inside the strip rather than pushing the conversation off screen, and
 * the header alone still answers "how far along is it" once collapsed.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, ListTodo } from 'lucide-react'
import { TaskList, formatTaskListProgress, type TodoItem } from '@bitlab/ui'
import { cn } from '@/lib/utils'

export interface TaskListStripProps {
  todos?: readonly TodoItem[]
  /** Whether the agent is still working; a stopped turn freezes the glyphs. */
  live?: boolean
  className?: string
}

export function TaskListStrip({ todos, live = false, className }: TaskListStripProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = React.useState(true)

  if (!todos || todos.length === 0) return null

  return (
    <section
      className={cn(
        'mb-2 rounded-xl border border-border/60 bg-muted/30 overflow-hidden',
        className,
      )}
      aria-label={t('taskList.title')}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-muted/50 transition-colors"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
      >
        <ListTodo className="w-3.5 h-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{t('taskList.title')}</span>
        <span className="truncate text-muted-foreground">{formatTaskListProgress(todos, { live })}</span>
        <span className="ml-auto shrink-0 text-muted-foreground" aria-hidden>
          <ChevronDown
            className={cn('w-3.5 h-3.5 transition-transform', expanded && 'rotate-180')}
          />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <TaskList todos={todos} live={live} className="px-3 pb-2 max-h-52 overflow-y-auto" />
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  )
}
