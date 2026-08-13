/**
 * Resolves the web_search settings that get pushed down to an agent subprocess.
 *
 * The credential store is main-process-only, so keys are read here and handed
 * over in the `init` / `search_config_update` messages — the subprocess never
 * touches the encrypted store (same arrangement as the LLM `piAuth` key).
 *
 * Only the active provider's key is sent: a session has no use for the others.
 */

import { getCredentialManager } from '../credentials/manager.ts';
import { isKeyedSearchProviderId, type KeyedSearchProviderId, type SearchConfig } from './search.ts';
import { getSearchConfig } from './storage.ts';

export interface ResolvedSearchSettings {
  searchConfig: SearchConfig;
  searchApiKeys: Partial<Record<KeyedSearchProviderId, string>>;
}

export async function resolveSearchSettings(): Promise<ResolvedSearchSettings> {
  const searchConfig = getSearchConfig();
  const searchApiKeys: Partial<Record<KeyedSearchProviderId, string>> = {};

  if (isKeyedSearchProviderId(searchConfig.provider)) {
    const key = await getCredentialManager().getSearchApiKey(searchConfig.provider);
    if (key) searchApiKeys[searchConfig.provider] = key;
  }

  return { searchConfig, searchApiKeys };
}
