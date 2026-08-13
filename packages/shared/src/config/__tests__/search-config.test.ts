import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const CONFIG_MODULE = pathToFileURL(join(import.meta.dir, '..', 'index.ts')).href
const CREDENTIALS_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', 'credentials', 'index.ts')).href

/**
 * Search settings touch both config.json and the encrypted credential store,
 * and both resolve their paths at import time — so each case runs in a
 * subprocess pointed at a throwaway BITLAB_CONFIG_DIR.
 */
function setup(storedConfig: Record<string, unknown> = {}) {
  const configDir = mkdtempSync(join(tmpdir(), 'bitlab-search-'))
  const configPath = join(configDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...storedConfig,
  }, null, 2), 'utf-8')

  function run(script: string): string {
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, BITLAB_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(`subprocess failed:\n${result.stderr.toString()}`)
    return result.stdout.toString().trim()
  }

  const readConfig = () => JSON.parse(readFileSync(configPath, 'utf-8'))

  return { configDir, run, readConfig }
}

describe('getSearchConfig / setSearchConfig', () => {
  it('defaults to auto when config.json has no searchConfig', () => {
    const { run } = setup()

    const output = run(`
      import { getSearchConfig } from '${CONFIG_MODULE}';
      console.log(JSON.stringify(getSearchConfig()));
    `)

    expect(JSON.parse(output)).toEqual({ provider: 'auto', providers: {} })
  })

  it('round-trips a provider selection with per-provider overrides', () => {
    const { run, readConfig } = setup()

    const output = run(`
      import { getSearchConfig, setSearchConfig } from '${CONFIG_MODULE}';
      setSearchConfig({ provider: 'tavily', providers: { tavily: { baseURL: 'https://proxy.test' } } });
      console.log(JSON.stringify(getSearchConfig()));
    `)

    expect(JSON.parse(output)).toEqual({
      provider: 'tavily',
      providers: { tavily: { baseURL: 'https://proxy.test' } },
    })
    expect(readConfig().searchConfig.provider).toBe('tavily')
  })

  it('drops unknown provider ids instead of trusting the file', () => {
    const { run } = setup({
      searchConfig: { provider: 'bing', providers: { bing: { baseURL: 'x' }, exa: { baseURL: 'y' } } },
    })

    const output = run(`
      import { getSearchConfig } from '${CONFIG_MODULE}';
      console.log(JSON.stringify(getSearchConfig()));
    `)

    expect(JSON.parse(output)).toEqual({ provider: 'auto', providers: { exa: { baseURL: 'y' } } })
  })

  it('never writes an api key into config.json', () => {
    const { run, readConfig } = setup()

    run(`
      import { setSearchConfig } from '${CONFIG_MODULE}';
      import { getCredentialManager } from '${CREDENTIALS_MODULE}';
      setSearchConfig({ provider: 'exa', providers: {} });
      await getCredentialManager().setSearchApiKey('exa', 'exa-secret-key-1234567890');
    `)

    expect(JSON.stringify(readConfig())).not.toContain('exa-secret-key')
  })
})

describe('search api key credentials', () => {
  it('round-trips a key and masks it for display', () => {
    const { run } = setup()

    const output = run(`
      import { getCredentialManager } from '${CREDENTIALS_MODULE}';
      const manager = getCredentialManager();
      await manager.setSearchApiKey('tavily', 'tvly-secret-key-1234567890');
      const stored = await manager.getSearchApiKey('tavily');
      const masked = await manager.getMaskedSearchApiKey('tavily');
      const deleted = await manager.deleteSearchApiKey('tavily');
      const afterDelete = await manager.getSearchApiKey('tavily');
      console.log(JSON.stringify({ stored, masked, deleted, afterDelete }));
    `)

    const result = JSON.parse(output)
    expect(result.stored).toBe('tvly-secret-key-1234567890')
    expect(result.masked).toBe('tvly-se••••••••7890')
    expect(result.deleted).toBe(true)
    expect(result.afterDelete).toBeNull()
  })

  it('keeps search keys separate from llm keys with the same slug', () => {
    const { run } = setup()

    const output = run(`
      import { getCredentialManager } from '${CREDENTIALS_MODULE}';
      const manager = getCredentialManager();
      await manager.setLlmApiKey('deepseek', 'llm-key');
      await manager.setSearchApiKey('deepseek', 'search-key');
      console.log(JSON.stringify({
        llm: await manager.getLlmApiKey('deepseek'),
        search: await manager.getSearchApiKey('deepseek'),
      }));
    `)

    expect(JSON.parse(output)).toEqual({ llm: 'llm-key', search: 'search-key' })
  })
})

describe('resolveSearchSettings', () => {
  it('sends only the active provider key to the subprocess', () => {
    const { run } = setup()

    const output = run(`
      import { setSearchConfig, resolveSearchSettings } from '${CONFIG_MODULE}';
      import { getCredentialManager } from '${CREDENTIALS_MODULE}';
      const manager = getCredentialManager();
      await manager.setSearchApiKey('tavily', 'tavily-key');
      await manager.setSearchApiKey('exa', 'exa-key');
      setSearchConfig({ provider: 'tavily', providers: {} });
      console.log(JSON.stringify(await resolveSearchSettings()));
    `)

    const { searchConfig, searchApiKeys } = JSON.parse(output)
    expect(searchConfig.provider).toBe('tavily')
    expect(searchApiKeys).toEqual({ tavily: 'tavily-key' })
  })

  it('sends no keys at all for auto and duckduckgo', () => {
    const { run } = setup()

    const output = run(`
      import { setSearchConfig, resolveSearchSettings } from '${CONFIG_MODULE}';
      import { getCredentialManager } from '${CREDENTIALS_MODULE}';
      await getCredentialManager().setSearchApiKey('tavily', 'tavily-key');
      setSearchConfig({ provider: 'duckduckgo', providers: {} });
      console.log(JSON.stringify((await resolveSearchSettings()).searchApiKeys));
    `)

    expect(JSON.parse(output)).toEqual({})
  })
})
