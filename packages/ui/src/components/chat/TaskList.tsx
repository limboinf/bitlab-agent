/**
 * TaskList — the rows of the agent's `todo_write` checklist.
 *
 * Rows only. The chrome around them (header, collapse, placement) belongs to
 * whoever mounts the list, so the strip above the composer and any future
 * surface stay one component apart instead of two copies of the same rows.
 */

import { motion } from 'motion/react'
import { Ban, Circle, CircleCheck, CircleDashed } from 'lucide-react'
import { Spinner } from '../ui/LoadingIndicator'
import { cn } from '../../lib/utils'
import { SIZE_CONFIG, type TodoItem, type TodoStatus } from './TurnCard'

/**
 * Status glyph. `interrupted` is UI-only: a turn the user stopped mid-task.
 *
 * `live` is what keeps the list honest once the agent stops. A task is only
 * spinning if something is actually working on it — after the turn ends, a
 * task still marked `in_progress` means the agent finished without ticking it
 * off, so it renders as unfinished rather than perpetually in flight.
 */
export function TaskStatusIcon({ status, live = true }: { status: TodoStatus; live?: boolean }) {
  switch (status) {
    case 'pending':
      return <Circle className={cn(SIZE_CONFIG.iconSize, 'shrink-0 text-muted-foreground/50')} />
    case 'in_progress':
      if (!live) {
        return <CircleDashed className={cn(SIZE_CONFIG.iconSize, 'shrink-0 text-muted-foreground/50')} />
      }
      return (
        <div className={cn(SIZE_CONFIG.iconSize, 'flex items-center justify-center shrink-0')}>
          <Spinner className={SIZE_CONFIG.spinnerSize} />
        </div>
      )
    case 'completed':
      return <CircleCheck className={cn(SIZE_CONFIG.iconSize, 'shrink-0 text-accent')} />
    case 'interrupted':
      return <Ban className={cn(SIZE_CONFIG.iconSize, 'shrink-0 text-muted-foreground/50')} />
  }
}

export function TaskRow({ todo, live = true }: { todo: TodoItem; live?: boolean }) {
  return (
    <div className={cn(
      'flex items-center gap-2 py-0.5 text-muted-foreground',
      SIZE_CONFIG.fontSize,
      todo.status === 'completed' && 'opacity-50',
    )}>
      <TaskStatusIcon status={todo.status} live={live} />
      <span className={cn('truncate flex-1', todo.status === 'completed' && 'line-through')}>
        {todo.content}
      </span>
    </div>
  )
}

export interface TaskListProps {
  todos: readonly TodoItem[]
  /** Whether the agent is still working — false freezes the running glyph. */
  live?: boolean
  className?: string
}

export function TaskList({ todos, live = true, className }: TaskListProps) {
  if (todos.length === 0) return null

  return (
    <div className={cn('space-y-0.5', className)}>
      {todos.map((todo, index) => (
        <motion.div
          key={todo.content}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.03 }}
        >
          <TaskRow todo={todo} live={live} />
        </motion.div>
      ))}
    </div>
  )
}
