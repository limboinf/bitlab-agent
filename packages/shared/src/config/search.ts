/**
 * Web search provider configuration.
 *
 * The active provider is chosen explicitly by the user (Settings → Plugins).
 * `auto` keeps the historical behaviour: the search backend is derived from the
 * LLM connection (OpenAI/OpenRouter → Responses API, Google → Gemini grounding,
 * anything else → DuckDuckGo).
 *
 * API keys are NEVER stored here — they live in the encrypted credential store
 * under `{ type: 'web_search_api_key', connectionSlug: <provider id> }`.
 */

/** Search provider the user can pick in settings. */
export type SearchProviderId =
  | 'auto'        // derive from the LLM connection (legacy behaviour)
  | 'duckduckgo'  // no key required
  | 'tavily'
  | 'exa'
  | 'deepseek';   // DeepSeek server-side search via the Anthropic-compatible API

/** Providers that need an API key (i.e. everything except `auto` and DDG). */
export type KeyedSearchProviderId = Exclude<SearchProviderId, 'auto' | 'duckduckgo'>;

export const KEYED_SEARCH_PROVIDER_IDS: readonly KeyedSearchProviderId[] = [
  'tavily',
  'exa',
  'deepseek',
];

export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = [
  'auto',
  'duckduckgo',
  ...KEYED_SEARCH_PROVIDER_IDS,
];

/** Non-secret per-provider overrides. */
export interface SearchProviderConfig {
  /** Endpoint override (proxies, self-hosted gateways). */
  baseURL?: string;
  /** Model override — only meaningful for `deepseek`. */
  model?: string;
}

export interface SearchConfig {
  /** Active provider. Defaults to `auto` so existing users see no change. */
  provider: SearchProviderId;
  /** Optional per-provider overrides. Keys live in the credential store. */
  providers: Partial<Record<KeyedSearchProviderId, SearchProviderConfig>>;
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  provider: 'auto',
  providers: {},
};

export function isKeyedSearchProviderId(value: string): value is KeyedSearchProviderId {
  return (KEYED_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isSearchProviderId(value: string): value is SearchProviderId {
  return (SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Normalize whatever is on disk into a usable config (drops unknown ids). */
export function normalizeSearchConfig(stored: Partial<SearchConfig> | undefined): SearchConfig {
  const provider = stored?.provider && isSearchProviderId(stored.provider)
    ? stored.provider
    : DEFAULT_SEARCH_CONFIG.provider;

  const providers: SearchConfig['providers'] = {};
  for (const [id, config] of Object.entries(stored?.providers ?? {})) {
    if (isKeyedSearchProviderId(id) && config) providers[id] = config;
  }

  return { provider, providers };
}
