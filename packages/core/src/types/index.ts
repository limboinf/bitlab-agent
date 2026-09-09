/**
 * Re-export all types from @bitlab/core
 */

// Workspace and config types
export type {
  WorkspaceInfo,
  Workspace,
  StoredWorkspace,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  AnnotationAuthor,
  AnnotationBody,
  AnnotationIntent,
  AnnotationStatus,
  AnnotationBlockType,
  AnnotationSelector,
  AnnotationTarget,
  AnnotationV1,
  Message,
  MessageModelSelection,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  ContextBreakdown,
  ContextUsageReading,
  RecoveryAction,
  ErrorCode,
  TypedError,
  PermissionRequest,
  AgentEvent,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Execution metrics (per-model-call latency facts)
export type {
  ExecutionStatus,
  ExecutionCoverage,
  ExecutionMeasurement,
  LlmRequestMetrics,
  AgentRunMetrics,
  MessageExecutionRef,
} from './execution-metrics.ts';
export { RUN_METRICS_SCHEMA_VERSION } from './execution-metrics.ts';

// Message persistence mappers
export { messageToStored, storedToMessage } from './message-mapper.ts';

// Server types (headless operations)
export type {
  ServerStatus,
  ServerHealth,
  SessionProcessingStatus,
  ActiveSessionInfo,
} from './server.ts';
