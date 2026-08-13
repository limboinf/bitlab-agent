/**
 * Workspace and authentication types
 */

/**
 * Client-facing workspace DTO.
 *
 * `folderPath` is the user-selected project folder and may be returned to a
 * local Electron client. The Bitlab-owned `dataRoot` is intentionally kept
 * off this DTO and is only present on the server-side `Workspace` type.
 */
export interface WorkspaceInfo {
  id: string;
  name: string;
  slug: string;
  kind: 'default' | 'folder';
  /** The user-visible project folder. Null only for the built-in default workspace. */
  folderPath: string | null;
  lastAccessedAt?: number;
  iconUrl?: string;
}

/**
 * Full workspace with server-internal details.
 * Used by server code and local Electron renderer (LOCAL_ONLY channels).
 */
export interface Workspace extends WorkspaceInfo {
  /** Bitlab-owned storage. Derived from slug and never persisted in global config. */
  dataRoot: string;
  createdAt: number;
}

/** Workspace record persisted in the global registry. */
export type StoredWorkspace = Omit<Workspace, 'dataRoot'>;

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  workspaces: StoredWorkspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  model?: string;
}
