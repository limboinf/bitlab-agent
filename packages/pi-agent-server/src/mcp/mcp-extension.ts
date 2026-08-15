/**
 * MCP adapter + host extension for the pi-agent-server subprocess.
 *
 * The pi-mcp-adapter package is a Pi *extension*: `createMcpAdapter({config})`
 * returns `function (pi: ExtensionAPI)` which must run INSIDE the agent
 * session. We inject it (plus a small "host" bridge extension) through a
 * custom ResourceLoader (see resource-loader.ts) so the adapter shares the
 * session's tool registry, extension runner, and shared event bus.
 *
 * The main process owns MCP configuration (Bitlab config.json) and pushes a
 * programmatic snapshot over the wire. The adapter never reads ambient config
 * files: `createMcpAdapter({ config })` with a programmatic config is fully
 * isolated (it also clones the config internally, so hot-updates must build a
 * FRESH adapter instance — hence the module-level `currentMcpConfig` that the
 * loader's inline factory reads at each reload).
 */

// Event channel constants + types come from the './types' subpath (type-only
// closure, safe under strict tsc). `createMcpAdapter` itself lives only in the
// package root, whose full runtime source (incl. npx-resolver.ts with implicit
// anys) must stay OUT of the tsc program — hence the non-literal dynamic
// import below (a variable specifier defeats static module resolution). Bun
// resolves it normally at runtime.
import { MCP_STATUS_EVENT, MCP_TOOL_APPROVAL_REQUEST_EVENT } from 'pi-mcp-adapter/types';
import type {
  McpToolApprovalDecision,
  McpToolApprovalRequest,
  McpStatusSnapshot,
} from 'pi-mcp-adapter/types';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import type {
  AdapterMcpConfig,
  McpApprovalDecision,
  McpApprovalRequestPayload,
  McpStatusSnapshot as WireMcpStatusSnapshot,
} from './types.ts';

/** Minimal shape of the adapter factory we actually call. */
type CreateMcpAdapterFn = (options: { config: AdapterMcpConfig }) => (pi: ExtensionAPI) => void;

let createMcpAdapterFn: CreateMcpAdapterFn | null = null;

async function loadCreateMcpAdapter(): Promise<CreateMcpAdapterFn> {
  if (createMcpAdapterFn) return createMcpAdapterFn;
  // Non-literal specifier on purpose — see the import note above.
  const moduleId = 'pi-mcp-adapter';
  const mod = (await import(moduleId)) as { createMcpAdapter: CreateMcpAdapterFn };
  createMcpAdapterFn = mod.createMcpAdapter;
  return createMcpAdapterFn;
}

// ============================================================
// Current adapter config (module-level so hot reloads pick it up)
// ============================================================

let currentMcpConfig: AdapterMcpConfig | null = null;

/** True when the config declares at least one MCP server. */
export function hasMcpServers(config: AdapterMcpConfig | null | undefined): boolean {
  return !!config && Object.keys(config.mcpServers).length > 0;
}

/**
 * Store the config used by the NEXT adapter instance. The resource loader's
 * inline factory reads this every time the session (re)loads extensions, so
 * `session.reload()` after a `setCurrentMcpConfig()` swaps the MCP surface.
 */
export function setCurrentMcpConfig(config: AdapterMcpConfig | null): void {
  currentMcpConfig = config;
}

export function getCurrentMcpConfig(): AdapterMcpConfig | null {
  return currentMcpConfig;
}

// ============================================================
// Adapter extension
// ============================================================

/**
 * Build the adapter as an inline Pi extension.
 *
 * `createMcpAdapter({ config })` clones the config into its closure, so a
 * factory instance is an immutable snapshot — hot config updates need a FRESH
 * `createMcpAdapter` call. To make that work across `session.reload()`, the
 * factory below defers the `createMcpAdapter` call to INVOCATION time and
 * reads `currentMcpConfig` then (unless an explicit config is pinned here for
 * tests). With no servers configured it registers nothing — an empty program
 * config must NEVER fall back to `createMcpAdapter({})`, which would make the
 * adapter discover and load ambient MCP config files.
 */
