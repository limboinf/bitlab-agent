/**
 * Top-bar control for the right dock.
 *
 * Always present, unlike the artifact-count badge it replaced: the dock is a
 * permanent part of the layout now, so its switch has to be somewhere stable
 * rather than appearing once a task happens to produce a file.
 */

import { useAtom } from 'jotai'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@bitlab/ui'
import { rightDockOpenAtom } from '@/atoms/right-dock'
import { TopBarButton } from '@/components/ui/TopBarButton'

export function RightDockToggle() {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useAtom(rightDockOpenAtom)

  const label = isOpen ? t('artifacts.closeDock') : t('artifacts.openDock')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <TopBarButton
          onClick={() => setIsOpen(!isOpen)}
          aria-label={label}
          aria-pressed={isOpen}
          className={`relative h-[26px] w-[26px] rounded-lg ${isOpen ? 'bg-foreground/[0.06]' : ''}`}
        >
          <Icons.PanelRight className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
        </TopBarButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
