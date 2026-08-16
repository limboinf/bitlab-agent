import { existsSync, mkdirSync, readFileSync, readdirSync, watch, type FSWatcher } from 'node:fs';
import { basename, join } from 'node:path';
import { platform } from 'node:os';
import { getAppPermissionsDir, permissionsConfigCache } from '../agent/permissions-config.ts';
import { readSessionHeader } from '../sessions/jsonl.ts';
import type { SessionHeader } from '../sessions/types.ts';
import {
  downloadSkillIcon,
  invalidateSkillsCache,
  loadSkill,
  skillNeedsIconDownload,
} from '../skills/storage.ts';
import type { LoadedSkill } from '../skills/types.ts';
import { expandPath } from '../utils/paths.ts';
import { CONFIG_DIR } from './paths.ts';
import {
  getAppThemesDir,
  loadAppTheme,
  loadPresetTheme,
  loadPresetThemes,
  loadStoredConfig,
  type LlmConnection,
  type StoredConfig,
} from './storage.ts';
import type { PresetTheme, ThemeOverrides } from './theme.ts';
import {
  validateConfig,
  validatePreferences,
  type ValidationResult,
} from './validators.ts';

export interface UserPreferences {
  name?: string;
  timezone?: string;
  location?: { city?: string; region?: string; country?: string };
  notes?: string;
  uiLanguage?: string;
  updatedAt?: number;
}

export interface ConfigWatcherCallbacks {
  onConfigChange?: (config: StoredConfig) => void;
  onPreferencesChange?: (preferences: UserPreferences) => void;
  onLlmConnectionsChange?: (connections: LlmConnection[]) => void;
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
  /** Something in the skills tree changed. Consumers re-read the catalog. */
  onSkillsListChange?: () => void;
  onDefaultPermissionsChange?: () => void;
  onWorkspacePermissionsChange?: () => void;
  onSessionMetadataChange?: (sessionId: string, header: SessionHeader) => void;
  onAppThemeChange?: (theme: ThemeOverrides | null) => void;
  onPresetThemesListChange?: (themes: PresetTheme[]) => void;
  onPresetThemeChange?: (id: string, theme: PresetTheme | null) => void;
  onValidationError?: (file: string, result: ValidationResult) => void;
  onError?: (file: string, error: Error) => void;
}

const activeWatchers = new Map<string, string>();
const DEBOUNCE_MS = 100;
const SESSION_META_DEBOUNCE_MS = platform() === 'win32' ? 300 : DEBOUNCE_MS;

export function _getActiveWatchers(): ReadonlyMap<string, string> {
  return activeWatchers;
}

export function loadPreferences(): UserPreferences | null {
  const path = join(CONFIG_DIR, 'preferences.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as UserPreferences;
  } catch {
    return null;
  }
}

export class ConfigWatcher {
  private watchers: FSWatcher[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly workspaceDataRoot: string;
  private isRunning = false;
  private ownsRegistration = false;
  private knownThemes = new Set<string>();
  private lastLlmConnectionsHash = '';

  /**
   * Skill directories outside the workspace — the project and global tiers.
   * Without them a skill edited in either tier would leave the UI and the live
   * session disagreeing until the cache TTL expired.
   */
  private readonly extraSkillRoots: string[];

  constructor(
    workspaceDataRoot: string,
    private callbacks: ConfigWatcherCallbacks,
    options?: { skillRoots?: string[] }
  ) {
    this.workspaceDataRoot = expandPath(workspaceDataRoot);
    this.extraSkillRoots = (options?.skillRoots ?? []).map(root => expandPath(root));
  }

  start(): void {
    if (this.isRunning) return;
    if (activeWatchers.has(this.workspaceDataRoot)) return;

    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(this.workspaceDataRoot, { recursive: true });
    mkdirSync(getAppThemesDir(), { recursive: true });
    mkdirSync(getAppPermissionsDir(), { recursive: true });

    activeWatchers.set(this.workspaceDataRoot, basename(this.workspaceDataRoot));
    this.ownsRegistration = true;
    this.isRunning = true;

    this.watchPath(CONFIG_DIR, false, (_event, filename) => this.handleAppChange(filename));
    this.watchPath(this.workspaceDataRoot, true, (_event, filename) => this.handleWorkspaceChange(filename));
    this.watchPath(getAppThemesDir(), false, (_event, filename) => {
      if (filename.endsWith('.json')) this.handlePresetThemeChange(basename(filename, '.json'));
    });
    this.watchPath(getAppPermissionsDir(), false, (_event, filename) => {
      if (filename === 'default.json') this.handleDefaultPermissionsChange();
    });
    for (const root of this.extraSkillRoots) {
      this.watchPath(root, true, () => this.handleSkillTierChange());
    }

    this.scanPresetThemes();
    const config = loadStoredConfig();
    this.lastLlmConnectionsHash = JSON.stringify(config?.llmConnections ?? []);
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.ownsRegistration) activeWatchers.delete(this.workspaceDataRoot);
    this.ownsRegistration = false;
    this.isRunning = false;
    this.knownThemes.clear();
  }

  isWatching(): boolean {
    return this.isRunning;
  }

