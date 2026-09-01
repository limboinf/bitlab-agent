/**
 * Live model-listing discovery for provider endpoints.
 *
 * The bundled Pi SDK catalog is a snapshot: a provider that ships a new model
 * after this build stays invisible until the app updates. Most providers also
 * answer `GET {baseURL}/models` with the models they currently serve, so the
 * catalog can be augmented with that listing at runtime — new releases then
 * appear without an app update.
 *
 * Everything here is best-effort and additive: catalog entries always win
 * (they carry reasoning flags, cost, and tested metadata a listing never
 * discloses), and any failure keeps the catalog unchanged.
 *
 * No Pi SDK imports — safe from any Node-side module.
 */

import type { ModelDefinition } from './models.ts';

// ============================================
// Types
// ============================================

/** One model recovered from a provider's `GET /models` listing. */
export interface ProviderListModelEntry {
  id: string;
  /** Display name when the listing discloses one; otherwise the id. */
  name?: string;
  /** Context window in tokens when the listing discloses it. */
  contextWindow?: number;
  /** Image input capability when the listing discloses it. */
  supportsImages?: boolean;
}

/** How the listing endpoint authenticates — mirrors the provider's wire protocol. */
export type ProviderListingAuthStyle = 'bearer' | 'anthropic';

export interface FetchProviderModelListingArgs {
  baseUrl: string;
  /** Omitted to probe unauthenticated (some catalogs allow it). */
  apiKey?: string;
  /** Header scheme for the request. Defaults to OpenAI-style bearer. */
  authStyle?: ProviderListingAuthStyle;
  timeoutMs?: number;
}

// ============================================
// Parsing
// ============================================

interface RawListingEntry {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  context_length?: unknown;
  context_window?: unknown;
  max_context_length?: unknown;
  architecture?: { input_modalities?: unknown; modality?: unknown };
}

/** Largest plausible context window, to reject junk like `context_length: -1`. */
const MAX_SANE_CONTEXT_WINDOW = 20_000_000;

/**
 * Model ids that can never serve a chat session (embeddings, rerankers, TTS,
 * transcription). A listing advertises everything the account may call, so
 * without this filter they would pollute the model picker.
 */
const NON_CHAT_MODEL_ID = /(^|[-_.])(embed|embedding|rerank|reranker|guard|moderation)([-_.]|$)|whisper|(^|[-_.])tts([-_.]|$)|^bge-/i;

/** Whether a listed model id is chat-capable enough to offer in pickers. */
export function isChatModelId(id: string): boolean {
  return !NON_CHAT_MODEL_ID.test(id);
}

function positiveInt(...candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0 && candidate <= MAX_SANE_CONTEXT_WINDOW) {
      return candidate;
    }
  }
  return undefined;
}

