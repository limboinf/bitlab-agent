/**
 * Heuristic composition of the next request's context: system prompt, tool
 * schemas, and conversation messages.
 *
 * These three figures answer "what is the prompt made of", NOT "what does it
 * cost". They are heuristic and deliberately do NOT sum to the provider-
 * anchored total the SDK reports via `getContextUsage()` — the chars/4 density
 * systematically underprices CJK text and JSON schemas, which is exactly the
 * error the SDK's anchoring keeps out of the headline figure. Present them as
 * an approximate composition, never as a total.
 *
 * The conversation figure rides the SDK's own `estimateTokens`, the same
 * heuristic that drives its compaction decisions, so our number can never
 * disagree with the one the SDK acts on. System and tools use the same fixed
 * density so all three parts stay in one vocabulary.
 */

import { estimateTokens } from '@earendil-works/pi-agent-core';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Fixed text density, matching the SDK's message estimator. */
const CHARS_PER_TOKEN = 4;

/** Heuristic system/tools/message composition of the next request. */
export interface ContextBreakdown {
  /** Heuristic tokens of the system prompt; 0 before one is known. */
  systemTokens: number;
  /** Heuristic tokens of the active tool schemas; 0 when no tool is active. */
  toolsTokens: number;
  /** Heuristic tokens of the current model-visible conversation. */
  messageTokens: number;
}

/** The parts of a tool definition that are actually serialized into a request. */
export interface ToolWireShape {
  name: string;
  description: string;
  parameters: unknown;
}

function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Price the system prompt.
 * @param prompt - the exact system prompt string, or undefined before one is set.
 */
export function estimateSystemTokens(prompt: string | undefined): number {
  if (!prompt) return 0;
  return tokensForChars(prompt.length);
}

/**
 * Price the tool schemas as the provider sees them.
 *
 * Only the three fields that reach the wire are counted — label, prompt
 * snippets and the execute function are local-only and would inflate the
 * figure without ever costing the user a token.
 *
 * @param tools - active tool definitions.
 */
export function estimateToolsTokens(tools: readonly ToolWireShape[]): number {
  if (tools.length === 0) return 0;
  const wire = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
  return tokensForChars(JSON.stringify(wire).length);
}

/**
 * Price the model-visible conversation with the SDK's own estimator.
 * @param messages - the session's current message list.
 */
export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(message);
  }
  return tokens;
}

/**
 * Compose the full breakdown for one session.
 * @param systemPrompt - the exact system prompt in force.
 * @param tools - active tool definitions.
 * @param messages - the session's current message list.
 */
export function computeContextBreakdown(
  systemPrompt: string | undefined,
  tools: readonly ToolWireShape[],
  messages: readonly AgentMessage[],
): ContextBreakdown {
  return {
    systemTokens: estimateSystemTokens(systemPrompt),
    toolsTokens: estimateToolsTokens(tools),
    messageTokens: estimateMessageTokens(messages),
  };
}
