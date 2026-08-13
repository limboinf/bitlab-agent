import type {
  AnnotationV1,
  ContentBadge,
  ContextUsageReading,
  Message,
  PermissionRequest as BasePermissionRequest,
  StoredAttachment,
  ToolDisplayMeta,
  TypedError,
} from '@bitlab/core/types';
import type { PermissionMode } from '../agent/mode-types.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { CustomEndpointConfig } from '../config/llm-connections.ts';

export { generateMessageId } from '@bitlab/core/types';

export interface Session {
  id: string;
  workspaceId: string;
  workspaceName: string;
  name?: string;
  preview?: string;
  lastMessageAt: number;
  messages: Message[];
  isProcessing: boolean;
  isFlagged?: boolean;
  permissionMode?: PermissionMode;
  lastReadMessageId?: string;
  hasUnread?: boolean;
  workingDirectory?: string;
  sessionFolderPath?: string;
  model?: string;
  llmConnection?: string;
  thinkingLevel?: ThinkingLevel;
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error';
  lastFinalMessageId?: string;
  isAsyncOperationOngoing?: boolean;
  isRegeneratingTitle?: boolean;
  currentStatus?: { message: string; statusType?: string };
  createdAt?: number;
  messageCount?: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    contextTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    contextWindow?: number;
  };
  /** Live context-meter reading; absent until the backend reports one. */
  contextUsage?: ContextUsageReading;
  hidden?: boolean;
  isArchived?: boolean;
  archivedAt?: number;
  supportsBranching?: boolean;
  parentSessionId?: string;
}

export interface CreateSessionOptions {
  name?: string;
  permissionMode?: PermissionMode;
  thinkingLevel?: ThinkingLevel;
  model?: string;
  llmConnection?: string;
  systemPromptPreset?: 'default' | 'mini' | string;
  hidden?: boolean;
  isFlagged?: boolean;
  branchFromMessageId?: string;
  branchFromSessionId?: string;
  parentSessionId?: string;
}

export interface PermissionModeState {
  permissionMode: PermissionMode;
  previousPermissionMode?: PermissionMode;
  transitionDisplay?: string;
  modeVersion: number;
  changedAt: string;
  changedBy: 'user' | 'system' | 'restore' | 'unknown';
}

