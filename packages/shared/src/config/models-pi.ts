/**
 * Pi Model & Provider Discovery (from SDK)
 *
 * Separated from models.ts because @earendil-works/pi-ai transitively pulls in
 * @aws-sdk/client-bedrock-runtime → @smithy/node-http-handler → Node.js `stream`,
 * which breaks the Vite renderer build (browser context, no Node.js modules).
 *
 * This file should ONLY be imported from:
 *   - Main process code (Electron main, IPC handlers)
 *   - Server-side code (build scripts, CLI)
 *   - Registration calls (e.g., registerPiModelResolver)
 *
 * NEVER import this file from renderer components or from files that the renderer imports.
 */

import { getProviders, getModels } from '@earendil-works/pi-ai/compat';
// `BuiltinProvider` is the catalog's own provider union — narrower than the
// package-root `KnownProvider`, which also covers runtime-only providers.
import type { BuiltinProvider } from '@earendil-works/pi-ai/compat';
import type { Model, Api } from '@earendil-works/pi-ai';
import type { ModelDefinition } from './models.ts';

// ============================================
// PI MODEL DISCOVERY
// ============================================

/**
 * Convert a Pi SDK Model to our ModelDefinition format.
 */
function piModelToDefinition(m: Model<Api>): ModelDefinition {
  const lastPart = m.name.split(/[\s-]/).pop() ?? m.name;
  const shortName = m.name.length > 20 ? lastPart : m.name;

  return {
    id: `pi/${m.id}`,
    name: m.name,
    shortName,
    description: `${m.provider} model via Pi`,
    provider: 'pi',
    contextWindow: m.contextWindow,
    supportsThinking: m.reasoning,
    // Kept so connection metadata records image capability — the runtime
    // prefers it over family inference when registering unknown models.
    ...(m.input?.includes('image') ? { supportsImages: true } : {}),
  };
}

/**
 * Models to EXCLUDE from the Pi model list.
 * Temporary workaround for models that are broken in the current Pi SDK version.
 * e.g., gemini-1.5-flash fails with "not found for API version v1beta"
 */
const PI_EXCLUDED_MODELS: Set<string> = new Set([
  // Unsupported 1.5 models
  'gemini-1.5-flash',
  'gemini-1.5-flash-8b',
  'gemini-1.5-pro',

  // Unsupported 2.0 models
  'gemini-2.0-flash',
  'gemini-2.0-flash-lite',

  // Stale alias exposed by some SDK catalogs; fails at runtime in OpenAI API-key flow
  'codex-mini-latest',
]);

/**
 * Prefixes to EXCLUDE from the Pi model list.
 * Keep this list narrow and intentional.
 */
const PI_EXCLUDED_MODEL_PREFIXES: string[] = [
  // Requested cleanup: hide legacy GPT-4 family variants (gpt-4, gpt-4.1, gpt-4o, ...)
  'gpt-4',
];

export function isDeprecatedClaudeOpus46Model(modelId: string): boolean {
  const lower = modelId.toLowerCase().replace(/^pi\//, '');
  return lower === 'claude-opus-4-6'
    || lower === 'claude-opus-4.6'
    || lower === 'anthropic/claude-opus-4-6'
    || lower === 'anthropic/claude-opus-4.6'
    || lower.endsWith('.anthropic.claude-opus-4-6-v1')
    || lower === 'anthropic.claude-opus-4-6-v1';
}

function isExcludedPiModel(modelId: string): boolean {
  if (PI_EXCLUDED_MODELS.has(modelId)) return true;
  if (isDeprecatedClaudeOpus46Model(modelId)) return true;
  return PI_EXCLUDED_MODEL_PREFIXES.some(prefix => modelId.startsWith(prefix));
}

/**
 * Check if a Bedrock model ID is a bare Claude model without a region prefix.
 * Bare IDs like `anthropic.claude-opus-4-8` are rejected by Bedrock which
 * requires inference profile IDs with a region prefix (`us.`, `eu.`, `global.`).
 * The Pi SDK catalog includes proper regional variants, so filtering bare models
 * doesn't remove any usable entries.
 */
function isBareBedrockClaudeModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.claude-');
}

