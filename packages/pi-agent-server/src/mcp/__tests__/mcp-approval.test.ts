/**
 * Host-extension approval broker unit tests.
 *
 * Exercises OUR bridge logic (sync claim, pending map, abort handling) with a
 * minimal fake ExtensionAPI — the adapter side is covered by the integration
 * test.
 */

import { describe, expect, it } from 'bun:test';
import { MCP_STATUS_EVENT, MCP_TOOL_APPROVAL_REQUEST_EVENT } from 'pi-mcp-adapter/types';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  clearPendingMcpApprovals,
  createMcpHostExtension,
  createMcpUiBridge,
  interpretMcpAuthResult,
  resolveMcpApproval,
} from '../mcp-extension.ts';
import type { McpApprovalRequestPayload, McpStatusSnapshot } from '../types.ts';

type Listener = (payload: unknown) => void;

/** Minimal `pi` implementing only what the host extension touches: pi.events. */
function fakePi() {
  const listeners = new Map<string, Listener>();
  return {
    pi: { events: { on: (name: string, cb: Listener) => { listeners.set(name, cb); return () => listeners.delete(name); } } } as unknown as ExtensionAPI,
    emit: (name: string, payload: unknown) => { listeners.get(name)?.(payload); },
    listenerCount: () => listeners.size,
  };
}

interface FakeApprovalRequest {
  requestId: string;
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
  claim(handler: () => unknown): boolean;
}

function install() {
  const { pi, emit } = fakePi();
  const statuses: McpStatusSnapshot[] = [];
  const requests: McpApprovalRequestPayload[] = [];
  const debugs: string[] = [];
  createMcpHostExtension({
    onStatusSnapshot: s => { statuses.push(s); },
    onApprovalRequest: r => { requests.push(r); },
    onDebug: m => { debugs.push(m); },
  }).factory(pi);
  return { emit, statuses, requests, debugs };
}

describe('MCP UI bridge (headless uiContext)', () => {
  it('forwards notify with level defaulting to info', () => {
    const forwarded: Array<{ message: string; level: string }> = [];
    const bridge = createMcpUiBridge({ onNotify: (message, level) => forwarded.push({ message, level }) });
    (bridge.notify as (m: string, t?: string) => void)('Authenticating linear...');
    (bridge.notify as (m: string, t?: string) => void)('boom', 'error');
    expect(forwarded).toEqual([
      { message: 'Authenticating linear...', level: 'info' },
      { message: 'boom', level: 'error' },
    ]);
  });

  it('auto-declines confirm/input (manual-paste path is out of scope headless)', async () => {
    const debugs: string[] = [];
    const bridge = createMcpUiBridge({ onNotify: () => {}, onDebug: m => debugs.push(m) });
    expect(await (bridge.confirm as (t: string, m: string) => Promise<boolean>)('t', 'm')).toBe(false);
    expect(await (bridge.input as (t: string, p?: string) => Promise<string | undefined>)('t')).toBeUndefined();
    expect(debugs.filter(d => d.includes('auto-declined'))).toHaveLength(2);
  });

  it('no-ops the presentation surface without throwing', () => {
    const bridge = createMcpUiBridge({ onNotify: () => {} });
    expect(() => {
      (bridge.setStatus as (k: string, t: string | undefined) => void)('mcp', undefined);
      (bridge.setWidget as (k: string, c: unknown) => void)('k', undefined);
      (bridge.setWorkingMessage as (m?: string) => void)();
    }).not.toThrow();
    expect(typeof (bridge.onTerminalInput as () => unknown)()).toBe('function');
  });
});

