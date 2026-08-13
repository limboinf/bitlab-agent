/**
 * DeepSeek-native search provider.
 *
 * Unlike Tavily/Exa this is not a search API: it spends a DeepSeek model turn
 * running DeepSeek's server-side `web_search_20250305` tool through the
 * Anthropic-compatible Messages endpoint, then harvests the tool result blocks.
 * Each search therefore costs a model call — slower and pricier than a plain
 * search API, which is why the settings UI says so.
 *
 * Docs: https://api-docs.deepseek.com/guides/anthropic_api
 */

import type { WebSearchProvider, WebSearchResult } from '../types.ts';

const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_MAX_USES = 5;
const MAX_TOKENS = 4096;

export interface DeepSeekSearchConfig {
  apiKey: string;
  /** Endpoint override without trailing slash (default: DeepSeek Anthropic API). */
  baseURL?: string;
  /** Model that runs the search turn (default: deepseek-v4-flash). */
  model?: string;
  /** Max server-side search invocations per call (default: 5). */
  maxUses?: number;
}

/** Wire types — only the fields this provider reads. */
interface WebSearchResultItem {
  type: 'web_search_result';
  url?: string;
  title?: string;
  page_age?: string;
}

interface WebSearchToolResultBlock {
  type: 'web_search_tool_result';
  content?: WebSearchResultItem[] | { type: string; error_code?: string };
}

interface TextBlock {
  type: 'text';
  text?: string;
  citations?: Array<{ url?: string; cited_text?: string }>;
}

type ContentBlock = WebSearchToolResultBlock | TextBlock | { type: string };

interface AnthropicResponse {
  content?: ContentBlock[];
}

/** url → snippet, taken from the citations attached to the assistant's prose. */
function citationSnippets(blocks: ContentBlock[]): Map<string, string> {
  const snippets = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const citation of (block as TextBlock).citations ?? []) {
      const { url, cited_text: citedText } = citation;
      if (!url || !citedText || snippets.has(url)) continue;
      snippets.set(url, citedText);
    }
  }
  return snippets;
}

export function mapAnthropicResponse(data: AnthropicResponse, count: number): WebSearchResult[] {
  const blocks = data.content ?? [];
  const toolResults = blocks.filter(
    (block): block is WebSearchToolResultBlock => block.type === 'web_search_tool_result',
  );

  if (toolResults.length === 0) {
    throw new Error('DeepSeek search returned no web_search_tool_result block');
  }

  const snippets = citationSnippets(blocks);
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();

  for (const toolResult of toolResults) {
    if (!Array.isArray(toolResult.content)) continue;
    for (const item of toolResult.content) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const snippet = snippets.get(item.url) ?? '';
      results.push({
        title: item.title || item.url,
        url: item.url,
        description: item.page_age ? `${snippet} (${item.page_age})`.trim() : snippet,
      });
      if (results.length >= count) return results;
    }
  }

  return results;
}

export class DeepSeekSearchProvider implements WebSearchProvider {
  name = 'DeepSeek';

  constructor(private config: DeepSeekSearchConfig) {}

  async search(query: string, count: number): Promise<WebSearchResult[]> {
    const baseURL = (this.config.baseURL || DEFAULT_BASE_URL).replace(/\/+$/, '');

    const response = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Native DeepSeek expects x-api-key; Bearer keeps proxies happy.
        'x-api-key': this.config.apiKey,
        Authorization: `Bearer ${this.config.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model || DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }],
          },
        ],
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
            max_uses: this.config.maxUses ?? DEFAULT_MAX_USES,
          },
        ],
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek search failed (HTTP ${response.status}): ${errorText}`);
    }

    return mapAnthropicResponse((await response.json()) as AnthropicResponse, count);
  }
}
