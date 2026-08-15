/**
 * Resolves the MCP adapter config that gets pushed down to an agent subprocess.
 *
 * Bitlab's config.json is the single source of truth; the adapter inside the
 * subprocess receives an isolated in-memory snapshot (never ambient files), so
 * this module is the only place that maps persisted state → adapter config.
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { buildAdapterMcpConfig, type AdapterMcpConfig } from './mcp.ts';
import { getMcpServers, getMcpSettings } from './storage.ts';
import { CONFIG_DIR } from './paths.ts';

export function resolveAdapterMcpConfig(): AdapterMcpConfig {
  return buildAdapterMcpConfig(getMcpServers(), getMcpSettings());
}

/**
 * Stable, process-shared OAuth token directory (`<configDir>/mcp-oauth`).
 * Both the agent subprocesses and any auth-driving process must agree on it:
 * pi-mcp-adapter resolves its storage from MCP_OAUTH_DIR first, so this env
 * override keeps tokens identical across sessions (per-session agent dirs
 * would otherwise lose credentials on every new chat).
 */
export function getMcpOAuthDir(): string {
  return join(CONFIG_DIR, 'mcp-oauth');
}

/** Ensure the OAuth token dir exists and return it. */
export function ensureMcpOAuthDir(): string {
  const dir = getMcpOAuthDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}
