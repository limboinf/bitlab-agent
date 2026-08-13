/**
 * Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k").
 * Shared by the desktop model dropdown and the compact (drawer) model picker.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(tokens >= 10000 ? 0 : 1)}k`
  }
  return tokens.toString()
}

/**
 * Strip the "pi/" prefix from model IDs/display names so the user sees a
 * provider-agnostic label in the picker (e.g., "pi/claude-opus" → "claude-opus").
 */
export function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

/**
 * Drop duplicate model entries by id, keeping the first occurrence.
 * A connection's model list can legitimately contain the same id twice when a
 * provider exposes fewer models than the setup wizard's tiers (best/balanced/fast),
 * which would otherwise render duplicate — and duplicately checked — picker rows.
 */
export function dedupeModelsById<T extends string | { id: string }>(models: readonly T[]): T[] {
  const seen = new Set<string>()
  return models.filter(model => {
    const id = typeof model === 'string' ? model : model.id
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
