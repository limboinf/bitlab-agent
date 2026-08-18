import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Check, CheckCheck, ChevronRight, Flag, Inbox, Plug, Settings, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuTrigger,
  StyledContextMenuContent,
} from '@/components/ui/styled-context-menu'
import { ContextMenuProvider } from '@/components/ui/menu-context'
import {
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
} from '@/components/ui/styled-dropdown'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { useFocusZone } from '@/hooks/keyboard'
import { mergeRefs } from '@/lib/merge-refs'
import * as storage from '@/lib/local-storage'
import type { Workspace } from '../../../shared/types'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'
import { SidebarMenu } from './SidebarMenu'
import { SquarePenRounded } from '../icons/SquarePenRounded'
import { PanelHeader } from './PanelHeader'

export type UnifiedNavigationSection = 'sessions' | 'skills' | 'mcp' | 'settings'
export type SessionNavigationView = 'all' | 'flagged' | 'archived'

interface UnifiedNavigationPanelProps {
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  workspaceUnreadMap?: Record<string, boolean>
  onSelectWorkspace: (workspaceId: string, openInNewWindow?: boolean) => void | Promise<void>
  onWorkspaceCreated?: (workspace: Workspace) => void
  onWorkspaceRemoved?: () => void
  newSessionHotkey: string | null
  onNewSession: (openInNewPanel: boolean) => void
  /** Return to the previous sessions location (chat / main). Used on skills/settings. */
  onReturnToSessions: () => void
  activeSection: UnifiedNavigationSection
  activeSessionView: SessionNavigationView
  title: string
  sessionCounts: {
    all: number
    flagged: number
    archived: number
  }
  onSelectSessionView: (view: SessionNavigationView) => void
  onMarkAllSessionsRead: () => void
  onSelectSection: (section: UnifiedNavigationSection) => void
  headerActions?: React.ReactNode
  children: React.ReactNode
}

