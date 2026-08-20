/**
 * The page `@browser` points at, or null when there is nothing to point at.
 *
 * Mirrors the rule the prompt layer uses for `<browser_state>`: only an open
 * dock showing a real page counts. Offering `@browser` for a closed dock would
 * let the user reference a page they already walked away from.
 */

import { useAtomValue } from 'jotai'
import { useMemo } from 'react'
import { activeBrowserInstanceIdAtom, browserInstancesAtom } from '@/atoms/browser-pane'
import { browserDockOpenAtom } from '@/atoms/browser-dock'

export interface BrowserMentionPage {
  title: string
  url: string
}

export function useBrowserMentionPage(): BrowserMentionPage | null {
  const isDockOpen = useAtomValue(browserDockOpenAtom)
  const instances = useAtomValue(browserInstancesAtom)
  const activeId = useAtomValue(activeBrowserInstanceIdAtom)

  return useMemo(() => {
    if (!isDockOpen || !activeId) return null

    const active = instances.find((instance) => instance.id === activeId)
    if (!active || active.crashed) return null

    // about:blank and the empty state identify nothing worth mentioning.
    if (!active.url || active.url === 'about:blank') return null

    return { title: active.title, url: active.url }
  }, [isDockOpen, instances, activeId])
}

/** Token the composer inserts; parsed agent-side by `parseMentions`. */
export function buildBrowserMentionToken(page: BrowserMentionPage): string {
  return `[browser:${page.url}] `
}
