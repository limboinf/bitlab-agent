/**
 * BrowserDockToggle
 *
 * Top-bar control that opens/closes the browser dock. It replaces the old
 * per-window badge strip: with tabs living inside the dock there is exactly one
 * thing to toggle, and the badge only has to answer "is anything running in
 * there, and does it want me?".
 */

import { useAtom, useAtomValue } from 'jotai'
import { useMemo } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { browserInstancesAtom, filterInstancesForWorkspace } from '@/atoms/browser-pane'
import { browserDockOpenAtom } from '@/atoms/browser-dock'
import { useAppShellContext } from '@/context/AppShellContext'
import { TopBarButton } from '@/components/ui/TopBarButton'

export function BrowserDockToggle() {
  const { t } = useTranslation()
  const { activeWorkspaceId } = useAppShellContext()
  const allInstances = useAtomValue(browserInstancesAtom)
  const [isOpen, setIsOpen] = useAtom(browserDockOpenAtom)

  const instances = useMemo(
    () => filterInstancesForWorkspace(allInstances, activeWorkspaceId),
    [allInstances, activeWorkspaceId],
  )

  if (instances.length === 0) return null

  const agentActive = instances.some((i) => i.agentControlActive)
  const label = isOpen ? t('browser.closeDock') : t('browser.toggleDock')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TopBarButton
          onClick={() => setIsOpen(!isOpen)}
          aria-label={label}
          aria-pressed={isOpen}
          className={`relative h-[26px] w-[26px] rounded-lg ${isOpen ? 'bg-foreground/[0.06]' : ''}`}
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
