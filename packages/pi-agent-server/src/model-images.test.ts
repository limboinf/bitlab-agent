import { describe, expect, it } from 'bun:test';
import { getModels } from '@earendil-works/pi-ai/compat';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { resolvePiModel } from './model-resolution.ts';
import { applyPiCatalogModelOverrides, getPiModelsForAuthProvider } from '../../shared/src/config/models-pi.ts';

describe('DeepSeek Flash image delivery', () => {
  for (const id of [
    'deepseek-v4-flash',
    'pi/deepseek-v4-flash',
    'deepseek-v4-flash-vision-exp',
    'deepseek-flash',
  ]) {
    it(`preserves uploaded images in the SDK HTTP payload for ${id}`, async () => {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify('deepseek', async () => ({ type: 'api_key', key: 'test-only' }));
      const registry = new ModelRegistry(
        await ModelRuntime.create({ credentials, refreshOnCreate: false }),
      );
      const model = resolvePiModel(registry, id, 'deepseek')!;
      expect(await registry.getApiKeyAndHeaders(model)).toMatchObject({ ok: true, apiKey: 'test-only' });
      let payload: any;
      const result = stream(model, { messages: [{ role: 'user', timestamp: 0, content: [
        { type: 'text', text: '这是什么？' },
        { type: 'image', mimeType: 'image/png', data: 'fixture-image' },
      ] }] }, { apiKey: 'test-only', onPayload: value => {
        payload = value;
        throw new Error('Captured before network');
      } });
      await result.result();
      expect(payload.messages[0].content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,fixture-image' } });
      expect(JSON.stringify(payload)).not.toContain('image omitted');
      expect(model.provider).toBe('deepseek');
      expect(model.id).toBe(id.replace(/^pi\//, ''));
      expect(model.compat?.thinkingFormat).toBe('deepseek');
      expect(model.maxTokens).toBe(384000);
      expect(model.thinkingLevelMap?.max).toBe('max');
    });
  }

  it('reports vision for the legacy Flash ID in the picker too', () => {
    expect(getPiModelsForAuthProvider('deepseek').find(m => m.id === 'pi/deepseek-v4-flash')?.supportsImages).toBe(true);
  });

  it('does not mutate the SDK catalog, Pro, or custom gateway metadata', () => {
    const flash = getModels('deepseek').find(m => m.id === 'deepseek-v4-flash')!;
    const originalInput = [...flash.input];
    expect(applyPiCatalogModelOverrides(flash).input).toContain('image');
    expect(flash.input).toEqual(originalInput);
    const pro = getModels('deepseek').find(m => m.id === 'deepseek-v4-pro')!;
    expect(applyPiCatalogModelOverrides(pro)).toBe(pro);
    const custom = { ...flash, provider: 'custom-endpoint', input: ['text'] as ['text'] };
    expect(applyPiCatalogModelOverrides(custom)).toBe(custom);
  });

  it('preserves explicit custom endpoint precedence for the new ID', () => {
    const custom = { ...getModels('deepseek')[0]!, id: 'deepseek-flash', provider: 'custom-endpoint' };
    const registry = { find: (provider: string) => provider === 'custom-endpoint' ? custom : undefined, getAll: () => [custom] };
    expect(resolvePiModel(registry as never, 'deepseek-flash', 'deepseek', true)).toBe(custom);
  });
});
