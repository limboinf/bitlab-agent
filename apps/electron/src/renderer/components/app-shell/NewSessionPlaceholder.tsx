import { useTranslation } from 'react-i18next'
import { useActiveWorkspace } from '@/context/AppShellContext'
import { WelcomeHero } from './WelcomeHero'

/**
 * Transitional surface for the `allSessions/new` draft route.
 *
 * "New task" parks the panel here for the frame or two it takes to create the
 * real session, then swaps in {@link ChatPage}. It shows the same hero in the
 * same position as the empty-chat state so the composer appears to grow in
 * underneath it instead of the whole panel swapping.
 */
export function NewSessionPlaceholder() {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-8 @container/welcome"
      aria-busy="true"
    >
      <div className="relative -top-[3vh] flex w-full max-w-[720px] flex-col items-center">
        <WelcomeHero workspaceName={workspace?.name ?? t('welcome.workspaceFallback')} />
      </div>
    </div>
  )
}