  updateCallbacks(callbacks: Partial<ConfigWatcherCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  notifyFileChange(relativePath: string): void {
    if (!this.isRunning) return;
    const normalized = relativePath.replaceAll('\\', '/');
    const delay = /^sessions\/[^/]+\/session\.jsonl$/.test(normalized)
      ? SESSION_META_DEBOUNCE_MS
      : DEBOUNCE_MS;
    this.debounce(`manual:${this.workspaceDataRoot}:${normalized}`, () => {
      this.handleWorkspaceChange(normalized);
    }, delay);
  }

  private watchPath(
    path: string,
    recursive: boolean,
    listener: (event: string, filename: string) => void
  ): void {
    if (!existsSync(path)) return;
    try {
      this.watchers.push(watch(path, { recursive }, (event, filename) => {
        if (!filename) return;
        const normalized = filename.replaceAll('\\', '/');
        const delay = recursive && /^sessions\/[^/]+\/session\.jsonl$/.test(normalized)
          ? SESSION_META_DEBOUNCE_MS
          : DEBOUNCE_MS;
        this.debounce(`${path}:${normalized}`, () => listener(event, normalized), delay);
      }));
    } catch (error) {
      this.callbacks.onError?.(path, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private debounce(key: string, callback: () => void, delay = DEBOUNCE_MS): void {
    const current = this.timers.get(key);
    if (current) clearTimeout(current);
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      callback();
    }, delay));
  }

  private handleAppChange(filename: string): void {
    if (filename === 'config.json') {
      const validation = validateConfig();
      if (!validation.valid) {
        this.callbacks.onValidationError?.('config.json', validation);
        return;
      }
      const config = loadStoredConfig();
      if (config) {
        this.callbacks.onConfigChange?.(config);
        const connections = config.llmConnections ?? [];
        const hash = JSON.stringify(connections);
        if (hash !== this.lastLlmConnectionsHash) {
          this.lastLlmConnectionsHash = hash;
          this.callbacks.onLlmConnectionsChange?.(connections);
        }
      } else {
        this.callbacks.onError?.('config.json', new Error('Failed to load config'));
      }
      return;
    }
    if (filename === 'preferences.json') {
      const validation = validatePreferences();
      if (!validation.valid) {
        this.callbacks.onValidationError?.('preferences.json', validation);
        return;
      }
      const preferences = loadPreferences();
      if (preferences) {
        this.callbacks.onPreferencesChange?.(preferences);
      } else if (existsSync(join(CONFIG_DIR, 'preferences.json'))) {
        this.callbacks.onError?.('preferences.json', new Error('Failed to load preferences'));
      }
      return;
    }
    if (filename === 'theme.json') {
      this.callbacks.onAppThemeChange?.(loadAppTheme());
      return;
    }
  }

  /** A skill changed in a tier outside the workspace. */
  private handleSkillTierChange(): void {
    invalidateSkillsCache();
    this.callbacks.onSkillsListChange?.();
  }

  private handleWorkspaceChange(filename: string): void {
    const normalized = filename.replaceAll('\\', '/');
    if (normalized === 'permissions.json') {
      permissionsConfigCache.invalidateWorkspace(this.workspaceDataRoot);
      this.callbacks.onWorkspacePermissionsChange?.();
      return;
    }
    // Enablement and trust live here rather than in the skill directories, so
    // a change to this file is just as much a catalog change as an edited
    // SKILL.md — and the UI has nothing else to learn about it from.
    if (normalized === 'skills.json') {
      this.handleSkillTierChange();
      return;
    }
    if (normalized.startsWith('skills/')) {
      const slug = normalized.split('/')[1];
      if (!slug) return;
      invalidateSkillsCache();
      const skill = loadSkill(this.workspaceDataRoot, slug);
      this.callbacks.onSkillChange?.(slug, skill);
      this.callbacks.onSkillsListChange?.();
      if (skill && skillNeedsIconDownload(skill)) {
        void downloadSkillIcon(skill.path, skill.metadata.icon!)
          .then(iconPath => {
            if (!iconPath) return;
            invalidateSkillsCache();
            this.callbacks.onSkillChange?.(slug, loadSkill(this.workspaceDataRoot, slug));
          })
          .catch(error => {
            this.callbacks.onError?.(
              `skills/${slug}/icon`,
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
      return;
    }
    const sessionMatch = normalized.match(/^sessions\/([^/]+)\/session\.jsonl$/);
    if (sessionMatch?.[1]) {
      const header = readSessionHeader(join(this.workspaceDataRoot, normalized));
      if (header) this.callbacks.onSessionMetadataChange?.(sessionMatch[1], header);
    }
  }

  private scanPresetThemes(): void {
    try {
      for (const file of readdirSync(getAppThemesDir())) {
        if (file.endsWith('.json')) this.knownThemes.add(basename(file, '.json'));
      }
    } catch (error) {
      this.callbacks.onError?.(
        getAppThemesDir(),
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private handlePresetThemeChange(id: string): void {
    const path = join(getAppThemesDir(), `${id}.json`);
    if (!existsSync(path)) {
      if (!this.knownThemes.has(id)) return;
      this.knownThemes.delete(id);
      this.callbacks.onPresetThemeChange?.(id, null);
      this.callbacks.onPresetThemesListChange?.(loadPresetThemes());
      return;
    }

    this.knownThemes.add(id);
    this.callbacks.onPresetThemeChange?.(id, loadPresetTheme(id));
    this.callbacks.onPresetThemesListChange?.(loadPresetThemes());
  }

  private handleDefaultPermissionsChange(): void {
    permissionsConfigCache.invalidateDefaults();
    this.callbacks.onDefaultPermissionsChange?.();
  }
}

export function createConfigWatcher(
  workspaceDataRoot: string,
  callbacks: ConfigWatcherCallbacks,
  options?: { skillRoots?: string[] }
): ConfigWatcher {
  const watcher = new ConfigWatcher(workspaceDataRoot, callbacks, options);
  watcher.start();
  return watcher;
}
