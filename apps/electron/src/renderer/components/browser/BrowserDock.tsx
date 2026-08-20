/**
 * BrowserDock
 *
 * The right-hand browser column. One dock per window, N tabs inside it —
 * browser instances are never separate native windows.
 *
 * Everything above the page (tab strip, toolbar, empty/crash states, the
 * agent-control ring) is ordinary React. Only the page itself is a native
 * WebContentsView, parked by the main process on the placeholder rect at the
 * bottom of this component. That split matters: native views paint above all
 * renderer content, so keeping chrome in React is what lets menus and dialogs
 * work at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BrowserControls, Spinner } from '@bitlab/ui'
import {
  activeBrowserInstanceIdAtom,
  browserInstancesAtom,
  filterInstancesForWorkspace,
} from '@/atoms/browser-pane'
import {
  browserDockOpenAtom,
  browserDockSuppressedAtom,
  browserDockWidthAtom,
} from '@/atoms/browser-dock'
import { useAppShellContext } from '@/context/AppShellContext'
import type { BrowserInstanceInfo } from '../../../shared/types'
import { getHostname } from './utils'
import { useDockBoundsSync } from './useDockBoundsSync'
import { useOverlayOcclusionSuppression } from './useDockSuppression'
import { buildBrowserMentionToken, useBrowserMentionPage } from './useBrowserMentionPage'
import { useAnnotationPicks } from './useAnnotationPicks'

/** Height of the tab strip; mirrors --topbar-height so the dock lines up with the app chrome. */
const TAB_STRIP_HEIGHT = 'var(--topbar-height)'

interface DockTabProps {
  instance: BrowserInstanceInfo
  isActive: boolean
  /** True when another chat session owns this tab — the agent may drive it out of view. */
  isForeignSession: boolean
  foreignLabel: string
  onSelect: () => void
  onClose: () => void
  closeLabel: string
}

function DockTab({
  instance,
  isActive,
  isForeignSession,
  foreignLabel,
  onSelect,
  onClose,
  closeLabel,
}: DockTabProps) {
  const [faviconFailed, setFaviconFailed] = useState(false)
  useEffect(() => { setFaviconFailed(false) }, [instance.favicon])

  const label = instance.title.trim() || getHostname(instance.url)

  return (
    <div
      className={`
        group flex h-[26px] min-w-0 max-w-[180px] flex-1 items-center gap-1.5 rounded-lg pl-2 pr-1
        text-[11px] leading-tight transition-colors titlebar-no-drag
        ${isActive ? 'bg-background shadow-minimal text-foreground' : 'text-foreground/60 hover:bg-foreground/[0.04]'}
        ${instance.agentControlActive ? 'ring-1 ring-accent' : ''}
      `}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 cursor-pointer"
        title={label}
      >
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">
          {instance.isLoading ? (
            <Spinner className="text-[9px] leading-none" />
          ) : instance.favicon && !faviconFailed ? (
            <img
              src={instance.favicon}
              alt=""
              className="block h-3 w-3 rounded-sm"
              onError={() => setFaviconFailed(true)}
            />
          ) : (
            <Icons.Globe className="h-3 w-3" />
          )}
        </span>
        <span className="truncate">{label}</span>

        {isForeignSession && (
          <Icons.Link2
            className="h-2.5 w-2.5 shrink-0 opacity-50"
            strokeWidth={2}
            aria-label={foreignLabel}
          />
        )}
      </button>

      <button
        type="button"
        onClick={onClose}
        aria-label={closeLabel}
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-0 transition-opacity hover:bg-foreground/10 group-hover:opacity-70"
      >
        <Icons.X className="h-2.5 w-2.5" />
      </button>
    </div>
  )
}

/** Shown in the page area when there is no live native view to cover it. */
function DockPlaceholderState({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode
  title: string
  description: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="text-foreground/30">{icon}</div>
      <div className="text-[13px] font-medium text-foreground/80">{title}</div>
      <div className="max-w-[280px] text-[11px] leading-relaxed text-foreground/45">{description}</div>
      {action}
    </div>
  )
}

interface BrowserDockProps {
  /** Chat session currently in focus, used to flag tabs owned by another session. */
  activeSessionId?: string | null
}

