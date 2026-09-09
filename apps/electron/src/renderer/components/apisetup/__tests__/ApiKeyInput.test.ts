import { describe, expect, it } from 'bun:test'
import {
  hasUnlistedTierModel,
  resolveCustomEndpointPayload,
  resolveEditPresetHint,
  resolveInitialPreset,
  resolvePiAuthProviderForSubmit,
  resolvePresetStateForBaseUrlChange,
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

describe('resolveInitialPreset', () => {
  const PRESETS = [
    { key: 'anthropic', url: 'https://api.anthropic.com' },
    { key: 'deepseek', url: 'https://api.deepseek.com' },
    { key: 'custom', url: '' },
  ]

  it('recovers DeepSeek from a legacy custom-endpoint URL', () => {
    expect(resolveInitialPreset({
      baseUrl: 'https://api.deepseek.com/',
      presets: PRESETS,
      defaultPreset: 'anthropic',
    })).toBe('deepseek')
  })

  it('preserves an explicit Custom selection', () => {
    expect(resolveInitialPreset({
      explicitPreset: 'custom',
      baseUrl: 'https://api.deepseek.com',
      presets: PRESETS,
      defaultPreset: 'anthropic',
    })).toBe('custom')
  })
})

describe('resolveEditPresetHint', () => {
  it('allows URL recovery for legacy tier saves carrying capability objects', () => {
    expect(resolveEditPresetHint({
      hasCustomEndpoint: true,
      piAuthProvider: 'openai',
      modelSelectionMode: 'userDefined3Tier',
      models: [{ id: 'deepseek-v4.1-flash-preview' }],
    })).toBeUndefined()
  })

  it('keeps an intentional Custom connection explicit', () => {
    expect(resolveEditPresetHint({
      hasCustomEndpoint: true,
      piAuthProvider: 'openai',
      modelSelectionMode: 'userDefined3Tier',
      models: ['deepseek-v4.1-flash-preview'],
    })).toBe('custom')
  })

  it('keeps a structured intentional Custom connection explicit outside the tier flow', () => {
    expect(resolveEditPresetHint({
      hasCustomEndpoint: true,
      piAuthProvider: 'openai',
      modelSelectionMode: 'automaticallySyncedFromProvider',
      models: [{ id: 'deepseek-v4.1-flash-preview' }],
    })).toBe('custom')
  })

  it('keeps the saved provider for ordinary provider connections', () => {
    expect(resolveEditPresetHint({
      hasCustomEndpoint: false,
      piAuthProvider: 'deepseek',
      modelSelectionMode: 'userDefined3Tier',
      models: ['deepseek-v4-pro'],
    })).toBe('deepseek')
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

describe('hasUnlistedTierModel', () => {
  const OPENROUTER_CATALOG = [
    { id: 'pi/openai/gpt-5.6-terra', api: 'openai-completions' },
    { id: 'pi/google/gemini-3.5-flash', api: 'openai-completions' },
  ]

  it('returns false when every tier is a known catalog model', () => {
    expect(hasUnlistedTierModel(
      ['pi/openai/gpt-5.6-terra', 'pi/google/gemini-3.5-flash'],
      OPENROUTER_CATALOG,
    )).toBe(false)
  })

  it('leaves a listing-discovered model on the provider connection', () => {
    // The subprocess registers it against the provider's own endpoint, so
    // there is nothing to gain by trading piAuthProvider for custom-endpoint.
    expect(hasUnlistedTierModel(
      ['pi/glm-5.3'],
      [{ id: 'pi/glm-5.2' }, { id: 'pi/glm-5.3' }],
    )).toBe(false)
  })

  it('keeps an unlisted model on the selected provider connection', () => {
    expect(hasUnlistedTierModel(
      ['stealth/ox-alpha', 'pi/google/gemini-3.5-flash'],
      OPENROUTER_CATALOG,
    )).toBe(true)
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
    })).toEqual(['pi/openai/gpt-5.6-terra', 'pi/google/gemini-3.5-flash'])
  })

  it('carries a listing-discovered model on a plain provider connection', () => {
    // The Pi catalog has never heard of it, so nothing downstream can look its
    // shape up — the pick has to travel with what the dropdown showed.
    const models = buildTierSetupModels({
      tierModelIds: ['pi/openai/gpt-5.6-terra', 'pi/glm-5.3'],
      catalog: [
        ...CATALOG,
        { id: 'pi/glm-5.3', contextWindow: 200_000, supportsImages: false, reasoning: true, source: 'listing' },
      ],
      customMeta: {},
    })

    expect(models).toEqual([
      'pi/openai/gpt-5.6-terra',
      { id: 'pi/glm-5.3', contextWindow: 200_000, supportsImages: false, supportsThinking: true },
    ])
  })

  it('carries hand-typed model capabilities without changing the provider', () => {
    expect(buildTierSetupModels({
      tierModelIds: ['deepseek-v4.1-flash-preview'],
      catalog: CATALOG,
      customMeta: {
        'deepseek-v4.1-flash-preview': { contextWindow: 200_000, supportsImages: false },
      },
    })).toEqual([
      { id: 'deepseek-v4.1-flash-preview', contextWindow: 200_000, supportsImages: false },
    ])
  })

  it('omits unknown capabilities instead of inventing them', () => {
    expect(buildTierSetupModels({
      tierModelIds: ['mystery-model'],
      catalog: [],
      customMeta: {},
    })).toEqual([{ id: 'mystery-model' }])
  })
})
