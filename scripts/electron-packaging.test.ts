import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf-8')

describe('Electron packaging', () => {
  it('stages ripgrep from its platform package at the runtime path', () => {
    const copyAssets = read('apps/electron/scripts/copy-assets.ts')
    const builder = read('apps/electron/electron-builder.yml')

    expect(copyAssets).toContain('`ripgrep-${targetPlatform}-${targetArch}`')
    expect(builder).toContain('from: vendor/ripgrep/bin')
    expect(builder).toContain('to: app/node_modules/@vscode/ripgrep/bin')
  })

  it('uses valid and consistent Linux executable and desktop names', () => {
    const metadata = JSON.parse(read('apps/electron/package.json'))
    const builder = read('apps/electron/electron-builder.yml')

    expect(metadata.desktopName).toBe('bitlab.desktop')
    expect(builder).toContain('executableName: bitlab')
    expect(builder).toContain('syncDesktopName: true')
    expect(builder).not.toContain('  desktopName:')
  })
})
