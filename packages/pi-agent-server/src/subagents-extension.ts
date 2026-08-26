/**
 * Sub-agent extension for the pi-agent-server subprocess.
 *
 * `@tintinweb/pi-subagents` is a Pi *extension*: its module default export is
 * `(pi: ExtensionAPI) => void`, the same shape as the MCP adapter, so it rides
 * the same inline-extension seam (see mcp-extension.ts and resource-loader.ts).
 * It registers three LLM-callable tools inside the session:
 *
 *   Agent               — spawn a sub-agent (foreground blocks this turn and
 *                         returns the result inline; `run_in_background: true`
 *                         returns an agentId immediately)
 *   get_subagent_result — status/result of a background sub-agent
 *   steer_subagent      — inject a steering message into a running sub-agent
 *
 * Why this is loaded inline rather than discovered: `agentDir` is deliberately
 * isolated per session (index.ts) so the subprocess never picks up whatever the
 * user has in ~/.pi/agent. That isolation also hides packaged extensions, so
 * anything Bitlab ships must be injected explicitly.
 *
 * The extension also registers TUI surfaces (an agent widget, a `/agents`
 * menu). Bitlab has no TUI host, so those registrations simply never render —
 * verified by subagents-extension.test.ts, which loads the extension in a real
 * embedded session and asserts a clean load plus the three tools.
 *
 * KNOWN LIMIT — sub-agents run outside Bitlab's permission prompts. The
 * extension builds each child with its own `createAgentSession({ tools })`
 * (agent-runner.ts), so a child uses Pi's raw tools rather than the
 * hook-wrapped ones from `wrapToolsWithHooks` in index.ts: its `bash` never
 * reaches `pre_tool_use`, even when the parent session is in "ask" mode. The
 * built-in `general-purpose` type carries every tool. Narrow a child by
 * declaring it in `<workspace>/.pi/agents/<name>.md` with a `tools:` allowlist,
 * or ship sessions with BITLAB_SUBAGENTS=0.
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

/** Lifecycle channels the extension publishes on the session's event bus. */
const SUBAGENT_COMPLETED_EVENT = 'subagents:completed';
const SUBAGENT_FAILED_EVENT = 'subagents:failed';

/** Terminal state of one background sub-agent, as reported on the event bus. */
export interface SubagentSettledPayload {
  agentId: string;
  status: 'completed' | 'failed' | 'stopped';
  description?: string;
  summary?: string;
}

/** The extension's `buildEventData` shape, narrowed to what the host forwards. */
function readSettledPayload(raw: unknown): SubagentSettledPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Record<string, unknown>;
  const agentId = typeof data.id === 'string' ? data.id : null;
  if (!agentId) return null;
  const rawStatus = typeof data.status === 'string' ? data.status : '';
  const status: SubagentSettledPayload['status'] =
    rawStatus === 'stopped' ? 'stopped' : rawStatus === 'completed' ? 'completed' : 'failed';
  const summarySource = status === 'completed' ? data.result : data.error;
  return {
    agentId,
    status,
    ...(typeof data.description === 'string' && data.description ? { description: data.description } : {}),
    ...(typeof summarySource === 'string' && summarySource
      ? { summary: summarySource.trim().slice(0, 400) }
      : {}),
  };
}

let detachHost: (() => void) | null = null;

/**
 * Host bridge that carries background sub-agent completions to the main process.
 *
 * A background sub-agent outlives the turn that launched it (the session's
 * subprocess is long-lived), but the extension only announces completion through
 * its own TUI surfaces, which this host never renders. Without this bridge the
 * only terminal signal is someone calling `get_subagent_result` — so an agent
 * that launched work and then finished its turn would never learn the work
 * finished, and its task chip would spin until the turn-end orphan sweep.
 *
 * Mirrors the MCP host bridge: subscribe on the loader-owned bus, forward to
 * stdout, and detach on reload so a rebuilt instance does not double-forward.
 */
export function createSubagentsHostExtension(
  onSettled: (payload: SubagentSettledPayload) => void,
): InlineExtension {
  return {
    name: 'bitlab-subagents-host',
    factory: (pi: ExtensionAPI) => {
      detachHost?.();
      detachHost = null;

      const forward = (raw: unknown) => {
        const payload = readSettledPayload(raw);
        if (payload) onSettled(payload);
      };

      const unsubCompleted = pi.events.on(SUBAGENT_COMPLETED_EVENT, forward);
      const unsubFailed = pi.events.on(SUBAGENT_FAILED_EVENT, forward);
      detachHost = () => {
        unsubCompleted();
        unsubFailed();
      };
    },
  };
}

/** Set BITLAB_SUBAGENTS=0 to ship a session without the sub-agent tools. */
export function subagentsEnabled(): boolean {
  return process.env.BITLAB_SUBAGENTS !== '0';
}

/**
 * The package publishes no `main`/`exports` — only `pi.extensions` pointing at
 * its TypeScript source — so the built `dist/` entry is addressed directly. A
 * non-literal specifier keeps the untyped runtime source out of the tsc program
 * (same trick as the MCP adapter import).
 */
async function loadSubagentsFactory(): Promise<(pi: ExtensionAPI) => void> {
  const moduleId = '@tintinweb/pi-subagents/dist/index.js';
  const mod = (await import(moduleId)) as { default: (pi: ExtensionAPI) => void };
  return mod.default;
}

export function buildSubagentsExtension(onDebug?: (message: string) => void): InlineExtension {
  return {
    name: 'pi-subagents',
    factory: async (pi: ExtensionAPI) => {
      // A failure here must not take the whole session down with it: without
      // this extension the agent simply has no sub-agent tools, which is how
      // every session behaved before it shipped.
      try {
        const install = await loadSubagentsFactory();
        install(pi);
        onDebug?.('Subagents: extension installed');
      } catch (error) {
        onDebug?.(`Subagents: extension failed to install — ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
