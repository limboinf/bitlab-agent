import { describe, it, expect } from 'bun:test';
import {
  parseProviderModelListing,
  mergeCatalogModelsWithListing,
  inferFamilyModelDefaults,
  isChatModelId,
  type ProviderListModelEntry,
} from '../src/config/provider-model-listing.ts';
import type { ModelDefinition } from '../src/config/models.ts';

function catalogDef(id: string, overrides: Partial<ModelDefinition> = {}): ModelDefinition {
  return {
    id,
    name: id,
    shortName: id,
    description: 'catalog model',
    provider: 'pi',
    contextWindow: 65536,
    ...overrides,
  };
}

describe('parseProviderModelListing', () => {
  it('reads the OpenAI listing shape', () => {
    const listing = parseProviderModelListing({
      data: [
        { id: 'glm-5.5', display_name: 'GLM-5.5' },
        { id: 'glm-4.7' },
      ],
    });
    expect(listing).toEqual([
      { id: 'glm-5.5', name: 'GLM-5.5' },
      { id: 'glm-4.7' },
    ]);
  });

  it('reads context window under the field names Ollama/OpenRouter/gateways use', () => {
    const listing = parseProviderModelListing({
      data: [
        { id: 'a', context_length: 131072 },
        { id: 'b', context_window: 262144 },
        { id: 'c', max_context_length: 1048576 },
        { id: 'd', context_length: -1 },
      ],
    });
    expect(listing).toEqual([
      { id: 'a', contextWindow: 131072 },
      { id: 'b', contextWindow: 262144 },
      { id: 'c', contextWindow: 1048576 },
      { id: 'd' },
    ]);
  });

  it('reads image support from both modality field shapes', () => {
    const listing = parseProviderModelListing({
      data: [
        { id: 'a', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'b', architecture: { modality: 'text+image->text' } },
        { id: 'c', architecture: { modality: 'text->text' } },
      ],
    });
    expect(listing).toEqual([
      { id: 'a', supportsImages: true },
      { id: 'b', supportsImages: true },
      { id: 'c', supportsImages: false },
    ]);
  });

  it('skips malformed rows and duplicates instead of failing the listing', () => {
    const listing = parseProviderModelListing({
      data: [{ id: '' }, { context_length: 1 }, null, { id: 'ok' }, { id: 'ok' }],
    });
    expect(listing).toEqual([{ id: 'ok' }]);
  });

  it('returns null when the payload is not a listing', () => {
    expect(parseProviderModelListing({ object: 'list' })).toBeNull();
    expect(parseProviderModelListing({ data: 'nope' })).toBeNull();
    expect(parseProviderModelListing(null)).toBeNull();
  });
});

describe('isChatModelId', () => {
  it('filters non-chat model families out of picker listings', () => {
    expect(isChatModelId('text-embedding-3-large')).toBe(false);
    expect(isChatModelId('bge-m3')).toBe(false);
    expect(isChatModelId('whisper-large-v3')).toBe(false);
    expect(isChatModelId('tts-1')).toBe(false);
    expect(isChatModelId('rerank-v2')).toBe(false);
    expect(isChatModelId('omni-moderation-latest')).toBe(false);
  });

  it('keeps chat models whose ids brush against the filter', () => {
    expect(isChatModelId('glm-5.2')).toBe(true);
    expect(isChatModelId('gpt-5.3-codex')).toBe(true);
    expect(isChatModelId('deepseek-v3.2')).toBe(true);
  });
});