export function UnifiedNavigationPanel({
  workspaces,
  activeWorkspaceId,
  workspaceUnreadMap,
  onSelectWorkspace,
  onWorkspaceCreated,
  onWorkspaceRemoved,
  newSessionHotkey,
  onNewSession,
  onReturnToSessions,
  activeSection,
  activeSessionView,
  title,
  sessionCounts,
  onSelectSessionView,
  onMarkAllSessionsRead,
  onSelectSection,
  headerActions,
  children,
}: UnifiedNavigationPanelProps) {
  const { t } = useTranslation()
  const navigationRootRef = React.useRef<HTMLDivElement>(null)
  const isSessionsSection = activeSection === 'sessions'
  const isCapabilitySection = activeSection === 'skills' || activeSection === 'mcp'
  const [extensionsOpen, setExtensionsOpen] = React.useState(() =>
    storage.get(storage.KEYS.sidebarExtensionsOpen, true),
  )

  React.useEffect(() => {
    if (activeSection === 'skills' || activeSection === 'mcp') {
      setExtensionsOpen(true)
      storage.set(storage.KEYS.sidebarExtensionsOpen, true)
    }
  }, [activeSection])

  const focusFirst = React.useCallback(() => {
    navigationRootRef.current
      ?.querySelector<HTMLElement>('[data-navigation-primary="true"]')
      ?.focus()
  }, [])
  const { zoneRef } = useFocusZone({ zoneId: 'sidebar', focusFirst })

  const setRootRef = React.useMemo(
    () => mergeRefs<HTMLDivElement>(navigationRootRef, zoneRef),
    [zoneRef],
  )

  const toggleExtensions = React.useCallback(() => {
    setExtensionsOpen((open) => {
      storage.set(storage.KEYS.sidebarExtensionsOpen, !open)
      return !open
    })
  }, [])

  const sessionTitleMenu = isSessionsSection ? (
    <>
      <SessionViewMenuItem
        icon={<Inbox className="h-3.5 w-3.5" />}
        label={t('sidebar.allSessions')}
        count={sessionCounts.all}
        selected={activeSessionView === 'all'}
        onSelect={() => onSelectSessionView('all')}
      />
      <SessionViewMenuItem
        icon={<Flag className="h-3.5 w-3.5" />}
        label={t('sidebar.flagged')}
        count={sessionCounts.flagged}
        selected={activeSessionView === 'flagged'}
        onSelect={() => onSelectSessionView('flagged')}
      />
      <StyledDropdownMenuSeparator />
      <SessionViewMenuItem
        icon={<Archive className="h-3.5 w-3.5" />}
        label={t('sidebar.archived')}
        count={sessionCounts.archived}
        selected={activeSessionView === 'archived'}
        onSelect={() => onSelectSessionView('archived')}
      />
      <StyledDropdownMenuSeparator />
      <StyledDropdownMenuItem onClick={onMarkAllSessionsRead}>
        <CheckCheck className="h-3.5 w-3.5" />
        <span className="flex-1">{t('sidebarMenu.markAllRead')}</span>
      </StyledDropdownMenuItem>
    </>
  ) : undefined

  return (
    <div ref={setRootRef} className="flex h-full min-w-0 flex-col select-none">
      <div className="shrink-0 px-2 pb-1 pt-1">
        <WorkspaceSwitcher
          variant="sidebar"
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSelect={onSelectWorkspace}
          onWorkspaceCreated={onWorkspaceCreated}
          onWorkspaceRemoved={onWorkspaceRemoved}
          workspaceUnreadMap={workspaceUnreadMap}
        />
      </div>

      <div className="shrink-0 px-2 pb-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <div>
              <ContextMenu modal>
                <ContextMenuTrigger asChild>
                  <button
                    type="button"
                    onClick={(event) => onNewSession(event.metaKey || event.ctrlKey)}
                    className={cn(
                      'flex h-8 w-full items-center justify-start gap-2 rounded-md px-2',
                      'text-left text-[13px] font-medium text-foreground/90',
                      'outline-none transition-colors hover:bg-foreground/4',
                      'focus-visible:bg-foreground/4 focus-visible:ring-1 focus-visible:ring-ring',
                    )}
                    data-navigation-primary="true"
                    data-tutorial="new-chat-button"
                  >
                    <SquarePenRounded className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                    <span className="truncate">{t('navigation.newChat')}</span>
                  </button>
                </ContextMenuTrigger>
                <StyledContextMenuContent>
                  <ContextMenuProvider>
                    <SidebarMenu type="newSession" />
                  </ContextMenuProvider>
                </StyledContextMenuContent>
              </ContextMenu>
            </div>
          </TooltipTrigger>
          {newSessionHotkey && (
            <TooltipContent side="right">{newSessionHotkey}</TooltipContent>
          )}
        </Tooltip>
      </div>

      <nav className="shrink-0 px-2 pb-1.5" aria-label={t('sidebar.extensions')}>
        <button
          type="button"
          onClick={toggleExtensions}
          className={cn(
            'flex h-7 w-full items-center gap-1.5 rounded-md px-2',
            'text-left text-[12px] font-medium text-muted-foreground',
            'outline-none transition-colors hover:bg-foreground/4 hover:text-foreground',
            'focus-visible:ring-1 focus-visible:ring-ring',
          )}
          aria-expanded={extensionsOpen}
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 transition-transform',
              extensionsOpen && 'rotate-90',
            )}
          />
          <span className="truncate">{t('sidebar.extensions')}</span>
        </button>
        {extensionsOpen && (
          <div className="ml-3 border-l border-border/40 pl-1">
            <NavigationButton
              icon={<Zap className="h-3.5 w-3.5" />}
              label={t('sidebar.skills')}
              active={activeSection === 'skills'}
              onClick={() => onSelectSection('skills')}
            />
            <NavigationButton
              icon={<Plug className="h-3.5 w-3.5" />}
              label={t('sidebar.connectors')}
              active={activeSection === 'mcp'}
              onClick={() => onSelectSection('mcp')}
            />
          </div>
        )}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {isCapabilitySection ? (
          <div className="min-h-0 flex-1" />
        ) : (
          <>
            <div className="mx-2 border-t border-border/30" aria-hidden="true" />
            <PanelHeader
              title={title}
              titleMenu={sessionTitleMenu}
              actions={headerActions}
              className="h-8 pl-2.5 [&_h1]:text-xs [&_h1]:font-medium [&_h1]:text-muted-foreground"
            />
            {isSessionsSection ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
            ) : (
              <NavigationBodyFocusZone>{children}</NavigationBodyFocusZone>
            )}
          </>
        )}
      </div>

      <nav
        className="grid shrink-0 gap-0.5 border-t border-border/40 px-2 pb-2 pt-1.5"
        aria-label="Workspace navigation"
      >
        <NavigationButton
          icon={<Settings className="h-3.5 w-3.5" />}
          label={t('sidebar.settings')}
          active={activeSection === 'settings'}
          onClick={() => {
            if (activeSection === 'settings') {
              onReturnToSessions()
              return
            }
            onSelectSection('settings')
          }}
        />
      </nav>
    </div>
  )
}

function NavigationBodyFocusZone({ children }: { children: React.ReactNode }) {
  const rootRef = React.useRef<HTMLDivElement>(null)
  const focusFirst = React.useCallback(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('button:not([disabled]), [tabindex="0"]')
      ?.focus()
  }, [])
  const { zoneRef } = useFocusZone({ zoneId: 'navigator', focusFirst })
  const setRootRef = React.useMemo(
    () => mergeRefs<HTMLDivElement>(rootRef, zoneRef),
    [zoneRef],
  )

  return (
    <div ref={setRootRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {children}
    </div>
  )
}

function SessionViewMenuItem({
  icon,
  label,
  count,
  selected,
  onSelect,
}: {
  icon: React.ReactNode
  label: string
  count: number
  selected: boolean
  onSelect: () => void
}) {
  return (
    <StyledDropdownMenuItem onClick={onSelect} className="min-w-52">
      {icon}
      <span className="flex-1">{label}</span>
      <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      <Check className={cn('h-3.5 w-3.5', !selected && 'opacity-0')} />
    </StyledDropdownMenuItem>
  )
}

function NavigationButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex w-full items-center gap-2 rounded-md px-2 py-[6px] text-left text-[13px]',
        'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring',
        active
          ? 'bg-foreground/[0.06] text-foreground'
          : 'text-foreground/70 hover:bg-foreground/[0.04] hover:text-foreground',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {active && (
        <span className="absolute left-0 inset-y-1.5 w-[2px] rounded-full bg-accent" aria-hidden="true" />
      )}
      <span className="shrink-0 text-foreground/65">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  )
}
