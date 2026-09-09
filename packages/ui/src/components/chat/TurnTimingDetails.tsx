import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Timer } from 'lucide-react'
import type { AgentRunMetrics } from '@bitlab/core'
import { deriveRunMetrics } from '@bitlab/core'
import { SimpleDropdown } from '../ui/SimpleDropdown'
import { cn } from '../../lib/utils'
import { formatCount, formatMetricDuration, formatTokensPerSecond } from './timing-format'

export interface TurnTimingDetailsProps {
  /** The run this turn belongs to. */
  run: AgentRunMetrics
  /** Compact-footer layout: smaller trigger. */
  compact?: boolean
  /** Additional className for the trigger button. */
  className?: string
}

/** Render a duration through the locale's unit wording, or the "unknown" text. */
function useDurationText(): (ms: number | undefined) => string {
  const { t, i18n } = useTranslation()
  return React.useCallback((ms: number | undefined) => {
    const parts = formatMetricDuration(ms, i18n.language)
    if (!parts) return t('timing.notRecorded')
    if (parts.unit === 'minutes') {
      return t('timing.minutesSeconds', { minutes: parts.value, seconds: parts.seconds })
    }
    return parts.unit === 'seconds'
      ? t('timing.seconds', { value: parts.value })
      : t('timing.milliseconds', { value: parts.value })
  }, [i18n.language, t])
}

/** One row of the panel. */
function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-[3px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/**
 * The turn's timing entry: a footer button that opens the run's four readings.
 *
 * Total time and model speed answer different questions and are deliberately
 * kept apart — the total covers tool runs and approval waits the model spent
 * none of, so presenting one as the other would misdescribe every turn that
 * used a tool.
 */
export function TurnTimingDetails({ run, compact = false, className }: TurnTimingDetailsProps) {
  const { t, i18n } = useTranslation()
  const durationText = useDurationText()
  const summary = React.useMemo(() => deriveRunMetrics(run), [run])

  if (!summary) return null

  const throughput = formatTokensPerSecond(summary.tokensPerSecond, i18n.language)
  const triggerLabel = summary.isRunning
    ? t('timing.running')
    : summary.totalDurationMs === undefined
      ? t('timing.notRecorded')
      : t('timing.tookLabel', { duration: durationText(summary.totalDurationMs) })

  return (
    <SimpleDropdown
      align="start"
      keyboardNavigation={false}
      menuWidth={280}
      className="w-[280px] max-w-[calc(100vw-16px)] p-3 text-[12px]"
      trigger={
        <button
          type="button"
          aria-label={t('timing.detailsAria')}
          className={cn(
            'turn-action-btn flex items-center gap-1.5 transition-colors select-none',
            'text-muted-foreground hover:text-foreground',
            'focus:outline-none focus-visible:underline',
            className,
          )}
        >
          <Timer className={compact ? 'w-3 h-3' : 'w-3.5 h-3.5'} aria-hidden="true" />
          <span className="tabular-nums">{triggerLabel}</span>
        </button>
      }
    >
      <div className="font-medium text-foreground mb-1.5">{t('timing.summaryTitle')}</div>
      <SummaryRow label={t('timing.totalDuration')} value={durationText(summary.totalDurationMs)} />
      <SummaryRow
        label={t('timing.outputSpeed')}
        value={throughput === undefined
          ? t('timing.notRecorded')
          : t('timing.tokensPerSecond', { value: throughput })}
      />
      <SummaryRow label={t('timing.firstTtft')} value={durationText(summary.ttftMs)} />
      <SummaryRow
        label={t('timing.requestCount')}
        value={t('timing.requestCountValue', { count: summary.totalRequests })}
      />
      {/* Coverage caveats stay: a partial sample presented as a full reading
          would be the one thing here that misleads. */}
      {summary.tokensPerSecond !== undefined && summary.sampledRequests < summary.totalRequests && (
        <div className="mt-1 text-[11px] text-muted-foreground">
          {t('timing.partialSamples', {
            sampled: formatCount(summary.sampledRequests, i18n.language),
            total: formatCount(summary.totalRequests, i18n.language),
          })}
        </div>
      )}
      {summary.isPartial && (
        <div className="mt-1 text-[11px] text-muted-foreground">{t('timing.branchPrefix')}</div>
      )}
    </SimpleDropdown>
  )
}
