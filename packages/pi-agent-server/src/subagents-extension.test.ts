/**
 * Real-session sub-agent extension test (no LLM involved).
 *
 * Drives the production path: BitlabResourceLoader with the inline sub-agent
 * extension → createAgentSession → tool registration. Two things break easily
 * and are both silent, so both are pinned here:
 *
 *  1. The extension is a THIRD-PARTY package (@tintinweb/pi-subagents) loaded
 *     from its `dist/` entry, against a peer-ranged Pi SDK. A version bump on
 *     either side can stop it installing — and the factory swallows failures on
 *     purpose, so a broken load shows up as "no sub-agent tools", not an error.
 *  2. Extension tools are registered AFTER the session is built, so passing the
 *     `tools` name allowlist filters every one of them out (index.ts omits the
 *     allowlist when sub-agents are on — that is what the second test guards).
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentSession,
  SettingsManager as PiSettingsManager,
} from '@earendil-works/pi-coding-agent';
import { BitlabResourceLoader } from './resource-loader.ts';
import { buildSubagentsExtension } from './subagents-extension.ts';

const SUBAGENT_TOOLS = ['Agent', 'get_subagent_result', 'steer_subagent'];

async function startSession(options: { toolAllowlist?: string[] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'bitlab-subagents-it-'));
  const agentDir = join(cwd, 'pi-agent');
  const loader = new BitlabResourceLoader({
    cwd,
    agentDir,
    settingsManager: PiSettingsManager.create(cwd, agentDir),
    inlineExtensions: [buildSubagentsExtension()],
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    model: { provider: 'stub', id: 'stub-model' } as never,
    ...(options.toolAllowlist ? { tools: options.toolAllowlist } : {}),
  });

  const toolNames = ((session as unknown as { agent: { state: { tools: Array<{ name: string }> } } })
    .agent.state.tools ?? []).map(tool => tool.name);
  return { session, loader, toolNames };
}

describe('sub-agent extension', () => {
  it(
    'loads inline and registers the sub-agent tools',
    async () => {
      const { session, loader, toolNames } = await startSession();
      try {
        expect(loader.getExtensions().errors ?? []).toEqual([]);
        for (const tool of SUBAGENT_TOOLS) expect(toolNames).toContain(tool);
        // The built-ins must survive alongside them.
        expect(toolNames).toContain('read');
        expect(toolNames).toContain('bash');
      } finally {
        await (session as unknown as { dispose(): Promise<void> }).dispose();
      }
    },
    { timeout: 60_000 },
  );

  it(
    'is filtered out by a tools allowlist — why index.ts omits it',
    async () => {
      const { session, toolNames } = await startSession({
        toolAllowlist: ['read', 'bash', 'edit', 'write'],
      });
      try {
        for (const tool of SUBAGENT_TOOLS) expect(toolNames).not.toContain(tool);
      } finally {
        await (session as unknown as { dispose(): Promise<void> }).dispose();
      }
    },
    { timeout: 60_000 },
  );
});
