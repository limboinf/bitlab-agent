/**
 * PluginsSettingsPage
 *
 * Settings for pluggable integrations. Currently one card: Web Search.
 *
 * The active provider decides which backend `web_search` calls hit. `auto`
 * (default) keeps the historical behaviour of deriving it from the LLM
 * connection. Keyed providers fall back to DuckDuckGo until their key is set,
 * so search never breaks mid-setup.
 *
 * API keys go straight to the encrypted credential store; the field shows a
 * mask when a key exists and saving a mask is a no-op on the server side.
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { KeyedSearchProviderId, SearchConfig, SearchProviderId } from '@bitlab/shared/config'

import {
  SettingsSection,
  SettingsCard,
  SettingsMenuSelectRow,
  SettingsInput,
  SettingsSecretInput,
} from '@/components/settings'

const DEFAULT_CONFIG: SearchConfig = { provider: 'auto', providers: {} }

const KEYED_PROVIDERS: readonly KeyedSearchProviderId[] = ['tavily', 'exa', 'deepseek']

function isKeyed(provider: SearchProviderId): provider is KeyedSearchProviderId {
  return (KEYED_PROVIDERS as readonly string[]).includes(provider)
}

export default function PluginsSettingsPage() {
  const { t } = useTranslation()

  const [config, setConfig] = useState<SearchConfig>(DEFAULT_CONFIG)
  // Masked key for the active provider — null when none is stored.
  const [apiKey, setApiKey] = useState('')
  const [hasStoredKey, setHasStoredKey] = useState(false)

  const provider = config.provider
  const providerConfig = isKeyed(provider) ? config.providers[provider] : undefined

  const loadApiKey = useCallback(async (id: SearchProviderId) => {
    if (!window.electronAPI || !isKeyed(id)) {
      setApiKey('')
      setHasStoredKey(false)
      return
    }
    const masked = await window.electronAPI.search.getApiKey(id)
    setApiKey(masked ?? '')
    setHasStoredKey(Boolean(masked))
  }, [])

  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      const stored = await window.electronAPI.search.getConfig()
      setConfig(stored)
      await loadApiKey(stored.provider)
    }
    load().catch(() => { /* settings stay at defaults */ })
  }, [loadApiKey])

  const persist = useCallback(async (next: SearchConfig) => {
    setConfig(next)
    await window.electronAPI?.search.setConfig(next)
  }, [])

  const handleProviderChange = useCallback(async (value: string) => {
    const next = { ...config, provider: value as SearchProviderId }
    await persist(next)
    await loadApiKey(next.provider)
  }, [config, persist, loadApiKey])

  const handleApiKeyBlur = useCallback(async () => {
    if (!isKeyed(provider) || !window.electronAPI) return
    const trimmed = apiKey.trim()
    if (!trimmed) {
      if (hasStoredKey) {
        await window.electronAPI.search.deleteApiKey(provider)
        setHasStoredKey(false)
      }
      return
    }
    // A mask means "unchanged" — the server ignores it, so skip the round trip.
    if (trimmed.includes('••')) return
    await window.electronAPI.search.setApiKey(provider, trimmed)
    await loadApiKey(provider)
  }, [provider, apiKey, hasStoredKey, loadApiKey])

  const updateProviderConfig = useCallback(async (patch: { baseURL?: string; model?: string }) => {
    if (!isKeyed(provider)) return
    const merged = { ...config.providers[provider], ...patch }
    // Drop emptied fields so they fall back to the provider defaults.
    for (const key of Object.keys(merged) as Array<keyof typeof merged>) {
      if (!merged[key]?.trim()) delete merged[key]
    }
    await persist({ ...config, providers: { ...config.providers, [provider]: merged } })
  }, [config, provider, persist])

  const providerOptions = [
    { value: 'auto', label: t('settings.plugins.webSearch.providerName.auto'), description: t('settings.plugins.webSearch.providerDesc.auto') },
    { value: 'duckduckgo', label: t('settings.plugins.webSearch.providerName.duckduckgo'), description: t('settings.plugins.webSearch.providerDesc.duckduckgo') },
    { value: 'tavily', label: t('settings.plugins.webSearch.providerName.tavily'), description: t('settings.plugins.webSearch.providerDesc.tavily') },
    { value: 'exa', label: t('settings.plugins.webSearch.providerName.exa'), description: t('settings.plugins.webSearch.providerDesc.exa') },
    { value: 'deepseek', label: t('settings.plugins.webSearch.providerName.deepseek'), description: t('settings.plugins.webSearch.providerDesc.deepseek') },
  ]

  const providerName = t(`settings.plugins.webSearch.providerName.${provider}`)

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t('settings.plugins.title')}
        actions={<HeaderMenu route={routes.view.settings('plugins')} />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              <SettingsSection
                title={t('settings.plugins.webSearch.title')}
                description={t('settings.plugins.webSearch.description')}
              >
                <SettingsCard>
                  <SettingsMenuSelectRow
                    label={t('settings.plugins.webSearch.provider')}
                    description={t('settings.plugins.webSearch.providerDesc.hint')}
                    value={provider}
                    onValueChange={handleProviderChange}
                    options={providerOptions}
                  />

                  {isKeyed(provider) && (
                    <>
                      <SettingsSecretInput
                        label={t('settings.plugins.webSearch.apiKey', { provider: providerName })}
                        description={
                          hasStoredKey
                            ? t('settings.plugins.webSearch.apiKeyHint')
                            : t('settings.plugins.webSearch.fallbackNotice', { provider: providerName })
                        }
                        value={apiKey}
                        onChange={setApiKey}
                        onBlur={handleApiKeyBlur}
                        placeholder={t('settings.plugins.webSearch.apiKeyPlaceholder')}
                        inCard
                      />

                      <SettingsInput
                        label={t('settings.plugins.webSearch.baseURL')}
                        description={t('settings.plugins.webSearch.baseURLDesc')}
                        value={providerConfig?.baseURL ?? ''}
                        onChange={value => setConfig(prev => ({
                          ...prev,
                          providers: { ...prev.providers, [provider]: { ...prev.providers[provider], baseURL: value } },
                        }))}
                        onBlur={() => updateProviderConfig({ baseURL: providerConfig?.baseURL ?? '' })}
                        placeholder={t('settings.plugins.webSearch.baseURLPlaceholder')}
                        inCard
                      />

                      {provider === 'deepseek' && (
                        <SettingsInput
                          label={t('settings.plugins.webSearch.model')}
                          description={t('settings.plugins.webSearch.modelDesc')}
                          value={providerConfig?.model ?? ''}
                          onChange={value => setConfig(prev => ({
                            ...prev,
                            providers: { ...prev.providers, deepseek: { ...prev.providers.deepseek, model: value } },
                          }))}
                          onBlur={() => updateProviderConfig({ model: providerConfig?.model ?? '' })}
                          placeholder="deepseek-v4-flash"
                          inCard
                        />
                      )}
                    </>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
