/**
 * Picks the web search provider for a `web_search` call.
 *
 * Priority:
 *   1. The provider the user picked in Settings → Plugins, when its key is present
 *   2. `auto` (the default) — derived from the LLM connection:
 *      OpenAI/OpenRouter → Responses API, Google → Gemini grounding
 *   3. DuckDuckGo — universal fallback, no API key required
 *
 * Search never hard-fails on configuration: a keyed provider without a key
 * falls back to DuckDuckGo rather than throwing.
 *
 * To add a Responses API-compatible LLM-derived provider, add a case in
 * `resolveDerivedSearchProvider`. To add a user-selectable backend, add it to
 * `SearchProviderId` (here and in @bitlab/shared/config/search) plus a case in
 * `resolveConfiguredSearchProvider`.
 */

import type { KeyedSearchProviderId, SearchConfig, WebSearchProvider } from './types.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';
import { TavilySearchProvider } from './providers/tavily.ts';
import { ExaSearchProvider } from './providers/exa.ts';
import { DeepSeekSearchProvider } from './providers/deepseek.ts';

export type SearchProviderCredential =
  | { type: 'api_key'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number };

export interface SearchProviderAuthConfig {
  provider?: string;
  credential?: SearchProviderCredential;
}

export interface ResolveSearchProviderOptions {
  /** LLM connection credentials — used by the `auto` provider. */
  piAuth?: SearchProviderAuthConfig;
  /** Explicit user selection. Absent = `auto`. */
  searchConfig?: SearchConfig;
  /**
   * Reads a provider's API key from the keys the main process already pushed
   * down. Synchronous on purpose: this subprocess never touches the credential
   * store, it only holds what was handed to it.
   */
  resolveKey?: (providerId: KeyedSearchProviderId) => string | null | undefined;
}

function getApiKey(piAuth?: SearchProviderAuthConfig): string | undefined {
  if (piAuth?.credential?.type !== 'api_key') return undefined;
  return typeof piAuth.credential.key === 'string' && piAuth.credential.key.length > 0
    ? piAuth.credential.key
    : undefined;
}

/** The historical behaviour: search backend derived from the LLM connection. */
export function resolveDerivedSearchProvider(piAuth?: SearchProviderAuthConfig): WebSearchProvider {
  const provider = piAuth?.provider;
  const apiKey = getApiKey(piAuth);

  // OpenAI with API key → standard Responses API
  if (provider === 'openai' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://api.openai.com/v1',
      apiKey,
    });
  }

  // OpenRouter → same Responses API format, different base URL
  if (provider === 'openrouter' && apiKey) {
    return new ResponsesApiSearchProvider({
      apiBase: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'openai/gpt-4o-mini',
    });
  }

  // Google → Gemini API with native Google Search grounding
  if (provider === 'google' && apiKey) {
    return new GoogleSearchProvider(apiKey);
  }

  // Vercel AI Gateway is currently not wired to provider-native search routing.
  // It intentionally falls back to DDG until we add an explicit Responses API mapping.

  // Universal fallback — no API key required
  return new DDGSearchProvider();
}

/** A user-selected keyed provider, or null when it can't be built (no key). */
function resolveConfiguredSearchProvider(
  providerId: KeyedSearchProviderId,
  searchConfig: SearchConfig | undefined,
  resolveKey: ResolveSearchProviderOptions['resolveKey'],
): WebSearchProvider | null {
  const apiKey = resolveKey?.(providerId);
  if (!apiKey) return null;

  const config = searchConfig?.providers?.[providerId];

  switch (providerId) {
    case 'tavily':
      return new TavilySearchProvider({ apiKey, baseURL: config?.baseURL });
    case 'exa':
      return new ExaSearchProvider({ apiKey, baseURL: config?.baseURL });
    case 'deepseek':
      return new DeepSeekSearchProvider({ apiKey, baseURL: config?.baseURL, model: config?.model });
  }
}

export function resolveSearchProvider(opts: ResolveSearchProviderOptions = {}): WebSearchProvider {
  const provider = opts.searchConfig?.provider ?? 'auto';

  if (provider === 'auto') return resolveDerivedSearchProvider(opts.piAuth);
  if (provider === 'duckduckgo') return new DDGSearchProvider();

  // Keyed provider — fall back to DDG when the key is missing so that a
  // half-finished setup degrades instead of breaking search entirely.
  return resolveConfiguredSearchProvider(provider, opts.searchConfig, opts.resolveKey)
    ?? new DDGSearchProvider();
}
