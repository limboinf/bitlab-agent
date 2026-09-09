import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'

export type PresetKey = string

function normalizePresetUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

/** Restore a named provider from its endpoint when no explicit preset exists. */
export function resolveInitialPreset(params: {
  explicitPreset?: PresetKey
  baseUrl?: string
  presets: ReadonlyArray<{ key: PresetKey; url: string }>
  defaultPreset: PresetKey
}): PresetKey {
  if (params.explicitPreset) return params.explicitPreset
  if (!params.baseUrl) return params.defaultPreset

  const normalizedBaseUrl = normalizePresetUrl(params.baseUrl)
  const match = params.presets.find(p =>
    p.key !== 'custom' && p.url && normalizePresetUrl(p.url) === normalizedBaseUrl
  )
  return match?.key ?? 'custom'
}

/**
 * Old tier-provider saves are distinguishable from intentional Custom saves:
 * the former used three-tier mode and persisted catalog capability objects,
 * while the Custom text field persisted bare model IDs. Require both legacy
 * markers before allowing the endpoint URL to infer a provider.
 */
export function resolveEditPresetHint(params: {
  hasCustomEndpoint: boolean
  piAuthProvider?: PresetKey
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  models?: ReadonlyArray<string | object>
}): PresetKey | undefined {
  if (!params.hasCustomEndpoint) return params.piAuthProvider
  const isLegacyTierSave =
    params.modelSelectionMode === 'userDefined3Tier'
    && params.models?.some(model => typeof model !== 'string')
  return isLegacyTierSave ? undefined : 'custom'
}

/**
 * Preset keys that are regional variants of a canonical Pi auth provider.
 * The Pi SDK recognizes both 'minimax' and 'minimax-cn' as separate providers
 * with distinct base URLs (api.minimax.io vs api.minimaxi.com), so only
 * 'minimax-global' needs aliasing — 'minimax-cn' maps 1:1 to the Pi SDK provider.
 */
const PI_AUTH_PROVIDER_ALIASES: Record<string, string> = {
  'minimax-global': 'minimax',
}

export function resolvePiAuthProviderForSubmit(
  activePreset: PresetKey,
  lastNonCustomPreset: PresetKey | null
): string | undefined {
  if (activePreset === 'custom') {
    // Pi SDK needs a provider hint for auth header formatting even when
    // the URL is user-provided — default to anthropic as the safest baseline.
    const resolved = lastNonCustomPreset && lastNonCustomPreset !== 'custom'
      ? lastNonCustomPreset
      : 'anthropic'
    return PI_AUTH_PROVIDER_ALIASES[resolved] ?? resolved
  }

  return PI_AUTH_PROVIDER_ALIASES[activePreset] ?? activePreset
}

export function resolvePresetStateForBaseUrlChange(params: {
  matchedPreset: PresetKey
  activePreset: PresetKey
  activePresetHasEmptyUrl: boolean
  lastNonCustomPreset: PresetKey | null
}): { activePreset: PresetKey; lastNonCustomPreset: PresetKey | null } {
  const { matchedPreset, activePreset, activePresetHasEmptyUrl, lastNonCustomPreset } = params

  // An explicit Custom selection wins over URL sniffing. Custom is the only
  // route to the free-form model list, so a URL that happens to match a preset
  // must not drag the user back into that preset's managed tier dropdowns.
  if (activePreset === 'custom') {
    return { activePreset: 'custom', lastNonCustomPreset }
  }

  if (matchedPreset !== 'custom') {
    return {
      activePreset: matchedPreset,
      lastNonCustomPreset: matchedPreset,
    }
  }

  if (activePresetHasEmptyUrl) {
    return {
      activePreset,
      lastNonCustomPreset,
    }
  }

  return {
    activePreset: 'custom',
    lastNonCustomPreset,
  }
}

/**
 * Resolve the customEndpoint + piAuthProvider payload at submit time.
 *
 * Three submit branches:
 *  - branded openai-compat preset (e.g. Manifest)  → pinned to openai-completions
 *  - generic custom preset with a base URL         → honors the protocol toggle
 *  - everything else                               → no customEndpoint, passthrough piAuth
 */
export function resolveCustomEndpointPayload(params: {
  activePreset: PresetKey
  baseUrl: string
  customApi: CustomEndpointApi
  brandedOpenAiCompatPresets: ReadonlySet<string>
  fallbackPiAuthProvider: string | undefined
}): {
  customEndpoint: CustomEndpointConfig | undefined
  piAuthProvider: string | undefined
} {
  const { activePreset, baseUrl, customApi, brandedOpenAiCompatPresets, fallbackPiAuthProvider } = params

  const isBrandedOpenAiCompat = brandedOpenAiCompatPresets.has(activePreset) && !!baseUrl
  const isCustomEndpoint = (activePreset === 'custom' && !!baseUrl) || isBrandedOpenAiCompat
  const effectiveApi: CustomEndpointApi = isBrandedOpenAiCompat ? 'openai-completions' : customApi

  return {
    customEndpoint: isCustomEndpoint ? { api: effectiveApi } : undefined,
    piAuthProvider: isCustomEndpoint
      ? (effectiveApi === 'anthropic-messages' ? 'anthropic' : 'openai')
      : fallbackPiAuthProvider,
  }
}

/** Whether the selected provider must synthesize an unlisted model at runtime. */
export function hasUnlistedTierModel(
  tierModelIds: string[],
  catalog: ReadonlyArray<{ id: string }>
): boolean {
  const known = new Set(catalog.map(m => m.id))
  return tierModelIds.some(id => !known.has(id))
}

/** Per-model capability hints carried through connection setup. */
export interface TierSetupModel {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
}

export interface TierCatalogModel {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  reasoning?: boolean
  /** Set when the provider's live listing contributed this entry. */
  source?: 'listing'
}

/**
 * Build the models payload for the three tiers.
 *
 * A tier travels as a bare ID whenever the Pi catalog already owns the model:
 * the catalog is the authority there, and repeating it here would only let the
 * two copies drift. Everything else has to carry its own shape, or it collapses
 * to the 131k text-only default at registration time:
 *
 *  - a custom endpoint has no catalog behind it at all;
 *  - a hand-typed provider model is not in the bundled/live catalog yet;
 *  - a listing-discovered model is one the catalog has never heard of, even on
 *    a plain provider connection.
 *
 * The listing case saves what the tier dropdown showed — a real disclosure when
 * the endpoint made one, the family estimate otherwise. Either way the pick and
 * the run agree, and the catalog takes over the moment it ships the model.
 */
export function buildTierSetupModels(params: {
  tierModelIds: string[]
  catalog: ReadonlyArray<TierCatalogModel>
  customMeta: Record<string, { contextWindow?: number; supportsImages?: boolean }>
}): Array<string | TierSetupModel> {
  const { tierModelIds, catalog, customMeta } = params

  return tierModelIds.map(id => {
    const known = catalog.find(m => m.id === id)
    if (known && known.source !== 'listing') return id

    const meta = customMeta[id]
    const contextWindow = known?.contextWindow ?? meta?.contextWindow
    const supportsImages = known ? known.supportsImages : meta?.supportsImages
    const supportsThinking = known?.reasoning

    const entry: TierSetupModel = { id }
    if (contextWindow !== undefined) entry.contextWindow = contextWindow
    if (supportsImages !== undefined) entry.supportsImages = supportsImages
    if (supportsThinking !== undefined) entry.supportsThinking = supportsThinking
    return entry
  })
}
