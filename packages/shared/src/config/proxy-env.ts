import { getNetworkProxySettings } from './storage.ts';
import type { NetworkProxySettings } from './types.ts';

/**
 * The proxy actually in effect for this process, which can differ from what is
 * stored: the desktop app also derives one from the environment or from the OS.
 */
let resolvedSettings: NetworkProxySettings | undefined;

/**
 * Record the proxy this process resolved, so subprocesses inherit it too.
 *
 * A spawned agent gets its own Node runtime — no dispatcher, no awareness of the
 * OS proxy — so these env vars are the only way it learns about a proxy the user
 * never typed into settings.
 */
export function setResolvedProxySettings(settings: NetworkProxySettings | undefined): void {
  resolvedSettings = settings;
}

/**
 * Convert the effective proxy settings into environment variables for subprocesses.
 * Returns an empty object when proxy is disabled or not configured.
 */
export function getProxyEnvVars(): Record<string, string> {
  const settings = resolvedSettings ?? getNetworkProxySettings();
  if (!settings?.enabled) return {};

  const env: Record<string, string> = {};
  if (settings.httpProxy) {
    env.HTTP_PROXY = settings.httpProxy;
    env.http_proxy = settings.httpProxy;
  }
  if (settings.httpsProxy) {
    env.HTTPS_PROXY = settings.httpsProxy;
    env.https_proxy = settings.httpsProxy;
  }
  if (settings.noProxy) {
    env.NO_PROXY = settings.noProxy;
    env.no_proxy = settings.noProxy;
  }
  return env;
}
