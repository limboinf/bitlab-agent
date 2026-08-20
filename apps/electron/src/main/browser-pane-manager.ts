/**
 * BrowserPaneManager
 *
 * Owns browser instances as `WebContentsView`s docked into the right-hand
 * column of an app window. There are no standalone browser windows: every
 * instance lives inside a host window's dock, and the renderer owns the dock's
 * geometry (it reports the placeholder rect via `setDockState`).
 *
 * One dock per host window; instances are tabs within it. Only the active tab
 * is attached to the host — background tabs keep their webContents alive
 * (and keep loading) but hold no native view.
 */

import { join, parse as parsePath } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { validateFilePath, getWorkspaceAllowedDirs } from '@bitlab/server-core/handlers'
import { WebContentsView, BrowserWindow, app, ipcMain, nativeTheme, session, shell, type Session as ElectronSession } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { BrowserCDP, type AccessibilitySnapshot, type ElementGeometry } from './browser-cdp'
import {
  type BrowserAnnotationPick,
  type BrowserContextSnapshot,
  type BrowserEmptyStateLaunchPayload,
  type BrowserEmptyStateLaunchResult,
  type BrowserInstanceInfo,
} from '../shared/types'
import { DEFAULT_THEME, loadAppTheme } from '@bitlab/shared/config'
import { CodedError } from '@bitlab/shared/protocol'
import { getBrowserLiveFxCornerRadii } from '../shared/browser-live-fx'
import type {
  IBrowserPaneManager,
  BrowserInstanceSnapshot,
} from '@bitlab/server-core/handlers'
import type {
  BrowserCapabilityRequest,
  ScreenshotResultWire,
} from '@bitlab/server-core/transport'

export type { BrowserInstanceInfo }

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const MAX_CONSOLE_LOG_ENTRIES = 500
const MAX_NETWORK_LOG_ENTRIES = 500
const MAX_DOWNLOAD_LOG_ENTRIES = 200
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
const SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS = 3
const SCREENSHOT_RETRY_DELAY_MS = 120
const SCREENSHOT_RESCUE_PAINT_DELAY_MS = 180
const SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS = 1_000
const SCREENSHOT_NETWORK_IDLE_MS = 300
const THEME_COLOR_SIGNAL_PREFIX = '__bitlab_theme_color__:'
const ANNOTATION_SIGNAL_PREFIX = '__bitlab_annotation__:'
/** Cap on the descriptor a page can put in an attachment filename. */
const ANNOTATION_LABEL_MAX = 60

/**
 * The element descriptor becomes an attachment filename, and it is page-authored
 * text. Keep it to characters that cannot escape a path or a shell word.
 */
