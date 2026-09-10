import { RPC_CHANNELS, type LlmConnectionSetup } from '@bitlab/shared/protocol'
import {
  addLlmConnection,
  deleteLlmConnection,
  fetchProviderModelListing,
  inferFamilyModelDefaults,
  getDefaultLlmConnection,
  getDefaultModelForConnection,
  getDefaultModelsForConnection,
  getLlmConnection,
  getLlmConnections,
  getPiApiKeyProviders,
  getPiCatalogModels,
  getPiProviderBaseUrl,
  isCompatProvider,
  parseValidationError,
  setDefaultLlmConnection,
  setSetupDeferred,
  touchLlmConnection,
  updateLlmConnection,
  type CustomEndpointConfig,
  type LlmConnection,
  type LlmConnectionWithStatus,
} from '@bitlab/shared/config'
import { getCredentialManager } from '@bitlab/shared/credentials'
import { isMaskedCredentialValue } from '@bitlab/shared/credentials/types'
import {
  resolveSetupTestConnectionHint,
  testBackendConnection,
  validateStoredBackendConnection,
} from '@bitlab/shared/agent/backend'
import { getModelRefreshService } from '@bitlab/server-core/model-fetchers'
import {
  buildBackendHostRuntimeContext,
  getWorkspaceOrThrow,
} from '@bitlab/server-core/handlers'
import {
  fetchEndpointModelMeta,
  parseTestConnectionError,
  createBuiltInConnection,
  piAuthProviderDisplayName,
  resolveCustomEndpointSetup,
  setupTestRequiresApiKey,
  toStoredModels,
  validateModelList,
  validateSetupTestInput,
} from '@bitlab/server-core/domain'
import type { RpcServer } from '@bitlab/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { randomUUID } from 'node:crypto'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.llmConnections.LIST,
  RPC_CHANNELS.llmConnections.LIST_WITH_STATUS,
  RPC_CHANNELS.llmConnections.GET,
  RPC_CHANNELS.llmConnections.GET_API_KEY,
  RPC_CHANNELS.llmConnections.SAVE,
  RPC_CHANNELS.llmConnections.DELETE,
  RPC_CHANNELS.llmConnections.TEST,
  RPC_CHANNELS.llmConnections.SET_DEFAULT,
  RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT,
  RPC_CHANNELS.llmConnections.REFRESH_MODELS,
  RPC_CHANNELS.settings.SETUP_LLM_CONNECTION,
  RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP,
  RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS,
  RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL,
  RPC_CHANNELS.pi.GET_PROVIDER_MODELS,
  RPC_CHANNELS.pi.GET_ENDPOINT_MODEL_META,
  RPC_CHANNELS.chatgpt.START_OAUTH,
  RPC_CHANNELS.chatgpt.COMPLETE_OAUTH,
  RPC_CHANNELS.chatgpt.CANCEL_OAUTH,
  RPC_CHANNELS.chatgpt.GET_AUTH_STATUS,
  RPC_CHANNELS.chatgpt.LOGOUT,
] as const

function createConnection(setup: LlmConnectionSetup): LlmConnection {
  const baseUrl = setup.baseUrl?.trim() || undefined
  const baseSlug = setup.slug.replace(/-\d+$/, '')
  if (!baseUrl && baseSlug === 'chatgpt-plus') return createBuiltInConnection(setup.slug)
  const customEndpoint = baseUrl ? setup.customEndpoint : undefined
  const custom = customEndpoint
    ? resolveCustomEndpointSetup({
        baseUrl,
        credential: setup.credential,
        customEndpointApi: customEndpoint.api,
      })
    : undefined
  const providerType = customEndpoint ? 'pi_compat' : 'pi'
  const piAuthProvider = custom?.piAuthProvider ?? setup.piAuthProvider
  const models = setup.models?.length
    ? toStoredModels(setup.models)
    : getDefaultModelsForConnection(providerType, piAuthProvider)
  const defaultModel = setup.defaultModel
    ?? getDefaultModelForConnection(providerType, piAuthProvider)
  const providerName = piAuthProvider
    ? piAuthProviderDisplayName(piAuthProvider)
    : null

  return {
    slug: setup.slug,
    name: custom?.name
      ?? (providerName ?? 'API Key'),
    providerType,
    authType: custom?.authType ?? 'api_key',
    ...(baseUrl ? { baseUrl } : {}),
    ...(customEndpoint ? { customEndpoint } : {}),
    ...(piAuthProvider ? { piAuthProvider } : {}),
    models,
    ...(defaultModel ? { defaultModel } : {}),
    modelSelectionMode: setup.modelSelectionMode
      ?? (setup.models?.length ? 'userDefined3Tier' : 'automaticallySyncedFromProvider'),
    midStreamBehavior: 'steer',
    createdAt: Date.now(),
  }
}

