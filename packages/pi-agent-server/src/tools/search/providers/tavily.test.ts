import { afterEach, describe, expect, it } from 'bun:test';
import { TavilySearchProvider } from './tavily.ts';

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

describe('TavilySearchProvider', () => {
  it('maps results and sends the expected request', async () => {
    const calls = stubFetch(json({
      results: [
        { title: 'A', url: 'https://a.com', content: 'snippet a' },
        { title: 'B', url: 'https://b.com', content: 'snippet b' },
      ],
    }));

    const results = await new TavilySearchProvider({ apiKey: 'tvly-test' }).search('bitlab', 5);

    expect(calls[0]?.url).toBe('https://api.tavily.com/search');
    expect(calls[0]?.headers.Authorization).toBe('Bearer tvly-test');
    expect(calls[0]?.body).toMatchObject({ query: 'bitlab', max_results: 5, include_answer: false });
    expect(results).toEqual([
      { title: 'A', url: 'https://a.com', description: 'snippet a' },
      { title: 'B', url: 'https://b.com', description: 'snippet b' },
    ]);
  });

  it('drops entries without a url and caps at count', async () => {
    stubFetch(json({
      results: [
        { title: 'no url', content: 'x' },
        { title: 'A', url: 'https://a.com' },
        { title: 'B', url: 'https://b.com', content: 'b' },
      ],
    }));

    const results = await new TavilySearchProvider({ apiKey: 'k' }).search('q', 1);

    expect(results).toEqual([{ title: 'A', url: 'https://a.com', description: '' }]);
  });

  it('honours a baseURL override and strips trailing slashes', async () => {
    const calls = stubFetch(json({ results: [] }));

    const results = await new TavilySearchProvider({ apiKey: 'k', baseURL: 'https://proxy.test/' }).search('q', 3);

    expect(calls[0]?.url).toBe('https://proxy.test/search');
    expect(results).toEqual([]);
  });

  it('throws on HTTP errors so the tool can fall back', async () => {
    stubFetch(new Response('unauthorized', { status: 401 }));

    await expect(new TavilySearchProvider({ apiKey: 'bad' }).search('q', 5))
      .rejects.toThrow(/Tavily search failed \(HTTP 401\)/);
  });
});