export function BrowserDock({ activeSessionId }: BrowserDockProps) {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()

  const allInstances = useAtomValue(browserInstancesAtom)
  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId),
    [allInstances, activeWorkspaceId],
  )

  const [activeInstanceId, setActiveInstanceId] = useAtom(activeBrowserInstanceIdAtom)
  const [isOpen, setIsOpen] = useAtom(browserDockOpenAtom)
  const suppressed = useAtomValue(browserDockSuppressedAtom)
  const dockWidth = useAtomValue(browserDockWidthAtom)

  const placeholderRef = useRef<HTMLDivElement>(null)
  const mentionPage = useBrowserMentionPage()
  const [isAnnotating, setIsAnnotating] = useState(false)

  // Picks arrive as composer attachments; nothing to render here.
  useAnnotationPicks(activeSessionId)
  const [urlDraft, setUrlDraft] = useState<string | null>(null)

  // Keep the active tab pointing at something real: when the active instance
  // disappears (closed, crashed away, workspace switch) fall back to the newest.
  const activeInstance = useMemo(
    () => instances.find((i) => i.id === activeInstanceId) ?? null,
    [instances, activeInstanceId],
  )

  useEffect(() => {
    if (activeInstance || instances.length === 0) return
    const fallback = instances[instances.length - 1]
    if (fallback) setActiveInstanceId(fallback.id)
  }, [activeInstance, instances, setActiveInstanceId])

  // An empty dock has nothing to show; close it rather than leaving a blank column.
  useEffect(() => {
    if (isOpen && instances.length === 0) setIsOpen(false)
  }, [isOpen, instances.length, setIsOpen])

  const hasLiveView = !!activeInstance && !activeInstance.crashed

  // Fullscreen preview overlays (image, markdown, diff...) can't stack above a
  // native view, so they detach it instead.
  useOverlayOcclusionSuppression()

  useDockBoundsSync(placeholderRef, {
    visible: isOpen && hasLiveView,
    suppressed,
    activeInstanceId: activeInstance?.id ?? null,
  })

  // The address bar shows the live URL unless the user is mid-edit.
  useEffect(() => { setUrlDraft(null) }, [activeInstance?.id, activeInstance?.url])

  const api = window.electronAPI?.browserPane

  const handleNavigate = useCallback((url: string) => {
    if (!activeInstance) return
    setUrlDraft(null)
    void api?.navigate(activeInstance.id, url)
  }, [activeInstance, api])

  const handleCloseTab = useCallback((id: string) => {
    void api?.destroy(id)
  }, [api])

  // Hands the page to the composer as an @browser chip rather than pasting text:
  // the agent reads the body through a tool call the user can see.
  const handleSendToChat = useCallback(() => {
    if (!mentionPage) return
    window.dispatchEvent(new CustomEvent('craft:insert-text', {
      detail: { text: buildBrowserMentionToken(mentionPage), append: true, sessionId: activeSessionId ?? undefined },
    }))
  }, [mentionPage, activeSessionId])

  // Annotation mode lives on the page itself (the dock's page area is a native
  // view), so toggling it is a round trip to the main process.
  const toggleAnnotating = useCallback(() => {
    if (!activeInstance) return
    const next = !isAnnotating
    setIsAnnotating(next)
    void api?.setAnnotationMode(activeInstance.id, next)
  }, [activeInstance, isAnnotating, api])

  // Switching or closing the tab drops the picker with it.
  useEffect(() => {
    if (isAnnotating && !activeInstance) setIsAnnotating(false)
  }, [isAnnotating, activeInstance])

  const handleNewTab = useCallback(async () => {
    const id = await api?.create({ show: true })
    if (id) setActiveInstanceId(id)
  }, [api, setActiveInstanceId])

  if (!isOpen) return null

  return (
    <aside
      data-panel-role="browser-dock"
      className="relative flex h-full shrink-0 flex-col border-l border-border/40 bg-foreground-2"
      style={{ width: dockWidth }}
    >
      {/* Tab strip — also the drag region, since the dock reaches the window top. */}
      <div
        className="flex shrink-0 items-center gap-1 px-2 titlebar-drag-region"
        style={{ height: TAB_STRIP_HEIGHT }}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {instances.map((instance) => (
            <DockTab
              key={instance.id}
              instance={instance}
              isActive={instance.id === activeInstance?.id}
              isForeignSession={
                !!instance.boundSessionId && instance.boundSessionId !== activeSessionId
              }
              foreignLabel={t('browser.ownedByOtherSession')}
              onSelect={() => setActiveInstanceId(instance.id)}
              onClose={() => handleCloseTab(instance.id)}
              closeLabel={t('browser.closeTab')}
            />
          ))}

          <button
            type="button"
            onClick={() => { void handleNewTab() }}
            aria-label={t('browser.newTab')}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] titlebar-no-drag"
          >
            <Icons.Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </div>

        {activeInstance && (
          <button
            type="button"
            onClick={toggleAnnotating}
            aria-label={t('browser.annotate')}
            aria-pressed={isAnnotating}
            title={t('browser.annotate')}
            className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors titlebar-no-drag ${
              isAnnotating ? 'bg-accent text-white' : 'text-foreground/50 hover:bg-foreground/[0.06]'
            }`}
          >
            <Icons.SquareDashedMousePointer className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        )}

        {mentionPage && (
          <button
            type="button"
            onClick={handleSendToChat}
            aria-label={t('browser.sendToChat')}
            title={t('browser.sendToChat')}
            className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] titlebar-no-drag"
          >
            <Icons.MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        )}

        <button
          type="button"
          onClick={() => setIsOpen(false)}
          aria-label={t('browser.closeDock')}
          className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-foreground/50 transition-colors hover:bg-foreground/[0.06] titlebar-no-drag"
        >
          <Icons.X className="h-3.5 w-3.5" strokeWidth={1.5} />
        </button>
      </div>

      {/*
        Toolbar — the React one. There is no native toolbar view any more.

        It deliberately does *not* pick up the page's theme color: in a dock the
        toolbar is app chrome sitting under the tab strip, so tinting it with the
        site's color split the header into two unrelated surfaces. The site color
        still shows up where it reads as a hint rather than a surface — the
        composer's browser status chip.
      */}
      <div className="shrink-0 border-b border-border/40">
        <BrowserControls
          compact
          url={urlDraft ?? activeInstance?.url ?? ''}
          loading={activeInstance?.isLoading ?? false}
          canGoBack={activeInstance?.canGoBack ?? false}
          canGoForward={activeInstance?.canGoForward ?? false}
          onUrlChange={setUrlDraft}
          onNavigate={handleNavigate}
          onGoBack={() => activeInstance && void api?.goBack(activeInstance.id)}
          onGoForward={() => activeInstance && void api?.goForward(activeInstance.id)}
          onReload={() => activeInstance && void api?.reload(activeInstance.id)}
          onStop={() => activeInstance && void api?.stop(activeInstance.id)}
        />
      </div>

      {/*
        Agent-control banner. It sits *above* the page rect rather than over it:
        an overlay would be painted under the native view no matter its z-index.
      */}
      {activeInstance?.agentControlActive && (
        <div className="flex shrink-0 items-center justify-center gap-1.5 bg-accent px-2 py-1 text-[10px] font-medium text-white">
          <Icons.Sparkles className="h-3 w-3 shrink-0" strokeWidth={2} />
          <span className="truncate">
            {activeInstance.agentControlLabel || t('browser.agentDriving')}
          </span>
        </div>
      )}

      {/*
        The accent frame is padding, not a ring — it has to occupy real layout
        space outside the placeholder rect to survive the native view on top.
      */}
      <div
        className={`
          min-h-0 flex-1 overflow-hidden
          ${activeInstance?.agentControlActive ? 'bg-accent p-[2px] pt-0' : 'bg-background'}
        `}
      >
        {/*
          The page view is parked exactly on this rect by the main process.
          Content here is only ever visible when no live view covers it.
        */}
        <div ref={placeholderRef} className="h-full w-full bg-background">
          {!activeInstance && (
            <DockPlaceholderState
              icon={<Icons.Globe className="h-7 w-7" strokeWidth={1.25} />}
              title={t('browser.emptyTitle')}
              description={t('browser.emptyDescription')}
            />
          )}

          {activeInstance?.crashed && (
            <DockPlaceholderState
              icon={<Icons.TriangleAlert className="h-7 w-7" strokeWidth={1.25} />}
              title={t('browser.crashedTitle')}
              description={t('browser.crashedDescription')}
              action={(
                <button
                  type="button"
                  onClick={() => void api?.reload(activeInstance.id)}
                  className="mt-1 rounded-lg bg-foreground/[0.06] px-3 py-1 text-[11px] text-foreground/80 transition-colors hover:bg-foreground/10"
                >
                  {t('browser.reloadPage')}
                </button>
              )}
            />
          )}
        </div>
      </div>
    </aside>
  )
}
