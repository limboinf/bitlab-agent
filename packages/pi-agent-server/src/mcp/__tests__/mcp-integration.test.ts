/**
 * Real-session MCP integration tests (no LLM involved).
 *
 * Drives the exact production path: BitlabMcpResourceLoader (adapter +
 * host extensions via DefaultResourceLoader.extensionFactories) →
 * createAgentSession → eager stdio server connection → tool registration →
 * mcp_status snapshots → hot config update via session.reload().
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SettingsManager as PiSettingsManager,
} from '@earendil-works/pi-coding-agent';
import { BitlabMcpResourceLoader } from '../resource-loader.ts';
import {
  buildAdapterExtension,
  createMcpHostExtension,
  setCurrentMcpConfig,
} from '../mcp-extension.ts';
import type { AdapterMcpConfig, McpStatusSnapshot } from '../types.ts';

const echoServerPath = join(import.meta.dir, 'fixtures', 'echo-server.mjs');

function adapterConfig(toolName: string, serverName = 'echo', lifecycle: 'eager' | 'lazy' = 'eager'): AdapterMcpConfig {
  return {
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: [echoServerPath, toolName],
        lifecycle,
        directTools: true,
      },
    },
    settings: {
      toolPrefix: 'mcp',
      directTools: true,
      scriptMode: false,
      hostConfigDiscovery: 'off',
      notifyOnStartupConnect: false,
      showStatusIcon: false,
    },
  };
}

async function poll(
  predicate: () => boolean,
  { timeoutMs = 20_000, intervalMs = 250, label }: { timeoutMs?: number; intervalMs?: number; label: string },
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function sessionToolNames(session: { agent: { state: { tools: Array<{ name: string }> } } }): string[] {
  return (session.agent.state.tools ?? []).map(t => t.name);
}

describe('MCP subprocess integration', () => {
  it(
    'registers adapter direct tools and publishes status snapshots',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'bitlab-mcp-it-'));
      const agentDir = join(cwd, 'pi-agent');
      const statuses: McpStatusSnapshot[] = [];

      setCurrentMcpConfig(adapterConfig('echo'));
      const loader = new BitlabMcpResourceLoader({
        cwd,
        agentDir,
        settingsManager: PiSettingsManager.create(cwd, agentDir),
        adapterExtension: buildAdapterExtension(),
        hostExtension: createMcpHostExtension({
          onStatusSnapshot: snapshot => { statuses.push(snapshot); },
          onApprovalRequest: () => {},
        }),
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        model: { provider: 'stub', id: 'stub-model' } as never,
      });

      try {
        // Eager server connects at extension load; direct tool registers once
        // the live tool list lands. toolPrefix 'mcp' → mcp__<server>_<tool>.
        await poll(
          () => sessionToolNames(session).includes('mcp__echo_echo'),
          { label: 'direct tool mcp__echo_echo in session tool registry' },
        );
        await poll(
          () => statuses.some(s => s.servers.some(srv => srv.name === 'echo' && srv.status === 'connected' && srv.toolCount >= 1)),
          { label: 'connected status snapshot with toolCount >= 1' },
        );

        // The mcp proxy tool (progressive-discovery surface) rides along.
        expect(sessionToolNames(session)).toContain('mcp');
      } finally {
        await session.dispose();
      }
    },
    { timeout: 60_000 },
  );

  it(
    'lazy server initializes via explicit session_start; proxy tool no longer "MCP not initialized"',
    async () => {
      // Regression: the Pi SDK only emits `session_start` from
      // bindExtensions() (the TUI entry point) — embedded sessions never get
      // it automatically, and lazy-lifecycle servers initialize EXCLUSIVELY
      // there. Production wiring (index.ts) calls bindExtensions({}) after
      // createAgentSession; this test mirrors that and asserts the adapter
      // actually reaches a usable state by invoking the `mcp` proxy tool.
      const cwd = mkdtempSync(join(tmpdir(), 'bitlab-mcp-it-lazy-'));
      const agentDir = join(cwd, 'pi-agent');
      const statuses: McpStatusSnapshot[] = [];

      setCurrentMcpConfig(adapterConfig('echo', 'echo', 'lazy'));
      const loader = new BitlabMcpResourceLoader({
        cwd,
        agentDir,
        settingsManager: PiSettingsManager.create(cwd, agentDir),
        adapterExtension: buildAdapterExtension(),
        hostExtension: createMcpHostExtension({
          onStatusSnapshot: snapshot => { statuses.push(snapshot); },
          onApprovalRequest: () => {},
        }),
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        model: { provider: 'stub', id: 'stub-model' } as never,
      });

      try {
        await session.bindExtensions({});

        // Adapter state must exist now — the proxy tool responds with real
        // output instead of the "MCP not initialized" error payload.
        const proxyTool = sessionToolNames(session).includes('mcp')
          ? (session.agent.state.tools ?? []).find(t => t.name === 'mcp')
          : undefined;
        expect(proxyTool).toBeDefined();

        const result = await proxyTool!.execute('test-call', { status: true } as never, undefined as never, undefined as never, undefined as never);
        const text = (result?.content ?? [])
          .filter((c: { type?: string }) => c.type === 'text')
          .map((c: { text?: string }) => c.text ?? '')
          .join('');
        expect(text).not.toContain('MCP not initialized');
        expect(text.toLowerCase()).toContain('echo');
      } finally {
        await session.dispose();
      }
    },
    { timeout: 60_000 },
  );

  it(
    'hot config update via session.reload() swaps the MCP tool surface',
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'bitlab-mcp-reload-'));
      const agentDir = join(cwd, 'pi-agent');

      setCurrentMcpConfig(adapterConfig('echo'));
      const loader = new BitlabMcpResourceLoader({
        cwd,
        agentDir,
        settingsManager: PiSettingsManager.create(cwd, agentDir),
        adapterExtension: buildAdapterExtension(),
        hostExtension: createMcpHostExtension({
          onStatusSnapshot: () => {},
          onApprovalRequest: () => {},
        }),
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        model: { provider: 'stub', id: 'stub-model' } as never,
      });

      try {
        await poll(
          () => sessionToolNames(session).includes('mcp__echo_echo'),
          { label: 'initial direct tool registered' },
        );

        setCurrentMcpConfig(adapterConfig('ping'));
        await session.reload();

        await poll(
          () => sessionToolNames(session).includes('mcp__echo_ping'),
          { label: 'post-reload direct tool mcp__echo_ping' },
        );
        // The old surface must be gone after the swap.
        await poll(
          () => !sessionToolNames(session).includes('mcp__echo_echo'),
          { label: 'old direct tool mcp__echo_echo removed after reload' },
        );
      } finally {
        await session.dispose();
      }
    },
    { timeout: 60_000 },
  );
});