export function buildAdapterExtension(
  config?: AdapterMcpConfig | null,
  onDebug?: (message: string) => void,
): InlineExtension {
  return {
    name: 'bitlab-mcp-adapter',
    factory: async (pi: ExtensionAPI) => {
      const effective = config !== undefined ? config : currentMcpConfig;
      if (!effective || Object.keys(effective.mcpServers).length === 0) {
        onDebug?.('MCP: adapter skipped — no servers configured');
        return;
      }
      onDebug?.(`MCP: adapter installing — ${describeAdapterConfig(effective)}`);
      // ExtensionFactory supports async — Pi awaits it during startup.
      const createMcpAdapter = await loadCreateMcpAdapter();
      createMcpAdapter({ config: effective })(pi);
    },
  };
}

// ============================================================
// Tool approval broker (host side)
// ============================================================

/**
 * How the adapter's approval handshake behaves (read from
 * node_modules/pi-mcp-adapter/tool-approval.ts):
 *
 * - The claim window is SYNCHRONOUS: the adapter emits
 *   MCP_TOOL_APPROVAL_REQUEST_EVENT and flips `acceptingClaim = false` the
 *   moment `emit()` returns. A listener must call `request.claim(handler)`
 *   inside the emit — there is no async window and no retry. `claim()` returns
 *   false when the window already closed or someone else claimed.
 * - UNCLAIMED requests make the broker "abstain" immediately. The adapter then
 *   falls back to its own policy: if the config's `approveTools` does not
 *   require approval the call proceeds; if approval IS required and there is
 *   no interactive UI (always true in this headless subprocess,
 *   `state.ui === undefined`) the tool call FAILS CLOSED with
 *   `{ ok: false, reason: 'approval_required_headless' }`.
 * - Once claimed, the adapter awaits the handler indefinitely — there is NO
 *   adapter-side timeout. Only `request.signal` aborts the wait (via
 *   `abortable`, which rethrows the abort reason). A handler that throws or
 *   returns an unknown value is treated as 'deny' (fail-closed).
 * - Decision strings are 'allow_once' | 'allow_for_session' | 'deny' |
 *   'abstain' — our wire's three decisions map 1:1 (we never abstain).
 */

export interface McpApprovalCallbacks {
  /** Forward a status snapshot to the main process (`mcp_status`). */
  onStatusSnapshot: (snapshot: WireMcpStatusSnapshot) => void;
  /** Ask the main process to approve a tool call (`mcp_approval_request`). */
  onApprovalRequest: (payload: McpApprovalRequestPayload) => void;
  /** Optional debug sink (subprocess stderr logging). */
  onDebug?: (message: string) => void;
}

/** Log an adapter install with enough detail to diagnose trust/lifecycle issues. */
export function describeAdapterConfig(config: AdapterMcpConfig): string {
  return Object.entries(config.mcpServers)
    .map(([name, entry]) => {
      const transport = entry.url ? `http ${entry.url}` : `stdio ${entry.command}`;
      const flags = [
        entry.lifecycle ?? 'lazy',
        entry.approveTools ? 'approval-required' : 'no-approval',
      ].join(' ');
      return `${name} [${transport}; ${flags}]`;
    })
    .join('; ');
}

interface PendingApproval {
  request: McpToolApprovalRequest;
  resolve: (decision: McpApprovalDecision) => void;
  /** Removes the abort listener when the request settles. */
  cleanup: () => void;
}

/**
 * Pending approvals keyed by requestId. Module-level (not per-extension):
 * the inbound `mcp_approval_response` handler must find requests regardless
 * of which host-extension generation created them.
 */
const pendingApprovals = new Map<string, PendingApproval>();

/** Active host listeners — replaced on each extension (re)load. */
let detachHost: (() => void) | null = null;

/**
 * Resolve a pending approval from an inbound `mcp_approval_response`.
 * Returns false when nothing is pending for the requestId (stale or unknown).
 */
