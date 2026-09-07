import { describe, it, expect, beforeEach, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// `.isolated.ts`: these backends write real files under CONFIG_DIR, which
// config/paths.ts captures the first time it loads. In a shared test process
// another file will already have loaded it against the developer's own
// ~/.bitlab, and this suite would write there instead — so it gets a process of
// its own (see scripts/run-tests.ts), and the dynamic imports below run after
// the override is in place.
const configDir = mkdtempSync(join(tmpdir(), 'bitlab-credentials-'))
process.env.BITLAB_CONFIG_DIR = configDir

const { CONFIG_DIR } = await import('../../config/paths.ts')
if (CONFIG_DIR !== configDir) {
  // Never fall through to the real credential store: this suite overwrites
  // credentials, and doing that to someone's actual keys is not a failure
  // anyone should have to discover after the fact.
  throw new Error(
    `Refusing to run: CONFIG_DIR resolved to ${CONFIG_DIR}, not the temporary ${configDir}. ` +
    'config/paths.ts loaded before this file set BITLAB_CONFIG_DIR — keep this file isolated.',
  )
}

const { SafeStorageBackend, setSafeStorageApiForTests, resetSafeStorageProbeForTests } =
  await import('../backends/safe-storage.ts')
const { CredentialManager } = await import('../manager.ts')

const SAFE_FILE = join(configDir, 'credentials.safe')

/** Stands in for Electron's safeStorage: reversible, and obviously not plaintext. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted: Buffer) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('not encrypted by this key')
    return text.slice(4)
  },
}

beforeEach(() => {
  // Both stores, so one test's writes cannot leak into the next one's reads.
  rmSync(SAFE_FILE, { force: true })
  rmSync(join(configDir, 'credentials.enc'), { force: true })
  setSafeStorageApiForTests(fakeSafeStorage)
})

afterAll(() => {
  resetSafeStorageProbeForTests()
  rmSync(configDir, { recursive: true, force: true })
})

describe('SafeStorageBackend', () => {
  it('round-trips a credential through the encrypted file', async () => {
    const backend = new SafeStorageBackend()
    const id = { type: 'mcp_oauth' as const, connectionSlug: 'sha256-abc' }

    await backend.set(id, { value: 'token-value' })

    expect(await backend.get(id)).toEqual({ value: 'token-value' })
    expect(await backend.list({ type: 'mcp_oauth' })).toEqual([id])
    expect(readFileSync(SAFE_FILE).subarray(0, 8).toString()).toBe('BLSAFE01')
    // The body went through safeStorage rather than being written as plain JSON.
    expect(readFileSync(SAFE_FILE).subarray(8, 12).toString()).toBe('enc:')
  })

  it('deletes credentials and reports whether anything was removed', async () => {
    const backend = new SafeStorageBackend()
    const id = { type: 'mcp_oauth' as const, connectionSlug: 'sha256-abc' }
    await backend.set(id, { value: 'token-value' })

    expect(await backend.delete(id)).toBe(true)
    expect(await backend.delete(id)).toBe(false)
    expect(await backend.get(id)).toBeNull()
  })

  it('claims MCP tokens only, leaving other credentials to the file backend', () => {
    const backend = new SafeStorageBackend()
    expect(backend.accepts({ type: 'mcp_oauth', connectionSlug: 'x' })).toBe(true)
    expect(backend.accepts({ type: 'llm_api_key', connectionSlug: 'x' })).toBe(false)
    expect(backend.accepts({ type: 'llm_oauth', connectionSlug: 'x' })).toBe(false)
  })

  it('is unavailable outside an Electron main process', async () => {
    setSafeStorageApiForTests(null)
    expect(await new SafeStorageBackend().isAvailable()).toBe(false)
  })

  it('discards a file it cannot decrypt instead of failing every read', async () => {
    const backend = new SafeStorageBackend()
    await backend.set({ type: 'mcp_oauth', connectionSlug: 'sha256-abc' }, { value: 'v' })

    // A file written under a key this machine no longer has.
    writeFileSync(SAFE_FILE, Buffer.concat([Buffer.from('BLSAFE01'), Buffer.from('garbage')]))
    const fresh = new SafeStorageBackend()

    expect(await fresh.get({ type: 'mcp_oauth', connectionSlug: 'sha256-abc' })).toBeNull()
    expect(existsSync(SAFE_FILE)).toBe(false)
  })
})

describe('CredentialManager backend routing', () => {
  it('stores MCP tokens in safe-storage and LLM keys in the file backend', async () => {
    const manager = new CredentialManager()
    await manager.setMcpOAuthPayload('sha256-server', 'mcp-token')
    await manager.setLlmApiKey('openai', 'sk-test-key')

    expect(await manager.getMcpOAuthPayload('sha256-server')).toBe('mcp-token')
    expect(await manager.getLlmApiKey('openai')).toBe('sk-test-key')

    // Each credential landed in its own file — the LLM key must stay readable
    // from a headless run, which has no safeStorage at all.
    expect(readFileSync(SAFE_FILE, 'utf8')).toContain('mcp-token')
    expect(readFileSync(SAFE_FILE, 'utf8')).not.toContain('sk-test-key')
    expect(existsSync(join(configDir, 'credentials.enc'))).toBe(true)
  })

  it('lists every stored MCP payload for seeding a subprocess', async () => {
    const manager = new CredentialManager()
    await manager.setMcpOAuthPayload('sha256-a', 'token-a')
    await manager.setMcpOAuthPayload('sha256-b', 'token-b')

    expect(await manager.listMcpOAuthPayloads()).toEqual({
      'sha256-a': 'token-a',
      'sha256-b': 'token-b',
    })
  })

  it('falls back to the file backend for MCP tokens with no safeStorage', async () => {
    setSafeStorageApiForTests(null)
    const manager = new CredentialManager()

    await manager.setMcpOAuthPayload('sha256-headless', 'headless-token')

    expect(await manager.getMcpOAuthPayload('sha256-headless')).toBe('headless-token')
    expect(existsSync(SAFE_FILE)).toBe(false)
  })
})
