import * as React from "react"
import { useTranslation } from "react-i18next"
import { useRef, useState, useEffect, useCallback, useMemo } from "react"
import { useAtomValue, useStore } from "jotai"
import { Search, Plus } from "lucide-react"
import { TopBar } from "./TopBar"
import { HeaderIconButton } from "@/components/ui/HeaderIconButton"
import { SessionList, type ChatGroupingMode } from "./SessionList"
import { PanelStackContainer } from "./PanelStackContainer"
import type { ChatDisplayHandle } from "./ChatDisplay"
import { useSession } from "@/hooks/useSession"
import { ensureSessionMessagesLoadedAtom } from "@/atoms/sessions"
import { AppShellProvider, type AppShellContextType } from "@/context/AppShellContext"
import { EscapeInterruptProvider, useEscapeInterrupt } from "@/context/EscapeInterruptContext"
import { useTheme } from "@/context/ThemeContext"
import { getResizeGradientStyle } from "@/hooks/useResizeGradient"
import { useAction, useActionLabel } from "@/actions"
import { useFocusContext } from "@/context/FocusContext"
import { getSessionTitle } from "@/utils/session"
import { useSetAtom } from "jotai"
import type { Session, FileAttachment, PermissionRequest, LoadedSkill, CatalogSnapshot, PermissionMode } from "../../../shared/types"
import { DEFAULT_CYCLABLE_PERMISSION_MODES } from "@bitlab/shared/agent/modes"
import { sessionMetaMapAtom, type SessionMeta } from "@/atoms/sessions"
import { EMPTY_SNAPSHOT, skillsSnapshotAtom } from "@/atoms/skills"
import { panelStackAtom, panelCountAtom, focusedPanelIdAtom, focusedSessionIdAtom, focusNextPanelAtom, focusPrevPanelAtom, parseSessionIdFromRoute } from "@/atoms/panel-stack"
import { useContainerWidth } from "@/hooks/useContainerWidth"
import * as storage from "@/lib/local-storage"
import { toast } from "sonner"
import { navigate, routes, type Route } from "@/lib/navigate"
import {
  useNavigation,
  useNavigationState,
  isSessionsNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
} from "@/contexts/NavigationContext"
import { buildRouteFromNavigationState } from "../../../shared/route-parser"
import type { SettingsSubpage } from "../../../shared/types"
import { SkillsListPanel } from "./SkillsListPanel"
import { SkillImportMenu } from "./SkillImportMenu"
import { McpListPanel } from "./McpListPanel"
import { FabNewChat } from "./FabNewChat"
import { EditPopover, getEditConfig } from "@/components/ui/EditPopover"
import SettingsNavigator from "@/pages/settings/SettingsNavigator"
import {
  PANEL_GAP,
  PANEL_EDGE_INSET,
  PANEL_SASH_HALF_HIT_WIDTH,
  PANEL_SASH_HIT_WIDTH,
  PANEL_SASH_LINE_WIDTH,
  PANEL_STACK_VERTICAL_OVERFLOW,
} from "./panel-constants"
import { hasOpenOverlay } from "@/lib/overlay-detection"
import { dispatchFocusInputEvent } from "./input/focus-input-events"
import {
  UnifiedNavigationPanel,
  type UnifiedNavigationSection,
  type SessionNavigationView,
} from "./UnifiedNavigationPanel"
import {
  NAVIGATION_PANEL_DEFAULT_WIDTH,
  captureSessionsReturnTarget,
  clampNavigationPanelWidth,
  resolveNavigationPanelWidth,
  type SessionsReturnTarget,
} from "./navigation-layout"

/**
 * AppShellProps - Minimal props interface for AppShell component
 *
 * Data and callbacks come via contextValue (AppShellContextType).
 * Only UI-specific state is passed as separate props.
 *
 * Adding new features:
 * 1. Add to AppShellContextType in context/AppShellContext.tsx
 * 2. Update App.tsx to include in contextValue
 * 3. Use via useAppShellContext() hook in child components
 */
interface AppShellProps {
  /** All data and callbacks - passed directly to AppShellProvider */
  contextValue: AppShellContextType
  /** UI-specific props */
  defaultCollapsed?: boolean
  menuNewChatTrigger?: number
  /** Focused mode - hides sidebars, shows only the chat content */
  isFocusedMode?: boolean
}

/** Filter mode for tri-state filtering: include shows only matching, exclude hides matching */
export function AppShell(props: AppShellProps) {
  // Wrap with EscapeInterruptProvider so AppShellContent can use useEscapeInterrupt
  return (
    <EscapeInterruptProvider>
      <AppShellContent {...props} />
    </EscapeInterruptProvider>
  )
}

/**
 * AppShellContent - Inner component that contains all the AppShell logic
 * Separated to allow useEscapeInterrupt hook to work (must be inside provider)
 */
