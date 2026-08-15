/**
 * HTMLPreviewOverlay - Fullscreen overlay for viewing rendered HTML content.
 *
 * Uses PreviewOverlay as the base for consistent modal/fullscreen behavior.
 * Renders HTML in a sandboxed iframe (no script execution).
 * Links open in the system browser via Electron's will-navigate handler.
 *
 * Supports multiple items with arrow navigation in the header.
 * The iframe auto-sizes to its content height by reading contentDocument.scrollHeight
 * on load (possible because allow-same-origin is set).
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ItemNavigator } from './ItemNavigator'

/**
 * Inject `<base target="_top">` so link clicks navigate the top frame,
 * which Electron's will-navigate handler intercepts → system browser.
 */
function injectBaseTarget(html: string): string {
  if (/<base\s/i.test(html)) return html
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/(<head[^>]*>)/i, '$1<base target="_top">')
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/(<html[^>]*>)/i, '$1<head><base target="_top"></head>')
  }
  return `<head><base target="_top"></head>${html}`
}

/** Widest layout the content is offered while being measured. */
const PROBE_WIDTH = 1600
/** Floor, so degenerate measurements can't collapse the preview to nothing. */
const MIN_CONTENT_WIDTH = 480

/**
 * Measure how wide the content *wants* to be.
 *
 * `fit-content` answers the opposite question — how narrow it can be squeezed —
 * which collapses responsive layouts (a wrapping grid reports one column wide).
 * Instead, lay the body out at PROBE_WIDTH and take the widest top-level child:
 * a fixed-width email reports its own width, a fluid layout reports PROBE_WIDTH.
 */
function measureContentWidth(doc: Document): number {
  const body = doc.body
  const origWidth = body.style.width
  body.style.width = `${PROBE_WIDTH}px`
  let widest = 0
  for (const child of Array.from(body.children)) {
    widest = Math.max(widest, child.getBoundingClientRect().width)
  }
  body.style.width = origWidth
  // Bare text nodes have no element children — fall back to the body itself
  return Math.min(Math.max(widest || body.scrollWidth, MIN_CONTENT_WIDTH), PROBE_WIDTH)
}

interface PreviewItem {
  src: string
  label?: string
}

export interface HTMLPreviewOverlayProps {
  /** Whether the overlay is visible */
  isOpen: boolean
  /** Callback when the overlay should close */
  onClose: () => void
  /** Single HTML content (backward compat for link interceptor usage) */
  html?: string
  /** Multiple items for tabbed navigation */
  items?: PreviewItem[]
  /** Pre-loaded content cache (src → html string) */
  contentCache?: Record<string, string>
  /** Callback to load content for uncached items */
  onLoadContent?: (src: string) => Promise<string>
  /** Initial active item index (defaults to 0) */
  initialIndex?: number
  /** Optional title for the overlay header */
  title?: string
  /** Theme mode for dark/light styling */
  theme?: 'light' | 'dark'
}

