import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bug,
  Code2,
  Hammer,
  SearchCode,
} from 'lucide-react'
import { cn } from '@/lib/utils'

const SUGGESTIONS = [
  { key: 'explore', icon: SearchCode },
  { key: 'build', icon: Hammer },
  { key: 'review', icon: Code2 },
  { key: 'fix', icon: Bug },
] as const

export interface CapabilityDiscoveryProps {
  workspaceName: string
  onSelectSuggestion: (prompt: string) => void
  disabled?: boolean
  className?: string
}

/** Hero + capability chips — capability discovery for empty chat / welcome. */
export function CapabilityDiscovery({
  workspaceName,
  onSelectSuggestion,
  disabled = false,
  className,
}: CapabilityDiscoveryProps) {
  const { t } = useTranslation()

  return (
    <div className={cn('w-full max-w-[720px]', className)}>
      <div className="mb-7 flex flex-col items-center text-center">
        <h1
          id="welcome-title"
          className="text-balance text-[clamp(1.5rem,2.8cqw,2rem)] font-medium tracking-[-0.03em] text-foreground"
        >
          {t('welcome.title', { workspace: workspaceName })}
        </h1>
      </div>

      <div
        className="flex flex-wrap items-center justify-center gap-2"
        role="list"
        aria-label={t('welcome.suggestionsLabel')}
      >
        {SUGGESTIONS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="listitem"
            disabled={disabled}
            onClick={() => onSelectSuggestion(t(`welcome.suggestions.${key}.prompt`))}
            className={cn(
              'inline-flex h-9 items-center gap-2 rounded-full border border-foreground/10 bg-background px-3.5',
              'text-[13px] font-medium text-foreground/85 shadow-minimal',
              'transition-[background-color,border-color,color] duration-150',
              'hover:border-foreground/15 hover:bg-foreground/[0.03] hover:text-foreground',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              'disabled:pointer-events-none disabled:opacity-50',
            )}
          >
            <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="whitespace-nowrap">{t(`welcome.suggestions.${key}.label`)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
