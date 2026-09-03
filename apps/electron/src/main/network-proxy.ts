/**
 * Network proxy manager — configures both Node.js (undici) and Electron session proxies.
 *
 * - Node side: replaces the global undici dispatcher with a ProtocolProxyDispatcher
 *   that routes HTTP/HTTPS through different ProxyAgent instances and respects NO_PROXY.
 * - Electron side: calls session.setProxy() on default + browser-pane sessions.
 */

import { app, session } from 'electron';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { parseNoProxyRules, parsePacProxy, shouldBypassProxy, splitCommaSeparated, type NoProxyRule } from './network-proxy-utils';
import { getNetworkProxySettings, setNetworkProxySettings } from '@bitlab/shared/config/storage';
import { setResolvedProxySettings } from '@bitlab/shared/config/proxy-env';
import type { NetworkProxySettings } from '@bitlab/shared/config/types';
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager';
import log from './logger';

/** Loopback must stay direct: the app talks to its own local server over HTTP. */
const LOOPBACK_NO_PROXY = 'localhost,127.0.0.1,::1';

/** Where a proxy configuration came from, in descending priority. */
type ProxySource = 'settings' | 'environment' | 'system';

// Track the current dispatcher so we can close it when reconfiguring
let currentProxyDispatcher: Dispatcher | null = null;

/**
 * Build a ProxyAgent, or fall back to direct for a URL undici can't dial.
 *
 * undici throws synchronously on schemes it doesn't support (SOCKS4), and that
 * throw would otherwise escape all the way out of startup.
 */
function createProxyAgent(proxyUrl: string | undefined): ProxyAgent | null {
  if (!proxyUrl) return null;
  try {
    return new ProxyAgent(proxyUrl);
  } catch (error) {
    log.warn('[proxy] Unusable proxy URL, going direct for that protocol:', error);
    return null;
  }
}

/**
 * Custom undici Dispatcher that routes requests through proxy agents based on protocol,
 * bypasses proxied destinations listed in NO_PROXY rules, and falls back to a direct Agent.
 */
class ProtocolProxyDispatcher extends Dispatcher {
  private httpProxy: ProxyAgent | null;
  private httpsProxy: ProxyAgent | null;
  private direct: Agent;
  private rules: NoProxyRule[];

  constructor(opts: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }) {
    super();
    this.httpProxy = createProxyAgent(opts.httpProxy);
    this.httpsProxy = createProxyAgent(opts.httpsProxy);
    this.direct = new Agent();
    this.rules = parseNoProxyRules(opts.noProxy);
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();

    // If URL matches bypass rules, go direct
    if (url && shouldBypassProxy(url, this.rules)) {
      return this.direct.dispatch(opts, handler);
    }

    // Route based on protocol
    const isHttps = url?.startsWith('https:');
    const proxy = isHttps ? (this.httpsProxy ?? this.httpProxy) : this.httpProxy;

    if (proxy) {
      return proxy.dispatch(opts, handler);
    }

    return this.direct.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
      this.direct.close(),
    ]);
  }

  async destroy(): Promise<void> {
    await Promise.all([
      this.httpProxy?.destroy(),
      this.httpsProxy?.destroy(),
      this.direct.destroy(),
    ]);
  }
}

/**
 * Configure the Node.js global undici dispatcher for proxy routing.
 */
function configureNodeProxy(settings: NetworkProxySettings | undefined): void {
  // Close previous dispatcher (proxy or direct — both are tracked)
  if (currentProxyDispatcher) {
    currentProxyDispatcher.close().catch(() => {});
    currentProxyDispatcher = null;
  }

  if (!settings?.enabled || (!settings.httpProxy && !settings.httpsProxy)) {
    // Restore a direct dispatcher and track it so next reconfigure can close it
    const direct = new Agent();
    setGlobalDispatcher(direct);
    currentProxyDispatcher = direct;
    return;
  }

  const dispatcher = new ProtocolProxyDispatcher({
    httpProxy: settings.httpProxy,
    httpsProxy: settings.httpsProxy,
    noProxy: settings.noProxy,
  });

  setGlobalDispatcher(dispatcher);
  currentProxyDispatcher = dispatcher;
}

/**
 * Configure Electron session proxies (default session + browser-pane partition).
 * Requires app to be ready.
 */
async function configureElectronProxy(
  settings: NetworkProxySettings | undefined,
  fallbackMode: 'system' | 'direct',
): Promise<void> {
  if (!app.isReady()) return;

  // Chromium follows the OS proxy by itself; only pin it when the user made an
  // explicit choice, so that "no setting" doesn't mean "ignore the system proxy".
  const proxyConfig = settings?.enabled
    ? buildElectronProxyConfig(settings)
    : { mode: fallbackMode };

  const sessions = [
    session.defaultSession,
    session.fromPartition(BROWSER_PANE_SESSION_PARTITION),
  ];

  await Promise.all(sessions.map(ses => ses.setProxy(proxyConfig)));
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  const rules: string[] = [];

  if (settings.httpsProxy) {
    rules.push(`https=${settings.httpsProxy}`);
  }
  if (settings.httpProxy) {
    rules.push(`http=${settings.httpProxy}`);
  }

  if (rules.length === 0) {
    return { mode: 'direct' };
  }

  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    proxyBypassRules: settings.noProxy
      ? splitCommaSeparated(settings.noProxy).join(',')
      : undefined,
  };
}

