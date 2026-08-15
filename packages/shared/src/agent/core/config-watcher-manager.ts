import {
  ConfigWatcher,
  createConfigWatcher,
  type ConfigWatcherCallbacks,
} from '../../config/watcher.ts';
import type { LoadedSkill } from '../../skills/types.ts';
import { debug } from '../../utils/debug.ts';

export interface ConfigWatcherManagerCallbacks {
  onSkillChange?: (slug: string, skill: LoadedSkill | null) => void;
  onSkillsListChange?: () => void;
  onWorkspacePermissionsChange?: () => void;
  onDefaultPermissionsChange?: () => void;
  onValidationError?: (file: string, errors: string[]) => void;
}

export interface ConfigWatcherManagerConfig {
  workspaceDataRoot: string;
  isHeadless?: boolean;
  onDebug?: (message: string) => void;
  /** Skill tiers outside the workspace (project, global) to watch as well. */
  skillRoots?: string[];
}

export class ConfigWatcherManager {
  private watcher: ConfigWatcher | null = null;
  private readonly workspaceDataRoot: string;
  private readonly isHeadless: boolean;
  private callbacks: ConfigWatcherManagerCallbacks;
  private readonly onDebugCallback: ((message: string) => void) | null;
  private readonly skillRoots: string[];

  constructor(config: ConfigWatcherManagerConfig, callbacks: ConfigWatcherManagerCallbacks = {}) {
    this.workspaceDataRoot = config.workspaceDataRoot;
    this.isHeadless = config.isHeadless ?? false;
    this.callbacks = callbacks;
    this.onDebugCallback = config.onDebug ?? null;
    this.skillRoots = config.skillRoots ?? [];
  }

  start(): void {
    if (this.watcher) return;
    if (this.isHeadless) {
      this.log('Config watching disabled in headless mode');
      return;
    }

    const watcherCallbacks: ConfigWatcherCallbacks = {
      onSkillChange: (slug, skill) => {
        this.log(`Skill changed: ${slug} ${skill ? 'updated' : 'deleted'}`);
        this.callbacks.onSkillChange?.(slug, skill);
      },
      onSkillsListChange: () => {
        this.log('Skills list changed');
        this.callbacks.onSkillsListChange?.();
      },
      onWorkspacePermissionsChange: () => {
        this.log('Workspace permissions changed');
        this.callbacks.onWorkspacePermissionsChange?.();
      },
      onDefaultPermissionsChange: () => {
        this.log('Default permissions changed');
        this.callbacks.onDefaultPermissionsChange?.();
      },
      onValidationError: (file, result) => {
        const errors = result.errors.map(error =>
          `${error.path ? `${error.path}: ` : ''}${error.message}`
        );
        this.log(`Config validation error: ${file} - ${errors.join(', ')}`);
        this.callbacks.onValidationError?.(file, errors);
      },
    };

    const watcher = createConfigWatcher(this.workspaceDataRoot, watcherCallbacks, {
      skillRoots: this.skillRoots,
    });
    if (!watcher.isWatching()) {
      this.log('Config watcher already owned by another manager');
      return;
    }
    this.watcher = watcher;
    this.log('Config watcher started');
  }

  stop(): void {
    if (!this.watcher) return;
    this.watcher.stop();
    this.watcher = null;
    this.log('Config watcher stopped');
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }

  updateCallbacks(callbacks: Partial<ConfigWatcherManagerCallbacks>): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  private log(message: string): void {
    const formatted = `[ConfigWatcherManager] ${message}`;
    this.onDebugCallback?.(formatted);
    debug(formatted);
  }
}

export function createConfigWatcherManager(
  config: ConfigWatcherManagerConfig,
  callbacks: ConfigWatcherManagerCallbacks = {},
  autoStart = true
): ConfigWatcherManager {
  const manager = new ConfigWatcherManager(config, callbacks);
  if (autoStart) manager.start();
  return manager;
}
