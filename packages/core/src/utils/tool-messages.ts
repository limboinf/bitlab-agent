import type { Message } from '../types/message.ts';

/**
 * Tool message lookup by call id.
 *
 * `toolUseId` is only unique *per call* for well-behaved providers. Many
 * OpenAI-compatible endpoints restart their numbering on every assistant
 * message, so `call_1` from round 2 collides with `call_1` from round 1.
 * Matching the first message with that id then overwrites the earlier call and
 * the transcript keeps only the last round of tools.
 *
 * So a tool message's identity is one *occurrence*, not one id: a repeated id
 * starts a new occurrence instead of replacing the finished one, and every
 * lookup below scans backwards to reach the most recent occurrence first.
 */

/**
 * A tool call that already produced a result. Backgrounded tools count as
 * finished here — their result arrived and later progress reaches them through
 * `findLatestToolMessageIndex`.
 */
export function isToolMessageFinished(message: Message): boolean {
  return message.toolStatus === 'completed'
    || message.toolStatus === 'error'
    || message.toolResult !== undefined;
}

/**
 * A stub created by a `tool_result` that arrived without a preceding
 * `tool_start` (normal for background subagent child tools). It is finished but
 * still missing the input/intent/display metadata, so a late `tool_start` should
 * fill it in rather than open a second occurrence.
 */
function isAwaitingToolStart(message: Message): boolean {
  return message.toolInput === undefined;
}

function findLastIndexById(
  messages: Message[],
  toolUseId: string | undefined,
  matches: (message: Message) => boolean,
): number {
  if (!toolUseId) return -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.toolUseId !== toolUseId) continue;
    return matches(message) ? i : -1;
  }
  return -1;
}

/**
 * Index of the message a `tool_start` should update, or -1 to create one.
 *
 * The SDK sends two `tool_start` events per call (empty input, then complete
 * input) and both land on the same in-flight message. A finished call only
 * matches while it is still a result-only stub.
 */
export function findToolStartTargetIndex(messages: Message[], toolUseId: string | undefined): number {
  return findLastIndexById(
    messages,
    toolUseId,
    message => !isToolMessageFinished(message) || isAwaitingToolStart(message),
  );
}

/**
 * Index of the message a `tool_result` should complete, or -1 to create one.
 * Only the call in flight matches — a repeated id must not overwrite the result
 * of an earlier, already-finished call.
 */
export function findOpenToolMessageIndex(messages: Message[], toolUseId: string | undefined): number {
  return findLastIndexById(messages, toolUseId, message => !isToolMessageFinished(message));
}

/**
 * Index of the most recent message for `toolUseId` regardless of status, or -1.
 * Used by lifecycle updates that arrive after the result (task_backgrounded,
 * shell_backgrounded, task_progress).
 */
export function findLatestToolMessageIndex(messages: Message[], toolUseId: string | undefined): number {
  return findLastIndexById(messages, toolUseId, () => true);
}
