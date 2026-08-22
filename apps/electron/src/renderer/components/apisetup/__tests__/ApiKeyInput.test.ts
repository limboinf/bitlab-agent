import { describe, expect, it } from 'bun:test'
import {
  resolveCustomEndpointPayload,
  resolvePiAuthProviderForSubmit,
  resolvePresetStateForBaseUrlChange,
  resolveTierCustomEndpoint,
  buildTierSetupModels,
} from '../submit-helpers'
import { pickTierDefaults, resolveTierModels } from '../tier-models'

const MODELS = [
  { id: 'pi/zai-best', name: 'Best', costInput: 10, costOutput: 20, contextWindow: 200000, reasoning: true },
  { id: 'pi/zai-balanced', name: 'Balanced', costInput: 5, costOutput: 10, contextWindow: 200000, reasoning: true },
  { id: 'pi/zai-fast', name: 'Fast', costInput: 1, costOutput: 2, contextWindow: 128000, reasoning: false },
]

describe('ApiKeyInput tier hydration helpers', () => {
  it('resolveTierModels keeps saved tier selections when all are valid', () => {
    const saved = ['pi/zai-fast', 'pi/zai-balanced', 'pi/zai-best']
    const resolved = resolveTierModels(MODELS, saved)

    expect(resolved).toEqual({
      best: 'pi/zai-fast',
      default_: 'pi/zai-balanced',
      cheap: 'pi/zai-best',
    })
  })

  it('resolveTierModels preserves duplicate tiers when saved models are valid', () => {
    const saved = ['pi/zai-best', 'pi/zai-best', 'pi/zai-fast']
    const resolved = resolveTierModels(MODELS, saved)

    expect(resolved).toEqual({
      best: 'pi/zai-best',
      default_: 'pi/zai-best',
      cheap: 'pi/zai-fast',
    })
  })

  it('resolveTierModels falls back per-slot for invalid/missing saved values', () => {
    const resolved = resolveTierModels(MODELS, ['pi/zai-best', 'pi/not-real'])
    const defaults = pickTierDefaults(MODELS)

    expect(resolved).toEqual({
      best: 'pi/zai-best',
      default_: defaults.default_,
      cheap: defaults.cheap,
    })
  })
})

describe('resolvePiAuthProviderForSubmit', () => {
  it('preserves the last non-custom provider when custom endpoint mode is selected', () => {
    expect(resolvePiAuthProviderForSubmit('custom', 'openai')).toBe('openai')
  })

  it('defaults custom endpoint mode to anthropic routing when none was selected yet', () => {
    expect(resolvePiAuthProviderForSubmit('custom', null)).toBe('anthropic')
  })

  it('passes through non-custom presets unchanged', () => {
    expect(resolvePiAuthProviderForSubmit('google', 'anthropic')).toBe('google')
  })
})

describe('resolvePresetStateForBaseUrlChange', () => {
  it('keeps an explicit Custom selection even when the URL matches a known preset', () => {
    // Custom is the only route to free-form model entry, so URL sniffing must
    // not snap the user back into the preset's managed tier dropdowns.
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'openrouter',
      activePreset: 'custom',
      activePresetHasEmptyUrl: true,
      lastNonCustomPreset: 'anthropic',
    })).toEqual({
      activePreset: 'custom',
      lastNonCustomPreset: 'anthropic',
    })
  })

  it('still adopts a matched preset when the user did not pick Custom', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'openrouter',
      activePreset: 'anthropic',
      activePresetHasEmptyUrl: false,
      lastNonCustomPreset: 'anthropic',
    })).toEqual({
      activePreset: 'openrouter',
      lastNonCustomPreset: 'openrouter',
    })
  })

  it('preserves provider routing when editing a provider with an empty default URL', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'custom',
      activePreset: 'azure-openai-responses',
      activePresetHasEmptyUrl: true,
      lastNonCustomPreset: 'azure-openai-responses',
    })).toEqual({
      activePreset: 'azure-openai-responses',
      lastNonCustomPreset: 'azure-openai-responses',
    })
  })

  it('falls back to custom while keeping the most recent matched provider', () => {
    expect(resolvePresetStateForBaseUrlChange({
      matchedPreset: 'custom',
      activePreset: 'openrouter',
      activePresetHasEmptyUrl: false,
      lastNonCustomPreset: 'openrouter',
    })).toEqual({
      activePreset: 'custom',
      lastNonCustomPreset: 'openrouter',
    })
  })
})

describe('resolveCustomEndpointPayload', () => {
  const BRANDED = new Set(['manifest'])

  it('routes branded openai-compat presets through openai-completions regardless of toggle', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'manifest',
      baseUrl: 'https://app.manifest.build/v1',
      customApi: 'anthropic-messages',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: { api: 'openai-completions' },
      piAuthProvider: 'openai',
    })
  })

  it('honors the protocol toggle for the generic custom preset', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'custom',
      baseUrl: 'https://my-endpoint.example.com',
      customApi: 'anthropic-messages',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: { api: 'anthropic-messages' },
      piAuthProvider: 'anthropic',
    })
  })

  it('returns no customEndpoint for a standard preset, passing through the fallback piAuth', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      customApi: 'openai-completions',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: 'openrouter',
    })).toEqual({
      customEndpoint: undefined,
      piAuthProvider: 'openrouter',
    })
  })

  it('treats branded preset with empty URL as non-custom (no customEndpoint)', () => {
    expect(resolveCustomEndpointPayload({
      activePreset: 'manifest',
      baseUrl: '',
      customApi: 'openai-completions',
      brandedOpenAiCompatPresets: BRANDED,
      fallbackPiAuthProvider: undefined,
    })).toEqual({
      customEndpoint: undefined,
      piAuthProvider: undefined,
    })
  })
})

