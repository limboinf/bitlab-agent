import { describe, expect, it } from 'bun:test'
import {
  validateSetupTestInput,
  isLoopbackBaseUrl,
  setupTestRequiresApiKey,
  resolveCustomEndpointSetup,
  createBuiltInConnection,
  BUILT_IN_CONNECTION_TEMPLATES,
  toStoredModels,
} from './connection-setup-logic'

describe('validateSetupTestInput', () => {
  it('rejects pi custom endpoint tests without piAuthProvider', () => {
    const result = validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
    })

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('requires selecting a provider preset')
    }
  })

  it('allows pi custom endpoint tests with piAuthProvider', () => {
    expect(validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
      piAuthProvider: 'openai',
    })).toEqual({ valid: true })
  })
})

describe('setup test API key requirements', () => {
  it('detects loopback base URLs', () => {
    expect(isLoopbackBaseUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('http://[::1]:11434/v1')).toBe(true)
    expect(isLoopbackBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('requires API key for non-loopback setup tests', () => {
    expect(setupTestRequiresApiKey('https://api.anthropic.com')).toBe(true)
    expect(setupTestRequiresApiKey('https://example.com/v1')).toBe(true)
  })

  it('allows keyless setup tests for loopback endpoints', () => {
    expect(setupTestRequiresApiKey('http://localhost:11434/v1')).toBe(false)
    expect(setupTestRequiresApiKey('http://127.0.0.1:11434/v1')).toBe(false)
  })
})

describe('resolveCustomEndpointSetup', () => {
  it('treats loopback URL with no credential as keyless local model', () => {
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://localhost:11434/v1',
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'none', name: 'Local Model' })
    expect(result.piAuthProvider).toBeUndefined()
  })

  it('treats loopback URL *with* a credential as a keyed custom endpoint (#636)', () => {
    // Real-world case: vLLM, LiteLLM, or any local OpenAI-compat server with --api-key.
    // Without piAuthProvider, getPiAuth() returns null at runtime → 401 on every chat request.
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://127.0.0.1:11111/v1',
      credential: 'sk-local-test',
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', name: 'OpenAI', piAuthProvider: 'openai' })
  })

  it('uses the anthropic provider hint for anthropic-messages protocol', () => {
    const result = resolveCustomEndpointSetup({
      baseUrl: 'http://127.0.0.1:8080',
      credential: 'sk-ant-local',
      customEndpointApi: 'anthropic-messages',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', name: 'Anthropic', piAuthProvider: 'anthropic' })
  })

  it('treats remote endpoints with a credential as keyed custom endpoints', () => {
    expect(resolveCustomEndpointSetup({
      baseUrl: 'https://api.example.com/v1',
      credential: 'sk-remote',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', name: 'OpenAI', piAuthProvider: 'openai' })
  })

  it('treats remote endpoints without a credential as keyed (still requires a key)', () => {
    // Non-loopback URLs are never assumed keyless, even if credential is missing —
    // setup validation handles "missing key" separately. We still set piAuthProvider
    // so the saved connection has a useful icon.
    expect(resolveCustomEndpointSetup({
      baseUrl: 'https://api.example.com/v1',
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', name: 'OpenAI', piAuthProvider: 'openai' })
  })

  it('treats undefined baseUrl as a non-loopback (keyed) endpoint', () => {
    expect(resolveCustomEndpointSetup({
      baseUrl: undefined,
      credential: 'sk-anything',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', name: 'OpenAI', piAuthProvider: 'openai' })
  })
})

// New connections must persist a per-provider midStreamBehavior default so the
// per-connection submenu in Settings → AI shows a checkmark on the right item
// out of the box (no read-time fallback needed for fresh connections).
describe('createBuiltInConnection seeds midStreamBehavior', () => {
  it('keeps only the ChatGPT subscription and Pi API key templates', () => {
    expect(Object.keys(BUILT_IN_CONNECTION_TEMPLATES).sort()).toEqual([
      'chatgpt-plus',
      'pi-api-key',
    ])
  })

  it('routes ChatGPT Plus OAuth through Pi with openai-codex auth', () => {
    const conn = createBuiltInConnection('chatgpt-plus')
    expect(conn.providerType).toBe('pi')
    expect(conn.authType).toBe('oauth')
    expect(conn.piAuthProvider).toBe('openai-codex')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("Pi API key → 'steer'", () => {
    const conn = createBuiltInConnection('pi-api-key')
    expect(conn.providerType).toBe('pi')
    expect(conn.midStreamBehavior).toBe('steer')
  })

})

describe('toStoredModels', () => {
  it('keeps plain IDs as strings', () => {
    expect(toStoredModels(['pi/a', 'pi/b'])).toEqual(['pi/a', 'pi/b'])
  })

  it('collapses a hint-free object back to a bare ID', () => {
    expect(toStoredModels([{ id: 'pi/a' }])).toEqual(['pi/a'])
  })

  it('stores capability hints so they survive into the Pi subprocess', () => {
    const stored = toStoredModels([
      { id: 'stealth/ox-alpha', contextWindow: 1_048_576, supportsImages: true },
    ])

    expect(stored).toHaveLength(1)
    expect(stored[0]).toEqual({
      id: 'stealth/ox-alpha',
      name: 'stealth/ox-alpha',
      shortName: 'stealth/ox-alpha',
      description: '',
      contextWindow: 1_048_576,
      supportsImages: true,
    } as never)
  })

  it('omits a context window it was never given rather than inventing one', () => {
    const stored = toStoredModels([{ id: 'pi/x', supportsImages: false }])[0] as unknown as Record<string, unknown>
    expect(stored).not.toHaveProperty('contextWindow')
    expect(stored.supportsImages).toBe(false)
  })

  it('strips the pi/ prefix for the display name only', () => {
    const stored = toStoredModels([{ id: 'pi/vendor/model', contextWindow: 8192 }])[0] as unknown as Record<string, unknown>
    expect(stored.id).toBe('pi/vendor/model')
    expect(stored.name).toBe('vendor/model')
  })
})
