import * as React from 'react'
import { useTranslation } from "react-i18next"
import { AnimatePresence, motion } from 'motion/react'
import {
  Paperclip,
  ArrowUp,
  Square,
  Check,
  ChevronUp,
} from 'lucide-react'
import { Spinner } from '@bitlab/ui'
import { toast } from 'sonner'

import * as storage from '@/lib/local-storage'
import { Button } from '@/components/ui/button'
import {
  InlineSlashCommand,
  useInlineSlashCommand,
  type SlashCommandId,
} from '@/components/ui/slash-command-menu'
import { useMcpServerOptions } from '@/hooks/useMcpServerOptions'
import {
  InlineMentionMenu,
  useInlineMention,
  type MentionItem,
  type MentionItemType,
} from '@/components/ui/mention-menu'
import { parseMentions } from '@/lib/mentions'
import { RichTextInput, type RichTextInputHandle } from '@/components/ui/rich-text-input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { ContextMeter } from './ContextMeter'
import { DropdownMenuPortal } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuSeparator } from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import { coerceInputText } from '@/lib/input-text'
import { isMac } from '@/lib/platform'
import { applySmartTypography } from '@/lib/smart-typography'
import { AttachmentPreview } from '../AttachmentPreview'
import { ImageSupportWarningBanner } from './ImageSupportWarningBanner'
import type { ModelDefinition } from '@config/models'
import {
  resolveEffectiveConnectionSlug,
  isCompatProvider,
  modelSupportsImages,
} from '@config/llm-connections'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig } from '@/components/ui/EditPopover'
import { FreeFormInputContextBadge } from './FreeFormInputContextBadge'
import { ModelSelect } from './ModelSelect'
import { useModelDirectory } from './useModelDirectory'
import { blocksComposer } from './picker-mode'
import type { ContextUsageReading, FileAttachment, LoadedSkill } from '../../../../shared/types'
import { DEFAULT_CYCLABLE_PERMISSION_MODES, type PermissionMode } from '@bitlab/shared/agent/modes'
import { type ThinkingLevel } from '@bitlab/shared/agent/thinking-levels'
import { useEscapeInterrupt } from '@/context/EscapeInterruptContext'
import { hasOpenOverlay } from '@/lib/overlay-detection'
import { ToolbarStatusSlot } from './ToolbarStatusSlot'
import { buildPlanApprovalMessage } from '../plan-approval-message'
import { shouldHandleScopedInputEvent, shouldRecallPromptOnArrowUp } from './input-event-guards'
import { clearPendingFocusForSession, consumePendingFocusForSession } from './focus-input-events'
import { CompactPermissionModeSelector } from './CompactPermissionModeSelector'
import { CompactModelSelector } from './CompactModelSelector'
import {
  PermissionModeDropdown,
  SessionInfoToolbarButton,
} from '../ActiveOptionBadges'
import {
  formatTokenCount,
  stripPiPrefixForDisplay,
} from './model-picker-helpers'
import { useModelVisionToggle } from './useModelVisionToggle'

