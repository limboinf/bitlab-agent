/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Sessions and Skills
 * is scoped to a workspace.
 *
 * Directory structure:
 * ~/.bitlab/workspaces/{slug}/
 *   ├── config.json      - Workspace settings
 *   ├── sessions/        - Conversation sessions
 *   └── skills/          - Workspace Skills
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';

/**
 * Workspace configuration (stored in config.json)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string; // Folder name (URL-safe)

  /**
   * Default settings for new sessions in this workspace
   */
  defaults?: {
    model?: string;
    /** Default LLM connection for new sessions (slug). Overrides global default. */
    defaultLlmConnection?: string;
    permissionMode?: PermissionMode; // Default permission mode ('safe', 'ask', 'allow-all')
    cyclablePermissionModes?: PermissionMode[]; // Which modes can be cycled with SHIFT+TAB (min 2, default: all 3)
    thinkingLevel?: ThinkingLevel; // Default thinking level for new sessions (default: 'medium')
    colorTheme?: string; // Color theme override for this workspace (preset ID). Undefined = inherit from app default.
  };

  createdAt: number;
  updatedAt: number;
}
