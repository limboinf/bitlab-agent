/**
 * Mirrors main-process browser instances into Jotai, and handles main's
 * "surface this tab" requests.
 *
 * This lives in the app shell rather than in the dock, because the dock
 * unmounts whenever it is closed — and a closed dock still has to learn that an
 * agent just opened a tab, which is the very event that reopens it.
 */

import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import {
  activeBrowserInstanceIdAtom,
  removeBrowserInstanceAtom,
  setBrowserInstancesAtom,
  updateBrowserInstanceAtom,
} from '@/atoms/browser-pane'
import { browserDockOpenAtom } from '@/atoms/browser-dock'
import type { BrowserInstanceInfo, BrowserShowRequest } from '../../../shared/types'

export function useBrowserInstanceSync(): void {
  const setInstances = useSetAtom(setBrowserInstancesAtom)
  const updateInstance = useSetAtom(updateBrowserInstanceAtom)
  const removeInstance = useSetAtom(removeBrowserInstanceAtom)
  const setActiveInstanceId = useSetAtom(activeBrowserInstanceIdAtom)
  const setDockOpen = useSetAtom(browserDockOpenAtom)

  const instanceIdsRef = useRef<string[]>([])

  useEffect(() => {
    const api = window.electronAPI?.browserPane
    if (!api || !window.electronAPI.isChannelAvailable('browser-pane:list')) {
      setInstances([])
      setActiveInstanceId(null)
      return
    }

    let cancelled = false

    const refresh = () => api.list()
      .then((items) => {
        if (cancelled) return
        instanceIdsRef.current = items.map((i) => i.id)
        setInstances(items)
        setActiveInstanceId((prev) => {
          if (prev && items.some((i) => i.id === prev)) return prev
          return items[0]?.id ?? null
        })
      })
      .catch((error) => {
        console.warn('[browser] failed to list instances:', error)
      })

    void refresh()

    const cleanupState = api.onStateChanged((info: BrowserInstanceInfo) => {
      if (!instanceIdsRef.current.includes(info.id)) {
        instanceIdsRef.current = [...instanceIdsRef.current, info.id]
      }
      updateInstance(info)
    })

    const cleanupRemoved = api.onRemoved((id: string) => {
      instanceIdsRef.current = instanceIdsRef.current.filter((item) => item !== id)
      removeInstance(id)
      setActiveInstanceId((prev) => (prev === id ? (instanceIdsRef.current[0] ?? null) : prev))
    })

    // Main can't mount the dock itself, so anything that used to show a window
    // (agent tool call, empty-state launch, window.open) arrives here instead.
    const cleanupShowRequest = api.onShowRequest?.((payload: BrowserShowRequest) => {
      setActiveInstanceId(payload.instanceId)
      setDockOpen(true)
    })

    return () => {
      cancelled = true
      cleanupState?.()
      cleanupRemoved?.()
      cleanupShowRequest?.()
    }
  }, [setInstances, updateInstance, removeInstance, setActiveInstanceId, setDockOpen])
}
