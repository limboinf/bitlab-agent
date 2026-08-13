/**
 * Tavily search provider — a purpose-built search API for LLMs.
 *
 * Docs: https://docs.tavily.com/api-reference/endpoint/search
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.tavily.com';

export interface TavilySearchConfig {
  apiKey: string;
  /** Endpoint override without trailing slash (default: https://api.tavily.com) */
  baseURL?: string;
}

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>;
}

export class TavilySearchProvider implements WebSearchProvider {
  name = 'Tavily';

  constructor(private config: TavilySearchConfig) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const baseURL = (this.config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    const response = await fetch(`${baseURL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: count,
        include_answer: false,
        search_depth: 'advanced',
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tavily search failed (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as TavilyResponse;

    return (data.results ?? [])
      .filter((result): result is { url: string; title?: string; content?: string } => !!result.url)
      .slice(0, count)
      .map(result => ({
        title: result.title || result.url,
        url: result.url,
        description: result.content ?? '',
      }));
  }
}
