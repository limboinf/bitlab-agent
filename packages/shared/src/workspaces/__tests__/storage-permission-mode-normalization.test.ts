import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkspaceConfig } from '../storage.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

describe('workspace storage: config normalization', () => {
  function writeWorkspace(prefix: string, defaults: Record<string, unknown>): string {
    const workspaceRoot = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(workspaceRoot);
    const rawConfig = {
      id: 'ws_123',
      name: 'Test Workspace',
      slug: 'test-workspace',
      defaults,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');
    return workspaceRoot;
  }

  it('maps canonical mode names on read', () => {
    const workspaceRoot = writeWorkspace('ws-mode-map-', {
      permissionMode: 'execute',
      cyclablePermissionModes: ['ask', 'execute'],
    });

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.permissionMode).toBe('allow-all');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['ask', 'allow-all']);
  });

  it('collapses the legacy 3-mode default to the two-state UI', () => {
    const workspaceRoot = writeWorkspace('ws-mode-legacy-', {
      permissionMode: 'explore',
      cyclablePermissionModes: ['explore', 'ask', 'execute'],
    });

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['ask', 'allow-all']);
    // Explore is off the menu, so the starting mode moves to the guarded default
    // instead of stranding the session in a mode with no control for it.
    expect(loaded?.defaults?.permissionMode).toBe('ask');
  });

  it('keeps an explicitly customized mode list untouched', () => {
    const workspaceRoot = writeWorkspace('ws-mode-custom-', {
      permissionMode: 'explore',
      cyclablePermissionModes: ['ask', 'safe'],
    });

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['ask', 'safe']);
    expect(loaded?.defaults?.permissionMode).toBe('safe');
  });

  it('falls back to the default cycle if persisted cyclablePermissionModes are invalid', () => {
    const workspaceRoot = writeWorkspace('ws-mode-invalid-', {
      permissionMode: 'execute',
      cyclablePermissionModes: ['unknown'],
    });

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.permissionMode).toBe('allow-all');
    expect(loaded?.defaults?.cyclablePermissionModes).toEqual(['ask', 'allow-all']);
  });

  it('normalizes legacy defaults.thinkingLevel=think on read', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'ws-thinking-legacy-'));
    tempDirs.push(workspaceRoot);

    const rawConfig = {
      id: 'ws_789',
      name: 'Legacy Thinking',
      slug: 'legacy-thinking',
      defaults: {
        thinkingLevel: 'think',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify(rawConfig, null, 2), 'utf-8');

    const loaded = loadWorkspaceConfig(workspaceRoot);
    expect(loaded).not.toBeNull();
    expect(loaded?.defaults?.thinkingLevel).toBe('medium');
  });
});
