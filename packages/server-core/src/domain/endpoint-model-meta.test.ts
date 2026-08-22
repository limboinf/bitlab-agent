import { describe, expect, it } from 'bun:test'
import { parseEndpointModelMeta } from './endpoint-model-meta.ts'

/** Shape OpenRouter returns from GET /api/v1/models. */
const OPENROUTER_PAYLOAD = {
  data: [
    {
      id: 'stealth/ox-alpha',
      name: 'Ox Alpha',
      context_length: 1048576,
      architecture: {
        modality: 'text+image+video->text',
        input_modalities: ['text', 'image', 'video'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'some/text-only',
      context_length: 32768,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
    },
  ],
}

describe('parseEndpointModelMeta', () => {
  it('reads the context window and image support for a listed model', () => {
    expect(parseEndpointModelMeta(OPENROUTER_PAYLOAD, 'stealth/ox-alpha')).toEqual({
      contextWindow: 1048576,
      supportsImages: true,
    })
  })

  it('reports text-only models as not supporting images', () => {
    expect(parseEndpointModelMeta(OPENROUTER_PAYLOAD, 'some/text-only')).toEqual({
      contextWindow: 32768,
      supportsImages: false,
    })
  })

  it('matches a stored pi/-prefixed ID against the endpoint bare ID', () => {
    expect(parseEndpointModelMeta(OPENROUTER_PAYLOAD, 'pi/stealth/ox-alpha')?.contextWindow)
      .toBe(1048576)
  })

  it('returns null when the model is absent', () => {
    expect(parseEndpointModelMeta(OPENROUTER_PAYLOAD, 'nope/missing')).toBeNull()
  })

  it('returns null for a payload without a data array', () => {
    expect(parseEndpointModelMeta({ models: [] }, 'anything')).toBeNull()
    expect(parseEndpointModelMeta(null, 'anything')).toBeNull()
  })

  it('falls back to the combined modality string when input_modalities is absent', () => {
    const payload = { data: [{ id: 'legacy', architecture: { modality: 'text+image->text' } }] }
    expect(parseEndpointModelMeta(payload, 'legacy')).toEqual({ supportsImages: true })
  })

  it('accepts the alternate context field names other gateways use', () => {
    expect(parseEndpointModelMeta({ data: [{ id: 'a', context_window: 200000 }] }, 'a'))
      .toEqual({ contextWindow: 200000 })
    expect(parseEndpointModelMeta({ data: [{ id: 'b', max_context_length: 8192 }] }, 'b'))
      .toEqual({ contextWindow: 8192 })
  })

  it('rejects nonsense context values rather than storing them', () => {
    expect(parseEndpointModelMeta({ data: [{ id: 'a', context_length: -1 }] }, 'a')).toBeNull()
    expect(parseEndpointModelMeta({ data: [{ id: 'a', context_length: 0 }] }, 'a')).toBeNull()
    expect(parseEndpointModelMeta({ data: [{ id: 'a', context_length: 1e9 }] }, 'a')).toBeNull()
  })

  it('returns null when an entry carries no usable capability at all', () => {
    expect(parseEndpointModelMeta({ data: [{ id: 'a', owned_by: 'someone' }] }, 'a')).toBeNull()
  })
})