export function HTMLPreviewOverlay({
  isOpen,
  onClose,
  html,
  items,
  contentCache: externalCache,
  onLoadContent,
  initialIndex = 0,
  title,
  theme,
}: HTMLPreviewOverlayProps) {
  // Normalize: single html prop → single item, or use items array
  const { t } = useTranslation()
  const resolvedItems = React.useMemo<PreviewItem[]>(() => {
    if (items && items.length > 0) return items
    if (html) return [{ src: '__single__' }]
    return []
  }, [items, html])

  const [activeIdx, setActiveIdx] = React.useState(initialIndex)
  const iframeRef = React.useRef<HTMLIFrameElement>(null)
  const resizeObserverRef = React.useRef<ResizeObserver | null>(null)
  const [contentSize, setContentSize] = React.useState<{ width: number; height: number } | null>(null)

  // Internal content cache (merges external + locally loaded)
  const [internalCache, setInternalCache] = React.useState<Record<string, string>>({})
  const [loadingItem, setLoadingItem] = React.useState(false)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  // Merge caches — external takes precedence, plus single html prop
  const mergedCache = React.useMemo(() => {
    const merged: Record<string, string> = { ...internalCache }
    if (externalCache) Object.assign(merged, externalCache)
    if (html) merged['__single__'] = html
    return merged
  }, [internalCache, externalCache, html])

  const activeItem = resolvedItems[activeIdx]
  const activeContent = activeItem ? mergedCache[activeItem.src] : undefined

  // Reset index when overlay opens
  React.useEffect(() => {
    if (isOpen) {
      setActiveIdx(initialIndex)
      setContentSize(null)
    }
  }, [isOpen, initialIndex])

  // Reset size when active item changes
  React.useEffect(() => {
    setContentSize(null)
    setLoadError(null)
  }, [activeIdx])

  // Load content for active item if not cached
  React.useEffect(() => {
    if (!isOpen || !activeItem?.src) return
    if (mergedCache[activeItem.src]) return
    if (!onLoadContent) return

    setLoadingItem(true)
    setLoadError(null)
    onLoadContent(activeItem.src)
      .then((content) => {
        setInternalCache((prev) => ({ ...prev, [activeItem.src]: content }))
      })
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load content')
      })
      .finally(() => setLoadingItem(false))
  }, [isOpen, activeItem?.src, mergedCache, onLoadContent])

  // Preprocess active HTML
  const processedHtml = React.useMemo(
    () => activeContent ? injectBaseTarget(activeContent) : null,
    [activeContent]
  )

  // Read iframe content dimensions after it loads.
  //
  // The width cap reflows the content, so the height measured here goes stale the
  // moment it lands. A ResizeObserver on <body> keeps it in sync — without it the
  // reflowed content is taller than the iframe and gets clipped.
  const handleLoad = React.useCallback(() => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.body) return
    resizeObserverRef.current?.disconnect()
    try {
      doc.documentElement.style.overflow = 'hidden'
      doc.body.style.overflow = 'hidden'
      setContentSize({ width: measureContentWidth(doc), height: doc.body.scrollHeight })

      let raf = 0
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(raf)
        raf = requestAnimationFrame(() => {
          const height = doc.body.scrollHeight
          setContentSize((prev) =>
            prev && Math.abs(prev.height - height) > 1 ? { ...prev, height } : prev
          )
        })
      })
      observer.observe(doc.body)
      resizeObserverRef.current = observer
    } catch {
      // Cross-origin access denied
    }
  }, [])

  // Stop observing when the overlay closes or unmounts
  React.useEffect(() => {
    if (!isOpen) resizeObserverRef.current?.disconnect()
  }, [isOpen])
  React.useEffect(() => () => resizeObserverRef.current?.disconnect(), [])

  const iframeHeight = contentSize
    ? `${contentSize.height}px`
    : 'calc(100vh - 200px)'

  const measured = contentSize !== null

  // Header actions: item navigation + copy button
  const headerActions = (
    <div className="flex items-center gap-2">
      <ItemNavigator items={resolvedItems} activeIndex={activeIdx} onSelect={setActiveIdx} size="md" />
      <CopyButton content={activeContent || ''} label="Copy HTML" className="bg-background shadow-minimal" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{
        icon: Globe,
        label: 'HTML',
        variant: 'blue',
      }}
      title={title || activeItem?.label || 'HTML Preview'}
      headerActions={headerActions}
    >
      <div className="px-6 pb-6">
        {loadingItem && !activeContent && (
          <div className="py-12 text-center text-muted-foreground text-sm">{t('common.loading')}</div>
        )}
        {loadError && !activeContent && (
          <div className="py-12 text-center text-destructive/70 text-sm">{loadError}</div>
        )}
        {processedHtml && (
          <div
            className="bg-white rounded-[12px] overflow-hidden shadow-minimal mx-auto"
            style={{
              maxWidth: contentSize?.width ? `${contentSize.width + 128}px` : undefined,
              padding: '24px 64px 36px',
              opacity: measured ? 1 : 0,
              transition: 'opacity 200ms ease-in',
            }}
          >
            <iframe
              ref={iframeRef}
              sandbox="allow-same-origin allow-top-navigation-by-user-activation"
              srcDoc={processedHtml}
              onLoad={handleLoad}
              title={activeItem?.label || title || 'HTML Preview'}
              className="w-full border-0"
              style={{ height: iframeHeight, minHeight: '400px' }}
            />
          </div>
        )}
      </div>
    </PreviewOverlay>
  )
}