export function registerLlmConnectionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps

  server.handle(RPC_CHANNELS.settings.SETUP_LLM_CONNECTION, async (_ctx, setup: LlmConnectionSetup) => {
    try {
      const existing = getLlmConnection(setup.slug)
      if (setup.updateOnly && !existing) {
        await getCredentialManager().deleteLlmCredentials(setup.slug).catch(() => {})
        return { success: false, error: 'Connection not found.' }
      }

      const connection = createConnection(setup)
      if (connection.models?.length) {
        const validation = validateModelList(connection.models, connection.defaultModel)
        if (!validation.valid) return { success: false, error: validation.error }
        if (validation.resolvedDefaultModel) {
          connection.defaultModel = validation.resolvedDefaultModel
        }
      }
      if (isCompatProvider(connection.providerType) && !connection.defaultModel) {
        return { success: false, error: 'Default model is required for compatible endpoints.' }
      }

      const persisted = existing
        ? updateLlmConnection(setup.slug, {
            ...connection,
            slug: undefined,
            // The form is authoritative. Without an explicit null, a connection
            // that once used a custom model ID could never go back to plain
            // catalog models — undefined means "keep" to updateLlmConnection.
            customEndpoint: connection.customEndpoint ?? null,
          } as Partial<Omit<LlmConnection, 'slug' | 'customEndpoint'>> & { customEndpoint: CustomEndpointConfig | null })
        : addLlmConnection(connection)
      if (!persisted) return { success: false, error: 'Failed to save connection.' }

      const isMasked = setup.credential?.includes('••')
      if (connection.authType !== 'oauth' && setup.credential && !isMasked) {
        await getCredentialManager().setLlmApiKey(setup.slug, setup.credential)
      }
      if (!getDefaultLlmConnection()) setDefaultLlmConnection(setup.slug)
      setSetupDeferred(false)
      await sessionManager.reinitializeAuth()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })

  server.handle(RPC_CHANNELS.settings.TEST_LLM_CONNECTION_SETUP, async (_ctx, params: {
    provider: 'pi'
    apiKey: string
    baseUrl?: string
    model?: string
    piAuthProvider?: string
    customEndpoint?: LlmConnection['customEndpoint']
  }) => {
    const validation = validateSetupTestInput(params)
    if (!validation.valid) return { success: false, error: validation.error }
    if (setupTestRequiresApiKey(params.baseUrl) && !params.apiKey.trim()) {
      return { success: false, error: 'API key is required' }
    }
    try {
      const connection = resolveSetupTestConnectionHint(params)
      const result = await testBackendConnection({
        provider: 'pi',
        apiKey: params.apiKey,
        model: params.model ?? '',
        baseUrl: params.baseUrl,
        connection,
        allowEmptyApiKey: !setupTestRequiresApiKey(params.baseUrl),
        hostRuntime: buildBackendHostRuntimeContext(deps.platform),
      })
      return result.success
        ? result
        : { success: false, error: parseTestConnectionError(result.error ?? 'Connection failed') }
    } catch (error) {
      return {
        success: false,
        error: parseTestConnectionError(error instanceof Error ? error.message : String(error)),
      }
    }
  })

  server.handle(RPC_CHANNELS.pi.GET_ENDPOINT_MODEL_META, async (_ctx, args: {
    baseUrl: string
    modelId: string
    apiKey?: string
  }) => {
    // A masked placeholder is not a usable bearer token. Most catalogs answer
    // /models unauthenticated anyway, so drop it and still try.
    const apiKey = args.apiKey && !isMaskedCredentialValue(args.apiKey) ? args.apiKey : undefined
    return fetchEndpointModelMeta({ baseUrl: args.baseUrl, modelId: args.modelId, apiKey })
  })

  server.handle(RPC_CHANNELS.pi.GET_API_KEY_PROVIDERS, async () => getPiApiKeyProviders())
  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_BASE_URL, async (_ctx, provider: string) => getPiProviderBaseUrl(provider))
  server.handle(RPC_CHANNELS.pi.GET_PROVIDER_MODELS, async (_ctx, provider: string, opts?: {
    baseUrl?: string
    apiKey?: string
    /** Editing an existing connection: its stored key authenticates the
     *  listing probe when the form holds none (the pre-filled one is masked). */
    connectionSlug?: string
  }) => {
    try {
      // Bundled SDK catalog merged with repo-owned supplements (see
      // PI_EXTRA_MODELS), so models released after the last SDK upgrade are
      // still listed with accurate capabilities instead of waiting for the
      // live listing probe below.
      const models = getPiCatalogModels(provider)
      const summaries = [...models]
        .sort((a, b) => b.cost.output - a.cost.output || b.cost.input - a.cost.input)
        .map(model => ({
          id: model.id.startsWith('pi/') ? model.id : `pi/${model.id}`,
          name: model.name,
          // Protocol the provider speaks — lets the setup UI pin a custom
          // model ID to the right custom-endpoint API without guessing.
          api: (model as { api?: string }).api,
          supportsImages: (model.input ?? []).includes('image'),
          costInput: model.cost.input,
          costOutput: model.cost.output,
          contextWindow: model.contextWindow,
          reasoning: model.reasoning,
        }))

      // Best-effort: merge models the provider's live listing advertises but
      // the bundled catalog doesn't know yet, so newly released models are
      // selectable without an app update. Catalog entries win; a failed probe
      // (no key yet, offline, non-OpenAI endpoint) keeps the catalog list.
      let apiKey = opts?.apiKey && !isMaskedCredentialValue(opts.apiKey) ? opts.apiKey : undefined
      if (!apiKey && opts?.connectionSlug) {
        apiKey = await getCredentialManager().getLlmApiKey(opts.connectionSlug).catch(() => undefined) ?? undefined
      }
      const baseUrl = opts?.baseUrl?.trim() || getPiProviderBaseUrl(provider)
      const listing = baseUrl
        ? await fetchProviderModelListing({
            baseUrl,
            apiKey,
            authStyle: (models[0] as { api?: string } | undefined)?.api === 'anthropic-messages'
              ? 'anthropic'
              : 'bearer',
            // Shorter than the default: this sits in front of the tier
            // dropdowns, so an unreachable endpoint must not stall the form.
            timeoutMs: 4000,
          }).catch(() => null)
        : null
      const known = new Set(models.map(m => m.id))
      const fresh = (listing ?? []).filter(entry => !known.has(entry.id))
      if (fresh.length > 0) {
        // A listing usually discloses nothing but the id, so the provider's
        // own catalog stands in for the capabilities it leaves out.
        const family = inferFamilyModelDefaults(models.map(m => ({
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          supportsImages: (m.input ?? []).includes('image'),
          supportsThinking: m.reasoning,
        })))
        // Unknown cost sorts fresh releases to the cheap end of the
        // expensive-first list, so they lead instead — new models are usually
        // the flagship the user opened the dropdown to find.
        const freshSummaries = fresh.map(entry => ({
          id: `pi/${entry.id}`,
          name: entry.name ?? entry.id,
          api: (models[0] as { api?: string } | undefined)?.api,
          supportsImages: entry.supportsImages ?? family.supportsImages ?? false,
          costInput: 0,
          costOutput: 0,
          contextWindow: entry.contextWindow ?? family.contextWindow,
          reasoning: family.supportsThinking === true,
          // Marks entries the live listing contributed — the setup flow keeps
          // them out of the catalog-known set (see ApiKeyInput submit).
          source: 'listing' as const,
        }))
        return {
          models: [...freshSummaries, ...summaries],
          totalCount: summaries.length + freshSummaries.length,
        }
      }
      return { models: summaries, totalCount: models.length }
    } catch {
      return { models: [], totalCount: 0 }
    }
  })

  interface PendingChatGptFlow {
    flowId: string
    state: string
    codeVerifier: string
    connectionSlug: string
    ownerClientId: string
    createdAt: number
  }
  const pendingChatGptFlows = new Map<string, PendingChatGptFlow>()
  const chatGptFlowTtlMs = 5 * 60 * 1000

  const cleanupExpiredChatGptFlows = () => {
    const now = Date.now()
    for (const [state, flow] of pendingChatGptFlows) {
      if (now - flow.createdAt > chatGptFlowTtlMs) pendingChatGptFlows.delete(state)
    }
  }

  server.handle(RPC_CHANNELS.chatgpt.START_OAUTH, async (ctx, connectionSlug: string) => {
    cleanupExpiredChatGptFlows()
    const { prepareChatGptOAuth } = await import('@bitlab/shared/auth')
    const prepared = prepareChatGptOAuth()
    const flowId = randomUUID()
    pendingChatGptFlows.set(prepared.state, {
      flowId,
      state: prepared.state,
      codeVerifier: prepared.codeVerifier,
      connectionSlug,
      ownerClientId: ctx.clientId,
      createdAt: Date.now(),
    })
    return { authUrl: prepared.authUrl, state: prepared.state, flowId }
  })

  server.handle(RPC_CHANNELS.chatgpt.COMPLETE_OAUTH, async (ctx, args: {
    flowId: string
    code: string
    state: string
  }) => {
    const flow = pendingChatGptFlows.get(args.state)
    if (!flow) throw new Error('Unknown or expired ChatGPT OAuth flow')
    if (flow.flowId !== args.flowId) throw new Error('Flow ID mismatch')
    if (flow.ownerClientId !== ctx.clientId) throw new Error('OAuth flow owned by different client')
    if (Date.now() - flow.createdAt > chatGptFlowTtlMs) {
      pendingChatGptFlows.delete(args.state)
      throw new Error('ChatGPT OAuth flow expired')
    }
    const { exchangeChatGptTokens, getOAuthFailureCode } = await import('@bitlab/shared/auth')
    try {
      const tokens = await exchangeChatGptTokens(args.code, flow.codeVerifier)
      await getCredentialManager().setLlmOAuth(flow.connectionSlug, {
        accessToken: tokens.accessToken,
        idToken: tokens.idToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      })
      pendingChatGptFlows.delete(args.state)
      return { success: true }
    } catch (error) {
      pendingChatGptFlows.delete(args.state)
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Token exchange failed',
        // Lets the UI point at the real fix (usually proxy settings) instead of
        // echoing an upstream message that blames the user's country.
        failureCode: getOAuthFailureCode(error),
      }
    }
  })

  server.handle(RPC_CHANNELS.chatgpt.CANCEL_OAUTH, async (ctx, args?: { state?: string }) => {
    if (args?.state) {
      const flow = pendingChatGptFlows.get(args.state)
      if (flow?.ownerClientId === ctx.clientId) pendingChatGptFlows.delete(args.state)
    }
    return { success: true }
  })

  server.handle(RPC_CHANNELS.chatgpt.GET_AUTH_STATUS, async (_ctx, connectionSlug: string) => {
    const credentials = await getCredentialManager().getLlmOAuth(connectionSlug)
    if (!credentials) return { authenticated: false }
    const expired = credentials.expiresAt && Date.now() > credentials.expiresAt - 5 * 60 * 1000
    return {
      authenticated: !expired || !!credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      hasRefreshToken: !!credentials.refreshToken,
    }
  })

  server.handle(RPC_CHANNELS.chatgpt.LOGOUT, async (_ctx, connectionSlug: string) => {
    await getCredentialManager().deleteLlmCredentials(connectionSlug)
    return { success: true }
  })

  server.handle(RPC_CHANNELS.llmConnections.LIST, async (): Promise<LlmConnection[]> => getLlmConnections())
  server.handle(RPC_CHANNELS.llmConnections.LIST_WITH_STATUS, async (): Promise<LlmConnectionWithStatus[]> => {
    const manager = getCredentialManager()
    const defaultSlug = getDefaultLlmConnection()
    return Promise.all(getLlmConnections().map(async connection => ({
      ...connection,
      isAuthenticated: await manager.hasLlmCredentials(connection.slug, connection.authType),
      isDefault: connection.slug === defaultSlug,
    })))
  })
  server.handle(RPC_CHANNELS.llmConnections.GET, async (_ctx, slug: string) => getLlmConnection(slug))
  server.handle(RPC_CHANNELS.llmConnections.GET_API_KEY, async (_ctx, slug: string) => {
    const key = await getCredentialManager().getLlmApiKey(slug)
    if (!key) return null
    return key.length > 15 ? `${key.slice(0, 7)}••••••••${key.slice(-4)}` : '••••••••'
  })
  server.handle(RPC_CHANNELS.llmConnections.SAVE, async (_ctx, connection: LlmConnection) => {
    try {
      const existing = getLlmConnection(connection.slug)
      const success = existing
        ? updateLlmConnection(connection.slug, connection)
        : addLlmConnection(connection)
      if (!success) return { success: false, error: 'Failed to save connection' }
      sessionManager.refreshConnectionRuntime(connection.slug).catch(error => {
        deps.platform.logger.warn(`Runtime refresh failed: ${error instanceof Error ? error.message : error}`)
      })
      if (getDefaultLlmConnection() === connection.slug) await sessionManager.reinitializeAuth()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
  server.handle(RPC_CHANNELS.llmConnections.DELETE, async (_ctx, slug: string) => {
    if (!getLlmConnection(slug)) return { success: false, error: 'Connection not found' }
    const success = deleteLlmConnection(slug)
    if (success) {
      getModelRefreshService().stopConnection(slug)
      await getCredentialManager().deleteLlmCredentials(slug)
    }
    return { success }
  })
  server.handle(RPC_CHANNELS.llmConnections.TEST, async (_ctx, slug: string) => {
    const result = await validateStoredBackendConnection({
      slug,
      hostRuntime: buildBackendHostRuntimeContext(deps.platform),
    })
    if (!result.success) return { success: false, error: result.error }
    touchLlmConnection(slug)
    return { success: true }
  })
  server.handle(RPC_CHANNELS.llmConnections.SET_DEFAULT, async (_ctx, slug: string) => {
    const success = setDefaultLlmConnection(slug)
    if (success) await sessionManager.reinitializeAuth()
    return { success, error: success ? undefined : 'Connection not found' }
  })
  server.handle(RPC_CHANNELS.llmConnections.SET_WORKSPACE_DEFAULT, async (_ctx, workspaceId: string, slug: string | null) => {
    try {
      if (slug && !getLlmConnection(slug)) return { success: false, error: 'Connection not found' }
      const workspace = getWorkspaceOrThrow(workspaceId)
      const { loadWorkspaceConfig, saveWorkspaceConfig } = await import('@bitlab/shared/workspaces')
      const config = loadWorkspaceConfig(workspace.dataRoot)
      if (!config) return { success: false, error: 'Failed to load workspace config' }
      config.defaults ??= {}
      if (slug) config.defaults.defaultLlmConnection = slug
      else delete config.defaults.defaultLlmConnection
      saveWorkspaceConfig(workspace.dataRoot, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: parseValidationError(error instanceof Error ? error.message : String(error)) }
    }
  })
  server.handle(RPC_CHANNELS.llmConnections.REFRESH_MODELS, async (_ctx, slug: string) => {
    if (!getLlmConnection(slug)) return { success: false, error: 'Connection not found' }
    try {
      await getModelRefreshService().refreshNow(slug)
      // Report the resulting list size so the UI can confirm what it now holds.
      const refreshed = getLlmConnection(slug)
      return { success: true, modelCount: refreshed?.models?.length }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  })
}
