import { describe, it, expect } from 'bun:test';
import { getPiApiKeyProviders, getPiModelsForAuthProvider } from '../src/config/models-pi.ts';

describe('models-pi filtering', () => {
  it('excludes codex-mini-latest for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.includes('pi/codex-mini-latest')).toBe(false);
  });

  it('excludes all gpt-4* models for openai models', () => {
    const models = getPiModelsForAuthProvider('openai');
    const ids = models.map(m => m.id);
    expect(ids.some(id => id.startsWith('pi/gpt-4'))).toBe(false);
  });

  it('excludes deprecated Claude Opus 4.6 models from Anthropic catalogs', () => {
    const anthropicIds = getPiModelsForAuthProvider('anthropic').map(m => m.id);
    expect(anthropicIds).not.toContain('pi/claude-opus-4-6');

  });

  it('includes DeepSeek in the Pi API key provider list with a human-readable label', () => {
    const providers = getPiApiKeyProviders();
    expect(providers.some(provider => provider.key === 'deepseek' && provider.label === 'DeepSeek')).toBe(true);
  });

  it('returns current DeepSeek models from the Pi SDK catalog', () => {
    const models = getPiModelsForAuthProvider('deepseek');
    const ids = models.map(m => m.id);
    expect(ids).toContain('pi/deepseek-v4-flash');
    expect(ids).toContain('pi/deepseek-v4-pro');
  });

  it('supplements the catalog with repo-owned DeepSeek V4.1 Flash', () => {
    const models = getPiModelsForAuthProvider('deepseek');
    const flash = models.find(m => m.id === 'pi/deepseek-flash');
    expect(flash).toBeDefined();
    expect(flash?.name).toBe('DeepSeek V4.1 Flash');
    expect(flash?.contextWindow).toBe(1000000);
    expect(flash?.supportsThinking).toBe(true);
    expect(flash?.supportsImages).toBe(true);
  });
});
