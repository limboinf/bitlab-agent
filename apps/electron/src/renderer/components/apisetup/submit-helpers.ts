import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'

export type PresetKey = string

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

/**
 * Decide whether a set of tier selections forces the connection into custom
 * endpoint mode.
 *
 * A tier may hold a model ID the provider catalog doesn't know — the user typed
 * it into the tier search box. The Pi subprocess only registers unknown IDs when
 * the connection carries a `customEndpoint`; without one it throws
 * "Could not resolve model" the first time that tier is used. So one custom ID
 * pins the whole connection to the protocol the provider's own catalog models
 * already speak.
 *
 * Returns null when every tier is a known catalog model (the common case).
 */
export function resolveTierCustomEndpoint(
  tierModelIds: string[],
  catalog: ReadonlyArray<{ id: string; api?: string }>
): { customEndpoint: CustomEndpointConfig; piAuthProvider: string } | null {
  const known = new Set(catalog.map(m => m.id))
  if (tierModelIds.every(id => known.has(id))) return null

  const api: CustomEndpointApi = catalog.find(m => m.api)?.api === 'anthropic-messages'
    ? 'anthropic-messages'
    : 'openai-completions'

  return {
    customEndpoint: { api },
    piAuthProvider: api === 'anthropic-messages' ? 'anthropic' : 'openai',
  }
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
  isCustomEndpoint: boolean
}): Array<string | TierSetupModel> {
  const { tierModelIds, catalog, customMeta, isCustomEndpoint } = params

  return tierModelIds.map(id => {
    const known = catalog.find(m => m.id === id)
    if (!isCustomEndpoint && known?.source !== 'listing') return id

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
