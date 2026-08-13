/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @bitlab/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
} from '@bitlab/core/types';

/** App-level network proxy configuration. */
export interface NetworkProxySettings {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}