export type SessionEvent =
  | { type: 'text_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'text_complete'; sessionId: string; text: string; isIntermediate?: boolean; turnId?: string; parentToolUseId?: string; timestamp?: number; messageId?: string }
  | { type: 'thinking_delta'; sessionId: string; delta: string; turnId?: string }
  | { type: 'thinking_complete'; sessionId: string; text: string; turnId?: string; timestamp?: number; messageId?: string }
  | { type: 'tool_start'; sessionId: string; toolName: string; toolUseId: string; toolInput: Record<string, unknown>; toolIntent?: string; toolDisplayName?: string; toolDisplayMeta?: ToolDisplayMeta; turnId?: string; parentToolUseId?: string; timestamp?: number }
  | { type: 'tool_result'; sessionId: string; toolUseId: string; toolName: string; result: string; turnId?: string; parentToolUseId?: string; isError?: boolean; timestamp?: number }
  | { type: 'error'; sessionId: string; error: string; timestamp?: number }
  | { type: 'typed_error'; sessionId: string; error: TypedError; timestamp?: number }
  | { type: 'complete'; sessionId: string; tokenUsage?: Session['tokenUsage']; hasUnread?: boolean; backgroundTasksAlive?: boolean }
  | { type: 'interrupted'; sessionId: string; message?: Message; queuedMessages?: string[] }
  | { type: 'status'; sessionId: string; message: string; statusType?: 'compacting' }
  | { type: 'info'; sessionId: string; message: string; statusType?: 'compaction_complete'; level?: 'info' | 'warning' | 'error' | 'success'; timestamp?: number }
  | { type: 'title_generated'; sessionId: string; title: string }
  | { type: 'title_regenerating'; sessionId: string; isRegenerating: boolean }
  | { type: 'async_operation'; sessionId: string; isOngoing: boolean }
  | { type: 'permission_request'; sessionId: string; request: PermissionRequest }
  | { type: 'permission_mode_changed'; sessionId: string; permissionMode: PermissionMode; previousPermissionMode?: PermissionMode; transitionDisplay?: string; modeVersion?: number; changedAt?: string; changedBy?: PermissionModeState['changedBy'] }
  | { type: 'plan_submitted'; sessionId: string; message: Message }
  | { type: 'connection_changed'; sessionId: string; connectionSlug: string; supportsBranching?: boolean }
  | { type: 'task_backgrounded'; sessionId: string; toolUseId: string; taskId: string; intent?: string; turnId?: string; kind?: 'workflow'; workflowId?: string }
  | { type: 'workflow_agent_completed'; sessionId: string; workflowId: string; agentId: string; turnId?: string }
  | { type: 'shell_backgrounded'; sessionId: string; toolUseId: string; shellId: string; intent?: string; command?: string; turnId?: string }
  | { type: 'task_progress'; sessionId: string; toolUseId: string; elapsedSeconds: number; turnId?: string }
  | { type: 'task_completed'; sessionId: string; taskId: string; status: 'completed' | 'failed' | 'stopped'; outputFile?: string; summary?: string; turnId?: string }
  | { type: 'shell_killed'; sessionId: string; shellId: string }
  | { type: 'user_message'; sessionId: string; message: Message; status: 'accepted' | 'queued' | 'processing'; optimisticMessageId?: string }
  | { type: 'session_flagged'; sessionId: string }
  | { type: 'session_unflagged'; sessionId: string }
  | { type: 'session_archived'; sessionId: string }
  | { type: 'session_unarchived'; sessionId: string }
  | { type: 'name_changed'; sessionId: string; name?: string }
  | { type: 'session_model_changed'; sessionId: string; model: string | null; thinkingLevel?: ThinkingLevel }
  | { type: 'session_deleted'; sessionId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'usage_update'; sessionId: string; tokenUsage: { inputTokens: number; contextWindow?: number } }
  | { type: 'context_usage'; sessionId: string; contextUsage: ContextUsageReading }
  | { type: 'message_annotations_updated'; sessionId: string; messageId: string; annotations: AnnotationV1[] }
  | { type: 'working_directory_error'; sessionId: string; error: string };

export interface SendMessageOptions {
  skillSlugs?: string[];
  badges?: ContentBadge[];
  optimisticMessageId?: string;
  hidden?: boolean;
}

/**
 * A complete route for one session: which connection, which model, and how
 * hard to think. Submitted and echoed as a whole, because a model id only
 * means something inside the connection that advertises it.
 */
export interface SessionModelSelectionDto {
  connection?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
}

/** One model inside its connection group. */
export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

/** One connection and the models it advertises. */
export interface ModelConnectionGroup {
  /** Connection slug, used to submit a selection. */
  slug: string;
  name: string;
  providerType: string;
  models: ModelCatalogModel[];
}

/** A connection that cannot currently be selected, listed for visibility. */
export interface ModelCatalogFailure {
  slug: string;
  name: string;
  message: string;
}

/**
 * The session's model directory — everything a picker needs to render.
 *
 * `groups` is ADVISORY: a connection may serve a model it stopped advertising,
 * so a selection missing from the catalog is not the same as an unusable one.
 * A surface that blocks input must read `routable`, never catalog membership.
 */
export interface SessionModels {
  /** The selection the next assembled turn will use. */
  current: SessionModelSelectionDto;
  /** The resolved model id, after connection defaults are applied. */
  resolvedModel: string;
  /**
   * Whether an authenticated connection serves `current`, and therefore
   * whether this session can start a turn at all.
   */
  routable: boolean;
  /** Connections that loaded, in display order. */
  groups: ModelConnectionGroup[];
  /** Connections that could not be offered; the rest stay usable. */
  failures: ModelCatalogFailure[];
}

/** Outcome of a model selection. */
export interface SelectModelResult {
  /** The selection that landed. */
  selected: SessionModelSelectionDto;
}

export type SessionCommand =
  | { type: 'flag' }
  | { type: 'unflag' }
  | { type: 'archive' }
  | { type: 'unarchive' }
  | { type: 'rename'; name: string }
  | { type: 'markRead' }
  | { type: 'markUnread' }
  | { type: 'setActiveViewing'; workspaceId: string }
  | { type: 'setPermissionMode'; mode: PermissionMode }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'showInFinder' }
  | { type: 'copyPath' }
  | { type: 'refreshTitle' }
  | { type: 'setConnection'; connectionSlug: string }
  | { type: 'selectModel'; selection: SessionModelSelectionDto }
  | { type: 'models' }
  | { type: 'setPendingPlanExecution'; planPath: string; draftInputSnapshot?: string }
  | { type: 'markCompactionComplete' }
  | { type: 'markPendingPlanExecutionDispatched' }
  | { type: 'clearPendingPlanExecution' }
  | { type: 'addAnnotation'; messageId: string; annotation: AnnotationV1 }
  | { type: 'removeAnnotation'; messageId: string; annotationId: string }
  | { type: 'updateAnnotation'; messageId: string; annotationId: string; patch: Partial<AnnotationV1> };

