import { afterEach, describe, expect, it } from 'bun:test'
import {
  CHATGPT_OAUTH_CONFIG,
  exchangeChatGptTokens,
  generateCallbackPage,
  prepareChatGptOAuth,
} from '../index.ts'
import { CredentialManager } from '../../credentials/manager.ts'
import type { CredentialBackend } from '../../credentials/backends/types.ts'
import type { CredentialId, StoredCredential } from '../../credentials/types.ts'

describe('LLM subscription OAuth', () => {
  it('prepares the Craft ChatGPT PKCE flow for the desktop callback', () => {
    const flow = prepareChatGptOAuth()
    const url = new URL(flow.authUrl)

    expect(url.origin + url.pathname).toBe(CHATGPT_OAUTH_CONFIG.AUTH_URL)
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_OAUTH_CONFIG.CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe(CHATGPT_OAUTH_CONFIG.REDIRECT_URI)
    expect(url.searchParams.get('scope')).toBe(CHATGPT_OAUTH_CONFIG.SCOPES)
    expect(url.searchParams.get('state')).toBe(flow.state)
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(flow.codeVerifier.length).toBeGreaterThanOrEqual(43)
  })

  describe('token exchange failures', () => {
    const realFetch = globalThis.fetch
    afterEach(() => { globalThis.fetch = realFetch })

    const respondWith = (status: number, body: unknown) => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
    }

    it('reports the nested platform error instead of [object Object]', async () => {
      // OpenAI answers a region-blocked exchange with a nested error object.
      respondWith(403, {
        error: {
          code: 'unsupported_country_region_territory',
          message: 'Country, region, or territory not supported',
        },
      })

      const failure = exchangeChatGptTokens('ac_code', 'verifier')
      await expect(failure).rejects.toThrow(
        'Token exchange failed: 403 - Country, region, or territory not supported (unsupported_country_region_territory)',
      )
    })

    it('still reports the flat OAuth error shape', async () => {
      respondWith(400, { error: 'invalid_grant', error_description: 'Code expired' })

      await expect(exchangeChatGptTokens('ac_code', 'verifier')).rejects.toThrow(
        'Token exchange failed: 400 - Code expired',
      )
    })
  })

  it('uses Bitlab branding on the retained callback page', () => {
    const html = generateCallbackPage({
      title: 'Authorization Complete',
      isSuccess: true,
      appType: 'electron',
      deeplinkUrl: 'bitlab://auth-complete',
    })
    expect(html).toContain('<title>Bitlab - Authorization Complete</title>')
    expect(html).toContain('>Bitlab</a>')
    expect(html).toContain('<img class="logo"')
    expect(html).toContain('src="data:image/png;base64,')
    expect(html).not.toContain('<pre class="logo">')
    expect(html).not.toContain('Craft Agents') // bitlab-brand-audit-ignore
  })
})

describe('LLM OAuth credential storage', () => {
  it('round-trips access, refresh, expiry, and ID tokens under the connection slug', async () => {
    const values = new Map<string, StoredCredential>()
    const key = (id: CredentialId) => `${id.type}:${id.connectionSlug}`
    const backend: CredentialBackend = {
      name: 'memory',
      priority: 1,
      isAvailable: async () => true,
      get: async id => values.get(key(id)) ?? null,
      set: async (id, credential) => { values.set(key(id), credential) },
      delete: async id => values.delete(key(id)),
      list: async () => [],
    }
    const manager = new CredentialManager()
    ;(manager as any).backends = [backend]
    ;(manager as any).writeBackend = backend
    ;(manager as any).initialized = true

    await manager.setLlmOAuth('chatgpt-plus', {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 123456789,
      idToken: 'identity-token',
    })

    expect(await manager.getLlmOAuth('chatgpt-plus')).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: 123456789,
      idToken: 'identity-token',
    })
    expect(await manager.hasLlmCredentials('chatgpt-plus', 'oauth')).toBe(true)
  })
})
