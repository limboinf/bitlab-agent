export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
  supportsThinking?: boolean
  /** Endpoint-wide window when the model itself declares none. */
  contextWindow?: number
  /** Endpoint-wide output cap when the model itself declares none. */
  maxTokens?: number
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
 * z.ai-family endpoints (api.z.ai, open.bigmodel.cn). pi-ai's own compat
 * auto-detection keys off these hosts too (`detectCompat` in
 * openai-completions: `thinkingFormat: "zai"`), which is what makes the zai
 * thinking parameter reach the wire for synthetic models — no explicit compat
 * is needed here. What detection cannot decide is `reasoning`: z.ai models
 * think BY DEFAULT when a request omits `thinking`, so an unflagged synthetic
 * model could never be told to stop thinking. Hence the flipped default.
 */
export function isZaiEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'z.ai' || host.endsWith('.z.ai')
      || host === 'bigmodel.cn' || host.endsWith('.bigmodel.cn')
  } catch {
    return false
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
 * reject the whole request — except on z.ai endpoints, where models think by
 * default when the parameter is omitted, so there the default flips to on.
 * Note that pi parses a reasoning response (`reasoning_content` and friends)
 * regardless of this flag — turning it on asks for reasoning, it isn't what
 * allows reasoning to render.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
  options?: {
    /** Reasoning default when neither overrides nor defaults say. */
    defaultReasoning?: boolean
  },
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']
  const reasoning = overrides?.supportsThinking ?? defaults?.supportsThinking ?? options?.defaultReasoning ?? false

  return {
    id,
    name: id,
    reasoning,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? defaults?.contextWindow ?? 131_072,
    // 8K is the floor a nameless endpoint is assumed to honour. A model whose
    // family is known can say more: capping a 128K-output model at 8K truncates
    // long answers with no error to explain it.
    maxTokens: defaults?.maxTokens ?? 8_192,
  }
}
