/**
 * Chat component exports for @bitlab/ui
 */

// Turn utilities (pure functions, no React)
export * from './turn-utils'
export * from './follow-up-helpers'
export * from './mcp-activity'
export * from './task-list-utils'
export * from './produced-files-utils'
export * from './media-utils'

// Components
export { TurnCard, ResponseCard, SIZE_CONFIG, ActivityStatusIcon, type TurnCardProps, type ResponseCardProps, type ActivityItem, type ActivityStatus, type ResponseContent, type TodoItem } from './TurnCard'
export { TaskList, TaskRow, TaskStatusIcon, type TaskListProps } from './TaskList'
export { InlineExecution, mapToolEventToActivity, type InlineExecutionProps, type InlineExecutionStatus, type InlineActivityItem } from './InlineExecution'
export { TurnCardActionsMenu, type TurnCardActionsMenuProps } from './TurnCardActionsMenu'
export { TurnTimingDetails, type TurnTimingDetailsProps } from './TurnTimingDetails'
export { formatMetricDuration, formatTokensPerSecond, formatCount, type FormattedDuration } from './timing-format'
export { UserMessageBubble, type UserMessageBubbleProps } from './UserMessageBubble'
export { ProducedFilesRow, MAX_PRODUCED_CHIPS, type ProducedFile, type ProducedFilesRowProps } from './ProducedFilesRow'
export { MessageMediaPreview, MAX_MEDIA_TILES, type MessageMediaPreviewProps } from './MessageMediaPreview'
export * from './media'
export { SystemMessage, type SystemMessageProps, type SystemMessageType } from './SystemMessage'

// Attachment helpers
export { FileTypeIcon, getFileTypeLabel, type FileTypeIconProps } from './attachment-helpers'

// Accept plan dropdown (for plan cards)
export { AcceptPlanDropdown } from './AcceptPlanDropdown'
