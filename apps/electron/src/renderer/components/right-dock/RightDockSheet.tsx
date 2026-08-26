/**
 * The dock's compact form.
 *
 * Below the mobile threshold there is no room for a right column, so the same
 * sections arrive as a sheet over the chat. It shares the section components
 * with the desktop dock — the layout changes, the content does not.
 *
 * The browser is deliberately absent: a native WebContentsView cannot sit
 * inside a sheet, and compact layout keeps its existing browser behaviour.
 */

import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { rightDockOpenAtom, rightDockSectionsAtom } from '@/atoms/right-dock'
import { useSessionArtifacts } from '@/hooks/useSessionArtifacts'
import { RightDockSections } from './RightDockSections'

export function RightDockSheet({ activeSessionId }: { activeSessionId?: string | null }) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useAtom(rightDockOpenAtom)
  const expanded = useAtomValue(rightDockSectionsAtom)
  const toggleSection = useSetAtom(rightDockSectionsAtom)
  const { artifacts, changes } = useSessionArtifacts(activeSessionId)

  return (
    <Drawer open={isOpen} onOpenChange={setIsOpen} direction="bottom">
      <DrawerContent className="inset-x-2 bottom-2 mt-0 h-[88vh] overflow-hidden rounded-[14px] border border-border/60 bg-background">
        <DrawerHeader className="shrink-0 border-b border-border/50 px-4 py-2 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
          <DrawerTitle className="text-[13px] font-medium">{t('artifacts.title')}</DrawerTitle>
        </DrawerHeader>

        {/* vaul starts a sheet drag from anywhere it is not told not to, which
            would swallow taps on the section headers. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden" data-vaul-no-drag>
          <RightDockSections
            activeSessionId={activeSessionId}
            artifacts={artifacts}
            changes={changes}
            expanded={expanded}
            onToggleSection={toggleSection}
          />
        </div>
      </DrawerContent>
    </Drawer>
  )
}
