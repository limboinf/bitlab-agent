/** Named Pi provider and custom endpoint configurations. */

import type { ModelDefinition } from './models.ts';

type PiModelResolver = (piAuthProvider?: string) => ModelDefinition[];
let piModelResolver: PiModelResolver = () => [];

export function registerPiModelResolver(resolver: PiModelResolver): void {
  piModelResolver = resolver;
}

export type LlmProviderType = 'pi' | 'pi_compat';
export type LlmAuthType = 'api_key' | 'api_key_with_endpoint' | 'oauth' | 'none';
export type ModelSelectionMode = 'automaticallySyncedFromProvider' | 'userDefined3Tier';
export type CustomEndpointApi = 'openai-completions' | 'anthropic-messages';
export type MidStreamBehavior = 'steer' | 'queue';

export interface CustomEndpointConfig {
  api: CustomEndpointApi;
  supportsImages?: boolean;
  /** Ask the endpoint for reasoning by sending a reasoning-effort parameter.
   *  Off by default: endpoints that don't understand it reject the request.
   *  Per-model `supportsThinking` overrides this. */
  supportsThinking?: boolean;
}

export interface LlmConnection {
  slug: string;
  name: string;
  providerType: LlmProviderType;
  baseUrl?: string;
  authType: LlmAuthType;
  models?: Array<ModelDefinition | string>;
  defaultModel?: string;
  modelSelectionMode?: ModelSelectionMode;
  piAuthProvider?: string;
  customEndpoint?: CustomEndpointConfig;
  midStreamBehavior?: MidStreamBehavior;
  createdAt: number;
  lastUsedAt?: number;
}

export interface LlmConnectionWithStatus extends LlmConnection {
  isAuthenticated: boolean;
  authError?: string;
  isDefault?: boolean;
}

/**
 * Returns true when `modelId` must not be used as the mini/summarization model.
 * `codex-mini-latest` is always denied. ChatGPT subscription auth also rejects
 * every `*codex-mini*` variant, while regular OpenAI API keys remain unaffected.
 */
export function isDeniedMiniModelId(modelId: string, piAuthProvider?: string): boolean {
  const bare = modelId.startsWith('pi/') ? modelId.slice(3) : modelId;
  if (piAuthProvider === 'openai-codex' && bare.includes('codex-mini')) return true;
  return bare === 'codex-mini-latest';
}

function findSmallModel(
  connection: Pick<LlmConnection, 'models' | 'piAuthProvider'>,
): string | undefined {
  if (!connection.models?.length) return undefined;
  const idOf = (model: ModelDefinition | string): string =>
    typeof model === 'string' ? model : model.id;
  const searchText = (model: ModelDefinition | string): string =>
    typeof model === 'string'
      ? model.toLowerCase()
      : `${model.id} ${model.name} ${model.shortName}`.toLowerCase();
  const allowed = connection.models.filter(model => !isDeniedMiniModelId(idOf(model), connection.piAuthProvider));
  const preferred = allowed.find(model =>
    ['mini', 'haiku', 'flash'].some(keyword => searchText(model).includes(keyword))
  );
  const fallback = preferred ?? allowed.at(-1) ?? connection.models.at(-1);
  return fallback ? idOf(fallback) : undefined;
}

export function getMiniModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

export function getSummarizationModel(
  connection: Pick<LlmConnection, 'models' | 'providerType' | 'piAuthProvider'>,
): string | undefined {
  return findSmallModel(connection);
}

export function generateSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(slug);
}

export function getLlmCredentialKey(slug: string): string {
  return `llm::${slug}::api_key`;
}

export type LlmCredentialStorageType = 'api_key' | 'oauth' | null;

export function authTypeToCredentialStorageType(authType: LlmAuthType): LlmCredentialStorageType {
  if (authType === 'none') return null;
  return authType === 'oauth' ? 'oauth' : 'api_key';
}

export function authTypeToCredentialType(authType: LlmAuthType): 'api_key' | 'oauth_token' | null {
  if (authType === 'oauth') return 'oauth_token';
  return authType === 'none' ? null : 'api_key';
}

export function authTypeRequiresEndpoint(authType: LlmAuthType): boolean {
  return authType === 'api_key_with_endpoint';
}

export function isCompatProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi_compat';
}