function sanitizeAnnotationLabel(raw: string): string {
  const cleaned = String(raw ?? '')
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/[^\p{L}\p{N} ._#-]/gu, '-')
    // Collapse dot runs so no filename ever carries a `..` segment, and trim
    // leading dots so it cannot become a hidden file either.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '')
    .slice(0, ANNOTATION_LABEL_MAX)
  return cleaned || 'element'
}
const THEME_COLOR_NULL_SENTINEL = '__NULL__'
const THEME_OBSERVER_MIN_INTERVAL_MS = 120
const EARLY_THEME_EXTRACTION_DELAY_MS = 100
const BROWSER_EMPTY_STATE_PAGE = 'browser-empty-state.html'
const BITLAB_DEEPLINK_SCHEME_PREFIX = `${process.env.BITLAB_DEEPLINK_SCHEME || 'bitlab'}://`

const THEME_COLOR_EXTRACTOR_FN = String.raw`
() => {
  const toHex = (r, g, b) => '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('');

  const parseColor = (str) => {
    if (!str) return null;
    str = str.trim();
    const hm = /^#([0-9a-f]{3,8})$/i.exec(str);
    if (hm) {
      const h = hm[1];
      let r, g, b;
      if (h.length === 3) { r = parseInt(h[0]+h[0],16); g = parseInt(h[1]+h[1],16); b = parseInt(h[2]+h[2],16); }
      else if (h.length >= 6) { r = parseInt(h.slice(0,2),16); g = parseInt(h.slice(2,4),16); b = parseInt(h.slice(4,6),16); }
      else return null;
      return toHex(r, g, b);
    }
    const rm = str.match(/rgba?[\(]\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
    if (rm) return toHex(+rm[1], +rm[2], +rm[3]);
    return null;
  };

  const parseBg = (el) => {
    if (!el) return null;
    const bg = getComputedStyle(el).backgroundColor;
    if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return null;
    return parseColor(bg);
  };

  // 1. theme-color meta — respect media attribute for light/dark
  const metas = document.querySelectorAll('meta[name="theme-color"]');
  for (const m of metas) {
    const media = m.getAttribute('media');
    if (media && !window.matchMedia(media).matches) continue;
    const c = parseColor(m.content);
    if (c) return c;
  }

  // 2. Safari-like approach: sample fixed/sticky elements at viewport top-center
  const els = document.elementsFromPoint(window.innerWidth / 2, 4);
  for (const el of els) {
    if (el === document.documentElement || el === document.body) continue;
    const style = getComputedStyle(el);
    const pos = style.position;
    if (pos !== 'fixed' && pos !== 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.8) continue;
    const c = parseBg(el);
    if (c) return c;
  }

  // 3. Fallback: body then html
  return parseBg(document.body) || parseBg(document.documentElement) || null;
}
`

type BrowserThemeMode = 'light' | 'dark' | 'system'
export const BROWSER_PANE_SESSION_PARTITION = 'persist:browser-pane'
const SESSION_PARTITION = BROWSER_PANE_SESSION_PARTITION

interface AgentControlState {
  active: boolean
  sessionId: string
  displayName?: string
  intent?: string
}

interface AgentControlLockState {
  active: boolean
}

/** Rect in host-window DIP coordinates, as measured by the renderer placeholder. */
export interface DockBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Per-host-window dock. The renderer owns every field here and pushes the whole
 * thing through `setDockState` — the main process never guesses geometry.
 */
interface DockState {
  window: BrowserWindow
  bounds: DockBounds | null
  /** Dock column is mounted and visible in the renderer. */
  visible: boolean
  /**
   * A renderer overlay (dialog, menu) currently covers the dock rect. Native
   * views always paint above renderer content, so we detach while it's up.
   */
  suppressed: boolean
  activeInstanceId: string | null
}

interface BrowserInstance {
  id: string
  /** Host window this instance is attached to, or null while it's a background tab. */
  host: BrowserWindow | null
  pageView: WebContentsView
  /** Transparent input shield — the only thing that must paint above the page. */
  nativeOverlayView: WebContentsView
  cdp: BrowserCDP
  currentUrl: string
  title: string
  favicon: string | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  /**
   * Workspace this instance is associated with, or `null` for unbound manual
   * windows. Renderers in other workspaces filter such entries out of the tab
   * strip / status badge. Stamped at create-time (or first bind) — once non-null,
   * subsequent rebinds may overwrite it with the new binder's workspace.
   */
  workspaceId: string | null
  /** True when this instance is the active tab of a visible, unsuppressed dock. */
  isVisible: boolean
  /** Set when the page's renderer process died; cleared on the next successful load. */
  crashed: { reason: string; at: number } | null
  /** Element-picking mode: hover highlights, click captures instead of activating. */
  annotationMode: boolean
  lastAction: LastBrowserAction | null
  agentControl: AgentControlState | null
  lockState: AgentControlLockState
  nativeOverlayReady: boolean
  themeColor: string | null
  inPageThemeTimer: ReturnType<typeof setTimeout> | null
  themeObserverToken: string | null
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
  lastLaunchToken: string | null
}

interface CreateBrowserInstanceOptions {
  show?: boolean
  ownerType?: 'session' | 'manual'
  ownerSessionId?: string
  workspaceId?: string | null
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements from accessibility tree */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserConsoleOptions {
  level?: 'all' | BrowserConsoleEntry['level']
  limit?: number
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: BrowserWaitArgs['kind']
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: 'started' | 'completed' | 'interrupted' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: {
    mode: 'raw' | 'agent'
    viewport?: {
      width: number
      height: number
      dpr: number
      scrollX: number
      scrollY: number
    }
    targets?: Array<{
      ref: string
      role?: string
      name?: string
      box: { x: number; y: number; width: number; height: number }
      clickPoint: { x: number; y: number }
    }>
    action?: {
      tool: string
      ref?: string
      status: 'succeeded' | 'failed'
      timestamp: number
    }
    annotationPartial?: boolean
    warnings?: string[]
    region?: {
      x: number
      y: number
      width: number
      height: number
    }
    targetMode?: 'coords' | 'ref' | 'selector'
  }
}

interface LastBrowserAction {
  tool: string
  ref?: string
  status: 'succeeded' | 'failed'
  geometry?: ElementGeometry
  timestamp: number
}

let instanceCounter = 0

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  private showRequestCallback: ((payload: { instanceId: string; hostWebContentsId: number }) => void) | null = null
  private annotationCallback: ((payload: BrowserAnnotationPick) => void) | null = null
  private partitionPermissionsInitialized = false
  private partitionObserversInitialized = false
  private inFlightRequestsByWebContentsId = new Map<number, number>()
  private lastNetworkActivityByWebContentsId = new Map<number, number>()
  /** Docks keyed by host window webContents id. */
  private docks = new Map<number, DockState>()
  private windowManager: WindowManager | null = null
  private sessionPathResolver: ((sessionId: string) => string | null) | null = null
  private themeMode: BrowserThemeMode = 'system'

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void {
    this.sessionPathResolver = fn
  }

  onStateChange(callback: (info: BrowserInstanceInfo) => void): void {
    this.stateChangeCallback = callback
  }

  onRemoved(callback: (id: string) => void): void {
    this.removedCallback = callback
  }

  onInteracted(callback: (id: string) => void): void {
    this.interactedCallback = callback
  }

  /**
   * Main → renderer: "open the dock on this instance". The main process cannot
   * mount the dock itself — the dock column is renderer layout — so anything
   * that used to call `window.show()` now raises this instead.
   */
  onShowRequest(callback: (payload: { instanceId: string; hostWebContentsId: number }) => void): void {
    this.showRequestCallback = callback
  }

  /** Main → renderer: the user picked an element in annotation mode. */
  onAnnotationPicked(callback: (payload: BrowserAnnotationPick) => void): void {
    this.annotationCallback = callback
  }

  // ---------------------------------------------------------------------------
  // Dock plumbing
  //
  // The renderer is the single source of truth for dock geometry/visibility.
  // It pushes the whole dock state on every change (mount, resize, tab switch,
  // overlay open/close) and we reconcile native views against it.
  // ---------------------------------------------------------------------------

  /** Renderer → main: full dock state for one host window. Idempotent. */
  setDockState(
    hostWebContentsId: number,
    next: { visible: boolean; suppressed: boolean; activeInstanceId: string | null; bounds: DockBounds | null },
  ): void {
    const window = this.findWindowByWebContentsId(hostWebContentsId)

    if (!window || window.isDestroyed()) {
      this.docks.delete(hostWebContentsId)
      return
    }

    const isNewDock = !this.docks.has(hostWebContentsId)

    const dock: DockState = {
      window,
      visible: next.visible,
      suppressed: next.suppressed,
      activeInstanceId: next.activeInstanceId,
      bounds: next.bounds ? this.normalizeBounds(next.bounds, window) : null,
    }
    this.docks.set(hostWebContentsId, dock)

    if (isNewDock) {
      // Detach any views still parented to this window when it goes away,
      // otherwise their webContents outlive a destroyed native parent.
      window.once('closed', () => this.releaseDock(hostWebContentsId))
    }

    // One line that answers "why is the dock blank?" — the three gates that
    // decide whether anything paints, plus the rect we were handed.
    mainLog.info(
      `[browser-pane] dock state host=${hostWebContentsId} visible=${dock.visible} suppressed=${dock.suppressed}`
      + ` active=${dock.activeInstanceId ?? 'none'} bounds=${dock.bounds ? `${dock.bounds.width}x${dock.bounds.height}@${dock.bounds.x},${dock.bounds.y}` : 'null'}`
      + ` paintable=${this.isDockPaintable(dock)}`,
    )

    this.reconcileDock(dock)
  }

  /** Drop a dock when its host window goes away. */
  releaseDock(hostWebContentsId: number): void {
    const dock = this.docks.get(hostWebContentsId)
    if (!dock) return
    this.docks.delete(hostWebContentsId)

    for (const instance of this.instances.values()) {
      if (instance.host === dock.window) {
        this.detachInstance(instance)
      }
    }
  }

  private findWindowByWebContentsId(id: number): BrowserWindow | null {
    return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.id === id) ?? null
  }

  /**
   * The renderer measures in CSS pixels; view bounds are in DIP. Those differ
   * exactly by the window's zoom factor, so a zoomed-in app would otherwise
   * park the page view short of its placeholder.
   */
  private normalizeBounds(bounds: DockBounds, host: BrowserWindow): DockBounds {
    const zoom = host.webContents.getZoomFactor?.() ?? 1
    const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1

    return {
      x: Math.round(bounds.x * scale),
      y: Math.round(bounds.y * scale),
      width: Math.max(0, Math.round(bounds.width * scale)),
      height: Math.max(0, Math.round(bounds.height * scale)),
    }
  }

  /** A dock can host views only when it is mounted, unsuppressed and measured. */
  private isDockPaintable(dock: DockState): boolean {
    return dock.visible
      && !dock.suppressed
      && !!dock.bounds
      && dock.bounds.width > 0
      && dock.bounds.height > 0
      && !dock.window.isDestroyed()
  }

  private findDockForInstance(instance: BrowserInstance): DockState | null {
    for (const dock of this.docks.values()) {
      if (dock.activeInstanceId === instance.id) return dock
    }
    return null
  }

  /**
   * Attach exactly the dock's active instance, detach everyone else that was
   * pointing at this host. Called on every dock state push.
   */
  private reconcileDock(dock: DockState): void {
    const activeId = dock.activeInstanceId
    const shouldPaint = this.isDockPaintable(dock)

    for (const instance of this.instances.values()) {
      const isActiveHere = shouldPaint && instance.id === activeId
      if (isActiveHere) {
        this.attachInstance(instance, dock)
      } else if (instance.host === dock.window) {
        this.detachInstance(instance)
      }
    }
  }

  private attachInstance(instance: BrowserInstance, dock: DockState): void {
    if (this.isInstanceDestroyed(instance) || dock.window.isDestroyed() || !dock.bounds) return

    if (instance.host !== dock.window) {
      this.detachInstance(instance)
      dock.window.contentView.addChildView(instance.pageView)
      dock.window.contentView.addChildView(instance.nativeOverlayView)
      instance.host = dock.window
    }

    instance.pageView.setBounds(dock.bounds)
    instance.pageView.setVisible(true)
    this.updateNativeOverlayState(instance)

    if (!instance.isVisible) {
      mainLog.info(`[browser-pane] attached id=${instance.id} to host=${dock.window.webContents.id}`)
      instance.isVisible = true
      this.emitStateChange(instance)
      if (!instance.themeColor) {
        void this.extractThemeColor(instance)
      }
    }
  }

  private detachInstance(instance: BrowserInstance): void {
    const host = instance.host
    instance.host = null

    if (host && !host.isDestroyed() && !this.isInstanceDestroyed(instance)) {
      try {
        host.contentView.removeChildView(instance.nativeOverlayView)
        host.contentView.removeChildView(instance.pageView)
      } catch (error) {
        mainLog.warn(`[browser-pane] detach failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (instance.isVisible) {
      mainLog.info(`[browser-pane] detached id=${instance.id}`)
      instance.isVisible = false
      this.emitStateChange(instance)
    }
  }

  /** Re-apply bounds for whichever instance currently owns each dock. */
  private relayoutAllDocks(): void {
    for (const dock of this.docks.values()) {
      if (dock.window.isDestroyed()) {
        this.docks.delete(dock.window.webContents.id)
        continue
      }
      this.reconcileDock(dock)
    }
  }

  private isInstanceDestroyed(instance: BrowserInstance): boolean {
    return instance.pageView.webContents.isDestroyed()
  }

  /**
   * Pick the dock a new/agent-driven instance should surface in. Prefers the
   * window whose workspace matches, then the focused window.
   */
  private resolveHostDock(workspaceId: string | null): DockState | null {
    if (this.docks.size === 0) return null

    if (workspaceId && this.windowManager) {
      for (const dock of this.docks.values()) {
        if (dock.window.isDestroyed()) continue
        const dockWorkspace = this.windowManager.getWorkspaceForWindow(dock.window.webContents.id)
        if (dockWorkspace === workspaceId) return dock
      }
    }

    const focused = this.windowManager?.getFocusedWindow() ?? null
    if (focused && !focused.isDestroyed()) {
      const dock = this.docks.get(focused.webContents.id)
      if (dock) return dock
    }

    for (const dock of this.docks.values()) {
      if (!dock.window.isDestroyed()) return dock
    }
    return null
  }

  setThemeMode(mode: string): void {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') {
      mainLog.warn(`[browser-pane] ignoring invalid theme mode: ${mode}`)
      return
    }

    this.themeMode = mode
    for (const instance of this.instances.values()) {
      this.applyThemeMode(instance)
    }
  }

  private resolveThemeMode(): 'light' | 'dark' {
    if (this.themeMode === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    }
    return this.themeMode
  }

  private themeBackgroundColor(): string {
    return this.resolveThemeMode() === 'dark' ? '#2b292e' : '#fafafb'
  }

  private applyThemeMode(instance: BrowserInstance): void {
    const bgColor = this.themeBackgroundColor()

    const pageWebContents = instance.pageView.webContents
    if (pageWebContents.isDestroyed()) return

    const pageWcWithBg = pageWebContents as typeof pageWebContents & { setBackgroundColor?: (color: string) => void }
    pageWcWithBg.setBackgroundColor?.(bgColor)

    if (this.isBrowserEmptyStateUrl(pageWebContents.getURL())) {
      void pageWebContents.executeJavaScript(
        `window.__BITLAB_APPLY_BROWSER_THEME__?.(${JSON.stringify(this.themeMode)})`,
      ).catch(() => {})
    }
  }

  createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || `browser-${++instanceCounter}`
    const shouldShow = options?.show ?? false
    const ownerType = options?.ownerType ?? 'manual'
    const ownerSessionId = ownerType === 'session' ? (options?.ownerSessionId ?? null) : null
    const workspaceId = options?.workspaceId ?? null

    if (this.instances.has(instanceId)) {
      mainLog.warn(`[browser-pane] Instance already exists, reusing: ${instanceId}`)
      return instanceId
    }

    const ses = session.fromPartition(SESSION_PARTITION)
    this.setupSessionPermissions(ses)
    this.setupSessionObservers(ses)

    // Match the app theme before first paint; "system" resolves through Electron.
    const bgColor = this.themeBackgroundColor()

    const pageView = new WebContentsView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const nativeOverlayView = new WebContentsView({
      webPreferences: {
        partition: SESSION_PARTITION,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Set view backgrounds to match theme so about:blank doesn't flash white
    const pageWcWithBg = pageView.webContents as typeof pageView.webContents & { setBackgroundColor?: (color: string) => void }
    pageWcWithBg.setBackgroundColor?.(bgColor)
    const overlayWcWithBg = nativeOverlayView.webContents as typeof nativeOverlayView.webContents & { setBackgroundColor?: (color: string) => void }
    overlayWcWithBg.setBackgroundColor?.('#00000000')

    const cdp = new BrowserCDP(pageView.webContents)

    const instance: BrowserInstance = {
      id: instanceId,
      host: null,
      pageView,
      nativeOverlayView,
      cdp,
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: ownerSessionId,
      ownerType,
      ownerSessionId,
      workspaceId,
      isVisible: false,
      crashed: null,
      annotationMode: false,
      lastAction: null,
      agentControl: null,
      lockState: { active: false },
      nativeOverlayReady: false,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
      downloads: [],
      lastLaunchToken: null,
    }

    const defaultUa = pageView.webContents.userAgent || ''
    const sanitizedUa = defaultUa.replace(/\sElectron\/[^\s]+/g, '')
    if (sanitizedUa && sanitizedUa !== defaultUa) {
      pageView.webContents.setUserAgent(sanitizedUa)
    }

    void this.loadNativeOverlayPage(instance)

    this.setupInstanceListeners(instance)
    this.instances.set(instanceId, instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, ownerType=${ownerType}, ownerSessionId=${ownerSessionId ?? 'none'})`)

    if (shouldShow) {
      this.focus(instanceId)
    }

    void this.loadEmptyStatePage(instance).catch((error) => {
      mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      void pageView.webContents.loadURL('about:blank')
    })

    return instanceId
  }

  destroyInstance(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) {
      mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`)
      return
    }

    const destroyedBefore = this.isInstanceDestroyed(instance)
    mainLog.info(`[browser-pane] destroy requested id=${id} destroyedBefore=${destroyedBefore}`)

    // Clear pending timers before tearing the views down
    if (instance.inPageThemeTimer) {
      clearTimeout(instance.inPageThemeTimer)
      instance.inPageThemeTimer = null
    }
    instance.themeObserverToken = null

    // Clean up in-flight network tracking for this instance's webContents
    const wcId = instance.pageView.webContents.id
    this.inFlightRequestsByWebContentsId.delete(wcId)
    this.lastNetworkActivityByWebContentsId.delete(wcId)

    const runCleanup = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] destroy cleanup failed id=${id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }

    runCleanup('applyAgentControlLock', () => this.applyAgentControlLock(instance, false))
    runCleanup('detachInstance', () => this.detachInstance(instance))

    try {
      if (!this.isInstanceDestroyed(instance)) {
        instance.pageView.webContents.close()
      }
      if (!instance.nativeOverlayView.webContents.isDestroyed()) {
        instance.nativeOverlayView.webContents.close()
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] destroy failed id=${id} error=${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.finalizeDestroyedInstance(instance, 'destroy')
      mainLog.info(`[browser-pane] destroy completed id=${id} removed=${!this.instances.has(id)}`)
    }
  }

  getInstance(id: string): BrowserInstance | undefined {
    return this.instances.get(id)
  }

  private cleanupDestroyedInstance(instance: BrowserInstance, reason: string): void {
    this.finalizeDestroyedInstance(instance, 'closed')
    mainLog.info(`[browser-pane] cleaned up stale instance ${instance.id}: ${reason}`)
  }

  /**
   * Get an instance that is confirmed alive (page webContents not destroyed).
   * Throws a clear error if the instance is missing or its tab was closed.
   * Automatically cleans up stale entries from the instance map.
   */
  private requireAliveInstance(id: string): BrowserInstance {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    if (this.isInstanceDestroyed(instance)) {
      this.cleanupDestroyedInstance(instance, `lookup by id ${id}`)
      throw new Error(`Browser tab was closed (instance: ${id})`)
    }
    return instance
  }

  async handleEmptyStateLaunchFromRenderer(
    senderWebContentsId: number,
    payload: BrowserEmptyStateLaunchPayload,
  ): Promise<BrowserEmptyStateLaunchResult> {
    const instance = this.findInstanceByPageWebContentsId(senderWebContentsId)
    if (!instance) {
      mainLog.warn(`[browser-pane] empty-state launch ignored: sender not mapped senderWebContentsId=${senderWebContentsId}`)
      return { ok: false, handled: false, reason: 'instance_not_found' }
    }

    const route = payload.route?.trim()
    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return { ok: false, handled: false, reason: 'missing_route' }
    }

    const token = payload.token ?? null
    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'ipc')
    return {
      ok: true,
      handled,
      reason: handled ? undefined : 'duplicate',
    }
  }

  private findInstanceByPageWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pageView.webContents.id === senderWebContentsId) {
        return instance
      }
    }
    return undefined
  }

  private resolveLaunchWorkspaceId(): string | null {
    if (!this.windowManager) return null

    const focusedWindow = this.windowManager.getFocusedWindow()
    if (focusedWindow) {
      const focusedWorkspaceId = this.windowManager.getWorkspaceForWindow(focusedWindow.webContents.id)
      if (focusedWorkspaceId) {
        return focusedWorkspaceId
      }
    }

    const managedWindows = this.windowManager.getAllWindows()
    return managedWindows[0]?.workspaceId ?? null
  }

  private buildDeepLinkFromRoute(route: string): string {
    const queryStart = route.indexOf('?')
    const routePath = queryStart >= 0 ? route.slice(0, queryStart) : route
    const routeQuery = queryStart >= 0 ? route.slice(queryStart + 1) : ''
    let normalizedPath = routePath.replace(/^\/+/, '')

    const workspaceId = this.resolveLaunchWorkspaceId()
    if (workspaceId && !normalizedPath.startsWith('workspace/')) {
      normalizedPath = `workspace/${encodeURIComponent(workspaceId)}/${normalizedPath}`
    }

    return `${BITLAB_DEEPLINK_SCHEME_PREFIX}${normalizedPath}${routeQuery ? `?${routeQuery}` : ''}`
  }

  private async triggerEmptyStateRouteLaunch(
    instance: BrowserInstance,
    route: string,
    token: string | null,
    source: 'hash' | 'ipc',
  ): Promise<boolean> {
    const dedupeToken = token ?? route
    if (dedupeToken && instance.lastLaunchToken === dedupeToken) {
      mainLog.info(`[browser-pane] ignoring duplicate empty-state launch id=${instance.id} source=${source} token=${dedupeToken}`)
      return false
    }

    instance.lastLaunchToken = dedupeToken
    const deepLink = this.buildDeepLinkFromRoute(route)
    mainLog.info(`[browser-pane] handling empty-state launch id=${instance.id} source=${source} route=${route} deepLink=${deepLink}`)

    await this.handleDeepLinkUrl(deepLink)
    return true
  }

  listInstances(): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (this.isInstanceDestroyed(instance)) {
        this.cleanupDestroyedInstance(instance, 'listInstances')
        continue
      }
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  async listInstancesAsync(): Promise<BrowserInstanceInfo[]> {
    return this.listInstances()
  }

  async getInstanceAsync(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    return this.getInstance(id)
  }

  async createForSessionAsync(
    sessionId: string,
    options?: { show?: boolean; workspaceId?: string | null },
  ): Promise<string> {
    return this.createForSession(sessionId, options)
  }

  async getOrCreateForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null },
  ): Promise<string> {
    return this.getOrCreateForSession(sessionId, options)
  }

  async focusBoundForSessionAsync(
    sessionId: string,
    options?: { workspaceId?: string | null },
  ): Promise<string> {
    return this.focusBoundForSession(sessionId, options)
  }

  getWindowCount(): number {
    return this.instances.size
  }

  /** Host windows currently showing a docked browser tab. */
  getBrowserWindows(): BrowserWindow[] {
    const hosts = new Set<BrowserWindow>()
    for (const instance of this.instances.values()) {
      if (instance.host && !instance.host.isDestroyed()) hosts.add(instance.host)
    }
    return Array.from(hosts)
  }

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    const instance = this.requireAliveInstance(id)

    let normalizedUrl = url.trim()
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl)
    const isAbout = normalizedUrl.startsWith('about:')
    if (!hasScheme && !isAbout) {
      const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(normalizedUrl)
      if (looksLikeHost) {
        normalizedUrl = `https://${normalizedUrl}`
      } else {
        normalizedUrl = `https://duckduckgo.com/?q=${encodeURIComponent(normalizedUrl)}`
      }
    }

    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
      const loaded = instance.pageView.webContents.loadURL(normalizedUrl)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      })
      await Promise.race([loaded, timeout])

      return { url: instance.currentUrl, title: instance.title }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  }

  async goBack(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoBack()) {
      instance.pageView.webContents.goBack()
    }
  }

  async goForward(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoForward()) {
      instance.pageView.webContents.goForward()
    }
  }

  reload(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || this.isInstanceDestroyed(instance)) return
    instance.pageView.webContents.reload()
  }

  stop(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || this.isInstanceDestroyed(instance)) return
    instance.pageView.webContents.stop()
  }

  /**
   * Surface this instance: ask the owning renderer to open its dock on this
   * tab. The main process can't mount the dock itself, so the actual attach
   * happens when the renderer echoes back through `setDockState`.
   */
  focus(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || this.isInstanceDestroyed(instance)) return

    const dock = this.findDockForInstance(instance) ?? this.resolveHostDock(instance.workspaceId)
    if (!dock) {
      mainLog.warn(`[browser-pane] focus with no dock available id=${id}`)
      return
    }

    const host = dock.window
    if (host.isDestroyed()) return
    if (host.isMinimized()) host.restore()
    host.show()
    host.focus()

    this.showRequestCallback?.({ instanceId: id, hostWebContentsId: host.webContents.id })
  }

  /**
   * Detach this tab from its dock without destroying it. The renderer keeps the
   * tab in its strip; the page keeps running in the background.
   */
  hide(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || this.isInstanceDestroyed(instance)) return

    const dock = this.findDockForInstance(instance)
    if (dock) {
      dock.activeInstanceId = null
    }

    this.detachInstance(instance)
  }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getAccessibilitySnapshot()
  }

  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.clickAtCoordinates(x, y)
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.drag(x1, y1, x2, y2)
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async typeText(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.typeText(text)
      instance.lastAction = {
        tool: 'browser_type',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_type',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async setClipboard(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await instance.cdp.setClipboard(text)
  }

  async getClipboard(id: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getClipboard()
  }

  async clickElement(
    id: string,
    ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }
  ): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.clickElement(ref)
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }

      const waitFor = options?.waitFor ?? 'none'
      if (waitFor === 'navigation') {
        const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup()
            reject(new Error(
              `Click navigation wait timed out after ${timeoutMs}ms (no navigation event observed). `
              + `Tip: retry with "click ${ref}" (no navigation wait), then use "wait url <pattern>" or "wait network-idle".`
            ))
          }, timeoutMs)

          const onNav = () => {
            cleanup()
            resolve()
          }

          const cleanup = () => {
            clearTimeout(timer)
            instance.pageView.webContents.removeListener('did-navigate', onNav)
            instance.pageView.webContents.removeListener('did-navigate-in-page', onNav)
          }

          instance.pageView.webContents.once('did-navigate', onNav)
          instance.pageView.webContents.once('did-navigate-in-page', onNav)
        })
      } else if (waitFor === 'network-idle') {
        await this.waitFor(id, { kind: 'network-idle', timeoutMs: options?.timeoutMs })
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async fillElement(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.fillElement(ref, value)
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async selectOption(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.selectOption(ref, value)
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  private suspendOverlayForCapture(instance: BrowserInstance): boolean {
    const shouldSuspend = !!instance.agentControl?.active
      && instance.nativeOverlayReady

    if (!shouldSuspend) return false

    instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    return true
  }

  private restoreOverlayAfterCapture(instance: BrowserInstance, suspended: boolean): void {
    if (!suspended) return
    this.updateNativeOverlayState(instance)
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    const instance = this.requireAliveInstance(id)

    // Hide native agent overlay so it doesn't appear in captures
    const suspendedOverlay = this.suspendOverlayForCapture(instance)

    try {
      // When annotating, force agent mode and gather refs from accessibility tree
      const annotate = !!options?.annotate
      const mode = (annotate || options?.mode === 'agent') ? 'agent' : 'raw'

      if (mode === 'raw') {
        const viewport = await instance.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: options?.includeMetadata
            ? {
              mode: 'raw',
              warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
            }
            : undefined,
        }
      }

      const warnings: string[] = []
      const geometries: ElementGeometry[] = []

      const MAX_ANNOTATED_REFS = 100
      let refs = options?.refs ?? []

      if (annotate) {
        try {
          const snapshot = await instance.cdp.getAccessibilitySnapshot()
          refs = snapshot.nodes.map((node) => node.ref).slice(0, MAX_ANNOTATED_REFS)
          if (snapshot.nodes.length > MAX_ANNOTATED_REFS) {
            warnings.push(`Annotation capped at ${MAX_ANNOTATED_REFS} of ${snapshot.nodes.length} elements`)
          }
        } catch (error) {
          warnings.push(`Accessibility snapshot for annotation failed: ${error instanceof Error ? error.message : String(error)}`)
          refs = []
        }
      }

      const settled = await Promise.allSettled(
        refs.map((ref) => instance.cdp.getElementGeometry(ref)),
      )

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!
        if (result.status === 'fulfilled') {
          geometries.push(result.value)
        } else if (!annotate) {
          const reason = result.reason instanceof Error ? result.reason.message : String(result.reason)
          warnings.push(`Could not resolve ref ${refs[i]}: ${reason}`)
        }
      }

      if (options?.includeLastAction && instance.lastAction?.geometry) {
        geometries.push(instance.lastAction.geometry)
      }

      const metadataText = instance.lastAction
        ? `${instance.lastAction.tool} • ${instance.lastAction.status} • ${new Date(instance.lastAction.timestamp).toISOString()}`
        : `browser_screenshot • ${new Date().toISOString()}`

      let annotationPartial = false

      try {
        if (geometries.length > 0 || options?.includeMetadata) {
          await instance.cdp.renderTemporaryOverlay({
            geometries,
            includeMetadata: !!options?.includeMetadata,
            metadataText,
            includeClickPoints: true,
          })
        }
      } catch (error) {
        annotationPartial = true
        warnings.push(`Annotation overlay failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      try {
        const viewport = await instance.cdp.getViewportMetrics()
        const captured = await this.capturePageWithRecovery(instance, {
          mode,
          errorPrefix: 'screenshot',
          dpr: viewport.dpr,
          format: options?.format,
          jpegQuality: options?.jpegQuality,
        })

        if (captured.warnings.length > 0) {
          warnings.push(...captured.warnings)
        }

        return {
          imageBuffer: captured.imageBuffer,
          imageFormat: captured.imageFormat,
          metadata: {
            mode: 'agent',
            viewport,
            targets: geometries.map((g) => ({
              ref: g.ref,
              role: g.role,
              name: g.name,
              box: g.box,
              clickPoint: g.clickPoint,
            })),
            action: instance.lastAction
              ? {
                tool: instance.lastAction.tool,
                ref: instance.lastAction.ref,
                status: instance.lastAction.status,
                timestamp: instance.lastAction.timestamp,
              }
              : undefined,
            annotationPartial,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
        }
      } finally {
        try {
          await instance.cdp.clearTemporaryOverlay()
        } catch {
          // ignore cleanup errors
        }
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)

    const hasCoords = [target.x, target.y, target.width, target.height].every((v) => typeof v === 'number')
    const hasRef = typeof target.ref === 'string' && target.ref.length > 0
    const hasSelector = typeof target.selector === 'string' && target.selector.length > 0

    const modeCount = [hasCoords, hasRef, hasSelector].filter(Boolean).length
    if (modeCount === 0) {
      throw new Error('Region screenshot requires either coordinates, ref, or selector')
    }
    if (modeCount > 1) {
      throw new Error('Region screenshot target is ambiguous. Provide only one of coordinates, ref, or selector')
    }

    const suspendedOverlay = this.suspendOverlayForCapture(instance)

    try {
      let box: { x: number; y: number; width: number; height: number }

      if (hasRef) {
        const geometry = await instance.cdp.getElementGeometry(String(target.ref))
        box = { ...geometry.box }
      } else if (hasSelector) {
        const geometry = await instance.cdp.getElementGeometryBySelector(String(target.selector))
        box = { ...geometry.box }
      } else {
        box = {
          x: Number(target.x),
          y: Number(target.y),
          width: Number(target.width),
          height: Number(target.height),
        }
      }

      const padding = Math.max(0, Number(target.padding ?? 0))
      box = {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
      }

      const viewport = await instance.cdp.getViewportMetrics()

      const clippedX = Math.max(0, Math.floor(box.x))
      const clippedY = Math.max(0, Math.floor(box.y))
      const maxWidth = Math.max(0, Math.floor(viewport.width - clippedX))
      const maxHeight = Math.max(0, Math.floor(viewport.height - clippedY))
      const clippedWidth = Math.min(Math.max(1, Math.floor(box.width)), maxWidth)
      const clippedHeight = Math.min(Math.max(1, Math.floor(box.height)), maxHeight)

      if (maxWidth <= 0 || maxHeight <= 0 || clippedWidth <= 0 || clippedHeight <= 0) {
        throw new Error('Resolved screenshot region is outside the current viewport')
      }

      const captured = await this.capturePageWithRecovery(instance, {
        mode: 'region',
        errorPrefix: 'region screenshot',
        rect: {
          x: clippedX,
          y: clippedY,
          width: clippedWidth,
          height: clippedHeight,
        },
        dpr: viewport.dpr,
        format: target.format,
        jpegQuality: target.jpegQuality,
      })

      return {
        imageBuffer: captured.imageBuffer,
        imageFormat: captured.imageFormat,
        metadata: {
          mode: 'raw',
          viewport,
          region: {
            x: clippedX,
            y: clippedY,
            width: clippedWidth,
            height: clippedHeight,
          },
          targetMode: hasRef ? 'ref' : hasSelector ? 'selector' : 'coords',
          warnings: captured.warnings.length > 0 ? captured.warnings : undefined,
        },
      }
    } finally {
      this.restoreOverlayAfterCapture(instance, suspendedOverlay)
    }
  }

  private async capturePageWithRecovery(
    instance: BrowserInstance,
    options: {
      mode: 'raw' | 'agent' | 'region'
      errorPrefix: 'screenshot' | 'region screenshot'
      rect?: { x: number; y: number; width: number; height: number }
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ imageBuffer: Buffer; imageFormat: 'png' | 'jpeg'; warnings: string[] }> {
    let rescueUsed = false
    let sawDisplaySurfaceUnavailable = false
    const warnings: string[] = []
    const imageOpts = { dpr: options.dpr, format: options.format, jpegQuality: options.jpegQuality }

    for (let attempt = 1; attempt <= SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS; attempt += 1) {
      let result: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
      try {
        result = await this.capturePageImage(instance, {
          rect: options.rect,
          useHiddenCaptureOptions: true,
          ...imageOpts,
        })
      } catch (error) {
        if (this.isDisplaySurfaceUnavailableError(error)) {
          sawDisplaySurfaceUnavailable = true
          mainLog.warn(
            `[browser-pane] ${options.errorPrefix} display surface unavailable instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} url=${instance.currentUrl}`,
          )
        } else {
          throw error
        }
      }

      if (result) {
        if (attempt > 1) {
          warnings.push(`Capture recovered after ${attempt} hidden attempt${attempt === 1 ? '' : 's'}.`)
        }
        return { imageBuffer: result.buffer, imageFormat: result.format, warnings }
      }

      mainLog.warn(
        `[browser-pane] ${options.errorPrefix} empty capture attempt instance=${instance.id} mode=${options.mode} attempt=${attempt}/${SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl}`,
      )

      if (attempt < SCREENSHOT_HIDDEN_CAPTURE_ATTEMPTS) {
        await this.waitForScreenshotReadiness(instance.id)
      }
    }

    // Rescue: hidden capture kept coming back empty, so give the page a real
    // display surface by briefly making it the dock's active tab. Costs a
    // visible flicker, which is why it only runs after every hidden attempt
    // has failed.
    const wasVisible = instance.isVisible
    const dock = wasVisible ? this.findDockForInstance(instance) : this.resolveHostDock(instance.workspaceId)
    const previousActiveId = dock?.activeInstanceId ?? null

    if (dock && !dock.window.isDestroyed()) {
      try {
        if (!wasVisible && this.isDockPaintable(dock)) {
          dock.activeInstanceId = instance.id
          this.reconcileDock(dock)
          rescueUsed = true
          await this.sleep(SCREENSHOT_RESCUE_PAINT_DELAY_MS)
          await this.waitForScreenshotReadiness(instance.id)
        }

        let rescueResult: { buffer: Buffer; format: 'png' | 'jpeg' } | null = null
        try {
          rescueResult = await this.capturePageImage(instance, {
            rect: options.rect,
            useHiddenCaptureOptions: false,
            ...imageOpts,
          })
        } catch (error) {
          if (this.isDisplaySurfaceUnavailableError(error)) {
            sawDisplaySurfaceUnavailable = true
            mainLog.warn(
              `[browser-pane] ${options.errorPrefix} display surface unavailable during rescue instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} url=${instance.currentUrl}`,
            )
          } else {
            throw error
          }
        }

        if (rescueResult) {
          if (rescueUsed) {
            warnings.push('Capture required briefly activating the browser tab; the previous tab was restored immediately.')
          }
          return { imageBuffer: rescueResult.buffer, imageFormat: rescueResult.format, warnings }
        }
      } finally {
        if (rescueUsed && !dock.window.isDestroyed()) {
          dock.activeInstanceId = previousActiveId
          this.reconcileDock(dock)
        }
      }
    }

    mainLog.warn(
      `[browser-pane] ${options.errorPrefix} capture failed after recovery instance=${instance.id} mode=${options.mode} visible=${instance.isVisible} isLoading=${instance.isLoading} url=${instance.currentUrl} rescueUsed=${rescueUsed}`,
    )

    if (sawDisplaySurfaceUnavailable) {
      throw new Error(
        `Failed to capture ${options.errorPrefix}: current display surface is unavailable. `
        + `Open the browser dock on this tab first ("focus ${instance.id}" or "open --foreground") and retry.`
      )
    }

    throw new Error(`Failed to capture ${options.errorPrefix}: empty image buffer`)
  }

  private isDisplaySurfaceUnavailableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false
    return error.message.toLowerCase().includes('current display surface not available for capture')
  }

  private async capturePageImage(
    instance: BrowserInstance,
    options: {
      rect?: { x: number; y: number; width: number; height: number }
      useHiddenCaptureOptions: boolean
      dpr?: number
      format?: 'png' | 'jpeg'
      jpegQuality?: number
    },
  ): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' } | null> {
    const captureOpts = options.useHiddenCaptureOptions
      ? { stayHidden: true, stayAwake: true }
      : undefined

    let image = options.rect
      ? await instance.pageView.webContents.capturePage(options.rect, captureOpts)
      : await instance.pageView.webContents.capturePage(undefined, captureOpts)

    if (image.isEmpty()) {
      return null
    }

    // Downscale from device pixels to CSS pixels so screenshot coordinates
    // match click-at viewport coordinates (uses Skia Lanczos via 'best')
    const dpr = options.dpr ?? 1
    if (dpr > 1) {
      const size = image.getSize()
      image = image.resize({
        width: Math.round(size.width / dpr),
        height: Math.round(size.height / dpr),
        quality: 'best',
      })
    }

    const fmt = options.format ?? 'png'
    const encoded = fmt === 'jpeg'
      ? image.toJPEG(options.jpegQuality ?? 80)
      : image.toPNG()

    if (!encoded || encoded.length === 0) {
      return null
    }

    return { buffer: encoded, format: fmt }
  }

  private async waitForScreenshotReadiness(instanceId: string): Promise<void> {
    try {
      await this.waitFor(instanceId, {
        kind: 'network-idle',
        timeoutMs: SCREENSHOT_NETWORK_IDLE_TIMEOUT_MS,
        idleMs: SCREENSHOT_NETWORK_IDLE_MS,
      })
    } catch {
      // network-idle can fail on continuously active pages; still proceed after bounded delay
    }

    await this.sleep(SCREENSHOT_RETRY_DELAY_MS)
  }

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): BrowserConsoleEntry[] {
    const instance = this.requireAliveInstance(id)

    const level = options?.level ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))

    const filtered = level === 'all'
      ? instance.consoleLogs
      : instance.consoleLogs.filter((entry) => entry.level === level)

    return filtered.slice(-limit)
  }

  getNetworkLogs(id: string, options?: BrowserNetworkOptions): BrowserNetworkEntry[] {
    const instance = this.requireAliveInstance(id)

    const statusFilter = options?.status ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))
    const method = options?.method?.toUpperCase()
    const resourceType = options?.resourceType?.toLowerCase()

    const filtered = instance.networkLogs.filter((entry) => {
      if (method && entry.method !== method) return false
      if (resourceType && entry.resourceType.toLowerCase() !== resourceType) return false

      if (statusFilter === 'all') return true
      if (statusFilter === 'failed') return !entry.ok
      if (statusFilter === '2xx') return entry.status >= 200 && entry.status < 300
      if (statusFilter === '3xx') return entry.status >= 300 && entry.status < 400
      if (statusFilter === '4xx') return entry.status >= 400 && entry.status < 500
      if (statusFilter === '5xx') return entry.status >= 500 && entry.status < 600
      return true
    })

    return filtered.slice(-limit)
  }

  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const instance = this.requireAliveInstance(id)

    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS)
    const idleMs = Math.max(100, args.idleMs ?? 700)
    const started = Date.now()

    const until = async (predicate: () => Promise<boolean>, detail: string): Promise<BrowserWaitResult> => {
      while (Date.now() - started <= timeoutMs) {
        if (await predicate()) {
          return {
            ok: true,
            kind: args.kind,
            elapsedMs: Date.now() - started,
            detail,
          }
        }
        await this.sleep(pollMs)
      }
      throw new Error(`Wait timed out after ${timeoutMs}ms (${args.kind})`)
    }

    if (args.kind === 'selector') {
      const selector = args.value?.trim()
      if (!selector) throw new Error('browser_wait selector requires value')
      return until(async () => {
        const exists = await instance.pageView.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )
        return Boolean(exists)
      }, `selector matched: ${selector}`)
    }

    if (args.kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('browser_wait text requires value')
      return until(async () => {
        const found = await instance.pageView.webContents.executeJavaScript(
          `document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)})`
        )
        return Boolean(found)
      }, `text found: ${text}`)
    }

    if (args.kind === 'url') {
      const needle = args.value?.trim()
      if (!needle) throw new Error('browser_wait url requires value')
      return until(async () => {
        return instance.currentUrl.includes(needle)
      }, `url matched: ${needle}`)
    }

    if (args.kind === 'network-idle') {
      const wcId = instance.pageView.webContents.id
      return until(async () => {
        const inflight = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        const last = this.lastNetworkActivityByWebContentsId.get(wcId) ?? started
        return inflight === 0 && (Date.now() - last) >= idleMs
      }, `network idle for ${idleMs}ms`)
    }

    throw new Error(`Unknown wait kind: ${args.kind}`)
  }

  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const key = args.key?.trim()
    if (!key) throw new Error('browser_key requires key')

    const modifiers = (args.modifiers ?? []) as Array<'shift' | 'control' | 'alt' | 'meta'>

    instance.pageView.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    } as any)
    instance.pageView.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    } as any)
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const instance = this.requireAliveInstance(id)

    const action = options?.action ?? 'list'
    const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 20)))

    if (action === 'wait') {
      const timeoutMs = Math.max(100, Number(options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
      const started = Date.now()
      while (Date.now() - started <= timeoutMs) {
        const hasTerminal = instance.downloads.some((d) => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled')
        if (hasTerminal) break
        await this.sleep(100)
      }
    }

    return instance.downloads.slice(-limit)
  }

  // validateUploadFilePath removed — uses shared validateFilePath from @bitlab/server-core/handlers

  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<ElementGeometry> {
    const instance = this.requireAliveInstance(id)

    const safePaths: string[] = []
    for (const p of filePaths) {
      const workspaceId = this.resolveLaunchWorkspaceId()
      const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId))
      if (!existsSync(safePath)) throw new Error(`File not found: ${p}`)
      safePaths.push(safePath)
    }

    return instance.cdp.setFileInputFiles(ref, safePaths)
  }

  /**
   * Resize the *viewport*, not a window — docked tabs have no window of their
   * own. Runs through CDP device-metrics emulation, so `resize(375, 812)` gives
   * a real mobile viewport regardless of how wide the dock happens to be.
   */
  async windowResize(id: string, width: number, height: number): Promise<{ width: number; height: number }> {
    const instance = this.requireAliveInstance(id)

    const viewportWidth = Math.max(320, Math.floor(width))
    const viewportHeight = Math.max(240, Math.floor(height))

    // Widths below the tablet breakpoint also emulate touch, matching how
    // device mode behaves — load-time device gates then resolve the same way.
    await instance.cdp.setViewportOverride(viewportWidth, viewportHeight, viewportWidth < 768)

    return { width: viewportWidth, height: viewportHeight }
  }

  /** Drop viewport emulation and go back to filling the dock. */
  async clearViewportOverride(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await instance.cdp.clearViewportOverride()
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    const instance = this.requireAliveInstance(id)
    return instance.pageView.webContents.executeJavaScript(expression)
  }

  async detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const instance = this.instances.get(id)
    if (!instance || this.isInstanceDestroyed(instance)) return { detected: false, provider: 'none', signals: [] }

    const signals: string[] = []
    const title = instance.title || ''
    const url = instance.currentUrl || ''

    // Title-based detection
    if (/^Just a moment/i.test(title)) {
      signals.push('title:just-a-moment')
    }

    // URL-based detection
    if (url.includes('/cdn-cgi/challenge-platform/')) {
      signals.push('url:cdn-cgi-challenge')
    }

    // DOM-based detection via JS evaluation
    try {
      const domSignals = await instance.pageView.webContents.executeJavaScript(`(() => {
        const signals = [];
        const bodyText = (document.body?.innerText || '').slice(0, 2000);
        if (/Verify you are human/i.test(bodyText)) signals.push('text:verify-human');
        if (/Checking (if the site connection is secure|your browser)/i.test(bodyText)) signals.push('text:checking-browser');
        if (/Performing security verification/i.test(bodyText)) signals.push('text:security-verification');
        if (document.querySelector('#challenge-form')) signals.push('dom:challenge-form');
        if (document.querySelector('#turnstile-wrapper')) signals.push('dom:turnstile-wrapper');
        if (document.querySelector('.cf-turnstile')) signals.push('dom:cf-turnstile');
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) signals.push('dom:cf-challenge-iframe');
        return signals;
      })()`) as string[]

      if (Array.isArray(domSignals)) {
        signals.push(...domSignals)
      }
    } catch {
      // JS evaluation can fail if page is in a weird state — don't block on it
    }

    try {
      const snapshot = await instance.cdp.getAccessibilitySnapshot()
      const actionableRoles = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
        'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox',
      ])
      const actionableCount = snapshot.nodes.filter((node) => {
        const role = (node.role || '').toLowerCase()
        return actionableRoles.has(role) && !node.disabled
      }).length

      if (snapshot.nodes.length > 0 && actionableCount <= 2) {
        signals.push(`ax:near-empty(${actionableCount}/${snapshot.nodes.length})`)
      }
    } catch {
      // AX snapshot can fail transiently during navigation; ignore
    }

    const detected = signals.length > 0
    const isCloudflare = signals.some(s =>
      s.includes('cf-') || s.includes('challenge') || s.includes('turnstile') || s === 'title:just-a-moment'
    )
    const provider = detected ? (isCloudflare ? 'cloudflare' : 'unknown') : 'none'

    if (detected) {
      mainLog.info(`[browser-pane] security challenge detected id=${id} provider=${provider} signals=[${signals.join(', ')}]`)
    }

    return { detected, provider, signals }
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 500): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0

    await instance.pageView.webContents.executeJavaScript(`window.scrollBy(${deltaX}, ${deltaY})`)
  }

  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.boundSessionId = sessionId
      instance.ownerType = 'session'
      instance.ownerSessionId = sessionId
      // Adopt the new binder's workspace. Manual windows being reused for a
      // session start carrying that session's workspace so the receiving
      // workspace's UI sees them and others don't.
      if (options?.workspaceId !== undefined) {
        instance.workspaceId = options.workspaceId
      }
      this.emitStateChange(instance)
    }
  }

  unbindSession(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.boundSessionId = null
      instance.ownerType = 'manual'
      // Preserve ownerSessionId as last-known owner for lifecycle targeting.
      this.emitStateChange(instance)
    }
  }

  /** Unbind all instances bound to the given session (non-destructive — window stays alive and reusable). */
  unbindAllForSession(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.boundSessionId = null
        instance.ownerType = 'manual'
        // Keep ownerSessionId for post-turn lifecycle commands like `close` and `hide`.
        instance.ownerSessionId = instance.ownerSessionId ?? sessionId
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] Unbound instance ${instance.id} from session ${sessionId} (owner retained: ${instance.ownerSessionId ?? 'none'})`)
      }
    }
  }

  getBoundForSession(sessionId: string): string | null {
    for (const instance of this.instances.values()) {
      if (instance.ownerType === 'session' && instance.ownerSessionId === sessionId) {
        if (this.isInstanceDestroyed(instance)) {
          this.cleanupDestroyedInstance(instance, `getBoundForSession(${sessionId})`)
          continue
        }
        return instance.id
      }
    }
    return null
  }

  /**
   * Pick an unbound window that the caller's workspace is allowed to adopt.
   *
   * Why workspace filtering matters: when a session ends, its window stays
   * alive and becomes `ownerType='manual'` so the next turn of the **same**
   * session can re-bind it. But the window keeps its original `workspaceId`.
   * Without filtering, a session in workspace B would grab a window left
   * behind by workspace A — moving the window across workspaces, which is
   * exactly the leak this whole workspace-isolation work is fixing.
   *
   * Rule: adoption is allowed if the unbound window has `workspaceId === null`
   * (truly user-opened, no workspace context) OR matches the caller's
   * `workspaceId`. Same-workspace reuse covers the legitimate "turn ended,
   * next turn re-binds" case as well as any future turn of any session in
   * that workspace.
   */
  private findReusableUnboundInstance(workspaceId: string | null): BrowserInstance | null {
    const candidates = Array.from(this.instances.values()).filter(
      (i) =>
        i.boundSessionId === null &&
        i.ownerType === 'manual' &&
        (i.workspaceId === null || i.workspaceId === workspaceId),
    )
    if (candidates.length === 0) return null

    // Prefer visible windows first, then fall back to first available.
    // The tab the user is looking at wins. `isVisible` happens to track the
    // dock's active tab today, but relying on that coincidence is how the agent
    // ends up driving tab B while the user watches tab A — so ask the docks
    // directly instead.
    const dockActiveIds = new Set(
      Array.from(this.docks.values())
        .filter((dock) => this.isDockPaintable(dock) && dock.activeInstanceId)
        .map((dock) => dock.activeInstanceId as string),
    )

    return candidates.find((i) => dockActiveIds.has(i.id)) ?? candidates[0]
  }

  /**
   * Ambient snapshot for the prompt: which page the user is looking at.
   *
   * Deliberately carries no page body — body text is a permissioned, explicit
   * action, not something every turn drags along. Strings here are raw; the
   * prompt layer sanitizes them (`sanitizeUntrustedPageString`).
   */
  getContextSnapshot(workspaceId?: string | null): BrowserContextSnapshot {
    const visibleInWorkspace = Array.from(this.instances.values()).filter(
      (instance) => !workspaceId || !instance.workspaceId || instance.workspaceId === workspaceId,
    )

    for (const dock of this.docks.values()) {
      if (!this.isDockPaintable(dock) || !dock.activeInstanceId) continue

      const active = this.instances.get(dock.activeInstanceId)
      if (!active || this.isInstanceDestroyed(active)) continue
      if (workspaceId && active.workspaceId && active.workspaceId !== workspaceId) continue

      return {
        activeTab: { title: active.title, url: active.currentUrl },
        tabCount: visibleInWorkspace.length,
        agentDriving: !!active.agentControl?.active,
      }
    }

    // No open dock — report nothing rather than a page the user closed away from.
    return { activeTab: null, tabCount: visibleInWorkspace.length, agentDriving: false }
  }

  createForSession(
    sessionId: string,
    options?: { show?: boolean; allowReuseManual?: boolean; workspaceId?: string | null },
  ): string {
    const workspaceId = options?.workspaceId ?? null
    const existing = this.getBoundForSession(sessionId)
    if (existing) {
      // Already bound — adopt the workspace if the caller provided one and the
      // existing instance was bound before we knew about its workspace.
      if (options?.workspaceId !== undefined) {
        const instance = this.instances.get(existing)
        if (instance) instance.workspaceId = options.workspaceId
      }
      if (options?.show) {
        this.focus(existing)
      }
      return existing
    }

    // Reuse an unbound/manual window before creating a new one — local
    // sessions only. Remote agents must always get a fresh window so they
    // can never hijack a window the user opened manually.
    const allowReuseManual = options?.allowReuseManual ?? true
    if (allowReuseManual) {
      const reusable = this.findReusableUnboundInstance(workspaceId)
      if (reusable) {
        this.bindSession(reusable.id, sessionId, { workspaceId })
        if (options?.show) {
          this.focus(reusable.id)
        }
        mainLog.info(`[browser-pane] Reused unbound instance ${reusable.id} for session ${sessionId} (workspace=${workspaceId ?? 'none'})`)
        return reusable.id
      }
    }

    return this.createInstance(undefined, {
      show: options?.show ?? false,
      ownerType: 'session',
      ownerSessionId: sessionId,
      workspaceId,
    })
  }

  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): string {
    const id = this.createForSession(sessionId, { show: true, workspaceId: options?.workspaceId })
    this.focus(id)
    return id
  }

  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): string {
    return this.createForSession(sessionId, { show: false, workspaceId: options?.workspaceId })
  }

  getBoundInstanceId(sessionId: string): string | null {
    for (const [id, instance] of this.instances) {
      if (instance.boundSessionId === sessionId) {
        if (this.isInstanceDestroyed(instance)) {
          this.cleanupDestroyedInstance(instance, `getBoundInstanceId(${sessionId})`)
          continue
        }
        return id
      }
    }
    return null
  }

  destroyForSession(sessionId: string): void {
    for (const [id, instance] of this.instances) {
      if (instance.boundSessionId === sessionId) {
        this.destroyInstance(id)
      }
    }
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
      }
    }
  }

  private getAgentControlLabel(agentControl: Pick<AgentControlState, 'displayName' | 'intent'> | null | undefined): string {
    if (agentControl?.intent) {
      return `${agentControl.displayName ?? 'Agent'} — ${agentControl.intent}`
    }

    return agentControl?.displayName ?? 'Agent is working…'
  }

  private reapplyAgentControlVisual(instance: BrowserInstance): void {
    const active = !!instance.agentControl?.active
    this.applyAgentControlLock(instance, active)
    this.updateNativeOverlayState(instance)
  }

  /** Resolve the app's current accent color as a concrete CSS value (not a var reference). */
  private getResolvedAccentColor(): string {
    const isDark = this.resolveThemeMode() === 'dark'
    const userTheme = loadAppTheme()
    const accent = isDark
      ? (userTheme?.dark?.accent ?? userTheme?.accent ?? DEFAULT_THEME.dark!.accent!)
      : (userTheme?.accent ?? DEFAULT_THEME.accent!)
    return accent
  }

  private async loadNativeOverlayPage(instance: BrowserInstance): Promise<void> {
    const liveFxPlatform: Parameters<typeof getBrowserLiveFxCornerRadii>[0] =
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other'
    const cornerRadii = getBrowserLiveFxCornerRadii(liveFxPlatform)

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #overlay {
        position: fixed;
        inset: 0;
        border: 2px solid transparent;
        border-top-left-radius: ${cornerRadii.topLeft};
        border-top-right-radius: ${cornerRadii.topRight};
        border-bottom-left-radius: ${cornerRadii.bottomLeft};
        border-bottom-right-radius: ${cornerRadii.bottomRight};
        box-sizing: border-box;
        pointer-events: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.82);
        color: rgba(236, 254, 255, 0.95);
        font-size: 11px;
        line-height: 1.2;
        backdrop-filter: blur(4px);
        max-width: calc(100vw - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #shield {
        position: fixed;
        inset: 0;
        pointer-events: none;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <div id="overlay">
      <div id="shield"></div>
      <div id="chip">Agent is working…</div>
    </div>
  </body>
</html>`

    try {
      await instance.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      instance.nativeOverlayReady = true
      mainLog.info(`[browser-pane] native overlay ready id=${instance.id} platform=${liveFxPlatform} corners=${cornerRadii.bottomLeft}/${cornerRadii.bottomRight}`)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      instance.nativeOverlayReady = false
      mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * The overlay view is a transparent input shield, nothing more. All agent-control
   * chrome (accent ring, "Agent is driving" chip) is drawn by the renderer around
   * the dock, where it can't be buried by the native page view.
   */
  private updateNativeOverlayState(instance: BrowserInstance): void {
    const shouldShield = !!instance.agentControl?.active

    if (this.isInstanceDestroyed(instance) || instance.nativeOverlayView.webContents.isDestroyed()) return

    if (!shouldShield || !instance.nativeOverlayReady || !instance.host || instance.host.isDestroyed()) {
      instance.nativeOverlayView.setVisible(false)
      return
    }

    const bounds = instance.pageView.getBounds()
    instance.nativeOverlayView.setBounds(bounds)
    instance.nativeOverlayView.setVisible(true)

    void instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlay');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!overlay || !chip || !shield) return;

      overlay.style.borderColor = 'transparent';
      overlay.style.boxShadow = 'none';
      chip.style.display = 'none';
      shield.style.pointerEvents = 'auto';
      shield.style.cursor = 'not-allowed';
      shield.style.background = 'rgba(2, 6, 23, 0.03)';
    })()`).catch(() => {})
  }

  /**
   * While the agent drives, the page stops accepting human input. There is no
   * window to freeze any more — the shield view plus the `before-input-event`
   * guard is the whole lock.
   */
  private applyAgentControlLock(instance: BrowserInstance, active: boolean): void {
    const wantsLock = active && !!instance.agentControl?.active
    if (wantsLock === instance.lockState.active) return

    instance.lockState.active = wantsLock
    this.updateNativeOverlayState(instance)
    mainLog.info(`[browser-pane] interaction lock ${wantsLock ? 'enabled' : 'released'} id=${instance.id}`)
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.destroyInstance(id)
    }
  }

  private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!this.instances.has(instance.id)) {
      return
    }

    const runCleanup = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] finalize cleanup failed id=${instance.id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    runCleanup('detachInstance', () => this.detachInstance(instance))
    runCleanup('cdp.detach', () => instance.cdp.detach())
    this.instances.delete(instance.id)
    this.removedCallback?.(instance.id)
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`)
  }

  // ---------------------------------------------------------------------------
  // Annotation mode — point at an element instead of describing it
  //
  // The picker has to live inside the page: the dock's page area is a native
  // view, so nothing the renderer draws can sit on top of it. It is injected
  // through executeJavaScript (which runs ahead of the page's own CSP) and
  // reports picks back over the console channel already used for theme colors.
  // ---------------------------------------------------------------------------

  private annotationScript(accent: string): string {
    return `(() => {
  const KEY = '__bitlabAnnotate';
  if (window[KEY]) { window[KEY].enable(); return true; }

  const accent = ${JSON.stringify(accent)};
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;'
    + 'border:2px solid ' + accent + ';border-radius:3px;'
    + 'background:color-mix(in oklab, ' + accent + ' 12%, transparent);';
  let attached = false;

  const describe = (el) => {
    const tag = (el.tagName || 'node').toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = (typeof el.className === 'string' && el.className.trim())
      ? '.' + el.className.trim().split(/\s+/)[0]
      : '';
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return (tag + id + cls + (text ? ' ' + text : '')).slice(0, ${ANNOTATION_LABEL_MAX});
  };

  const paint = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) { box.style.display = 'none'; return; }
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  };

  const onMove = (e) => { if (e.target && e.target.nodeType === 1) paint(e.target); };

  const onPick = (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // Picking must not also activate the thing being picked.
    e.preventDefault();
    e.stopPropagation();
    const r = el.getBoundingClientRect();
    console.log(${JSON.stringify(ANNOTATION_SIGNAL_PREFIX)} + JSON.stringify({
      x: Math.max(0, Math.round(r.left)),
      y: Math.max(0, Math.round(r.top)),
      width: Math.round(r.width),
      height: Math.round(r.height),
      label: describe(el),
    }));
  };

  const api = {
    enable() {
      if (!attached) { document.documentElement.appendChild(box); attached = true; }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onPick, true);
      document.body && (document.body.style.cursor = 'crosshair');
    },
    disable() {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onPick, true);
      box.style.display = 'none';
      document.body && (document.body.style.cursor = '');
    },
  };

  window[KEY] = api;
  api.enable();
  return true;
})()`;
  }

  /**
   * Turn element picking on or off for a tab.
   *
   * Injection is idempotent and re-applied after navigation, because a page
   * load wipes the picker along with the rest of the document.
   */
  async setAnnotationMode(id: string, enabled: boolean): Promise<void> {
    const instance = this.requireAliveInstance(id)
    instance.annotationMode = enabled

    if (enabled) {
      await this.injectAnnotationScript(instance)
    } else {
      await instance.pageView.webContents
        .executeJavaScript(`window.__bitlabAnnotate && window.__bitlabAnnotate.disable()`)
        .catch(() => {})
    }

    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] annotation mode ${enabled ? 'on' : 'off'} id=${id}`)
  }

  private async injectAnnotationScript(instance: BrowserInstance): Promise<void> {
    if (this.isInstanceDestroyed(instance)) return
    try {
      await instance.pageView.webContents.executeJavaScript(
        this.annotationScript(this.getResolvedAccentColor()),
      )
    } catch (error) {
      mainLog.warn(`[browser-pane] annotation inject failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Turn a picked rect into the evidence the model actually reads.
   *
   * A screenshot rather than a DOM slice: it is unambiguous about what the user
   * pointed at, and it carries no markup for a page to hide instructions in.
   */
  private async handleAnnotationPick(
    instance: BrowserInstance,
    pick: { x: number; y: number; width: number; height: number; label: string },
  ): Promise<void> {
    if (!this.annotationCallback) return

    const label = sanitizeAnnotationLabel(pick.label)
    try {
      const shot = await this.screenshotRegion(instance.id, {
        x: pick.x,
        y: pick.y,
        width: pick.width,
        height: pick.height,
        padding: 4,
        format: 'png',
      })

      this.annotationCallback({
        instanceId: instance.id,
        label,
        imageBase64: shot.imageBuffer.toString('base64'),
        mimeType: 'image/png',
      })
    } catch (error) {
      mainLog.warn(`[browser-pane] annotation capture failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private isBrowserEmptyStateUrl(url: string): boolean {
    if (!url) return false
    return url.includes(`/${BROWSER_EMPTY_STATE_PAGE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_PAGE}`)
  }

  private normalizePageState(url: string, title: string): { url: string; title: string } {
    if (this.isBrowserEmptyStateUrl(url)) {
      return { url: 'about:blank', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStatePage(instance: BrowserInstance): Promise<void> {
    const query = { themeMode: this.themeMode }
    if (VITE_DEV_SERVER_URL) {
      await instance.pageView.webContents.loadURL(
        `${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_PAGE}?themeMode=${encodeURIComponent(this.themeMode)}`,
      )
      return
    }

    await instance.pageView.webContents.loadFile(
      join(__dirname, `renderer/${BROWSER_EMPTY_STATE_PAGE}`),
      { query },
    )
  }

  private async handleDeepLinkUrl(url: string): Promise<void> {
    if (!url.startsWith(BITLAB_DEEPLINK_SCHEME_PREFIX)) return

    try {
      if (!this.windowManager) {
        mainLog.warn('[browser-pane] window manager unavailable for deep-link handling, falling back to shell.openExternal')
        await shell.openExternal(url)
        return
      }

      const { handleDeepLink } = await import('./deep-link')
      const sink = this.windowManager.getRpcEventSink() ?? undefined
      const resolver = (wcId: number) => this.windowManager?.getClientIdForWindow(wcId)
      const result = await handleDeepLink(url, this.windowManager, sink, resolver)
      if (!result.success) {
        mainLog.warn(`[browser-pane] deep-link handling failed: ${result.error ?? 'unknown error'} url=${url}`)
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] deep-link handling threw, falling back to shell.openExternal: ${error instanceof Error ? error.message : String(error)}`)
      await shell.openExternal(url)
    }
  }

  private async maybeHandleEmptyStateLaunch(instance: BrowserInstance, url: string): Promise<boolean> {
    if (!this.isBrowserEmptyStateUrl(url) || !url.includes('#launch=')) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
    const launchPayload = hash.startsWith('launch=') ? hash.slice('launch='.length) : hash
    if (!launchPayload) return false

    const params = new URLSearchParams(launchPayload)
    const route = params.get('route')
    const token = params.get('ts') ?? route ?? null

    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return false
    }

    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'hash')

    try {
      await instance.pageView.webContents.executeJavaScript(
        "if (window.location.hash.includes('launch=')) history.replaceState(null, '', window.location.pathname + window.location.search);",
      )
    } catch {
      // Best effort cleanup only
    }

    return handled
  }

  // ---------------------------------------------------------------------------
  // Capability IPC — dispatcher for the `client:browser:invoke` WS capability.
  //
  // Sits between the preload bridge (which receives the WS request from the
  // remote server) and the real BrowserPaneManager. It rewrites session IDs to
  // an owner-key namespace, refuses any instance ID not owned by the calling
  // (workspaceId, sessionId), and blocks unsafe methods like `uploadFile` or
  // (optionally) `evaluate`.
  // ---------------------------------------------------------------------------

  /** Register the `__browser:invoke` IPC handler. Call once at app startup. */
  registerCapabilityIpc(): void {
    ipcMain.handle('__browser:invoke', async (_event, req: BrowserCapabilityRequest) => {
      return await this.dispatchCapability(req)
    })
    mainLog.info('[browser-pane] Capability IPC handler registered')
  }

  /** Owner-key namespacing: remote sessions can't collide with local sessions. */
  private toOwnerKey(workspaceId: string, sessionId: string): string {
    return `remote:${workspaceId}:${sessionId}`
  }

  private isRemoteOwnerKey(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith('remote:')
  }

  private parseOwnerKey(value: string): { workspaceId: string; sessionId: string } | null {
    if (!this.isRemoteOwnerKey(value)) return null
    const rest = value.slice('remote:'.length)
    const colon = rest.indexOf(':')
    if (colon === -1) return null
    return { workspaceId: rest.slice(0, colon), sessionId: rest.slice(colon + 1) }
  }

  /** Replace `remote:${ws}:${sid}` owner-keys with raw `sid` on outbound payloads. */
  private stripOwnerKeysInPlace<T extends Partial<BrowserInstanceInfo>>(info: T): T {
    if (this.isRemoteOwnerKey(info.boundSessionId)) {
      info.boundSessionId = this.parseOwnerKey(info.boundSessionId)!.sessionId
    }
    if (this.isRemoteOwnerKey(info.ownerSessionId)) {
      info.ownerSessionId = this.parseOwnerKey(info.ownerSessionId)!.sessionId
    }
    return info
  }

  /**
   * Throws `BROWSER_INSTANCE_NOT_OWNED` unless the instance belongs to `ownerKey`.
   * Called by every dispatcher branch that accepts an instanceId — including read-only ones.
   */
  private requireOwnedInstance(instanceId: string, ownerKey: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance || this.isInstanceDestroyed(instance)) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" not found.`)
    }
    const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
    if (!owned) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED',
        `Browser instance "${instanceId}" is not owned by this session.`)
    }
  }

  /** Session-scoped listInstances — never returns workspace-wide windows to a remote agent. */
  private listInstancesForOwner(ownerKey: string): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (this.isInstanceDestroyed(instance)) {
        this.cleanupDestroyedInstance(instance, 'listInstancesForOwner')
        continue
      }
      const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
      if (!owned) continue
      infos.push(this.stripOwnerKeysInPlace(this.toInfo(instance)))
    }
    return infos
  }

  /**
   * Extract a plain {@link BrowserInstanceSnapshot} from a live `BrowserInstance`.
   *
   * `this.getInstance(id)` returns the full instance, which has non-cloneable
   * Electron native references (`window: BrowserWindow`, `pageView: BrowserView`,
   * `toolbarView`, ...). When we ship the result back over the `__browser:invoke`
   * IPC channel, Electron's structured-clone serializer throws
   * "An object could not be cloned" — see the user-reported bug on the remote
   * bridge path. Always pass the live instance through this helper before
   * returning over IPC.
   */
  private toSnapshot(instance: BrowserInstance): BrowserInstanceSnapshot {
    return {
      ownerType: instance.ownerType,
      ownerSessionId: instance.ownerSessionId,
      isVisible: instance.isVisible,
      title: instance.title,
      currentUrl: instance.currentUrl,
    }
  }

  private toScreenshotWire(result: BrowserScreenshotResult): ScreenshotResultWire {
    const buf = result.imageBuffer
    return {
      imageFormat: result.imageFormat,
      imageBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      metadata: result.metadata,
    }
  }

  /** Main dispatcher. Strongly-typed `switch` over `IBrowserPaneManager` methods. */
  private async dispatchCapability(req: BrowserCapabilityRequest): Promise<unknown> {
    if (!req || req.v !== 1) {
      throw new CodedError('HANDLER_ERROR',
        `Unsupported browser capability request shape (v=${(req as { v?: unknown })?.v}).`)
    }
    const ownerKey = this.toOwnerKey(req.workspaceId, req.sessionId)
    const args = req.args ?? []

    switch (req.method) {
      // -- Session-scoped (no instanceId arg, takes a sessionId) ----------------
      case 'createForSession': {
        const [, options] = args as [string, { show?: boolean } | undefined]
        return this.createForSession(ownerKey, {
          show: options?.show ?? false,
          allowReuseManual: false,
          workspaceId: req.workspaceId,
        })
      }
      // Remote agents must NEVER reuse an existing manual / unbound window —
      // even one that was previously bound to a local session. The
      // workspaceId-aware reuse filter is best-effort (it can still match
      // legacy windows stamped with workspaceId=null), so we belt-and-brace
      // by disabling manual reuse on every remote lifecycle path. Each remote
      // session-id namespace gets a fresh window unless it already owns one.
      case 'getOrCreateForSession':
        return this.createForSession(ownerKey, {
          show: false,
          allowReuseManual: false,
          workspaceId: req.workspaceId,
        })
      case 'focusBoundForSession': {
        const id = this.createForSession(ownerKey, {
          show: true,
          allowReuseManual: false,
          workspaceId: req.workspaceId,
        })
        this.focus(id)
        return id
      }
      case 'destroyForSession':
        this.destroyForSession(ownerKey)
        return undefined
      case 'clearVisualsForSession':
        await this.clearVisualsForSession(ownerKey)
        return undefined
      case 'unbindAllForSession':
        this.unbindAllForSession(ownerKey)
        return undefined
      case 'setAgentControl': {
        const [, meta] = args as [string, { displayName?: string; intent?: string }]
        this.setAgentControl(ownerKey, meta, { workspaceId: req.workspaceId })
        return undefined
      }
      case 'clearAgentControl':
        this.clearAgentControl(ownerKey)
        return undefined

      // -- Mixed (instanceId + optional sessionId) ----------------------------
      case 'clearAgentControlForInstance': {
        const [instanceId, sessionId] = args as [string, string | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clearAgentControlForInstance(
          instanceId,
          sessionId !== undefined ? ownerKey : undefined,
        )
      }

      // -- Instance-id only ----------------------------------------------------
      case 'getInstance': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        const live = this.getInstance(instanceId)
        if (!live) return undefined
        // `getInstance` returns the live BrowserInstance (which embeds non-
        // cloneable Electron native objects). Project to a plain snapshot
        // before crossing the IPC boundary.
        return this.stripOwnerKeysInPlace(this.toSnapshot(live))
      }
      case 'listInstances':
        return this.listInstancesForOwner(ownerKey)
      case 'bindSession': {
        const [instanceId] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.bindSession(instanceId, ownerKey, { workspaceId: req.workspaceId })
        return undefined
      }
      case 'focus': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.focus(instanceId)
        return undefined
      }
      case 'hide': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.hide(instanceId)
        return undefined
      }
      case 'destroyInstance': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        this.destroyInstance(instanceId)
        return undefined
      }

      // -- Navigation ----------------------------------------------------------
      case 'navigate': {
        const [instanceId, url] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.navigate(instanceId, url)
      }
      case 'goBack': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.goBack(instanceId)
      }
      case 'goForward': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.goForward(instanceId)
      }

      // -- Interaction ---------------------------------------------------------
      case 'getAccessibilitySnapshot': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getAccessibilitySnapshot(instanceId)
      }
      case 'clickElement': {
        const [instanceId, ref, options] = args as [
          string, string,
          { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number } | undefined,
        ]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clickElement(instanceId, ref, options)
      }
      case 'clickAtCoordinates': {
        const [instanceId, x, y] = args as [string, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.clickAtCoordinates(instanceId, x, y)
      }
      case 'drag': {
        const [instanceId, x1, y1, x2, y2] = args as [string, number, number, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.drag(instanceId, x1, y1, x2, y2)
      }
      case 'fillElement': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.fillElement(instanceId, ref, value)
      }
      case 'typeText': {
        const [instanceId, text] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.typeText(instanceId, text)
      }
      case 'selectOption': {
        const [instanceId, ref, value] = args as [string, string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.selectOption(instanceId, ref, value)
      }
      case 'sendKey': {
        const [instanceId, keyArgs] = args as [string, BrowserKeyArgs]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.sendKey(instanceId, keyArgs)
      }
      case 'scroll': {
        const [instanceId, direction, amount] = args as [
          string, 'up' | 'down' | 'left' | 'right', number | undefined,
        ]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.scroll(instanceId, direction, amount)
      }
      case 'waitFor': {
        const [instanceId, waitArgs] = args as [string, BrowserWaitArgs]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.waitFor(instanceId, waitArgs)
      }
      case 'evaluate': {
        const [instanceId, expression] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.evaluate(instanceId, expression)
      }

      // -- Clipboard -----------------------------------------------------------
      case 'setClipboard': {
        const [instanceId, text] = args as [string, string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.setClipboard(instanceId, text)
      }
      case 'getClipboard': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getClipboard(instanceId)
      }

      // -- Capture / introspection --------------------------------------------
      case 'screenshot': {
        const [instanceId, options] = args as [string, BrowserScreenshotOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        const result = await this.screenshot(instanceId, options)
        return this.toScreenshotWire(result)
      }
      case 'screenshotRegion': {
        const [instanceId, target] = args as [string, BrowserScreenshotRegionTarget]
        this.requireOwnedInstance(instanceId, ownerKey)
        const result = await this.screenshotRegion(instanceId, target)
        return this.toScreenshotWire(result)
      }
      case 'getConsoleLogs': {
        const [instanceId, options] = args as [string, BrowserConsoleOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getConsoleLogs(instanceId, options)
      }
      case 'getNetworkLogs': {
        const [instanceId, options] = args as [string, BrowserNetworkOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getNetworkLogs(instanceId, options)
      }
      case 'windowResize': {
        const [instanceId, width, height] = args as [string, number, number]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.windowResize(instanceId, width, height)
      }
      case 'getDownloads': {
        const [instanceId, options] = args as [string, BrowserDownloadOptions | undefined]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.getDownloads(instanceId, options)
      }
      case 'uploadFile':
        throw new CodedError('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
          'File upload from a remote agent is not supported yet. Ask the user to attach the file to the session.')
      case 'detectSecurityChallenge': {
        const [instanceId] = args as [string]
        this.requireOwnedInstance(instanceId, ownerKey)
        return this.detectSecurityChallenge(instanceId)
      }

      default: {
        const method = (req as { method?: unknown }).method
        throw new CodedError('HANDLER_ERROR', `Unknown browser capability method: ${String(method)}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent Control — persistent overlay while agent is using the browser
  // ---------------------------------------------------------------------------

  /**
   * Activate or update the agent control overlay on the browser instance
   * bound to the given session. Called from sessions.ts on browser_* tool_start events.
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.agentControl = {
          active: true,
          sessionId,
          displayName: meta.displayName,
          intent: meta.intent,
        }

        // Backfill workspaceId for instances that were created before the
        // workspace was known (legacy callers / pre-workspaceId code paths).
        if (options?.workspaceId !== undefined && instance.workspaceId === null) {
          instance.workspaceId = options.workspaceId
        }

        const label = this.getAgentControlLabel(instance.agentControl)

        this.reapplyAgentControlVisual(instance)
        this.emitStateChange(instance)

        mainLog.info(`[browser-pane] agent control activated session=${sessionId} label=${label}`)
        return
      }
    }
  }

  /**
   * Clear the agent control overlay for the given session.
   * Called on explicit browser_tool release and session/window teardown.
   */
  clearAgentControl(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId && instance.agentControl?.active) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] agent control released session=${sessionId}`)
      }
    }
  }

  clearAgentControlForInstance(instanceId: string, sessionId?: string): { released: boolean; reason?: string } {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      return { released: false, reason: `Browser window "${instanceId}" not found.` }
    }

    if (sessionId) {
      if (instance.boundSessionId && instance.boundSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is locked to session ${instance.boundSessionId}.` }
      }

      if (!instance.boundSessionId && instance.ownerSessionId && instance.ownerSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is currently owned by session ${instance.ownerSessionId}.` }
      }
    }

    if (!instance.agentControl?.active) {
      return { released: false, reason: 'No active agent overlay on the target window.' }
    }

    instance.agentControl = null
    this.applyAgentControlLock(instance, false)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] agent control released instance=${instanceId}${sessionId ? ` session=${sessionId}` : ''}`)

    return { released: true }
  }

  /**
   * Extract a theme color from the page using Safari 26-style heuristics.
   * Priority: media-aware theme-color meta → elementsFromPoint (fixed/sticky headers) → body/html bg.
   * All colors pass through (including white/black) — contrast is handled by the renderer.
   * Guards against stale extraction (URL change during async executeJavaScript).
   */
  private async extractThemeColor(instance: BrowserInstance): Promise<void> {
    if (instance.themeColor) return // already set by did-change-theme-color or observer
    const urlAtStart = instance.currentUrl
    try {
      const color = await instance.pageView.webContents.executeJavaScript(`(${THEME_COLOR_EXTRACTOR_FN})()`)
      // Guard: if user navigated away during extraction, discard stale result
      if (instance.currentUrl !== urlAtStart) return
      if (typeof color === 'string' && color.length > 0) {
        this.applyThemeColor(instance, color)
      }
    } catch {
      // page destroyed or JS error — ignore
    }
  }

  private applyThemeColor(instance: BrowserInstance, color: string | null): void {
    if (instance.themeColor === color) return
    instance.themeColor = color
    this.emitStateChange(instance)
  }

  private installThemeObserver(instance: BrowserInstance, allowRetry = true): void {
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const urlAtInstall = instance.currentUrl
    instance.themeObserverToken = token

    void instance.pageView.webContents.executeJavaScript(`
      (() => {
        const token = ${JSON.stringify(token)};
        const prefix = ${JSON.stringify(THEME_COLOR_SIGNAL_PREFIX)} + token + ':';
        const nullSentinel = ${JSON.stringify(THEME_COLOR_NULL_SENTINEL)};
        const extractThemeColor = ${THEME_COLOR_EXTRACTOR_FN};

        const w = window;
        const previousCleanup = w.__BITLAB_THEME_OBSERVER_CLEANUP__;
        if (typeof previousCleanup === 'function') {
          try { previousCleanup(); } catch {}
        }

        let lastColor = '__unset__';
        let rafId = 0;
        let timerId = 0;
        let lastRunAt = 0;
        const minIntervalMs = ${THEME_OBSERVER_MIN_INTERVAL_MS};

        const clearScheduled = () => {
          if (timerId) {
            clearTimeout(timerId);
            timerId = 0;
          }
          if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
          }
        };

        const emit = (color) => {
          const normalized = typeof color === 'string' && color.length > 0 ? color : null;
          if (normalized === lastColor) return;
          lastColor = normalized;
          console.info(prefix + (normalized ?? nullSentinel));
        };

        const run = () => {
          rafId = 0;
          lastRunAt = Date.now();
          try {
            emit(extractThemeColor());
          } catch {}
        };

        const schedule = () => {
          if (rafId || timerId) return;
          const waitMs = Math.max(0, minIntervalMs - (Date.now() - lastRunAt));
          if (waitMs > 0) {
            timerId = setTimeout(() => {
              timerId = 0;
              rafId = requestAnimationFrame(run);
            }, waitMs);
            return;
          }
          rafId = requestAnimationFrame(run);
        };

        const onScroll = () => schedule();
        const onResize = () => schedule();
        const onMutation = () => schedule();

        const headObserver = new MutationObserver(onMutation);
        if (document.head) {
          headObserver.observe(document.head, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['name', 'content', 'media'],
          });
        }

        const rootObserver = new MutationObserver(onMutation);
        if (document.documentElement) {
          rootObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }
        if (document.body) {
          rootObserver.observe(document.body, {
            attributes: true,
            attributeFilter: ['class', 'style'],
          });
        }

        w.addEventListener('scroll', onScroll, { passive: true });
        w.addEventListener('resize', onResize, { passive: true });

        const mql = w.matchMedia('(prefers-color-scheme: dark)');
        const onSchemeChange = () => schedule();
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onSchemeChange);
        else if (typeof mql.addListener === 'function') mql.addListener(onSchemeChange);

        w.__BITLAB_THEME_OBSERVER_CLEANUP__ = () => {
          headObserver.disconnect();
          rootObserver.disconnect();
          w.removeEventListener('scroll', onScroll);
          w.removeEventListener('resize', onResize);
          if (typeof mql.removeEventListener === 'function') mql.removeEventListener('change', onSchemeChange);
          else if (typeof mql.removeListener === 'function') mql.removeListener(onSchemeChange);
          clearScheduled();
        };

        // Fast first color for the dock's first paint and after SPA route changes
        schedule();
      })()
    `).catch(() => {
      if (!allowRetry) return
      setTimeout(() => {
        if (!this.instances.has(instance.id)) return
        if (instance.currentUrl !== urlAtInstall) return
        if (instance.themeObserverToken !== token) return
        this.installThemeObserver(instance, false)
      }, 120)
    })
  }

  private scheduleEarlyThemeExtraction(instance: BrowserInstance, urlAtSchedule: string): void {
    setTimeout(() => {
      if (!this.instances.has(instance.id)) return
      if (instance.currentUrl !== urlAtSchedule) return
      void this.extractThemeColor(instance)
    }, EARLY_THEME_EXTRACTION_DELAY_MS)
  }

  private getInstanceByWebContentsId(webContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pageView.webContents.id === webContentsId) return instance
    }
    return undefined
  }

  private pushNetworkLog(instance: BrowserInstance, entry: BrowserNetworkEntry): void {
    instance.networkLogs.push(entry)
    if (instance.networkLogs.length > MAX_NETWORK_LOG_ENTRIES) {
      instance.networkLogs.splice(0, instance.networkLogs.length - MAX_NETWORK_LOG_ENTRIES)
    }
  }

  private pushDownloadLog(instance: BrowserInstance, entry: BrowserDownloadEntry): void {
    instance.downloads.push(entry)
    if (instance.downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
      instance.downloads.splice(0, instance.downloads.length - MAX_DOWNLOAD_LOG_ENTRIES)
    }
  }

  private resolveDownloadsDir(instance: BrowserInstance): string {
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId
    if (sessionId && this.sessionPathResolver) {
      const sessionPath = this.sessionPathResolver(sessionId)
      if (sessionPath) {
        const dir = join(sessionPath, 'downloads')
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
    // Fallback: OS downloads folder for manual/unbound windows
    return app.getPath('downloads')
  }

  private uniqueFilename(dir: string, filename: string): string {
    if (!existsSync(join(dir, filename))) return filename
    const { name, ext } = parsePath(filename)
    let counter = 1
    while (existsSync(join(dir, `${name}_${counter}${ext}`))) {
      counter++
    }
    return `${name}_${counter}${ext}`
  }

  private setupSessionObservers(ses: ElectronSession): void {
    if (this.partitionObserversInitialized) return
    this.partitionObserversInitialized = true

    ses.webRequest.onBeforeRequest((details, callback) => {
      const wcId = details.webContentsId
      if (typeof wcId === 'number' && wcId > 0) {
        const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        this.inFlightRequestsByWebContentsId.set(wcId, current + 1)
        this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())
      }
      callback({})
    })

    ses.webRequest.onCompleted((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      this.pushNetworkLog(instance, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: details.statusCode ?? 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: (details.statusCode ?? 0) >= 200 && (details.statusCode ?? 0) < 400,
      })
    })

    ses.webRequest.onErrorOccurred((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      this.pushNetworkLog(instance, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: false,
      })
    })

    ses.on('will-download', (_event, item, webContents) => {
      const wcId = webContents?.id
      if (typeof wcId !== 'number') return
      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      // Auto-save: set a deterministic path so Electron doesn't show a native dialog
      const downloadsDir = this.resolveDownloadsDir(instance)
      const filename = this.uniqueFilename(downloadsDir, item.getFilename())
      const savePath = join(downloadsDir, filename)
      item.setSavePath(savePath)

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const started: BrowserDownloadEntry = {
        id: downloadId,
        timestamp: Date.now(),
        url: item.getURL(),
        filename,
        state: 'started',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        mimeType: item.getMimeType() || 'application/octet-stream',
        savePath,
      }
      this.pushDownloadLog(instance, started)

      const onUpdated = (_e: Electron.Event, state: string) => {
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        if (state === 'interrupted') latest.state = 'interrupted'
      }

      item.on('updated', onUpdated)

      item.once('done', (_e, state) => {
        item.removeListener('updated', onUpdated)
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        latest.savePath = item.getSavePath()
        latest.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      })
    })
  }

  private logPermissionDecision(kind: 'check' | 'request', permission: string, origin: string): void {
    const isNonBlockingNoise = permission === 'background-sync'
    const suffix = isNonBlockingNoise ? ' (non-blocking)' : ''
    const message = `[browser-pane] permission denied (${kind}): ${permission} origin=${origin}${suffix}`
    if (isNonBlockingNoise) {
      mainLog.info(message)
      return
    }
    mainLog.warn(message)
  }

  private setupSessionPermissions(ses: ElectronSession): void {
    if (this.partitionPermissionsInitialized) return
    this.partitionPermissionsInitialized = true

    const allow = new Set([
      'fullscreen',
      'pointerLock',
      'window-management',
      'notifications',
      'geolocation',
      'media',
      'clipboard-read',
      'clipboard-sanitized-write',
      'idle-detection',
    ])

    if (typeof ses.setPermissionCheckHandler === 'function') {
      ses.setPermissionCheckHandler((_webContents, permission: string, requestingOrigin: string, _details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('check', permission, requestingOrigin)
        }
        return allowed
      })
    }

    if (typeof ses.setPermissionRequestHandler === 'function') {
      ses.setPermissionRequestHandler((_webContents, permission: string, callback: (allow: boolean) => void, details: any) => {
        const allowed = allow.has(permission)
        if (!allowed) {
          this.logPermissionDecision('request', permission, details?.requestingOrigin ?? 'unknown')
        }
        callback(allowed)
      })
    }
  }

  private setupInstanceListeners(instance: BrowserInstance): void {
    const pageWc = instance.pageView.webContents
    const overlayWc = instance.nativeOverlayView.webContents

    // The page died on its own (OOM, renderer crash). Codex shipped this exact
    // bug — a sidebar webview crash taking the whole app with it — so the tab
    // is torn down and the renderer is told, instead of leaving a dead view up.
    pageWc.on('render-process-gone', (_event, details) => {
      mainLog.error(`[browser-pane] page process gone id=${instance.id} reason=${details.reason} exitCode=${details.exitCode}`)
      instance.crashed = { reason: details.reason, at: Date.now() }
      this.detachInstance(instance)
      this.emitStateChange(instance)
    })

    pageWc.on('did-start-loading', () => {
      instance.crashed = null
      instance.isLoading = true
      this.emitStateChange(instance)
    })

    pageWc.on('did-stop-loading', () => {
      instance.isLoading = false
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.extractThemeColor(instance)
      this.reapplyAgentControlVisual(instance)
    })

    pageWc.on('dom-ready', () => {
      this.installThemeObserver(instance)
      void this.extractThemeColor(instance)
    })

    pageWc.on('before-input-event', (_event, _input) => {
      if (instance.lockState.active) {
        _event.preventDefault()
      }
    })

    // The shield swallows everything while the agent drives.
    overlayWc.on('before-input-event', (event) => {
      event.preventDefault()
    })

    pageWc.on('did-navigate', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      const previousUrl = instance.currentUrl
      if (instance.inPageThemeTimer) {
        clearTimeout(instance.inPageThemeTimer)
        instance.inPageThemeTimer = null
      }
      instance.themeObserverToken = null
      instance.themeColor = null // reset for new page (batched with state push below)
      const normalized = this.normalizePageState(url, pageWc.getTitle())
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${instance.currentUrl}`)
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — prior page's requests are cancelled on navigation
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      this.scheduleEarlyThemeExtraction(instance, url)
      this.reapplyAgentControlVisual(instance)
      // A load wipes the picker along with the document.
      if (instance.annotationMode) void this.injectAnnotationScript(instance)
    })

    pageWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`)
    })

    pageWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      const normalized = this.normalizePageState(url, instance.title)
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()

      void this.maybeHandleEmptyStateLaunch(instance, url).then((handled) => {
        if (handled) {
          this.emitStateChange(instance)
          return
        }

        // SPA route change — re-extract theme color (debounced)
        if (instance.inPageThemeTimer) clearTimeout(instance.inPageThemeTimer)
        instance.themeObserverToken = null
        instance.themeColor = null
        this.emitStateChange(instance)
        this.installThemeObserver(instance)
        instance.inPageThemeTimer = setTimeout(() => { void this.extractThemeColor(instance) }, 300)
        this.reapplyAgentControlVisual(instance)
      }).catch((error) => {
        mainLog.warn(`[browser-pane] empty-state launch handling failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    pageWc.on('page-title-updated', (_event, title) => {
      const normalized = this.normalizePageState(pageWc.getURL(), title)
      instance.title = normalized.title
      this.emitStateChange(instance)
    })

    pageWc.on('page-favicon-updated', (_event, favicons) => {
      instance.favicon = favicons[0] || null
      this.emitStateChange(instance)
    })

    pageWc.on('did-change-theme-color', (_event, color) => {
      this.applyThemeColor(instance, color ?? null)
    })

    pageWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('console-message', (_event, level, message) => {
      if (message.startsWith(ANNOTATION_SIGNAL_PREFIX)) {
        try {
          const pick = JSON.parse(message.slice(ANNOTATION_SIGNAL_PREFIX.length))
          void this.handleAnnotationPick(instance, pick)
        } catch {
          mainLog.warn(`[browser-pane] malformed annotation signal id=${instance.id}`)
        }
        return
      }

      if (message.startsWith(THEME_COLOR_SIGNAL_PREFIX)) {
        const payload = message.slice(THEME_COLOR_SIGNAL_PREFIX.length)
        const delimiterIdx = payload.indexOf(':')
        if (delimiterIdx > 0) {
          const token = payload.slice(0, delimiterIdx)
          const value = payload.slice(delimiterIdx + 1).trim()
          if (token === instance.themeObserverToken) {
            if (value === THEME_COLOR_NULL_SENTINEL) {
              this.applyThemeColor(instance, null)
            } else if (value.length > 0) {
              this.applyThemeColor(instance, value)
            }
          }
        }
        return
      }

      const mappedLevel: BrowserConsoleEntry['level'] = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log'
      instance.consoleLogs.push({
        timestamp: Date.now(),
        level: mappedLevel,
        message,
      })
      if (instance.consoleLogs.length > MAX_CONSOLE_LOG_ENTRIES) {
        instance.consoleLogs.splice(0, instance.consoleLogs.length - MAX_CONSOLE_LOG_ENTRIES)
      }

      if (level >= 2) {
        mainLog.warn(`[browser-pane] console id=${instance.id} level=${level}: ${message}`)
      }
    })

    pageWc.on('will-navigate', (event, url) => {
      if (url.startsWith(BITLAB_DEEPLINK_SCHEME_PREFIX)) {
        event.preventDefault()
        void this.handleDeepLinkUrl(url)
      }
    })

    // target=_blank / window.open lands as a new tab in the same dock — the
    // shape Codex and Claude both settled on. Never a separate native window.
    pageWc.setWindowOpenHandler((details) => {
      mainLog.info(
        `[browser-pane] window-open requested id=${instance.id} url=${details.url} disposition=${details.disposition ?? 'unknown'} frameName=${details.frameName || 'none'}`,
      )

      if (details.url.startsWith(BITLAB_DEEPLINK_SCHEME_PREFIX)) {
        void this.handleDeepLinkUrl(details.url)
        return { action: 'deny' }
      }

      let parsed: URL
      try {
        parsed = new URL(details.url)
      } catch {
        mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=invalid_url url=${details.url}`)
        return { action: 'deny' }
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=unsupported_protocol protocol=${parsed.protocol} url=${details.url}`)
        return { action: 'deny' }
      }

      this.openInNewTab(instance, details.url)
      return { action: 'deny' }
    })

    pageWc.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    pageWc.on('destroyed', () => {
      this.finalizeDestroyedInstance(instance, 'closed')
    })
  }

  /**
   * Open `url` as a sibling tab of `origin` and surface it. Used by
   * window.open/target=_blank, which never gets its own native window.
   */
  private openInNewTab(origin: BrowserInstance, url: string): string {
    const tabId = this.createInstance(undefined, {
      workspaceId: origin.workspaceId,
      ownerType: origin.ownerType,
      ownerSessionId: origin.ownerSessionId ?? undefined,
    })

    void this.navigate(tabId, url).catch((error) => {
      mainLog.warn(`[browser-pane] new-tab navigation failed id=${tabId} url=${url}: ${error instanceof Error ? error.message : String(error)}`)
    })

    this.focus(tabId)
    mainLog.info(`[browser-pane] opened new tab id=${tabId} from=${origin.id} url=${url}`)
    return tabId
  }

  private toInfo(instance: BrowserInstance): BrowserInstanceInfo {
    return {
      id: instance.id,
      url: instance.currentUrl,
      title: instance.title,
      favicon: instance.favicon,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      boundSessionId: instance.boundSessionId,
      ownerType: instance.ownerType,
      ownerSessionId: instance.ownerSessionId,
      isVisible: instance.isVisible,
      agentControlActive: !!instance.agentControl?.active,
      agentControlLabel: instance.agentControl?.active
        ? this.getAgentControlLabel(instance.agentControl)
        : null,
      themeColor: instance.themeColor,
      workspaceId: instance.workspaceId,
      crashed: instance.crashed,
    }
  }

  private emitStateChange(instance: BrowserInstance): void {
    if (!this.instances.has(instance.id)) {
      return
    }
    this.stateChangeCallback?.(this.toInfo(instance))
  }
}