describe('mergeCatalogModelsWithListing', () => {
  const listing: ProviderListModelEntry[] = [
    { id: 'glm-4.7', contextWindow: 999 }, // catalog already knows it — catalog wins
    { id: 'glm-5.5', name: 'GLM-5.5', contextWindow: 204800, supportsImages: true },
    { id: 'glm-5.5-air' },
  ];

  it('appends listing-only models and keeps catalog entries untouched', () => {
    const catalog = [catalogDef('pi/glm-4.7')];
    const merged = mergeCatalogModelsWithListing(catalog, listing);
    expect(merged).toHaveLength(3);
    // Catalog entry preserved field-for-field, no duplicate from the listing.
    expect(merged[0]).toEqual(catalogDef('pi/glm-4.7'));
    const ids = merged.map(m => m.id);
    expect(ids.filter(id => id === 'pi/glm-4.7')).toHaveLength(1);
  });

  it('gives new models pi-prefixed ids and listing-disclosed capabilities', () => {
    const merged = mergeCatalogModelsWithListing([catalogDef('pi/glm-4.7')], listing);
    const fresh = merged.find(m => m.id === 'pi/glm-5.5');
    expect(fresh?.name).toBe('GLM-5.5');
    expect(fresh?.contextWindow).toBe(204800);
    expect(fresh?.supportsImages).toBe(true);
    expect(fresh?.provider).toBe('pi');
  });

  it('marks new models reasoning when the provider catalog is all-reasoning', () => {
    // z.ai-style family: every catalog model thinks. A new release flagged
    // non-reasoning could never be told to stop thinking, because z.ai turns
    // thinking ON by default when the request omits the parameter.
    const catalog = [catalogDef('pi/glm-4.7'), catalogDef('pi/glm-5.2')];
    const merged = mergeCatalogModelsWithListing(catalog, [{ id: 'glm-5.5' }]);
    expect(merged.find(m => m.id === 'pi/glm-5.5')?.supportsThinking).toBe(true);
  });

  it('leaves reasoning unset for a mixed-reasoning catalog', () => {
    // The listing cannot disclose reasoning; guessing true here could send
    // effort parameters to a non-reasoning model.
    const catalog = [catalogDef('pi/chat', { supportsThinking: false }), catalogDef('pi/reasoner')];
    const merged = mergeCatalogModelsWithListing(catalog, [{ id: 'model-new' }]);
    expect(merged.find(m => m.id === 'pi/model-new')?.supportsThinking).toBeUndefined();
  });

  it('gives a silent listing entry the family\'s typical window', () => {
    // The listing said only "glm-5.5" exists; its siblings say what that means.
    const catalog = [
      catalogDef('pi/glm-5.1', { contextWindow: 200_000 }),
      catalogDef('pi/glm-5.2', { contextWindow: 200_000 }),
      catalogDef('pi/glm-4.5-air', { contextWindow: 131_072 }),
    ];
    const merged = mergeCatalogModelsWithListing(catalog, [{ id: 'glm-5.5' }]);
    expect(merged.find(m => m.id === 'pi/glm-5.5')?.contextWindow).toBe(200_000);
  });

  it('falls back to the default context window when nothing discloses one', () => {
    const merged = mergeCatalogModelsWithListing([], [{ id: 'glm-5.5-air' }]);
    expect(merged[0]?.contextWindow).toBe(131072);
    expect(merged[0]?.supportsImages).toBeUndefined();
    expect(merged[0]?.supportsThinking).toBeUndefined();
  });

  it('returns the catalog as-is when the listing adds nothing', () => {
    const catalog = [catalogDef('pi/glm-4.7')];
    const merged = mergeCatalogModelsWithListing(catalog, [{ id: 'glm-4.7' }]);
    expect(merged).toEqual(catalog);
  });
});

describe('inferFamilyModelDefaults', () => {
  // z.ai's listing returns bare ids, so the GLM catalog is the only evidence
  // about a new release. 131K would be wrong by an order of magnitude here.
  const glmFamily = [
    { contextWindow: 131_072, maxTokens: 98_304, supportsThinking: true },
    { contextWindow: 200_000, maxTokens: 131_072, supportsThinking: true },
    { contextWindow: 200_000, maxTokens: 131_072, supportsThinking: true },
    { contextWindow: 1_000_000, maxTokens: 131_072, supportsThinking: true },
    { contextWindow: 200_000, maxTokens: 131_072, supportsThinking: true, supportsImages: true },
  ];

  it('takes the family\'s most common window and output cap', () => {
    const defaults = inferFamilyModelDefaults(glmFamily);
    expect(defaults.contextWindow).toBe(200_000);
    expect(defaults.maxTokens).toBe(131_072);
  });

  it('asserts a capability only when the whole family agrees', () => {
    const defaults = inferFamilyModelDefaults(glmFamily);
    expect(defaults.supportsThinking).toBe(true);
    // One vision model among five says nothing about the next release.
    expect(defaults.supportsImages).toBeUndefined();
  });

  it('breaks ties toward the smaller window', () => {
    // An underestimate compacts early; an overestimate grows a turn until the
    // provider rejects it.
    const defaults = inferFamilyModelDefaults([
      { contextWindow: 200_000 },
      { contextWindow: 1_000_000 },
    ]);
    expect(defaults.contextWindow).toBe(200_000);
  });

  it('falls back to the flat default for an empty or silent family', () => {
    expect(inferFamilyModelDefaults([]).contextWindow).toBe(131_072);
    expect(inferFamilyModelDefaults([{}]).maxTokens).toBeUndefined();
  });
});
