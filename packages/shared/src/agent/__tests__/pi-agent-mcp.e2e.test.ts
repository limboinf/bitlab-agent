/**
 * End-to-end MCP test across the REAL main↔subprocess boundary.
 *
 * Spawns the built pi-agent-server bundle through PiAgent exactly like
 * production: config.json (temp BITLAB_CONFIG_DIR) → resolveAdapterMcpConfig
 * → `init.mcpConfig` → in-subprocess pi-mcp-adapter (eager stdio echo server)
 * → outbound `mcp_status` → BaseAgent.onMcpStatus callback. Then rewrites the
 * config and drives `refreshMcpConfig()` (update_mcp_config → session.reload)
 * and asserts the swapped surface.
 *
 * The whole scenario runs in a subprocess (Bun.spawnSync harness) because
 * CONFIG_DIR is captured at module-import time.
 */

import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PI_AGENT_MODULE = pathToFileURL(join(HERE, '..', 'pi-agent.ts')).href;

/**
 * Walk upwards from this test file until `packages/pi-agent-server/dist/index.js`
 * exists. Counting `..` levels is fragile (bun's test runner may resolve
 * `import.meta.url` through a rewritten path), and a wrong bundle path fails
 * the spawn — which never rejects `subprocessReady`, hanging the harness.
 */
function resolvePiServerBundle(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'pi-agent-server', 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('pi-agent-server dist bundle not found — run `bun run build` in packages/pi-agent-server');
}

const PI_SERVER_BUNDLE = resolvePiServerBundle();
const ECHO_FIXTURE = join(dirname(dirname(PI_SERVER_BUNDLE)), 'src', 'mcp', '__tests__', 'fixtures', 'echo-server.mjs');

function writeMcpConfig(configDir: string, serverName: string, lifecycle: 'eager' | 'lazy' = 'eager'): void {
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    workspaces: [], activeWorkspaceId: null, activeSessionId: null,
    mcpServers: [{
      id: serverName, name: serverName, enabled: true, trusted: false,
      source: 'user',
      transport: { type: 'stdio', command: process.execPath, args: [ECHO_FIXTURE, 'echo'] },
    }],
    mcpSettings: { requireApproval: true, directTools: true, lifecycle },
  }, null, 2), 'utf-8');
}

const HARNESS = `
  import { writeFileSync, readFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { ensureConfigDir } from ${JSON.stringify(pathToFileURL(join(HERE, '..', '..', 'config', 'storage.ts')).href)}
  import { PiAgent } from ${JSON.stringify(PI_AGENT_MODULE)}

  // The app calls this at startup (bundled defaults/docs sync); the test's
  // throwaway config dir needs the same one-time initialization.
  ensureConfigDir()

  const trace = (m: string) => console.error('H: ' + m)
  trace('start')

  const agent = new PiAgent({
    provider: 'pi',
    workspace: { id: 'ws-e2e', name: 'E2E', slug: 'e2e', kind: 'folder', folderPath: process.cwd(), dataRoot: process.env.E2E_DATA_ROOT },
    session: { id: 'session-e2e', workspaceRootPath: process.env.E2E_DATA_ROOT, createdAt: Date.now(), lastUsedAt: Date.now() },
    isHeadless: true,
    runtime: { paths: { piServer: ${JSON.stringify(PI_SERVER_BUNDLE)}, node: process.execPath } },
  } as any)

  const statuses = []
  const errors = []
  agent.onMcpStatus = snapshot => { statuses.push(snapshot) }
  // Quiet by default, but surface subprocess death loudly — a failed spawn
  // otherwise hangs subprocessReady forever (no rejection path).
  agent.onDebug = (m: string) => {
    if (/exited|error|fail/i.test(m)) console.error('D: ' + m.slice(0, 200))
  }

  const waitFor = async (predicate, label, timeoutMs = 45000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise(r => setTimeout(r, 200))
    }
    throw new Error('timed out waiting for ' + label)
  }
  const connectedServers = () => {
    const latest = statuses[statuses.length - 1]
    return latest && latest.servers ? latest.servers.filter(s => s.status === 'connected').map(s => s.name) : []
  }
  const listedServers = () => {
    for (let i = statuses.length - 1; i >= 0; i--) {
      const servers = statuses[i].servers || []
      if (servers.length) return servers.map(s => s.name)
    }
    return []
  }
  // E2E_MODE=lazy: phase 1 only waits for the adapter's initial snapshot (a
  // lazy server stays not-connected until first use) and skips the hot-swap
  // phase — it exists to prove session_start-driven initialization happens.
  const lazyMode = process.env.E2E_MODE === 'lazy'
  const phase1Server = lazyMode ? 'lazyecho' : 'echo'

  const report = { phase1: false, phase2: false, phase2Servers: [], statusCount: 0 }
  try {
    // Phase 1: session creation → adapter initialization → first snapshot.
    trace('ensuring session')
    await (agent as any).requestEnsureSessionReady()
    trace('session ready')
    await waitFor(() => lazyMode ? listedServers().includes(phase1Server) : connectedServers().includes(phase1Server), phase1Server + (lazyMode ? ' listed in snapshot' : ' connected snapshot'))
    trace('phase1 ok')
    report.phase1 = true
    const phase1StatusCount = statuses.length

    if (lazyMode) {
      report.statusCount = statuses.length
      console.log(JSON.stringify({ report, errors }))
      agent.destroy()
      process.exit(0)
    }

    // Phase 2: rewrite config.json (server renamed echo → ping), hot-push.
    const configPath = join(process.env.BITLAB_CONFIG_DIR, 'config.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.mcpServers = [{
      id: 'ping', name: 'ping', enabled: true, trusted: false, source: 'user',
      transport: { type: 'stdio', command: process.execPath, args: [${JSON.stringify(ECHO_FIXTURE)}, 'echo'] },
    }]
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    trace('config rewritten, refreshing')
    agent.refreshMcpConfig()
    await waitFor(() => connectedServers().includes('ping') && !connectedServers().includes('echo'), 'ping connected / echo gone after hot update')
    trace('phase2 ok')
    report.phase2 = true
    report.phase2Servers = connectedServers()
    report.statusCount = statuses.length
    if (statuses.length <= phase1StatusCount) throw new Error('no new snapshot after refreshMcpConfig')
  } catch (e) {
    errors.push(String((e && e.message) || e))
  }
  console.log(JSON.stringify({ report, errors }))
  agent.destroy()
  process.exit(0)
`

