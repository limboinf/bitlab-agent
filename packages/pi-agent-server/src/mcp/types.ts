/**
 * MCP wire-protocol types for the pi-agent-server subprocess.
 *
 * These mirror @bitlab/shared's `AdapterMcpConfig` / `McpStatusSnapshotDto` /
 * `McpApprovalRequestDto` (packages/shared/src/config/mcp.ts) field-for-field,
 * but are re-declared here because this package is deliberately
 * dependency-isolated from @bitlab/shared (see the SearchConfig precedent in
 * src/tools/search/types.ts). Field names are the wire contract — DO NOT
 * rename. Compatibility with pi-mcp-adapter's real `McpConfig` /
 * `McpStatusSnapshot` shapes is asserted at the type level at the bottom of
 * this file, so `bun run typecheck` fails if either side drifts.
 */

// Real adapter types — available in-process (unlike in @bitlab/shared).
// NOTE: imported from the './types' subpath, NOT the package root: the root
// index.ts pulls the adapter's full runtime source (incl. npx-resolver.ts,
// which does not satisfy our strict noImplicitAny) into the tsc program.
// The './types' module is type-only + tiny leaf consts, so it typechecks clean.
import type {
  McpConfig as VendorMcpConfig,
  McpStatusSnapshot as VendorMcpStatusSnapshot,
  McpToolApprovalRequest as VendorMcpToolApprovalRequest,
} from 'pi-mcp-adapter/types';

// ============================================================
// Adapter config (inbound: `init.mcpConfig` and `update_mcp_config`)
// ============================================================

export type McpLifecycle = 'lazy' | 'lazy-keep-alive' | 'eager' | 'keep-alive';

export interface AdapterMcpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  lifecycle?: McpLifecycle;
  directTools?: boolean;
  includeTools?: string[];
  excludeTools?: string[];
  approveTools?: boolean | string[];
}

export interface AdapterMcpConfig {
  mcpServers: Record<string, AdapterMcpServerEntry>;
  settings?: {
    toolPrefix?: 'server' | 'none' | 'short' | 'mcp';
    directTools?: boolean;
    scriptMode?: boolean;
    hostConfigDiscovery?: 'off' | 'prompt' | 'on';
    notifyOnStartupConnect?: boolean;
    showStatusIcon?: boolean;
  };
}

// ============================================================
// Status snapshots (outbound: `mcp_status`)
// ============================================================

export type McpServerRuntimeStatus =
  | 'connected'
  | 'cached'
  | 'failed'
  | 'needs-auth'
  | 'not-connected'
  | 'disabled';

export interface McpServerStatusSnapshot {
  name: string;
  status: McpServerRuntimeStatus;
  toolCount: number;
  resourceCount?: number;
  failedAgoSeconds?: number;
  disabled: boolean;
}

export interface McpStatusSnapshot {
  version: number;
  /** Readonly to mirror the adapter's published snapshot exactly. */
  servers: readonly McpServerStatusSnapshot[];
  totalTools: number;
  totalResources: number;
  connectedCount: number;
  disabledCount: number;
}

// ============================================================
// Tool approval handshake (outbound: `mcp_approval_request`,
// inbound: `mcp_approval_response`)
// ============================================================

/** Subset of pi-mcp-adapter's McpToolApprovalDecision exposed on the wire. */
export type McpApprovalDecision = 'allow_once' | 'allow_for_session' | 'deny';

export interface McpApprovalRequestPayload {
  requestId: string;
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
}

// ============================================================
// Compile-time compatibility guards against pi-mcp-adapter
// ============================================================
// The assignments below fail `bun run typecheck` the moment either side
// drifts; the casts never produce a real value (they stay null at runtime).

/** Our wire config must be assignable to the adapter's programmatic McpConfig. */
const _configGuard: VendorMcpConfig = null as unknown as AdapterMcpConfig;
void _configGuard;

/** The adapter's published snapshot must be forwardable verbatim on the wire. */
const _statusGuard: McpStatusSnapshot = null as unknown as VendorMcpStatusSnapshot;
void _statusGuard;

/** Our approval payload must be a structural subset of the adapter request. */
const _approvalGuard: Omit<VendorMcpToolApprovalRequest, 'origin' | 'claim' | 'signal'> =
  null as unknown as McpApprovalRequestPayload;
void _approvalGuard;
