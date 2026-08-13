/**
 * The composer's model seat: one trigger, a two-level menu.
 *
 * Ported from dsh's `ModelSelect`. The root pane is the Model / Effort row
 * pair (label + current value + chevron), each drilling into its own list —
 * the connection-grouped model list, and the thinking levels. The trigger
 * shows both, with the effort in the caption tone.
 *
 * Data and submission ride the shared per-session {@link ModelDirectory}, so
 * whichever surface renders this component, the host stays the single fact
 * source and a switch made in one place is what the other shows next.
 *
 * Two display rules matter more than they look:
 *
 * - **Never synthesize a row for a selection the catalog lacks.** When the
 *   current route is not among the advertised models, the trigger still names
 *   what the host says is resolved — that route is real and usable — and the
 *   menu simply has no checkmark. What it must not do is invent a catalog row,
 *   which would claim an advertised model that does not exist.
 * - **The menu stays live while the composer is blocked.** Choosing a model is
 *   what clears the block, so disabling this control would leave the composer
 *   demanding the only thing it prevents.
 */
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Image as ImageIcon, AlertCircle } from 'lucide-react'
import type { SessionModelSelectionDto } from '@bitlab/shared/protocol'
import { THINKING_LEVELS, type ThinkingLevel } from '@bitlab/shared/agent/thinking-levels'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { StyledDropdownMenuContent, StyledDropdownMenuItem } from '@/components/ui/styled-dropdown'
import { navigate, routes } from '@/lib/navigate'
import { derivePickerMode } from './picker-mode'
import { stripPiPrefixForDisplay } from './model-picker-helpers'
import type { ModelDirectory } from './useModelDirectory'
import { useModelVisionToggle } from './useModelVisionToggle'

/** Which pane the menu shows: the two-row root, or one drilled-in list. */
type Pane = 'root' | 'model' | 'effort'

export interface ModelSelectProps {
  directory: ModelDirectory
  /** Rendered inside the menu below the lists (context meter, etc.). */
  footer?: React.ReactNode
  /** Compact trigger styling for the mobile toolbar. */
  compact?: boolean
  className?: string
}

