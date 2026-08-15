import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isLoopbackAddress } from '../loopback'
import { createWebuiHandler, startWebuiHttpServer } from '../http-server'

const SECRET = 'test-server-secret'
const TEMP_DIRS: string[] = []
const SERVERS: Array<{ stop: () => void }> = []

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any

function createTestWebuiDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bitlab-loopback-test-'))
  TEMP_DIRS.push(dir)
  writeFileSync(join(dir, 'login.html'), '<!doctype html><html><body>login</body></html>')
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><body>app</body></html>')
  return dir
}

function createHandler(allowLoopbackWithoutAuth: boolean) {
  return createWebuiHandler({
    webuiDir: createTestWebuiDir(),
    secret: SECRET,
    wsProtocol: 'ws',
    wsPort: 9100,
    getHealthCheck: () => ({ status: 'ok' }),
    logger,
    allowLoopbackWithoutAuth,
  })
}

afterEach(() => {
  while (SERVERS.length) SERVERS.pop()!.stop()
  while (TEMP_DIRS.length) rmSync(TEMP_DIRS.pop()!, { recursive: true, force: true })
})

describe('isLoopbackAddress', () => {
  it('accepts loopback in the forms a socket actually reports', () => {
    // The whole 127/8 range is loopback, not just 127.0.0.1.
    for (const addr of ['127.0.0.1', '127.0.0.53', '127.1.2.3', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) {
      expect(isLoopbackAddress(addr)).toBe(true)
    }
  })

  it('rejects non-loopback peers', () => {
    for (const addr of ['192.168.1.5', '10.0.0.1', '128.0.0.1', '126.255.255.255', '::ffff:192.168.1.5', '2001:db8::1']) {
      expect(isLoopbackAddress(addr)).toBe(false)
    }
  })

  it('rejects missing or malformed input rather than guessing', () => {
    for (const addr of [undefined, null, '', '   ', 'localhost', '127.0.0', '127.0.0.1.1', '127.0.0.256', '127.0.0.1x', 'not-an-ip']) {
      expect(isLoopbackAddress(addr)).toBe(false)
    }
  })
})

describe('webui loopback auth bypass', () => {
  it('serves a loopback request with no session cookie when enabled', async () => {
    const handler = createHandler(true)
    const res = await handler.fetch(
      new Request('http://127.0.0.1:9100/api/config'),
      { remoteAddress: '127.0.0.1' },
    )

    expect(res.status).toBe(200)
    expect((await res.json() as { wsUrl: string }).wsUrl).toContain('ws://')
    handler.dispose()
  })

  it('still rejects a non-loopback peer when enabled', async () => {
    const handler = createHandler(true)
    const res = await handler.fetch(
      new Request('http://127.0.0.1:9100/api/config'),
      { remoteAddress: '192.168.1.50' },
    )

    expect(res.status).toBe(401)
    handler.dispose()
  })

  it('rejects a loopback peer when the bypass is disabled', async () => {
    const handler = createHandler(false)
    const res = await handler.fetch(
      new Request('http://127.0.0.1:9100/api/config'),
      { remoteAddress: '127.0.0.1' },
    )

    expect(res.status).toBe(401)
    handler.dispose()
  })

  it('ignores headers claiming to be local — only the socket peer counts', async () => {
    const handler = createHandler(true)
    // A remote client cannot talk its way in by asserting a loopback origin.
    const res = await handler.fetch(
      new Request('http://127.0.0.1:9100/api/config', {
        headers: {
          host: '127.0.0.1',
          'x-forwarded-for': '127.0.0.1',
          'x-real-ip': '127.0.0.1',
          origin: 'http://localhost',
        },
      }),
      { remoteAddress: '203.0.113.9' },
    )

    expect(res.status).toBe(401)
    handler.dispose()
  })

  it('fails closed when the peer address is unknown', async () => {
    const handler = createHandler(true)
    const res = await handler.fetch(new Request('http://127.0.0.1:9100/api/config'))

    expect(res.status).toBe(401)
    handler.dispose()
  })

  it('protects the app shell too, not just the API', async () => {
    const enabled = createHandler(true)
    const local = await enabled.fetch(
      new Request('http://127.0.0.1:9100/', { headers: { accept: 'text/html' } }),
      { remoteAddress: '::1' },
    )
    expect(local.status).toBe(200)

    const remote = await enabled.fetch(
      new Request('http://127.0.0.1:9100/', { headers: { accept: 'text/html' } }),
      { remoteAddress: '198.51.100.4' },
    )
    expect(remote.status).toBe(302)
    expect(remote.headers.get('location')).toContain('/login')
    enabled.dispose()
  })

  it('reaches a real loopback socket end-to-end without logging in', async () => {
    const server = await startWebuiHttpServer({
      port: 0,
      webuiDir: createTestWebuiDir(),
      secret: SECRET,
      wsProtocol: 'ws',
      wsPort: 9100,
      getHealthCheck: () => ({ status: 'ok' }),
      logger,
      allowLoopbackWithoutAuth: true,
    })
    SERVERS.push(server)

    const res = await fetch(`http://127.0.0.1:${server.port}/api/config`)
    expect(res.status).toBe(200)
  })
})
