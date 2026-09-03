/** API-key/local connection step for the Pi-only Bitlab runtime. */
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import type { ApiSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import { ApiKeyInput, type ApiKeyStatus, type ApiKeySubmitData, type OAuthStatus } from "../apisetup"
import type { CustomEndpointApi } from '@config/llm-connections'
import type { OAuthFailureCode } from '@bitlab/shared/auth'

export type CredentialStatus = ApiKeyStatus | OAuthStatus

/** Spelled out rather than interpolated so the i18n usage lint can see both keys. */
const OAUTH_FAILURE_HINT_KEY: Record<OAuthFailureCode, string> = {
  region_blocked: 'onboarding.credentials.oauthError.region_blocked',
  network_unreachable: 'onboarding.credentials.oauthError.network_unreachable',
}

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod
  status: CredentialStatus
  errorMessage?: string
  /** Actionable classification of an OAuth failure, when the server named one. */
  errorCode?: OAuthFailureCode
  onSubmit: (data: ApiKeySubmitData) => void
  onStartOAuth?: (methodOverride?: ApiSetupMethod) => void
  onBack: () => void
  editInitialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    activePreset?: string
    models?: string[]
    customApi?: CustomEndpointApi
    connectionSlug?: string
  }
}

export function CredentialsStep({
  apiSetupMethod,
  status,
  errorMessage,
  errorCode,
  onSubmit,
  onStartOAuth,
  onBack,
  editInitialValues,
}: CredentialsStepProps) {
  const { t } = useTranslation()
  const isChatGptOAuth = apiSetupMethod === 'pi_chatgpt_oauth'

  if (isChatGptOAuth) {
    return (
      <StepFormLayout
        title={t("onboarding.credentials.connectChatGPT")}
        description={t("onboarding.credentials.connectChatGPTDesc")}
        actions={(
          <>
            <BackButton onClick={onBack} disabled={status === 'validating'} />
            <ContinueButton onClick={() => onStartOAuth?.()} loading={status === 'validating'} loadingText={t("common.connecting")} className="gap-2">
              <ExternalLink className="size-4" />
              {t("onboarding.credentials.signInChatGPT")}
            </ContinueButton>
          </>
        )}
      >
        <div className="space-y-4">
          <div className="rounded-xl bg-foreground-2 p-4 text-sm text-muted-foreground">
            <p>{t("onboarding.credentials.chatGPTInstructions")}</p>
          </div>
          {status === 'error' && errorMessage && (
            <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3 space-y-1.5">
              {/* A classified failure gets the fix, not just the upstream wording —
                  "country not supported" really means this app went out unproxied. */}
              {errorCode && <p>{t(OAUTH_FAILURE_HINT_KEY[errorCode])}</p>}
              <p className={errorCode ? 'text-xs opacity-70' : undefined}>{errorMessage}</p>
            </div>
          )}
        </div>
      </StepFormLayout>
    )
  }

  const apiKeyInputKey = [
    apiSetupMethod,
    editInitialValues?.activePreset ?? '',
    editInitialValues?.baseUrl ?? '',
    editInitialValues?.connectionDefaultModel ?? '',
    (editInitialValues?.models ?? []).join('|'),
    editInitialValues?.customApi ?? '',
  ].join('::')

  return (
    <StepFormLayout
      title={t("onboarding.credentials.apiConfiguration")}
      description="Select a provider preset and enter its API key, or configure an Ollama/custom compatible endpoint."
      actions={(
        <>
          <BackButton onClick={onBack} disabled={status === 'validating'} />
          <ContinueButton
            type="submit"
            form="api-key-form"
            loading={status === 'validating'}
            loadingText={t("common.validating")}
          />
        </>
      )}
    >
      <ApiKeyInput
        key={apiKeyInputKey}
        status={status}
        errorMessage={errorMessage}
        onSubmit={onSubmit}
        initialValues={editInitialValues}
      />
    </StepFormLayout>
  )
}
