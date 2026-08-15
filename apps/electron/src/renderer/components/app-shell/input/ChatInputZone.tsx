import * as React from 'react'
import { cn } from '@/lib/utils'
import { CHAT_LAYOUT } from '@/config/layout'
import type { PermissionMode } from '@bitlab/shared/agent/modes'
import type { BackgroundTask } from '../ActiveTasksBar'
import { ActiveOptionBadges } from '../ActiveOptionBadges'
import { InputContainer } from './InputContainer'
import { InputErrorBoundary } from './InputErrorBoundary'

interface ChatInputZoneProps {
  compactMode?: boolean
  showOptionBadges?: boolean
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  tasks?: BackgroundTask[]
  sessionId: string
  sessionFolderPath?: string
  onKillTask?: (taskId: string) => void
  onInsertMessage?: (text: string) => void
  className?: string
  inputProps: React.ComponentProps<typeof InputContainer>
}

export function ChatInputZone({
  compactMode = false,
  showOptionBadges,
  permissionMode = 'ask',
  onPermissionModeChange,
  tasks = [],
  sessionId,
  sessionFolderPath,
  onKillTask,
  onInsertMessage,
  className,
  inputProps,
}: ChatInputZoneProps) {
  const shouldShowOptionBadges = showOptionBadges ?? !compactMode
  const inputResetKey = `${sessionId}::${inputProps.structuredInput?.type ?? 'freeform'}`

  const handleClearDraft = React.useCallback(() => {
    inputProps.onInputChange?.('')
    inputProps.onAttachmentsChange?.([])
  }, [inputProps])

  return (
    <div className={cn(
      CHAT_LAYOUT.maxWidth,
      'mx-auto w-full mt-1',
      compactMode ? 'px-3 pb-3' : 'px-6 @xs/panel:px-10 pb-8',
      className,
    )}>
      {shouldShowOptionBadges && (
        <ActiveOptionBadges
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          tasks={tasks}
          sessionId={sessionId}
          sessionFolderPath={sessionFolderPath}
          onKillTask={onKillTask}
          onInsertMessage={onInsertMessage ?? inputProps.onInputChange}
        />
      )}

      <InputErrorBoundary
        sessionId={sessionId}
        resetKey={inputResetKey}
        onClearDraft={handleClearDraft}
      >
        <InputContainer
          {...inputProps}
          compactMode={compactMode}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          sessionFolderPath={sessionFolderPath}
          sessionId={sessionId}
        />
      </InputErrorBoundary>
    </div>
  )
}
