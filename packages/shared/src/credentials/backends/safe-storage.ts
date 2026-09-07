/**
 * Safe Storage Backend
 *
 * Stores credentials in <configDir>/credentials.safe, encrypted by Electron's
 * safeStorage (macOS Keychain / Windows DPAPI / Linux libsecret).
 *
 * Why this exists rather than "just use the OS keychain from wherever":
 * an OS credential entry is owned by the *code identity* that created it, and
 * macOS re-prompts whenever a different identity reads it. Reaching the
 * keychain from the agent subprocess means the owner is `bun` — a generic
 * runtime that exists in several copies, signed by two different teams, and
 * re-signed on every package build. safeStorage instead binds the entry to the
 * app bundle (app.bitlab.desktop), which is one stable Developer ID identity
 * for the life of the product.
 *
 * Availability is asymmetric by design: only an Electron main process can
 * decrypt. The headless server (packages/server) and the agent subprocess have
 * no safeStorage, fall through to SecureStorageBackend, and never see this
 * file's contents. CredentialManager reads every backend in priority order, so
 * a credential written by the server stays readable in the desktop app; the
 * reverse does not hold, and a headless run has to authenticate on its own.
 *
 * File format:
 *   Magic: "BLSAFE01" (8 bytes)
 *   Ciphertext: safeStorage.encryptString(JSON) — opaque, OS-managed key
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';

import { debug } from '../../utils/debug.ts';
import { CONFIG_DIR } from '../../config/paths.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';
import type { CredentialBackend } from './types.ts';

const CREDENTIALS_FILE = join(CONFIG_DIR, 'credentials.safe');
const MAGIC_BYTES = Buffer.from('BLSAFE01');
const MAGIC_SIZE = MAGIC_BYTES.length;

/** The slice of Electron's safeStorage this backend needs. */
interface SafeStorageApi {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

interface SafeStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: { createdAt: number; updatedAt: number };
}

/**
 * Resolved once per process: the API object when this is an Electron main
 * process with working encryption, null everywhere else. `undefined` means
 * "not probed yet" — the probe is async because importing electron from a
 * shared module must not be a load-time dependency.
 */
let safeStorageApi: SafeStorageApi | null | undefined;

async function probeSafeStorage(): Promise<SafeStorageApi | null> {
  if (safeStorageApi !== undefined) return safeStorageApi;
  safeStorageApi = null;
  if (!process.versions.electron) return safeStorageApi;
  try {
    // The electron main bundle is CJS with electron left external, so this
    // dynamic import can hand back either the module itself or a namespace
    // wrapping it under `default`.
    const imported = (await import('electron')) as unknown as {
      safeStorage?: SafeStorageApi;
      app?: { isReady(): boolean; whenReady(): Promise<unknown> };
      default?: { safeStorage?: SafeStorageApi; app?: { isReady(): boolean; whenReady(): Promise<unknown> } };
    };
    const electron = imported.safeStorage ? imported : (imported.default ?? imported);

    // On Linux the backing secret service is only wired up once the app is
    // ready, and asking early would cache a permanent "unavailable" for the
    // rest of the process. Everywhere else this resolves immediately.
    if (electron.app && !electron.app.isReady()) await electron.app.whenReady();

    const api = electron.safeStorage;
    // Still false for a keychain that cannot be unlocked at all — the manager
    // then falls back instead of writing a file nothing can ever read.
    if (api && api.isEncryptionAvailable()) safeStorageApi = api;
    else debug('[SafeStorageBackend] safeStorage present but encryption unavailable');
  } catch (error) {
    debug('[SafeStorageBackend] electron import failed:', error);
  }
  return safeStorageApi;
}

export class SafeStorageBackend implements CredentialBackend {
  readonly name = 'safe-storage';
  /** Above SecureStorageBackend (100) — preferred for both reads and writes. */
  readonly priority = 200;

  private cachedStore: SafeStore | null = null;

