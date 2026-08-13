import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveScriptRuntime } from './resolve-script-runtime.ts';

describe('resolveScriptRuntime', () => {
  it('prefers BITLAB_UV for python3', () => {
    const prev = process.env.BITLAB_UV;
    process.env.BITLAB_UV = '/tmp/custom-uv';

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-uv');
      expect(resolved.argsPrefix).toEqual(['run', '--python', '3.12']);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.BITLAB_UV;
      else process.env.BITLAB_UV = prev;
    }
  });

  it('prefers bundled uv when env is missing', () => {
    const prevUv = process.env.BITLAB_UV;
    delete process.env.BITLAB_UV;

    const base = mkdtempSync(join(tmpdir(), 'runtime-resolver-'));
    const uvPath = join(base, 'resources', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'uv.exe' : 'uv');
    mkdirSync(join(base, 'resources', 'bin', `${process.platform}-${process.arch}`), { recursive: true });
    writeFileSync(uvPath, '');

    try {
      const resolved = resolveScriptRuntime('python3', { isPackaged: true, resourcesBasePath: base });
      expect(resolved.command).toBe(uvPath);
      expect(resolved.source).toBe('bundled');
    } finally {
      if (prevUv === undefined) delete process.env.BITLAB_UV;
      else process.env.BITLAB_UV = prevUv;
    }
  });

  it('blocks PATH fallback in packaged mode', () => {
    const prevUv = process.env.BITLAB_UV;
    const prevBase = process.env.BITLAB_RESOURCES_BASE;
    const prevRoot = process.env.BITLAB_APP_ROOT;
    delete process.env.BITLAB_UV;
    delete process.env.BITLAB_RESOURCES_BASE;
    delete process.env.BITLAB_APP_ROOT;

    try {
      expect(() => resolveScriptRuntime('python3', { isPackaged: true })).toThrow(
        'packaged app'
      );
    } finally {
      if (prevUv === undefined) delete process.env.BITLAB_UV;
      else process.env.BITLAB_UV = prevUv;
      if (prevBase === undefined) delete process.env.BITLAB_RESOURCES_BASE;
      else process.env.BITLAB_RESOURCES_BASE = prevBase;
      if (prevRoot === undefined) delete process.env.BITLAB_APP_ROOT;
      else process.env.BITLAB_APP_ROOT = prevRoot;
    }
  });

  it('rejects bare BITLAB_NODE command in packaged mode', () => {
    const prev = process.env.BITLAB_NODE;
    process.env.BITLAB_NODE = 'node';

    try {
      expect(() => resolveScriptRuntime('node', { isPackaged: true })).toThrow(
        'do not allow PATH-based runtime resolution'
      );
    } finally {
      if (prev === undefined) delete process.env.BITLAB_NODE;
      else process.env.BITLAB_NODE = prev;
    }
  });

  it('prefers BITLAB_BUN for bun in dev', () => {
    const prev = process.env.BITLAB_BUN;
    process.env.BITLAB_BUN = '/tmp/custom-bun';

    try {
      const resolved = resolveScriptRuntime('bun', { isPackaged: false });
      expect(resolved.command).toBe('/tmp/custom-bun');
      expect(resolved.argsPrefix).toEqual([]);
      expect(resolved.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env.BITLAB_BUN;
      else process.env.BITLAB_BUN = prev;
    }
  });
});