export interface NewChatActionParams { input?: string; name?: string }
export type { BasePermissionRequest };
export interface PermissionRequest extends BasePermissionRequest { sessionId: string }
export interface PermissionResponseOptions { rememberForMinutes?: number }

export interface DirectoryListingResult {
  currentPath: string;
  parentPath: string | null;
  breadcrumbs: Array<{ name: string; path: string }>;
  platform: 'win32' | 'darwin' | 'linux';
  truncated: boolean;
  totalEntries: number;
  entries: Array<{ name: string; path: string; isSymlink: boolean }>;
}

export interface FileAttachment {
  type: 'image' | 'text' | 'pdf' | 'office' | 'audio' | 'unknown';
  path: string;
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
  size: number;
  thumbnailBase64?: string;
}
export interface SessionFile { name: string; path: string; type: 'file' | 'directory'; size?: number; children?: SessionFile[] }
export interface FileSearchResult { name: string; path: string; type: 'file' | 'directory'; relativePath: string }

export interface LlmConnectionSetup {
  slug: string;
  credential?: string;
  baseUrl?: string | null;
  defaultModel?: string | null;
  models?: string[] | null;
  piAuthProvider?: string;
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier';
  updateOnly?: boolean;
  customEndpoint?: CustomEndpointConfig;
}
export interface TestLlmConnectionParams {
  provider: 'pi';
  apiKey: string;
  baseUrl?: string;
  model?: string;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
}
export interface TestLlmConnectionResult { success: boolean; error?: string }
export interface SkillFile { name: string; type: 'file' | 'directory'; size?: number; children?: SkillFile[] }
export interface SessionSearchMatch { sessionId: string; lineNumber: number; snippet: string }
export interface SessionSearchResult { sessionId: string; matchCount: number; matches: SessionSearchMatch[] }
export interface UnreadSummary { totalUnreadSessions: number; byWorkspace: Record<string, number>; hasUnreadByWorkspace: Record<string, boolean> }
export interface RefreshTitleResult { success: boolean; title?: string; error?: string }

export interface PlanStep { id: string; description: string; tools?: string[]; status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' }
export interface Plan { id: string; title: string; summary?: string; steps: PlanStep[]; questions?: string[]; state?: 'creating' | 'refining' | 'ready' | 'executing' | 'completed' | 'cancelled'; createdAt?: number; updatedAt?: number }
export interface GitBashStatus { found: boolean; path: string | null; platform: 'win32' | 'darwin' | 'linux' }
export interface UpdateInfo { available: boolean; currentVersion: string; latestVersion: string | null; downloadState: 'idle' | 'downloading' | 'ready' | 'installing' | 'error'; downloadProgress: number; error?: string }
export interface WorkspaceSettings { name?: string; model?: string; permissionMode?: PermissionMode; cyclablePermissionModes?: PermissionMode[]; thinkingLevel?: ThinkingLevel; defaultLlmConnection?: string }
export type WindowCloseRequestSource = 'keyboard-shortcut' | 'window-button' | 'unknown';
export interface WindowCloseRequest { source: WindowCloseRequestSource }
export interface BrowserInstanceInfo {
  id: string;
  url: string;
  title: string;
  favicon: string | null;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  boundSessionId: string | null;
  ownerType: 'session' | 'manual';
  ownerSessionId: string | null;
  isVisible: boolean;
  agentControlActive: boolean;
  themeColor: string | null;
  workspaceId?: string | null;
}
export interface DeepLinkNavigation {
  view?: string
  workspaceId?: string
  sessionId?: string
  settingsSection?: string
  action?: string
  actionParams?: Record<string, string>
}

export type StoredSessionAttachment = StoredAttachment;
