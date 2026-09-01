import * as React from "react"
import { useTranslation } from "react-i18next"

import { Tooltip, TooltipContent, TooltipTrigger } from "@bitlab/ui"
import { cn } from "@/lib/utils"
import type { Message } from "../../../shared/types"

export interface MessageTickItem {
  /** Key of the user turn's DOM node in ChatDisplay's turnRefs map */
  turnKey: string
  /** Index of the turn within the full (unpaginated) turn list */
  turnIndex: number
  message: Message
}

interface MessageTickNavProps {
  ticks: MessageTickItem[]
  viewportRef: React.RefObject<HTMLDivElement | null>
  turnRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  onJump: (item: MessageTickItem) => void
}

/** Single-line preview for the hover tooltip: strip line breaks, fall back to attachment names */
function getTickPreview(message: Message): string {
  const content = message.content?.replace(/\s*\n+\s*/g, ' ').trim()
  if (content) return content
  return (message.attachments ?? []).map(a => a.name).filter(Boolean).join(', ')
}

/**
 * Vertical tick rail on the right edge of the messages area — one tick per
 * user message. Hovering a tick previews the message; clicking scrolls the
 * conversation to it. The tick whose message sits at the reading position
 * (upper third of the viewport) is highlighted while scrolling.
 */
export function MessageTickNav({ ticks, viewportRef, turnRefs, onJump }: MessageTickNavProps) {
  const { t } = useTranslation()
  const [activeTurnKey, setActiveTurnKey] = React.useState<string | null>(null)

  // Track the reading position: highlight the last user message above the probe line.
  React.useEffect(() => {
    if (ticks.length < 2) return
    const viewport = viewportRef.current
    if (!viewport) return

    let raf = 0
    const update = () => {
      raf = 0
      const viewportRect = viewport.getBoundingClientRect()
      const probeY = viewportRect.top + viewportRect.height * 0.35
      let current: string | null = null
      for (const tick of ticks) {
        const el = turnRefs.current.get(tick.turnKey)
        if (!el) continue
        if (el.getBoundingClientRect().top <= probeY) current = tick.turnKey
        else break
      }
      setActiveTurnKey(prev => (prev === current ? prev : current))
    }
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update)
    }

    update()
    viewport.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [ticks, turnRefs, viewportRef])

  if (ticks.length < 2) return null

  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-1.5 z-20 flex items-center"
      role="navigation"
      aria-label={t('chat.messageNav.ariaLabel')}
    >
      <div className="pointer-events-auto flex max-h-full flex-col items-center overflow-y-auto py-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {ticks.map((tick, index) => {
          const preview = getTickPreview(tick.message)
          const isActive = tick.turnKey === activeTurnKey
          return (
            <Tooltip key={tick.turnKey} delayDuration={120}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onJump(tick)}
                  aria-label={t('chat.messageNav.goToMessage', { index: index + 1, total: ticks.length })}
                  className="group flex h-[15px] w-4 items-center justify-center outline-none"
                >
                  <span
                    className={cn(
                      "h-[2px] rounded-full transition-all duration-200",
                      isActive
                        ? "w-3.5 bg-foreground/70"
                        : "w-2 bg-foreground/25 group-hover:w-3 group-hover:bg-foreground/55"
                    )}
                  />
                </button>
              </TooltipTrigger>
              {preview && (
                <TooltipContent
                  side="left"
                  sideOffset={10}
                  className="max-w-[280px] leading-relaxed line-clamp-4"
                >
                  {preview}
                </TooltipContent>
              )}
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}
