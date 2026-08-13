import { describe, expect, it } from 'bun:test';
import { resolveSearchProvider, resolveDerivedSearchProvider } from './resolve-provider.ts';
import { ResponsesApiSearchProvider } from './providers/openai.ts';
import { GoogleSearchProvider } from './providers/google.ts';
import { DDGSearchProvider } from './providers/ddg.ts';
import { TavilySearchProvider } from './providers/tavily.ts';
import { ExaSearchProvider } from './providers/exa.ts';
import { DeepSeekSearchProvider } from './providers/deepseek.ts';
import type { SearchConfig } from './types.ts';

const config = (provider: SearchConfig['provider'], providers: SearchConfig['providers'] = {}): SearchConfig =>
  ({ provider, providers });

describe('resolveDerivedSearchProvider (auto)', () => {
  it('selects ResponsesApiSearchProvider for OpenAI API keys', () => {
    const provider = resolveDerivedSearchProvider({
      provider: 'openai',
      credential: { type: 'api_key', key: 'sk-test' },
    });
    expect(provider).toBeInstanceOf(ResponsesApiSearchProvider);
    expect(provider.name).toBe('OpenAI');
  });

  it('selects ResponsesApiSearchProvider for OpenRouter API keys', () => {
    const provider = resolveDerivedSearchProvider({
      provider: 'openrouter',
      credential: { type: 'api_key', key: 'sk-or-test' },
    });
    expect(provider).toBeInstanceOf(ResponsesApiSearchProvider);
    expect(provider.name).toBe('OpenRouter');
  });

  it('selects Google search for Google API keys', () => {
    expect(resolveDerivedSearchProvider({
      provider: 'google',
      credential: { type: 'api_key', key: 'g-test' },
    })).toBeInstanceOf(GoogleSearchProvider);
  });

  it('falls back to DuckDuckGo for unknown providers', () => {
    expect(resolveDerivedSearchProvider({
      provider: 'unknown',
      credential: { type: 'api_key', key: 'x' },
    })).toBeInstanceOf(DDGSearchProvider);
  });

  it('falls back to DuckDuckGo for empty or absent credentials', () => {
    expect(resolveDerivedSearchProvider({
      provider: 'openai',
      credential: { type: 'api_key', key: '' },
    })).toBeInstanceOf(DDGSearchProvider);
    expect(resolveDerivedSearchProvider()).toBeInstanceOf(DDGSearchProvider);
  });
});

describe('resolveSearchProvider', () => {
  it('derives from the LLM connection when no search config is set', () => {
    const provider = resolveSearchProvider({
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'sk-test' } },
    });
    expect(provider).toBeInstanceOf(ResponsesApiSearchProvider);
  });

  it('derives from the LLM connection for provider="auto"', () => {
    const provider = resolveSearchProvider({
      piAuth: { provider: 'google', credential: { type: 'api_key', key: 'g-test' } },
      searchConfig: config('auto'),
    });
    expect(provider).toBeInstanceOf(GoogleSearchProvider);
  });

  it('honours an explicit duckduckgo selection over the LLM connection', () => {
    const provider = resolveSearchProvider({
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'sk-test' } },
      searchConfig: config('duckduckgo'),
    });
    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('builds keyed providers when a key was pushed down', () => {
    const resolveKey = () => 'key-1';
    expect(resolveSearchProvider({ searchConfig: config('tavily'), resolveKey }))
      .toBeInstanceOf(TavilySearchProvider);
    expect(resolveSearchProvider({ searchConfig: config('exa'), resolveKey }))
      .toBeInstanceOf(ExaSearchProvider);
    expect(resolveSearchProvider({ searchConfig: config('deepseek'), resolveKey }))
      .toBeInstanceOf(DeepSeekSearchProvider);
  });

  it('falls back to DuckDuckGo when the selected provider has no key', () => {
    expect(resolveSearchProvider({ searchConfig: config('tavily') }))
      .toBeInstanceOf(DDGSearchProvider);
    expect(resolveSearchProvider({ searchConfig: config('exa'), resolveKey: () => '' }))
      .toBeInstanceOf(DDGSearchProvider);
  });

  it('does not fall back to the LLM-derived provider when a keyed provider lacks its key', () => {
    const provider = resolveSearchProvider({
      piAuth: { provider: 'openai', credential: { type: 'api_key', key: 'sk-test' } },
      searchConfig: config('tavily'),
    });
    expect(provider).toBeInstanceOf(DDGSearchProvider);
  });

  it('passes per-provider overrides through', () => {
    const provider = resolveSearchProvider({
      searchConfig: config('deepseek', { deepseek: { baseURL: 'https://proxy.test/v1', model: 'deepseek-v4-pro' } }),
      resolveKey: () => 'key-1',
    }) as DeepSeekSearchProvider;
    expect(provider.name).toBe('DeepSeek');
    expect((provider as unknown as { config: { baseURL: string; model: string } }).config)
      .toMatchObject({ baseURL: 'https://proxy.test/v1', model: 'deepseek-v4-pro' });
  });
});
