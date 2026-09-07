/**
 * Credential Storage Module
 *
 * Provides secure credential storage across a priority-ordered set of
 * backends — an AES-256-GCM encrypted file everywhere, plus Electron
 * safeStorage for MCP tokens in the desktop app (see backends/safe-storage.ts).
 * All methods auto-initialize, so explicit initialize() calls are optional.
 *
 * Usage:
 *   import { getCredentialManager } from './credentials';
 *
 *   const manager = getCredentialManager();
 *
 *   // Get/set API key
 *   const apiKey = await manager.getLlmApiKey(connectionSlug);
 *   await manager.setLlmApiKey(connectionSlug, 'sk-...');
 */

export { CredentialManager, getCredentialManager } from './manager.ts';
export { SafeStorageBackend } from './backends/safe-storage.ts';
export type { CredentialId, CredentialType, StoredCredential } from './types.ts';
export {
  credentialIdToAccount,
  accountToCredentialId,
  maskCredentialValue,
  isMaskedCredentialValue,
} from './types.ts';
export type { CredentialBackend } from './backends/types.ts';
