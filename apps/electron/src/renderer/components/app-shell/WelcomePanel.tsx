import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp } from 'lucide-react'
import { useAppShellContext, useActiveWorkspace } from '@/context/AppShellContext'
import { cn } from '@/lib/utils'
import { CapabilityDiscovery } from './CapabilityDiscovery'

/** Default landing surface shown when every content panel has been closed. */
export function WelcomePanel() {
  const { t } = useTranslation()
  const { openNewChat } = useAppShellContext()
  const workspace = useActiveWorkspace()
  const [input, setInput] = React.useState('')
  const [isOpening, setIsOpening] = React.useState(false)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)

  const openChat = React.useCallback(async (prompt?: string) => {
    if (!openNewChat || isOpening) return

    const nextInput = prompt ?? input.trim()
    setIsOpening(true)
    // Clear before navigation so a failed/slow open doesn't leave stale text,
    // and so unmount of this panel never flashes the old draft.
    setInput('')
    try {
      await openNewChat(nextInput ? { input: nextInput } : undefined)
    } finally {
      setIsOpening(false)
    }
  }, [input, isOpening, openNewChat])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    void openChat()
  }

  const workspaceName = workspace?.name ?? t('welcome.workspaceFallback')
  const isDisabled = !openNewChat || isOpening

  return (
    <main
      className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background @container/welcome"
      aria-labelledby="welcome-title"
    >
      {/* Centered stack: hero + chips + input — visual weight upper-middle, not bottom */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10">
        <section className="flex w-full max-w-[720px] -translate-y-[4vh] flex-col items-center">
          <CapabilityDiscovery
            workspaceName={workspaceName}
            onSelectSuggestion={(prompt) => void openChat(prompt)}
            disabled={isDisabled}
          />

          <form
            onSubmit={handleSubmit}
            className="mt-8 w-full rounded-2xl border border-foreground/10 bg-background shadow-middle"
          >
            <label htmlFor="welcome-prompt" className="sr-only">
              {t('welcome.inputLabel')}
            </label>
            <textarea
              ref={textareaRef}
              id="welcome-prompt"
              value={input}
              disabled={isDisabled}
              rows={2}
              placeholder={t('welcome.inputPlaceholder')}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  void openChat()
                }
              }}
              className="block min-h-[72px] w-full resize-none bg-transparent px-5 pb-2 pt-4 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground/65 disabled:opacity-50"
            />
            <div className="flex items-center justify-between gap-3 border-t border-border/40 px-3 py-2.5 pl-4">
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {workspace?.folderPath ?? t('welcome.inputHint')}
              </span>
              <button
                type="submit"
                disabled={isDisabled || input.trim().length === 0}
                aria-label={t('welcome.startChat')}
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity',
                  'hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  'disabled:opacity-25',
                )}
              >
                <ArrowUp className="size-4" aria-hidden="true" />
              </button>
            </div>
          </form>
        </section>
      </div>
    </main>
  )
}
