/**
 * Stores API keys and OAuth tokens across a small set of backends.
 *
 * Backends are ordered by priority and filtered per credential via
 * `accepts()`, so a backend that only some processes can reach (safe-storage)
 * can own one credential type while everything else stays on the backend every
 * process can read (secure-storage). Reads walk every eligible backend, which
 * keeps a credential written by one process visible to another whenever the
 * storage allows it at all.
 */

import type { LlmAuthType } from '../config/llm-connections.ts';
import { debug } from '../utils/debug.ts';
import { SafeStorageBackend } from './backends/safe-storage.ts';
import { SecureStorageBackend } from './backends/secure-storage.ts';
import type { CredentialBackend } from './backends/types.ts';
import type {
  CredentialHealthIssue,
  CredentialHealthStatus,
  CredentialId,
  StoredCredential,
} from './types.ts';
import { maskCredentialValue } from './types.ts';

export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize().catch(error => {
      this.initPromise = null;
      throw error;
    });
    await this.initPromise;
  }

  /**
   * Sync fallback for the few callers that cannot await (shutdown cleanup).
   * Only the file backend can be set up without probing Electron, so a sync
   * caller that runs before any async one sees just that backend.
   */
  private ensureInitializedSync(): void {
    if (this.initialized) return;
    const backend = new SecureStorageBackend();
    this.backends = [backend];
    this.writeBackend = backend;
    this.initialized = true;
    this.initPromise = null;
  }

  private async doInitialize(): Promise<void> {
    const candidates: CredentialBackend[] = [new SafeStorageBackend(), new SecureStorageBackend()];
    const available: CredentialBackend[] = [];
    for (const backend of candidates) {
      if (await backend.isAvailable()) available.push(backend);
    }
    if (this.initialized) return;
    this.backends = available.sort((a, b) => b.priority - a.priority);
    // The default write target stays the backend that accepts everything, so
    // credential types nobody has claimed keep their current storage.
    this.writeBackend = this.backends.find(backend => !backend.accepts) ?? this.backends[0] ?? null;
    this.initialized = true;
    debug(`[CredentialManager] Backends: ${this.backends.map(b => b.name).join(', ') || 'none'}`);
  }

  /** Backends that handle this credential, highest priority first. */
  private backendsFor(id: CredentialId): CredentialBackend[] {
    return this.backends.filter(backend => backend.accepts?.(id) ?? true);
  }

  /** Where a credential is written: its highest-priority eligible backend. */
  private writeBackendFor(id: CredentialId): CredentialBackend | null {
    return this.backendsFor(id)[0] ?? this.writeBackend;
  }

  getActiveBackendName(): string | null {
    return this.writeBackend?.name ?? null;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();
    for (const backend of this.backendsFor(id)) {
      try {
        const credential = await backend.get(id);
        if (credential) return credential;
      } catch (error) {
        debug(`[CredentialManager] Error reading from ${backend.name}:`, error);
      }
    }
    return null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();
    const backend = this.writeBackendFor(id);
    if (!backend) throw new Error('No writable credential backend available');
    await backend.set(id, credential);
  }

  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();
    let deleted = false;
    for (const backend of this.backendsFor(id)) deleted = (await backend.delete(id)) || deleted;
    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();
    let deleted = false;
    for (const backend of this.backendsFor(id)) deleted = (backend.deleteSync?.(id) ?? false) || deleted;
    return deleted;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();
    const results = new Map<string, CredentialId>();
    for (const backend of this.backends) {
      for (const id of await backend.list(filter)) results.set(`${id.type}:${id.connectionSlug}`, id);
    }
    return [...results.values()];
  }

  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const credential = await this.get({ type: 'llm_api_key', connectionSlug });
    return credential?.value ?? null;
  }

  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  // --- Web search provider keys (connectionSlug === provider id) ---

  async getSearchApiKey(providerId: string): Promise<string | null> {
    const credential = await this.get({ type: 'web_search_api_key', connectionSlug: providerId });
    return credential?.value ?? null;
  }

  async setSearchApiKey(providerId: string, apiKey: string): Promise<void> {
    await this.set({ type: 'web_search_api_key', connectionSlug: providerId }, { value: apiKey });
  }

  async deleteSearchApiKey(providerId: string): Promise<boolean> {
    return this.delete({ type: 'web_search_api_key', connectionSlug: providerId });
  }

  // --- MCP OAuth tokens (connectionSlug === pi-mcp-adapter's account key) ---

  /**
   * pi-mcp-adapter addresses its own entries by an opaque account key
   * (`sha256-<hash of server name>`, plus `.chunk.<digest>.<n>` parts when a
   * payload exceeds its per-value limit) and treats every value as an opaque
   * string. We mirror that key space verbatim instead of re-deriving anything:
   * the adapter owns it, and its chunk bookkeeping only works if we do.
   */
  async getMcpOAuthPayload(account: string): Promise<string | null> {
    const credential = await this.get({ type: 'mcp_oauth', connectionSlug: account });
    return credential?.value ?? null;
  }

  async setMcpOAuthPayload(account: string, payload: string): Promise<void> {
    await this.set({ type: 'mcp_oauth', connectionSlug: account }, { value: payload });
  }

  async deleteMcpOAuthPayload(account: string): Promise<boolean> {
    return this.delete({ type: 'mcp_oauth', connectionSlug: account });
  }

  /**
   * Every stored MCP payload, keyed by account.
   *
   * The agent subprocess reads its tokens synchronously, so it gets the whole
   * set once at startup instead of asking across the wire per lookup.
   */
  async listMcpOAuthPayloads(): Promise<Record<string, string>> {
    const payloads: Record<string, string> = {};
    for (const id of await this.list({ type: 'mcp_oauth' })) {
      const value = await this.getMcpOAuthPayload(id.connectionSlug);
      if (value !== null) payloads[id.connectionSlug] = value;
    }
    return payloads;
  }

  /** Masked key for the settings UI — proves a key exists without exposing it. */
  async getMaskedSearchApiKey(providerId: string): Promise<string | null> {
    const key = await this.getSearchApiKey(providerId);
    return key ? maskCredentialValue(key) : null;
  }

  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    idToken?: string;
  } | null> {
    const credential = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!credential) return null;
    return {
      accessToken: credential.value,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      idToken: credential.idToken,
    };
  }

  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  async deleteLlmOAuth(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_oauth', connectionSlug });
  }

  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.deleteLlmApiKey(connectionSlug);
    await this.deleteLlmOAuth(connectionSlug);
  }

  async hasLlmCredentials(connectionSlug: string, authType: LlmAuthType): Promise<boolean> {
    if (authType === 'none') return true;
    if (authType === 'oauth') return Boolean(await this.getLlmOAuth(connectionSlug));
    return Boolean(await this.getLlmApiKey(connectionSlug));
  }

  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];
    try {
      await this.list({});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      issues.push({
        type: lower.includes('decrypt') || lower.includes('cipher')
          ? 'decryption_failed'
          : 'file_corrupted',
        message: 'Failed to read encrypted credentials. Please enter the API key again.',
        error: message,
      });
      return { healthy: false, issues };
    }

    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const slug = getDefaultLlmConnection();
      const connection = slug ? getLlmConnection(slug) : undefined;
      if (slug && connection && !(await this.hasLlmCredentials(slug, connection.authType))) {
        issues.push({
          type: 'no_default_credentials',
          message: `No credentials found for default connection "${connection.name}".`,
        });
      }
    } catch {
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return { healthy: issues.length === 0, issues };
  }
}

let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
  manager ??= new CredentialManager();
  return manager;
}
