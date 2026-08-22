/**
 * Capability lookup for models an OpenAI-compatible endpoint advertises.
 *
 * A hand-typed model ID is absent from the Pi SDK catalog, so nothing local
 * knows its context window or whether it accepts images. Without that,
 * `buildCustomEndpointModelDef` falls back to 131k/text-only — which silently
 * caps a 1M-context model at 13% and triggers compaction almost immediately.
 *
 * Most OpenAI-compatible providers publish the missing numbers at `GET /models`.
 * The field names vary, so parsing stays deliberately tolerant: anything we
 * can't read comes back undefined and the caller keeps its own default.
 */

/** Capabilities recovered for a single model. Fields are absent when unknown. */
export interface EndpointModelMeta {
  contextWindow?: number
  supportsImages?: boolean
}

interface RawModelEntry {
  id?: unknown
  context_length?: unknown
  context_window?: unknown
  max_context_length?: unknown
  architecture?: { input_modalities?: unknown; modality?: unknown }
}

/** Largest plausible context window, to reject junk like `context_length: -1`. */
const MAX_SANE_CONTEXT_WINDOW = 20_000_000

function readContextWindow(entry: RawModelEntry): number | undefined {
  for (const raw of [entry.context_length, entry.context_window, entry.max_context_length]) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue
    const value = Math.floor(raw)
    if (value > 0 && value <= MAX_SANE_CONTEXT_WINDOW) return value
  }
  return undefined
}

function readSupportsImages(entry: RawModelEntry): boolean | undefined {
  const modalities = entry.architecture?.input_modalities
  if (Array.isArray(modalities)) {
    return modalities.some(m => typeof m === 'string' && m.toLowerCase() === 'image')
  }
  // Older OpenRouter payloads only carry the combined "text+image->text" string.
  const modality = entry.architecture?.modality
  if (typeof modality === 'string') {
    const inputs = modality.split('->')[0] ?? ''
    return inputs.toLowerCase().includes('image')
  }
  return undefined
}

/**
 * Pick one model out of a raw `/models` payload and read its capabilities.
 * Exported separately from the fetch so the parsing is testable without a server.
 */
export function parseEndpointModelMeta(payload: unknown, modelId: string): EndpointModelMeta | null {
  const data = (payload as { data?: unknown })?.data
  if (!Array.isArray(data)) return null

  // Endpoints answer with bare IDs; Bitlab may hold the same model prefixed.
  const wanted = modelId.startsWith('pi/') ? modelId.slice(3) : modelId
  const entry = data.find((m): m is RawModelEntry =>
    !!m && typeof m === 'object' && (m as RawModelEntry).id === wanted
  )
  if (!entry) return null

  const contextWindow = readContextWindow(entry)
  const supportsImages = readSupportsImages(entry)
  if (contextWindow === undefined && supportsImages === undefined) return null

  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsImages !== undefined ? { supportsImages } : {}),
  }
}

export interface FetchEndpointModelMetaArgs {
  baseUrl: string
  modelId: string
  /** Omitted for public catalogs; a masked placeholder must never be passed. */
  apiKey?: string
  timeoutMs?: number
}

/**
 * Best-effort probe. Returns null on any failure — a missing capability hint is
 * never worth failing connection setup over.
 */
export async function fetchEndpointModelMeta(
  args: FetchEndpointModelMetaArgs
): Promise<EndpointModelMeta | null> {
  const baseUrl = args.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || !args.modelId.trim()) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8000)
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {},
      signal: controller.signal,
    })
    if (!response.ok) return null
    return parseEndpointModelMeta(await response.json(), args.modelId)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