export function resolveMcpApproval(requestId: string, decision: McpApprovalDecision): boolean {
  const pending = pendingApprovals.get(requestId);
  if (!pending) return false;
  pendingApprovals.delete(requestId);
  pending.cleanup();
  pending.resolve(decision);
  return true;
}

/**
 * Fail-closed cleanup: resolve every pending approval with 'deny' (abort,
 * shutdown). The adapter ignores late decisions for already-aborted requests;
 * resolving merely avoids dangling promises.
 */
export function clearPendingMcpApprovals(): void {
  for (const pending of pendingApprovals.values()) {
    pending.cleanup();
    pending.resolve('deny');
  }
  pendingApprovals.clear();
}

function isApprovalRequest(value: unknown): value is McpToolApprovalRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as McpToolApprovalRequest).requestId === 'string' &&
    typeof (value as McpToolApprovalRequest).claim === 'function'
  );
}

function isStatusSnapshot(value: unknown): value is McpStatusSnapshot {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as McpStatusSnapshot).version === 'number' &&
    Array.isArray((value as McpStatusSnapshot).servers)
  );
}

// ============================================================
// UI bridge (auth flows: the adapter's one-shot OAuth requires state.ui)
// ============================================================

export interface McpUiBridgeCallbacks {
  /** Forward an adapter ui.notify to the main process (`mcp_notify`). */
  onNotify: (message: string, level: 'info' | 'warning' | 'error') => void;
  /** Optional debug sink. */
  onDebug?: (message: string) => void;
}

/**
 * Minimal ExtensionUIContext for the headless subprocess.
 *
 * pi-mcp-adapter refuses interactive OAuth (attemptDirectAutoAuth → "requires
 * an interactive session") unless the extension context carries a UI. Binding
 * this bridge via `bindExtensions({ uiContext })` sets `state.ui`, which
 * unlocks the browser OAuth flow:
 *
 * - notify → forwarded to the main process (renderer toasts);
 * - confirm/input → auto-declined: the local browser callback completes the
 *   flow automatically; the manual paste path only matters on remote hosts
 *   where localhost is unreachable from the browser — v1 accepts that limit;
 * - everything else (status bar, widgets, terminal input) is a no-op.
 */
export function createMcpUiBridge(callbacks: McpUiBridgeCallbacks): Record<string, unknown> {
  const noop = () => {};
  return {
    select: async () => undefined,
    confirm: async () => {
      callbacks.onDebug?.('MCP ui.confirm auto-declined (headless bridge)');
      return false;
    },
    input: async () => {
      callbacks.onDebug?.('MCP ui.input auto-declined (headless bridge)');
      return undefined;
    },
    notify: (message: string, type?: 'info' | 'warning' | 'error') => {
      callbacks.onNotify(message, type ?? 'info');
    },
    onTerminalInput: () => () => {},
    setStatus: noop,
    setWorkingMessage: noop,
    setWorkingVisible: noop,
    setWorkingIndicator: noop,
    setHiddenThinkingLabel: noop,
    setWidget: noop,
    setFooter: noop,
  };
}

// ============================================================
// Sign-in result interpretation
// ============================================================

/** The slice of the adapter's proxy-tool result the sign-in flow reads. */
export interface McpProxyToolResult {
  content?: readonly { type?: string; text?: string }[];
  details?: { mode?: string; error?: string; message?: string };
}

/** Longest message forwarded to the main process for a sign-in attempt. */
const AUTH_MESSAGE_MAX_LENGTH = 500;

/**
 * Decide whether a `mcp({ connect })` round-trip authenticated the server.
 *
 * The adapter reports outcomes in `details.error` (`auth_required`,
 * `connect_failed`, `not_found`, `server_disabled`, …) and leaves it unset on
 * success, so that field — not the prose in `content` — is the verdict. The
 * text is only used as the fallback message, and as a last-resort verdict for
 * a result that carries no details at all.
 */
