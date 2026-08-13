export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
  supportsThinking?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
  supportsThinking?: boolean
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
    ...(model.supportsThinking !== undefined ? { supportsThinking: model.supportsThinking } : {}),
  }
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. Image and reasoning support
 * must be explicitly enabled either at the connection level or per-model.
 *
 * `reasoning` drives what pi sends: with it on, the request carries a
 * reasoning-effort parameter derived from the session's thinking level.
 * It defaults to off because endpoints that don't understand that parameter
 * reject the whole request. Note that pi parses a reasoning response
 * (`reasoning_content` and friends) regardless of this flag — turning it on
 * asks for reasoning, it isn't what allows reasoning to render.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']
  const reasoning = overrides?.supportsThinking ?? defaults?.supportsThinking ?? false

  return {
    id,
    name: id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131_072,
    maxTokens: 8_192,
  }
}
