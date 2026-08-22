/**
 * Context-window meter: a ring beside the send button, with a click-open panel
 * breaking the prompt down into system prompt, tools, and conversation.
 *
 * Two independent facts are shown together on purpose:
 *
 *  - The headline percent and `~used / window` come from the backend, which
 *    anchors on the last response's provider-reported context size and only
 *    estimates what was appended since. That figure is `null` right after a
 *    compaction — the true size is genuinely unknown until the next response,
 *    and a stale number would be worse than none.
 *  - The breakdown is an independent heuristic. It does NOT sum to the
 *    headline figure, so it only ever proportions the bar's colored parts:
 *    the bar's overall length stays the provider-anchored percent.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { ContextUsageReading } from '../../../../shared/types'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

/** Ring geometry: 14px box, 2px stroke. */
const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * Occupancy at which the ring warns and offers a manual compaction, and at
 * which it turns critical.
 *
 * The warning sits below the backend's own auto-compaction point (~77.5% of
 * the window) on purpose: past that line the agent has already compacted for
 * the user, so an offer to do it manually arrives too late to be useful.
 */
const WARN_PERCENT = 65
const CRITICAL_PERCENT = 85

/** Legend rows in bar-segment order; each carries its own swatch tint. */
const ROWS = [
  { key: 'systemTokens', label: 'chat.contextSystem', color: 'var(--muted-foreground)' },
  { key: 'toolsTokens', label: 'chat.contextTools', color: 'var(--accent)' },
  { key: 'messageTokens', label: 'chat.contextMessages', color: 'var(--success)' },
] as const

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M.
 *
 * Local rather than shared: the shared `formatTokens` stops at K, which would
 * render a 1M context window as "1000k" in the one place the denominator is
 * always a whole context window.
 */
function formatContextTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(Math.floor(n))
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Ring tint by occupancy: neutral, then the project's amber and red. */
function ringColor(percent: number | null): string {
  if (percent === null) return 'var(--muted-foreground)'
  if (percent >= CRITICAL_PERCENT) return 'var(--destructive)'
  if (percent >= WARN_PERCENT) return 'var(--info)'
  return 'var(--muted-foreground)'
}

export interface ContextMeterProps {
  /** Backend reading; the meter renders nothing until one arrives. */
  contextUsage?: ContextUsageReading
  /** True while the backend is compacting. */
  isCompacting?: boolean
  /** Runs a manual compaction; offered only when occupancy is high. */
  onCompact?: () => void
  /** True while a turn is in flight — compaction has to wait. */
  isProcessing?: boolean
}

export function ContextMeter({
  contextUsage,
  isCompacting,
  onCompact,
  isProcessing,
}: ContextMeterProps) {
  const { t } = useTranslation()

  if (!contextUsage) return null

  const { tokens, contextWindow, percent, breakdown } = contextUsage
  // Clamp for display only: a provider can report a prompt larger than the
  // advertised window (extra framing), and a >100% ring reads as a bug.
  const displayPercent = percent === null ? null : Math.min(100, Math.round(percent))
  const reading = displayPercent === null ? '—' : `${displayPercent}%`
  const ariaLabel = t('chat.contextAria', { percent: reading })

  const breakdownTotal = breakdown
    ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    : 0
  // A zero-width part is dropped rather than rendered, so an empty context
  // never draws a hairline that reads as occupancy.
  const segments =
    !breakdown || displayPercent === null || breakdownTotal === 0
      ? []
      : ROWS.map(row => ({
          key: row.key,
          color: row.color,
          width: (displayPercent * breakdown[row.key]) / breakdownTotal,
        })).filter(segment => segment.width > 0)

  const showCompact =
    onCompact !== undefined
    && displayPercent !== null
    && displayPercent >= WARN_PERCENT
    && !isCompacting

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label={ariaLabel}
              className="inline-flex items-center justify-center h-6 w-6 rounded-[6px] shrink-0 hover:bg-foreground/5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden>
                <circle
                  cx="7"
                  cy="7"
                  r={RADIUS}
                  fill="none"
                  strokeWidth="2"
                  stroke="currentColor"
                  className="text-foreground/15"
                />
                {displayPercent !== null && displayPercent > 0 && (
                  <circle
                    cx="7"
                    cy="7"
                    r={RADIUS}
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    stroke={ringColor(displayPercent)}
                    strokeDasharray={`${(CIRCUMFERENCE * displayPercent) / 100} ${CIRCUMFERENCE}`}
                    transform="rotate(-90 7 7)"
                  />
                )}
              </svg>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{ariaLabel}</TooltipContent>
      </Tooltip>

      <PopoverContent side="top" align="end" className="w-[280px] p-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[12px] text-foreground/60">
            {t('chat.contextUsed')}
          </span>
          <span className="text-[13px] font-medium tabular-nums">{reading}</span>
          <span className="flex-1" />
          <span className="text-[12px] text-foreground/50 tabular-nums">
            {tokens === null
              ? formatContextTokens(contextWindow)
              : `~${formatContextTokens(tokens)} / ${formatContextTokens(contextWindow)}`}
          </span>
        </div>

        <div className="mt-2 h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden flex">
          {segments.length > 0 ? (
            segments.map(segment => (
              <div
                key={segment.key}
                style={{ width: `${segment.width}%`, backgroundColor: segment.color }}
              />
            ))
          ) : (
            // Occupancy is known even when its composition is not, so the bar
            // fills as one undifferentiated block rather than reading as empty.
            displayPercent !== null && displayPercent > 0 && (
              <div
                style={{ width: `${displayPercent}%` }}
                className="bg-foreground/40"
              />
            )
          )}
        </div>

        {tokens === null ? (
          <p className="mt-3 text-[12px] text-foreground/50">
            {t('chat.contextPending')}
          </p>
        ) : !breakdown ? (
          <p className="mt-3 text-[12px] text-foreground/50">
            {t('chat.contextCompositionPending')}
          </p>
        ) : (
          <dl className="mt-3 space-y-1.5">
            {ROWS.map(row => (
              <React.Fragment key={row.key}>
                <div className="flex items-center justify-between gap-2">
                  <dt className="flex items-center gap-2 text-[12px] text-foreground/70">
                    <span
                      aria-hidden
                      className="h-2 w-2 rounded-[2px] shrink-0"
                      style={{ backgroundColor: row.color }}
                    />
                    {t(row.label)}
                  </dt>
                  <dd className="text-[12px] text-foreground/50 tabular-nums">
                    {`~${formatContextTokens(breakdown[row.key])}`}
                  </dd>
                </div>
                {/* Indented under the system prompt because it is part of it,
                    not a fourth segment. Every enabled skill contributes its
                    name and description to every request, so a large catalog
                    is a standing cost worth being able to see. */}
                {row.key === 'systemTokens' && breakdown.skillsTokens > 0 && (
                  <div className="flex items-center justify-between gap-2 pl-4">
                    <dt className="text-[11px] text-foreground/45">{t('chat.contextSkills')}</dt>
                    <dd className="text-[11px] text-foreground/40 tabular-nums">
                      {`~${formatContextTokens(breakdown.skillsTokens)}`}
                    </dd>
                  </div>
                )}
              </React.Fragment>
            ))}
          </dl>
        )}

        {showCompact && (
          <button
            type="button"
            disabled={isProcessing}
            onClick={() => onCompact?.()}
            className="mt-3 w-full h-7 text-[12px] font-medium rounded-[6px] bg-foreground/5 hover:bg-foreground/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isProcessing ? t('chat.contextCompactBusy') : t('chat.contextCompact')}
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
