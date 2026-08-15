import { describe, expect, it } from 'bun:test';
import {
  buildAdapterMcpConfig,
  DEFAULT_MCP_SETTINGS,
  discoverHostMcpConfigs,
  discoverProjectMcpServers,
  hostMcpConfigPaths,
  isValidMcpServerName,
  mcpServerId,
  normalizeMcpServers,
  normalizeMcpSettings,
  type BitlabMcpServer,
} from '../mcp.ts';

function stdioServer(overrides: Partial<BitlabMcpServer> = {}): BitlabMcpServer {
  return {
    id: 'test',
    name: 'test',
    enabled: true,
    trusted: false,
    transport: { type: 'stdio', command: 'node', args: ['server.js'] },
    source: 'user',
    ...overrides,
  };
}

describe('normalizeMcpServers', () => {
  it('drops malformed entries and dedupes names', () => {
    const result = normalizeMcpServers([
      stdioServer(),
      stdioServer(), // duplicate name
      { ...stdioServer(), name: 'bad name!', transport: { type: 'stdio', command: 'x' } },
      { ...stdioServer(), name: 'no-transport', transport: undefined as unknown as BitlabMcpServer['transport'] },
    ]);
    expect(result.map(s => s.name)).toEqual(['test']);
  });

  it('fills defaults for optional fields', () => {
    const [server] = normalizeMcpServers([stdioServer({ enabled: undefined as unknown as boolean })]);
    expect(server!.enabled).toBe(true);
    expect(server!.trusted).toBe(false);
    expect(server!.source).toBe('user');
  });
});

describe('normalizeMcpSettings', () => {
  it('falls back to defaults on invalid values', () => {
    expect(normalizeMcpSettings({ lifecycle: 'bogus' as never, requireApproval: false })).toEqual({
      ...DEFAULT_MCP_SETTINGS,
      requireApproval: false,
    });
    expect(normalizeMcpSettings(undefined)).toEqual(DEFAULT_MCP_SETTINGS);
  });
});

describe('normalizeMcpSettings request timeout', () => {
  it('keeps a sane value, zeroes an explicit off, and rejects nonsense', () => {
    expect(normalizeMcpSettings({ requestTimeoutMs: 30_000 }).requestTimeoutMs).toBe(30_000);
    expect(normalizeMcpSettings({ requestTimeoutMs: 0 }).requestTimeoutMs).toBe(0);
    // Out of range or not a number → the default, not an extreme.
    expect(normalizeMcpSettings({ requestTimeoutMs: 5 }).requestTimeoutMs).toBe(60_000);
    expect(normalizeMcpSettings({ requestTimeoutMs: 99_999_999 }).requestTimeoutMs).toBe(60_000);
    expect(normalizeMcpSettings({ requestTimeoutMs: Number.NaN }).requestTimeoutMs).toBe(60_000);
  });
});