  async isAvailable(): Promise<boolean> {
    return (await probeSafeStorage()) !== null;
  }

  /**
   * MCP OAuth tokens only, for now.
   *
   * These are the credentials that were being read straight from the OS
   * keychain by the agent subprocess, so they are the ones the stable app
   * identity actually buys something for. LLM keys deliberately stay on the
   * file backend: moving them here would make every credential written in the
   * desktop app invisible to a headless `packages/server` run on the same
   * machine, which is a regression no one asked for. Widening this predicate
   * later is a one-line change plus a migration.
   */
  accepts(id: CredentialId): boolean {
    return id.type === 'mcp_oauth';
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    return store?.credentials[credentialIdToAccount(id)] ?? null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    const api = await probeSafeStorage();
    if (!api) throw new Error('safeStorage is not available in this process');

    const store = (await this.loadStore()) ?? {
      version: 1 as const,
      credentials: {},
      metadata: { createdAt: Date.now(), updatedAt: Date.now() },
    };
    store.credentials[credentialIdToAccount(id)] = credential;
    store.metadata.updatedAt = Date.now();
    this.saveStore(api, store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    const api = await probeSafeStorage();
    if (!api) return false;
    return this.deleteWith(api, id);
  }

  deleteSync(id: CredentialId): boolean {
    // Only works once some async path has probed; the sync delete path exists
    // for shutdown cleanup, where a prior read has always run.
    return safeStorageApi ? this.deleteWith(safeStorageApi, id) : false;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];
    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);
    if (!filter) return ids;
    return ids.filter(id => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.connectionSlug && id.connectionSlug !== filter.connectionSlug) return false;
      return true;
    });
  }

  // ============================================================
  // Private
  // ============================================================

  private deleteWith(api: SafeStorageApi, id: CredentialId): boolean {
    const store = this.loadStoreWith(api);
    if (!store) return false;
    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;
    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();
    this.saveStore(api, store);
    return true;
  }

  private async loadStore(): Promise<SafeStore | null> {
    const api = await probeSafeStorage();
    return api ? this.loadStoreWith(api) : null;
  }

  private loadStoreWith(api: SafeStorageApi): SafeStore | null {
    if (this.cachedStore) return this.cachedStore;
    if (!existsSync(CREDENTIALS_FILE)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(CREDENTIALS_FILE);
    } catch (error) {
      debug('[SafeStorageBackend] read failed:', error);
      return null;
    }

    if (fileData.length <= MAGIC_SIZE || !fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.discardCorruptedFile('bad magic');
      return null;
    }

    try {
      const store = JSON.parse(api.decryptString(fileData.subarray(MAGIC_SIZE))) as SafeStore;
      this.cachedStore = store;
      return store;
    } catch (error) {
      // A failed decrypt here means the OS key is gone for good (keychain entry
      // deleted, restored to another machine). Nothing can recover the file, so
      // drop it and let the user re-authenticate rather than failing forever.
      this.discardCorruptedFile(String(error));
      return null;
    }
  }

  private saveStore(api: SafeStorageApi, store: SafeStore): void {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const payload = Buffer.concat([MAGIC_BYTES, api.encryptString(JSON.stringify(store))]);
    writeFileSync(CREDENTIALS_FILE, payload, { mode: 0o600 });
    this.cachedStore = store;
  }

  private discardCorruptedFile(reason: string): void {
    debug(`[SafeStorageBackend] discarding unreadable ${CREDENTIALS_FILE}: ${reason}`);
    try {
      unlinkSync(CREDENTIALS_FILE);
    } catch {
      // Already gone, or not ours to remove — the caller treats it as empty.
    }
    this.cachedStore = null;
  }
}

/** Test seam: forget the probed API and any decrypted store. */
export function resetSafeStorageProbeForTests(): void {
  safeStorageApi = undefined;
}

/** Test seam: install a fake safeStorage without an Electron runtime. */
export function setSafeStorageApiForTests(api: SafeStorageApi | null): void {
  safeStorageApi = api;
}