describe('PiAgent MCP end-to-end (spawned subprocess)', () => {
  it(
    'init → eager connect → mcp_status; refreshMcpConfig hot-swaps the server surface',
    async () => {
      const configDir = mkdtempSync(join(tmpdir(), 'bitlab-mcp-e2e-'));
      const dataRoot = mkdtempSync(join(tmpdir(), 'bitlab-mcp-e2e-data-'));
      writeMcpConfig(configDir, 'echo');

      try {
        const result = await runHarness(configDir, dataRoot);
        expect(result.errors).toEqual([]);
        expect(result.report.phase1).toBe(true);
        expect(result.report.phase2).toBe(true);
        expect(result.report.phase2Servers).toEqual(['ping']);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );

  it(
    'lazy lifecycle still reaches an initialized state (session_start regression)',
    async () => {
      // Regression: embedded SDK sessions never emit session_start on their
      // own, and lazy servers initialize ONLY there — every tool call used to
      // return "MCP not initialized". The production wiring now emits it via
      // bindExtensions({}); an initialized adapter publishes a status snapshot
      // even before any lazy server connects.
      const configDir = mkdtempSync(join(tmpdir(), 'bitlab-mcp-e2e-lazy-'));
      const dataRoot = mkdtempSync(join(tmpdir(), 'bitlab-mcp-e2e-lazy-data-'));
      writeMcpConfig(configDir, 'lazyecho', 'lazy');

      try {
        const result = await runHarness(configDir, dataRoot, 'lazy');
        expect(result.errors).toEqual([]);
        expect(result.report.phase1).toBe(true);
        expect(result.report.statusCount).toBeGreaterThan(0);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    { timeout: 180_000 },
  );
});

/**
 * Run the harness with stdout/stderr redirected to files: the spawned Pi
 * subprocess (and its MCP server children) inherit the harness's stdio pipes,
 * and Bun.spawnSync blocks until every pipe writer closes — orphaned
 * grandchildren would hang the test forever. File redirection has no such
 * close semantics.
 */
async function runHarness(configDir: string, dataRoot: string, mode: 'eager' | 'lazy' = 'eager'): Promise<{ report: { phase1: boolean; phase2: boolean; phase2Servers: string[]; statusCount: number }; errors: string[] }> {
  const outPath = join(configDir, 'harness.out');
  const errPath = join(configDir, 'harness.err');
  const proc = Bun.spawn([process.execPath, '--eval', HARNESS], {
    cwd: dataRoot,
    env: {
      ...process.env,
      BITLAB_CONFIG_DIR: configDir,
      E2E_DATA_ROOT: dataRoot,
      E2E_MODE: mode,
    },
    stdout: Bun.file(outPath),
    stderr: Bun.file(errPath),
  });
  const timeout = setTimeout(() => { try { proc.kill(9); } catch { /* already gone */ } }, 150_000);
  let exitCode: number | null = null;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(timeout);
  }
  const out = await Bun.file(outPath).text();
  const err = await Bun.file(errPath).text();
  if (exitCode !== 0) {
    throw new Error(`harness failed (${exitCode}):\n${out.slice(-2000)}\n${err.slice(-4000)}`);
  }
  const jsonStart = out.indexOf('{"report"');
  if (jsonStart < 0) {
    throw new Error(`no report in harness output:\n${out.slice(-4000)}\nstderr:\n${err.slice(-2000)}`);
  }
  return JSON.parse(out.slice(jsonStart));
}