/**
 * Render the model seat.
 *
 * @param props - the shared directory plus presentation hooks.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect({
  directory,
  footer,
  compact = false,
  className,
}: ModelSelectProps) {
  const { t } = useTranslation()
  const { state, load, select } = directory
  const [open, setOpen] = React.useState(false)
  const [pane, setPane] = React.useState<Pane>('root')
  const toggleVision = useModelVisionToggle()

  const mode = derivePickerMode({
    groupCount: state.groups.length,
    loaded: state.status !== 'idle' && state.status !== 'loading',
  })

  // The catalog row backing the current route, when it advertises one. Absence
  // is normal and must not be papered over — see the header note.
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
  // A model that declares no thinking support silences the row entirely,
  // rather than offering levels the route will ignore.
  const thinkingSupported = currentRow?.model.supportsThinking !== false
  const effortLabel = thinkingLevel
    ? t(`thinking.${thinkingLevel}`)
    : undefined

  // A switch is its own feedback: the trigger label changes and the row gets
  // its checkmark. Nothing else needs to be announced.
  const submit = React.useCallback(async (selection: SessionModelSelectionDto) => {
    const result = await select(selection)
    if (!result) return
    setOpen(false)
    setPane('root')
  }, [select])

  const chooseModel = (connectionSlug: string, modelId: string) => {
    if (state.current?.connection === connectionSlug && state.current.model === modelId) {
      setOpen(false)
      setPane('root')
      return
    }
    void submit({ connection: connectionSlug, model: modelId, thinkingLevel })
  }

  const chooseEffort = (level: ThinkingLevel) => {
    if (thinkingLevel === level) {
      setOpen(false)
      setPane('root')
      return
    }
    void submit({
      connection: state.current?.connection,
      model: state.current?.model,
      thinkingLevel: level,
    })
  }

  const busy = state.status === 'selecting'

  return (
    <DropdownMenu
      open={open}
      onOpenChange={next => {
        setOpen(next)
        if (next) {
          setPane('root')
          load()
        } else {
          setPane('root')
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('chat.modelPicker.triggerAria', { model: modelLabel })}
              className={cn(
                'inline-flex items-center gap-1 shrink-0 select-none transition-colors',
                compact
                  ? 'h-7 px-2 text-xs font-medium rounded-[6px] bg-foreground/5 text-foreground/70 shadow-tinted min-w-[64px] shrink'
                  : 'input-toolbar-btn h-7 px-1.5 text-[13px] rounded-[6px] hover:bg-foreground/5',
                open && !compact && 'bg-foreground/5',
                className,
              )}
              style={compact ? ({ '--shadow-color': 'var(--foreground-rgb)' } as React.CSSProperties) : undefined}
            >
              <span className="truncate min-w-0">{modelLabel}</span>
              {effortLabel !== undefined && thinkingSupported && (
                <span className="text-muted-foreground truncate">{effortLabel}</span>
              )}
              <ChevronDown className="h-3 w-3 opacity-50 shrink-0" />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('common.model')}</TooltipContent>
      </Tooltip>

      <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
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
            <StyledDropdownMenuItem
              onSelect={event => { event.preventDefault(); setPane('model') }}
              className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
            >
              <span className="font-medium text-sm">{t('common.model')}</span>
              <span className="flex items-center gap-1.5 ml-3 shrink-0 text-muted-foreground">
                <span className="text-sm truncate max-w-[140px]">{modelLabel}</span>
                <ChevronRight className="h-3.5 w-3.5 opacity-60" />
              </span>
            </StyledDropdownMenuItem>
            {thinkingSupported && (
              <StyledDropdownMenuItem
                onSelect={event => { event.preventDefault(); setPane('effort') }}
                className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
              >
                <span className="font-medium text-sm">{t('chat.modelPicker.thinkingSection')}</span>
                <span className="flex items-center gap-1.5 ml-3 shrink-0 text-muted-foreground">
                  <span className="text-sm">{effortLabel ?? t('chat.modelPicker.providerDefault')}</span>
                  <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                </span>
              </StyledDropdownMenuItem>
            )}
            {footer}
          </>
        ) : pane === 'model' ? (
          <div className="max-h-[55vh] overflow-y-auto">
            {state.error !== null && (
              <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-destructive">
                <span className="truncate">{state.error}</span>
                <button type="button" className="underline shrink-0" onClick={load}>
                  {t('common.retry')}
                </button>
              </div>
            )}
            {state.groups.map(group => (
              <React.Fragment key={group.slug}>
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground select-none">
                  {group.name}
                </div>
                {group.models.map(model => {
                  const selected = state.current?.connection === group.slug
                    && (state.current.model ?? state.resolvedModel) === model.id
                  const showVision = group.providerType === 'pi_compat'
                  return (
                    <StyledDropdownMenuItem
                      key={`${group.slug}/${model.id}`}
                      disabled={busy}
                      onSelect={() => chooseModel(group.slug, model.id)}
                      className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="font-medium text-sm truncate">
                          {stripPiPrefixForDisplay(model.name)}
                        </span>
                        </TooltipTrigger>
                        <TooltipContent side="right">{model.id}</TooltipContent>
                      </Tooltip>
                      <div className="flex items-center gap-1 ml-3 shrink-0">
                        {showVision && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label={model.supportsImages
                              ? t('chat.modelPicker.supportsImagesOn')
                              : t('chat.modelPicker.supportsImagesOff')}
                            className="inline-flex items-center justify-center p-1 rounded hover:bg-foreground/5 cursor-pointer"
                            onClick={event => {
                              event.preventDefault()
                              event.stopPropagation()
                              void toggleVision(group.slug, model.id, !model.supportsImages).then(load)
                            }}
                            onKeyDown={event => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
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
                        {selected && <Check className="h-3 w-3 text-foreground" />}
                      </div>
                    </StyledDropdownMenuItem>
                  )
                })}
              </React.Fragment>
            ))}
            {/* Below the usable groups, never above: a connection that failed
                is context, not the thing the user came here to pick. */}
            {state.failures.map(failure => (
              <div
                key={failure.slug}
                className="px-2 py-1.5 text-xs text-muted-foreground select-none truncate"
                title={failure.message}
              >
                {failure.name} · {failure.message}
              </div>
            ))}
          </div>
        ) : (
          <div className="max-h-[55vh] overflow-y-auto">
            {THINKING_LEVELS.map(({ id, nameKey, descriptionKey }) => (
              <StyledDropdownMenuItem
                key={id}
                disabled={busy}
                onSelect={() => chooseEffort(id)}
                className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
              >
                <div className="text-left min-w-0">
                  <div className="font-medium text-sm">{t(nameKey)}</div>
                  <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
                </div>
                {thinkingLevel === id && <Check className="h-3 w-3 text-foreground shrink-0 ml-3" />}
              </StyledDropdownMenuItem>
            ))}
          </div>
        )}
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