function AppShellContent({
  contextValue,
  defaultCollapsed = false,
  menuNewChatTrigger,
  isFocusedMode = false,
}: AppShellProps) {
  // Destructure commonly used values from context
  // Note: sessions is NOT destructured here - we use sessionMetaMapAtom instead
  // to prevent closures from retaining the full messages array
  const {
    workspaces,
    activeWorkspaceId,
    sessionOptions,
    onSelectWorkspace,
    onRefreshWorkspaces,
    onDeleteSession,
    onFlagSession,
    onUnflagSession,
    onArchiveSession,
    onUnarchiveSession,
    onMarkSessionUnread,
    onRenameSession,
    onOpenSettings,
    onOpenKeyboardShortcuts,
    pendingPermissions,
  } = contextValue

  const { t } = useTranslation()

  // Get hotkey labels from centralized action registry
  const newChatHotkey = useActionLabel('app.newChat').hotkey

  const [isNavigationPanelVisible, setIsNavigationPanelVisible] = React.useState(() => {
    return storage.get(storage.KEYS.navigationPanelVisible, !defaultCollapsed)
  })
  const [navigationPanelWidth, setNavigationPanelWidth] = React.useState(() => {
    return clampNavigationPanelWidth(
      storage.get(storage.KEYS.navigationPanelWidth, NAVIGATION_PANEL_DEFAULT_WIDTH),
    )
  })

  // Hides both sidebar and navigator (CMD+. toggle)
  // Seed from either focused window param or persisted preference, then keep it toggleable.
  const [isSidebarAndNavigatorHidden, setIsSidebarAndNavigatorHidden] = React.useState(() => {
    return isFocusedMode || storage.get(storage.KEYS.focusModeEnabled, false)
  })

  // Auto-compact mode: shell width below mobile threshold hides sidebar/navigator
  // and switches to single-panel mode. Works in both webui (narrow viewport) and
  // desktop (narrow window or small screen).
  const shellRef = useRef<HTMLDivElement>(null)
  const shellWidth = useContainerWidth(shellRef)
  const MOBILE_THRESHOLD = 768
  const isAutoCompact = shellWidth > 0 && shellWidth < MOBILE_THRESHOLD

  const isNavigationPanelHidden = isSidebarAndNavigatorHidden || !isNavigationPanelVisible
  const effectiveSidebarAndNavigatorHidden = isNavigationPanelHidden || isAutoCompact

  const [isResizingNavigation, setIsResizingNavigation] = React.useState(false)
  const [navigationHandleY, setNavigationHandleY] = React.useState<number | null>(null)
  const navigationResizeHandleRef = React.useRef<HTMLDivElement>(null)
  const [session, setSession] = useSession()
  const { resolvedMode, setMode } = useTheme()
  const { canGoBack, canGoForward, goBack, goForward, navigateToSession } = useNavigation()

  // Double-Esc interrupt feature: first Esc shows warning, second Esc interrupts
  const { handleEscapePress } = useEscapeInterrupt()

  // UNIFIED NAVIGATION STATE - single source of truth from NavigationContext
  // Derived from focused panel's route — all panels are peers
  const navState = useNavigationState()

  const store = useStore()
  const panelStack = useAtomValue(panelStackAtom)
  const panelCount = useAtomValue(panelCountAtom)
  const focusedSessionId = useAtomValue(focusedSessionIdAtom)

  // Navigate the focused panel to a session.
  // If the session is already open in another panel, focus that panel instead.
  const setFocusedPanel = useSetAtom(focusedPanelIdAtom)
  const navigateToSessionInPanel = useCallback((sessionId: string) => {
    // Check if the session is already open in any panel — focus it instead of navigating
    const stack = store.get(panelStackAtom)
    for (const entry of stack) {
      if (parseSessionIdFromRoute(entry.route) === sessionId) {
        setFocusedPanel(entry.id)
        return
      }
    }

    // Not open in any panel — navigate() updates the focused panel
    navigateToSession(sessionId)
  }, [store, setFocusedPanel, navigateToSession])

  const sessionsContext = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      return {
        filter: navState.filter,
        sessionId: navState.details?.sessionId ?? null,
      }
    }
    return null
  }, [navState])

  const sessionFilter = sessionsContext?.filter ?? null

  // Search state for session list
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')

  const chatGroupingMode: ChatGroupingMode = 'date'

  // Ref for ChatDisplay navigation (exposed via forwardRef)
  const chatDisplayRef = React.useRef<ChatDisplayHandle>(null)
  // Track match count and index from ChatDisplay (for SessionList navigation UI)
  const [chatMatchInfo, setChatMatchInfo] = React.useState<{ sessionId: string | null; count: number; index: number; isHighlighting?: boolean }>({ sessionId: null, count: 0, index: 0 })

  // Callback for immediate match info updates from ChatDisplay
  // Memo guard prevents render feedback loops from identical updates
  const handleChatMatchInfoChange = React.useCallback((info: { sessionId: string | null; count: number; index: number; isHighlighting: boolean }) => {
    setChatMatchInfo(prev => {
      if (prev.sessionId === info.sessionId && prev.count === info.count && prev.index === info.index && prev.isHighlighting === info.isHighlighting) {
        return prev
      }
      return info
    })
  }, [])

  // Reset match info when search is deactivated
  React.useEffect(() => {
    if (!searchActive || !searchQuery) {
      setChatMatchInfo({ sessionId: null, count: 0, index: 0 })
    }
  }, [searchActive, searchQuery])

  // Reset search only when navigator or filter changes (not when selecting sessions)
  const navFilterKey = React.useMemo(() => {
    if (isSessionsNavigation(navState)) {
      const filter = navState.filter
      return `chats:${filter.kind}`
    }
    return navState.navigator
  }, [navState])

  React.useEffect(() => {
    setSearchActive(false)
    setSearchQuery('')
  }, [navFilterKey])

  // Cmd+F to activate search
  useAction('app.search', () => setSearchActive(true))

  // Skills state (workspace-scoped)
  const [snapshot, setSnapshot] = React.useState<CatalogSnapshot>(EMPTY_SNAPSHOT)
  // Only the winners are offered to the user — they are what the model sees too.
  const skills = React.useMemo(() => snapshot.entries.filter(entry => entry.winner), [snapshot])
  // Sync the catalog to the atom for NavigationContext auto-selection
  const setSkillsSnapshot = useSetAtom(skillsSnapshotAtom)
  React.useEffect(() => {
    setSkillsSnapshot(snapshot)
  }, [snapshot, setSkillsSnapshot])
  const activeWorkspace = workspaces.find(w => w.id === activeWorkspaceId)

  // Enabled permission modes for Shift+Tab cycling (min 2 modes)
  const [enabledModes, setEnabledModes] = React.useState<PermissionMode[]>(DEFAULT_CYCLABLE_PERMISSION_MODES)

  // Load workspace settings for permission-mode cycling on workspace change
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getWorkspaceSettings(activeWorkspaceId).then((settings) => {
      if (settings) {
        // Load cyclablePermissionModes from workspace settings
        if (settings.cyclablePermissionModes && settings.cyclablePermissionModes.length >= 2) {
          setEnabledModes(settings.cyclablePermissionModes)
        }
      }
    }).catch((err) => {
      console.error('[Chat] Failed to load workspace settings:', err)
    })
  }, [activeWorkspaceId])

  // Reset UI state when workspace changes
  // This prevents stale search queries, focused items, and filter state from persisting
  const previousWorkspaceRef = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (!activeWorkspaceId) return

    const previousWorkspaceId = previousWorkspaceRef.current

    // Clear transient UI state only on workspace SWITCH (not initial mount)
    if (previousWorkspaceId !== null && previousWorkspaceId !== activeWorkspaceId) {
      // Clear search state
      setSearchActive(false)
      setSearchQuery('')

    }

    previousWorkspaceRef.current = activeWorkspaceId
  }, [activeWorkspaceId])

  // Subscribe to live skill updates (when skills are added/removed dynamically)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onSkillsChanged((workspaceId, updatedSnapshot) => {
      if (workspaceId !== activeWorkspaceId) return
      setSnapshot(updatedSnapshot ?? EMPTY_SNAPSHOT)
    })
    return cleanup
  }, [activeWorkspaceId])

  // Ensure session messages are loaded when selected
  const ensureMessagesLoaded = useSetAtom(ensureSessionMessagesLoadedAtom)

  // Handle selecting a skill from the list
  const handleSkillSelect = React.useCallback((skill: LoadedSkill) => {
    if (!activeWorkspaceId) return
    navigate(routes.view.skills(skill.slug))
  }, [activeWorkspaceId, navigate])

  // Focus zone management
  const { focusZone, focusNextZone, focusPreviousZone } = useFocusContext()

  // Global keyboard shortcuts using centralized action registry
  // Actions are defined in @/actions/definitions.ts

  // Zone navigation - explicit keyboard intent, always move DOM focus
  useAction('nav.focusSidebar', () => focusZone('sidebar', { intent: 'keyboard' }))
  useAction('nav.focusNavigator', () => focusZone('navigator', { intent: 'keyboard' }))
  useAction('nav.focusChat', () => focusZone('chat', { intent: 'keyboard' }))

  // Tab navigation between zones
  useAction('nav.nextZone', () => {
    focusNextZone()
  }, { enabled: () => !document.querySelector('[role="dialog"]') })

  // Shift+Tab cycles permission mode through enabled modes (textarea handles its own, this handles when focus is elsewhere)
  // In multi-panel, targets the focused panel's session
  const effectiveSessionId = focusedSessionId ?? session.selected

  // Focus chat input for the target session only (multi-panel safe).
  const focusChatInputForSession = useCallback((targetSessionId?: string | null) => {
    if (!targetSessionId) return
    dispatchFocusInputEvent({ sessionId: targetSessionId })
  }, [])

  useAction('chat.cyclePermissionMode', () => {
    if (effectiveSessionId) {
      const currentOptions = contextValue.sessionOptions.get(effectiveSessionId)
      const currentMode = currentOptions?.permissionMode ?? 'ask'
      // Cycle through enabled permission modes
      const modes = enabledModes.length >= 2 ? enabledModes : DEFAULT_CYCLABLE_PERMISSION_MODES
      const currentIndex = modes.indexOf(currentMode)
      // If current mode not in enabled list, jump to first enabled mode
      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % modes.length
      const nextMode = modes[nextIndex]
      contextValue.onSessionOptionsChange(effectiveSessionId, { permissionMode: nextMode })
    }
  })

  const handleToggleSidebar = useCallback(() => {
    if (isSidebarAndNavigatorHidden) {
      setIsSidebarAndNavigatorHidden(false)
      setIsNavigationPanelVisible(true)
      return
    }
    setIsNavigationPanelVisible(v => !v)
  }, [isSidebarAndNavigatorHidden])

  // Sidebar toggle (CMD+B)
  useAction('view.toggleSidebar', handleToggleSidebar)

  // Focus mode toggle (CMD+.) - hides both sidebars
  useAction('view.toggleFocusMode', () => setIsSidebarAndNavigatorHidden(v => !v))

  // Panel focus navigation (CMD+SHIFT+[ / ])
  const focusNextPanel = useSetAtom(focusNextPanelAtom)
  const focusPrevPanel = useSetAtom(focusPrevPanelAtom)
  useAction('panel.focusNext', focusNextPanel, { enabled: () => panelCount > 1 })
  useAction('panel.focusPrev', focusPrevPanel, { enabled: () => panelCount > 1 })

  // New chat
  useAction('app.newChat', () => handleNewChat())
  useAction('app.newChatInPanel', () => handleNewChat(true))

  // Settings
  useAction('app.settings', onOpenSettings)

  // Keyboard shortcuts
  useAction('app.keyboardShortcuts', onOpenKeyboardShortcuts)

  // New window
  useAction('app.newWindow', () => window.electronAPI.menuNewWindow())

  // Quit (note: also handled by native menu on macOS)
  useAction('app.quit', () => window.electronAPI.menuQuit())

  // History navigation
  useAction('nav.goBack', goBack)
  useAction('nav.goForward', goForward)

  // History navigation (arrow key alternatives)
  useAction('nav.goBackAlt', goBack)
  useAction('nav.goForwardAlt', goForward)

  // Search match navigation (CMD+G next, CMD+SHIFT+G prev)
  useAction('chat.nextSearchMatch', () => chatDisplayRef.current?.goToNextMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })
  useAction('chat.prevSearchMatch', () => chatDisplayRef.current?.goToPrevMatch(), {
    enabled: () => searchActive && (chatMatchInfo.count ?? 0) > 0
  })

  // ESC to stop processing - requires double-press within 1 second
  // First press shows warning overlay, second press interrupts
  // In multi-panel, targets the focused panel's session
  useAction('chat.stopProcessing', () => {
    if (effectiveSessionId) {
      const meta = sessionMetaMap.get(effectiveSessionId)
      if (meta?.isProcessing) {
        // handleEscapePress returns true on second press (within timeout)
        const shouldInterrupt = handleEscapePress()
        if (shouldInterrupt) {
          window.electronAPI.cancelProcessing(effectiveSessionId, false).catch(err => {
            console.error('[AppShell] Failed to cancel processing:', err)
          })
        }
      }
    }
  }, {
    // Only active when no overlay is open and session is processing
    // Overlays (dialogs, menus, popovers, etc.) should handle their own Escape
    enabled: () => {
      if (hasOpenOverlay()) return false
      if (!effectiveSessionId) return false
      const meta = sessionMetaMap.get(effectiveSessionId)
      return meta?.isProcessing ?? false
    }
  }, [effectiveSessionId, handleEscapePress])

  // Theme toggle (CMD+SHIFT+A)
  useAction('app.toggleTheme', () => setMode(resolvedMode === 'dark' ? 'light' : 'dark'))

  // Global paste listener for file attachments
  // Fires when Cmd+V is pressed anywhere in the app (not just textarea)
  React.useEffect(() => {
    const handleGlobalPaste = (e: ClipboardEvent) => {
      // Skip if a dialog or menu is open
      if (document.querySelector('[role="dialog"], [role="menu"]')) {
        return
      }

      // Skip if there are no files in the clipboard
      const files = e.clipboardData?.files
      if (!files || files.length === 0) return

      // Skip if the active element is an input/textarea/contenteditable (let it handle paste directly)
      const activeElement = document.activeElement as HTMLElement | null
      if (
        activeElement?.tagName === 'TEXTAREA' ||
        activeElement?.tagName === 'INPUT' ||
        activeElement?.isContentEditable
      ) {
        return
      }

      // Prevent default paste behavior
      e.preventDefault()

      // Dispatch custom event for FreeFormInput to handle (target focused session only)
      const filesArray = Array.from(files)
      const targetSessionId = focusedSessionId ?? session.selected
      if (!targetSessionId) return
      window.dispatchEvent(new CustomEvent('craft:paste-files', {
        detail: { files: filesArray, sessionId: targetSessionId }
      }))
    }

    document.addEventListener('paste', handleGlobalPaste)
    return () => document.removeEventListener('paste', handleGlobalPaste)
  }, [focusedSessionId, session.selected])

  // Resize the single navigation domain.
  React.useEffect(() => {
    if (!isResizingNavigation) return

    const handleMouseMove = (e: MouseEvent) => {
      setNavigationPanelWidth(clampNavigationPanelWidth(e.clientX))
      if (navigationResizeHandleRef.current) {
        const rect = navigationResizeHandleRef.current.getBoundingClientRect()
        setNavigationHandleY(e.clientY - rect.top)
      }
    }

    const handleMouseUp = (event: MouseEvent) => {
      const nextWidth = clampNavigationPanelWidth(event.clientX)
      setNavigationPanelWidth(nextWidth)
      storage.set(storage.KEYS.navigationPanelWidth, nextWidth)
      setNavigationHandleY(null)
      setIsResizingNavigation(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingNavigation])

  // Use session metadata from Jotai atom (lightweight, no messages)
  // This prevents closures from retaining full message arrays
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const setSessionMetaMap = useSetAtom(sessionMetaMapAtom)

  const hasPendingPrompt = React.useCallback((sessionId: string) => {
    return (pendingPermissions.get(sessionId)?.length ?? 0) > 0
  }, [pendingPermissions])

  // Workspace-level unread indicators (needed for workspace selectors across all workspaces)
  const [workspaceUnreadMap, setWorkspaceUnreadMap] = useState<Record<string, boolean>>({})

  // Project Skills follow the folder bound to the active workspace.
  React.useEffect(() => {
    if (!activeWorkspaceId) return
    window.electronAPI.getSkills(activeWorkspaceId).then((loaded) => {
      setSnapshot(loaded ?? EMPTY_SNAPSHOT)
    }).catch(err => {
      console.error('[Chat] Failed to load skills:', err)
    })
  }, [activeWorkspaceId])

  // Filter session metadata by active workspace
  // Also exclude hidden sessions (mini-agent sessions) from all counts and lists
  const workspaceSessionMetas = useMemo(() => {
    const metas = Array.from(sessionMetaMap.values())
    if (!activeWorkspaceId) return metas.filter(s => !s.hidden)
    return metas.filter(s => !s.hidden && s.workspaceId === activeWorkspaceId)
  }, [sessionMetaMap, activeWorkspaceId])

  // Active sessions exclude archived - use this for all counts and filters except archived view
  const activeSessionMetas = useMemo(() => {
    return workspaceSessionMetas.filter(s => !s.isArchived)
  }, [workspaceSessionMetas])

  const refreshWorkspaceUnreadMap = useCallback(async () => {
    try {
      const summary = await window.electronAPI.getUnreadSummary()
      const next: Record<string, boolean> = {}

      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }

      setWorkspaceUnreadMap(next)
    } catch (error) {
      console.error('[AppShell] Failed to refresh workspace unread indicators:', error)
    }
  }, [workspaces])

  // Initial + workspace-list refresh
  useEffect(() => {
    void refreshWorkspaceUnreadMap()
  }, [refreshWorkspaceUnreadMap])

  // Keep active workspace unread indicator in sync with live metadata updates
  useEffect(() => {
    if (!activeWorkspaceId) return
    const activeHasUnread = activeSessionMetas.some((session) => !!session.hasUnread)
    setWorkspaceUnreadMap((prev) => ({ ...prev, [activeWorkspaceId]: activeHasUnread }))
  }, [activeWorkspaceId, activeSessionMetas])

  // Keep cross-workspace indicators in sync with global unread updates from main process
  useEffect(() => {
    const cleanup = window.electronAPI.onUnreadSummaryChanged((summary) => {
      const next: Record<string, boolean> = {}
      for (const workspace of workspaces) {
        next[workspace.id] = !!summary.hasUnreadByWorkspace[workspace.id]
      }
      setWorkspaceUnreadMap(next)
    })

    return cleanup
  }, [workspaces])

  const flaggedCount = activeSessionMetas.filter(s => s.isFlagged).length
  const archivedCount = workspaceSessionMetas.filter(s => s.isArchived).length

  // Filter session metadata by the retained built-in views.
  const filteredSessionMetas = useMemo(() => {
    if (!sessionFilter) return []
    switch (sessionFilter.kind) {
      case 'flagged':
        return activeSessionMetas.filter(s => s.isFlagged)
      case 'archived':
        return workspaceSessionMetas.filter(s => s.isArchived)
      default:
        return activeSessionMetas
    }
  }, [workspaceSessionMetas, activeSessionMetas, sessionFilter])

  // Ensure session messages are loaded when selected
  React.useEffect(() => {
    if (session.selected) {
      ensureMessagesLoaded(session.selected)
    }
  }, [session.selected, ensureMessagesLoaded])

  // Wrap delete handler to clear selection when deleting the currently selected session
  // This prevents stale state during re-renders that could cause crashes
  const handleDeleteSession = useCallback(async (sessionId: string, skipConfirmation?: boolean): Promise<boolean> => {
    // Clear selection first if this is the selected session
    if (session.selected === sessionId) {
      setSession({ selected: null })
    }
    return onDeleteSession(sessionId, skipConfirmation)
  }, [session.selected, setSession, onDeleteSession])

  // Extend the Craft context with retained Bitlab capabilities only.
  const activeWorkspaceWorkingDirectory = activeWorkspace?.folderPath ?? activeWorkspace?.dataRoot
  const appShellContextValue = React.useMemo<AppShellContextType>(() => ({
    ...contextValue,
    onDeleteSession: handleDeleteSession,
    skills,
    activeWorkspaceWorkingDirectory,
    enabledModes,
    rightSidebarButton: null,
    isCompactMode: isAutoCompact,
    sessionListSearchQuery: searchActive ? searchQuery : undefined,
    isSearchModeActive: searchActive,
    chatDisplayRef,
    onChatMatchInfoChange: handleChatMatchInfoChange,
  }), [contextValue, handleDeleteSession, skills, activeWorkspaceWorkingDirectory, enabledModes, isAutoCompact, searchActive, searchQuery, handleChatMatchInfoChange])

  // Persist navigation visibility to localStorage.
  React.useEffect(() => {
    storage.set(storage.KEYS.navigationPanelVisible, isNavigationPanelVisible)
  }, [isNavigationPanelVisible])

  // Persist focus mode state to localStorage
  React.useEffect(() => {
    storage.set(storage.KEYS.focusModeEnabled, isSidebarAndNavigatorHidden)
  }, [isSidebarAndNavigatorHidden])

  // Listen for focus mode toggle from menu (View → Focus Mode)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleFocusMode?.(() => {
      setIsSidebarAndNavigatorHidden(v => !v)
    })
    return cleanup
  }, [])

  // Listen for sidebar toggle from menu (View → Toggle Sidebar)
  React.useEffect(() => {
    const cleanup = window.electronAPI.onMenuToggleSidebar?.(() => {
      handleToggleSidebar()
    })
    return cleanup
  }, [handleToggleSidebar])

  const handleAllSessionsClick = useCallback(() => {
    navigate(routes.view.allSessions())
  }, [])

  const handleFlaggedClick = useCallback(() => {
    navigate(routes.view.flagged())
  }, [])

  const handleArchivedClick = useCallback(() => {
    navigate(routes.view.archived())
  }, [])

  // Handler for skills view
  const handleSkillsClick = useCallback(() => {
    navigate(routes.view.skills())
  }, [])

  const handleConnectorsClick = useCallback(() => {
    navigate(routes.view.settings('mcp'))
  }, [])

  // Handler for settings view. With no arg → bare `settings` route (navigator-only
  // in compact mode, App fallback on desktop). With an arg → `settings/<subpage>`.
  const handleSettingsClick = useCallback((subpage?: SettingsSubpage) => {
    navigate(routes.view.settings(subpage))
  }, [])

  // Create a new chat and select it
  const handleNewChat = useCallback((newPanel: boolean = false) => {
    if (!activeWorkspace) return

    // Exit search mode and switch to All Sessions
    setSearchActive(false)
    setSearchQuery('')

    // Delegate to NavigationContext which handles session creation
    navigate(
      routes.action.newSession(),
      newPanel ? { newPanel: true, targetLaneId: 'main' } : undefined
    )

    // Focus the chat input after navigation completes
    setTimeout(() => focusZone('chat', { intent: 'programmatic' }), 50)
  }, [activeWorkspace, focusZone, navigate])

  // Create a brand new dedicated browser window and focus it.
  // Intentionally unbound: this action should always create a NEW window.
  const handleNewBrowserWindow = useCallback(async () => {
    try {
      const instanceId = await window.electronAPI.browserPane.create({
        show: true,
      })
      await window.electronAPI.browserPane.focus(instanceId)
    } catch (error) {
      console.error('[Chat] Failed to create browser window:', error)
      toast.error(t('toast.failedToCreateBrowser'))
    }
  }, [])

  // Delete Skill
  const handleDeleteSkill = useCallback(async (skillId: string) => {
    if (!activeWorkspace) return
    const slug = snapshot.entries.find(entry => entry.skillId === skillId)?.slug ?? skillId
    try {
      await window.electronAPI.deleteSkill(activeWorkspace.id, skillId)
      toast.success(t('toast.deletedSkill', { slug }))
    } catch (error) {
      console.error('[Chat] Failed to delete skill:', error)
      toast.error(t('toast.failedToDeleteSkill'))
    }
  }, [activeWorkspace, snapshot])

  // Enable / disable a Skill. A disabled skill leaves the runtime entirely; if
  // it was the winner, the next tier down takes over.
  const handleToggleSkill = useCallback(async (skillId: string, enabled: boolean) => {
    if (!activeWorkspace) return
    try {
      setSnapshot(await window.electronAPI.setSkillEnabled(activeWorkspace.id, skillId, enabled))
    } catch (error) {
      console.error('[Chat] Failed to toggle skill:', error)
      toast.error(t('toast.failedToToggleSkill'))
    }
  }, [activeWorkspace, t])

  // Let the working directory's Skills reach the agent. Explicit, and revocable.
  const handleTrustProject = useCallback(async (projectRoot: string) => {
    if (!activeWorkspace) return
    try {
      setSnapshot(await window.electronAPI.setSkillProjectTrust(activeWorkspace.id, projectRoot, true))
    } catch (error) {
      console.error('[Chat] Failed to trust project:', error)
      toast.error(t('toast.failedToTrustProject'))
    }
  }, [activeWorkspace, t])

  // The route addresses a Skill by slug; the list is keyed on skillId.
  const selectedSkillIdFor = useCallback((slug: string) => {
    const entries = snapshot.entries.filter(entry => entry.slug === slug)
    return (entries.find(entry => entry.winner) ?? entries[0])?.skillId ?? null
  }, [snapshot])

  // Respond to menu bar "New Chat" trigger
  const menuTriggerRef = useRef(menuNewChatTrigger)
  useEffect(() => {
    // Skip initial render
    if (menuTriggerRef.current === menuNewChatTrigger) return
    menuTriggerRef.current = menuNewChatTrigger
    handleNewChat()
  }, [menuNewChatTrigger, handleNewChat])

  // Get title based on the retained navigation states.
  const listTitle = React.useMemo(() => {
    if (isSkillsNavigation(navState)) return t('sidebar.allSkills')
    if (isSettingsNavigation(navState) && navState.subpage === 'mcp') return t('sidebar.connectors')
    if (isSettingsNavigation(navState)) return t('sidebar.settings')
    if (sessionFilter?.kind === 'flagged') return t('sidebar.flagged')
    if (sessionFilter?.kind === 'archived') return t('sidebar.archived')
    return t('sidebar.tasks')
  }, [navState, t, sessionFilter])

  const activeNavigationSection: UnifiedNavigationSection = isSkillsNavigation(navState)
    ? 'skills'
    : isSettingsNavigation(navState) && navState.subpage === 'mcp'
      ? 'mcp'
      : isSettingsNavigation(navState)
        ? 'settings'
        : 'sessions'

  const activeSessionView: SessionNavigationView = sessionFilter?.kind === 'flagged'
    ? 'flagged'
    : sessionFilter?.kind === 'archived'
      ? 'archived'
      : 'all'

  const handleSelectSessionView = useCallback((view: SessionNavigationView) => {
    if (view === 'flagged') {
      handleFlaggedClick()
      return
    }
    if (view === 'archived') {
      handleArchivedClick()
      return
    }
    handleAllSessionsClick()
  }, [handleAllSessionsClick, handleArchivedClick, handleFlaggedClick])

  const handleSelectNavigationSection = useCallback((section: UnifiedNavigationSection) => {
    if (section === 'skills') {
      handleSkillsClick()
      return
    }
    if (section === 'mcp') {
      handleConnectorsClick()
      return
    }
    if (section === 'settings') {
      handleSettingsClick()
      return
    }
    handleAllSessionsClick()
  }, [handleAllSessionsClick, handleConnectorsClick, handleSettingsClick, handleSkillsClick])

  // Keep the last sessions location while still on sessions, so "返回" from
  // skills/settings restores that chat / main surface (not browser history steps).
  const sessionsReturnRef = useRef<SessionsReturnTarget>({ kind: 'welcome' })
  useEffect(() => {
    if (!isSessionsNavigation(navState)) return
    sessionsReturnRef.current = captureSessionsReturnTarget({
      route: buildRouteFromNavigationState(navState) as Route,
      panelCount,
    })
  }, [navState, panelCount])

  const handleReturnToSessions = useCallback(() => {
    const target = sessionsReturnRef.current
    if (target.kind === 'welcome') {
      // Welcome surface: closing all panels restores WelcomePanel.
      store.set(panelStackAtom, [])
      store.set(focusedPanelIdAtom, null)
      return
    }
    navigate(
      target.route as Route,
      target.skipAutoSelect ? { skipAutoSelect: true } : undefined,
    )
  }, [store])

  const handleMarkAllSessionsRead = useCallback(() => {
    if (!activeWorkspaceId) return
    setSessionMetaMap((previous) => {
      const next = new Map(previous)
      for (const [id, meta] of next) {
        if (meta.workspaceId === activeWorkspaceId && meta.hasUnread) {
          next.set(id, { ...meta, hasUnread: false })
        }
      }
      return next
    })
    void window.electronAPI.markAllSessionsRead(activeWorkspaceId)
  }, [activeWorkspaceId, setSessionMetaMap])

  // Tiers an install may target: the ones backed by a writable directory.
  // Built-in ships with the app and is never a destination.
  const installTargets = React.useMemo(
    () =>
      snapshot.tiers
        .map(tier => tier.source)
        .filter(source => source !== 'builtin'),
    [snapshot],
  )

  const navigationHeaderActions = (
    <>
      {isSessionsNavigation(navState) && (
        <HeaderIconButton
          icon={<Search className="h-4 w-4" />}
          tooltip={t('common.search')}
          onClick={() => setSearchActive(true)}
        />
      )}
      {isSkillsNavigation(navState) && activeWorkspace && (
        <>
          <SkillImportMenu
            workspaceId={activeWorkspace.id}
            targets={installTargets}
            onInstalled={setSnapshot}
          />
          <EditPopover
            trigger={<HeaderIconButton icon={<Plus className="h-4 w-4" />} tooltip={t('sidebarMenu.addSkill')} />}
            {...getEditConfig('add-skill', activeWorkspace.dataRoot)}
          />
        </>
      )}
    </>
  )

  const navigationPanelContent = (
    <UnifiedNavigationPanel
      workspaces={workspaces}
      activeWorkspaceId={activeWorkspaceId}
      workspaceUnreadMap={workspaceUnreadMap}
      onSelectWorkspace={onSelectWorkspace}
      onWorkspaceCreated={() => onRefreshWorkspaces?.()}
      onWorkspaceRemoved={() => onRefreshWorkspaces?.()}
      newSessionHotkey={newChatHotkey}
      onNewSession={handleNewChat}
      onReturnToSessions={handleReturnToSessions}
      activeSection={activeNavigationSection}
      activeSessionView={activeSessionView}
      title={listTitle}
      titleBadge={
        isSkillsNavigation(navState) && activeWorkspaceId ? (
          <span
            className="text-xs tabular-nums text-muted-foreground"
            aria-label={t('skillsList.totalCount', { count: skills.length })}
          >
            {skills.length}
          </span>
        ) : undefined
      }
      sessionCounts={{
        all: activeSessionMetas.length,
        flagged: flaggedCount,
        archived: archivedCount,
      }}
      onSelectSessionView={handleSelectSessionView}
      onMarkAllSessionsRead={handleMarkAllSessionsRead}
      onSelectSection={handleSelectNavigationSection}
      headerActions={navigationHeaderActions}
    >
      {isSkillsNavigation(navState) && activeWorkspaceId && (
        <SkillsListPanel
          snapshot={snapshot}
          workspaceId={activeWorkspaceId}
          workspaceRootPath={activeWorkspace?.dataRoot}
          onSkillClick={handleSkillSelect}
          onDeleteSkill={handleDeleteSkill}
          onToggleSkill={handleToggleSkill}
          onTrustProject={handleTrustProject}
          selectedSkillSlug={
            navState.details?.type === 'skill'
              ? selectedSkillIdFor(navState.details.skillSlug)
              : null
          }
        />
      )}
      {isSettingsNavigation(navState) && navState.subpage === 'mcp' && (
        <McpListPanel onSelectServer={handleConnectorsClick} onAddConnector={handleConnectorsClick} />
      )}
      {isSettingsNavigation(navState) && navState.subpage !== 'mcp' && (
        <SettingsNavigator
          selectedSubpage={navState.subpage}
          onSelectSubpage={handleSettingsClick}
        />
      )}
      {isSessionsNavigation(navState) && (
        <SessionList
          key={sessionFilter?.kind}
          items={searchActive ? workspaceSessionMetas : filteredSessionMetas}
          onDelete={handleDeleteSession}
          onFlag={onFlagSession}
          onUnflag={onUnflagSession}
          onArchive={onArchiveSession}
          onUnarchive={onUnarchiveSession}
          onMarkUnread={onMarkSessionUnread}
          onRename={onRenameSession}
          onFocusChatInput={(targetSessionId) => {
            focusChatInputForSession(targetSessionId ?? focusedSessionId ?? session.selected)
          }}
          onSessionSelect={(selectedMeta) => navigateToSession(selectedMeta.id)}
          onOpenInNewWindow={(selectedMeta) => {
            if (activeWorkspaceId) {
              window.electronAPI.openSessionInNewWindow(activeWorkspaceId, selectedMeta.id)
            }
          }}
          onNavigateToView={(view) => {
            if (view === 'allSessions') handleAllSessionsClick()
            else handleFlaggedClick()
          }}
          sessionOptions={sessionOptions}
          searchActive={searchActive}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSearchClose={() => {
            setSearchActive(false)
            setSearchQuery('')
          }}
          groupingMode={chatGroupingMode}
          workspaceId={activeWorkspaceId ?? undefined}
          focusedSessionId={panelCount === 0 ? null : panelCount > 1 ? focusedSessionId : undefined}
          onNavigateToSession={panelCount > 1 ? navigateToSessionInPanel : undefined}
          hasPendingPrompt={hasPendingPrompt}
          activeChatMatchInfo={chatMatchInfo}
        />
      )}
      {isAutoCompact && isSessionsNavigation(navState) && !navState.details && (
        <FabNewChat onClick={() => handleNewChat()} />
      )}
    </UnifiedNavigationPanel>
  )

  return (
    <AppShellProvider value={appShellContextValue}>
      {/* === OUTER LAYOUT: Unified Panel Stack | Right Sidebar === */}
      <div
        ref={shellRef}
        className="flex items-stretch relative"
        style={{
          height: '100%',
          paddingRight: 0,
          paddingBottom: 0,
          paddingLeft: 0,
          gap: 0,
        }}
      >
        <PanelStackContainer
          sidebarSlot={null}
          sidebarWidth={0}
          navigatorSlot={
            <div
              style={{ width: isAutoCompact ? '100%' : navigationPanelWidth }}
              className="h-full flex flex-col min-w-0 relative z-panel"
            >
              {navigationPanelContent}
            </div>
          }
          navigatorWidth={isAutoCompact
            ? navigationPanelWidth
            : resolveNavigationPanelWidth({
                width: navigationPanelWidth,
                hidden: isNavigationPanelHidden,
              })}
          isSidebarAndNavigatorHidden={effectiveSidebarAndNavigatorHidden}
          isRightSidebarVisible={false}
          isCompact={isAutoCompact}
          isResizing={isResizingNavigation}
        />

        {/* Single resize handle for the unified navigation domain. */}
        {!effectiveSidebarAndNavigatorHidden && !isAutoCompact && (
        <div
          ref={navigationResizeHandleRef}
          onMouseDown={(event) => {
            event.preventDefault()
            setIsResizingNavigation(true)
          }}
          onMouseMove={(e) => {
            if (navigationResizeHandleRef.current) {
              const rect = navigationResizeHandleRef.current.getBoundingClientRect()
              setNavigationHandleY(e.clientY - rect.top)
            }
          }}
          onMouseLeave={() => {
            if (!isResizingNavigation) setNavigationHandleY(null)
          }}
          className="absolute cursor-col-resize z-panel flex justify-center"
          style={{
            width: PANEL_SASH_HIT_WIDTH,
            top: 'var(--topbar-height)',
            bottom: PANEL_STACK_VERTICAL_OVERFLOW,
            left: PANEL_EDGE_INSET + navigationPanelWidth + (PANEL_GAP / 2) - PANEL_SASH_HALF_HIT_WIDTH,
            transition: isResizingNavigation ? undefined : 'left 0.15s ease-out',
          }}
        >
          <div
            className="h-full"
            style={{
              ...getResizeGradientStyle(
                navigationHandleY,
                navigationResizeHandleRef.current?.clientHeight ?? null,
              ),
              width: PANEL_SASH_LINE_WIDTH,
            }}
          />
        </div>
        )}

      </div>

      {/* Overlay chrome — transparent so sidebar/content colors run to the window top. */}
      <TopBar
        activeSessionId={effectiveSessionId}
        onBack={goBack}
        onForward={goForward}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onToggleSidebar={handleToggleSidebar}
        onAddSessionPanel={() => handleNewChat(true)}
        onAddBrowserPanel={() => { void handleNewBrowserWindow() }}
        isCompact={isAutoCompact}
      />

    </AppShellProvider>
  )
}
