import type { ContextUsageReading } from '@bitlab/core'

/**
 * Assemble the context meter's reading from whichever halves are available.
 *
 * A reading looks atomic but its two halves have different lifetimes, and that
 * mismatch is the whole reason this function exists. Occupancy measures
 * persisted history, so it survives a restart. Composition describes the prompt
 * an agent is currently assembling — system prompt plus the tool definitions of
 * connected MCP servers — and simply does not exist between runs.
 *
 * Binding them together would mean either withholding occupancy until an agent
 * boots (the meter disappears on a reopened session) or persisting a stale
 * composition (a number that quietly stops being true). Keeping them separate
 * costs one optional field and avoids both.
 */
export function resolveContextUsage(args: {
  /** Reading from a running agent, authoritative whenever it exists. */
  live: ContextUsageReading | undefined
  /** Last measured occupancy, persisted alongside the session. */
  contextTokens: number
  /** Window resolved from current config, or the last one reported. */
  contextWindow: number | undefined
}): ContextUsageReading | undefined {
  if (args.live) return args.live

  // Nothing measured yet. Reporting zero would look authoritative while being
  // badly wrong: a first request already carries a system prompt and every tool
  // definition, which is tens of thousands of tokens before the user types.
  if (!args.contextTokens || !args.contextWindow) return undefined

  return {
    tokens: args.contextTokens,
    contextWindow: args.contextWindow,
    percent: (args.contextTokens / args.contextWindow) * 100,
  }
}