export function interpretMcpAuthResult(result: McpProxyToolResult | undefined): { ok: boolean; message: string; code?: string } {
  const text = (result?.content ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text ?? '')
    .join(' ')
    .trim();
  const details = result?.details;
  const ok = details
    ? !details.error
    : text.length > 0 && !/failed|error|not connected|not configured|not found/i.test(text);
  // The code travels with the result so the UI can say something a person can
  // act on; the adapter's prose is written for the model that called it.
  const code = details?.error ?? (ok ? undefined : 'connect_failed');
  return {
    ok,
    message: (details?.message ?? text).slice(0, AUTH_MESSAGE_MAX_LENGTH),
    ...(code ? { code } : {}),
  };
}

// ============================================================
// Host extension
// ============================================================

/**
 * Build the host bridge extension. It runs alongside the adapter inside the
 * agent session and forwards the adapter's shared-event-broker events to this
 * subprocess's JSONL stdout protocol:
 *
 * - `pi-mcp-adapter/status/v1` snapshots  → outbound `mcp_status`
 * - `pi-mcp-adapter:tool-approval-request` → outbound `mcp_approval_request`
 *   (claimed SYNCHRONOUSLY — see the broker notes above) and later resolved
 *   by an inbound `mcp_approval_response` via `resolveMcpApproval()`.
 */
export function createMcpHostExtension(callbacks: McpApprovalCallbacks): InlineExtension {
  return {
    name: 'bitlab-mcp-host',
    factory: (pi: ExtensionAPI) => {
      // A session reload builds a NEW host instance on the SAME loader-owned
      // event bus; subscriptions from the previous instance are never
      // auto-removed, so detach them here to avoid duplicate forwards.
      detachHost?.();
      detachHost = null;

      const unsubStatus = pi.events.on(MCP_STATUS_EVENT, (snapshot: unknown) => {
        if (!isStatusSnapshot(snapshot)) return;
        // Forward verbatim — the wire type is field-identical (see types.ts guard).
        callbacks.onStatusSnapshot(snapshot);
      });

      const unsubApproval = pi.events.on(MCP_TOOL_APPROVAL_REQUEST_EVENT, (raw: unknown) => {
        if (!isApprovalRequest(raw)) return;
        const request = raw;

        let settled = false;
        let resolveDecision: (decision: McpApprovalDecision) => void = () => {};
        const decisionPromise = new Promise<McpApprovalDecision>((resolve) => {
          resolveDecision = resolve;
        });
        const drop = () => {
          if (settled) return;
          settled = true;
          pendingApprovals.delete(request.requestId);
          // Unblock a claimed handler; the adapter discards this result if its
          // own abortable() already rejected on signal abort.
          resolveDecision('deny');
        };

        // Watch for adapter-side aborts (turn aborted, server shutdown) and
        // drop the pending entry so stale responses can't resolve it later.
        const onAbort = () => {
          callbacks.onDebug?.(`MCP approval ${request.requestId} aborted`);
          drop();
        };
        request.signal?.addEventListener('abort', onAbort, { once: true });
        const cleanup = () => {
          request.signal?.removeEventListener('abort', onAbort);
        };

        // Claim SYNCHRONOUSLY — inside this emit. After emit() returns the
        // adapter stops accepting claims and an unclaimed request fails
        // closed (approval_required_headless) when approval is required.
        const claimed = request.claim(async (): Promise<McpToolApprovalDecision> => {
          return await decisionPromise;
        });

        if (!claimed) {
          // Another broker listener won, or the claim window already closed.
          cleanup();
          callbacks.onDebug?.(`MCP approval ${request.requestId} could not be claimed`);
          return;
        }

        pendingApprovals.set(request.requestId, {
          request,
          resolve: resolveDecision,
          cleanup,
        });

        decisionPromise.then(() => cleanup(), () => cleanup());

        callbacks.onApprovalRequest({
          requestId: request.requestId,
          serverName: request.serverName,
          originalToolName: request.originalToolName,
          prefixedToolName: request.prefixedToolName,
          args: request.args ?? {},
        });
      });

      detachHost = () => {
        unsubStatus();
        unsubApproval();
        detachHost = null;
      };
    },
  };
}
