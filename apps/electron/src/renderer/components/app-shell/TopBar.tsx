/**
 * TopBar - Persistent top bar above all panels (Slack-style)
 *
 * Layout: [Sidebar] [Back] [Forward] ... [Browser strip] [+]
 *
 * Fixed at top of window, 48px tall.
 * macOS: offset left to avoid stoplight controls.
 */

import { useTranslation } from "react-i18next"
import * as Icons from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@bitlab/ui"
import { PanelLeftRounded } from "../icons/PanelLeftRounded"
import { TopBarButton } from "../ui/TopBarButton"
import { cn } from "@/lib/utils"
import { isMac, isWebUI } from "@/lib/platform"
import { useActionLabel } from "@/actions"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-dropdown"
import { SquarePenRounded } from "../icons/SquarePenRounded"
import { useEffect, useRef, useState } from "react"
import { BrowserTabStrip } from "../browser/BrowserTabStrip"

const RIGHT_SLOT_FULL_BADGES_THRESHOLD = 420
const RIGHT_SLOT_TWO_BADGES_THRESHOLD = 300

interface TopBarProps {
  activeSessionId?: string | null
  onBack: () => void
  onForward: () => void
  canGoBack: boolean
  canGoForward: boolean
  onToggleSidebar: () => void
  onAddSessionPanel: () => void
  onAddBrowserPanel: () => void
  /** When true, hides controls that don't apply in compact/mobile layout */
  isCompact?: boolean
}

export function TopBar({
  activeSessionId,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  onToggleSidebar,
  onAddSessionPanel,
  onAddBrowserPanel,
  isCompact,
}: TopBarProps) {
  const { t } = useTranslation()
  const [maxVisibleBrowserBadges, setMaxVisibleBrowserBadges] = useState(3)
  const rightSlotRef = useRef<HTMLDivElement | null>(null)

  const goBackHotkey = useActionLabel('nav.goBackAlt').hotkey
  const goForwardHotkey = useActionLabel('nav.goForwardAlt').hotkey

  useEffect(() => {
    const slotEl = rightSlotRef.current
    if (!slotEl) return

    let frame = 0

    const updateBadgeDensity = () => {
      const slotWidth = slotEl.getBoundingClientRect().width
      const nextMaxVisibleBadges = slotWidth >= RIGHT_SLOT_FULL_BADGES_THRESHOLD
        ? 3
        : slotWidth >= RIGHT_SLOT_TWO_BADGES_THRESHOLD
          ? 2
          : 1

      setMaxVisibleBrowserBadges((prev) => (prev === nextMaxVisibleBadges ? prev : nextMaxVisibleBadges))
    }

    const schedule = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(updateBadgeDensity)
    }

    const observer = new ResizeObserver(schedule)
    observer.observe(slotEl)
    updateBadgeDensity()

    return () => {
      if (frame) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  // Stoplight padding clears macOS traffic-light controls, which only exist
  // in the Electron desktop window. The webui runs in a regular browser tab
  // and has no traffic lights regardless of host OS — collapse to a normal
  // 12px inset so controls sit at the edge.
  const menuLeftPadding = isMac && !isWebUI ? 86 : 12

  return (
    <div
      className="fixed top-0 left-0 right-0 z-panel titlebar-drag-region"
      style={{ height: 'var(--topbar-height)' }}
    >
      <div className="flex h-full w-full items-center justify-between gap-2">
      {/* === LEFT: Sidebar + History === */}
      {/* Keep this container draggable. Only individual interactive controls should use titlebar-no-drag. */}
      {/* In compact mode the right slot is hidden, so keep a normal trailing inset. */}
      <div
        className="pointer-events-auto flex min-w-0 flex-1 items-center gap-0.5"
        style={{ paddingLeft: menuLeftPadding, paddingRight: isCompact ? 12 : 0 }}
      >
        <div className="flex items-center gap-0.5">
        {!isCompact && (
        <Tooltip>
          <TooltipTrigger asChild>
            <TopBarButton onClick={onToggleSidebar} aria-label={t("menu.toggleSidebar")}>
              <PanelLeftRounded className="h-[18px] w-[18px] text-foreground/70" />
            </TopBarButton>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t("menu.toggleSidebar")}</TooltipContent>
        </Tooltip>
        )}
        </div>

        <div className={cn("ml-1 flex min-w-0 items-center gap-1", isCompact && "flex-1")}>
          {!isCompact && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <TopBarButton onClick={onBack} disabled={!canGoBack} aria-label={t("common.back")}>
                    <Icons.ChevronLeft className="h-[18px] w-[18px] text-foreground/70" strokeWidth={1.5} />
                  </TopBarButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("common.back")} {goBackHotkey}</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <TopBarButton onClick={onForward} disabled={!canGoForward} aria-label={t("common.forward")}>
                    <Icons.ChevronRight className="h-[18px] w-[18px] text-foreground/70" strokeWidth={1.5} />
                  </TopBarButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t("common.forward")} {goForwardHotkey}</TooltipContent>
              </Tooltip>
            </>
          )}
        </div>
      </div>

      {/* === RIGHT: Browser strip + add panel === */}
      {!isCompact && (
      <div ref={rightSlotRef} className="flex min-w-0 shrink-0 items-center justify-end gap-1" style={{ paddingRight: 12 }}>
        <div className="min-w-0">
          <BrowserTabStrip activeSessionId={activeSessionId} maxVisibleBadges={maxVisibleBrowserBadges} />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TopBarButton aria-label={t("menu.addPanelMenu")} className="ml-1 h-[26px] w-[26px] rounded-lg">
              <Icons.Plus className="h-4 w-4 text-foreground/50" strokeWidth={1.5} />
            </TopBarButton>
          </DropdownMenuTrigger>
          <StyledDropdownMenuContent align="end" minWidth="min-w-56">
            <StyledDropdownMenuItem onClick={onAddSessionPanel}>
              <SquarePenRounded className="h-3.5 w-3.5" />
              {t("session.newSessionInPanel")}
            </StyledDropdownMenuItem>
            <StyledDropdownMenuItem onClick={onAddBrowserPanel}>
              <Icons.Globe className="h-3.5 w-3.5" />
              {t("browser.newWindow")}
            </StyledDropdownMenuItem>
          </StyledDropdownMenuContent>
        </DropdownMenu>
      </div>
      )}
      </div>
    </div>
  )
}