function nonEmptyString(...candidates: readonly unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

function readSupportsImages(entry: RawListingEntry): boolean | undefined {
  const modalities = entry.architecture?.input_modalities;
  if (Array.isArray(modalities)) {
    return modalities.some(m => typeof m === 'string' && m.toLowerCase() === 'image');
  }
  // Older OpenRouter payloads only carry the combined "text+image->text" string.
  const modality = entry.architecture?.modality;
  if (typeof modality === 'string') {
    return modality.split('->')[0]?.toLowerCase().includes('image') ?? false;
  }
  return undefined;
}

/**
 * Read one OpenAI-compatible listing reply (`{ data: [...] }`). Entries without
 * a usable id are skipped rather than failing the whole parse: one malformed
 * row should not deny the user the rest of a working endpoint's catalog.
 * Returns null when the payload is not a listing at all.
 *
 * Exported separately from the fetch so parsing is testable without a server.
 */
export function parseProviderModelListing(payload: unknown): ProviderListModelEntry[] | null {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;

  const models: ProviderListModelEntry[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    const entry = raw as RawListingEntry | null;
    if (!entry) continue;
    const id = nonEmptyString(entry.id);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const name = nonEmptyString(entry.name, entry.display_name);
    const contextWindow = positiveInt(entry.context_window, entry.context_length, entry.max_context_length);
    const supportsImages = readSupportsImages(entry);
    models.push({
      id,
      ...(name === id ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(supportsImages === undefined ? {} : { supportsImages }),
    });
  }
  return models;
}

// ============================================
// Fetch
// ============================================

/**
 * Best-effort probe of one provider's model listing. Returns the chat-capable
 * entries the endpoint currently advertises, or null on any failure — a missing
 * listing must never fail model discovery over the catalog alone.
 */
export async function fetchProviderModelListing(
  args: FetchProviderModelListingArgs,
): Promise<ProviderListModelEntry[] | null> {
  const baseUrl = args.baseUrl.trim().replace(/\/+$/, '');
  if (!baseUrl) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 8000);
  try {
    const apiKey = args.apiKey?.trim() || undefined;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) {
      if (args.authStyle === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.authorization = `Bearer ${apiKey}`;
      }
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const listing = parseProviderModelListing(await response.json());
    if (listing === null) return null;
    return listing.filter(entry => isChatModelId(entry.id));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================
// Family defaults
// ============================================

/** Fallback when nothing — catalog, listing or family — knows better. */
export const DEFAULT_CONTEXT_WINDOW = 131_072;

/** The capabilities one catalog model discloses, as this module reads them. */
export interface FamilyModelShape {
  contextWindow?: number;
  maxTokens?: number;
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

/** Capability guesses for a model the catalog has never heard of. */
export interface FamilyModelDefaults {
  contextWindow: number;
  /** Unset when no sibling discloses one — the caller keeps its own default. */
  maxTokens?: number;
  /** Only set where the whole family agrees; unset means "don't assert". */
  supportsImages?: boolean;
  supportsThinking?: boolean;
}

/**
 * The most frequent value, ties broken toward the smaller one.
 *
 * Smaller is the safer miss for a context window: an underestimate compacts
 * earlier than it had to, an overestimate lets a turn grow until the provider
 * rejects it outright.
 */
function mostCommon(values: readonly (number | undefined)[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) {
    if (typeof value === 'number' && value > 0) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== undefined && value < best)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Infer what a provider "typically" ships from the models it does disclose.
 *
 * Most `/models` listings — z.ai's and DeepSeek's included — return bare ids
 * and nothing else, so a newly released model arrives with no capabilities at
 * all. Its siblings are the only evidence available, and they are good
 * evidence: providers ship families, not one-offs. Taking the family's typical
 * context window beats a flat constant that is wrong by an order of magnitude
 * (z.ai's GLM family runs 200K–1M, not 128K).
 *
 * Capability flags are only asserted where the whole family agrees, so a mixed
 * catalog leaves them unset rather than guessing.
 */
export function inferFamilyModelDefaults(family: readonly FamilyModelShape[]): FamilyModelDefaults {
  return {
    contextWindow: mostCommon(family.map(model => model.contextWindow)) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: mostCommon(family.map(model => model.maxTokens)),
    // A listing cannot disclose reasoning. Providers whose entire catalog is
    // reasoning models (z.ai's GLM family, ...) ship reasoning new releases
    // too — and for them the conservative default is the wrong guess: z.ai
    // thinks BY DEFAULT when a request omits the thinking parameter, so an
    // unflagged model could never be told to stop thinking.
    ...(family.length > 0 && family.every(model => model.supportsThinking !== false)
      ? { supportsThinking: true }
      : {}),
    ...(family.length > 0 && family.every(model => model.supportsImages === true)
      ? { supportsImages: true }
      : {}),
  };
}

// ============================================
// Merge
// ============================================

function shortDisplayName(name: string): string {
  const lastPart = name.split(/[\s-]/).pop() ?? name;
  return name.length > 20 ? lastPart : name;
}

/**
 * Union of the bundled catalog and a live listing, keyed by bare model id
 * (catalog ids carry the `pi/` prefix, listing ids don't). Catalog entries win
 * field-for-field; listing-only entries — models released after this build —
 * are appended so they surface in pickers without an app update.
 */
export function mergeCatalogModelsWithListing(
  catalog: readonly ModelDefinition[],
  listing: readonly ProviderListModelEntry[],
): ModelDefinition[] {
  // Most listings disclose nothing beyond the id, so the catalog siblings
  // stand in for what the entry doesn't say.
  const family = inferFamilyModelDefaults(catalog);
  const known = new Set(catalog.map(m => (m.id.startsWith('pi/') ? m.id.slice(3) : m.id)));
  const additions: ModelDefinition[] = [];
  for (const entry of listing) {
    if (known.has(entry.id)) continue;
    const name = entry.name ?? entry.id;
    const supportsImages = entry.supportsImages ?? family.supportsImages;
    additions.push({
      id: `pi/${entry.id}`,
      name,
      shortName: shortDisplayName(name),
      description: 'Discovered from the provider model listing',
      provider: 'pi',
      contextWindow: entry.contextWindow ?? family.contextWindow,
      ...(family.supportsThinking ? { supportsThinking: true } : {}),
      ...(supportsImages === undefined ? {} : { supportsImages }),
    });
  }
  return additions.length === 0 ? [...catalog] : [...catalog, ...additions];
}