export function isLocalConnection(connection: Pick<LlmConnection, 'baseUrl'>): boolean {
  if (!connection.baseUrl?.trim()) return false;
  try {
    const hostname = new URL(connection.baseUrl.trim()).hostname.replace(/^\[|\]$/g, '');
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

export type OllamaKind = 'local' | 'cloud';

/** Default port of a local Ollama server. */
const OLLAMA_LOCAL_PORT = '11434';

/**
 * Tell a local Ollama server apart from Ollama Cloud by base URL.
 * Local: the default 11434 port or an "ollama" hostname (e.g. a LAN box).
 * Cloud: anything under ollama.com.
 */
export function detectOllamaKind(baseUrl?: string | null): OllamaKind | null {
  if (!baseUrl?.trim()) return null;
  try {
    const { hostname, port } = new URL(baseUrl.trim());
    const host = hostname.toLowerCase();
    if (host === 'ollama.com' || host.endsWith('.ollama.com')) return 'cloud';
    if (port === OLLAMA_LOCAL_PORT || host.includes('ollama')) return 'local';
    return null;
  } catch {
    return baseUrl.toLowerCase().includes('ollama') ? 'local' : null;
  }
}

/** Provider label for an Ollama endpoint, or null when it is not Ollama. */
export function ollamaDisplayName(baseUrl?: string | null): string | null {
  const kind = detectOllamaKind(baseUrl);
  if (!kind) return null;
  return kind === 'cloud' ? 'Ollama Cloud' : 'Ollama (Local)';
}

export function isPiProvider(providerType: LlmProviderType): boolean {
  return providerType === 'pi' || providerType === 'pi_compat';
}

export function defaultMidStreamBehavior(_providerType: LlmProviderType): MidStreamBehavior {
  return 'steer';
}

export function resolveMidStreamBehavior(
  connection: Pick<LlmConnection, 'midStreamBehavior' | 'providerType'>,
): MidStreamBehavior {
  return connection.midStreamBehavior === 'queue' || connection.midStreamBehavior === 'steer'
    ? connection.midStreamBehavior
    : defaultMidStreamBehavior(connection.providerType);
}

export function setModelSupportsImages(
  connection: LlmConnection,
  modelId: string,
  enabled: boolean,
): LlmConnection {
  if (!connection.models) return connection;
  const index = connection.models.findIndex(model =>
    (typeof model === 'string' ? model : model.id) === modelId
  );
  if (index < 0) return connection;
  const current = connection.models[index]!;
  const next = typeof current === 'string'
    ? ({ id: current, name: current, shortName: current, supportsImages: enabled } as ModelDefinition)
    : { ...current, supportsImages: enabled };
  const models = [...connection.models];
  models[index] = next;
  return { ...connection, models };
}

export function modelSupportsImages(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'customEndpoint'>,
  modelId: string,
): boolean {
  if (!isCompatProvider(connection.providerType)) return true;
  const model = connection.models?.find(candidate =>
    (typeof candidate === 'string' ? candidate : candidate.id) === modelId
  );
  if (model && typeof model !== 'string' && typeof model.supportsImages === 'boolean') {
    return model.supportsImages;
  }
  return connection.customEndpoint?.supportsImages ?? false;
}

/**
 * Resolve a model's context window from durable configuration alone.
 *
 * Deliberately config-only: the agent runtime knows the window too, but it does
 * not exist between app launches, and a session that was reopened still has to
 * be able to meter itself. Resolving here also means a model swapped while the
 * app was closed is reflected, where replaying a stored number would not be.
 *
 * Order matters. A connection's own model entry wins because it is the only
 * place a custom endpoint's capabilities are recorded — the shared catalog has
 * never heard of a hand-typed model ID. Returns undefined when nothing knows,
 * leaving the caller to decide between a stale reading and none.
 */
export function resolveModelContextWindow(
  connection: Pick<LlmConnection, 'providerType' | 'models' | 'piAuthProvider'> | undefined,
  modelId: string | undefined,
): number | undefined {
  if (!modelId) return undefined;

  const configured = connection?.models?.find(candidate =>
    (typeof candidate === 'string' ? candidate : candidate.id) === modelId
  );
  if (configured && typeof configured !== 'string' && configured.contextWindow) {
    return configured.contextWindow;
  }

  const fromProvider = getModelsForProviderType(
    connection?.providerType ?? 'pi',
    connection?.piAuthProvider,
  ).find(model => model.id === modelId)?.contextWindow;
}

export function getModelsForProviderType(
  providerType: LlmProviderType,
  piAuthProvider?: string,
): ModelDefinition[] {
  return providerType === 'pi' ? piModelResolver(piAuthProvider) : [];
}

/**
 * Which models make a good default, per Pi auth provider. Expressed as rules,
 * not model IDs, so a newly released model ranks first as soon as an SDK
 * upgrade ships it.
 *
 * - `families`: ID prefixes in preference order ("claude-opus" before "claude-sonnet").
 * - `variants`: suffixes after the version, in preference order; '' is the bare ID.
 *   Anything else (-pro, -mini, -preview, …) is not preferred.
 *
 * Within a family, the newest version wins; the variant only breaks ties.
 */
interface ModelPreference {
  families: string[];
  variants: string[];
}

const GPT_PREFERENCE: ModelPreference = {
  families: ['gpt'],
  variants: ['astra', 'sol', 'terra', 'luna', ''],
};

const PI_MODEL_PREFERENCES: Record<string, ModelPreference> = {
  anthropic: { families: ['claude-opus', 'claude-sonnet', 'claude-haiku'], variants: [''] },
  'openai-codex': GPT_PREFERENCE,
  openai: GPT_PREFERENCE,
  google: { families: ['gemini'], variants: ['flash', 'pro'] },
  deepseek: { families: ['deepseek'], variants: ['flash', 'pro'] },
};

interface PreferenceRank {
  family: number;
  version: number[];
  variant: number;
}

/**
 * Rank a model ID against a provider's preference, or undefined when it is not
 * a preferred model. "claude-opus-5-5" → family opus, version [5, 5], variant ''.
 */
function rankModel(modelId: string, preference: ModelPreference): PreferenceRank | undefined {
  const bare = modelId
    .replace(/^pi\//, '')
    .replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, ''); // snapshot date suffix
  const family = preference.families.findIndex(prefix => bare.startsWith(`${prefix}-`));
  if (family < 0) return undefined;

  const rest = bare.slice(preference.families[family]!.length + 1);
  const match = /^v?(\d+(?:[.-]\d+)*)(?:-(.+))?$/.exec(rest);
  // An unversioned ID ("deepseek-flash") is a rolling alias for the newest release.
  const version = match ? match[1]!.split(/[.-]/).map(Number) : [Infinity];
  const variant = preference.variants.indexOf(match ? match[2] ?? '' : rest);
  if (variant < 0) return undefined;

  return { family, version, variant };
}

function compareVersionsDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? -1) - (a[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The preferred models for a Pi auth provider, best first. Models the
 * preference does not cover are left out.
 */
export function pickPreferredModels<T extends { id: string }>(
  models: T[],
  piAuthProvider: string | undefined,
): T[] {
  const preference = piAuthProvider ? PI_MODEL_PREFERENCES[piAuthProvider] : undefined;
  if (!preference) return [];

  return models
    .map(model => ({ model, rank: rankModel(model.id, preference) }))
    .filter((entry): entry is { model: T; rank: PreferenceRank } => entry.rank !== undefined)
    .sort((a, b) =>
      a.rank.family - b.rank.family
      || compareVersionsDesc(a.rank.version, b.rank.version)
      || a.rank.variant - b.rank.variant)
    .map(entry => entry.model);
}

export function getDefaultModelsForConnection(
  providerType: LlmProviderType,
  piAuthProvider?: string,
): Array<ModelDefinition | string> {
  if (providerType === 'pi_compat') return [];
  const models = piModelResolver(piAuthProvider);
  const preferred = pickPreferredModels(models, piAuthProvider);
  return [...preferred, ...models.filter(model => !preferred.includes(model))];
}

export function getDefaultModelForConnection(
  providerType: LlmProviderType,
  piAuthProvider?: string,
): string {
  const first = getDefaultModelsForConnection(providerType, piAuthProvider)[0];
  return typeof first === 'string' ? first : first?.id ?? '';
}

export function resolveEffectiveConnectionSlug(
  sessionConnection: string | undefined,
  workspaceDefault: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug' | 'isDefault'>[],
): string | undefined {
  return sessionConnection
    ?? workspaceDefault
    ?? connections.find(connection => connection.isDefault)?.slug
    ?? connections[0]?.slug;
}

export function isSessionConnectionUnavailable(
  sessionConnection: string | undefined,
  connections: Pick<LlmConnectionWithStatus, 'slug'>[],
): boolean {
  return Boolean(sessionConnection && !connections.some(connection => connection.slug === sessionConnection));
}

export function isValidProviderAuthCombination(
  providerType: LlmProviderType,
  authType: LlmAuthType,
): boolean {
  return providerType === 'pi'
    ? authType === 'api_key' || authType === 'oauth'
    : authType === 'api_key_with_endpoint' || authType === 'none';
}