/**
 * Proxy settings inherited from the environment, used when the app has no proxy
 * of its own configured. Without this, Node's fetch ignores HTTPS_PROXY entirely
 * (unlike curl or the CLI tools users expect to behave the same), so requests to
 * region-restricted endpoints fail even though the browser reaches them fine.
 *
 * Note a macOS GUI launch inherits no shell environment — configure the proxy in
 * settings for that case.
 */
function readEnvProxySettings(): NetworkProxySettings | undefined {
  const { HTTP_PROXY, http_proxy, HTTPS_PROXY, https_proxy, NO_PROXY, no_proxy } = process.env;
  const httpProxy = HTTP_PROXY || http_proxy;
  // A lone HTTPS_PROXY is the common setup; fall back to the http one for either protocol.
  const httpsProxy = HTTPS_PROXY || https_proxy || httpProxy;
  if (!httpProxy && !httpsProxy) return undefined;

  const noProxy = [NO_PROXY || no_proxy, LOOPBACK_NO_PROXY].filter(Boolean).join(',');
  return { enabled: true, httpProxy: httpProxy || httpsProxy, httpsProxy, noProxy };
}

/**
 * Cap on the system-proxy lookup. Resolving can mean fetching and evaluating a
 * remote PAC script, and this runs on the startup path.
 */
const SYSTEM_PROXY_TIMEOUT_MS = 2_000;

/** Reject if `promise` hasn't settled in time, without holding the event loop open. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    }),
  ]);
}

/**
 * The proxy the operating system itself is configured with, read via Chromium.
 *
 * Node's HTTP stack ignores the OS proxy completely, so on a machine where every
 * app is proxied this one still dials out direct — which is how a region-locked
 * endpoint rejects us while the user's browser reaches it fine. Chromium does
 * follow the OS settings (and evaluates any PAC script), so asking it means the
 * user configures nothing here.
 */
async function readSystemProxySettings(): Promise<NetworkProxySettings | undefined> {
  if (!app.isReady()) return undefined;

  try {
    // Chromium answers from whatever mode the session is in, so put it back on
    // the OS settings first — otherwise we would read back our own last override.
    await session.defaultSession.setProxy({ mode: 'system' });

    // Ask for both protocols: a PAC script may route them differently.
    const [httpProxy, httpsProxy] = await withTimeout(Promise.all([
      session.defaultSession.resolveProxy('http://example.com').then(parsePacProxy),
      session.defaultSession.resolveProxy('https://example.com').then(parsePacProxy),
    ]), SYSTEM_PROXY_TIMEOUT_MS);

    if (!httpProxy && !httpsProxy) return undefined;

    return {
      enabled: true,
      httpProxy: httpProxy ?? httpsProxy,
      httpsProxy: httpsProxy ?? httpProxy,
      noProxy: LOOPBACK_NO_PROXY,
    };
  } catch (error) {
    log.warn('[proxy] Could not read the system proxy:', error);
    return undefined;
  }
}

/**
 * Resolve which proxy to use, in descending priority: what the user configured
 * here, then the shell environment, then the operating system's own proxy.
 */
async function resolveProxySettings(): Promise<{
  settings: NetworkProxySettings | undefined;
  source: ProxySource;
}> {
  // An explicit setting wins even when it says "off" — that means direct, not
  // "go guess from my shell or my OS".
  const configured = getNetworkProxySettings();
  if (configured) return { settings: configured, source: 'settings' };

  const fromEnv = readEnvProxySettings();
  if (fromEnv) return { settings: fromEnv, source: 'environment' };

  return { settings: await readSystemProxySettings(), source: 'system' };
}

/**
 * Read persisted proxy settings and apply to both Node and Electron.
 * Safe to call before app.whenReady() — Electron session setup is skipped until ready.
 */
export async function applyConfiguredProxySettings(): Promise<void> {
  const { settings, source } = await resolveProxySettings();

  log.info('[proxy] Applying proxy settings:', {
    source,
    enabled: settings?.enabled ?? false,
    hasHttpProxy: !!settings?.httpProxy,
    hasHttpsProxy: !!settings?.httpsProxy,
    hasNoProxy: !!settings?.noProxy,
  });

  configureNodeProxy(settings);
  // Subprocesses read this back as env vars — they can't see the OS proxy either.
  setResolvedProxySettings(settings);
  // Chromium needs no override for a system-derived proxy — it already follows
  // the OS, and pinning it would freeze a PAC script's per-URL routing.
  // Only an explicit setting pins it, and only an explicit "off" means direct.
  await configureElectronProxy(
    source === 'system' ? undefined : settings,
    source === 'settings' ? 'direct' : 'system',
  );
}

/**
 * Persist new proxy settings and apply immediately.
 */
export async function updateConfiguredProxySettings(settings: NetworkProxySettings): Promise<void> {
  setNetworkProxySettings(settings);
  await applyConfiguredProxySettings();
}
