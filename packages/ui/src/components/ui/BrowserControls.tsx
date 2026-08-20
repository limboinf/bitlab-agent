import { useState, useCallback, useRef, useEffect, forwardRef, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, RotateCw, X, Globe } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { cn } from '../../lib/utils'
import { useTranslation } from 'react-i18next'
import { Spinner } from './LoadingIndicator'

/* ------------------------------------------------------------------ */
/*  NavButton – small internal button matching TopBarButton styling   */
/* ------------------------------------------------------------------ */

interface NavButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode
}

const NavButton = forwardRef<HTMLButtonElement, NavButtonProps>(
  ({ children, className, disabled, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={cn(
        'h-7 w-7 flex items-center justify-center rounded-[6px]',
        'hover:bg-foreground/5 focus:outline-none focus-visible:ring-0',
        'disabled:opacity-30 disabled:pointer-events-none',
        'transition-colors duration-100',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  ),
)
NavButton.displayName = 'NavButton'

/* ------------------------------------------------------------------ */
/*  BrowserControls                                                    */
/* ------------------------------------------------------------------ */

export interface BrowserControlsProps {
  /** Current URL displayed in the address bar */
  url?: string
  /** Whether page is loading (toggles Stop/Reload, shows progress) */
  loading?: boolean
  /** Enable back button */
  canGoBack?: boolean
  /** Enable forward button */
  canGoForward?: boolean
  /** Called when user submits a URL */
  onNavigate?: (url: string) => void
  /** Back button click */
  onGoBack?: () => void
  /** Forward button click */
  onGoForward?: () => void
  /** Reload button click */
  onReload?: () => void
  /** Stop button click */
  onStop?: () => void
  /** Controlled URL input change */
  onUrlChange?: (url: string) => void
  /** Compact layout variant */
  compact?: boolean
  /** Content rendered before navigation buttons */
  leadingContent?: ReactNode
  /** Content rendered after URL bar (e.g. label) */
  trailingContent?: ReactNode
  /** Show animated loading progress bar (default true) */
  showProgressBar?: boolean
  /** Additional CSS classes on the URL bar group (reload + form) */
  urlBarClassName?: string
  /** Additional CSS classes on the root element */
  className?: string
}

export function BrowserControls({
  url: controlledUrl,
  loading = false,
  canGoBack = false,
  canGoForward = false,
  onNavigate,
  onGoBack,
  onGoForward,
  onReload,
  onStop,
  onUrlChange,
  compact = false,
  leadingContent,
  trailingContent,
  showProgressBar = true,
  urlBarClassName,
  className,
}: BrowserControlsProps) {
  const { t } = useTranslation()
  const [localUrl, setLocalUrl] = useState(controlledUrl ?? '')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Sync with controlled url when not focused
  useEffect(() => {
    if (!isFocused && controlledUrl != null) {
      setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
    }
  }, [controlledUrl, isFocused])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const trimmed = localUrl.trim()
      if (trimmed) {
        onNavigate?.(trimmed)
        inputRef.current?.blur()
      }
    },
    [localUrl, onNavigate],
  )

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value
      setLocalUrl(value)
      onUrlChange?.(value)
    },
    [onUrlChange],
  )

  const handleFocus = useCallback(() => {
    setIsFocused(true)
    setTimeout(() => inputRef.current?.select(), 0)
  }, [])

  const handleBlur = useCallback(() => {
    setIsFocused(false)
  }, [])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (controlledUrl != null) {
          setLocalUrl(controlledUrl === 'about:blank' ? '' : controlledUrl)
        }
        inputRef.current?.blur()
      }
    },
    [controlledUrl],
  )

  /* Shared: reload / stop button */
  const reloadButton = (
    <NavButton
      aria-label={loading ? t('browser.stopLoading') : t('common.reload')}
      onClick={loading ? onStop : onReload}
    >
      {loading ? (
        <X className="h-[16px] w-[16px] text-foreground/70" strokeWidth={1.8} />
      ) : (
        <RotateCw className="h-[15px] w-[15px] text-foreground/70" strokeWidth={1.8} />
      )}
    </NavButton>
  )

  /* Shared: URL input form */
  const urlForm = (
    <form className="flex-1 min-w-0" onSubmit={handleSubmit}>
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={localUrl}
          onChange={handleChange}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={t('browser.urlPlaceholder')}
          className={cn(
            'w-full rounded-[8px] px-3 pl-8 text-[13px] outline-none transition-colors duration-100',
            compact ? 'h-[28px]' : 'h-[30px]',
            isFocused
              ? 'bg-background border border-border text-foreground shadow-minimal'
              : 'bg-foreground/[0.04] border border-transparent text-foreground/70 hover:bg-foreground/[0.06]',
          )}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
        />
        <span className="absolute inset-y-0 left-3 flex items-center justify-center">
          {loading ? (
            <span className="flex items-center justify-center h-3.5 w-3.5">
              <Spinner className="text-[11px] text-foreground/40" />
            </span>
          ) : (
            <Globe className="h-3.5 w-3.5 text-foreground/30" />
          )}
        </span>
      </div>
    </form>
  )

  /* Shared: progress bar */
  const progressBar = showProgressBar && (
    <AnimatePresence>
      {loading && (
        <motion.div
          className="pointer-events-none absolute left-0 right-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-accent to-transparent"
          style={{ backgroundSize: '220% 100%' }}
          initial={{ opacity: 0 }}
          animate={{
            opacity: 0.9,
            backgroundPosition: ['0% 50%', '100% 50%', '0% 50%'],
          }}
          exit={{ opacity: 0 }}
          transition={{
            opacity: { duration: 0.2, ease: 'easeOut' },
            backgroundPosition: { duration: 1.6, repeat: Infinity, ease: 'easeInOut' },
          }}
        />
      )}
    </AnimatePresence>
  )

  /* ---- Layout ---- */
  return (
    <div
      className={cn(
        'relative flex items-center gap-1',
        compact ? 'h-[38px] px-1.5' : 'h-[48px] border-b border-foreground/6 px-3',
        className,
      )}
    >
      {leadingContent}

      <NavButton aria-label={t('common.back')} disabled={!canGoBack} onClick={onGoBack}>
        <ChevronLeft className="h-[18px] w-[18px] text-foreground/70" strokeWidth={1.5} />
      </NavButton>
      <NavButton aria-label={t('common.forward')} disabled={!canGoForward} onClick={onGoForward}>
        <ChevronRight className="h-[18px] w-[18px] text-foreground/70" strokeWidth={1.5} />
      </NavButton>

      <div className="flex-1 flex items-center min-w-0">
        <div className={cn('mx-auto flex items-center gap-1 w-full', urlBarClassName)}>
          {reloadButton}
          {urlForm}
        </div>
      </div>

      {trailingContent}
      {progressBar}
    </div>
  )
}
