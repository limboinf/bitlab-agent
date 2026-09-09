/**
 * Number and duration formatting for execution metrics.
 *
 * Kept out of JSX so units and the "not recorded" wording live in the locale
 * dictionaries, and so every surface — the footer entry, the summary rows, the
 * per-call table — renders the same reading the same way.
 */

/** A formatted duration split from its unit, so the unit can be localized. */
export interface FormattedDuration {
  /** Locale-formatted number. */
  value: string
  /** Which unit string the caller should wrap it in. */
  unit: 'milliseconds' | 'seconds' | 'minutes'
  /** Only set for the minutes unit: the leftover whole seconds. */
  seconds?: string
}

function formatNumber(locale: string, value: number, fractionDigits: number): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)
}

/**
 * Pick the unit a duration reads best in.
 *
 * Sub-second readings (TTFT, mostly) keep one decimal of a second so they stay
 * comparable with the totals beside them; anything under 100 ms would round to
 * "0.0 s", so those switch to milliseconds instead.
 *
 * @param ms - the measured duration.
 * @param locale - BCP-47 tag for number formatting.
 * @returns the formatted parts, or undefined when the reading is unusable.
 */
export function formatMetricDuration(ms: number | undefined, locale: string): FormattedDuration | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 100) return { value: formatNumber(locale, Math.round(ms), 0), unit: 'milliseconds' }
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) {
    return {
      value: formatNumber(locale, totalSeconds, totalSeconds < 10 ? 1 : 0),
      unit: 'seconds',
    }
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  return {
    value: formatNumber(locale, minutes, 0),
    unit: 'minutes',
    seconds: formatNumber(locale, seconds, 0),
  }
}

/**
 * Format a throughput reading.
 *
 * Zero is a legitimate answer — a call that streamed for a while and reported
 * no output tokens really did produce nothing — so only non-numbers are refused.
 *
 * @param tokensPerSecond - the derived rate.
 * @param locale - BCP-47 tag for number formatting.
 * @returns the formatted rate, or undefined when there is no usable sample.
 */
export function formatTokensPerSecond(tokensPerSecond: number | undefined, locale: string): string | undefined {
  if (typeof tokensPerSecond !== 'number' || !Number.isFinite(tokensPerSecond) || tokensPerSecond < 0) {
    return undefined
  }
  return formatNumber(locale, tokensPerSecond, tokensPerSecond < 10 ? 1 : 0)
}

/** Format a plain integer count for display. */
export function formatCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(count)
}
