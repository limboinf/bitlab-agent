import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const STORAGE_URL = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href

describe('workspace folder registry', () => {
  it('separates project folders from stable Bitlab data roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'bitlab-workspace-registry-'))
    const configDir = join(root, 'config')
    const firstProject = join(root, 'work', 'abc')
    const secondProject = join(root, 'client', 'abc')
    mkdirSync(firstProject, { recursive: true })
    mkdirSync(secondProject, { recursive: true })

    try {
      const script = `
        import {
          addWorkspace,
          ensureConfigDir,
          getActiveWorkspace,
          getWorkspaces,
          removeWorkspace,
          saveConfig,
          setActiveWorkspace,
        } from ${JSON.stringify(STORAGE_URL)};

        ensureConfigDir();
        saveConfig({ workspaces: [], activeWorkspaceId: null, activeSessionId: null });
        const fallback = addWorkspace({ name: 'No Workspace', kind: 'default', folderPath: null });
        const first = addWorkspace({ name: 'abc', folderPath: ${JSON.stringify(firstProject)} });
        const repeated = addWorkspace({ name: 'ABC Renamed', folderPath: ${JSON.stringify(firstProject)} });
        const second = addWorkspace({ name: 'abc', folderPath: ${JSON.stringify(secondProject)} });
        setActiveWorkspace(first.id);
        const active = getActiveWorkspace();
        const privateName = JSON.parse(await Bun.file(first.dataRoot + '/config.json').text()).name;
        let folderInvariantError = '';
        let defaultInvariantError = '';
        try {
          addWorkspace({ name: 'Invalid Folder', kind: 'folder', folderPath: null });
        } catch (error) {
          folderInvariantError = error.message;
        }
        try {
          addWorkspace({ name: 'Invalid Default', kind: 'default', folderPath: ${JSON.stringify(firstProject)} });
        } catch (error) {
          defaultInvariantError = error.message;
        }
        await removeWorkspace(first.id);
        console.log(JSON.stringify({
          fallback,
          first,
          repeated,
          second,
          active,
          privateName,
          folderInvariantError,
          defaultInvariantError,
          remaining: getWorkspaces(),
        }));
      `
      const run = Bun.spawnSync([process.execPath, '--eval', script], {
        env: { ...process.env, BITLAB_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      expect(run.exitCode, run.stderr.toString()).toBe(0)
      const result = JSON.parse(run.stdout.toString())

      expect(result.fallback).toMatchObject({ id: 'default', slug: 'default', kind: 'default', folderPath: null })
      expect(result.fallback.dataRoot).toBe(join(configDir, 'workspaces', 'default'))
      expect(result.first.slug).toBe('abc')
      expect(result.repeated.id).toBe(result.first.id)
      expect(result.repeated.name).toBe('ABC Renamed')
      expect(result.active.name).toBe('ABC Renamed')
      expect(result.privateName).toBe('ABC Renamed')
      expect(result.folderInvariantError).toBe('Folder workspace requires a project folder path')
      expect(result.defaultInvariantError).toBe('Default workspace cannot have a project folder path')
      expect(result.second.slug).toMatch(/^abc-[a-f0-9]{8}$/)
      expect(result.second.dataRoot).toBe(join(configDir, 'workspaces', result.second.slug))
      expect(existsSync(firstProject)).toBe(true)
      expect(existsSync(result.first.dataRoot)).toBe(false)
      expect(existsSync(secondProject)).toBe(true)
      expect(existsSync(result.second.dataRoot)).toBe(true)

      const stored = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'))
      expect(stored.workspaces.every((workspace: Record<string, unknown>) => !('dataRoot' in workspace))).toBe(true)
      expect(stored.workspaces.some((workspace: { folderPath: string | null }) => workspace.folderPath === result.second.folderPath)).toBe(true)
    } finally {
      rmSync(dirname(configDir), { recursive: true, force: true })
    }
  })
})
