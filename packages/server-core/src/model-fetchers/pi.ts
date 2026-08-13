/**
 * Pi Model Fetcher
 *
 * Provider-agnostic wrapper that delegates model discovery to backend drivers.
 */

import type { ModelFetcher, ModelFetchResult, ModelFetcherCredentials } from '@bitlab/shared/config'
import type { LlmConnection } from '@bitlab/shared/config'
import { fetchBackendModels } from '@bitlab/shared/agent/backend'
import { getHostRuntime } from './runtime'

export class PiModelFetcher implements ModelFetcher {
  /** No periodic refresh — SDK models are static, updated on app upgrade */
  readonly refreshIntervalMs = 0

  async fetchModels(
    connection: LlmConnection,
    credentials: ModelFetcherCredentials,
  ): Promise<ModelFetchResult> {
    return fetchBackendModels({
      connection,
      credentials,
      timeoutMs: 15_000,
      hostRuntime: getHostRuntime(),
    })
  }
}
