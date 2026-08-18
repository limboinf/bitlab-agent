import type { EventSink, RpcServer } from '@bitlab/server-core/transport'
import { RPC_CHANNELS, generateMessageId } from '@bitlab/shared/protocol'
import type {
  CreateSessionOptions,
  FileAttachment,
  PermissionModeState,
  PermissionResponseOptions,
  ModelCatalogFailure,
  ModelCatalogModel,
  ModelConnectionGroup,
  SelectModelResult,
  SendMessageOptions,
  Session,
  SessionEvent,
  SessionModels,
  UnreadSummary,
} from '@bitlab/shared/protocol'
import type { ISessionManager, IBrowserPaneManager } from '@bitlab/server-core/handlers'
import {
  CONSOLE_LOGGER,
  createScopedLogger,
  type Logger,
  type PlatformServices,
} from '@bitlab/server-core/runtime'
import type {
  ActiveSessionInfo,
  AgentEvent,
  AnnotationV1,
  ContextUsageReading,
  Message,
  StoredAttachment,
  Workspace,
  WorkspaceInfo,
} from '@bitlab/core/types'
import { messageToStored, storedToMessage } from '@bitlab/core/types'
import {
  AbortReason,
  createBackendFromResolvedContext,
  resolveBackendContext,
  type AgentBackend,
} from '@bitlab/shared/agent/backend'
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
  type BrowserPaneFns,
} from '@bitlab/shared/agent'
import {
  ConfigWatcher,
  getLlmConnections,
  getMiniModel,
  getMcpServers,
  getMcpSettings,
  getActiveWorkspace,
  getWorkspaces,
  modelSupportsImages,
  resolveTitleLanguageName,
  type ConfigWatcherCallbacks,
  type McpApprovalDecision,
  type McpApprovalRequestDto,
  type McpServerStatusDto,
  type McpOperationResult,
  type McpSessionStatusDto,
  type McpStatusSnapshotDto,
  type StoredConfig,
} from '@bitlab/shared/config'
import { getCredentialManager } from '@bitlab/shared/credentials'
import { existsSync } from 'fs'
import { GLOBAL_AGENT_SKILLS_DIR, PROJECT_AGENT_SKILLS_DIR } from '@bitlab/shared/skills'
import { loadWorkspaceConfig, setWorkspaceModelDefaults } from '@bitlab/shared/workspaces'
import {
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionPath as getSessionStoragePath,
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  saveSession as saveStoredSession,
  sessionPersistenceQueue,
  serializeSession,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  validateBundle,
  type DispatchMode,
  type SessionBundle,
  type SessionConfig,
  type SessionHeader,
  type SessionMetadata,
  type SessionTokenUsage,
  type StoredSession,
} from '@bitlab/shared/sessions'
import { restoreFiles } from '@bitlab/shared/utils/bundle-files'
import { readFileAttachment } from '@bitlab/shared/utils'
import { getWorkspaceAllowedDirs, validateFilePath } from '@bitlab/server-core/handlers'
import { normalizeThinkingLevel, type ThinkingLevel } from '@bitlab/shared/agent/thinking-levels'
import type { PermissionMode } from '@bitlab/shared/agent/mode-types'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature, isImageAttachment } from './runtime-config'
import { McpRuntimeState, formatMcpApprovalCommand, type McpStatusSessionEvent } from './mcp-runtime'
import {
  crossesConnection,
  currentSelection,
  effectiveSelection,
  type SessionModelSelection,
} from './model-selection'
import { rollbackFailedBranchCreation, sanitizeForTitle } from '@bitlab/server-core/domain'
import { applyTranscriptEvent } from './persist-transcript'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let platform: PlatformServices | null = null
let log: Logger = createScopedLogger(CONSOLE_LOGGER, 'session')

export function setSessionPlatform(nextPlatform: PlatformServices): void {
  platform = nextPlatform
  log = createScopedLogger(nextPlatform.logger, 'session')
}

interface SessionRuntimeHooks {
  updateBadgeCount: (count: number) => void
  captureException: (error: unknown, context?: { errorSource?: string; sessionId?: string }) => void
  onSessionStarted: () => void
  onSessionStopped: () => void
}

let runtimeHooks: SessionRuntimeHooks = {
  updateBadgeCount: () => {},
  captureException: () => {},
  onSessionStarted: () => {},
  onSessionStopped: () => {},
}

function createFallbackTitle(content: string): string | undefined {
  const sanitized = sanitizeForTitle(content)
  return sanitized ? sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '') : undefined
}

export function setSessionRuntimeHooks(hooks: Partial<SessionRuntimeHooks>): void {
  runtimeHooks = { ...runtimeHooks, ...hooks }
}

export const AGENT_FLAGS = {
  isHeadless: false,
  skipConfigWatcher: true,
} as const

interface PiTurnAnchorsIndex {
  version: 1
  anchors: Record<string, string>
}

const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  try {
    const parsed = JSON.parse(await readFile(getPiTurnAnchorsPath(sessionPath), 'utf-8')) as Partial<PiTurnAnchorsIndex>
    const anchors: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(parsed.anchors ?? {})) {
      if (messageId && typeof anchor === 'string' && anchor) anchors[messageId] = anchor
    }
    return { version: 1, anchors }
  } catch {
    return { version: 1, anchors: {} }
  }
}

export async function savePiTurnAnchor(
  sessionPath: string,
  messageId: string,
  anchorId: string,
): Promise<void> {
  if (!messageId || !anchorId) return
  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return
  index.anchors[messageId] = anchorId
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(getPiTurnAnchorsPath(sessionPath), JSON.stringify(index), 'utf-8')
}

export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const source = await loadPiTurnAnchors(sourceSessionPath)
  const allowed = new Set(branchedMessageIds)
  const anchors = Object.fromEntries(
    Object.entries(source.anchors).filter(([messageId]) => allowed.has(messageId)),
  )
  if (Object.keys(anchors).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(getPiTurnAnchorsPath(branchSessionPath), JSON.stringify({ version: 1, anchors }), 'utf-8')
}

const EMPTY_USAGE: SessionTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

interface QueuedMessage {
  message: string
  messageId: string
  optimisticMessageId?: string
  attachments?: FileAttachment[]
  storedAttachments?: StoredAttachment[]
  options?: SendMessageOptions
}

type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

interface RunningBackgroundTask {
  taskId: string
  toolUseId?: string
  intent?: string
  startTime: number
  lastProgressAt?: number
  elapsedSeconds?: number
  status: BackgroundTaskStatus
  completedAt?: number
  turnId?: string
  workflowId?: string
  agentsCompleted?: number
}

interface ManagedSession extends SessionConfig {
  workspace: Workspace
  messages: Message[]
  tokenUsage: SessionTokenUsage
  /** Live context-meter reading; runtime-only, never persisted (it goes stale). */
  contextUsage?: ContextUsageReading
  messagesLoaded: boolean
  isProcessing: boolean
  agent: AgentBackend | null
  messageQueue: QueuedMessage[]
  backgroundShellCommands: Map<string, string>
  backgroundTaskRegistry: Map<string, RunningBackgroundTask>
  backendRuntimeSignature?: string
  backendRestartSignature?: string
  runtimeRefreshPromise?: Promise<void>
  /**
   * Selection made in this process — the top tier of `currentSelection()`.
   * Deliberately NOT persisted: after a restart the transcript is the record,
   * so a selection that never reached a dispatched turn does not outlive it.
   */
  pickedSelection?: SessionModelSelection
  /** Selection the running turn captured when it entered assembly. */
  assembledSelection?: SessionModelSelection
  currentStatus?: Session['currentStatus']
  preview?: string
  messageCount?: number
  lastFinalMessageId?: string
  lastMessageRole?: Session['lastMessageRole']
  pendingExternalHeader?: SessionHeader
}

export function createManagedSession(
  session: Partial<StoredSession & SessionMetadata> & Pick<SessionConfig, 'id'>,
  workspace: Workspace,
  options: { messagesLoaded?: boolean } = {},
): ManagedSession {
  const now = Date.now()
  return {
    id: session.id,
    workspaceRootPath: workspace.dataRoot,
    workspace,
    createdAt: session.createdAt ?? now,
    lastUsedAt: session.lastUsedAt ?? now,
    lastMessageAt: session.lastMessageAt,
    name: session.name ?? createFallbackTitle(session.preview ?? ''),
    isFlagged: session.isFlagged,
    hidden: session.hidden,
    lastReadMessageId: session.lastReadMessageId,
    hasUnread: session.hasUnread,
    permissionMode: session.permissionMode,
    previousPermissionMode: session.previousPermissionMode,
    workingDirectory: workspace.folderPath ?? workspace.dataRoot,
    sdkCwd: session.sdkCwd,
    sdkSessionId: session.sdkSessionId,
    model: session.model,
    llmConnection: session.llmConnection,
    thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
    pendingPlanExecution: session.pendingPlanExecution,
    isArchived: session.isArchived,
    archivedAt: session.archivedAt,
    branchFromMessageId: session.branchFromMessageId,
    branchFromSdkSessionId: session.branchFromSdkSessionId,
    branchFromSessionPath: session.branchFromSessionPath,
    branchFromSdkCwd: session.branchFromSdkCwd,
    branchFromSdkTurnId: session.branchFromSdkTurnId,
    parentSessionId: session.parentSessionId,
    preview: session.preview,
    messageCount: session.messageCount ?? session.messages?.length ?? 0,
    lastMessageRole: session.lastMessageRole,
    lastFinalMessageId: session.lastFinalMessageId,
    messages: (session.messages ?? []).map(storedToMessage),
    tokenUsage: session.tokenUsage ?? { ...EMPTY_USAGE },
    messagesLoaded: options.messagesLoaded ?? Boolean(session.messages),
    isProcessing: false,
    agent: null,
    messageQueue: [],
    backgroundShellCommands: new Map(),
    backgroundTaskRegistry: new Map(),
  }
}

export interface SessionCompletionEvent {
  sessionId: string
  stopReason: 'complete' | 'cancelled' | 'error'
}

/**
 * The MCP-capable slice of the Pi agent. Shared's `AgentBackend` interface
 * does not declare the MCP surface yet (the callbacks live on BaseAgent, the
 * methods on PiAgent), so this structural type is the server-core-side view
 * used to wire and invoke it. Everything is optional because non-Pi backends
 * never grow these members.
 */