describe('resolveTierModels with custom endpoint hydration', () => {
  it('drops unknown saved IDs by default', () => {
    const resolved = resolveTierModels(MODELS, ['stealth/ox-alpha', 'pi/zai-balanced', 'pi/zai-fast'])

    expect(resolved.best).toBe(pickTierDefaults(MODELS).best)
  })

  it('keeps hand-typed IDs when the connection is a custom endpoint', () => {
    const resolved = resolveTierModels(
      MODELS,
      ['stealth/ox-alpha', 'pi/zai-balanced', 'pi/zai-fast'],
      { allowUnknownIds: true },
    )

    expect(resolved).toEqual({
      best: 'stealth/ox-alpha',
      default_: 'pi/zai-balanced',
      cheap: 'pi/zai-fast',
    })
  })
})

describe('resolveTierCustomEndpoint', () => {
  const OPENROUTER_CATALOG = [
    { id: 'pi/openai/gpt-5.6-terra', api: 'openai-completions' },
    { id: 'pi/google/gemini-3.5-flash', api: 'openai-completions' },
  ]

  it('returns null when every tier is a known catalog model', () => {
    expect(resolveTierCustomEndpoint(
      ['pi/openai/gpt-5.6-terra', 'pi/google/gemini-3.5-flash'],
      OPENROUTER_CATALOG,
    )).toBeNull()
  })

  it('pins the connection to the provider protocol when a tier holds an unknown ID', () => {
    expect(resolveTierCustomEndpoint(
      ['stealth/ox-alpha', 'pi/google/gemini-3.5-flash'],
      OPENROUTER_CATALOG,
    )).toEqual({
      customEndpoint: { api: 'openai-completions' },
      piAuthProvider: 'openai',
    })
  })

  it('uses anthropic-messages for providers whose catalog speaks it', () => {
    expect(resolveTierCustomEndpoint(
      ['some-unreleased-model'],
      [{ id: 'pi/claude-opus-4-8', api: 'anthropic-messages' }],
    )).toEqual({
      customEndpoint: { api: 'anthropic-messages' },
      piAuthProvider: 'anthropic',
    })
  })

  it('defaults to openai-completions when the catalog carries no protocol hint', () => {
    expect(resolveTierCustomEndpoint(['mystery-model'], [{ id: 'pi/known' }]))
      .toEqual({
        customEndpoint: { api: 'openai-completions' },
        piAuthProvider: 'openai',
      })
  })
})

describe('buildTierSetupModels', () => {
  const CATALOG = [
    { id: 'pi/openai/gpt-5.6-terra', contextWindow: 400_000, supportsImages: true, reasoning: true },
    { id: 'pi/google/gemini-3.5-flash', contextWindow: 1_000_000, supportsImages: true, reasoning: false },
  ]

  it('sends bare IDs on a plain provider connection', () => {
    // The Pi catalog is the authority there; copying it into the payload would
    // just create a second copy to drift.
    expect(buildTierSetupModels({
      tierModelIds: ['pi/openai/gpt-5.6-terra', 'pi/google/gemini-3.5-flash'],
      catalog: CATALOG,
      customMeta: {},
      isCustomEndpoint: false,
    })).toEqual(['pi/openai/gpt-5.6-terra', 'pi/google/gemini-3.5-flash'])
  })

  it('carries catalog capabilities for every tier once the connection is a custom endpoint', () => {
    // Otherwise all three collapse to buildCustomEndpointModelDef's 131k default.
    const models = buildTierSetupModels({
      tierModelIds: ['pi/openai/gpt-5.6-terra', 'stealth/ox-alpha'],
      catalog: CATALOG,
      customMeta: { 'stealth/ox-alpha': { contextWindow: 1_048_576, supportsImages: true } },
      isCustomEndpoint: true,
    })

    expect(models).toEqual([
      { id: 'pi/openai/gpt-5.6-terra', contextWindow: 400_000, supportsImages: true, supportsThinking: true },
      { id: 'stealth/ox-alpha', contextWindow: 1_048_576, supportsImages: true },
    ])
  })

  it('omits unknown capabilities instead of inventing them', () => {
    expect(buildTierSetupModels({
      tierModelIds: ['mystery-model'],
      catalog: [],
      customMeta: {},
      isCustomEndpoint: true,
    })).toEqual([{ id: 'mystery-model' }])
  })

  it('lets the catalog win over stale custom metadata for the same ID', () => {
    const models = buildTierSetupModels({
      tierModelIds: ['pi/google/gemini-3.5-flash'],
      catalog: CATALOG,
      customMeta: { 'pi/google/gemini-3.5-flash': { contextWindow: 1, supportsImages: false } },
      isCustomEndpoint: true,
    })

    expect(models).toEqual([
      { id: 'pi/google/gemini-3.5-flash', contextWindow: 1_000_000, supportsImages: true, supportsThinking: false },
    ])
  })
})
