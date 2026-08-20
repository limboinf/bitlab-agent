/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron WebContentsView/BrowserWindow and session modules to validate
 * lifecycle, session binding, navigation, and dock attachment behavior.
 *
 * Browser instances are docked views inside a host window, not standalone
 * windows, so most tests register a dock first via `attachDock()`.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'

const createdWindows: any[] = []
let webContentsIdCounter = 0
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    id: ++webContentsIdCounter,
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    isDestroyed: mock(() => false),
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
    }),
    loadFile: mock(async (path: string, opts?: { query?: Record<string, string> }) => {
      const query = opts?.query ? `?${new URLSearchParams(opts.query).toString()}` : ''
      currentUrl = `file://${path}${query}`
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    executeJavaScript: mock(async (expr: string) => eval(expr)),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    close: mock(() => {}),
    getZoomFactor: mock(() => 1),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      if ((event === 'did-navigate' || event === 'did-navigate-in-page') && typeof args[0] === 'string') {
        currentUrl = args[0]
      }
      for (const cb of listeners[event] || []) cb({}, ...args)
    },
  }
}

function createMockView() {
  const webContents = createMockWebContents()
  let bounds = { x: 0, y: 0, width: 0, height: 0 }
  return {
    webContents,
    setBounds: mock((next: typeof bounds) => { bounds = next }),
    getBounds: mock(() => bounds),
    setVisible: mock((_visible: boolean) => {}),
    setAutoResize: mock(() => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0

  const win = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    restore: mock(() => {}),
    show: mock(() => {}),
    showInactive: mock(() => {}),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    contentView: {
      addChildView: mock((_view: any) => {}),
      removeChildView: mock((_view: any) => {}),
    },
    setBackgroundColor: mock((_color: string) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    getPath: mock((name: string) => name === 'downloads' ? '/tmp/mock-downloads' : `/tmp/mock-${name}`),
  },
  BrowserWindow: Object.assign(
    class MockBrowserWindow {
      webContents: any
      constructor(opts?: any) {
        const win = createMockWindow(opts)
        this.webContents = win.webContents
        Object.assign(this, win)
      }
    },
    { getAllWindows: mock(() => createdWindows) },
  ),
  WebContentsView: class MockWebContentsView {
    webContents: any
    constructor(_opts?: any) {
      const view = createMockView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    setViewportOverride = mock(async () => {})
    clearViewportOverride = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

const { BrowserPaneManager } = await import('../browser-pane-manager')

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  /**
   * Register a dock the way the renderer would, and point it at `activeId`.
   * Without this there is nowhere for a tab to attach — background tabs are
   * live but view-less, which is the normal state, not an error.
   */
  function attachDock(activeInstanceId: string | null, overrides?: {
    visible?: boolean
    suppressed?: boolean
    bounds?: { x: number; y: number; width: number; height: number } | null
    host?: any
  }) {
    const host = overrides?.host ?? createMockWindow()
    manager.setDockState(host.webContents.id, {
      visible: overrides?.visible ?? true,
      suppressed: overrides?.suppressed ?? false,
      activeInstanceId,
      bounds: overrides?.bounds === undefined
        ? { x: 800, y: 40, width: 480, height: 800 }
        : overrides.bounds,
    })
    return host
  }

  beforeEach(() => {
    createdWindows.length = 0
    webContentsIdCounter = 0
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    manager = new BrowserPaneManager()
  })

  it('creates and lists instances', () => {
    const id = manager.createInstance('test-1')
    const list = manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('uses the app theme mode for new browser surfaces', async () => {
    manager.setThemeMode('dark')
    manager.createInstance('theme-dark')
    await Bun.sleep(0)

    const instance = (manager as any).instances.get('theme-dark')
    expect(instance.pageView.webContents.loadFile).toHaveBeenCalledWith(
      expect.stringContaining('browser-empty-state.html'),
      { query: { themeMode: 'dark' } },
    )
  })

  it('updates an open browser tab when the app theme changes', async () => {
    manager.createInstance('theme-live')
    await Bun.sleep(0)
    const instance = (manager as any).instances.get('theme-live')

    manager.setThemeMode('dark')

    expect(instance.pageView.webContents.setBackgroundColor).toHaveBeenLastCalledWith('#2b292e')
    expect(instance.pageView.webContents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('"dark"'),
    )
  })

  it('is idempotent when explicit ID already exists', () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('opens http(s) window.open targets as a new tab instead of a window', () => {
    manager.createInstance('popup-allow')
    const instance = (manager as any).instances.get('popup-allow')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-popup',
      frameName: 'oauth-popup',
    })

    // Denied as a native window, re-opened as a sibling tab in the same dock.
    expect(result).toEqual({ action: 'deny' })
    const tabs = manager.listInstances()
    expect(tabs).toHaveLength(2)
    expect(tabs.some((t) => t.id !== 'popup-allow')).toBe(true)
  })

  it('inherits workspace and session ownership when opening a new tab', () => {
    manager.createInstance('popup-owner', { workspaceId: 'ws-1', ownerType: 'session', ownerSessionId: 's-1' })
    const instance = (manager as any).instances.get('popup-owner')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    openHandler({ url: 'https://example.com/popup', disposition: 'new-popup', frameName: '' })

    const opened = manager.listInstances().find((t) => t.id !== 'popup-owner')
    expect(opened?.workspaceId).toBe('ws-1')
    expect(opened?.ownerSessionId).toBe('s-1')
  })

  it('denies non-http(s) window.open targets without opening a tab', () => {
    manager.createInstance('popup-scheme')
    const instance = (manager as any).instances.get('popup-scheme')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({ url: 'ftp://example.com/file', disposition: 'new-popup', frameName: '' })

    expect(result).toEqual({ action: 'deny' })
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'bitlab://settings',
      disposition: 'new-popup',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('bitlab://settings')
  })

  it('destroys instances', () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('detaches the view from its dock when the tab is destroyed', () => {
    manager.createInstance('d-detach')
    const host = attachDock('d-detach')
    const instance = (manager as any).instances.get('d-detach')

    expect(host.contentView.addChildView).toHaveBeenCalled()

    manager.destroyInstance('d-detach')

    expect(host.contentView.removeChildView).toHaveBeenCalledWith(instance.pageView)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback exactly once when destroy triggers closed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    // A late dock push naming the dead instance must not resurrect its events.
    attachDock('d-late-state')
    instance.pageView.webContents._emit('did-start-loading')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('binds and unbinds sessions', () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect(manager.listInstances()[0].boundSessionId).toBe('session-abc')
    expect(manager.listInstances()[0].ownerType).toBe('session')

    manager.unbindSession('b1')
    expect(manager.listInstances()[0].boundSessionId).toBeNull()
    expect(manager.listInstances()[0].ownerType).toBe('manual')
  })

  it('createForSession returns canonical bound instance', () => {
    const id1 = manager.createForSession('sess-1')
    const id2 = manager.createForSession('sess-1')
    const info = manager.listInstances()[0]

    expect(id1).toBe(id2)
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-1')
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('getOrCreateForSession reuses existing instance', () => {
    const id1 = manager.getOrCreateForSession('sess-1')
    const id2 = manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('createForSession reuses an unbound manual window before creating new', () => {
    manager.createInstance('manual-1')

    const id = manager.createForSession('sess-reuse')

    expect(id).toBe('manual-1')
    const info = manager.listInstances()[0]
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-reuse')
    expect(info.boundSessionId).toBe('sess-reuse')
    expect(manager.listInstances()).toHaveLength(1)
  })

  describe('workspaceId stamping', () => {
    it('createForSession with workspaceId stamps the field on a new instance', () => {
      const id = manager.createForSession('sess-ws', { workspaceId: 'ws-alpha' })
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBe('ws-alpha')
    })

    it('createForSession without workspaceId defaults to null', () => {
      const id = manager.createForSession('sess-plain')
      const info = manager.listInstances().find((i) => i.id === id)
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance with no options leaves workspaceId null (unbound window)', () => {
      manager.createInstance('manual-ws')
      const info = manager.listInstances().find((i) => i.id === 'manual-ws')
      expect(info?.workspaceId).toBeNull()
    })

    it('manual createInstance accepts workspaceId option (TopBar manual open)', () => {
      // The browser-pane CREATE handler passes ctx.workspaceId so TopBar-
      // opened windows stay scoped to the workspace the user clicked from,
      // rather than being broadcast to every workspace.
      manager.createInstance('manual-scoped', { workspaceId: 'ws-toolbar' })
      const info = manager.listInstances().find((i) => i.id === 'manual-scoped')
      expect(info?.workspaceId).toBe('ws-toolbar')
    })

    it('reusing an unbound manual window adopts the new binder workspace', () => {
      manager.createInstance('manual-reuse')
      expect(manager.listInstances().find((i) => i.id === 'manual-reuse')?.workspaceId).toBeNull()

      const id = manager.createForSession('sess-reuse-ws', { workspaceId: 'ws-beta' })
      expect(id).toBe('manual-reuse')

      const info = manager.listInstances().find((i) => i.id === 'manual-reuse')
      expect(info?.workspaceId).toBe('ws-beta')
      expect(info?.ownerSessionId).toBe('sess-reuse-ws')
    })

    it('bindSession with workspaceId overwrites the instance workspaceId', () => {
      manager.createInstance('bind-ws')
      manager.bindSession('bind-ws', 'sess-bound', { workspaceId: 'ws-gamma' })
      const info = manager.listInstances().find((i) => i.id === 'bind-ws')
      expect(info?.workspaceId).toBe('ws-gamma')
      expect(info?.boundSessionId).toBe('sess-bound')
    })

    it('setAgentControl backfills workspaceId when previously null', () => {
      // Legacy path: instance was created without a workspace, then the overlay
      // path supplies it. Backfill should stamp it.
      manager.createInstance('legacy-overlay')
      manager.bindSession('legacy-overlay', 'sess-legacy')
      manager.setAgentControl('sess-legacy', { displayName: 'browser_navigate' }, { workspaceId: 'ws-delta' })

      const info = manager.listInstances().find((i) => i.id === 'legacy-overlay')
      expect(info?.workspaceId).toBe('ws-delta')
    })

    it('toInfo emits workspaceId on the DTO', () => {
      manager.createForSession('sess-dto', { workspaceId: 'ws-epsilon' })
      const dto = manager.listInstances().find((i) => i.ownerSessionId === 'sess-dto')
      expect(dto).toBeDefined()
      expect(dto).toHaveProperty('workspaceId', 'ws-epsilon')
    })

    describe('cross-workspace reuse', () => {
      it('does NOT reuse an unbound session window from another workspace', () => {
        // Session in workspace A opens a window, then its turn ends — the
        // unbind path sets ownerType='manual' and clears boundSessionId, but
        // workspaceId stays = A. A session in workspace B asking for a window
        // must NOT pick it up; that would "move" the window across workspaces.
        const wsA = manager.createForSession('sess-a', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a')

        // Sanity: instance is now unbound + manual but retains workspaceId=A.
        const after = manager.listInstances().find((i) => i.id === wsA)
        expect(after?.boundSessionId).toBeNull()
        expect(after?.ownerType).toBe('manual')
        expect(after?.workspaceId).toBe('ws-a')

        const wsB = manager.createForSession('sess-b', { workspaceId: 'ws-b' })
        expect(wsB).not.toBe(wsA)
        expect(manager.listInstances()).toHaveLength(2)

        // Workspace-A's window still belongs to A.
        const stillA = manager.listInstances().find((i) => i.id === wsA)
        expect(stillA?.workspaceId).toBe('ws-a')
      })

      it('DOES reuse an unbound window within the same workspace (next-turn case)', () => {
        // The legitimate same-workspace reuse: session-A ends a turn, leaves
        // an unbound window behind; the same workspace's session-A (or any
        // session in workspace A) should grab it on the next turn.
        const original = manager.createForSession('sess-a1', { workspaceId: 'ws-a' })
        manager.unbindAllForSession('sess-a1')

        const reused = manager.createForSession('sess-a2', { workspaceId: 'ws-a' })
        expect(reused).toBe(original)
        expect(manager.listInstances()).toHaveLength(1)
      })

      it('lets any workspace adopt a truly unbound (workspaceId=null) manual window', () => {
        manager.createInstance('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBeNull()

        const adopted = manager.createForSession('sess-c', { workspaceId: 'ws-c' })
        expect(adopted).toBe('manual-anyworkspace')
        expect(manager.listInstances().find((i) => i.id === 'manual-anyworkspace')?.workspaceId).toBe('ws-c')
      })

      it('does NOT reuse a workspaceId=null unbound window when allowReuseManual=false', () => {
        // Remote-bridge dispatcher path: every lifecycle call passes
        // allowReuseManual=false so a stale window from before workspace
        // stamping (workspaceId=null) cannot get hijacked by a remote agent
        // for an unrelated workspace.
        manager.createInstance('legacy-unstamped')
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()

        const fresh = manager.createForSession('sess-d', {
          workspaceId: 'ws-d',
          allowReuseManual: false,
        })
        expect(fresh).not.toBe('legacy-unstamped')
        // Legacy window is left untouched.
        expect(manager.listInstances().find((i) => i.id === 'legacy-unstamped')?.workspaceId).toBeNull()
        // A new instance was created for the remote session.
        expect(manager.listInstances().find((i) => i.id === fresh)?.ownerSessionId).toBe('sess-d')
      })
    })
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'bitlab browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=bitlab%20browser%20tools'
    )
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus raises a show request for the renderer to open the dock', () => {
    const requests: Array<{ instanceId: string; hostWebContentsId: number }> = []
    manager.onShowRequest((payload) => requests.push(payload))

    manager.createInstance('f1')
    const host = attachDock('f1')
    manager.focus('f1')

    expect(host.show).toHaveBeenCalled()
    expect(host.focus).toHaveBeenCalled()
    expect(requests).toEqual([{ instanceId: 'f1', hostWebContentsId: host.webContents.id }])
  })

  it('focus without any dock is a no-op rather than a crash', () => {
    const requests: unknown[] = []
    manager.onShowRequest((payload) => requests.push(payload))

    manager.createInstance('f-no-dock')
    expect(() => manager.focus('f-no-dock')).not.toThrow()
    expect(requests).toHaveLength(0)
  })

  it('attaches only the dock active tab and detaches the rest', () => {
    manager.createInstance('tab-a')
    manager.createInstance('tab-b')

    const host = attachDock('tab-a')
    const a = (manager as any).instances.get('tab-a')
    const b = (manager as any).instances.get('tab-b')

    expect(a.host).toBe(host)
    expect(b.host).toBeNull()
    expect(manager.listInstances().find((i) => i.id === 'tab-a')?.isVisible).toBe(true)

    // Switching tabs moves the single native slot over.
    attachDock('tab-b', { host })

    expect(a.host).toBeNull()
    expect(b.host).toBe(host)
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(a.pageView)
  })

  it('parks the page view on the reported dock rect', () => {
    manager.createInstance('bounds-1')
    attachDock('bounds-1', { bounds: { x: 700, y: 48, width: 500, height: 820 } })

    const instance = (manager as any).instances.get('bounds-1')
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 700, y: 48, width: 500, height: 820 })
  })

  it('scales dock bounds by the host zoom factor', () => {
    manager.createInstance('bounds-zoom')
    const host = createMockWindow()
    host.webContents.getZoomFactor = mock(() => 2)
    attachDock('bounds-zoom', { host, bounds: { x: 100, y: 20, width: 300, height: 400 } })

    const instance = (manager as any).instances.get('bounds-zoom')
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith({ x: 200, y: 40, width: 600, height: 800 })
  })

  it('detaches while a renderer overlay suppresses the dock', () => {
    manager.createInstance('suppress-1')
    const host = attachDock('suppress-1')
    const instance = (manager as any).instances.get('suppress-1')
    expect(instance.host).toBe(host)

    attachDock('suppress-1', { host, suppressed: true })

    expect(instance.host).toBeNull()
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('detaches when the dock is closed but keeps the tab alive', () => {
    manager.createInstance('dock-closed')
    const host = attachDock('dock-closed')

    attachDock(null, { host, visible: false, bounds: null })

    const instance = (manager as any).instances.get('dock-closed')
    expect(instance.host).toBeNull()
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('hide detaches the tab without destroying it', () => {
    manager.createInstance('h1')
    attachDock('h1')

    manager.hide('h1')

    const instance = (manager as any).instances.get('h1')
    expect(instance.host).toBeNull()
    expect(manager.listInstances()).toHaveLength(1)
    expect(manager.listInstances()[0].isVisible).toBe(false)
  })

  it('releases dock views when the host window closes', () => {
    manager.createInstance('host-closed')
    const host = attachDock('host-closed')
    const instance = (manager as any).instances.get('host-closed')

    host._emit('closed')

    expect(instance.host).toBeNull()
    expect((manager as any).docks.size).toBe(0)
    expect(manager.listInstances()).toHaveLength(1)
  })

  it('still destroys instance when cleanup throws', () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).detachInstance = () => {
      throw new Error('mock detach failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.pageView.webContents.close).toHaveBeenCalledTimes(1)
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when the page webContents is destroyed', () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.pageView.webContents._emit('destroyed')

    expect(removed).toEqual(['r1'])
    expect(manager.listInstances()).toHaveLength(0)
  })

  it('detaches and reports a crashed tab when its render process dies', () => {
    manager.createInstance('crash-1')
    const host = attachDock('crash-1')
    const instance = (manager as any).instances.get('crash-1')

    instance.pageView.webContents._emit('render-process-gone', { reason: 'crashed', exitCode: 133 })

    expect(instance.host).toBeNull()
    expect(host.contentView.removeChildView).toHaveBeenCalledWith(instance.pageView)
    expect(manager.listInstances()[0].crashed?.reason).toBe('crashed')
  })

  it('clears the crash flag once the tab starts loading again', () => {
    manager.createInstance('crash-2')
    const instance = (manager as any).instances.get('crash-2')

    instance.pageView.webContents._emit('render-process-gone', { reason: 'oom', exitCode: 9 })
    expect(manager.listInstances()[0].crashed).not.toBeNull()

    instance.pageView.webContents._emit('did-start-loading')
    expect(manager.listInstances()[0].crashed).toBeNull()
  })

  it('captures and filters console entries', () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-1:#123456')

    expect(manager.listInstances().find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('dedupes repeated observer theme signals', () => {
    const states: string[] = []
    manager.createInstance('theme-dedupe')
    const instance = (manager as any).instances.get('theme-dedupe')
    instance.themeObserverToken = 'tok-2'
    manager.onStateChange((info) => states.push(info.id))

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-2:#445566')
    const emitsAfterFirst = states.length

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-2:#445566')

    expect(states.length).toBe(emitsAfterFirst)
  })

  it('ignores observer theme signals from stale token', () => {
    manager.createInstance('theme-stale-token')
    const instance = (manager as any).instances.get('theme-stale-token')
    instance.themeObserverToken = 'tok-current'
    instance.themeColor = '#aaaaaa'

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-old:#bbccdd')

    expect(manager.listInstances().find(i => i.id === 'theme-stale-token')?.themeColor).toBe('#aaaaaa')
  })

  it('clears theme on explicit null sentinel signal', () => {
    manager.createInstance('theme-null')
    const instance = (manager as any).instances.get('theme-null')
    instance.themeObserverToken = 'tok-null'

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-null:#223344')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBe('#223344')

    instance.pageView.webContents._emit('console-message', 1, '__bitlab_theme_color__:tok-null:__NULL__')
    expect(manager.listInstances().find(i => i.id === 'theme-null')?.themeColor).toBeNull()
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect(manager.listInstances().find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('recovers screenshot by briefly activating the tab and restores the previous one', async () => {
    manager.createInstance('screenshot-rescue-success')
    manager.createInstance('screenshot-rescue-other')
    const host = attachDock('screenshot-rescue-other')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    let captureCalls = 0
    instance.pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function() { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    // The other tab is active again once the capture is done.
    expect((manager as any).docks.get(host.webContents.id).activeInstanceId).toBe('screenshot-rescue-other')
    expect(instance.host).toBeNull()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('briefly activating'))).toBe(true)
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes the viewport through CDP emulation rather than a window', async () => {
    manager.createInstance('resize-1')
    const resized = await manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    expect(instance.cdp.setViewportOverride).toHaveBeenCalledWith(1280, 720, false)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('emulates touch for viewports below the tablet breakpoint', async () => {
    manager.createInstance('resize-mobile')
    const resized = await manager.windowResize('resize-mobile', 375, 812)

    const instance = (manager as any).instances.get('resize-mobile')
    expect(instance.cdp.setViewportOverride).toHaveBeenCalledWith(375, 812, true)
    expect(resized).toEqual({ width: 375, height: 812 })
  })

  it('clamps viewport requests to a usable minimum', async () => {
    manager.createInstance('resize-min')
    const resized = await manager.windowResize('resize-min', 200, 200)

    expect(resized).toEqual({ width: 320, height: 240 })
  })

  describe('ambient context snapshot', () => {
    it('reports nothing when no dock is open', () => {
      manager.createInstance('ctx-closed')
      const snap = manager.getContextSnapshot()

      // A closed dock must not leak the page the user walked away from.
      expect(snap.activeTab).toBeNull()
      expect(snap.tabCount).toBe(1)
    })

    it('reports the dock active tab', () => {
      manager.createInstance('ctx-1')
      const instance = (manager as any).instances.get('ctx-1')
      instance.title = 'Example Site'
      instance.currentUrl = 'https://example.com/'
      attachDock('ctx-1')

      const snap = manager.getContextSnapshot()
      expect(snap.activeTab).toEqual({ title: 'Example Site', url: 'https://example.com/' })
      expect(snap.agentDriving).toBe(false)
    })

    it('reports nothing while an overlay suppresses the dock', () => {
      manager.createInstance('ctx-suppressed')
      const host = attachDock('ctx-suppressed')
      attachDock('ctx-suppressed', { host, suppressed: true })

      expect(manager.getContextSnapshot().activeTab).toBeNull()
    })

    it('flags when an agent is driving the active tab', () => {
      manager.createInstance('ctx-agent')
      manager.bindSession('ctx-agent', 'sess-ctx')
      attachDock('ctx-agent')
      manager.setAgentControl('sess-ctx', { displayName: 'Navigate' })

      expect(manager.getContextSnapshot().agentDriving).toBe(true)
    })

    it('does not report a tab from another workspace', () => {
      manager.createInstance('ctx-ws', { workspaceId: 'ws-a' })
      attachDock('ctx-ws')

      expect(manager.getContextSnapshot('ws-b').activeTab).toBeNull()
      expect(manager.getContextSnapshot('ws-a').activeTab).not.toBeNull()
    })
  })

  describe('session reuse targets the tab the user is watching', () => {
    it('adopts the dock active tab over an older unbound one', () => {
      manager.createInstance('reuse-old')
      manager.createInstance('reuse-watched')
      attachDock('reuse-watched')

      // Without an explicit dock-active preference this picks 'reuse-old' and
      // the agent silently drives a tab the user cannot see.
      expect(manager.createForSession('sess-reuse')).toBe('reuse-watched')
    })

    it('falls back to any unbound tab when no dock is open', () => {
      manager.createInstance('reuse-only')
      expect(manager.createForSession('sess-nodock')).toBe('reuse-only')
    })
  })

  describe('annotation mode', () => {
    it('injects the picker and reports mode on the instance', async () => {
      manager.createInstance('anno-1')
      await manager.setAnnotationMode('anno-1', true)

      const instance = (manager as any).instances.get('anno-1')
      expect(instance.annotationMode).toBe(true)
      const injected = instance.pageView.webContents.executeJavaScript.mock.calls
        .map((args: [string]) => String(args[0]))
      expect(injected.some((src: string) => src.includes('__bitlabAnnotate'))).toBe(true)
    })

    it('disables the picker without tearing down the page', async () => {
      manager.createInstance('anno-off')
      await manager.setAnnotationMode('anno-off', true)
      await manager.setAnnotationMode('anno-off', false)

      const instance = (manager as any).instances.get('anno-off')
      expect(instance.annotationMode).toBe(false)
      const calls = instance.pageView.webContents.executeJavaScript.mock.calls
        .map((args: [string]) => String(args[0]))
      expect(calls.some((src: string) => src.includes('disable()'))).toBe(true)
    })

    it('re-injects after navigation, because a load wipes the picker', async () => {
      manager.createInstance('anno-nav')
      await manager.setAnnotationMode('anno-nav', true)
      const instance = (manager as any).instances.get('anno-nav')
      const before = instance.pageView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-navigate', 'https://example.com/next')
      await Bun.sleep(0)

      expect(instance.pageView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(before)
    })

    it('captures a pick as a screenshot and reports it', async () => {
      const picks: any[] = []
      manager.onAnnotationPicked((payload) => picks.push(payload))
      manager.createInstance('anno-pick')
      const instance = (manager as any).instances.get('anno-pick')

      instance.pageView.webContents._emit(
        'console-message',
        1,
        '__bitlab_annotation__:' + JSON.stringify({ x: 10, y: 20, width: 100, height: 40, label: 'button.cta Get started' }),
      )
      await Bun.sleep(10)

      expect(picks).toHaveLength(1)
      expect(picks[0].instanceId).toBe('anno-pick')
      expect(picks[0].label).toBe('button.cta Get started')
      expect(picks[0].mimeType).toBe('image/png')
      expect(picks[0].imageBase64.length).toBeGreaterThan(0)
    })

    it('sanitizes a hostile element label — it becomes a filename', async () => {
      const picks: any[] = []
      manager.onAnnotationPicked((payload) => picks.push(payload))
      manager.createInstance('anno-evil')
      const instance = (manager as any).instances.get('anno-evil')

      instance.pageView.webContents._emit(
        'console-message',
        1,
        '__bitlab_annotation__:' + JSON.stringify({
          x: 0, y: 0, width: 10, height: 10,
          label: '../../etc/passwd\u0000; rm -rf /',
        }),
      )
      await Bun.sleep(10)

      expect(picks[0].label).not.toContain('/')
      expect(picks[0].label).not.toContain('..')
      expect(picks[0].label).not.toContain(';')
    })

    it('ignores a malformed annotation signal', async () => {
      const picks: any[] = []
      manager.onAnnotationPicked((payload) => picks.push(payload))
      manager.createInstance('anno-bad')
      const instance = (manager as any).instances.get('anno-bad')

      instance.pageView.webContents._emit('console-message', 1, '__bitlab_annotation__:not-json')
      await Bun.sleep(10)

      expect(picks).toHaveLength(0)
      // And it must not be logged as page console noise either.
      expect(manager.getConsoleLogs('anno-bad', { level: 'all', limit: 10 })).toHaveLength(0)
    })
  })

  describe('agent control overlay', () => {
    /**
     * The input shield only paints once the tab is attached to a dock and its
     * overlay page has loaded — a background tab has no view to shield.
     */
    function dockedWithShield(instanceId: string, sessionId: string) {
      manager.createInstance(instanceId)
      manager.bindSession(instanceId, sessionId)
      const host = attachDock(instanceId)
      const instance = (manager as any).instances.get(instanceId)
      instance.nativeOverlayReady = true
      return { instance, host }
    }

    it('setAgentControl activates the input shield on the bound instance', async () => {
      const { instance } = dockedWithShield('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      expect(instance.nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect(manager.listInstances().find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    it('covers the page rect with the shield while control is active', async () => {
      const { instance } = dockedWithShield('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this tab',
      })
      await Promise.resolve()

      // The shield tracks the page view exactly — same rect, painted above it.
      expect(instance.nativeOverlayView.setBounds).toHaveBeenLastCalledWith(instance.pageView.getBounds())
      expect(instance.nativeOverlayView.setVisible).toHaveBeenLastCalledWith(true)
      expect(manager.listInstances().find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      manager.bindSession('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies the shield after did-stop-loading while control is active', async () => {
      dockedWithShield('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies the input shield when the tab is reattached to the dock', async () => {
      manager.createInstance('ac-show-reapply')
      manager.bindSession('ac-show-reapply', 'sess-show-reapply')

      const host = attachDock('ac-show-reapply')
      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      instance.nativeOverlayReady = true
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      attachDock(null, { host, visible: false, bounds: null })
      attachDock('ac-show-reapply', { host })
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      dockedWithShield('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      // The label rides the DTO now — the banner that renders it is React.
      expect(manager.listInstances().find(i => i.id === 'ac-2')?.agentControlLabel)
        .toBe('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      dockedWithShield('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      expect(manager.listInstances().find(i => i.id === 'ac-3')?.agentControlLabel)
        .toBe('Agent is working…')
    })

    it('clearAgentControl hides the shield', () => {
      const { instance } = dockedWithShield('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setVisible).toHaveBeenLastCalledWith(false)
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      manager.bindSession('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      const { instance } = dockedWithShield('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setVisible).toHaveBeenLastCalledWith(false)
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      manager.bindSession('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })
})
