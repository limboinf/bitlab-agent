import type { ModelRegistry as PiModelRegistry } from '@earendil-works/pi-coding-agent';
import { resolvePiModel, isDeniedMiniModelId } from './model-resolution.ts';
import { pickPreferredModels } from '../../shared/src/config/llm-connections.ts';
import { getPiCatalogModels } from '../../shared/src/config/models-pi.ts';

/**
 * Pick an auth-provider-appropriate default mini model.
 *
 * `getDefaultSummarizationModel()` returns `claude-haiku-4-5`, which only resolves
 * under `anthropic` auth. For `openai`, `google`, and other API-key providers
 * we need one of that provider's preferred models — otherwise the ephemeral session ends up with no explicit
 * model and Pi SDK's internal default (post-0.70.0 an openai model) is used,
 * surfacing as a misleading "No API key found for openai" error when the user
 * is authenticated under a different provider.
 *
 * Walks the provider's preferred catalog models (best first) and returns the first candidate
 * that is not denied by `isDeniedMiniModelId` and resolves via `resolvePiModel`.
 *
 * Returns `undefined` when there is no resolvable candidate; callers should
 * fall back to `getDefaultSummarizationModel()` in that case.
 */
export function pickProviderAppropriateMiniModel(
  authProvider: string,
  modelRegistry: PiModelRegistry,
  preferCustomEndpoint: boolean,
): string | undefined {
  for (const { id } of pickPreferredModels(getPiCatalogModels(authProvider), authProvider)) {
    if (isDeniedMiniModelId(id, authProvider)) continue;
    if (resolvePiModel(modelRegistry, id, authProvider, preferCustomEndpoint)) return id;
  }
  return undefined;
}
