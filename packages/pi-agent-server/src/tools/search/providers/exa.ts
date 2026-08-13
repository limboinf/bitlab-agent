/**
 * Exa search provider — neural/keyword search with highlight snippets.
 *
 * Docs: https://docs.exa.ai/reference/search
 *
 * Results without a highlight are dropped: Exa returns no other snippet field,
 * and inventing one from the title would misrepresent the page.
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.exa.ai';

export interface ExaSearchConfig {
  apiKey: string;
  /** Endpoint override without trailing slash (default: https://api.exa.ai) */
  baseURL?: string;
}

interface ExaResponse {
  results?: Array<{ title?: string; url?: string; highlights?: string[] }>;
}

export class ExaSearchProvider implements WebSearchProvider {
  name = 'Exa';

  constructor(private config: ExaSearchConfig) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const baseURL = (this.config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    const response = await fetch(`${baseURL}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Exa's own docs use x-api-key; proxies in front of it usually expect Bearer.
        'x-api-key': this.config.apiKey,
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: count,
        contents: { highlights: { highlightsPerUrl: 1 } },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Exa search failed (HTTP ${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as ExaResponse;

    return (data.results ?? [])
      .flatMap(result => {
        const highlight = result.highlights?.[0];
        if (!result.url || !highlight) return [];
        return [{ title: result.title || result.url, url: result.url, description: highlight }];
      })
      .slice(0, count);
  }
}
