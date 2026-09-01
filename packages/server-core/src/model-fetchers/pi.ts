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
  /**
   * No periodic polling — refreshed once per app start via startAll(). The
   * fetch itself merges the live provider listing over the static SDK catalog
   * (see appendLiveListedModels in the pi driver), so models released after
   * this build appear on restart without an app update.
   */
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