function formatFollowUpChipText(text: string, fallback: string, maxLength = 50): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return fallback

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1).trimEnd()}…`
    : normalized
}


/** Platform-specific modifier key for keyboard shortcuts */
const cmdKey = isMac ? '⌘' : 'Ctrl'

/** Default rotating placeholders are now generated inside FreeFormInput via useMemo + t() */

/** Fisher-Yates shuffle — returns a new array in random order */
function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

export interface FollowUpInputItem {
  id: string
  messageId: string
  annotationId: string
  index?: number
  noteLabel: string
  selectedText: string
  color?: string
}

export interface FreeFormInputProps {
  /** Placeholder text(s) for the textarea - can be array for rotation */
  placeholder?: string | string[]
  /** Whether input is disabled */
  disabled?: boolean
  /** Whether the session is currently processing */
  isProcessing?: boolean
  /** Callback when message is submitted (skillSlugs from @mentions) */
  onSubmit: (message: string, attachments?: FileAttachment[], skillSlugs?: string[]) => void
  /** Callback to stop processing. Pass silent=true to skip "Response interrupted" message */
  onStop?: (silent?: boolean) => void
  /** External ref for the input */
  inputRef?: React.RefObject<RichTextInputHandle>
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes connection slug for proper persistence) */
  // Thinking level (session-level setting)
  /** Current thinking level ('off', 'think', 'max') */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  // Advanced options
  permissionMode?: PermissionMode
  onPermissionModeChange?: (mode: PermissionMode) => void
  /** Enabled permission modes for Shift+Tab cycling (min 2 modes) */
  enabledModes?: PermissionMode[]
  /** Offer configured MCP servers in `/mcp` and `@` (off when undefined). */
  mcpPickerEnabled?: boolean
  // Controlled input value (for persisting across mode switches and conversation changes)
  /** Current input value - if provided, component becomes controlled */
  inputValue?: string
  /** Callback when input value changes */
  onInputChange?: (value: string) => void
  /** Persisted attachment draft for this session (seeds local state on session switch) */
  attachmentsValue?: FileAttachment[]
  /** Callback when attachment list changes (add, remove, clear on send) */
  onAttachmentsChange?: (attachments: FileAttachment[]) => void
  /** When true, removes container styling (shadow, bg, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
  /** Callback when component height changes (for external animation sync) */
  onHeightChange?: (height: number) => void
  /** Callback when focus state changes */
  onFocusChange?: (focused: boolean) => void
  // Skill selection (for @mentions)
  /** Available skills for @mention autocomplete */
  skills?: LoadedSkill[]
  /** Workspace ID for loading skill icons */
  workspaceId?: string
  /** Current working directory path */
  workingDirectory?: string
  /** Session folder path (for "Reset to Session Root" option) */
  sessionFolderPath?: string
  /** Session ID for scoping events like approve-plan */
  sessionId?: string
  /** Disable send action (for tutorial guidance) */
  disableSend?: boolean
  /** Whether the session is empty (no messages yet) - affects context badge prominence */
  isEmptySession?: boolean
  /** Context status for showing compaction indicator and token usage */
  contextStatus?: {
    /** True when SDK is actively compacting the conversation */
    isCompacting?: boolean
    /** Input tokens used so far in this session */
    inputTokens?: number
    /** Model's context window size in tokens */
    contextWindow?: number
    /** Backend context-meter reading; drives the ring beside the send button */
    contextUsage?: ContextUsageReading
  }
  /** Follow-up annotations shown as context chips above the input */
  followUpItems?: FollowUpInputItem[]
  /** Callback when user clicks a follow-up chip body */
  onFollowUpClick?: (item: FollowUpInputItem, anchor?: { x: number; y: number }) => void
  /** Callback when user clicks the follow-up index badge */
  onFollowUpIndexClick?: (item: FollowUpInputItem) => void
  /**
   * Compact-footer layout. Used by EditPopover (popover embedding) and by
   * ChatPage in auto-compact / WebUI mobile mode. The popover case hides the
   * model picker; the auto-compact case opts the compact picker in via
   * `enableCompactModelPicker`.
   */
  compactMode?: boolean
  /**
   * When `compactMode` is true, render the compact (drawer-based) model
   * selector next to the permission-mode pill. Defaults to false so that
   * EditPopover (which has no use for a model picker) keeps its current
   * behavior.
   */
  enableCompactModelPicker?: boolean
  // Connection selection (hierarchical connection → model selector)
  /** Current LLM connection slug (locked after first message) */
  currentConnection?: string
  /** Callback when connection changes (only works when session is empty) */
  onConnectionChange?: (connectionSlug: string) => void
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean
  /**
   * True when the input is collapsed because the agent is processing in
   * compact mode and the user hasn't expanded it yet. Owned by
   * `InputContainer`; toggle back via `onRequestExpand`.
   */
  isCollapsedInCompact?: boolean
  /** Callback fired when the user clicks or hovers the collapsed-input strip. */
  onRequestExpand?: () => void
}

/**
 * FreeFormInput - Self-contained textarea input with attachments and controls
 *
 * Features:
 * - Auto-growing textarea
 * - File attachments via button or drag-drop
 * - Slash commands menu
 * - Model selector
 * - Active option badges
 */
export function FreeFormInput({
  placeholder,
  disabled = false,
  isProcessing = false,
  onSubmit,
  onStop,
  inputRef: externalInputRef,
  currentModel,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  permissionMode = 'ask',
  onPermissionModeChange,
  enabledModes = DEFAULT_CYCLABLE_PERMISSION_MODES,
  mcpPickerEnabled = true,
  inputValue,
  onInputChange,
  attachmentsValue,
  onAttachmentsChange,
  unstyled = false,
  onHeightChange,
  onFocusChange,
  skills = [],
  workspaceId,
  workingDirectory,
  sessionFolderPath,
  sessionId,
  disableSend = false,
  isEmptySession = false,
  contextStatus,
  followUpItems = [],
  onFollowUpClick,
  onFollowUpIndexClick,
  compactMode = false,
  enableCompactModelPicker = false,
  currentConnection,
  onConnectionChange,
  connectionUnavailable = false,
  isCollapsedInCompact = false,
  onRequestExpand,
}: FreeFormInputProps) {
  const { t } = useTranslation()

  // MCP servers offered by `/mcp` and `@`, with their live status.
  const { servers: mcpServers } = useMcpServerOptions(mcpPickerEnabled)

  // Rotating placeholders for the empty composer. They are the only place the
  // input teaches its own affordances, so each one names a trigger the user
  // can act on right there.
  const defaultPlaceholders = React.useMemo(() => {
    const hints = [
      t("chatInput.placeholder.workOn"),
      t("chatInput.placeholder.slash"),
      t("chatInput.placeholder.mention"),
      t("chatInput.placeholder.shiftTab"),
      t("chatInput.placeholder.newLine"),
      t("chatInput.placeholder.sidebar", { key: cmdKey }),
      t("chatInput.placeholder.focusMode", { key: cmdKey }),
    ]
    // A hint for a feature nobody has set up is noise, not onboarding.
    if (mcpServers.length > 0) hints.push(t("chatInput.placeholder.mcp"))
    return hints
  }, [t, mcpServers.length])

  const effectivePlaceholderProp = placeholder ?? defaultPlaceholders

  // Read connection default model, connections, and workspace info from context.
  // Uses optional variant so playground (no provider) doesn't crash.
  const appShellCtx = useOptionalAppShellContext()
  // Memoized so the empty-array fallback is not a fresh reference every
  // render, which would invalidate every memo downstream that depends on it.
  const llmConnections = React.useMemo(
    () => appShellCtx?.llmConnections ?? [],
    [appShellCtx?.llmConnections],
  )
  const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection

  // The session's model directory — the ONE state the picker renders from and
  // submits through.
  //
  // The revision must be a VALUE, not the connections array: that array is a
  // fresh reference on every render, so passing it would refetch the directory
  // on every render. Fold the fields a directory actually depends on into a
  // string, and a provider edited in Settings converges here without
  // reopening the session, while an unrelated render changes nothing.
  const connectionsRevision = React.useMemo(
    () => llmConnections
      .map(c => `${c.slug}:${c.isAuthenticated}:${c.defaultModel ?? ''}:${c.models?.length ?? 0}`)
      .join('|'),
    [llmConnections],
  )
  const modelDirectory = useModelDirectory(sessionId, connectionsRevision)

  // Effective connection details, still needed by the image-support banner.
  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])

  // Display name for the route in use. The host's resolved id is the fallback
  // rather than a synthesized catalog row: a route serving an unadvertised
  // model is real, so name it instead of pretending it does not exist.
  const currentModelDisplayName = React.useMemo(() => {
    const { current, resolvedModel, groups } = modelDirectory.state
    const advertised = groups
      .find(group => group.slug === current?.connection)?.models
      .find(model => model.id === (current?.model ?? resolvedModel))
    return advertised?.name
      ?? (resolvedModel ? stripPiPrefixForDisplay(resolvedModel) : currentModel)
  }, [modelDirectory.state, currentModel])

  // Sending is blocked only when the host definitively says no connection
  // serves this session's route. `null` — before the first load, or after one
  // failed — must never block, or a slow or unreachable host would lock a
  // composer that works fine. Catalog membership never blocks either: a route
  // serving a model it stopped advertising is absent from the groups yet
  // perfectly usable. The model seat stays live throughout, because choosing
  // a model is what clears this block.
  const routeBlocked = blocksComposer(modelDirectory.state.routable)

  // Context readout, kept in the menu where it has always lived.
  const modelMenuFooter = contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 ? (
    <>
      <StyledDropdownMenuSeparator className="my-1" />
      <div className="flex items-center justify-between px-2 py-1.5 text-xs text-muted-foreground select-none">
        <span>{t('chat.context')}</span>
        <span className="flex items-center gap-1.5">
          {contextStatus.isCompacting && <Spinner className="h-3 w-3" />}
          {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
        </span>
      </div>
    </>
  ) : undefined


  // Workspace slug for SDK skill qualification (server-computed)
  // SDK expects "workspaceSlug:skillSlug" format, NOT UUID
  const workspaceSlug = React.useMemo(() => {
    if (!appShellCtx || !workspaceId) return workspaceId
    return appShellCtx.workspaces.find(w => w.id === workspaceId)?.slug ?? workspaceId
  }, [appShellCtx, workspaceId])

  // Read panel focus state from context (for multi-panel unfocused styling)
  const appShellContext = useOptionalAppShellContext()
  const isFocusedPanel = appShellContext?.isFocusedPanel ?? true

  // In compact mode, suppress desktop-keyboard guidance that is noisy or
  // misleading on narrow/mobile-like layouts. This filters the list actually
  // shown (defaults included), not just an explicitly passed `placeholder`.
  const placeholderOptions = React.useMemo(() => {
    if (!Array.isArray(effectivePlaceholderProp)) return effectivePlaceholderProp
    if (!compactMode) return effectivePlaceholderProp
    return effectivePlaceholderProp.filter((entry) => {
      const lower = entry.toLowerCase()
      return !lower.includes('shift + tab')
        && !lower.includes('shift + return')
        && !lower.includes('toggle the sidebar')
        && !lower.includes('focus mode')
        && !lower.includes('⌘')
        && !lower.includes('ctrl')
    })
  }, [effectivePlaceholderProp, compactMode])

  // Shuffle so each session opens on a different hint. Hide the placeholder
  // entirely when the panel is unfocused in a multi-panel layout.
  const placeholderCount = Array.isArray(placeholderOptions) ? placeholderOptions.length : 1
  const shuffledPlaceholder = React.useMemo(
    () => Array.isArray(placeholderOptions) ? shuffleArray(placeholderOptions) : placeholderOptions,
    // Shuffle once per hint set, not per render: the MCP hint is appended once
    // the server list loads, and that is the only expected change.
    [placeholderCount] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const effectivePlaceholder = isFocusedPanel ? shuffledPlaceholder : ''

  // Performance optimization: Always use internal state for typing to avoid parent re-renders
  // Sync FROM parent on mount/change (for restoring drafts)
  // Sync TO parent on blur/submit (debounced persistence)
  const [input, setInput] = React.useState(() => coerceInputText(inputValue))
  const [attachments, setAttachments] = React.useState<FileAttachment[]>(attachmentsValue ?? [])

  // Ref to track current attachments for use in event handlers (avoids stale closure issues)
  const attachmentsRef = React.useRef<FileAttachment[]>([])
  React.useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  // Seed from parent when `attachmentsValue` changes (e.g., switching sessions).
  // `skipPersistRef` tells the save effect below that the next `attachments` change
  // is a prop-driven seed, not user intent — otherwise we'd echo the seed back to
  // the parent and risk persisting A's attachments under B's sessionId.
  const attachmentsRefsKey = React.useMemo(() => {
    if (!attachmentsValue) return ''
    return attachmentsValue.map(a => a.path).join('|')
  }, [attachmentsValue])
  const prevAttachmentsRefsKey = React.useRef(attachmentsRefsKey)
  const skipPersistRef = React.useRef(true) // treat initial mount as a prop-seed
  React.useEffect(() => {
    if (attachmentsValue === undefined) return
    if (attachmentsRefsKey === prevAttachmentsRefsKey.current) return
    prevAttachmentsRefsKey.current = attachmentsRefsKey
    skipPersistRef.current = true
    setAttachments(attachmentsValue)
  }, [attachmentsValue, attachmentsRefsKey])

  // Persist user-initiated attachment changes back to the parent. The parent stores
  // refs (path + name) and debounces the disk write, so we fire eagerly on every
  // change — add/remove/send-clear.
  const onAttachmentsChangeRef = React.useRef(onAttachmentsChange)
  onAttachmentsChangeRef.current = onAttachmentsChange
  React.useEffect(() => {
    if (skipPersistRef.current) {
      skipPersistRef.current = false
      return
    }
    onAttachmentsChangeRef.current?.(attachments)
  }, [attachments])

  // Sync from parent when inputValue changes externally (e.g., switching sessions)
  const prevInputValueRef = React.useRef(coerceInputText(inputValue))
  React.useEffect(() => {
    if (inputValue === undefined) return
    const nextInputValue = coerceInputText(inputValue)
    if (nextInputValue !== prevInputValueRef.current) {
      setInput(nextInputValue)
      prevInputValueRef.current = nextInputValue
    }
  }, [inputValue])

  // Debounced sync to parent (saves draft without blocking typing)
  const syncTimeoutRef = React.useRef<NodeJS.Timeout | null>(null)
  const syncToParent = React.useCallback((value: string) => {
    if (!onInputChange) return
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    syncTimeoutRef.current = setTimeout(() => {
      onInputChange(value)
      prevInputValueRef.current = value
    }, 300) // Debounce 300ms
  }, [onInputChange])

  // Sync immediately on unmount to preserve input across mode switches
  // Also cleanup any pending debounced sync
  const inputRef = React.useRef(input)
  inputRef.current = input // Keep ref in sync with state

  React.useEffect(() => {
    return () => {
      // Cancel pending debounced sync
      if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
      // Immediately sync current value to parent on unmount
      // This preserves input when switching to structured input (e.g., permission request)
      if (onInputChange && inputRef.current !== prevInputValueRef.current) {
        onInputChange(inputRef.current)
      }
    }
  }, [onInputChange])

  const [isDraggingOver, setIsDraggingOver] = React.useState(false)
  const [loadingCount, setLoadingCount] = React.useState(0)
  const [isFocused, setIsFocused] = React.useState(false)
  const [inputMaxHeight, setInputMaxHeight] = React.useState(540)
  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Input settings (loaded from config)
  const [autoCapitalisation, setAutoCapitalisation] = React.useState(true)
  const [sendMessageKey, setSendMessageKey] = React.useState<'enter' | 'cmd-enter'>('enter')
  const [spellCheck, setSpellCheck] = React.useState(false)

  // Load input settings on mount
  React.useEffect(() => {
    const loadInputSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [autoCapEnabled, sendKey, spellCheckEnabled] = await Promise.all([
          window.electronAPI.getAutoCapitalisation(),
          window.electronAPI.getSendMessageKey(),
          window.electronAPI.getSpellCheck(),
        ])
        setAutoCapitalisation(autoCapEnabled)
        setSendMessageKey(sendKey ?? 'enter')
        setSpellCheck(spellCheckEnabled)
      } catch (error) {
        console.error('Failed to load input settings:', error)
      }
    }
    loadInputSettings()
  }, [])

  // Double-Esc interrupt: show warning overlay on first Esc, interrupt on second
  const { showEscapeOverlay } = useEscapeInterrupt()

  // Calculate max height: min(66% of window height, 540px)
  React.useEffect(() => {
    const updateMaxHeight = () => {
      const maxFromWindow = Math.floor(window.innerHeight * 0.66)
      setInputMaxHeight(Math.min(maxFromWindow, 540))
    }
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const dragCounterRef = React.useRef(0)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)

  // Merge refs for RichTextInput
  const internalInputRef = React.useRef<RichTextInputHandle>(null)
  const richInputRef = externalInputRef || internalInputRef

  // Track last caret position for focus restoration (e.g., after permission mode popover closes)
  const lastCaretPositionRef = React.useRef<number | null>(null)

  // Listen for craft:insert-text events (generic mechanism for inserting text into input)
  // Used by components that want to pre-fill the input with text
  React.useEffect(() => {
    const handleInsertText = (e: CustomEvent<{ text: string; sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const text = coerceInputText(e.detail?.text)
      setInput(text)
      syncToParent(text)
      // Focus the input after inserting
      setTimeout(() => {
        richInputRef.current?.focus()
        // Move cursor to end
        richInputRef.current?.setSelectionRange(text.length, text.length)
      }, 0)
    }

    window.addEventListener('craft:insert-text', handleInsertText as EventListener)
    return () => window.removeEventListener('craft:insert-text', handleInsertText as EventListener)
  }, [sessionId, isFocusedPanel, syncToParent, richInputRef])

  const clearInputDraft = React.useCallback(() => {
    // Update refs immediately — setState is async, and an unmount between clear
    // and the next commit (e.g. empty-chat → messages layout remount) would
    // otherwise re-persist the pre-clear text via the unmount draft sync.
    setInput('')
    inputRef.current = ''
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    prevInputValueRef.current = ''
  }, [onInputChange])

  const handleToggleModelVision = useModelVisionToggle()

  const consumeInputDraftSnapshot = React.useCallback((): string => {
    const snapshot = input.trim()
    clearInputDraft()
    return snapshot
  }, [input, clearInputDraft])

  type PlanApprovalEventDetail = {
    sessionId?: string
    planPath?: string
    includeDraftInput?: boolean
    source?: string
  }

  // Listen for craft:approve-plan events (used by ResponseCard's Accept Plan button)
  // This disables safe mode AND submits the message in one action
  // Only process events for this session (sessionId must match)
  React.useEffect(() => {
    const handleApprovePlan = (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInput = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''
      const text = buildPlanApprovalMessage({
        planPath: e.detail?.planPath,
        draftInput,
      })

      // Switch to allow-all (Auto) mode if in Explore mode (allow execution without prompts)
      // Only switch if currently in safe mode - if user is in 'ask' mode, respect their choice
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      onSubmit(text, undefined)
    }

    window.addEventListener('craft:approve-plan', handleApprovePlan as EventListener)
    return () => window.removeEventListener('craft:approve-plan', handleApprovePlan as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

  // Listen for craft:approve-plan-with-compact events (Accept & Compact option)
  // This compacts the conversation first, then executes the plan.
  // The pending state is persisted to survive page reloads (CMD+R).
  React.useEffect(() => {
    const handleApprovePlanWithCompact = async (e: CustomEvent<PlanApprovalEventDetail>) => {
      // Only handle if this event is for our session
      if (e.detail?.sessionId && e.detail.sessionId !== sessionId) {
        return
      }

      const planPath = e.detail?.planPath
      const shouldIncludeDraft = e.detail?.includeDraftInput !== false
      const draftInputSnapshot = shouldIncludeDraft ? consumeInputDraftSnapshot() : ''

      // Switch to allow-all (Auto) mode if in Explore mode
      if (permissionMode === 'safe') {
        onPermissionModeChange?.('allow-all')
      }

      // Persist the pending plan execution state BEFORE sending /compact.
      // This allows reload recovery if CMD+R happens during compaction.
      if (sessionId) {
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'setPendingPlanExecution',
          planPath: planPath ?? '',
          draftInputSnapshot,
        })
      }

      // Send /compact to trigger compaction
      onSubmit('/compact', undefined)

      // Set up a one-time listener for compaction complete.
      // This handles the normal case (no reload during compaction).
      const handleCompactionComplete = async (compactEvent: CustomEvent<{ sessionId?: string }>) => {
        // Only handle if this is for our session
        if (compactEvent.detail?.sessionId !== sessionId) {
          return
        }

        // Remove the listener (one-time use)
        window.removeEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)

        const executionMessage = buildPlanApprovalMessage({
          planPath,
          draftInput: draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        // Clear the pending state since we just sent the execution message
        if (sessionId) {
          await window.electronAPI.sessionCommand(sessionId, {
            type: 'clearPendingPlanExecution',
          })
        }
      }

      window.addEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    }

    window.addEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
    return () => window.removeEventListener('craft:approve-plan-with-compact', handleApprovePlanWithCompact as unknown as EventListener)
  }, [sessionId, permissionMode, onPermissionModeChange, onSubmit, consumeInputDraftSnapshot])

  // Reload recovery: Check for pending plan execution on mount.
  // If the page reloaded after compaction completed (awaitingCompaction = false),
  // we need to send the plan execution message that was interrupted by the reload.
  // Also listen for compaction-complete in case CMD+R happened during compaction.
  React.useEffect(() => {
    if (!sessionId) return

    let hasExecuted = false

    const isExpectedReconnectError = (error: unknown): boolean => {
      const message = error instanceof Error ? error.message : String(error)
      return message.includes('Connection closed')
        || message.includes('Client disconnected')
        || message.includes('transport')
        || message.includes('socket')
    }

    const executePendingPlan = async () => {
      if (hasExecuted) return

      try {
        const pending = await window.electronAPI.getPendingPlanExecution(sessionId)
        if (!pending || pending.awaitingCompaction || pending.executionDispatched) return

        // Mark dispatched before sending so reload recovery does not double-submit
        // the same plan if onSubmit succeeds but cleanup fails during a reconnect.
        await window.electronAPI.sessionCommand(sessionId, {
          type: 'markPendingPlanExecutionDispatched',
        })

        // Compaction completed but we never sent the execution message (page reloaded).
        // Send it now and clear the pending state.
        hasExecuted = true
        const executionMessage = buildPlanApprovalMessage({
          planPath: pending.planPath,
          draftInput: pending.draftInputSnapshot,
        })
        onSubmit(executionMessage, undefined)

        await window.electronAPI.sessionCommand(sessionId, {
          type: 'clearPendingPlanExecution',
        })
      } catch (error) {
        if (!isExpectedReconnectError(error)) {
          console.error('[FreeFormInput] Failed to resume pending plan execution:', error)
        }
      }
    }

    // Check immediately on mount (handles case where compaction already completed)
    executePendingPlan()

    // Also listen for compaction-complete in case CMD+R happened during compaction.
    // When compaction finishes after reload, this listener will trigger execution.
    const handleCompactionComplete = async (e: CustomEvent<{ sessionId: string }>) => {
      if (e.detail?.sessionId !== sessionId) return
      // Small delay to ensure markCompactionComplete has been called
      await new Promise(resolve => setTimeout(resolve, 100))
      executePendingPlan()
    }

    window.addEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    return () => {
      window.removeEventListener('craft:compaction-complete', handleCompactionComplete as unknown as EventListener)
    }
  }, [sessionId, onSubmit])

  // Listen for craft:focus-input events (restore focus after popover/dropdown closes)
  React.useEffect(() => {
    const handleFocusInput = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail
      const targetSessionId = detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      if (targetSessionId) {
        clearPendingFocusForSession(targetSessionId)
      }

      richInputRef.current?.focus()
      // Restore caret position if saved, then clear it (one-shot)
      if (lastCaretPositionRef.current !== null) {
        richInputRef.current?.setSelectionRange(
          lastCaretPositionRef.current,
          lastCaretPositionRef.current
        )
        lastCaretPositionRef.current = null
      }
    }

    window.addEventListener('craft:focus-input', handleFocusInput)
    return () => window.removeEventListener('craft:focus-input', handleFocusInput)
  }, [sessionId, isFocusedPanel, richInputRef])

  // Recover queued focus requests after session switch/mount races.
  React.useEffect(() => {
    if (!consumePendingFocusForSession(sessionId)) return

    setTimeout(() => {
      richInputRef.current?.focus()
    }, 0)
  }, [sessionId, richInputRef])

  // Get the next available number for a pasted file prefix (e.g., pasted-image-1, pasted-image-2)
  const getNextPastedNumber = (
    prefix: 'image' | 'text' | 'file',
    existingAttachments: FileAttachment[]
  ): number => {
    const pattern = new RegExp(`^pasted-${prefix}-(\\d+)\\.`)
    let maxNum = 0
    for (const att of existingAttachments) {
      const match = att.name.match(pattern)
      if (match) {
        maxNum = Math.max(maxNum, parseInt(match[1], 10))
      }
    }
    return maxNum + 1
  }

  // Listen for craft:paste-files events (for global paste when input not focused)
  React.useEffect(() => {
    const handlePasteFiles = async (e: CustomEvent<{ files: File[]; sessionId?: string }>) => {
      if (disabled) return

      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return

      const { files } = e.detail
      if (!files || files.length === 0) return

      setLoadingCount(prev => prev + files.length)

      // Pre-assign sequential names using ref to avoid race conditions
      let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
      const fileNames: string[] = files.map(file => {
        if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
          const ext = file.type.split('/')[1] || 'png'
          return `pasted-image-${nextImageNum++}.${ext}`
        }
        return file.name
      })

      for (let i = 0; i < files.length; i++) {
        try {
          const attachment = await readFileAsAttachment(files[i], fileNames[i])
          if (attachment) {
            setAttachments(prev => [...prev, attachment])
          }
        } catch (error) {
          console.error('[FreeFormInput] Failed to process pasted file:', error)
        }
        setLoadingCount(prev => prev - 1)
      }

      // Focus the input after adding attachments
      richInputRef.current?.focus()
    }

    window.addEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
    return () => window.removeEventListener('craft:paste-files', handlePasteFiles as unknown as EventListener)
  }, [disabled, sessionId, isFocusedPanel, richInputRef])

  const mcpMenuItems = React.useMemo(
    () => mcpServers.map((server) => ({
      name: server.name,
      ...(server.display ? { statusLabel: t(`settings.mcp.status.${server.display.status}`) } : {}),
      ...(server.display?.toolCount !== undefined ? { toolCount: server.display.toolCount } : {}),
    })),
    [mcpServers, t],
  )
  const mcpMentionItems = React.useMemo(
    () => (mcpPickerEnabled ? mcpMenuItems.map((server) => ({
      name: server.name,
      ...(server.statusLabel || server.toolCount !== undefined
        ? {
            status: [
              server.statusLabel,
              server.toolCount !== undefined
                ? t('settings.mcp.server.toolCount', { count: server.toolCount })
                : null,
            ].filter(Boolean).join(' · '),
          }
        : {}),
    })) : []),
    [mcpMenuItems, mcpPickerEnabled, t],
  )
  const mcpLabels = React.useMemo(() => ({
    section: t('mcpMention.section'),
    description: t('mcpMention.itemDescription'),
    toolCount: (count: number) => t('settings.mcp.server.toolCount', { count }),
  }), [t])

  // Build active commands list for slash command menu
  const activeCommands = React.useMemo(() => {
    const active: SlashCommandId[] = []
    // Add the currently active permission mode
    if (permissionMode === 'safe') active.push('safe')
    else if (permissionMode === 'ask') active.push('ask')
    else if (permissionMode === 'allow-all') active.push('allow-all')
    return active
  }, [permissionMode])

  // Handle slash command selection (mode/feature commands)
  const handleSlashCommand = React.useCallback((commandId: SlashCommandId) => {
    if (commandId === 'safe') onPermissionModeChange?.('safe')
    else if (commandId === 'ask') onPermissionModeChange?.('ask')
    else if (commandId === 'allow-all') onPermissionModeChange?.('allow-all')
    // `mcp:<server>` needs no side effect: the hook puts its token in the
    // input, and the message carries the instruction from there.
    else if (commandId === 'compact' && !isProcessing) onSubmit('/compact', undefined)
  }, [onPermissionModeChange, isProcessing, onSubmit])

  // Inline slash command hook (modes, MCP scope and features).
  const inlineSlash = useInlineSlashCommand({
    inputRef: richInputRef,
    onSelectCommand: handleSlashCommand,
    activeCommands,
    enabledModes,
    mcpServers: mcpMenuItems,
    mcpLabels,
  })

  // Inline mention hook (skills, files and MCP servers)
  const inlineMention = useInlineMention({
    inputRef: richInputRef,
    skills,
    basePath: workingDirectory,
    onSelect: () => undefined,
    // Use workspace slug (not UUID) for SDK skill qualification
    workspaceId: workspaceSlug,
    mcpServers: mcpMentionItems,
    mcpSectionLabel: t('mcpMention.section'),
  })

  // Report height changes to parent (for external animation sync)
  React.useLayoutEffect(() => {
    if (!onHeightChange || !containerRef.current) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        onHeightChange(entry.contentRect.height)
      }
    })

    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [onHeightChange])

  // In compact mode, immediately report collapsed height when the input is
  // collapsed during processing. This ensures smooth animation timing.
  // When the user expands (or processing ends), the ResizeObserver takes
  // over and reports the actual rendered height.
  React.useEffect(() => {
    if (!onHeightChange) return
    if (isCollapsedInCompact) {
      // Collapsed state - only bottom bar visible (~44px)
      onHeightChange(44)
    }
  }, [isCollapsedInCompact, onHeightChange])

  // Check if running in Electron environment (has electronAPI)
  const hasElectronAPI = typeof window !== 'undefined' && !!window.electronAPI

  // Shared helper: read a File, add as attachment, decrement loading count
  const processFileAttachment = async (file: File, overrideName?: string) => {
    try {
      const attachment = await readFileAsAttachment(file, overrideName)
      if (attachment) {
        setAttachments(prev => [...prev, attachment])
      }
    } catch (error) {
      console.error('[FreeFormInput] Failed to read file:', error)
    }
    setLoadingCount(prev => prev - 1)
  }

  // File attachment handlers
  const handleAttachClick = () => {
    if (disabled) return
    fileInputRef.current?.click()
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    const fileList = Array.from(files)
    setLoadingCount(prev => prev + fileList.length)

    for (const file of fileList) {
      await processFileAttachment(file)
    }

    // Reset input so re-selecting the same file triggers onChange again
    e.target.value = ''
  }

  const handleRemoveAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }

  // Drag and drop handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDraggingOver(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDraggingOver(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  // Helper to read a File using FileReader API
  const readFileAsAttachment = async (file: File, overrideName?: string): Promise<FileAttachment | null> => {
    // Capture the absolute OS path at attach time. Works for <input type="file"> and
    // OS drag-drop; returns null for clipboard paste and web-drag (no disk origin).
    // When null, the draft layer falls back to persisting content inline (Track C).
    const realPath = hasElectronAPI ? window.electronAPI.getFilePath?.(file) ?? null : null

    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = async () => {
        const result = reader.result as ArrayBuffer
        // Chunked base64 encoding — btoa + reduce fails on large files (>1MB)
        // due to O(n²) string concatenation and browser string-length limits
        const bytes = new Uint8Array(result)
        let binary = ''
        const chunkSize = 8192
        for (let i = 0; i < bytes.length; i += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, bytes.length)))
        }
        const base64 = btoa(binary)

        let type: FileAttachment['type'] = 'unknown'
        const fileName = overrideName || file.name
        if (file.type.startsWith('image/')) type = 'image'
        else if (file.type === 'application/pdf') type = 'pdf'
        else if (file.type.includes('text') || fileName.match(/\.(txt|md|json|js|ts|tsx|py|css|html)$/i)) type = 'text'
        else if (file.type.includes('officedocument') || fileName.match(/\.(docx?|xlsx?|pptx?)$/i)) type = 'office'

        const mimeType = file.type || 'application/octet-stream'

        // For text files, decode the ArrayBuffer as UTF-8 text
        let text: string | undefined
        if (type === 'text') {
          text = new TextDecoder('utf-8').decode(new Uint8Array(result))
        }

        let thumbnailBase64: string | undefined
        if (hasElectronAPI) {
          try {
            const thumb = await window.electronAPI.generateThumbnail(base64, mimeType)
            if (thumb) thumbnailBase64 = thumb
          } catch {
            // Thumbnail generation is optional, continue without it
          }
        }

        resolve({
          type,
          path: realPath ?? fileName,
          name: fileName,
          mimeType,
          base64,
          text,
          size: file.size,
          thumbnailBase64,
        })
      }
      reader.onerror = () => resolve(null)
      reader.readAsArrayBuffer(file)
    })
  }

  // Clipboard paste handler for files/images
  const handlePaste = async (e: React.ClipboardEvent) => {
    if (disabled) return

    const clipboardItems = e.clipboardData?.files
    if (!clipboardItems || clipboardItems.length === 0) return

    // We have files to process - prevent default text paste behavior
    e.preventDefault()

    const files = Array.from(clipboardItems)
    setLoadingCount(prev => prev + files.length)

    // Pre-assign sequential names using ref to avoid race conditions
    let nextImageNum = getNextPastedNumber('image', attachmentsRef.current)
    const fileNames: string[] = files.map(file => {
      if (!file.name || file.name === 'image.png' || file.name === 'image.jpg' || file.name === 'blob') {
        const ext = file.type.split('/')[1] || 'png'
        return `pasted-image-${nextImageNum++}.${ext}`
      }
      return file.name
    })

    for (let i = 0; i < files.length; i++) {
      await processFileAttachment(files[i], fileNames[i])
    }
  }

  // Handle long text paste - convert to file attachment
  const handleLongTextPaste = React.useCallback((text: string) => {
    const nextNum = getNextPastedNumber('text', attachmentsRef.current)
    const fileName = `pasted-text-${nextNum}.txt`
    const attachment: FileAttachment = {
      type: 'text',
      path: fileName,
      name: fileName,
      mimeType: 'text/plain',
      text: text,
      size: new Blob([text]).size,
    }
    setAttachments(prev => [...prev, attachment])
    // Focus input after adding attachment
    richInputRef.current?.focus()
  }, []) // No deps needed - uses ref

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingOver(false)
    if (disabled) return

    const files = Array.from(e.dataTransfer.files)
    setLoadingCount(files.length)

    for (const file of files) {
      await processFileAttachment(file)
    }
  }

  // Submit message - backend handles queueing and interruption
  const submitMessage = React.useCallback(() => {
    const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0
    if (!hasContent || disabled) return false

    // No connection serves this route: sending would fail inside the backend
    // with a message about registration. Refusing here names the problem while
    // the draft is still in the composer, and the model seat is right there.
    if (routeBlocked) {
      toast.error(t('chat.connectionUnavailableDescription'))
      return false
    }

    // Tutorial may disable sending to guide user through specific steps
    if (disableSend) return false

    // Parse retained Skill mentions.
    const mentions = parseMentions(input, skills.map(s => s.slug))
    const attachmentSnapshot = attachments

    // The `[mcp:server]` token rides along with the message: the agent turns
    // it into an explicit "use this server" instruction (see formatMcpDirective),
    // and the transcript keeps rendering it as a chip.
    onSubmit(
      input.trim(),
      attachmentSnapshot.length > 0 ? attachmentSnapshot : undefined,
      mentions.skills.length > 0 ? mentions.skills : undefined
    )
    // Clear local + parent draft immediately. Refs must update synchronously:
    // first-message send flips empty-chat layout and remounts this input in the
    // same turn; unmount draft-sync would restore stale text if inputRef lagged.
    setInput('')
    inputRef.current = ''
    setAttachments([])
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current)
    onInputChange?.('')
    onAttachmentsChange?.([])
    prevInputValueRef.current = ''

    // Restore focus after state updates
    requestAnimationFrame(() => {
      richInputRef.current?.focus()
    })

    return true
  }, [input, attachments, followUpItems, disabled, disableSend, routeBlocked, t, onInputChange, onAttachmentsChange, onSubmit, skills])

  // Listen for craft:submit-input events (simulate pressing the Send button)
  React.useEffect(() => {
    const handleSubmitInput = (e: CustomEvent<{ sessionId?: string }>) => {
      const targetSessionId = e.detail?.sessionId
      if (!shouldHandleScopedInputEvent({ sessionId, isFocusedPanel, targetSessionId })) return
      submitMessage()
    }

    window.addEventListener('craft:submit-input', handleSubmitInput as EventListener)
    return () => window.removeEventListener('craft:submit-input', handleSubmitInput as EventListener)
  }, [sessionId, isFocusedPanel, submitMessage])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    submitMessage()
  }

  const handleStop = (silent = false) => {
    onStop?.(silent)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // During IME composition, ESC should cancel composition, not trigger app/menu ESC behavior.
    if (e.key === 'Escape' && e.nativeEvent.isComposing) {
      return
    }

    // Don't submit when mention menu is open AND has visible content
    if (inlineMention.isOpen) {
      // Only intercept navigation/selection keys if menu actually shows items or is loading
      const hasVisibleContent = inlineMention.sections.some(s => s.items.length > 0) || inlineMention.isSearching
      if (hasVisibleContent && (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        // These keys are handled by the InlineMentionMenu component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineMention.close()
        return
      }
    }

    // Don't submit when slash command menu is open - let it handle the Enter key
    if (inlineSlash.isOpen) {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // These keys are handled by the InlineSlashCommand component
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        inlineSlash.close()
        return
      }
    }

    // Plain Arrow Up with no draft content cancels the running turn and recalls
    // its prompt through ChatDisplay.handleStop. The pure guard deliberately
    // treats whitespace, attachments, loading files, and follow-up chips as draft
    // content so normal editing is never hijacked.
    if (shouldRecallPromptOnArrowUp({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      isProcessing,
      input,
      attachmentCount: attachments.length,
      loadingAttachmentCount: loadingCount,
      followUpItemCount: followUpItems.length,
      inlineMenuOpen: inlineMention.isOpen || inlineSlash.isOpen,
      disabled,
      disableSend,
    })) {
      e.preventDefault()
      handleStop()
      return
    }

    // Skip submission during IME composition - user is confirming composed characters, not sending
    // Handle send key based on user preference:
    // - 'enter': Enter sends (Shift+Enter for newline)
    // - 'cmd-enter': ⌘/Ctrl+Enter sends (Enter for newline)
    if (sendMessageKey === 'enter') {
      // Enter sends, Shift+Enter adds newline
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Also allow Cmd/Ctrl+Enter to send (power user shortcut)
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
    } else {
      // cmd-enter mode: ⌘/Ctrl+Enter sends, plain Enter adds newline
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
        e.preventDefault()
        submitMessage()
      }
      // Plain Enter is allowed to pass through (adds newline)
    }
    if (e.key === 'Escape') {
      // Skip blur if a popover/overlay is open — let the overlay handle ESC instead.
      // This prevents the input from consuming ESC when focus gets pulled back here
      // while a popover is still visible (portal DOM isolation means the event won't
      // reach the popover's DismissableLayer otherwise).
      if (!hasOpenOverlay()) {
        richInputRef.current?.blur()
      }
    }
  }

  // Handle input changes from RichTextInput
  const handleInputChange = React.useCallback((value: string) => {
    const nextValue = coerceInputText(value)
    setInput(nextValue)
    syncToParent(nextValue) // Debounced sync to parent for draft persistence
  }, [syncToParent])

  // Handle input with cursor position (for menu detection)
  const handleRichInput = React.useCallback((value: string, cursorPosition: number) => {
    const nextValue = coerceInputText(value)

    // Update inline slash command state
    inlineSlash.handleInputChange(nextValue, cursorPosition)

    // Update inline mention state (for @mentions - skills, files, folders)
    inlineMention.handleInputChange(nextValue, cursorPosition)

    // Auto-capitalize first letter (but not for slash commands, @mentions, or #labels)
    // Only if autoCapitalisation setting is enabled
    let newValue = nextValue
    if (autoCapitalisation && nextValue.length > 0 && nextValue.charAt(0) !== '/' && nextValue.charAt(0) !== '@' && nextValue.charAt(0) !== '#') {
      const capitalizedFirst = nextValue.charAt(0).toUpperCase()
      if (capitalizedFirst !== nextValue.charAt(0)) {
        newValue = capitalizedFirst + nextValue.slice(1)
        // Set cursor position BEFORE state update so it's used when useEffect syncs the value
        richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
        setInput(newValue)
        syncToParent(newValue)
        return
      }
    }

    // Apply smart typography (-> to →, etc.)
    const typography = applySmartTypography(nextValue, cursorPosition)
    if (typography.replaced) {
      newValue = typography.text
      // Set cursor position BEFORE state update so it's used when useEffect syncs the value
      richInputRef.current?.setSelectionRange(typography.cursor, typography.cursor)
      setInput(newValue)
      syncToParent(newValue)
    }
  }, [inlineSlash, inlineMention, syncToParent, autoCapitalisation])

  // Handle inline slash command selection (removes the /command text)
  const handleInlineSlashCommandSelect = React.useCallback((commandId: SlashCommandId) => {
    const newValue = inlineSlash.handleSelectCommand(commandId)
    setInput(newValue)
    syncToParent(newValue)
    richInputRef.current?.focus()
  }, [inlineSlash, syncToParent])

  // Handle inline mention selection (inserts appropriate mention text)
  const handleInlineMentionSelect = React.useCallback((item: MentionItem) => {
    const { value: newValue, cursorPosition } = inlineMention.handleSelect(item)
    setInput(newValue)
    syncToParent(newValue)
    // Focus input and restore cursor position after badge renders
    setTimeout(() => {
      richInputRef.current?.focus()
      richInputRef.current?.setSelectionRange(cursorPosition, cursorPosition)
    }, 0)
  }, [inlineMention, syncToParent])

  const followUpLayoutKey = React.useMemo(
    () => followUpItems.map(item => [
      item.id,
      item.index ?? '',
      item.noteLabel,
      item.selectedText,
      item.color ?? '',
    ].join('::')).join('|'),
    [followUpItems]
  )
  const previousFollowUpLayoutKeyRef = React.useRef<string | null>(null)
  const [animateFollowUpLayout, setAnimateFollowUpLayout] = React.useState(false)

  React.useEffect(() => {
    const previous = previousFollowUpLayoutKeyRef.current
    previousFollowUpLayoutKeyRef.current = followUpLayoutKey

    if (previous == null || previous === followUpLayoutKey) return

    setAnimateFollowUpLayout(true)
    const timer = window.setTimeout(() => {
      setAnimateFollowUpLayout(false)
    }, 220)

    return () => window.clearTimeout(timer)
  }, [followUpLayoutKey])

  const hasContent = input.trim() || attachments.length > 0 || followUpItems.length > 0

  // Pre-flight image-support check: warn when staged images would be silently
  // stripped by Pi SDK because the active custom-endpoint model is text-only.
  // Gate on pi_compat — built-in catalogs (anthropic/pi) are owned by the SDK
  // and we can't repair them from the UI here.
  const hasStagedImages = attachments.some(a => a.type === 'image' || a.mimeType?.startsWith('image/'))
  const showVisionWarning =
    hasStagedImages
    && !!effectiveConnectionDetails
    && isCompatProvider(effectiveConnectionDetails.providerType)
    && !modelSupportsImages(effectiveConnectionDetails, currentModel)

  return (
    <form onSubmit={handleSubmit}>
      <div
        ref={containerRef}
        className={cn(
          'overflow-hidden transition-all',
          // Container styling - only when not wrapped by InputContainer
          !unstyled && 'rounded-[24px] border border-foreground/[0.08] bg-background',
          isDraggingOver && 'ring-2 ring-foreground ring-offset-2 ring-offset-background bg-foreground/5'
        )}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {/* Inline Slash Command Autocomplete */}
        <InlineSlashCommand
          open={inlineSlash.isOpen}
          onOpenChange={(open) => !open && inlineSlash.close()}
          sections={inlineSlash.sections}
          activeCommands={activeCommands}
          onSelectCommand={handleInlineSlashCommandSelect}
          filter={inlineSlash.filter}
          position={inlineSlash.position}
        />

        {/* Inline Mention Autocomplete (skills and files) */}
        <InlineMentionMenu
          open={inlineMention.isOpen}
          onOpenChange={(open) => !open && inlineMention.close()}
          sections={inlineMention.sections}
          onSelect={handleInlineMentionSelect}
          filter={inlineMention.filter}
          position={inlineMention.position}
          workspaceId={workspaceId}
          maxWidth={280}
          isSearching={inlineMention.isSearching}
        />

        {/* Pre-flight image-support warning — only for pi_compat connections
            where the renderer can both detect text-only models and offer to
            flip the per-model supportsImages override on the spot. */}
        {showVisionWarning && effectiveConnectionDetails && (
          <ImageSupportWarningBanner
            modelName={currentModelDisplayName}
            onEnable={() => handleToggleModelVision(effectiveConnectionDetails.slug, currentModel, true)}
          />
        )}

        {/* Attachment Preview */}
        <AttachmentPreview
          attachments={attachments}
          onRemove={handleRemoveAttachment}
          disabled={disabled}
          loadingCount={loadingCount}
        />

        {/* Follow-up context chips */}
        <AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div layout={animateFollowUpLayout} className="px-3 pt-3.5 pb-0">
                <motion.div layout={animateFollowUpLayout} className="flex flex-wrap gap-1">
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1
                      const tooltipText = item.selectedText.trim() || t('chat.selectedText')
                      const selectedExcerpt = formatFollowUpChipText(item.selectedText, t('chat.selectedText'), 50)
                      const noteExcerpt = formatFollowUpChipText(item.noteLabel, t('chat.followUp'), 50)

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            })
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onFollowUpIndexClick?.(item)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onFollowUpIndexClick?.(item)
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[420px] break-words text-xs">
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">{selectedExcerpt}</span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Rich Text Input with inline mention badges */}
        {/* In compact mode, hide input while the agent is processing — until the
            user clicks / hovers the collapsed bar to expand it back. */}
        {!isCollapsedInCompact && (
        <RichTextInput
          ref={richInputRef}
          value={input}
          onChange={handleInputChange}
          onInput={handleRichInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onLongTextPaste={handleLongTextPaste}
          onFocus={() => { setIsFocused(true); onFocusChange?.(true) }}
          onBlur={() => {
            // Save caret position before losing focus (for restoration via craft:focus-input)
            lastCaretPositionRef.current = richInputRef.current?.selectionStart ?? null
            setIsFocused(false)
            onFocusChange?.(false)
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          skills={skills}
          workspaceId={workspaceSlug}
          className="overflow-y-auto min-h-[100px] px-5 pb-3 pt-4"
          style={{ maxHeight: inputMaxHeight }}
          data-tutorial="chat-input"
          spellCheck={spellCheck}
        />
        )}

        {/* Bottom Row: Controls - wrapped in relative container for status slot overlay */}
        <div className="relative">
          {/* Status slot overlay - escape interrupt (highest priority), browser status, etc. */}
          <ToolbarStatusSlot
            showEscapeOverlay={isProcessing && showEscapeOverlay}
            sessionId={sessionId}
          />

          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5">
          {/* Hidden file input for attach button (shared by compact and desktop) */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileInputChange}
          />

          {/* Compact mode: permission mode drawer + standard icon badges for attach/working dir.
              Wrapper absorbs all squeeze so the model label truncates first and the send button stays
              anchored to the right (craft-agents-oss#798). overflow-hidden is safe — Radix Drawer /
              dropdowns inside render via portals, so they aren't clipped. */}
          {compactMode && (
          <div className="flex items-center gap-1 min-w-0 shrink overflow-hidden">
          {onPermissionModeChange && (
            <CompactPermissionModeSelector
              permissionMode={permissionMode}
              enabledModes={enabledModes}
              onPermissionModeChange={onPermissionModeChange}
            />
          )}
          {enableCompactModelPicker && (
            <CompactModelSelector
              directory={modelDirectory}
              contextStatus={contextStatus}
            />
          )}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attach")
            }
            isExpanded={false}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />
          </div>
          )}

          {/* Desktop: permission + attach + working dir + session info — all inside the composer */}
          {!compactMode && (
          <div className="flex min-w-32 shrink items-center gap-1 overflow-hidden">
          {onPermissionModeChange && (
            <PermissionModeDropdown
              permissionMode={permissionMode}
              onPermissionModeChange={onPermissionModeChange}
              enabledModes={enabledModes}
              sessionId={sessionId}
              compact
            />
          )}
          <FreeFormInputContextBadge
            icon={<Paperclip className="h-4 w-4" />}
            label={attachments.length > 0
              ? t("chat.filesCount", { count: attachments.length })
              : t("chat.attachFiles")
            }
            isExpanded={isEmptySession}
            hasSelection={attachments.length > 0}
            showChevron={false}
            onClick={handleAttachClick}
            tooltip={t("chat.attachFilesTooltip")}
            disabled={disabled}
          />
          <SessionInfoToolbarButton
            sessionId={sessionId}
            sessionFolderPath={sessionFolderPath}
          />
          </div>
          )}

          {/* Spacer — doubles as a tap / hover target while the input is
              collapsed during processing in compact mode, so the user can
              type a follow-up without waiting for the agent to finish. */}
          {isCollapsedInCompact ? (
            <button
              type="button"
              onClick={onRequestExpand}
              onMouseEnter={onRequestExpand}
              aria-label={t('chat.tapToType')}
              className="flex-1 h-7 mx-1 flex items-center justify-center text-foreground/30 hover:text-foreground/60 transition-colors cursor-pointer rounded-[6px] hover:bg-foreground/5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : (
            <div className="flex-1" />
          )}

          {/* Right side: Model + Send - never shrink so they're always visible */}
          <div className="flex items-center shrink-0">
          {/* 5. Model/Connection Selector - Hidden in compact mode (EditPopover embedding) */}
          {/* 5. Model selector — one shared per-session directory, two-level menu.
              No lock and no catalog-size gate: see picker-mode.ts. */}
          {!compactMode && (
            <ModelSelect
              directory={modelDirectory}
              footer={modelMenuFooter}
            />
          )}

          {/* 5.5 Context meter — always-on occupancy ring; the panel carries the
              composition breakdown and, at high occupancy, the compact action
              that used to live in a separate warning badge. */}
          <ContextMeter
            contextUsage={contextStatus?.contextUsage}
            isCompacting={contextStatus?.isCompacting}
            isProcessing={isProcessing}
            onCompact={() => { onSubmit('/compact', []) }}
          />

          {/* 6. Send/Stop Button - Always show stop when processing */}
          {isProcessing ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              aria-label={t('chat.stopResponse')}
              className="send-btn h-7 w-7 rounded-full shrink-0 hover:bg-foreground/15 active:bg-foreground/20 ml-2"
              onClick={() => handleStop(false)}
            >
              <Square className="h-3 w-3 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              aria-label={t('shortcuts.sendMessage')}
              className="send-btn h-7 w-7 rounded-full shrink-0 ml-2"
              disabled={!hasContent || disabled || disableSend || routeBlocked}
              data-tutorial="send-button"
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
          )}
          </div>
          </div>
        </div>
      </div>
    </form>
  )
}