// ============================================
// PI CATALOG SUPPLEMENTS
// ============================================

/**
 * Repo-owned additions to the bundled Pi SDK catalog.
 *
 * The SDK catalog only refreshes when the dependency is upgraded, so models
 * released in the meantime never reach the static model lists even though the
 * endpoint already serves them (the pi-agent-server registers unknown ids
 * synthetically at request time). Entries mirror the generated catalog shape
 * and are merged into every catalog read; an entry drops out automatically
 * once an SDK upgrade ships the same id.
 */
const DEEPSEEK_V41_FLASH: Model<Api> = {
  // DeepSeek V4.1 Flash (2026-09-10): native multimodal successor —
  // deepseek-v4-flash / -vision-exp already route here, v4-pro follows on
  // 2026-09-14. Cost is the off-peak CNY rate (1 input / 4 output / 0.02
  // cache-read per Mtok) in USD at the catalog's usual ~7.1 rate; peak doubles.
  id: 'deepseek-flash',
  name: 'DeepSeek V4.1 Flash',
  api: 'openai-completions',
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    requiresReasoningContentOnAssistantMessages: true,
    thinkingFormat: 'deepseek',
  },
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: 'high', max: 'max' },
  input: ['text', 'image'],
  cost: { input: 0.14, output: 0.56, cacheRead: 0.0028, cacheWrite: 0 },
  contextWindow: 1000000,
  maxTokens: 384000,
};

const PI_EXTRA_MODELS: Model<Api>[] = [
  DEEPSEEK_V41_FLASH,
  {
    ...DEEPSEEK_V41_FLASH,
    id: 'deepseek-v4-flash-vision-exp',
    name: 'DeepSeek V4 Flash Vision (legacy alias)',
  },
];

/** Return only an explicit repo supplement, never an SDK catalog entry. */
export function getPiCatalogSupplementModel(
  piAuthProvider: string,
  modelId: string,
): Model<Api> | undefined {
  return PI_EXTRA_MODELS.find(model =>
    model.provider === piAuthProvider
    && model.id === modelId
    && !isExcludedPiModel(model.id));
}

/** Official Flash aliases changed backend on 2026-09-10. Do not apply this
 * to Pro (not migrated yet), or to identically named third-party models.
 * Preserve routing, auth, compat and any unrelated registry overrides. */
export function applyPiCatalogModelOverrides<T extends Model<Api>>(model: T): T {
  if (model.provider !== 'deepseek' || ![
    'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp',
  ].includes(model.id) || model.input.includes('image')) return model;
  return { ...model, input: [...model.input, 'image'] };
}

/**
 * Read the Pi SDK catalog for a provider, merged with repo-owned additions.
 * Unknown providers yield an empty list, never a throw.
 */
export function getPiCatalogModels(piAuthProvider: string): Model<Api>[] {
  let models: Model<Api>[] = [];
  try {
    models = getModels(piAuthProvider as BuiltinProvider);
  } catch {
    // Provider not recognized by SDK — extras may still apply below
  }
  const known = new Set(models.map(m => m.id));
  return [
    ...models.map(applyPiCatalogModelOverrides),
    ...PI_EXTRA_MODELS.filter(m =>
      m.provider === piAuthProvider
      && !known.has(m.id)
      && !isExcludedPiModel(m.id)),
  ];
}

/**
 * Get Pi models for a specific auth provider directly from the Pi SDK.
 */
