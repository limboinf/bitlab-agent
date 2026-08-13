/** API-key/local connection step for the Pi-only Bitlab runtime. */
import { useTranslation } from "react-i18next"
import { ExternalLink } from "lucide-react"
import type { ApiSetupMethod } from "./APISetupStep"
import { StepFormLayout, BackButton, ContinueButton } from "./primitives"
import { ApiKeyInput, type ApiKeyStatus, type ApiKeySubmitData, type OAuthStatus } from "../apisetup"
import type { CustomEndpointApi } from '@config/llm-connections'

export type CredentialStatus = ApiKeyStatus | OAuthStatus

interface CredentialsStepProps {
  apiSetupMethod: ApiSetupMethod
  status: CredentialStatus
  errorMessage?: string
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
  }
}

export function CredentialsStep({
  apiSetupMethod,
  status,
  errorMessage,
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
          {status === 'error' && errorMessage && <div className="rounded-lg bg-destructive/10 text-destructive text-sm p-3">{errorMessage}</div>}
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
