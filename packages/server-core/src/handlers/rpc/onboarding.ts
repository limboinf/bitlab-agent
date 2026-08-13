/**
 * Onboarding IPC handlers for Electron main process
 *
 * Handles workspace setup and configuration persistence.
 */
import { getLlmConnections, setSetupDeferred } from '@bitlab/shared/config'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import type { RpcServer } from '@bitlab/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

// ============================================
// IPC Handlers
// ============================================

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.onboarding.GET_AUTH_STATE,
  RPC_CHANNELS.onboarding.DEFER_SETUP,
] as const

export function registerOnboardingHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  server.handle(RPC_CHANNELS.onboarding.GET_AUTH_STATE, async () => {
    const connections = getLlmConnections()
    const hasConnection = connections.length > 0
    return {
      setupNeeds: {
        isFullyConfigured: hasConnection,
        needsBillingConfig: !hasConnection,
      },
    }
  })

  // User chose "Setup later" — persist so onboarding doesn't re-show on next launch
  server.handle(RPC_CHANNELS.onboarding.DEFER_SETUP, async () => {
    setSetupDeferred(true)
    log?.info('[Onboarding] User deferred setup')
    return { success: true }
  })
}
