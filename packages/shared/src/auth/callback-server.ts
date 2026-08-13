import { createServer as createHttpServer, type Server } from 'http';
import { URL } from 'url';
import { generateCallbackPage, type AppType } from './callback-page.ts';

// Re-export for backwards compatibility
export { generateCallbackPage, type AppType } from './callback-page.ts';

const START_PORT = 6477;
const MAX_PORT_ATTEMPTS = 100;
/** How long to wait for the provider to redirect back. Matches the server-side flow TTL. */
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CallbackPayload {
  // For now just the query params. In the future we may extend this with other request properties.
  query: Record<string, string>;
}

export interface CallbackServer {
  promise: Promise<CallbackPayload>;
  url: string;
  /** Close the callback server. Call this on component unmount to clean up. */
  close: () => void | Promise<void>;
}

/**
 * Attempt to bind an HTTP server to the given port.
 * Resolves on success, rejects on error (e.g. EADDRINUSE).
 */
function tryBind(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind the IPv4 loopback explicitly rather than 'localhost'. Node resolves
    // 'localhost' through DNS, so two servers could bind the same port on
    // different address families (::1 and 127.0.0.1) without either seeing
    // EADDRINUSE — leaving a stale listener that silently swallows the
    // browser's callback. Browsers resolving localhost reach 127.0.0.1 (or
    // fall back to it per RFC 8305), which is also what the Codex CLI binds.
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

export interface CreateCallbackServerOptions {
  appType?: AppType;
  /** Deep link URL to redirect to after successful auth (e.g., bitlab://auth-complete) */
  deeplinkUrl?: string;
  /** Fixed port to bind to. If set, only that port is tried (no range scanning). */
  port?: number;
  /** URL paths to accept as callbacks. Default: ['/callback', '/oauth/callback']. */
  callbackPaths?: string[];
  /** Reject the callback promise if no callback arrives in time. Default: 5 minutes. */
  timeoutMs?: number;
}

/**
 * Creates an OAuth callback server by binding directly to a port in the range
 * START_PORT .. START_PORT + MAX_PORT_ATTEMPTS - 1.
 *
 * Unlike a check-then-bind approach, this eliminates the TOCTOU race condition
 * by attempting to bind the real server on each candidate port. If the port is
 * already in use (EADDRINUSE), the server is closed and the next port is tried.
 */
export async function createCallbackServer(options?: CreateCallbackServerOptions): Promise<CallbackServer> {
  const appType = options?.appType ?? 'terminal';
  const deeplinkUrl = options?.deeplinkUrl;
  const allowedPaths = new Set(options?.callbackPaths ?? ['/callback', '/oauth/callback']);

  let server: Server | null = null;
  let boundPort: number | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  let resolveCallback: ((payload: CallbackPayload) => void) | null = null;
  let rejectCallback: ((error: Error) => void) | null = null;

  const callbackPromise = new Promise<CallbackPayload>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // The caller may close the server without awaiting the promise (component
  // unmount, cancelled flow). Keep a noop catch so that rejection never
  // surfaces as an unhandled rejection — awaiting callers still see the error.
  callbackPromise.catch(() => {});

  const closeServer = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (server) {
      server.close();
      server = null;
    }
  };

  /** Finish the flow exactly once: stop listening, then settle the promise. */
  const finish = (result: { payload: CallbackPayload } | { error: Error }) => {
    if (settled) return;
    settled = true;
    closeServer();
    if ('error' in result) rejectCallback?.(result.error);
    else resolveCallback?.(result.payload);
  };

  // Build the request handler. It closes over `boundPort` which is set before
  // any requests can arrive (the browser isn't opened until after we return).
  const requestHandler = (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    try {
      const url = new URL(req.url || '/', `http://localhost:${boundPort}`);

      // Unrelated requests (favicon, liveness probes, stray navigations) must
      // not end the flow — we keep listening for the real callback.
      if (!allowedPaths.has(url.pathname)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found');
        return;
      }

      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });

      const payload: CallbackPayload = {
        query,
      };

      // Check if this looks like a successful auth callback
      const hasCode = !!query.code;
      const hasError = !!query.error;

      // Send a styled success/error page
      const html = generateCallbackPage({
        title: hasError ? 'Authorization Failed' : 'Authorization Complete',
        isSuccess: hasCode && !hasError,
        errorDetail: query.error_description || query.error,
        appType,
        deeplinkUrl: (hasCode && !hasError) ? deeplinkUrl : undefined,
      });

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);

      finish({ payload });
    } catch (error) {
      const html = generateCallbackPage({
        title: 'Error',
        isSuccess: false,
        errorDetail: error instanceof Error ? error.message : 'Internal Server Error',
        appType,
      });

      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);

      finish({ error: error instanceof Error ? error : new Error(String(error)) });
    }
  };

  // Port selection: fixed port (options.port) or scan default range.
  const fixedPort = options?.port;
  const portStart = fixedPort ?? START_PORT;
  const portAttempts = fixedPort != null ? 1 : MAX_PORT_ATTEMPTS;

  for (let i = 0; i < portAttempts; i++) {
    const port = portStart + i;
    const candidate = createHttpServer(requestHandler);

    try {
      await tryBind(candidate, port);
      // Bind succeeded — wire up the error handler for runtime errors
      // and propagate them to the callback promise.
      server = candidate;
      boundPort = port;
      server.on('error', (err) => {
        finish({ error: err instanceof Error ? err : new Error(String(err)) });
      });
      break;
    } catch (err: unknown) {
      // Port in use — close the candidate and try the next one
      candidate.close();
      const isAddressInUse =
        err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!isAddressInUse) {
        // Unexpected error (e.g. permission denied) — propagate immediately
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }

  if (server === null || boundPort === null) {
    if (fixedPort != null) {
      throw new Error(
        `Port ${fixedPort} is already in use — another authorization is still pending ` +
        `(or another app such as the Codex CLI holds the port). Close it and try again.`,
      );
    }
    throw new Error(`No available port found in range ${START_PORT}-${START_PORT + MAX_PORT_ATTEMPTS - 1}`);
  }

  // Never leave the caller waiting forever when the browser flow is abandoned.
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;
  timeoutTimer = setTimeout(() => {
    finish({ error: new Error(`Timed out waiting for the authorization callback (${Math.round(timeoutMs / 1000)}s)`) });
  }, timeoutMs);

  const callbackUrl = `http://localhost:${boundPort}`;

  return {
    promise: callbackPromise,
    url: callbackUrl,
    close: () => {
      finish({ error: new Error('Authorization cancelled') });
    },
  };
}
