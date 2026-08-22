export interface PiModelInfo {
  id: string
  name: string
  /** Wire protocol this model speaks ('openai-completions' | 'anthropic-messages'). */
  api?: string
  /** Whether the catalog says this model accepts image input. */
  supportsImages?: boolean
  costInput: number
  costOutput: number
  contextWindow: number
  reasoning: boolean
}

/** Pick smart defaults for 3 tiers from a cost-sorted model list (expensive-first). */
export function pickTierDefaults(models: PiModelInfo[]): { best: string; default_: string; cheap: string } {
  if (models.length === 0) return { best: '', default_: '', cheap: '' }
  if (models.length === 1) return { best: models[0].id, default_: models[0].id, cheap: models[0].id }
  const best = models[0].id
  const cheap = models[models.length - 1].id
  // The list is the provider's full catalog sorted expensive-first, so ~40% in
  // lands on a capable-but-not-flagship model for the everyday tier.
  const defaultIdx = Math.min(Math.floor(models.length * 0.4), models.length - 2)
  const default_ = models[defaultIdx].id
  return { best, default_, cheap }
}

export interface ResolveTierModelsOptions {
  /**
   * Keep saved IDs the catalog doesn't know. Set for custom-endpoint
   * connections, where the user's hand-typed model IDs are legitimately absent
   * from the provider catalog and must survive a re-open of the setup form.
   */
  allowUnknownIds?: boolean
}

export function resolveTierModels(
  models: PiModelInfo[],
  savedModels?: string[],
  options?: ResolveTierModelsOptions
): { best: string; default_: string; cheap: string } {
  const defaults = pickTierDefaults(models)
  const saved = (savedModels ?? []).filter(Boolean)
  if (saved.length === 0) return defaults

  const known = new Set(models.map(m => m.id))
  const isValid = (id: string | undefined): id is string =>
    !!id && (options?.allowUnknownIds || known.has(id))

  return {
    best: isValid(saved[0]) ? saved[0] : defaults.best,
    default_: isValid(saved[1]) ? saved[1] : defaults.default_,
    cheap: isValid(saved[2]) ? saved[2] : defaults.cheap,
  }
}
