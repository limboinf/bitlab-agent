/**
 * Tests for the OAuth callback server lifecycle.
 *
 * The flow these guard: an unrelated request (favicon, liveness probe) used to
 * shut the listener down without settling the promise, leaving the app stuck on
 * "connecting" forever even though the browser showed "Authorization successful".
 */
import { describe, it, expect } from 'bun:test';
import { createCallbackServer } from '../callback-server.ts';

describe('createCallbackServer', () => {
  it('keeps listening after an unrelated request and still resolves the real callback', async () => {
    const server = await createCallbackServer({ callbackPaths: ['/auth/callback'] });

    const probe = await fetch(`${server.url}/favicon.ico`);
    expect(probe.status).toBe(404);

    // A fresh connection must still reach the listener.
    const callback = await fetch(`${server.url}/auth/callback?code=abc&state=xyz`, {
      headers: { Connection: 'close' },
    });
    expect(callback.status).toBe(200);

    const payload = await server.promise;
    expect(payload.query.code).toBe('abc');
    expect(payload.query.state).toBe('xyz');
    server.close();
  });

  it('rejects instead of hanging when the callback never arrives', async () => {
    const server = await createCallbackServer({ callbackPaths: ['/auth/callback'], timeoutMs: 50 });
    await expect(server.promise).rejects.toThrow(/Timed out/);
  });

  it('rejects the pending promise when the caller cancels', async () => {
    const server = await createCallbackServer({ callbackPaths: ['/auth/callback'] });
    server.close();
    await expect(server.promise).rejects.toThrow(/cancelled/i);
  });

  it('reports a fixed port that is already taken', async () => {
    const first = await createCallbackServer({ callbackPaths: ['/auth/callback'], port: 16455 });
    await expect(
      createCallbackServer({ callbackPaths: ['/auth/callback'], port: 16455 }),
    ).rejects.toThrow(/already in use/);
    first.close();
  });
});
