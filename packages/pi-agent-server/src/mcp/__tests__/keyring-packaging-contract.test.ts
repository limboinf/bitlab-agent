/**
 * The keyring shim only works if two things stay true. Both are invisible at
 * runtime when they break — MCP tokens would silently go back to the OS
 * keychain, and every user would start seeing "bun wants to use your
 * confidential information" again — so they are asserted here.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = join(import.meta.dir, '..', '..', '..');

function readPackageFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), 'utf-8');
}

describe('MCP keyring packaging contract', () => {
  it('installs the shim as the first top-level statement of the server entry', () => {
    const source = readPackageFile('src/index.ts');
    const install = source.indexOf('installKeyringShim();');
    expect(install).toBeGreaterThan(-1);

    // Anything the adapter's credential store could reach must come after it.
    const firstOtherStatement = source.indexOf('setBedrockProviderModule(');
    expect(firstOtherStatement).toBeGreaterThan(install);
  });

  it('keeps pi-mcp-adapter behind a dynamic import', () => {
    const extension = readPackageFile('src/mcp/mcp-extension.ts');
    expect(extension).toContain('await import(moduleId)');
    // A static `from 'pi-mcp-adapter'` would be hoisted above the shim install.
    // The type-only subpath import is fine: it pulls no credential code.
    expect(extension).not.toMatch(/from ['"]pi-mcp-adapter['"]/);
  });

  it('leaves the adapter resolving @napi-rs/keyring at runtime, where the shim can answer', () => {
    // Built by scripts/run-tests.ts before the suite runs.
    const bundle = readPackageFile('dist/index.js');
    expect(bundle).toContain('keyringRequire("@napi-rs/keyring")');
    expect(bundle).toContain('installKeyringShim()');
  });
});
