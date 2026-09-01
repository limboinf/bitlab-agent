import type { ProviderDriver, DriverTestConnectionArgs } from '../driver-types.ts';
import { getAllPiModels, getPiModelsForAuthProvider } from '../../../../config/models-pi.ts';
import { getPiProviderBaseUrl } from '../../../../config/models-pi.ts';
import {
  fetchProviderModelListing,
  mergeCatalogModelsWithListing,
} from '../../../../config/provider-model-listing.ts';
import type { ModelDefinition } from '../../../../config/models.ts';

/** Minimal shape appendLiveListedModels needs from an LlmConnection. */
interface LlmConnectionShape {
  baseUrl?: string;
  piAuthProvider?: string;
}

/**
 * Augment the bundled Pi SDK catalog with the provider's live `GET /models`
 * listing, so models released after this build reach existing connections on
 * the next model refresh without an app update. Catalog entries always win;
 * any failure keeps the catalog unchanged.
 */
async function appendLiveListedModels(
  catalog: ModelDefinition[],
  connection: LlmConnectionShape,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
): Promise<ModelDefinition[]> {
  const baseUrl = connection.baseUrl?.trim()
    || (connection.piAuthProvider ? getPiProviderBaseUrl(connection.piAuthProvider) : undefined);
  if (!baseUrl) return catalog;

  try {
    let authStyle: 'bearer' | 'anthropic' = 'bearer';
    if (connection.piAuthProvider) {
      const { getModels } = await import('@earendil-works/pi-ai/compat');
      const first = getModels(connection.piAuthProvider as Parameters<typeof getModels>[0])[0] as
        | { api?: string }
        | undefined;
      if (first?.api === 'anthropic-messages') authStyle = 'anthropic';
    }
    const listing = await fetchProviderModelListing({ baseUrl, apiKey, authStyle, timeoutMs });
    if (listing === null || listing.length === 0) return catalog;
    return mergeCatalogModelsWithListing(catalog, listing);
  } catch {
    return catalog;
  }
}

/**
 * Lightweight direct HTTP test for Pi providers that expose an Anthropic-compatible
 * messages endpoint. Avoids spawning a full Pi subprocess (which can exceed the
 * 20s test timeout due to SDK initialization overhead).
 */
async function testAnthropicCompatible(
  apiKey: string,
  baseUrl: string,
  model: string,
  timeoutMs: number,
): Promise<{ success: boolean; error?: string }> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Say ok' }],
      }),
    });

    if (res.ok) return { success: true };

    const text = await res.text().catch(() => '');
    return { success: false, error: `${res.status} ${text}`.slice(0, 500) };
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return { success: false, error: 'Connection test timed out' };
    }
    return { success: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export const piDriver: ProviderDriver = {
  provider: 'pi',
  buildRuntime: ({ context, providerOptions, resolvedPaths }) => ({
    paths: {
      piServer: resolvedPaths.piServerPath,
      interceptor: resolvedPaths.interceptorBundlePath,
      node: resolvedPaths.nodeRuntimePath,
    },
    piAuthProvider: providerOptions?.piAuthProvider || context.connection?.piAuthProvider,
    baseUrl: context.connection?.baseUrl,
    customEndpoint: context.connection?.customEndpoint,
    customModels: context.connection?.models?.map(m => {
      if (typeof m === 'string') return m;
      const supportsImages = typeof m.supportsImages === 'boolean'
        ? m.supportsImages
        : undefined;
      const supportsThinking = typeof m.supportsThinking === 'boolean'
        ? m.supportsThinking
        : undefined;
      if (m.contextWindow || supportsImages !== undefined || supportsThinking !== undefined) {
        return {
          id: m.id,
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(supportsImages !== undefined ? { supportsImages } : {}),
          ...(supportsThinking !== undefined ? { supportsThinking } : {}),
        };
      }
      return m.id;
    }),
  }),
  fetchModels: async ({ connection, credentials, timeoutMs }) => {
    // Pi providers use the SDK model registry; custom endpoints supply models directly.
    const models = connection.piAuthProvider
      ? getPiModelsForAuthProvider(connection.piAuthProvider)
      : getAllPiModels();

    if (models.length === 0) {
      throw new Error(
        `No Pi models found for provider: ${connection.piAuthProvider ?? 'all'}`,
      );
    }

    return { models: await appendLiveListedModels(models, connection, credentials.apiKey, timeoutMs) };
  },
  testConnection: async (args: DriverTestConnectionArgs): Promise<{ success: boolean; error?: string } | null> => {
    const piAuthProvider = args.connection?.piAuthProvider;
    if (!piAuthProvider) {
      // No provider hint — fall back to generic subprocess path
      return null;
    }

    // Resolve the model's API type from the Pi SDK registry.
    // For anthropic-messages providers, do a lightweight direct HTTP test
    // instead of spawning a full Pi subprocess (which can exceed the timeout).
    let modelApi: string | undefined;
    let modelBaseUrl: string | undefined;
    try {
      const { getModels } = await import('@earendil-works/pi-ai/compat');
      const models = getModels(piAuthProvider as Parameters<typeof getModels>[0]);
      const requestedId = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
      const match = models.find(m => m.id === requestedId) || models[0];
      if (match) {
        modelApi = (match as { api?: string }).api;
        modelBaseUrl = (match as { baseUrl?: string }).baseUrl;
      }
    } catch { /* ignore — fall through to subprocess */ }

    if (modelApi !== 'anthropic-messages') {
      // Non-Anthropic API types need the full Pi SDK — let factory.ts handle it
      return null;
    }

    const baseUrl = args.baseUrl?.trim() || modelBaseUrl || getPiProviderBaseUrl(piAuthProvider);
    if (!baseUrl) {
      return { success: false, error: 'Could not determine API endpoint for provider' };
    }

    // Strip Pi SDK's 'pi/' prefix — Anthropic-compatible endpoints only accept bare model IDs
    let bareModel = args.model.startsWith('pi/') ? args.model.slice(3) : args.model;
    // MiniMax CN API doesn't accept the 'MiniMax-' prefix on model names
    if (piAuthProvider === 'minimax-cn' && bareModel.startsWith('MiniMax-')) {
      bareModel = bareModel.slice('MiniMax-'.length);
    }
    return testAnthropicCompatible(args.apiKey, baseUrl, bareModel, args.timeoutMs);
  },
  validateStoredConnection: async () => ({ success: true }),
};