describe('buildAdapterMcpConfig', () => {
  it('omits disabled servers and maps transports', () => {
    const config = buildAdapterMcpConfig(
      [
        stdioServer(),
        stdioServer({ name: 'off', enabled: false }),
        stdioServer({
          name: 'remote',
          trusted: true,
          transport: { type: 'http', url: 'https://mcp.example.com/sse', headers: { Authorization: 'Bearer x' } },
        }),
      ],
      DEFAULT_MCP_SETTINGS,
    );
    expect(Object.keys(config.mcpServers).sort()).toEqual(['remote', 'test']);
    expect(config.mcpServers.test).toMatchObject({ command: 'node', args: ['server.js'] });
    expect(config.mcpServers.remote).toMatchObject({
      url: 'https://mcp.example.com/sse',
      headers: { Authorization: 'Bearer x' },
    });
    expect(config.mcpServers.remote).not.toHaveProperty('command');
  });

  it('pins toolPrefix mcp and approval per trust level', () => {
    const config = buildAdapterMcpConfig(
      [stdioServer(), stdioServer({ name: 'trusted', trusted: true })],
      DEFAULT_MCP_SETTINGS,
    );
    expect(config.settings?.toolPrefix).toBe('mcp');
    expect(config.mcpServers.test!.approveTools).toBe(true);
    expect(config.mcpServers.trusted!.approveTools).toBe(false);
  });

  it('narrows a trusted server down to the tools it names', () => {
    const config = buildAdapterMcpConfig(
      [stdioServer({ name: 'trusted', trusted: true, approveTools: ['*write*', '*delete*'] })],
      DEFAULT_MCP_SETTINGS,
    );
    // "Never ask, except for these" — the read-freely / ask-before-writes
    // middle ground between a trusted and an untrusted server.
    expect(config.mcpServers.trusted!.approveTools).toEqual(['*write*', '*delete*']);
  });

  it('ignores a tool-level approval list on an untrusted server', () => {
    const config = buildAdapterMcpConfig(
      [stdioServer({ approveTools: ['*write*'] })],
      DEFAULT_MCP_SETTINGS,
    );
    // Untrusted already asks for everything; a narrower list must not widen it.
    expect(config.mcpServers.test!.approveTools).toBe(true);
  });

  it('applies the global request timeout and its per-server override', () => {
    const config = buildAdapterMcpConfig(
      [stdioServer(), stdioServer({ name: 'slow', requestTimeoutMs: 120_000 })],
      DEFAULT_MCP_SETTINGS,
    );
    expect(config.settings?.requestTimeoutMs).toBe(60_000);
    expect(config.mcpServers.test!.requestTimeoutMs).toBe(60_000);
    expect(config.mcpServers.slow!.requestTimeoutMs).toBe(120_000);
  });

  it('omits the timeout entirely when it is turned off globally', () => {
    const config = buildAdapterMcpConfig([stdioServer()], { ...DEFAULT_MCP_SETTINGS, requestTimeoutMs: 0 });
    expect(config.settings).not.toHaveProperty('requestTimeoutMs');
    expect(config.mcpServers.test).not.toHaveProperty('requestTimeoutMs');
  });

  it('turns off the approval gate entirely when requireApproval is off', () => {
    const config = buildAdapterMcpConfig([stdioServer()], { ...DEFAULT_MCP_SETTINGS, requireApproval: false });
    expect(config.mcpServers.test!.approveTools).toBe(false);
  });

  it('passes per-server overrides and defaults the lifecycle', () => {
    const config = buildAdapterMcpConfig(
      [stdioServer({ lifecycle: 'eager', includeTools: ['echo_*'] })],
      DEFAULT_MCP_SETTINGS,
    );
    expect(config.mcpServers.test!.lifecycle).toBe('eager');
    expect(config.mcpServers.test!.includeTools).toEqual(['echo_*']);
  });

  it('maps http auth overrides and enables one-shot browser OAuth', () => {
    const config = buildAdapterMcpConfig(
      [
        stdioServer({ name: 'forced', transport: { type: 'http', url: 'https://a.example/mcp', auth: 'oauth' } }),
        stdioServer({ name: 'static', transport: { type: 'http', url: 'https://b.example/mcp', auth: 'none' } }),
        stdioServer({ name: 'auto', transport: { type: 'http', url: 'https://c.example/mcp' } }),
      ],
      DEFAULT_MCP_SETTINGS,
    );
    expect(config.mcpServers.forced!.auth).toBe('oauth');
    expect(config.mcpServers.static!.auth).toBe(false);
    expect(config.mcpServers.auto).not.toHaveProperty('auth');
    expect(config.settings?.autoAuth).toBe(true);
  });
});

describe('isValidMcpServerName / mcpServerId', () => {
  it('accepts slug-like names only', () => {
    expect(isValidMcpServerName('github')).toBe(true);
    expect(isValidMcpServerName('my-server_2')).toBe(true);
    expect(isValidMcpServerName('-lead')).toBe(false);
    expect(isValidMcpServerName('has space')).toBe(false);
  });

  it('slugs ids from names', () => {
    expect(mcpServerId('My Server!')).toBe('my-server');
  });
});

const projectConfig = {
  mcpServers: {
    linear: { command: 'npx', args: ['-y', '@linear/mcp'] },
    remote: { url: 'https://api.example.com/mcp', headers: { 'X-Key': 'v' } },
    broken: { neither: 'command nor url' },
  },
};

describe('discoverProjectMcpServers', () => {
  it('parses stdio and http entries, skipping malformed ones', () => {
    const found = discoverProjectMcpServers('/ws', path => (path === '/ws/.mcp.json' ? projectConfig : null) as never);
    expect(found.map(s => s.name)).toEqual(['linear', 'remote']);
    expect(found[0]!.transport).toEqual({ type: 'stdio', command: 'npx', args: ['-y', '@linear/mcp'] });
    expect(found[0]!.originPath).toBe('/ws/.mcp.json');
    expect(found[1]!.transport).toMatchObject({ type: 'http', url: 'https://api.example.com/mcp' });
  });

  it('returns empty when the file is missing or unreadable', () => {
    expect(discoverProjectMcpServers('/ws', () => { throw new Error('ENOENT'); })).toEqual([]);
  });
});

describe('discoverHostMcpConfigs', () => {
  it('skips missing files and parses present ones', () => {
    const paths = hostMcpConfigPaths('/home/u');
    expect(paths.some(p => p.app === 'cursor' && p.path === '/home/u/.cursor/mcp.json')).toBe(true);

    const found = discoverHostMcpConfigs(
      '/home/u',
      path => path === '/home/u/.cursor/mcp.json',
      path => (path === '/home/u/.cursor/mcp.json' ? projectConfig : null) as never,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.app).toBe('cursor');
    expect(found[0]!.servers.map(s => s.name)).toEqual(['linear', 'remote']);
  });
});
