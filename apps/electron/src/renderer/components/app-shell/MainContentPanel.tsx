/**
 * MainContentPanel - retained Craft content routes for Bitlab Lite.
 *
 * The panel keeps Craft's settings, Skills, sessions, focus-mode stoplight
 * handling, and multi-select shell while physically excluding removed product
 * navigators.
 */

import * as React from 'react'
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Panel } from './Panel'
import { MultiSelectPanel } from './MultiSelectPanel'
import { WelcomePanel } from './WelcomePanel'
import { NewSessionPlaceholder } from './NewSessionPlaceholder'
import { useAppShellContext } from '@/context/AppShellContext'
import { StoplightProvider } from '@/context/StoplightContext'
import {
  useNavigationState,
  isSessionsNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
} from '@/contexts/NavigationContext'
import {
  useSessionSelection,
  useIsMultiSelectActive,
  useSelectedIds,
  useSelectionCount,
} from '@/hooks/useSession'
import { skillSelection } from '@/hooks/useEntitySelection'
import { ChatPage } from '@/pages'
import SkillsCatalogPage from '@/pages/SkillsCatalogPage'
import { getSettingsPageComponent } from '@/pages/settings/settings-pages'

export interface MainContentPanelProps {
  isSidebarAndNavigatorHidden?: boolean
  className?: string
  navStateOverride?: import('../../../shared/types').NavigationState | null
}
export function MainContentPanel({
  isSidebarAndNavigatorHidden = false,
  className,
  navStateOverride,
}: MainContentPanelProps) {
  const { t } = useTranslation()
  const globalNavState = useNavigationState()
  const navState = navStateOverride ?? globalNavState
  const { onArchiveSession } = useAppShellContext()

  const isMultiSelectActive = useIsMultiSelectActive()
  const selectedIds = useSelectedIds()
  const selectionCount = useSelectionCount()
  const { clearMultiSelect } = useSessionSelection()

  const isSkillMultiSelectActive = skillSelection.useIsMultiSelectActive()
  const skillSelectionCount = skillSelection.useSelectionCount()
  const { clearMultiSelect: clearSkillSelection } = skillSelection.useSelection()

  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(sessionId => onArchiveSession(sessionId))
    clearMultiSelect()
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  const wrapWithStoplight = (content: React.ReactNode) => (
    <StoplightProvider value={isSidebarAndNavigatorHidden}>
      {content}
    </StoplightProvider>
  )

  if (isSettingsNavigation(navState)) {
    const SettingsPageComponent = getSettingsPageComponent(navState.subpage ?? 'app')
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SettingsPageComponent />
      </Panel>,
    )
  }

  if (isSkillsNavigation(navState)) {
    if (isSkillMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={skillSelectionCount}
            entityType="skill"
            onClearSelection={clearSkillSelection}
          />
        </Panel>,
      )
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SkillsCatalogPage />
      </Panel>,
    )
  }

  if (isSessionsNavigation(navState)) {
    if (isMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={selectionCount}
            onArchive={handleBatchArchive}
            onClearSelection={clearMultiSelect}
          />
        </Panel>,
      )
    }
    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <ChatPage sessionId={navState.details.sessionId} />
        </Panel>,
      )
    }
    if (navState.isNewSessionDraft) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <NewSessionPlaceholder />
        </Panel>,
      )
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <WelcomePanel />
      </Panel>,
    )
  }

  return wrapWithStoplight(
    <Panel variant="grow" className={className}>
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">{t('session.selectConversation')}</p>
      </div>
    </Panel>,
  )
}