export function getPiModelsForAuthProvider(piAuthProvider: string): ModelDefinition[] {
  return getPiCatalogModels(piAuthProvider)
    .filter(m => !isExcludedPiModel(m.id))
    // Bedrock: exclude bare Claude models without region prefix — they're
    // always rejected by Bedrock which requires inference profiles (us.*/eu.*/global.*).
    // Regional variants from the same catalog are kept.
    .filter(m => piAuthProvider !== 'amazon-bedrock' || !isBareBedrockClaudeModel(m.id))
    .map(piModelToDefinition);
}

/**
 * Get all Pi models across all providers from the SDK.
 */
export function getAllPiModels(): ModelDefinition[] {
  const allModels: ModelDefinition[] = [];
  for (const provider of getProviders()) {
    allModels.push(...getPiCatalogModels(provider)
      .filter(m => !isExcludedPiModel(m.id))
      .map(piModelToDefinition));
  }
  return allModels;
}

// ============================================
// PI PROVIDER DISCOVERY
// ============================================

/**
 * Display metadata for Pi SDK providers.
 *
 * Keep this keyed by string instead of `KnownProvider` so the UI metadata can
 * stay ahead of or lag behind the SDK's exact provider union without blocking
 * typecheck/commits when providers are added or renamed upstream.
 */
const PI_PROVIDER_DISPLAY: Partial<Record<string, { label: string; placeholder: string }>> = {
  'anthropic':              { label: 'Anthropic',          placeholder: 'sk-ant-...' },
  'google':                 { label: 'Google AI Studio',   placeholder: 'AIza...' },
  'openai':                 { label: 'OpenAI',             placeholder: 'sk-...' },
  'openrouter':             { label: 'OpenRouter',         placeholder: 'sk-or-...' },
  'groq':                   { label: 'Groq',               placeholder: 'gsk_...' },
  'mistral':                { label: 'Mistral',            placeholder: 'Paste your key here...' },
  'deepseek':               { label: 'DeepSeek',           placeholder: 'sk-...' },
  'xai':                    { label: 'xAI (Grok)',         placeholder: 'xai-...' },
  'cerebras':               { label: 'Cerebras',           placeholder: 'csk-...' },
  'azure-openai-responses': { label: 'Azure OpenAI',       placeholder: 'Paste your key here...' },
  'vercel-ai-gateway':      { label: 'Vercel AI Gateway',  placeholder: 'Paste your key here...' },
  'huggingface':            { label: 'Hugging Face',       placeholder: 'hf_...' },
  'minimax':                { label: 'Minimax',            placeholder: 'Paste your key here...' },
  'kimi-coding':            { label: 'Kimi (Coding)',      placeholder: 'sk-kimi-...' },
  'zai':                    { label: 'z.ai (GLM)',         placeholder: 'Paste your key here...' },
};

/** Info for a Pi provider available in the API key flow. */
export interface PiProviderInfo {
  key: string;
  label: string;
  placeholder: string;
}

/** Convert 'vercel-ai-gateway' → 'Vercel Ai Gateway' etc. */
function formatProviderName(key: string): string {
  return key.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Get all Pi providers available for API key authentication.
 */
export function getPiApiKeyProviders(): PiProviderInfo[] {
  return getProviders()
    .filter(p => p in PI_PROVIDER_DISPLAY)
    .map(p => {
      const display = PI_PROVIDER_DISPLAY[p];
      return {
        key: p,
        label: display?.label ?? formatProviderName(p),
        placeholder: display?.placeholder ?? 'sk-...',
      };
    })
    .sort((a, b) => {
      const priority = ['anthropic', 'google', 'openai'];
      const ai = priority.indexOf(a.key);
      const bi = priority.indexOf(b.key);
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.label.localeCompare(b.label);
    });
}

/**
 * Get the base URL for a Pi SDK provider (e.g. 'anthropic' → 'https://api.anthropic.com').
 */
export function getPiProviderBaseUrl(provider: string): string | undefined {
  try {
    const models = getModels(provider as Parameters<typeof getModels>[0]);
    return models[0]?.baseUrl || undefined;
  } catch {
    return undefined;
  }
}
