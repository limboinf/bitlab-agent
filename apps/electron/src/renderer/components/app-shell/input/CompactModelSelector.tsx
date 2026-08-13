/**
 * The compact (drawer) model seat for narrow layouts.
 *
 * Same two-level Model / Effort structure as the desktop {@link ModelSelect},
 * over the SAME per-session directory — a switch made here is what the desktop
 * menu shows next, because both submit through one host-backed fact.
 *
 * It carries the same two rules as the desktop seat: no synthesized row for a
 * selection the catalog lacks, and no lock while the composer is blocked,
 * since picking a model is what clears the block.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, ChevronDown, ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react'
import { Spinner } from '@bitlab/ui'
import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer'
import { cn } from '@/lib/utils'
import { navigate, routes } from '@/lib/navigate'
import type { SessionModelSelectionDto } from '@bitlab/shared/protocol'
import { THINKING_LEVELS, type ThinkingLevel } from '@bitlab/shared/agent/thinking-levels'
import { derivePickerMode } from './picker-mode'
import { formatTokenCount, stripPiPrefixForDisplay } from './model-picker-helpers'
import type { ModelDirectory } from './useModelDirectory'
import { useModelVisionToggle } from './useModelVisionToggle'

type Pane = 'root' | 'model' | 'effort'

interface CompactModelSelectorProps {
  directory: ModelDirectory
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
    contextWindow?: number
  }
}

export function CompactModelSelector({
  directory,
  contextStatus,
}: CompactModelSelectorProps) {
  const { t } = useTranslation()
  const { state, load, select } = directory
  const [open, setOpen] = React.useState(false)
  const [pane, setPane] = React.useState<Pane>('root')
  const toggleVision = useModelVisionToggle()

  const mode = derivePickerMode({
    groupCount: state.groups.length,
    loaded: state.status !== 'idle' && state.status !== 'loading',
  })

  const currentRow = React.useMemo(() => {
    const { current } = state
    if (!current) return undefined
    for (const group of state.groups) {
      if (group.slug !== current.connection) continue
      const model = group.models.find(item => item.id === (current.model ?? state.resolvedModel))
      if (model) return { group, model }
    }
    return undefined
  }, [state])

  // The `pi/` prefix is routing detail, not something a user picked; strip it
  // everywhere a name is shown, while ids stay intact for submission.
  const modelLabel = currentRow
    ? stripPiPrefixForDisplay(currentRow.model.name)
    : state.resolvedModel
      ? stripPiPrefixForDisplay(state.resolvedModel)
      : t('chat.modelPicker.selectModel')

  const thinkingLevel = state.current?.thinkingLevel
  const thinkingSupported = currentRow?.model.supportsThinking !== false
  const effortLabel = thinkingLevel ? t(`thinking.${thinkingLevel}`) : undefined
  const busy = state.status === 'selecting'

  React.useEffect(() => {
    if (!open) setPane('root')
  }, [open])

  const submit = React.useCallback(async (selection: SessionModelSelectionDto) => {
    const result = await select(selection)
    if (!result) return
    setOpen(false)
  }, [select])

  const chooseModel = (connectionSlug: string, modelId: string) => {
    if (state.current?.connection === connectionSlug && state.current.model === modelId) {
      setOpen(false)
      return
    }
    void submit({ connection: connectionSlug, model: modelId, thinkingLevel })
  }

  const chooseEffort = (level: ThinkingLevel) => {
    if (thinkingLevel === level) {
      setOpen(false)
      return
    }
    void submit({
      connection: state.current?.connection,
      model: state.current?.model,
      thinkingLevel: level,
    })
  }

  return (
    <Drawer
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) load()
      }}
    >
      <DrawerTrigger asChild>
        <button
          type="button"
          aria-label={t('chat.modelPicker.triggerAria', { model: modelLabel })}
          className="h-7 pl-2 pr-2 text-xs font-medium rounded-[6px] flex items-center gap-1.5 shadow-tinted outline-none select-none min-w-[64px] shrink bg-foreground/5 text-foreground/70"
          style={{ '--shadow-color': 'var(--foreground-rgb)' } as React.CSSProperties}
        >
          <span className="truncate min-w-0">{modelLabel}</span>
          {effortLabel !== undefined && thinkingSupported && (
            <span className="text-muted-foreground truncate">{effortLabel}</span>
          )}
          <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
        </button>
      </DrawerTrigger>

      <DrawerContent>
        <DrawerHeader className="flex flex-row items-center gap-2">
          {pane !== 'root' && (
            <button
              type="button"
              aria-label={t('common.back')}
              className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5"
              onClick={() => setPane('root')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <DrawerTitle>
            {pane === 'effort' ? t('chat.modelPicker.thinkingSection') : t('common.model')}
          </DrawerTitle>
        </DrawerHeader>

        <div className="px-2 pb-4 flex flex-col gap-0.5 max-h-[55vh] overflow-y-auto">
          {mode === 'unavailable' ? (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <AlertCircle className="h-8 w-8 text-destructive mb-2" />
              <div className="font-medium text-sm mb-1">{t('chat.connectionUnavailable')}</div>
              <div className="text-xs text-muted-foreground mb-3">
                {t('chat.connectionUnavailableDescription')}
              </div>
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  navigate(routes.view.settings('ai'))
                }}
                className="text-xs underline text-foreground/70 hover:text-foreground"
              >
                {t('chat.modelPicker.openAiSettings')}
              </button>
            </div>
          ) : mode === 'empty' ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center select-none">
              {t('common.loading')}
            </div>
          ) : pane === 'root' ? (
            <>
              <button
                type="button"
                onClick={() => setPane('model')}
                className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-left hover:bg-foreground/5 transition-colors"
              >
                <span className="text-sm font-medium">{t('common.model')}</span>
                <span className="flex items-center gap-1.5 ml-3 shrink-0 text-muted-foreground">
                  <span className="text-sm truncate max-w-[160px]">{modelLabel}</span>
                  <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                </span>
              </button>
              {thinkingSupported && (
                <button
                  type="button"
                  onClick={() => setPane('effort')}
                  className="flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-left hover:bg-foreground/5 transition-colors"
                >
                  <span className="text-sm font-medium">{t('chat.modelPicker.thinkingSection')}</span>
                  <span className="flex items-center gap-1.5 ml-3 shrink-0 text-muted-foreground">
                    <span className="text-sm">{effortLabel ?? t('chat.modelPicker.providerDefault')}</span>
                    <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                  </span>
                </button>
              )}
              {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
                <div className="flex items-center justify-between px-3 py-2 mt-1 text-xs text-muted-foreground select-none">
                  <span>{t('chat.context')}</span>
                  <span className="flex items-center gap-1.5">
                    {contextStatus.isCompacting && <Spinner className="h-3 w-3" />}
                    {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
                  </span>
                </div>
              )}
            </>
          ) : pane === 'model' ? (
            <>
              {state.error !== null && (
                <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs text-destructive">
                  <span className="truncate">{state.error}</span>
                  <button type="button" className="underline shrink-0" onClick={load}>
                    {t('common.retry')}
                  </button>
                </div>
              )}
              {state.groups.map(group => (
                <React.Fragment key={group.slug}>
                  <div className="px-3 pt-3 pb-1 text-xs font-medium text-foreground/60 select-none">
                    {group.name}
                  </div>
                  {group.models.map(model => {
                    const selected = state.current?.connection === group.slug
                      && (state.current.model ?? state.resolvedModel) === model.id
                    const showVision = group.providerType === 'pi_compat'
                    return (
                      <button
                        key={`${group.slug}/${model.id}`}
                        type="button"
                        disabled={busy}
                        onClick={() => chooseModel(group.slug, model.id)}
                        className={cn(
                          'flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors',
                          selected ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                        )}
                      >
                        <span className="text-sm font-medium truncate">
                          {stripPiPrefixForDisplay(model.name)}
                        </span>
                        <div className="flex items-center gap-1 ml-3 shrink-0">
                          {showVision && (
                            <span
                              role="button"
                              tabIndex={0}
                              aria-label={model.supportsImages
                                ? t('chat.modelPicker.supportsImagesOn')
                                : t('chat.modelPicker.supportsImagesOff')}
                              className="inline-flex items-center justify-center p-2 rounded hover:bg-foreground/5 cursor-pointer"
                              onClick={event => {
                                event.preventDefault()
                                event.stopPropagation()
                                void toggleVision(group.slug, model.id, !model.supportsImages).then(load)
                              }}
                            >
                              <ImageIcon className={cn(
                                'h-3.5 w-3.5',
                                model.supportsImages ? 'text-foreground/70' : 'text-foreground/30',
                              )} />
                            </span>
                          )}
                          {selected && <Check className="h-3 w-3 text-foreground/60" />}
                        </div>
                      </button>
                    )
                  })}
                </React.Fragment>
              ))}
              {/* Below the usable groups, never above. */}
              {state.failures.map(failure => (
                <div
                  key={failure.slug}
                  className="px-3 py-2 text-xs text-muted-foreground select-none truncate"
                >
                  {failure.name} · {failure.message}
                </div>
              ))}
            </>
          ) : (
            THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => (
              <button
                key={id}
                type="button"
                disabled={busy}
                onClick={() => chooseEffort(id)}
                className={cn(
                  'flex items-center justify-between w-full px-3 py-2 rounded-lg text-left transition-colors',
                  thinkingLevel === id ? 'bg-foreground/5' : 'hover:bg-foreground/5',
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium">{t(nameKey)}</div>
                  <div className="text-xs text-foreground/50">{t(descriptionKey)}</div>
                </div>
                {thinkingLevel === id && <Check className="h-3 w-3 text-foreground/60 shrink-0 ml-3" />}
              </button>
            ))
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}
