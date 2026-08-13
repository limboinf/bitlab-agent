/**
 * HtmlFilePreviewOverlay - Overlay for .html files opened from the transcript.
 *
 * Code alone is not much use for a page an agent just authored, so this overlay
 * offers both: a live preview and the source, switchable in the header.
 *
 * The preview loads the file through `getHtmlPreviewUrl` (Electron's
 * html-preview:// scheme) rather than inlining it via srcDoc. A srcDoc iframe
 * inherits the app's CSP, which blocks third-party scripts, styles and fonts —
 * a page pulling in p5.js from a CDN would render broken. Loading from a URL
 * gives the page its own document with no inherited CSP, and lets its relative
 * paths resolve against its own directory. Platforms without that URL (the web
 * viewer) fall back to srcDoc, which still renders self-contained pages.
 *
 * `allow-scripts` is set so animation and interaction actually run.
 * `allow-same-origin` is not, so the page can't reach the app's own origin.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Code2, Eye } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { ContentFrame } from './ContentFrame'
import { ShikiCodeViewer } from '../code-viewer/ShikiCodeViewer'
import { usePlatform } from '../../context/PlatformContext'
import { cn } from '../../lib/utils'

const PREVIEW_SANDBOX = 'allow-scripts allow-top-navigation-by-user-activation'

/** Card width shared by both tabs so switching doesn't resize the frame. */
const CARD_WIDTH = 1100

export interface HtmlFilePreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** The HTML source */
  content: string
  /** File path for display, preview URL, and the "open in browser" action */
  filePath: string
  /** Theme mode */
  theme?: 'light' | 'dark'
  /** Error message if the read failed */
  error?: string
  /** Render inline without dialog (for playground) */
  embedded?: boolean
}

type Tab = 'preview' | 'code'

export function HtmlFilePreviewOverlay({
  isOpen,
  onClose,
  content,
  filePath,
  theme = 'light',
  error,
  embedded,
}: HtmlFilePreviewOverlayProps) {
  const { t } = useTranslation()
  const { onOpenFileInBrowser, getHtmlPreviewUrl } = usePlatform()
  const [tab, setTab] = React.useState<Tab>('preview')

  // A failed read has no source to preview — show the error over the code view.
  const canPreview = !error && content.trim().length > 0
  const activeTab: Tab = canPreview ? tab : 'code'

  const previewUrl = React.useMemo(
    () => getHtmlPreviewUrl?.(filePath),
    [getHtmlPreviewUrl, filePath]
  )

  // Start on the preview each time the overlay opens on a file
  React.useEffect(() => {
    if (isOpen) setTab('preview')
  }, [isOpen, filePath])

  const headerActions = (
    <div className="flex items-center gap-1.5">
      {canPreview && (
        <div className="flex items-center gap-0.5 p-0.5 rounded-[7px] bg-background shadow-minimal">
          <TabButton
            icon={Eye}
            label={t('overlay.preview')}
            isActive={activeTab === 'preview'}
            onClick={() => setTab('preview')}
          />
          <TabButton
            icon={Code2}
            label={t('overlay.code')}
            isActive={activeTab === 'code'}
            onClick={() => setTab('code')}
          />
        </div>
      )}
      {onOpenFileInBrowser && (
        <button
          type="button"
          onClick={() => onOpenFileInBrowser(filePath)}
          title={t('overlay.openInBrowser')}
          aria-label={t('overlay.openInBrowser')}
          className={cn(
            'p-1.5 rounded-[6px] bg-background shadow-minimal cursor-pointer',
            'opacity-70 hover:opacity-100 transition-opacity',
            'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
        >
          <Globe className="w-4 h-4" />
        </button>
      )}
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{ icon: Globe, label: 'HTML', variant: 'blue' }}
      filePath={filePath}
      error={error ? { label: t('overlay.readFailed'), message: error } : undefined}
      headerActions={headerActions}
      embedded={embedded}
      className="bg-foreground-3"
    >
      {activeTab === 'preview' ? (
        <ContentFrame title={t('overlay.preview')} maxWidth={CARD_WIDTH}>
          <iframe
            key={previewUrl ?? 'inline'}
            sandbox={PREVIEW_SANDBOX}
            {...(previewUrl ? { src: previewUrl } : { srcDoc: content })}
            title={filePath}
            className="w-full border-0 bg-white rounded-b-2xl"
            style={{ height: 'min(78vh, 820px)' }}
          />
        </ContentFrame>
      ) : (
        <ContentFrame title={t('overlay.code')} maxWidth={CARD_WIDTH}>
          <div className="overflow-x-auto">
            <ShikiCodeViewer code={content} filePath={filePath} language="html" theme={theme} />
          </div>
        </ContentFrame>
      )}
    </PreviewOverlay>
  )
}

function TabButton({
  icon: Icon,
  label,
  isActive,
  onClick,
}: {
  icon: typeof Globe
  label: string
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded-[5px] text-xs cursor-pointer transition-colors',
        'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        isActive ? 'bg-foreground-3 text-foreground' : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  )
}
