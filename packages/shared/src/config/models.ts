/**
 * Model definitions and display helpers.
 *
 * There is no hardcoded model list here: every model comes from the Pi SDK
 * catalog (see models-pi.ts), so new models arrive with an SDK upgrade.
 * This file stays renderer-safe — it must not import the SDK.
 */

// ============================================
// TYPES
// ============================================

/**
 * Provider identifier for AI backends.
 */
export type ModelProvider = 'pi';

/**
 * Full model definition with capabilities and costs.
 * Used throughout the application for model selection and display.
 */
export interface ModelDefinition {
  /** Model identifier (e.g., 'claude-sonnet-4-6', 'gpt-5.3-codex') */
  id: string;
  /** Human-readable name (e.g., 'Sonnet 4.6', 'Codex') */
  name: string;
  /** Short display name for compact UI (e.g., 'Sonnet', 'Codex') */
  shortName: string;
  /** Brief description of the model's strengths */
  description: string;
  /** Provider that offers this model */
  provider: ModelProvider;
  /** Maximum context window in tokens */
  contextWindow: number;
  /** Whether this model supports thinking/reasoning effort. Defaults to true when undefined. */
  supportsThinking?: boolean;
  /** Explicit per-model image input capability hint, primarily for custom endpoints. */
  supportsImages?: boolean;
}

// ============================================
// UTILITY MODELS
// ============================================

/**
 * Fallback summarization model, used only when no connection context is
 * available. For connection-aware resolution, use getSummarizationModel(connection).
 */
export function getDefaultSummarizationModel(): string {
  return 'claude-haiku-4-5';
}

// ============================================
// DISPLAY HELPERS
// ============================================

/**
 * Strip Bedrock inference-profile decorations so any region/version variant
 * reads the same as its bare Anthropic ID,
 * e.g. "us.anthropic.claude-haiku-4-5-20251001-v1:0" → "claude-haiku-4-5-20251001".
 */
function stripBedrockDecorations(modelId: string): string {
  return modelId
    .replace(/^(?:[a-z]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '');
}

/**
 * Get display name for a model ID by humanizing it,
 * e.g. "claude-opus-4-8-20251101" → "Opus 4.8".
 */
export function getModelDisplayName(modelId: string): string {
  const stripped = stripBedrockDecorations(modelId)
    .replace('claude-', '')
    .replace(/-\d{8}$/, '');
  const [first, ...versionParts] = stripped.split('-');
  if (!first) return modelId;
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return versionParts.length ? `${name} ${versionParts.join('.')}` : name;
}

/**
 * Get short display name for a model ID.
 */
export function getModelShortName(modelId: string): string {
  // For provider-prefixed IDs (e.g. "openai/gpt-5"), show just the model part
  if (modelId.includes('/')) {
    return modelId.split('/').pop() || modelId;
  }
  return getModelDisplayName(modelId);
}

/**
 * Check if model is an Opus model (for cache TTL decisions).
 */
export function isOpusModel(modelId: string): boolean {
  return modelId.includes('opus');
}

/**
 * Check if a model ID refers to a Claude model.
 * Handles direct Anthropic IDs (e.g. "claude-sonnet-4-6"),
 * provider-prefixed IDs (e.g. "anthropic/claude-sonnet-4" via OpenRouter),
 * and Bedrock-native IDs (e.g. "anthropic.claude-opus-4-8").
 */
export function isClaudeModel(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower.startsWith('claude-') || lower.includes('/claude') || lower.includes('.claude');
}
