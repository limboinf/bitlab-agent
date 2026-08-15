import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface WelcomeHeroProps {
  workspaceName: string
  className?: string
}

const PROMPT_COUNT = 10

function greetingKey(hour: number): 'welcome.greetingMorning' | 'welcome.greetingAfternoon' | 'welcome.greetingEvening' {
  if (hour < 12) return 'welcome.greetingMorning'
  if (hour < 18) return 'welcome.greetingAfternoon'
  return 'welcome.greetingEvening'
}

/** Hero title for the empty chat / welcome surface. */
export function WelcomeHero({ workspaceName: _workspaceName, className }: WelcomeHeroProps) {
  const { t } = useTranslation()
  const headline = React.useMemo(() => {
    const greeting = t(greetingKey(new Date().getHours()))
    const index = Math.floor(Math.random() * PROMPT_COUNT) + 1
    return t('welcome.headline', { greeting, prompt: t(`welcome.prompt${index}`) })
  }, [t])

  return (
    <div className={cn('flex w-full max-w-[720px] flex-col items-center text-center', className)}>
      <h1
        id="welcome-title"
        className="text-balance text-[clamp(1.5rem,2.8cqw,2rem)] font-medium tracking-[-0.03em] text-foreground"
      >
        {headline}
      </h1>
    </div>
  )
}