export type McpCapableAgent = AgentBackend & {
  onMcpStatus?: ((snapshot: McpStatusSnapshotDto) => void) | null
  onMcpApprovalRequest?: ((request: McpApprovalRequestDto) => void) | null
  onMcpNotify?: ((notice: { message: string; level: 'info' | 'warning' | 'error' }) => void) | null
  refreshMcpConfig?: () => void
  resolveMcpApproval?: (requestId: string, decision: McpApprovalDecision) => void
  /** Spawn the subprocess + Pi session without a prompt (auth prerequisite). */
  ensureReady?: () => Promise<string | null>
  /** Browser OAuth sign-in / connect for one MCP server (round-trips the subprocess). */
  requestMcpAuth?: (serverName: string, timeoutMs?: number) => Promise<McpOperationResult>
  /** Clear one MCP server's stored OAuth credentials (adapter `/mcp logout`). */
  requestMcpLogout?: (serverName: string, url: string, timeoutMs?: number) => Promise<McpOperationResult>
}

export interface MidStreamDeliveryOutcome {
  shouldQueue: boolean
  wasInterrupted: boolean
}

export function resolveMidStreamDeliveryOutcome(
  behavior: 'steer' | 'queue',
  redirected: boolean,
): MidStreamDeliveryOutcome {
  return {
    shouldQueue: !redirected,
    wasInterrupted: behavior === 'steer' && !redirected,
  }
}

/**
 * Skill tiers that live outside the workspace directory: the folder bound to
 * the workspace (project tier) and the shared cross-tool directory (global
 * tier). Watching them is what keeps an edit in either tier from leaving the
 * UI and the running session on different revisions.
 */
function skillTierRoots(workspaceId: string): string[] {
  const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
  const roots = [GLOBAL_AGENT_SKILLS_DIR]
  if (workspace?.folderPath) roots.push(join(workspace.folderPath, PROJECT_AGENT_SKILLS_DIR))
  return roots
}

export class SessionManager implements ISessionManager {
  private sessions = new Map<string, ManagedSession>()
  private configWatchers = new Map<string, ConfigWatcher>()
  private eventSink: EventSink = () => {}
  private initPromise: Promise<void> | null = null
  private activeViewingByWorkspace = new Map<string, string>()
  private completionListeners = new Set<(event: SessionCompletionEvent) => void>()
  private browserPaneManager: IBrowserPaneManager | null = null
  private rpcServer: RpcServer | null = null
  private browserHostPins = new Map<string, string>()
  private lastTimestamp = 0
  /** Latest MCP status snapshot per live session + fail-closed approval timers. */
  private mcpRuntime = new McpRuntimeState()
  /** Session Settings runs MCP operations in (see withMcpUtilityAgent). */
  private mcpUtilitySessionId: string | null = null
  /**
   * Watermark of the persisted MCP config as last pushed to live agents.
   * Lets the config-watcher path distinguish external edits (hand-edited
   * config.json) from our own writes, which already refreshed the agents.
   */
  private lastMcpConfigHash: string | null = null

