import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  SlashCommandMenu,
  buildPermissionModeGroups,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'
import { ChevronDown, Info } from 'lucide-react'
import { DEFAULT_CYCLABLE_PERMISSION_MODES, type PermissionMode } from '@bitlab/shared/agent/modes'
import { ActiveTasksBar, type BackgroundTask } from './ActiveTasksBar'
import type { TerminalOverlayData } from './TaskActionMenu'
import { SessionInfoPopover } from './SessionInfoPopover'
import { PermissionModeIcon } from '@/components/ui/permission-mode-icon'
import {
  PermissionModePanel,
  PERMISSION_CHIP_STYLES,
  permissionModeLabelKey,
  usesSimplePermissionPanel,
} from './input/PermissionModePanel'

export interface ActiveOptionBadgesProps {
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId?: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  onShowTerminalOverlay?: (data: TerminalOverlayData) => void
  className?: string
}

/**
 * Surfaces active background tasks above the input.
 * Permission mode + session info live inside FreeFormInput's toolbar so the
 * composer reads as one component (not floating islands).
 */
export function ActiveOptionBadges({
  tasks = [],
  sessionId,
  onKillTask,
  onInsertMessage,
  onShowTerminalOverlay,
  className,
}: ActiveOptionBadgesProps) {
  if (tasks.length === 0 || !sessionId) return null

  return (
    <div className={cn('mb-2 flex flex-wrap items-center gap-2 px-px', className)}>
      <ActiveTasksBar
        tasks={tasks}
        sessionId={sessionId}
        onKillTask={onKillTask}
        onInsertMessage={onInsertMessage}
        onShowTerminalOverlay={onShowTerminalOverlay}
      />
    </div>
  )
}

interface PermissionModeDropdownProps {
  permissionMode: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  enabledModes?: PermissionMode[]
  sessionId?: string
  /** Compact toolbar style — fits FreeFormInput bottom bar */
  compact?: boolean
}

/** Permission mode control — used inside FreeFormInput toolbar. */
export function PermissionModeDropdown({
  permissionMode,
  onPermissionModeChange,
  enabledModes = DEFAULT_CYCLABLE_PERMISSION_MODES,
  sessionId,
  compact = false,
}: PermissionModeDropdownProps) {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const [optimisticMode, setOptimisticMode] = React.useState(permissionMode)

  React.useEffect(() => {
    setOptimisticMode(permissionMode)
  }, [permissionMode])

  const activeCommands = React.useMemo(
    (): SlashCommandId[] => [optimisticMode as SlashCommandId],
    [optimisticMode],
  )

  const applyMode = React.useCallback((mode: PermissionMode) => {
    setOptimisticMode(mode)
    onPermissionModeChange?.(mode)
  }, [onPermissionModeChange])

  const handleSelect = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe' || commandId === 'ask' || commandId === 'allow-all') {
      applyMode(commandId)
    }
    setOpen(false)
  }, [applyMode])

  const modeGroups = React.useMemo(
    () => buildPermissionModeGroups(enabledModes),
    [enabledModes],
  )

  const currentStyle = PERMISSION_CHIP_STYLES

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-tutorial="permission-mode-dropdown"
          className={cn(
            'flex shrink-0 items-center gap-1.5 font-medium outline-none select-none',
            compact
              ? cn(
                  'input-toolbar-btn h-7 rounded-[6px] px-1.5 text-[13px] transition-colors',
                  'hover:bg-foreground/5 data-[state=open]:bg-foreground/5',
                  optimisticMode === 'allow-all' ? 'text-accent' : 'text-foreground/70',
                )
              : cn(
                  'h-[30px] rounded-[8px] pl-2.5 pr-2 text-xs shadow-tinted',
                  currentStyle[optimisticMode].className,
                ),
          )}
          style={compact
            ? undefined
            : { '--shadow-color': currentStyle[optimisticMode].shadowVar } as React.CSSProperties}
        >
          <PermissionModeIcon mode={optimisticMode} className="h-3.5 w-3.5" />
          <span>{t(permissionModeLabelKey(optimisticMode))}</span>
          <ChevronDown className={cn('opacity-60', compact ? 'h-3 w-3' : 'h-3.5 w-3.5')} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-auto rounded-[8px] bg-background p-0 text-foreground shadow-modal-small"
        side="top"
        align="start"
        sideOffset={4}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0
          if (!isTouchDevice) {
            window.dispatchEvent(new CustomEvent('craft:focus-input', {
              detail: { sessionId },
            }))
          }
        }}
      >
        {usesSimplePermissionPanel(enabledModes) ? (
          <PermissionModePanel
            permissionMode={optimisticMode}
            enabledModes={enabledModes}
            onPermissionModeChange={(mode) => {
              applyMode(mode)
              setOpen(false)
            }}
          />
        ) : (
          <SlashCommandMenu
            commandGroups={modeGroups}
            activeCommands={activeCommands}
            onSelect={handleSelect}
            showFilter
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Session info trigger sized for FreeFormInput toolbar. */
export function SessionInfoToolbarButton({
  sessionId,
  sessionFolderPath,
}: {
  sessionId?: string
  sessionFolderPath?: string
}) {
  const { t } = useTranslation()
  if (!sessionId) return null

  return (
    <SessionInfoPopover
      sessionId={sessionId}
      sessionFolderPath={sessionFolderPath}
      trigger={(
        <button
          type="button"
          className={cn(
            'input-toolbar-btn inline-flex h-7 shrink-0 items-center gap-1 rounded-[6px] px-1.5 text-[13px]',
            'text-foreground/70 transition-colors select-none',
            'hover:bg-foreground/5 data-[state=open]:bg-foreground/5',
            'outline-none focus-visible:ring-1 focus-visible:ring-ring',
          )}
          aria-label={t('common.info')}
        >
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span className="whitespace-nowrap">{t('common.info')}</span>
        </button>
      )}
    />
  )
}
