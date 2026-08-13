/**
 * @bitlab/shared
 *
 * Shared business logic for Bitlab.
 * Used by the Electron app.
 *
 * Import specific modules via subpath exports:
 *   import { PiAgent } from '@bitlab/shared/agent';
 *   import { loadStoredConfig } from '@bitlab/shared/config';
 *   import { getCredentialManager } from '@bitlab/shared/credentials';
 *   import { debug } from '@bitlab/shared/utils';
 *   import { createWorkspace, loadWorkspace } from '@bitlab/shared/workspaces';
 *
 * Available modules:
 *   - agent: Pi agent runtime and plan tools
 *   - config: Storage, models, preferences
 *   - credentials: Encrypted credential storage
 *   - prompts: System prompt generation
 *   - utils: Debug logging, file handling, summarization
 *   - version: Version and installation management
 *   - workspaces: Workspace management (top-level organizational unit)
 */

// Export branding (standalone, no dependencies)
export * from './branding.ts';
