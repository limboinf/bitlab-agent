// `.isolated.ts`: installKeyringShim() registers a process-wide Bun plugin that
// replaces @napi-rs/keyring for every module loaded afterwards, so this file
// cannot share a test process with the rest of the suite.
import { describe, expect, it, beforeEach } from 'bun:test'
import { createRequire } from 'node:module'

import {
  installKeyringShim,
  seedMcpSecrets,
  setSecretWriter,
  applyMcpSecretSync,
  resetMcpSecretsForTests,
  setLegacyKeychainReaderForTests,
} from '../keyring-store.ts'

installKeyringShim()

const SERVICE = 'pi-mcp-adapter.oauth'
const writes: Array<{ account: string; payload: string | null }> = []

beforeEach(() => {
  resetMcpSecretsForTests()
  writes.length = 0
  legacyReads.length = 0
  delete process.env.BITLAB_MCP_KEYCHAIN_IMPORT_DISABLED
  setSecretWriter((account, payload) => { writes.push({ account, payload }) })
  setLegacyKeychainReaderForTests((service, account) => {
    legacyReads.push(account)
    if (legacyThrows) throw new Error('keychain unavailable')
    return legacyTokens[account] ?? null
  })
})

const legacyReads: string[] = []
let legacyTokens: Record<string, string> = {}
let legacyThrows = false

/** How pi-mcp-adapter loads the module (bundled as a runtime require). */
function requireKeyring() {
  return createRequire(import.meta.url)('@napi-rs/keyring') as {
    Entry: new (service: string, account: string) => {
      getPassword(): string | null
      setPassword(password: string): void
      deleteCredential(): boolean
    }
  }
}

describe('keyring shim module override', () => {
  it('replaces @napi-rs/keyring for require() and import() alike', async () => {
    seedMcpSecrets({ 'sha256-a': 'token-a' })

    expect(new (requireKeyring().Entry)(SERVICE, 'sha256-a').getPassword()).toBe('token-a')

    const imported = await import('@napi-rs/keyring')
    expect(new imported.Entry(SERVICE, 'sha256-a').getPassword()).toBe('token-a')
  })

  it('rejects any service other than the adapter’s', () => {
    seedMcpSecrets({})
    expect(() => new (requireKeyring().Entry)('some-other-app', 'acct')).toThrow(/Unexpected keyring service/)
  })
})

describe('keyring shim entry', () => {
  it('throws rather than reporting an empty store before the snapshot arrives', () => {
    const { Entry } = requireKeyring()
    expect(() => new Entry(SERVICE, 'sha256-a').getPassword()).toThrow(/snapshot has not been received/)
  })

  it('reads seeded tokens and reports unknown accounts as absent', () => {
    seedMcpSecrets({ 'sha256-a': 'token-a' })
    const { Entry } = requireKeyring()

    expect(new Entry(SERVICE, 'sha256-a').getPassword()).toBe('token-a')
    expect(new Entry(SERVICE, 'sha256-missing').getPassword()).toBeNull()
  })

  it('serves a write back locally and forwards it to the main process', () => {
    seedMcpSecrets({})
    const entry = new (requireKeyring().Entry)(SERVICE, 'sha256-a')

    entry.setPassword('fresh-token')

    expect(entry.getPassword()).toBe('fresh-token')
    expect(writes).toEqual([{ account: 'sha256-a', payload: 'fresh-token' }])
  })

  it('forwards deletes only when something was actually stored', () => {
    seedMcpSecrets({ 'sha256-a': 'token-a' })
    const { Entry } = requireKeyring()

    expect(new Entry(SERVICE, 'sha256-a').deleteCredential()).toBe(true)
    expect(new Entry(SERVICE, 'sha256-a').deleteCredential()).toBe(false)
    expect(writes).toEqual([{ account: 'sha256-a', payload: null }])
  })

  it('applies another session’s token change without echoing it back', () => {
    seedMcpSecrets({ 'sha256-a': 'stale' })
    const { Entry } = requireKeyring()

    applyMcpSecretSync('sha256-a', 'rotated')
    expect(new Entry(SERVICE, 'sha256-a').getPassword()).toBe('rotated')

    applyMcpSecretSync('sha256-a', null)
    expect(new Entry(SERVICE, 'sha256-a').getPassword()).toBeNull()
    expect(writes).toEqual([])
  })
})

describe('one-time import from the old keychain', () => {
  beforeEach(() => {
    legacyTokens = {}
    legacyThrows = false
  })

  it('imports a token the adapter wrote before the store moved, and persists it', () => {
    legacyTokens = { 'sha256-old': 'legacy-token' }
    seedMcpSecrets({})
    const entry = new (requireKeyring().Entry)(SERVICE, 'sha256-old')

    expect(entry.getPassword()).toBe('legacy-token')
    // Handed to the main process, so the next session is seeded from the new store.
    expect(writes).toEqual([{ account: 'sha256-old', payload: 'legacy-token' }])
  })

  it('reads the old keychain at most once per account', () => {
    seedMcpSecrets({})
    const { Entry } = requireKeyring()

    expect(new Entry(SERVICE, 'sha256-gone').getPassword()).toBeNull()
    expect(new Entry(SERVICE, 'sha256-gone').getPassword()).toBeNull()
    expect(legacyReads).toEqual(['sha256-gone'])
  })

  it('never reaches for the keychain when the snapshot already has the account', () => {
    legacyTokens = { 'sha256-a': 'legacy-token' }
    seedMcpSecrets({ 'sha256-a': 'current-token' })

    expect(new (requireKeyring().Entry)(SERVICE, 'sha256-a').getPassword()).toBe('current-token')
    expect(legacyReads).toEqual([])
  })

  it('treats a failing keychain as an unauthenticated server', () => {
    legacyThrows = true
    seedMcpSecrets({})

    expect(new (requireKeyring().Entry)(SERVICE, 'sha256-old').getPassword()).toBeNull()
    expect(writes).toEqual([])
  })

  it('can be switched off entirely', () => {
    process.env.BITLAB_MCP_KEYCHAIN_IMPORT_DISABLED = '1'
    legacyTokens = { 'sha256-old': 'legacy-token' }
    seedMcpSecrets({})

    expect(new (requireKeyring().Entry)(SERVICE, 'sha256-old').getPassword()).toBeNull()
    expect(legacyReads).toEqual([])
  })
})
