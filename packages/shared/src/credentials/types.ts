/** Credential storage types for model connections. */

export type CredentialType = 'llm_api_key' | 'llm_oauth' | 'web_search_api_key';

const CREDENTIAL_TYPES: readonly CredentialType[] = ['llm_api_key', 'llm_oauth', 'web_search_api_key'];

const CREDENTIAL_DELIMITER = '::';

export interface CredentialId {
  type: CredentialType;
  connectionSlug: string;
}

export interface StoredCredential {
  value: string;
  refreshToken?: string;
  expiresAt?: number;
  idToken?: string;
}

export type CredentialHealthIssueType =
  | 'file_corrupted'
  | 'decryption_failed'
  | 'no_default_credentials';

export interface CredentialHealthIssue {
  type: CredentialHealthIssueType;
  message: string;
  error?: string;
}

export interface CredentialHealthStatus {
  healthy: boolean;
  issues: CredentialHealthIssue[];
}

/** Mask a secret for display — same shape the LLM connection settings use. */
export function maskCredentialValue(value: string): string {
  return value.length > 15 ? `${value.slice(0, 7)}••••••••${value.slice(-4)}` : '••••••••';
}

/** True when a UI-supplied value is a mask placeholder rather than a real secret. */
export function isMaskedCredentialValue(value: string): boolean {
  return value.includes('••');
}

export function credentialIdToAccount(id: CredentialId): string {
  return [id.type, id.connectionSlug].join(CREDENTIAL_DELIMITER);
}

export function accountToCredentialId(account: string): CredentialId | null {
  const [type, connectionSlug, ...rest] = account.split(CREDENTIAL_DELIMITER);
  if (!CREDENTIAL_TYPES.includes(type as CredentialType) || !connectionSlug || rest.length > 0) return null;
  return { type: type as CredentialType, connectionSlug };
}
