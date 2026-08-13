/**
 * Workspace Storage
 *
 * CRUD operations for workspaces.
 * User project folders are registered here, while Bitlab-owned data stays
 * under ~/.bitlab/workspaces/<slug>/.
 * The folder path and the data root are deliberately separate concepts.
 */

import {
  existsSync,
  mkdirSync,
} from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { loadConfigDefaults } from '../config/storage.ts';
import {
  parsePermissionMode,
  DEFAULT_CYCLABLE_PERMISSION_MODES,
  isLegacyCyclableDefault,
  resolveStartingPermissionMode,
} from '../agent/mode-types.ts';
import { normalizeThinkingLevel } from '../agent/thinking-levels.ts';
import { CONFIG_DIR } from '../config/paths.ts';
import type {
  WorkspaceConfig,
} from './types.ts';

const DEFAULT_WORKSPACES_DIR = join(CONFIG_DIR, 'workspaces');
export const DEFAULT_WORKSPACE_SLUG = 'default';

// ============================================================
// Path Utilities
// ============================================================

/**
 * Get the default workspaces directory (~/.bitlab/workspaces/)
 */
export function getDefaultWorkspacesDir(): string {
  return DEFAULT_WORKSPACES_DIR;
}

/**
 * Ensure default workspaces directory exists
 */
export function ensureDefaultWorkspacesDir(): void {
  if (!existsSync(DEFAULT_WORKSPACES_DIR)) {
    mkdirSync(DEFAULT_WORKSPACES_DIR, { recursive: true });
  }
}

/** Ensure the local default workspace exists and return its configuration. */
export function ensureDefaultWorkspace(): WorkspaceConfig {
  ensureDefaultWorkspacesDir();
  const rootPath = join(DEFAULT_WORKSPACES_DIR, DEFAULT_WORKSPACE_SLUG);
  const existing = loadWorkspaceConfig(rootPath);
  if (existing) return existing;
  return createWorkspaceAtPath(rootPath, 'Default', undefined, { id: 'default', slug: 'default' });
}

/** Resolve the Bitlab-owned data directory for a stable workspace slug. */
export function getWorkspaceDataRoot(slug: string): string {
  return join(DEFAULT_WORKSPACES_DIR, slug);
}

/**
 * Get path to workspace sessions directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSessionsPath(rootPath: string): string {
  return join(rootPath, 'sessions');
}

/**
 * Get path to workspace skills directory
 * @param rootPath - Absolute path to workspace root folder
 */
export function getWorkspaceSkillsPath(rootPath: string): string {
  return join(rootPath, 'skills');
}

// ============================================================
// Config Operations
// ============================================================

/**
 * Load workspace config.json from a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function loadWorkspaceConfig(rootPath: string): WorkspaceConfig | null {
  const configPath = join(rootPath, 'config.json');
  if (!existsSync(configPath)) return null;

  try {
    const config = readJsonFileSync<WorkspaceConfig>(configPath);

    // Compatibility: accept canonical or legacy permission mode names on read
    if (config.defaults?.permissionMode && typeof config.defaults.permissionMode === 'string') {
      const parsed = parsePermissionMode(config.defaults.permissionMode);
      config.defaults.permissionMode = parsed ?? undefined;
    }

    if (Array.isArray(config.defaults?.cyclablePermissionModes)) {
      const normalized = config.defaults.cyclablePermissionModes
        .map(mode => (typeof mode === 'string' ? parsePermissionMode(mode) : null))
        .filter((mode): mode is NonNullable<typeof mode> => !!mode)
        .filter((mode, index, arr) => arr.indexOf(mode) === index);

      // Collapse an untouched legacy default to the two-state UI.
      // An explicitly customized list is left alone.
      config.defaults.cyclablePermissionModes = normalized.length >= 2 && !isLegacyCyclableDefault(normalized)
        ? normalized
        : [...DEFAULT_CYCLABLE_PERMISSION_MODES];
    }

    if (config.defaults) {
      config.defaults.permissionMode = resolveStartingPermissionMode(
        config.defaults.permissionMode,
        config.defaults.cyclablePermissionModes ?? DEFAULT_CYCLABLE_PERMISSION_MODES,
      );
    }

    if (config.defaults && 'thinkingLevel' in config.defaults) {
      // TODO: Remove legacy 'think' normalization after old persisted workspace configs
      // have realistically aged out across upgrades.
      config.defaults.thinkingLevel = normalizeThinkingLevel(config.defaults.thinkingLevel);
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Save workspace config.json to a workspace folder
 * @param rootPath - Absolute path to workspace root folder
 */
