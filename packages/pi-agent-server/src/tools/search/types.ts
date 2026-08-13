export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchProvider {
  /** Display name shown in search results attribution (e.g. "Google", "OpenAI") */
  name: string;
  /** Execute a web search and return structured results. */
  search(query: string, count: number): Promise<WebSearchResult[]>;
}

/**
 * Search settings handed down by the main process.
 *
 * Structurally mirrors `SearchConfig` in @bitlab/shared/config — duplicated
 * rather than imported because this package deliberately has no workspace
 * dependencies (same reason `PiCredential` is redeclared in index.ts).
 */
export type KeyedSearchProviderId = 'tavily' | 'exa' | 'deepseek';
export type SearchProviderId = 'auto' | 'duckduckgo' | KeyedSearchProviderId;

export interface SearchProviderConfig {
  baseURL?: string;
  model?: string;
}

export interface SearchConfig {
  provider: SearchProviderId;
  providers: Partial<Record<KeyedSearchProviderId, SearchProviderConfig>>;
}
