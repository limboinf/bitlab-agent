/**
 * RightDock
 *
 * The window's one right-hand column, and a permanent one — it is where the
 * result of a task lives, so it does not wait to be summoned.
 *
 * Artifacts, changes and files are collapsible sections rather than tabs: they
 * answer adjacent questions ("what did it make", "what did it touch", "what is
 * in this session"), and a tab bar forces you to pick one. The browser is the
 * exception and takes over the whole column, because a native WebContentsView
 * needs a rect that does not move when a sibling section expands.
 */

import { useEffect } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { RPC_CHANNELS } from '@bitlab/shared/protocol'
import {
  rightDockModeAtom,
  rightDockOpenAtom,
  rightDockSectionsAtom,
} from '@/atoms/right-dock'
import { BrowserPanel } from '../browser/BrowserPanel'
import { useSessionArtifacts } from '@/hooks/useSessionArtifacts'
import { cn } from '@/lib/utils'
import { RightDockSections } from './RightDockSections'

/** Height of the dock header; mirrors --topbar-height so the dock lines up with the app chrome. */
const HEADER_HEIGHT = 'var(--topbar-height)'

/**
 * The browser panel needs a native WebContentsView, which only the desktop host
 * can park. A remote WebUI has no such host, so the mode is not offered there —
 * entering it anyway would leave the panel pushing dock geometry at a channel
 * nobody answers.
 */
export function useBrowserPanelAvailable(): boolean {
  return window.electronAPI?.isChannelAvailable?.(RPC_CHANNELS.browserPane.LIST) ?? false
}

function HeaderButton({
  label,
  onClick,
  isActive,
  children,
}: {
  label: string
  onClick: () => void
  isActive?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={isActive}
      className={cn(
        'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors titlebar-no-drag',
        isActive ? 'bg-foreground/[0.08] text-foreground' : 'text-foreground/50 hover:bg-foreground/[0.06]',
      )}
    >
      {children}
    </button>
  )
}

export function RightDock({
  activeSessionId,
  width,
}: {
  activeSessionId?: string | null
  /** Resolved by the shell, which is the only thing that knows how much room is left. */
  width: number
}) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useAtom(rightDockOpenAtom)
  const [mode, setMode] = useAtom(rightDockModeAtom)
  const expanded = useAtomValue(rightDockSectionsAtom)
  const toggleSection = useSetAtom(rightDockSectionsAtom)
  const hasBrowserPanel = useBrowserPanelAvailable()
  const { artifacts, changes } = useSessionArtifacts(activeSessionId)

  // A persisted browser mode must not strand the dock on a view this host
  // cannot show.
  useEffect(() => {
    if (!hasBrowserPanel && mode === 'browser') setMode('sections')
  }, [hasBrowserPanel, mode, setMode])

  if (!isOpen) return null

  const showingBrowser = hasBrowserPanel && mode === 'browser'

  return (
    <aside
      data-panel-role="right-dock"
      className="relative flex h-full shrink-0 flex-col border-l border-border/40 bg-foreground-2"
      style={{ width }}
    >
      {/* Header — also the drag region, since the dock reaches the window top. */}
      <div
        className="flex shrink-0 items-center gap-1 px-2 titlebar-drag-region"
        style={{ height: HEADER_HEIGHT }}
      >
        {/* No title in sections mode — the first section header sits right
            below it and said the same word twice. */}
        <span className="min-w-0 flex-1 truncate pl-1 text-[11px] font-medium text-foreground/70">
          {showingBrowser ? t('artifacts.browserTab') : ''}
        </span>

        {hasBrowserPanel && (
          <HeaderButton
            label={showingBrowser ? t('artifacts.backToSections') : t('artifacts.browserTab')}
            onClick={() => setMode(showingBrowser ? 'sections' : 'browser')}
            isActive={showingBrowser}
          >
            <Icons.Globe className="h-3.5 w-3.5" strokeWidth={1.5} />
          </HeaderButton>
        )}

        <HeaderButton label={t('artifacts.closeDock')} onClick={() => setIsOpen(false)}>
          <Icons.PanelRightClose className="h-3.5 w-3.5" strokeWidth={1.5} />
        </HeaderButton>
      </div>

      {/*
        The browser stays mounted while sections are showing so its tabs keep
        their listeners; `hidden` collapses its placeholder to nothing, which is
        also what tells the main process to detach the native view.
      */}
      {hasBrowserPanel && (
        <div className={cn('min-h-0 flex-1 flex-col', showingBrowser ? 'flex' : 'hidden')}>
          <BrowserPanel activeSessionId={activeSessionId} />
        </div>
      )}

      <div className={cn('min-h-0 flex-1 flex-col', showingBrowser ? 'hidden' : 'flex')}>
        <RightDockSections
          activeSessionId={activeSessionId}
          artifacts={artifacts}
          changes={changes}
          expanded={expanded}
          onToggleSection={toggleSection}
        />
      </div>
    </aside>
  )
}