  waitForInit(): Promise<void> {
    return this.initPromise ?? Promise.resolve()
  }

  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise
    this.initPromise = Promise.resolve().then(() => {
      for (const workspace of getWorkspaces()) {
        this.setupConfigWatcher(workspace.dataRoot, workspace.id)
        for (const metadata of listStoredSessions(workspace.dataRoot)) {
          this.sessions.set(metadata.id, createManagedSession(metadata, workspace))
        }
      }
      this.refreshBadge()
    })
    return this.initPromise
  }

  setEventSink(sink: EventSink): void {
    this.eventSink = sink
  }

  setBrowserPaneManager(manager: IBrowserPaneManager): void {
    this.browserPaneManager = manager
  }

  setRpcServer(server: RpcServer): void {
    this.rpcServer = server
  }

  onClientDisconnected(clientId: string): void {
    for (const [sessionId, pinned] of this.browserHostPins) {
      if (pinned === clientId) this.browserHostPins.delete(sessionId)
    }
  }

  private emit(workspaceId: string, event: SessionEvent): void {
    this.eventSink(
      RPC_CHANNELS.sessions.EVENT,
      { to: 'workspace', workspaceId },
      event,
    )
  }

  /** Craft-compatible event helper retained for isolated domain testing. */
  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!workspaceId || !this.eventSink) return
    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  notifySessionCreated(workspaceId: string, sessionId: string): void {
    this.emit(workspaceId, { type: 'session_created', sessionId })
  }

  private ensureMessagesLoaded(managed: ManagedSession): void {
    if (managed.messagesLoaded) return
    const stored = loadStoredSession(managed.workspace.dataRoot, managed.id)
    if (stored) {
      managed.messages = stored.messages.map(storedToMessage)
      managed.tokenUsage = stored.tokenUsage
    }
    managed.messagesLoaded = true
  }

  private toStored(managed: ManagedSession): StoredSession {
    const { workspace: _workspace, agent: _agent, messageQueue: _queue,
      messagesLoaded: _loaded, isProcessing: _processing,
      backgroundShellCommands: _backgroundShellCommands,
      backgroundTaskRegistry: _backgroundTaskRegistry,
      runtimeRefreshPromise: _refresh, backendRuntimeSignature: _runtimeSignature,
      backendRestartSignature: _restartSignature, currentStatus: _status,
      pickedSelection: _picked, assembledSelection: _assembled,
      preview: _preview, messageCount: _messageCount,
      lastFinalMessageId: _lastFinalMessageId, lastMessageRole: _lastMessageRole,
      pendingExternalHeader: _pendingExternalHeader,
      contextUsage: _contextUsage,
      messages, tokenUsage, ...config } = managed
    return { ...config, messages: messages.map(messageToStored), tokenUsage }
  }

  private persistSession(managed: ManagedSession): void {
    this.ensureMessagesLoaded(managed)
    sessionPersistenceQueue.enqueue(this.toStored(managed))
  }

  async flushSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    this.ensureMessagesLoaded(managed)
    sessionPersistenceQueue.enqueue(this.toStored(managed))
    await sessionPersistenceQueue.flush(sessionId)
  }

  async flushAllSessions(): Promise<void> {
    for (const managed of this.sessions.values()) this.persistSession(managed)
    await sessionPersistenceQueue.flushAll()
  }

  getSessions(workspaceId?: string): Session[] {
    return [...this.sessions.values()]
      .filter(managed => !workspaceId || managed.workspace.id === workspaceId)
      .map(managed => this.toSession(managed, false))
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    this.ensureMessagesLoaded(managed)
    return this.toSession(managed, true)
  }

  private toSession(managed: ManagedSession, includeMessages: boolean): Session {
    const messages = includeMessages ? managed.messages : []
    return {
      id: managed.id,
      workspaceId: managed.workspace.id,
      workspaceName: managed.workspace.name,
      name: managed.name,
      preview: managed.preview,
      lastMessageAt: managed.lastMessageAt
        ?? ((managed.messageCount ?? 0) > 0 ? managed.createdAt : managed.lastUsedAt),
      messages,
      isProcessing: managed.isProcessing,
      isFlagged: managed.isFlagged,
      permissionMode: managed.permissionMode,
      lastReadMessageId: managed.lastReadMessageId,
      hasUnread: managed.hasUnread,
      workingDirectory: managed.workingDirectory,
      sessionFolderPath: getSessionStoragePath(managed.workspace.dataRoot, managed.id),
      model: managed.model,
      llmConnection: managed.llmConnection,
      thinkingLevel: managed.thinkingLevel,
      lastMessageRole: managed.lastMessageRole,
      lastFinalMessageId: managed.lastFinalMessageId,
      currentStatus: managed.currentStatus,
      createdAt: managed.createdAt,
      messageCount: managed.messageCount ?? managed.messages.length,
      tokenUsage: managed.tokenUsage,
      contextUsage: managed.contextUsage,
      hidden: managed.hidden,
      isArchived: managed.isArchived,
      archivedAt: managed.archivedAt,
      supportsBranching: managed.agent?.supportsBranching ?? true,
      parentSessionId: managed.parentSessionId,
    }
  }

  async createSession(
    workspaceId: string,
    options: CreateSessionOptions = {},
    internal: { emitCreatedEvent?: boolean } = {},
  ): Promise<Session> {
    const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const workspaceConfig = loadWorkspaceConfig(workspace.dataRoot)

    let branchSource: StoredSession | undefined
    let branchIndex = -1
    let branchFromSdkTurnId: string | undefined
    if (options.branchFromSessionId || options.branchFromMessageId) {
      if (!options.branchFromSessionId || !options.branchFromMessageId) {
        throw new Error('Invalid branch request: both branchFromSessionId and branchFromMessageId are required')
      }

      const sourceManaged = this.sessions.get(options.branchFromSessionId)
      if (sourceManaged && sourceManaged.workspace.dataRoot !== workspace.dataRoot) {
        throw new Error('Invalid branch request: source session belongs to a different workspace')
      }
      if (sourceManaged) {
        this.ensureMessagesLoaded(sourceManaged)
        await this.flushSession(sourceManaged.id)
      }

      branchSource = loadStoredSession(workspace.dataRoot, options.branchFromSessionId) ?? undefined
      if (!branchSource) {
        throw new Error(`Invalid branch request: source session ${options.branchFromSessionId} not found`)
      }
      branchIndex = branchSource.messages.findIndex(message => message.id === options.branchFromMessageId)
      if (branchIndex < 0) {
        throw new Error(`Invalid branch request: message ${options.branchFromMessageId} not found in source session`)
      }
      if (!branchSource.sdkSessionId) {
        throw new Error('Cannot create branch yet: parent session SDK context is not initialized. Send one message in the parent session and try again.')
      }

      const sourcePath = getSessionStoragePath(workspace.dataRoot, options.branchFromSessionId)
      branchFromSdkTurnId = (await loadPiTurnAnchors(sourcePath)).anchors[options.branchFromMessageId]
    }

    const stored = await createStoredSession(workspace.dataRoot, {
      name: options.name,
      permissionMode: options.permissionMode ?? workspaceConfig?.defaults?.permissionMode,
      workingDirectory: workspace.folderPath ?? workspace.dataRoot,
      model: options.model ?? workspaceConfig?.defaults?.model,
      llmConnection: options.llmConnection ?? workspaceConfig?.defaults?.defaultLlmConnection,
      hidden: options.hidden,
      isFlagged: options.isFlagged,
      parentSessionId: options.parentSessionId,
    })

    if (branchSource && options.branchFromSessionId && options.branchFromMessageId) {
      const branchPath = getSessionStoragePath(workspace.dataRoot, stored.id)
      const sourcePath = getSessionStoragePath(workspace.dataRoot, options.branchFromSessionId)
      const branched = loadStoredSession(workspace.dataRoot, stored.id)
      if (!branched) throw new Error(`Failed to load newly created session ${stored.id} for branch copy`)

      const sourceMessages = branchSource.messages.slice(0, branchIndex + 1)
      branched.messages = sourcePath === branchPath
        ? sourceMessages
        : sourceMessages.map(message => {
            const serialized = JSON.stringify(message)
            return serialized.includes(sourcePath)
              ? JSON.parse(serialized.replaceAll(sourcePath, branchPath)) as StoredSession['messages'][number]
              : message
          })
      branched.branchFromMessageId = options.branchFromMessageId
      branched.branchFromSdkSessionId = branchSource.sdkSessionId
      branched.branchFromSessionPath = sourcePath
      branched.branchFromSdkCwd = branchSource.sdkCwd
      branched.branchFromSdkTurnId = branchFromSdkTurnId
      await saveStoredSession(branched)
      await copyPiTurnAnchorsForBranch(sourcePath, branchPath, branched.messages.map(message => message.id))
      Object.assign(stored, branched)
    }

    const managed = createManagedSession(stored, workspace, { messagesLoaded: true })
    managed.thinkingLevel = normalizeThinkingLevel(options.thinkingLevel ?? workspaceConfig?.defaults?.thinkingLevel)
    if (branchSource) {
      try {
        const agent = await this.getOrCreateAgent(managed)
        await agent.ensureBranchReady()
      } catch (error) {
        await rollbackFailedBranchCreation({
          managed,
          workspaceRootPath: workspace.dataRoot,
          sessionId: stored.id,
          deleteFromRuntimeSessions: id => this.sessions.delete(id),
          deleteStoredSession,
        })
        throw new Error(`Could not create branch: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    this.sessions.set(managed.id, managed)
    await this.flushSession(managed.id)
    if (internal.emitCreatedEvent !== false) this.notifySessionCreated(workspace.id, managed.id)
    return this.toSession(managed, true)
  }

  getSessionWorkingDirectory(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.workingDirectory
  }

  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    return managed ? getSessionStoragePath(managed.workspace.dataRoot, managed.id) : null
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    await this.cancelProcessing(sessionId, true)
    managed.agent?.destroy()
    unregisterSessionScopedToolCallbacks(sessionId)
    // Drop cached MCP status + any pending approval auto-deny timers.
    this.mcpRuntime.clearSession(sessionId)
    sessionPersistenceQueue.cancel(sessionId)
    deleteStoredSession(managed.workspace.dataRoot, sessionId)
    this.sessions.delete(sessionId)
    this.emit(managed.workspace.id, { type: 'session_deleted', sessionId })
    this.refreshBadge()
  }

  private async updateMetadata(
    sessionId: string,
    updates: Partial<ManagedSession>,
    event?: SessionEvent,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    Object.assign(managed, updates)
    await this.flushSession(sessionId)
    if (event) this.emit(managed.workspace.id, event)
  }

  flagSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isFlagged: true }, { type: 'session_flagged', sessionId })
  }

  unflagSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isFlagged: false }, { type: 'session_unflagged', sessionId })
  }

  archiveSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isArchived: true, archivedAt: Date.now() }, { type: 'session_archived', sessionId })
  }

  unarchiveSession(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { isArchived: false, archivedAt: undefined }, { type: 'session_unarchived', sessionId })
  }

  renameSession(sessionId: string, name: string): Promise<void> {
    return this.updateMetadata(sessionId, { name: name.trim() || undefined }, { type: 'name_changed', sessionId, name: name.trim() || undefined })
  }

  async sendMessage(
    sessionId: string,
    message: string,
    attachments?: FileAttachment[],
    storedAttachments?: StoredAttachment[],
    options?: SendMessageOptions,
    existingMessageId?: string,
    _isRetry?: boolean,
    onAck?: (messageId: string) => void,
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session not found: ${sessionId}`)
    this.ensureMessagesLoaded(managed)
    let shouldGenerateTitle = false
    const now = this.nextTimestamp()
    let userMessage: Message
    if (existingMessageId) {
      const existing = managed.messages.find(item => item.id === existingMessageId)
      if (!existing) throw new Error(`Existing message ${existingMessageId} not found`)
      userMessage = existing
    } else {
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: now,
        attachments: storedAttachments,
        badges: options?.badges,
        ...(options?.hidden ? { hidden: true } : {}),
      }
      managed.messages.push(userMessage)
      if (!options?.hidden) managed.lastMessageRole = 'user'
    }
    managed.lastMessageAt = now
    managed.lastUsedAt = now

    if (managed.isProcessing) {
      const redirected = managed.agent?.redirect(message) ?? false
      if (!redirected) {
        userMessage.isQueued = true
        managed.messageQueue.push({
          message,
          messageId: userMessage.id,
          optimisticMessageId: options?.optimisticMessageId,
          attachments,
          storedAttachments,
          options,
        })
      }
      await this.flushSession(sessionId)
      onAck?.(userMessage.id)
      this.emit(managed.workspace.id, {
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: redirected ? 'processing' : 'queued',
        optimisticMessageId: options?.optimisticMessageId,
      })
      return
    }

    await this.flushSession(sessionId)
    if (!existingMessageId) {
      onAck?.(userMessage.id)
      this.emit(managed.workspace.id, {
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: options?.optimisticMessageId,
      })

      const isFirstUserMessage = managed.messages.filter(item => item.role === 'user').length === 1
      if (isFirstUserMessage && !managed.name && !options?.hidden) {
        let titleSource = message
        for (const badge of options?.badges ?? []) {
          if (badge.rawText && badge.label) titleSource = titleSource.replace(badge.rawText, badge.label)
        }
        const initialTitle = createFallbackTitle(titleSource)
        if (initialTitle) {
          managed.name = initialTitle
          await this.flushSession(managed.id)
          this.emit(managed.workspace.id, { type: 'title_generated', sessionId, title: initialTitle })
          shouldGenerateTitle = true
        }
      }
    }
    await this.runTurn(managed, message, attachments, userMessage)
    if (shouldGenerateTitle) void this.generateTitle(managed, message)
  }

  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    try {
      const agent = await this.getOrCreateAgent(managed)
      const title = await agent.generateTitle(userMessage, { language: resolveTitleLanguageName() })
      if (!title) return
      managed.name = title
      await this.flushSession(managed.id)
      this.emit(managed.workspace.id, { type: 'title_generated', sessionId: managed.id, title })
    } catch { return }
  }

  /**
   * The session's selection for its next assembled turn.
   *
   * @param managed - the session.
   * @returns the selection resolved through the three tiers.
   */
  private selectionOf(managed: ManagedSession): SessionModelSelection {
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    return currentSelection(managed, workspaceConfig?.defaults?.defaultLlmConnection)
  }

  /**
   * The selection a backend must be resolved under right now: the running
   * turn's snapshot, or the current selection when no turn is running.
   *
   * @param managed - the session.
   * @returns the selection to build a backend context from.
   */
  private routeOf(managed: ManagedSession): SessionModelSelection {
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    return effectiveSelection(
      managed,
      managed.assembledSelection,
      workspaceConfig?.defaults?.defaultLlmConnection,
    )
  }

  private async runTurn(
    managed: ManagedSession,
    message: string,
    attachments?: FileAttachment[],
    userMessage?: Message,
  ): Promise<void> {
    // The assembly boundary: this turn commits to the selection that is current
    // NOW, and every later read of the route during the turn sees this snapshot.
    // A switch that lands mid-turn therefore takes effect on the next turn
    // rather than splitting this one — the reason no lock is needed.
    const assembled = this.selectionOf(managed)
    managed.assembledSelection = assembled
    if (userMessage) {
      userMessage.modelSelection = {
        connection: assembled.connection,
        model: assembled.model,
        thinkingLevel: assembled.thinkingLevel,
      }
    }
    managed.isProcessing = true
    runtimeHooks.onSessionStarted()
    let stopReason: SessionCompletionEvent['stopReason'] = 'complete'
    try {
      const agent = await this.getOrCreateAgent(managed)
      for await (const event of agent.chat(message, attachments)) {
        if (this.handleAgentEvent(managed, event)) stopReason = 'error'
      }
    } catch (error) {
      stopReason = 'error'
      const errorMessage = error instanceof Error ? error.message : String(error)
      const storedError: Message = {
        id: generateMessageId(),
        role: 'error',
        content: errorMessage,
        timestamp: this.nextTimestamp(),
      }
      managed.messages.push(storedError)
      this.emit(managed.workspace.id, { type: 'error', sessionId: managed.id, error: errorMessage })
      runtimeHooks.captureException(error, { errorSource: 'session-turn', sessionId: managed.id })
    } finally {
      managed.isProcessing = false
      managed.currentStatus = undefined
      // Release the snapshot: the turn is over, so the next read of the route
      // resolves through the tiers again and picks up any switch made meanwhile.
      managed.assembledSelection = undefined
      if (managed.pendingExternalHeader) {
        this.applyExternalSessionMetadata(managed, managed.pendingExternalHeader)
        managed.pendingExternalHeader = undefined
      }
      await this.flushSession(managed.id)
      runtimeHooks.onSessionStopped()
      for (const listener of this.completionListeners) listener({ sessionId: managed.id, stopReason })
      if (managed.messageQueue.length) this.processNextQueuedMessage(managed.id)
    }
  }

  private handleAgentEvent(managed: ManagedSession, event: AgentEvent): boolean {
    const sessionId = managed.id
    let isTurnError = false
    switch (event.type) {
      case 'text_complete': {
        const timestamp = this.nextTimestamp()
        const messageId = event.sdkMessageId ?? generateMessageId()
        managed.messages = applyTranscriptEvent(managed.messages, event, { id: messageId, timestamp })
        if (!event.isIntermediate) {
          managed.lastFinalMessageId = messageId
          managed.lastMessageRole = 'assistant'
          managed.hasUnread = this.activeViewingByWorkspace.get(managed.workspace.id) !== sessionId
        }
        this.emit(managed.workspace.id, {
          type: 'text_complete',
          sessionId,
          text: event.text,
          isIntermediate: event.isIntermediate,
          messageId,
          timestamp,
          turnId: event.turnId,
          parentToolUseId: event.parentToolUseId,
        })
        break
      }
      case 'text_delta':
        this.emit(managed.workspace.id, { type: 'text_delta', sessionId, delta: event.text, turnId: event.turnId })
        break
      case 'thinking_delta':
        this.emit(managed.workspace.id, { type: 'thinking_delta', sessionId, delta: event.text, turnId: event.turnId })
        break
      case 'thinking_complete': {
        const timestamp = this.nextTimestamp()
        const messageId = generateMessageId()
        managed.messages = applyTranscriptEvent(managed.messages, event, { id: messageId, timestamp })
        this.emit(managed.workspace.id, {
          type: 'thinking_complete',
          sessionId,
          text: event.text,
          messageId,
          timestamp,
          turnId: event.turnId,
        })
        break
      }
      case 'tool_start': {
        const timestamp = this.nextTimestamp()
        managed.messages = applyTranscriptEvent(managed.messages, event, { id: generateMessageId(), timestamp })
        this.emit(managed.workspace.id, { type: 'tool_start', sessionId, toolName: event.toolName, toolUseId: event.toolUseId, toolInput: event.input, toolIntent: event.intent, toolDisplayName: event.displayName, toolDisplayMeta: event.toolDisplayMeta, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp })
        break
      }
      case 'tool_result': {
        const timestamp = this.nextTimestamp()
        managed.messages = applyTranscriptEvent(managed.messages, event, { id: generateMessageId(), timestamp })
        this.emit(managed.workspace.id, { type: 'tool_result', sessionId, toolUseId: event.toolUseId, toolName: event.toolName ?? 'tool', result: event.result, isError: event.isError, turnId: event.turnId, parentToolUseId: event.parentToolUseId, timestamp })
        break
      }
      case 'status':
        managed.currentStatus = { message: event.message }
        this.emit(managed.workspace.id, { type: 'status', sessionId, message: event.message })
        break
      case 'info':
        this.emit(managed.workspace.id, { type: 'info', sessionId, message: event.message })
        break
      case 'error': {
        if (!managed.isProcessing || event.message.includes('aborted') || event.message.includes('AbortError')) break
        const message: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.nextTimestamp(),
        }
        managed.messages.push(message)
        this.emit(managed.workspace.id, {
          type: 'error',
          sessionId,
          error: event.message,
          timestamp: message.timestamp,
        })
        isTurnError = true
        break
      }
      case 'typed_error': {
        const errorText = event.error.message || event.error.title || ''
        if (!managed.isProcessing || errorText.includes('aborted') || errorText.includes('AbortError')) break
        const message: Message = {
          id: generateMessageId(),
          role: 'error',
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.nextTimestamp(),
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(message)
        this.emit(managed.workspace.id, {
          type: 'typed_error',
          sessionId,
          error: event.error,
          timestamp: message.timestamp,
        })
        isTurnError = true
        break
      }
      case 'complete':
        if (event.usage) {
          managed.tokenUsage = { ...managed.tokenUsage, ...event.usage }
        }
        this.emit(managed.workspace.id, { type: 'complete', sessionId, tokenUsage: managed.tokenUsage, hasUnread: managed.hasUnread })
        break
      case 'usage_update':
        managed.tokenUsage.inputTokens = event.usage.inputTokens
        if (event.usage.contextWindow) managed.tokenUsage.contextWindow = event.usage.contextWindow
        this.emit(managed.workspace.id, { type: 'usage_update', sessionId, tokenUsage: event.usage })
        break
      case 'context_usage':
        managed.contextUsage = event.contextUsage
        this.emit(managed.workspace.id, { type: 'context_usage', sessionId, contextUsage: event.contextUsage })
        break
      case 'task_backgrounded':
        managed.backgroundTaskRegistry.set(event.taskId, {
          taskId: event.taskId,
          toolUseId: event.toolUseId,
          intent: event.intent,
          startTime: Date.now(),
          status: 'running',
          turnId: event.turnId,
          ...(event.workflowId ? { workflowId: event.workflowId } : {}),
          ...(event.kind === 'workflow' ? { agentsCompleted: 0 } : {}),
        })
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'shell_backgrounded':
        if (event.command) managed.backgroundShellCommands.set(event.shellId, event.command)
        this.emit(managed.workspace.id, { type: 'shell_backgrounded', sessionId, toolUseId: event.toolUseId, shellId: event.shellId, intent: event.intent, command: event.command, turnId: event.turnId })
        break
      case 'task_progress':
        for (const task of managed.backgroundTaskRegistry.values()) {
          if (task.toolUseId === event.toolUseId) {
            task.elapsedSeconds = event.elapsedSeconds
            task.lastProgressAt = Date.now()
            break
          }
        }
        this.emit(managed.workspace.id, { type: 'task_progress', sessionId, toolUseId: event.toolUseId, elapsedSeconds: event.elapsedSeconds, turnId: event.turnId })
        break
      case 'task_completed': {
        const task = managed.backgroundTaskRegistry.get(event.taskId)
          ?? [...managed.backgroundTaskRegistry.values()].find(item => item.workflowId === event.taskId)
        const wasAlreadyTerminal = task ? task.status !== 'running' : false
        if (task) {
          task.status = event.status
          task.completedAt = Date.now()
        } else {
          managed.backgroundTaskRegistry.set(event.taskId, {
            taskId: event.taskId,
            startTime: Date.now(),
            status: event.status,
            completedAt: Date.now(),
          })
        }
        this.emit(managed.workspace.id, { type: 'task_completed', sessionId, taskId: event.taskId, status: event.status, outputFile: event.outputFile, summary: event.summary, turnId: event.turnId })
        if (!managed.isProcessing && !wasAlreadyTerminal) {
          const label = task?.intent ? `"${task.intent}"` : `task ${event.taskId}`
          const nudge = event.status === 'completed'
            ? [
                `[background-task-completed] The background agent you launched (${label}) has finished.`,
                event.outputFile ? `Its full output is saved at: ${event.outputFile}` : '',
                'Read that output file and present the results to the user now. Do NOT spawn another background agent — just read the file and summarize the findings inline.',
              ].filter(Boolean).join('\n')
            : `[background-task-${event.status}] The background agent you launched (${label}) did not complete successfully. Do NOT spawn another background agent.`
          void this.sendMessage(sessionId, nudge, undefined, undefined, { hidden: true })
            .catch(error => log.error('Failed to surface background task result', event.taskId, error))
        }
        break
      }
      case 'shell_killed':
        this.emit(managed.workspace.id, { type: 'shell_killed', sessionId, shellId: event.shellId })
        break
      case 'permission_request':
        this.emit(managed.workspace.id, { type: 'permission_request', sessionId, request: { sessionId, requestId: event.requestId, toolName: event.toolName, command: event.command, description: event.description, type: event.permissionType, appName: event.appName, reason: event.reason, impact: event.impact, requiresSystemPrompt: event.requiresSystemPrompt, rememberForMinutes: event.rememberForMinutes, commandHash: event.commandHash, approvalTtlSeconds: event.approvalTtlSeconds } })
        break
      case 'pi_turn_anchor':
        void savePiTurnAnchor(
          getSessionStoragePath(managed.workspace.dataRoot, sessionId),
          event.sdkMessageId,
          event.sdkTurnAnchor,
        ).catch(error => log.warn('Failed to persist Pi turn anchor', sessionId, error))
        break
      case 'workflow_agent_completed':
        for (const task of managed.backgroundTaskRegistry.values()) {
          if (task.workflowId === event.workflowId) {
            task.agentsCompleted = (task.agentsCompleted ?? 0) + 1
            break
          }
        }
        this.emit(managed.workspace.id, { ...event, sessionId })
        break
      case 'steer_undelivered':
        break
    }
    this.persistSession(managed)
    return isTurnError
  }

  /** Craft-compatible async entry point for events arriving outside a live turn. */
  private async processEvent(managed: ManagedSession, event: AgentEvent): Promise<void> {
    this.handleAgentEvent(managed, event)
    await this.flushSession(managed.id)
  }

  /** Craft browser-tool bridge, scoped to the current local session. */
  private createBrowserPaneFns(managed: ManagedSession): BrowserPaneFns | undefined {
    const browser = this.browserPaneManager
    if (!browser) return undefined
    const workspaceId = managed.workspace.id
    const getInstanceId = () => browser.getOrCreateForSessionAsync(managed.id, { workspaceId })
    const lifecycleTarget = async (requested?: string) => requested ?? await getInstanceId()

    return {
      openPanel: async options => ({
        instanceId: options?.background
          ? await browser.createForSessionAsync(managed.id, { show: false, workspaceId })
          : await browser.focusBoundForSessionAsync(managed.id, { workspaceId }),
      }),
      navigate: async url => browser.navigate(await getInstanceId(), url),
      snapshot: async () => browser.getAccessibilitySnapshot(await getInstanceId()),
      click: async (ref, options) => browser.clickElement(await getInstanceId(), ref, options),
      clickAt: async (x, y) => browser.clickAtCoordinates(await getInstanceId(), x, y),
      drag: async (x1, y1, x2, y2) => browser.drag(await getInstanceId(), x1, y1, x2, y2),
      fill: async (ref, value) => browser.fillElement(await getInstanceId(), ref, value),
      type: async text => browser.typeText(await getInstanceId(), text),
      select: async (ref, value) => browser.selectOption(await getInstanceId(), ref, value),
      setClipboard: async text => browser.setClipboard(await getInstanceId(), text),
      getClipboard: async () => browser.getClipboard(await getInstanceId()),
      screenshot: async args => browser.screenshot(await getInstanceId(), args),
      screenshotRegion: async args => browser.screenshotRegion(await getInstanceId(), args),
      getConsoleLogs: async args => browser.getConsoleLogs(await getInstanceId(), args),
      windowResize: async args => browser.windowResize(await getInstanceId(), args.width, args.height),
      getNetworkLogs: async args => browser.getNetworkLogs(await getInstanceId(), args),
      waitFor: async args => browser.waitFor(await getInstanceId(), args),
      sendKey: async args => browser.sendKey(await getInstanceId(), args),
      getDownloads: async args => browser.getDownloads(await getInstanceId(), args),
      upload: async (ref, paths) => { await browser.uploadFile(await getInstanceId(), ref, paths) },
      scroll: async (direction, amount) => browser.scroll(await getInstanceId(), direction, amount),
      goBack: async () => browser.goBack(await getInstanceId()),
      goForward: async () => browser.goForward(await getInstanceId()),
      evaluate: async expression => browser.evaluate(await getInstanceId(), expression),
      focusWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.focus(instanceId)
        const info = await browser.getInstanceAsync(instanceId)
        return { instanceId, title: info?.title ?? '', url: info?.currentUrl ?? '' }
      },
      releaseControl: async requested => {
        const instanceId = await lifecycleTarget(requested)
        const result = browser.clearAgentControlForInstance(instanceId, managed.id)
        return {
          action: result.released ? 'released' : 'noop',
          requestedInstanceId: requested,
          resolvedInstanceId: instanceId,
          affectedIds: result.released ? [instanceId] : [],
          reason: result.reason,
        }
      },
      closeWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.destroyInstance(instanceId)
        return { action: 'closed', requestedInstanceId: requested, resolvedInstanceId: instanceId, affectedIds: [instanceId] }
      },
      hideWindow: async requested => {
        const instanceId = await lifecycleTarget(requested)
        browser.hide(instanceId)
        return { action: 'hidden', requestedInstanceId: requested, resolvedInstanceId: instanceId, affectedIds: [instanceId] }
      },
      listWindows: async () => browser.listInstancesAsync(),
      detectChallenge: async () => browser.detectSecurityChallenge(await getInstanceId()),
    }
  }

  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentBackend> {
    if (managed.agent) {
      await this.refreshManagedRuntime(managed)
      if (managed.agent) return managed.agent
    }
    if (!platform) throw new Error('Session platform has not been initialized')
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    const route = this.routeOf(managed)
    const context = resolveBackendContext({
      sessionConnectionSlug: route.connection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: route.model,
    })
    const agent = createBackendFromResolvedContext({
      context,
      hostRuntime: {
        appRootPath: platform.appRootPath,
        resourcesPath: platform.resourcesPath,
        isPackaged: platform.isPackaged,
      },
      coreConfig: {
        workspace: managed.workspace,
        session: this.toStored(managed),
        model: context.resolvedModel,
        miniModel: context.connection ? getMiniModel(context.connection) : undefined,
        thinkingLevel: managed.thinkingLevel,
        isHeadless: !this.browserPaneManager,
        skipConfigWatcher: true,
        onSdkSessionIdUpdate: sdkSessionId => {
          managed.sdkSessionId = sdkSessionId
          this.persistSession(managed)
        },
        getRecoveryMessages: () => managed.messages.slice(-12).map(item => ({ type: item.role === 'assistant' ? 'assistant' : 'user', content: item.content })),
      },
    })
    // Seed the permission-mode registry from the session's own config.
    //
    // The registry that pre-tool-use checks consult is process-global and
    // starts empty, defaulting to 'ask'. The session's mode, meanwhile, is
    // restored from its config file. Without this line the two disagree on
    // every fresh agent: the UI reads the config and shows full access while
    // tools keep prompting, and the only way out is toggling the mode by hand
    // to force the write below in setSessionPermissionMode.
    agent.setPermissionMode(managed.permissionMode ?? 'ask')

    agent.onPermissionRequest = request => {
      this.handleAgentEvent(managed, { ...request, type: 'permission_request', permissionType: request.type })
    }
    // MCP status/approvals surface (pi backend only; other backends keep the
    // optional members unset). Wired through the structural cast because
    // AgentBackend does not declare this surface yet — see McpCapableAgent.
    const mcpAgent = agent as McpCapableAgent
    mcpAgent.onMcpStatus = snapshot => this.handleMcpStatus(managed, snapshot)
    mcpAgent.onMcpApprovalRequest = request => this.handleMcpApprovalRequest(managed, request)
    mcpAgent.onMcpNotify = notice => {
      appLogger.info(`[MCP] ${notice.level}: ${notice.message.slice(0, 300)}`)
      this.eventSink(RPC_CHANNELS.mcp.NOTIFY, { to: 'all' }, {
        sessionId: managed.id,
        ...notice,
      })
    }
    // Pipe backend debug lines (including the pi subprocess's MCP stderr
    // banner: "MCP enabled: N server(s)", reload traces) into the app log so
    // MCP lifecycle issues are diagnosable from the Electron console.
    const appLogger = platform.logger
    agent.onDebug = message => appLogger.debug(`[session:${managed.id.slice(0, 8)}] ${message}`)
    agent.onPlanSubmitted = planPath => {
      const message: Message = { id: generateMessageId(), role: 'plan', content: planPath, timestamp: this.nextTimestamp() }
      managed.messages.push(message)
      this.emit(managed.workspace.id, { type: 'plan_submitted', sessionId: managed.id, message })
    }
    agent.onPermissionModeChange = mode => {
      managed.previousPermissionMode = managed.permissionMode
      managed.permissionMode = mode
      this.emit(managed.workspace.id, { type: 'permission_mode_changed', sessionId: managed.id, permissionMode: mode, previousPermissionMode: managed.previousPermissionMode, changedBy: 'system', changedAt: new Date().toISOString() })
    }
    // Craft's session self-management wiring, reduced to the Lite session surface.
    agent.onSpawnSession = async request => {
      const session = await this.createSession(managed.workspace.id, {
        name: request.name,
        llmConnection: request.llmConnection ?? managed.llmConnection,
        model: request.model ?? managed.model,
        permissionMode: request.permissionMode ?? managed.permissionMode,
        thinkingLevel: request.thinkingLevel ?? managed.thinkingLevel,
        parentSessionId: managed.id,
      })
      let fileAttachments: FileAttachment[] | undefined
      if (request.attachments?.length) {
        const attachments: FileAttachment[] = []
        for (const item of request.attachments) {
          try {
            const allowedDirs = getWorkspaceAllowedDirs(managed.workspace.id)
            const attachment = readFileAttachment(await validateFilePath(item.path, allowedDirs))
            if (attachment) {
              if (item.name) attachment.name = item.name
              attachments.push(attachment)
            }
          } catch (error) {
            log.warn('Spawn session attachment rejected', item.path, error)
          }
        }
        if (attachments.length) fileAttachments = attachments
      }
      void this.sendMessage(session.id, request.prompt, fileAttachments)
        .catch(error => log.error('Failed to start spawned session', session.id, error))
      return {
        sessionId: session.id,
        name: session.name ?? request.name ?? session.id,
        status: 'started',
        connection: session.llmConnection,
        model: session.model,
      }
    }
    const browserPaneFns = this.createBrowserPaneFns(managed)
    mergeSessionScopedToolCallbacks(managed.id, {
      ...(browserPaneFns ? { browserPaneFns } : {}),
      getSessionInfoFn: (sessionId = managed.id) => {
        const session = this.sessions.get(sessionId)
        if (!session) return null
        return {
          id: session.id,
          name: session.name ?? session.id,
          permissionMode: session.permissionMode ?? 'ask',
          createdAt: session.createdAt,
          updatedAt: session.lastUsedAt,
          workingDirectory: session.workingDirectory,
          llmConnection: session.llmConnection,
          model: session.model,
          isActive: session.agent != null,
          isArchived: session.isArchived,
          isFlagged: session.isFlagged,
          hasUnread: session.hasUnread,
        }
      },
      listSessionsFn: options => {
        const limit = Math.min(options?.limit ?? 20, 100)
        const offset = options?.offset ?? 0
        let sessions = this.getSessions(managed.workspace.id)
        if (options?.archived !== undefined) {
          sessions = sessions.filter(item => Boolean(item.isArchived) === options.archived)
        }
        if (options?.search) {
          const query = options.search.toLowerCase()
          sessions = sessions.filter(item => item.name?.toLowerCase().includes(query))
        }
        sessions.sort(options?.sortBy === 'name'
          ? (a, b) => (a.name ?? '').localeCompare(b.name ?? '')
          : (a, b) => b.lastMessageAt - a.lastMessageAt)
        const page = sessions.slice(offset, offset + limit)
        return {
          total: sessions.length,
          returned: page.length,
          sessions: page.map(item => ({
            id: item.id,
            name: item.name ?? item.id,
            createdAt: item.createdAt ?? 0,
            lastUsedAt: item.lastMessageAt,
            isArchived: item.isArchived,
            isFlagged: item.isFlagged,
            hasUnread: item.hasUnread,
            isProcessing: item.isProcessing,
          })),
        }
      },
      listBackgroundTasksFn: (sessionId = managed.id) => this.listBackgroundTasks(sessionId),
      sendAgentMessageFn: async (sessionId, message, attachments) => {
        let fileAttachments: FileAttachment[] | undefined
        if (attachments?.length) {
          const resolved: FileAttachment[] = []
          for (const item of attachments) {
            const attachment = readFileAttachment(
              await validateFilePath(item.path, getWorkspaceAllowedDirs(managed.workspace.id)),
            )
            if (attachment) {
              if (item.name) attachment.name = item.name
              resolved.push(attachment)
            }
          }
          if (resolved.length) fileAttachments = resolved
        }
        const targetBusy = this.sessions.get(sessionId)?.isProcessing === true
        await this.sendMessage(sessionId, message, fileAttachments)
        return { delivery: targetBusy ? 'queued' : 'delivered', targetBusy }
      },
    })
    agent.setBackgroundEventSink?.(event => { void this.processEvent(managed, event) })
    const result = await agent.postInit()
    if (result.authWarning) log.warn(result.authWarning)
    managed.agent = agent
    managed.backendRuntimeSignature = buildBackendRuntimeSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel })
    managed.backendRestartSignature = buildRestartRequiredSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel })
    return agent
  }

  /** Push changed web_search settings to every live agent. */
  async refreshSearchConfig(): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .map(managed => managed.agent?.refreshSearchConfig?.())
      .filter(Boolean))
  }

  /**
   * Push the persisted MCP config to every live agent subprocess (hot update).
   * Also refreshes the external-change watermark so the config-watcher path
   * does not re-broadcast changes that originated from our own handlers.
   */
  refreshMcpConfig(): void {
    const servers = getMcpServers().filter(server => server.enabled)
    const summary = servers.map(s => `${s.name}(${s.trusted ? 'trusted' : 'approval'})`).join(', ') || 'none'
    const hash = this.mcpConfigHash()
    this.lastMcpConfigHash = hash
    let pushed = 0
    for (const managed of this.sessions.values()) {
      if (!managed.agent) continue
      ;(managed.agent as McpCapableAgent).refreshMcpConfig?.()
      pushed++
    }
    platform?.logger.info(`[MCP] config pushed to ${pushed} live session(s); enabled servers: ${summary}`)
  }

  /** Latest MCP status snapshots across live sessions (for `mcp:list`). */
  getMcpStatusSnapshots(): McpSessionStatusDto[] {
    return this.mcpRuntime.getStatusSnapshots()
  }

  /** What each MCP server was last seen doing, outliving its session. */
  getLastKnownMcpStatuses(): McpServerStatusDto[] {
    return this.mcpRuntime.getLastKnownStatuses()
  }

  /** Forget a remembered MCP status (server reconfigured or removed). */
  forgetMcpStatus(serverName: string): void {
    this.mcpRuntime.forgetLastKnown(serverName)
  }

  /**
   * Run one MCP operation in a session dedicated to Settings.
   *
   * Never a chat session: those may be mid-turn, and driving a connect or a
   * sign-out through one interferes with work the user can see. The session is
   * created silently (no create event, nothing in the session list) and
   * deleted as soon as the operation settles, so a crash cannot strand it.
   */
  private async withMcpUtilityAgent<T>(
    run: (agent: McpCapableAgent) => Promise<T>,
    onUnavailable: (message: string) => T,
  ): Promise<T> {
    const workspace = getActiveWorkspace() ?? this.getWorkspaces()[0]
    if (!workspace) return onUnavailable('No workspace available to run MCP operations')
    const managed = this.toManaged(await this.createSession(workspace.id, {}, { emitCreatedEvent: false }))
    this.mcpUtilitySessionId = managed.id
    try {
      const agent = await this.getOrCreateAgent(managed) as McpCapableAgent
      if (typeof agent.requestMcpAuth !== 'function') {
        return onUnavailable('This session backend does not support MCP operations')
      }
      await agent.ensureReady?.()
      return await run(agent)
    } finally {
      await this.disposeMcpUtilitySession(managed.id)
    }
  }

  /**
   * Drop the utility session. `expectedId` guards the teardown that follows an
   * operation: a cancel may already have disposed it and started nothing else.
   */
  private async disposeMcpUtilitySession(expectedId?: string): Promise<void> {
    const sessionId = this.mcpUtilitySessionId
    if (!sessionId || (expectedId && sessionId !== expectedId)) return
    this.mcpUtilitySessionId = null
    await this.deleteSession(sessionId).catch(() => {})
  }

  /**
   * Browser OAuth sign-in for one MCP server. Tokens land in the shared
   * credential store, so every session picks them up on its next connect.
   */
  async authenticateMcpServer(serverId: string): Promise<McpOperationResult> {
    const server = getMcpServers().find(item => item.id === serverId)
    if (!server) return { ok: false, message: 'Server not found', code: 'not_found' }
    if (server.transport.type !== 'http') {
      return { ok: false, message: 'OAuth sign-in applies to HTTP MCP servers only', code: 'not_http' }
    }
    try {
      const result = await this.withMcpUtilityAgent(
        agent => agent.requestMcpAuth!(server.name),
        message => ({ ok: false, message, code: 'no_session' } satisfies McpOperationResult),
      )
      if (result.ok) {
        platform?.logger.info(`[MCP] OAuth sign-in succeeded for "${server.name}"`)
        this.eventSink(RPC_CHANNELS.mcp.CHANGED, { to: 'all' })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // A cancelled sign-in tears the utility session down mid-flight, which
      // surfaces here as a rejected request rather than a failure.
      const cancelled = this.mcpUtilitySessionId === null
      platform?.logger.warn(`[MCP] OAuth sign-in ${cancelled ? 'cancelled' : 'failed'} for "${server.name}": ${message}`)
      return { ok: false, message, code: cancelled ? 'cancelled' : 'connect_failed' }
    }
  }

  /**
   * Abandon an in-flight sign-in. The browser flow lives in the utility
   * session's subprocess, so dropping the session is what actually stops it.
   */
  async cancelMcpAuth(): Promise<{ ok: boolean }> {
    if (!this.mcpUtilitySessionId) return { ok: false }
    platform?.logger.info('[MCP] sign-in cancelled by the user')
    await this.disposeMcpUtilitySession()
    return { ok: true }
  }

  /** Clear one server's stored OAuth credentials. */
  async signOutMcpServer(serverId: string): Promise<McpOperationResult> {
    const server = getMcpServers().find(item => item.id === serverId)
    if (!server) return { ok: false, message: 'Server not found', code: 'not_found' }
    if (server.transport.type !== 'http') {
      return { ok: false, message: 'OAuth sign-out applies to HTTP MCP servers only', code: 'not_http' }
    }
    const url = server.transport.url
    try {
      const result = await this.withMcpUtilityAgent(
        agent => agent.requestMcpLogout!(server.name, url),
        message => ({ ok: false, message, code: 'no_session' } satisfies McpOperationResult),
      )
      if (result.ok) {
        platform?.logger.info(`[MCP] signed out of "${server.name}"`)
        this.forgetMcpStatus(server.name)
        this.eventSink(RPC_CHANNELS.mcp.CHANGED, { to: 'all' })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      platform?.logger.warn(`[MCP] sign-out failed for "${server.name}": ${message}`)
      return { ok: false, message, code: 'logout_failed' }
    }
  }

  /**
   * Reconnect one server in every live chat session.
   *
   * Deliberately NOT the utility session: a connection belongs to the agent
   * that will call the tools, so reconnecting anywhere else would report
   * success while the user's session stays broken. With no live session there
   * is nothing to reconnect — the next session connects on its own.
   */
  async reconnectMcpServer(serverId: string): Promise<McpOperationResult> {
    const server = getMcpServers().find(item => item.id === serverId)
    if (!server) return { ok: false, message: 'Server not found', code: 'not_found' }
    if (!server.enabled) return { ok: false, message: 'Server is disabled', code: 'server_disabled' }

    const agents = [...this.sessions.values()]
      .filter(managed => managed.id !== this.mcpUtilitySessionId)
      .map(managed => managed.agent as McpCapableAgent | null | undefined)
      .filter((agent): agent is McpCapableAgent => typeof agent?.requestMcpAuth === 'function')
    if (!agents.length) {
      return { ok: false, message: 'No running session to reconnect in', code: 'no_live_session' }
    }

    const results = await Promise.all(agents.map(async agent => {
      try {
        return await agent.requestMcpAuth!(server.name)
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
          code: 'connect_failed',
        } satisfies McpOperationResult
      }
    }))
    const failure = results.find(result => !result.ok)
    platform?.logger.info(`[MCP] reconnect "${server.name}" in ${agents.length} session(s) — ${failure ? `failed: ${failure.code}` : 'ok'}`)
    this.eventSink(RPC_CHANNELS.mcp.CHANGED, { to: 'all' })
    return failure ?? { ok: true, message: `Reconnected "${server.name}"` }
  }

  private toManaged(session: Session): ManagedSession {
    const managed = this.sessions.get(session.id)
    if (!managed) throw new Error(`Session ${session.id} not tracked`)
    return managed
  }

  resolveMcpApproval(sessionId: string, requestId: string, decision: McpApprovalDecision): boolean {    const agent = this.sessions.get(sessionId)?.agent as McpCapableAgent | null | undefined
    if (!agent?.resolveMcpApproval) {
      platform?.logger.warn(`[MCP] approval ${decision} for ${requestId} could not route — session ${sessionId.slice(0, 8)} has no MCP agent`)
      return false
    }
    agent.resolveMcpApproval(requestId, decision)
    this.mcpRuntime.clearApprovalTimer(sessionId, requestId)
    platform?.logger.info(`[MCP] approval ${decision} → ${requestId} (${sessionId.slice(0, 8)})`)
    return true
  }

  private mcpConfigHash(): string {
    return JSON.stringify([getMcpServers(), getMcpSettings()])
  }

  private handleMcpStatus(managed: ManagedSession, snapshot: McpStatusSnapshotDto): void {
    const firstForSession = !this.mcpRuntime.hasStatus(managed.id)
    this.mcpRuntime.recordStatus(managed.id, snapshot)
    const summary = snapshot.servers
      .map(server => `${server.name}:${server.status}(${server.toolCount} tools)`)
      .join(', ')
    const line = `[MCP] status ${managed.id.slice(0, 8)} — ${summary || 'no servers'}`
    if (firstForSession) platform?.logger.info(line)
    else platform?.logger.debug(line)
    // Same envelope/channel as every other session event, but emitted through
    // the sink directly: shared's SessionEvent union does not include the MCP
    // event types yet, and the sink's payload parameter is intentionally
    // untyped (`...args: any[]`).
    this.eventSink(RPC_CHANNELS.sessions.EVENT, { to: 'workspace', workspaceId: managed.workspace.id }, {
      type: 'mcp_status',
      sessionId: managed.id,
      snapshot,
    } satisfies McpStatusSessionEvent)
    // Settings → MCP is not scoped to a workspace and must not have to re-list
    // to notice a connect, a failure or a sign-in taking effect, so the same
    // snapshot also goes out on the MCP channel to every client.
    this.eventSink(RPC_CHANNELS.mcp.STATUS, { to: 'all' }, {
      sessionId: managed.id,
      snapshot,
    })
  }

  private handleMcpApprovalRequest(managed: ManagedSession, request: McpApprovalRequestDto): void {
    // Answers the user already gave, honored before anything is shown:
    //   - full access is the session saying "stop asking me"; an MCP tool call
    //     is a tool call, and the adapter's own gate knows nothing about the
    //     session's permission mode;
    //   - "always allow" for this tool, remembered per session here because
    //     the adapter's cache does not survive an agent-session rebuild.
    const preApproved = managed.permissionMode === 'allow-all'
      || this.mcpRuntime.isApproved(managed.id, request.serverName, request.originalToolName)
    if (preApproved) {
      const reason = managed.permissionMode === 'allow-all' ? 'full access' : 'always allowed'
      platform?.logger.info(`[MCP] auto-approved ${managed.id.slice(0, 8)} — ${request.prefixedToolName} (${reason})`)
      ;(managed.agent as McpCapableAgent | null)?.resolveMcpApproval?.(request.requestId, 'allow_for_session')
      return
    }
    platform?.logger.info(`[MCP] approval requested ${managed.id.slice(0, 8)} — ${request.prefixedToolName}`)
    // Fail-closed guard: the adapter awaits a claimed approval handler
    // indefinitely (only an aborted turn unblocks it), so an unanswered
    // request is denied after 120s instead of hanging the tool call.
    this.mcpRuntime.scheduleApprovalAutoDeny(managed.id, request.requestId, () => {
      ;(managed.agent as McpCapableAgent | null)?.resolveMcpApproval?.(request.requestId, 'deny')
    }, undefined, { serverName: request.serverName, originalToolName: request.originalToolName })
    // Ride the standard permission_request pipeline: same queueing, native
    // notification, and inline approval prompt as every other tool approval.
    // The renderer resolves through sessions:respondToPermission, which routes
    // back to resolveMcpApproval by requestId (see respondToPermission).
    this.emit(managed.workspace.id, {
      type: 'permission_request',
      sessionId: managed.id,
      request: {
        sessionId: managed.id,
        requestId: request.requestId,
        toolName: request.prefixedToolName,
        command: formatMcpApprovalCommand(request.args),
        description: `MCP tool call on server "${request.serverName}"`,
        type: 'mcp',
      },
    })
  }

  /** Config-watcher path: external config.json edits propagate to live agents. */
  private handleExternalMcpConfigChange(config: StoredConfig): void {
    const hash = JSON.stringify([config.mcpServers ?? [], config.mcpSettings ?? null])
    if (hash === this.lastMcpConfigHash) return
    this.eventSink(RPC_CHANNELS.mcp.CHANGED, { to: 'all' })
    this.refreshMcpConfig()
  }

  async refreshConnectionRuntime(connectionSlug: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter(managed => managed.agent && this.selectionOf(managed).connection === connectionSlug)
      .map(managed => this.refreshManagedRuntime(managed)))
  }

  private async refreshManagedRuntime(managed: ManagedSession): Promise<void> {
    if (managed.runtimeRefreshPromise) return managed.runtimeRefreshPromise
    managed.runtimeRefreshPromise = this.performRuntimeRefresh(managed).finally(() => {
      managed.runtimeRefreshPromise = undefined
    })
    return managed.runtimeRefreshPromise
  }

  private async performRuntimeRefresh(managed: ManagedSession): Promise<void> {
    const agent = managed.agent
    if (!agent || agent.isProcessing()) return
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    const route = this.routeOf(managed)
    const context = resolveBackendContext({ sessionConnectionSlug: route.connection, workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection, managedModel: route.model })
    const runtimeSignature = buildBackendRuntimeSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel })
    if (runtimeSignature === managed.backendRuntimeSignature) return
    const restartSignature = buildRestartRequiredSignature({ connection: context.connection, provider: context.provider, authType: context.authType, resolvedModel: context.resolvedModel })
    if (restartSignature !== managed.backendRestartSignature || !agent.updateRuntimeConfig) {
      await agent.disposeForRestart?.()
      agent.dispose()
      managed.agent = null
      return
    }
    const connection = context.connection
    const updated = await agent.updateRuntimeConfig({
      model: context.resolvedModel,
      providerType: connection?.providerType,
      authType: context.authType,
      runtime: connection ? {
        baseUrl: connection.baseUrl,
        piAuthProvider: connection.piAuthProvider,
        customEndpoint: connection.customEndpoint,
        customModels: connection.models?.map(model => typeof model === 'string' ? model : ({ id: model.id, contextWindow: model.contextWindow, supportsImages: model.supportsImages })),
      } : {},
    })
    if (!updated) {
      await agent.disposeForRestart?.()
      agent.dispose()
      managed.agent = null
      return
    }
    managed.backendRuntimeSignature = runtimeSignature
    managed.backendRestartSignature = restartSignature
  }

  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    const queued = managed?.messageQueue.shift()
    if (!managed || !queued) return
    const existing = managed.messages.find(item => item.id === queued.messageId)
    if (existing) {
      existing.isQueued = false
      existing.timestamp = this.nextTimestamp()
      this.emit(managed.workspace.id, { type: 'user_message', sessionId, message: existing, status: 'processing', optimisticMessageId: queued.optimisticMessageId })
    }
    this.persistSession(managed)
    void this.sendMessage(sessionId, queued.message, queued.attachments, queued.storedAttachments, queued.options, queued.messageId, true)
  }

  private nextTimestamp(): number {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1)
    return this.lastTimestamp
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.agent || !managed.isProcessing) return
    managed.agent.forceAbort(AbortReason.UserStop)
    managed.isProcessing = false
    if (!silent) this.emit(managed.workspace.id, { type: 'interrupted', sessionId })
  }

  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { success: false, error: 'Session not found' }

    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        const { execFile } = await import('node:child_process')
        const pattern = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const stdout = await new Promise<string>((resolve, reject) => {
          execFile('pgrep', ['-f', pattern], { encoding: 'utf8' }, (error, result) => {
            if (error) reject(error)
            else resolve(result)
          })
        }).catch(() => '')

        for (const value of stdout.split('\n')) {
          const pid = Number(value.trim())
          if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            // The process may have exited between discovery and termination.
          }
        }
      } finally {
        managed.backgroundShellCommands.delete(shellId)
      }
    }

    this.emit(managed.workspace.id, { type: 'shell_killed', sessionId, shellId })
    return { success: true }
  }

  listBackgroundTasks(sessionId: string) {
    const managed = this.sessions.get(sessionId)
    if (!managed) return []
    const now = Date.now()
    return [...managed.backgroundTaskRegistry.values()].map(task => {
      const end = task.status === 'running' ? now : (task.completedAt ?? now)
      return {
        taskId: task.taskId,
        intent: task.intent,
        status: task.status,
        startTime: task.startTime,
        elapsedSeconds: task.elapsedSeconds ?? Math.max(0, Math.round((end - task.startTime) / 1000)),
        completedAt: task.completedAt,
        workflowId: task.workflowId,
        agentsCompleted: task.agentsCompleted,
      }
    })
  }

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    _options?: PermissionResponseOptions,
  ): boolean {
    const managed = this.sessions.get(sessionId)
    if (!managed?.agent) return false
    // MCP tool approvals share this channel but their requestIds live in the
    // MCP runtime, not the agent's permission pipeline. Map the UI's
    // Allow / Always Allow / Deny onto the adapter's decision set.
    if (this.mcpRuntime.hasPendingApproval(sessionId, requestId)) {
      const decision: McpApprovalDecision = !allowed ? 'deny' : alwaysAllow ? 'allow_for_session' : 'allow_once'
      // Remember before resolving: resolving clears the pending record the
      // tool identity is stored under.
      if (decision === 'allow_for_session') this.mcpRuntime.rememberApproval(sessionId, requestId)
      return this.resolveMcpApproval(sessionId, requestId, decision)
    }
    managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
    return true
  }

  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.previousPermissionMode = managed.permissionMode
    managed.permissionMode = mode
    managed.agent?.setPermissionMode(mode)
    this.persistSession(managed)
    this.emit(managed.workspace.id, { type: 'permission_mode_changed', sessionId, permissionMode: mode, previousPermissionMode: managed.previousPermissionMode, changedBy: 'user', changedAt: new Date().toISOString() })
  }

  getSessionPermissionModeState(sessionId: string): PermissionModeState | null {
    const managed = this.sessions.get(sessionId)
    if (!managed?.permissionMode) return null
    return { permissionMode: managed.permissionMode, previousPermissionMode: managed.previousPermissionMode, modeVersion: 1, changedAt: new Date().toISOString(), changedBy: 'unknown' }
  }

  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.thinkingLevel = level
    managed.agent?.setThinkingLevel(level)
    this.persistSession(managed)
  }

  /**
   * Select the complete route for this session's next assembled turn.
   *
   * There is deliberately no "locked after the first message" check. A running
   * turn already snapshotted its own selection, so a switch cannot split it;
   * what the old lock protected against is handled by the snapshot instead.
   *
   * What IS refused is a route that cannot serve this session: an unknown or
   * unauthenticated connection, and a text-only model for a session whose
   * transcript already contains images. Those are real incompatibilities —
   * "you already sent a message" is not.
   *
   * @param sessionId - the session to re-route.
   * @param selection - the complete selection; unset fields follow the defaults.
   * @returns the selection that landed.
   * @throws when no adapter can serve the route, or images make it unusable.
   */
  async selectModel(
    sessionId: string,
    selection: SessionModelSelection,
  ): Promise<SelectModelResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session not found: ${sessionId}`)
    this.ensureMessagesLoaded(managed)

    const previous = this.selectionOf(managed)
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    const context = resolveBackendContext({
      sessionConnectionSlug: selection.connection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: selection.model,
    })

    // Compare the RESOLVED slug, not just "did anything resolve": connection
    // resolution falls back to the workspace/global default for an unknown
    // slug, so a bare null-check would silently route the user somewhere they
    // did not choose. A selection that cannot be honored must fail, not drift.
    if (selection.connection && context.connection?.slug !== selection.connection) {
      throw new Error(`No connection serves "${selection.connection}"; pick another model.`)
    }

    // Image admission: a session that already contains images cannot continue
    // on a text-only model, because its own history would stop being sendable.
    if (context.connection && !modelSupportsImages(context.connection, context.resolvedModel)) {
      const hasImages = managed.messages.some(item =>
        item.attachments?.some(attachment => isImageAttachment(attachment)),
      )
      if (hasImages) {
        throw new Error(
          `Model "${context.resolvedModel}" does not accept image input, but this session already contains images; select an image-capable model.`,
        )
      }
    }

    const next: SessionModelSelection = {
      connection: context.connection?.slug ?? selection.connection,
      model: selection.model,
      thinkingLevel: selection.thinkingLevel ?? previous.thinkingLevel,
    }

    managed.pickedSelection = next
    // The persisted projection of the same choice, so it survives a restart
    // that happens before the next turn records it.
    managed.llmConnection = next.connection
    managed.model = next.model
    if (next.thinkingLevel) {
      managed.thinkingLevel = next.thinkingLevel
      managed.agent?.setThinkingLevel(next.thinkingLevel)
    }

    // Same connection: the live backend can just retarget its model. A
    // different connection needs new credential/provider routing, which the
    // runtime refresh resolves by restarting the backend on the next turn.
    if (!crossesConnection(previous, next) && next.model && managed.agent) {
      managed.agent.setModel(next.model)
    }

    // Remember it for the next session in this workspace. A failure here must
    // not fail the switch: the selection already applies to THIS session, and
    // losing the default is strictly less bad than rejecting a valid choice.
    try {
      setWorkspaceModelDefaults(managed.workspace.dataRoot, next)
    } catch (error) {
      log.warn(
        `the model switch applies to this session but was not saved as the workspace default: ${String(error)}`,
      )
    }

    await this.flushSession(sessionId)
    this.emit(managed.workspace.id, { type: 'connection_changed', sessionId, connectionSlug: next.connection ?? '' })
    this.emit(managed.workspace.id, {
      type: 'session_model_changed',
      sessionId,
      model: next.model ?? null,
      ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
    })
    return { selected: next }
  }

  /**
   * Read the session's model directory.
   *
   * `groups` is advisory and `routable` is the gate. They are computed from
   * different things on purpose: a connection can serve a model it no longer
   * advertises (absent from groups, perfectly usable), while a connection with
   * no credentials can serve nothing however complete its catalog looks. A UI
   * that blocks its composer must read `routable`.
   *
   * @param sessionId - the session whose directory to read.
   * @returns the directory snapshot.
   */
  async getSessionModels(sessionId: string): Promise<SessionModels> {
    const managed = this.sessions.get(sessionId)
    if (!managed) throw new Error(`Session not found: ${sessionId}`)
    this.ensureMessagesLoaded(managed)

    const current = this.selectionOf(managed)
    const workspaceConfig = loadWorkspaceConfig(managed.workspace.dataRoot)
    const context = resolveBackendContext({
      sessionConnectionSlug: current.connection,
      workspaceDefaultConnectionSlug: workspaceConfig?.defaults?.defaultLlmConnection,
      managedModel: current.model,
    })

    const credentials = getCredentialManager()
    const groups: ModelConnectionGroup[] = []
    const failures: ModelCatalogFailure[] = []
    let routable = false

    for (const connection of getLlmConnections()) {
      let authenticated = false
      try {
        authenticated = await credentials.hasLlmCredentials(connection.slug, connection.authType)
      } catch (error) {
        failures.push({
          slug: connection.slug,
          name: connection.name,
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      // A connection with no credentials is not a "failure" to report — it is
      // simply not offerable yet, and listing it as an error row would put
      // noise above the models the user can actually pick. `failures` stays
      // reserved for connections that should have worked and did not.
      if (!authenticated) continue
      if (connection.slug === context.connection?.slug) routable = true

      // Dedupe by id: a connection's model list legitimately repeats an id when
      // the provider exposes fewer models than the setup wizard's tiers
      // (best/balanced/fast), which would otherwise render the same row twice —
      // and check both copies.
      const seen = new Set<string>()
      const models: ModelCatalogModel[] = []
      for (const model of connection.models ?? []) {
        const id = typeof model === 'string' ? model : model.id
        if (seen.has(id)) continue
        seen.add(id)
        models.push({
          id,
          name: typeof model === 'string' ? model : (model.name ?? model.id),
          supportsImages: modelSupportsImages(connection, id),
          ...(typeof model !== 'string' && model.supportsThinking !== undefined
            ? { supportsThinking: model.supportsThinking }
            : {}),
        })
      }

      groups.push({
        slug: connection.slug,
        name: connection.name,
        providerType: connection.providerType,
        models,
      })
    }

    return {
      current,
      resolvedModel: context.resolvedModel,
      routable,
      groups,
      failures,
    }
  }

  /** @deprecated Use {@link selectModel}; kept for callers that only set a connection. */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    await this.selectModel(sessionId, { ...this.selectionOf(managed), connection: connectionSlug, model: undefined })
  }

  /** @deprecated Use {@link selectModel}; kept for the existing model-only wire. */
  async updateSessionModel(sessionId: string, _workspaceId: string, model: string | null, connection?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    const previous = this.selectionOf(managed)
    await this.selectModel(sessionId, {
      connection: connection ?? previous.connection,
      model: model ?? undefined,
      thinkingLevel: previous.thinkingLevel,
    })
  }

  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) this.activeViewingByWorkspace.set(workspaceId, sessionId)
    else this.activeViewingByWorkspace.delete(workspaceId)
  }

  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingByWorkspace.delete(workspaceId)
  }

  markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    return this.updateMetadata(sessionId, { hasUnread: false, lastReadMessageId: managed?.messages.at(-1)?.id })
  }

  markSessionUnread(sessionId: string): Promise<void> {
    return this.updateMetadata(sessionId, { hasUnread: true })
  }

  async markAllSessionsRead(workspaceId: string): Promise<void> {
    await Promise.all([...this.sessions.values()]
      .filter(managed => managed.workspace.id === workspaceId)
      .map(managed => this.markSessionRead(managed.id)))
    this.refreshBadge()
  }

  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    for (const managed of this.sessions.values()) {
      if (managed.hasUnread) byWorkspace[managed.workspace.id] = (byWorkspace[managed.workspace.id] ?? 0) + 1
    }
    return {
      totalUnreadSessions: Object.values(byWorkspace).reduce((sum, count) => sum + count, 0),
      byWorkspace,
      hasUnreadByWorkspace: Object.fromEntries(Object.entries(byWorkspace).map(([id, count]) => [id, count > 0])),
    }
  }

  refreshBadge(): void {
    runtimeHooks.updateBadgeCount(this.getUnreadSummary().totalUnreadSessions)
  }

  addMessageAnnotation(sessionId: string, messageId: string, annotation: AnnotationV1): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      log.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      log.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: AnnotationV1 = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(item => item.id === safeAnnotation.id)) {
      log.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      log.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(item => item.id === annotationId)) {
      log.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(item => item.id !== annotationId)
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  updateMessageAnnotation(sessionId: string, messageId: string, annotationId: string, patch: Partial<AnnotationV1>): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      log.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(item => item.id === messageId)
    if (!message) {
      log.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const index = existing.findIndex(item => item.id === annotationId)
    if (index === -1) {
      log.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      log.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      log.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[index]!
    const updated: AnnotationV1 = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[index] = updated
    message.annotations = next
    this.persistSession(managed)
    this.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations }, managed.workspace.id)
  }

  setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return Promise.resolve()
    managed.pendingPlanExecution = { planPath, draftInputSnapshot, awaitingCompaction: true, executionDispatched: false }
    return setStoredPendingPlanExecution(managed.workspace.dataRoot, sessionId, planPath, draftInputSnapshot)
  }

  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    if (managed.pendingPlanExecution) managed.pendingPlanExecution.awaitingCompaction = false
    await markStoredCompactionComplete(managed.workspace.dataRoot, sessionId)
  }

  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    if (managed.pendingPlanExecution) managed.pendingPlanExecution.executionDispatched = true
    await markStoredPendingPlanExecutionDispatched(managed.workspace.dataRoot, sessionId)
  }

  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return
    managed.pendingPlanExecution = undefined
    await clearStoredPendingPlanExecution(managed.workspace.dataRoot, sessionId)
  }

  getPendingPlanExecution(sessionId: string) {
    const managed = this.sessions.get(sessionId)
    return managed ? getStoredPendingPlanExecution(managed.workspace.dataRoot, sessionId) : null
  }

  async acceptPlan(sessionId: string, _planPath?: string): Promise<void> {
    await this.sendMessage(sessionId, 'I approve this plan. Please execute it.')
  }

  getSessionFinalText(sessionId: string): string | undefined {
    return [...(this.sessions.get(sessionId)?.messages ?? [])].reverse().find(item => item.role === 'assistant')?.content
  }

  onSessionComplete(listener: (event: SessionCompletionEvent) => void): () => void {
    this.completionListeners.add(listener)
    return () => this.completionListeners.delete(listener)
  }

  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { success: false, error: 'Session not found' }
    try {
      const agent = await this.getOrCreateAgent(managed)
      const recentUsers = managed.messages.filter(item => item.role === 'user').slice(-3).map(item => item.content)
      const lastAssistant = this.getSessionFinalText(sessionId) ?? ''
      const title = await agent.regenerateTitle(recentUsers, lastAssistant, { language: resolveTitleLanguageName() })
      if (!title) return { success: false, error: 'Title generation returned no result' }
      await this.renameSession(sessionId, title)
      return { success: true, title }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ dataRoot: _dataRoot, createdAt: _createdAt, ...info }) => info)
  }

  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    if (this.configWatchers.has(workspaceRootPath)) return

    const callbacks: ConfigWatcherCallbacks = {
      onConfigChange: config => {
        this.handleExternalMcpConfigChange(config)
      },
      onLlmConnectionsChange: () => {
        this.eventSink(RPC_CHANNELS.llmConnections.CHANGED, { to: 'all' })
      },
      onAppThemeChange: theme => {
        this.eventSink(RPC_CHANNELS.theme.APP_CHANGED, { to: 'all' }, theme)
      },
      onDefaultPermissionsChange: () => {
        this.eventSink(RPC_CHANNELS.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
      },
      onSkillsListChange: () => {
        void this.broadcastSkillsChanged(workspaceId, workspaceRootPath)
      },
      onSkillChange: () => {
        void this.broadcastSkillsChanged(workspaceId, workspaceRootPath)
      },
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return
        if (managed.isProcessing) managed.pendingExternalHeader = header
        else this.applyExternalSessionMetadata(managed, header)
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks, {
      skillRoots: skillTierRoots(workspaceId),
    })
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)
  }

  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    this.configWatchers.get(workspaceRootPath)?.notifyFileChange(relativePath)
  }

  /**
   * Push the whole catalog, not just the winners: the UI needs the shadowed
   * entries and the revision, and the revision is what tells it whether it and
   * the live session are looking at the same catalog.
   */
  private async broadcastSkillsChanged(workspaceId: string, workspaceRootPath: string): Promise<void> {
    const { getSkillsSnapshot } = await import('@bitlab/shared/skills')
    const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
    const projectRoot = workspace?.folderPath && existsSync(workspace.folderPath)
      ? workspace.folderPath
      : undefined
    const snapshot = getSkillsSnapshot(workspaceRootPath, projectRoot)
    this.eventSink(RPC_CHANNELS.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, snapshot)
  }

  private applyExternalSessionMetadata(managed: ManagedSession, header: SessionHeader): void {
    if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
      managed.isFlagged = header.isFlagged ?? false
      this.sendEvent({
        type: managed.isFlagged ? 'session_flagged' : 'session_unflagged',
        sessionId: managed.id,
      }, managed.workspace.id)
    }
    if ((managed.isArchived ?? false) !== (header.isArchived ?? false)) {
      managed.isArchived = header.isArchived ?? false
      managed.archivedAt = header.archivedAt
      this.sendEvent({
        type: managed.isArchived ? 'session_archived' : 'session_unarchived',
        sessionId: managed.id,
      }, managed.workspace.id)
    }
    if (managed.name !== header.name) {
      managed.name = header.name
      this.sendEvent({ type: 'name_changed', sessionId: managed.id, name: header.name }, managed.workspace.id)
    }
  }

  getActiveSessionCount(workspaceId?: string): number {
    return [...this.sessions.values()].filter(managed => managed.isProcessing && (!workspaceId || managed.workspace.id === workspaceId)).length
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    return [...this.sessions.values()].filter(managed => managed.isProcessing).map(managed => ({
      sessionId: managed.id,
      workspaceId: managed.workspace.id,
      workspaceName: managed.workspace.name,
      title: managed.name,
      status: 'processing',
      createdAt: managed.createdAt,
    }))
  }

  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    if (connectionSlug) return this.refreshConnectionRuntime(connectionSlug)
    await Promise.all([...new Set([...this.sessions.values()].map(item => item.llmConnection).filter(Boolean) as string[])].map(slug => this.refreshConnectionRuntime(slug)))
  }

  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.workspace.id !== workspaceId || managed.isProcessing) return null
    await this.flushSession(sessionId)
    return serializeSession(managed.workspace.dataRoot, sessionId)
  }

  async importSession(workspaceId: string, bundle: SessionBundle, mode: DispatchMode): Promise<{ sessionId: string; warnings?: string[] }> {
    if (!validateBundle(bundle)) throw new Error('Invalid session bundle')
    const workspace = getWorkspaces().find(item => item.id === workspaceId || item.slug === workspaceId)
    if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`)
    const created = await createStoredSession(workspace.dataRoot, {
      name: bundle.session.header.name,
      workingDirectory: workspace.folderPath ?? workspace.dataRoot,
      permissionMode: bundle.session.header.permissionMode,
      model: bundle.session.header.model,
      llmConnection: bundle.session.header.llmConnection,
      hidden: bundle.session.header.hidden,
      isFlagged: bundle.session.header.isFlagged,
      parentSessionId: mode === 'fork' ? bundle.session.header.id : bundle.session.header.parentSessionId,
    })
    const stored = loadStoredSession(workspace.dataRoot, created.id)
    if (!stored) throw new Error('Failed to create imported session')
    stored.messages = bundle.session.messages
    stored.tokenUsage = bundle.session.header.tokenUsage
    await saveStoredSession(stored)
    restoreFiles(getSessionStoragePath(workspace.dataRoot, created.id), bundle.files)
    const managed = createManagedSession(stored, workspace, { messagesLoaded: true })
    this.sessions.set(managed.id, managed)
    this.notifySessionCreated(workspace.id, managed.id)
    return { sessionId: managed.id }
  }

  cleanup(): void {
    for (const watcher of this.configWatchers.values()) watcher.stop()
    this.configWatchers.clear()
    this.mcpUtilitySessionId = null
    for (const managed of this.sessions.values()) {
      managed.agent?.destroy()
      unregisterSessionScopedToolCallbacks(managed.id)
    }
    this.sessions.clear()
    this.mcpRuntime.clearAll()
    this.browserHostPins.clear()
    this.rpcServer = null
    this.browserPaneManager = null
  }
}

export { sanitizeForTitle } from '@bitlab/server-core/domain'
