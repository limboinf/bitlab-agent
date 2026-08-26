/**
 * BrowserDockToggle
 *
 * Top-bar control that shows the browser in the right dock. It replaces the old
 * per-window badge strip: with tabs living inside the dock there is exactly one
 * thing to toggle, and the badge only has to answer "is anything running in
 * there, and does it want me?".
 *
 * Pressed means "the dock is showing the browser" — not merely "the dock is
 * open", which would light up while the user reads artifacts.
 */

import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useMemo } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { browserInstancesAtom, filterInstancesForWorkspace } from '@/atoms/browser-pane'
import { openRightDockBrowserAtom, rightDockModeAtom, rightDockOpenAtom } from '@/atoms/right-dock'
import { useAppShellContext } from '@/context/AppShellContext'
import { TopBarButton } from '@/components/ui/TopBarButton'

export function BrowserDockToggle() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const allInstances = useAtomValue(browserInstancesAtom)
  const [isDockOpen, setDockOpen] = useAtom(rightDockOpenAtom)
  const dockMode = useAtomValue(rightDockModeAtom)
  const showBrowserInDock = useSetAtom(openRightDockBrowserAtom)

  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId),
    [allInstances, activeWorkspaceId],
  )

  if (instances.length === 0) return null

  const agentActive = instances.some((i) => i.agentControlActive)
  const isShowingBrowser = isDockOpen && dockMode === 'browser'
  const label = isShowingBrowser ? t('browser.closeDock') : t('browser.toggleDock')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TopBarButton
          onClick={() => (isShowingBrowser ? setDockOpen(false) : showBrowserInDock())}
          aria-label={label}
          aria-pressed={isShowingBrowser}
          className={`relative h-[26px] w-[26px] rounded-lg ${isShowingBrowser ? 'bg-foreground/[0.06]' : ''}`}
        >
          <Icons.Globe
            className={`h-4 w-4 ${agentActive ? 'text-accent' : 'text-foreground/50'}`}
            strokeWidth={1.5}
          />
          {instances.length > 1 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-foreground/15 px-[3px] text-[9px] leading-none text-foreground/70">
              {instances.length}
            </span>
          )}
        </TopBarButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
