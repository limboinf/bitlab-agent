import { writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from '@bitlab/shared/config'
import { readJsonFileSync } from '@bitlab/shared/utils/files'
import { mainLog } from './logger'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindow {
  type: 'main'
  workspaceId: string
  bounds: WindowBounds
  focused?: boolean
  // Full URL captured from webContents.getURL() at quit time.
  // May be localhost (dev) or file:// (prod) — both are safe to store because
  // createWindow() never loads this URL directly. It extracts query params
  // (workspaceId, route, focused, etc.) and rebuilds the URL from __dirname
  // (prod) or the current dev server (dev). See window-manager.ts restoreUrl.
  url?: string
}

export interface WindowState {
  windows: SavedWindow[]
  lastFocusedWorkspaceId?: string
}

const WINDOW_STATE_FILE = join(CONFIG_DIR, 'window-state.json')

/**
 * Save the current window state (windows with bounds and type)
 */
export function saveWindowState(state: WindowState): void {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }

    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
    mainLog.info('[WindowState] Saved window state:', state.windows.length, 'windows')
  } catch (error) {
    mainLog.error('[WindowState] Failed to save window state:', error)
  }
}

/**
 * Load the saved window state
 */
export function loadWindowState(): WindowState | null {
  try {
    if (!existsSync(WINDOW_STATE_FILE)) {
      return null
    }

    const raw = readJsonFileSync(WINDOW_STATE_FILE)

    // Validate format
    const state = raw as WindowState
    if (!Array.isArray(state.windows)) {
      mainLog.warn('[WindowState] Invalid window state file, ignoring')
      return null
    }

    mainLog.info('[WindowState] Loaded window state:', state.windows.length, 'windows')
    return state
  } catch (error) {
    mainLog.error('[WindowState] Failed to load window state:', error)
    return null
  }
}

/**
 * Clear the saved window state
 */
export function clearWindowState(): void {
  try {
    if (existsSync(WINDOW_STATE_FILE)) {
      writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ windows: [] }, null, 2), 'utf-8')
      mainLog.info('[WindowState] Cleared window state')
    }
  } catch (error) {
    mainLog.error('[WindowState] Failed to clear window state:', error)
  }
}

/**
 * Remember which workspace the user was last in, so the next launch reopens it
 * instead of falling back to the first (default) workspace.
 *
 * Called on window creation, in-window workspace switches, and window focus —
 * all low-frequency events. Writes are skipped when the value is unchanged.
 */
let lastRememberedWorkspaceId: string | null = null

export function rememberLastWorkspaceId(workspaceId: string): void {
  if (!workspaceId || workspaceId === lastRememberedWorkspaceId) return
  lastRememberedWorkspaceId = workspaceId
  try {
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true })
    }
    const existing = loadWindowState()
    const next: WindowState = {
      windows: existing?.windows ?? [],
      lastFocusedWorkspaceId: workspaceId,
    }
    writeFileSync(WINDOW_STATE_FILE, JSON.stringify(next, null, 2), 'utf-8')
  } catch (error) {
    mainLog.error('[WindowState] Failed to remember last workspace:', error)
  }
}

/**
 * The workspace the user was last in, or null when nothing was recorded yet.
 * Callers must verify the workspace still exists before using it.
 */
export function getLastWorkspaceId(): string | null {
  try {
    if (!existsSync(WINDOW_STATE_FILE)) return null
    const raw = readJsonFileSync(WINDOW_STATE_FILE) as WindowState | null
    const id = raw?.lastFocusedWorkspaceId
    return typeof id === 'string' && id ? id : null
  } catch (error) {
    mainLog.error('[WindowState] Failed to read last workspace:', error)
    return null
  }
}
