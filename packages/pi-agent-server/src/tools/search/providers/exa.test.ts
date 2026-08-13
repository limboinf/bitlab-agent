import { afterEach, describe, expect, it } from 'bun:test';
import { ExaSearchProvider } from './exa.ts';

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

describe('ExaSearchProvider', () => {
  it('maps highlights into descriptions and passes numResults through', async () => {
    const calls = stubFetch(json({
      results: [
        { title: 'A', url: 'https://a.com', highlights: ['highlight a', 'second'] },
        { title: 'B', url: 'https://b.com', highlights: ['highlight b'] },
      ],
    }));

    const results = await new ExaSearchProvider({ apiKey: 'exa-test' }).search('bitlab', 4);

    expect(calls[0]?.url).toBe('https://api.exa.ai/search');
    expect(calls[0]?.headers['x-api-key']).toBe('exa-test');
    expect(calls[0]?.body).toMatchObject({ query: 'bitlab', numResults: 4, type: 'auto' });
    expect(results).toEqual([
      { title: 'A', url: 'https://a.com', description: 'highlight a' },
      { title: 'B', url: 'https://b.com', description: 'highlight b' },
    ]);
  });

  it('drops results without a highlight rather than inventing a snippet', async () => {
    stubFetch(json({
      results: [
        { title: 'no highlight', url: 'https://a.com' },
        { title: 'empty highlights', url: 'https://b.com', highlights: [] },
        { title: 'ok', url: 'https://c.com', highlights: ['snippet'] },
      ],
    }));

    const results = await new ExaSearchProvider({ apiKey: 'k' }).search('q', 5);

    expect(results).toEqual([{ title: 'ok', url: 'https://c.com', description: 'snippet' }]);
  });

  it('throws on HTTP errors so the tool can fall back', async () => {
    stubFetch(new Response('nope', { status: 500 }));

    await expect(new ExaSearchProvider({ apiKey: 'k' }).search('q', 5))
      .rejects.toThrow(/Exa search failed \(HTTP 500\)/);
  });
});