export function saveWorkspaceConfig(rootPath: string, config: WorkspaceConfig): void {
  if (!existsSync(rootPath)) {
    mkdirSync(rootPath, { recursive: true });
  }

  // Convert paths to portable form for cross-machine compatibility
  const storageConfig: WorkspaceConfig = {
    ...config,
    updatedAt: Date.now(),
  };

  // Use atomic write to prevent corruption on crash/interrupt
  atomicWriteFileSync(join(rootPath, 'config.json'), JSON.stringify(storageConfig, null, 2));
}

// ============================================================
// Create/Delete Operations
// ============================================================

/**
 * Generate URL-safe slug from name
 */
export function generateSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 50);

  if (!slug) {
    slug = 'workspace';
  }

  return slug;
}

/**
 * Create workspace folder structure at a given path
 * @param rootPath - Absolute path where workspace folder will be created
 * @param name - Display name for the workspace
 * @param defaults - Optional default settings for new sessions
 * @returns The created WorkspaceConfig
 */
export function createWorkspaceAtPath(
  rootPath: string,
  name: string,
  defaults?: WorkspaceConfig['defaults'],
  identity?: Pick<WorkspaceConfig, 'id' | 'slug'>,
): WorkspaceConfig {
  const now = Date.now();
  const slug = generateSlug(name);

  // Load global defaults from config-defaults.json
  let globalDefaults: ReturnType<typeof loadConfigDefaults>;
  try {
    globalDefaults = loadConfigDefaults();
  } catch {
    // Headless and CLI entrypoints may create the default workspace before
    // bundled assets have been synchronized.
    globalDefaults = {
      version: '1.0',
      description: 'Fallback defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        autoCapitalisation: true,
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
        extendedPromptCache: false,
        browserToolEnabled: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'medium',
        permissionMode: 'ask',
        cyclablePermissionModes: [...DEFAULT_CYCLABLE_PERMISSION_MODES],
      },
    };
  }

  // Merge global defaults with provided defaults
  // AI settings (model, thinkingLevel, defaultLlmConnection) are left undefined
  // so they fall back to app-level defaults
  const workspaceDefaults: WorkspaceConfig['defaults'] = {
    model: undefined,
    thinkingLevel: undefined,
    // defaultLlmConnection: undefined - falls back to app default
    permissionMode: globalDefaults.workspaceDefaults.permissionMode,
    cyclablePermissionModes: globalDefaults.workspaceDefaults.cyclablePermissionModes,
    ...defaults, // User-provided defaults override global defaults
  };

  const config: WorkspaceConfig = {
    id: identity?.id ?? `ws_${randomUUID().slice(0, 8)}`,
    name,
    slug: identity?.slug ?? slug,
    defaults: workspaceDefaults,
    createdAt: now,
    updatedAt: now,
  };

  // Create workspace directory structure
  mkdirSync(rootPath, { recursive: true });
  mkdirSync(getWorkspaceSessionsPath(rootPath), { recursive: true });
  mkdirSync(getWorkspaceSkillsPath(rootPath), { recursive: true });

  // Save config
  saveWorkspaceConfig(rootPath, config);

  return config;
}

/**
 * Check if a valid workspace exists at a path
 * @param rootPath - Absolute path to check
 */
export function isValidWorkspace(rootPath: string): boolean {
  return existsSync(join(rootPath, 'config.json'));
}

// ============================================================
// Workspace Color Theme
// ============================================================

/**
 * Get the color theme setting for a workspace.
 * Returns undefined if workspace uses the app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @returns Theme ID or undefined (inherit from app default)
 */
export function getWorkspaceColorTheme(rootPath: string): string | undefined {
  const config = loadWorkspaceConfig(rootPath);
  return config?.defaults?.colorTheme;
}

/**
 * Set the color theme for a workspace.
 * Pass undefined to clear and use app default.
 *
 * @param rootPath - Absolute path to workspace root folder
 * @param themeId - Preset theme ID or undefined to inherit
 */
export function setWorkspaceColorTheme(rootPath: string, themeId: string | undefined): void {
  const config = loadWorkspaceConfig(rootPath);
  if (!config) return;

  // Validate theme ID if provided (skip for undefined = inherit default)
  // Only allow alphanumeric characters, hyphens, and underscores (max 64 chars)
  if (themeId && themeId !== 'default') {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(themeId)) {
      console.warn(`[workspace-storage] Invalid theme ID rejected: ${themeId}`);
      return;
    }
  }

  // Initialize defaults if not present
  if (!config.defaults) {
    config.defaults = {};
  }

  if (themeId) {
    config.defaults.colorTheme = themeId;
  } else {
    delete config.defaults.colorTheme;
  }

  saveWorkspaceConfig(rootPath, config);
}

// ============================================================
// Exports
// ============================================================

export { CONFIG_DIR, DEFAULT_WORKSPACES_DIR };