describe('interpretMcpAuthResult', () => {
  it('treats a connect result without details.error as signed in', () => {
    expect(interpretMcpAuthResult({
      content: [{ type: 'text', text: 'notion tools (12):\nsearch, fetch' }],
      details: { mode: 'list' },
    })).toEqual({ ok: true, message: 'notion tools (12):\nsearch, fetch' });
  });

  it('carries the adapter outcome code so the UI can speak for itself', () => {
    expect(interpretMcpAuthResult({
      details: { mode: 'connect', error: 'auth_required', message: 'x' },
    }).code).toBe('auth_required');
    // No details at all: a failure still gets a code the UI can map.
    expect(interpretMcpAuthResult({ content: [{ type: 'text', text: 'Failed to connect' }] }).code)
      .toBe('connect_failed');
  });

  it('fails on details.error and prefers its message over the prose', () => {
    expect(interpretMcpAuthResult({
      content: [{ type: 'text', text: 'long guidance for the agent' }],
      details: { mode: 'connect', error: 'auth_required', message: 'Server "notion" requires OAuth authentication.' },
    })).toEqual({ ok: false, message: 'Server "notion" requires OAuth authentication.', code: 'auth_required' });
  });

  it('fails a list fallback that reports the server is not connected', () => {
    // What the adapter returns when the connect never happened.
    expect(interpretMcpAuthResult({
      content: [{ type: 'text', text: 'Server "notion" is configured but not connected.' }],
      details: { mode: 'list', error: 'not_connected' },
    }).ok).toBe(false);
  });

  it('falls back to the text verdict when the result carries no details', () => {
    expect(interpretMcpAuthResult({ content: [{ type: 'text', text: 'connected' }] }).ok).toBe(true);
    expect(interpretMcpAuthResult({ content: [{ type: 'text', text: 'Failed to connect' }] }).ok).toBe(false);
    expect(interpretMcpAuthResult(undefined)).toEqual({ ok: false, message: '', code: 'connect_failed' });
  });
});

describe('MCP host extension bridge', () => {
  it('forwards valid status snapshots and drops malformed ones', () => {
    const { emit, statuses } = install();
    emit(MCP_STATUS_EVENT, { version: 1, servers: [], totalTools: 0, totalResources: 0, connectedCount: 0, disabledCount: 0 });
    emit(MCP_STATUS_EVENT, { not: 'a snapshot' });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.version).toBe(1);
  });

  it('claims approval requests synchronously and forwards them on the wire', () => {
    const { emit, requests } = install();
    let claimedHandler: (() => unknown) | null = null;
    const request: FakeApprovalRequest = {
      requestId: 'r1',
      serverName: 'echo',
      originalToolName: 'echo',
      prefixedToolName: 'mcp__echo_echo',
      args: { message: 'hi' },
      claim(handler) { claimedHandler = handler; return true; },
    };
    emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, request);

    expect(claimedHandler).not.toBeNull();
    expect(requests).toEqual([{
      requestId: 'r1',
      serverName: 'echo',
      originalToolName: 'echo',
      prefixedToolName: 'mcp__echo_echo',
      args: { message: 'hi' },
    }]);

    // Main process answers → the claimed handler resolves with the decision.
    expect(resolveMcpApproval('r1', 'allow_for_session')).toBe(true);
    expect(claimedHandler!()).resolves.toBe('allow_for_session');
  });

  it('ignores requests whose claim window is already closed', () => {
    const { emit, requests, debugs } = install();
    emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, {
      requestId: 'r2',
      serverName: 'echo',
      originalToolName: 'echo',
      prefixedToolName: 'mcp__echo_echo',
      args: {},
      claim: () => false,
    });
    expect(requests).toHaveLength(0);
    expect(debugs.some(d => d.includes('r2'))).toBe(true);
    expect(resolveMcpApproval('r2', 'allow_once')).toBe(false);
  });

  it('drops pending approvals on adapter-side abort', () => {
    const { emit, requests } = install();
    const abortController = new AbortController();
    let handler: (() => unknown) | null = null;
    emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, {
      requestId: 'r3',
      serverName: 'echo',
      originalToolName: 'echo',
      prefixedToolName: 'mcp__echo_echo',
      args: {},
      signal: abortController.signal,
      claim(h) { handler = h; return true; },
    });
    expect(requests).toHaveLength(1);

    abortController.abort();
    // Aborted requests are dropped — a late response must not resolve them.
    expect(resolveMcpApproval('r3', 'allow_once')).toBe(false);
    // The claimed handler was unblocked fail-closed (deny).
    expect(handler!()).resolves.toBe('deny');
  });

  it('clearPendingMcpApprovals denies everything outstanding', async () => {
    const { emit } = install();
    const handlers: Array<() => unknown> = [];
    for (const id of ['r4', 'r5']) {
      emit(MCP_TOOL_APPROVAL_REQUEST_EVENT, {
        requestId: id,
        serverName: 'echo',
        originalToolName: 'echo',
        prefixedToolName: 'mcp__echo_echo',
        args: {},
        claim(h) { handlers.push(h); return true; },
      });
    }
    clearPendingMcpApprovals();
    for (const handler of handlers) {
      expect(await handler()).toBe('deny');
    }
    expect(resolveMcpApproval('r4', 'allow_once')).toBe(false);
  });
});
