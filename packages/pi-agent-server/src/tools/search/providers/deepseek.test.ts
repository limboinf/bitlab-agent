import { afterEach, describe, expect, it } from 'bun:test';
import { DeepSeekSearchProvider, mapAnthropicResponse } from './deepseek.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(response: Response) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    return response.clone();
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('mapAnthropicResponse', () => {
  it('pairs search results with citation snippets and de-duplicates by url', () => {
    const results = mapAnthropicResponse({
      content: [
        {
          type: 'text',
          text: 'Some prose.',
          citations: [
            { url: 'https://a.com', cited_text: 'snippet a' },
            { url: 'https://a.com', cited_text: 'later duplicate, ignored' },
          ],
        },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a.com', title: 'A' },
            { type: 'web_search_result', url: 'https://b.com', title: 'B' },
          ],
        },
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A again' }],
        },
      ],
    }, 10);

    expect(results).toEqual([
      { title: 'A', url: 'https://a.com', description: 'snippet a' },
      { title: 'B', url: 'https://b.com', description: '' },
    ]);
  });

  it('appends page_age when present and caps at count', () => {
    const results = mapAnthropicResponse({
      content: [
        { type: 'text', citations: [{ url: 'https://a.com', cited_text: 'snippet a' }] },
        {
          type: 'web_search_tool_result',
          content: [
            { type: 'web_search_result', url: 'https://a.com', title: 'A', page_age: '2 days ago' },
            { type: 'web_search_result', url: 'https://b.com', title: 'B' },
          ],
        },
      ],
    }, 1);

    expect(results).toEqual([
      { title: 'A', url: 'https://a.com', description: 'snippet a (2 days ago)' },
    ]);
  });

  it('throws when the model answered without running a search', () => {
    expect(() => mapAnthropicResponse({ content: [{ type: 'text', text: 'I think...' }] }, 5))
      .toThrow(/no web_search_tool_result block/);
  });

  it('tolerates an error-shaped tool result block', () => {
    const results = mapAnthropicResponse({
      content: [
        { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      ],
    }, 5);

    expect(results).toEqual([]);
  });
});

describe('DeepSeekSearchProvider', () => {
  it('requests the Anthropic messages endpoint with the server-side search tool', async () => {
    const calls = stubFetch(json({
      content: [
        { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.com', title: 'A' }] },
      ],
    }));

    const results = await new DeepSeekSearchProvider({ apiKey: 'ds-test' }).search('bitlab', 5);

    expect(calls[0]?.url).toBe('https://api.deepseek.com/anthropic/v1/messages');
    expect(calls[0]?.headers['x-api-key']).toBe('ds-test');
    expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');
    expect(calls[0]?.body.model).toBe('deepseek-v4-flash');
    expect(calls[0]?.body.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ]);
    expect(results).toHaveLength(1);
  });

  it('honours baseURL and model overrides', async () => {
    const calls = stubFetch(json({
      content: [{ type: 'web_search_tool_result', content: [] }],
    }));

    await new DeepSeekSearchProvider({
      apiKey: 'k',
      baseURL: 'https://proxy.test/anthropic/v1/',
      model: 'deepseek-v4-pro',
    }).search('q', 3);

    expect(calls[0]?.url).toBe('https://proxy.test/anthropic/v1/messages');
    expect(calls[0]?.body.model).toBe('deepseek-v4-pro');
  });

  it('throws on HTTP errors so the tool can fall back', async () => {
    stubFetch(new Response('bad key', { status: 401 }));

    await expect(new DeepSeekSearchProvider({ apiKey: 'k' }).search('q', 5))
      .rejects.toThrow(/DeepSeek search failed \(HTTP 401\)/);
  });
});
