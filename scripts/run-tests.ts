#!/usr/bin/env bun

// pi-agent-mcp.e2e.test.ts spawns the real pi-agent-server bundle, and `dist/` is
// gitignored — a fresh clone (CI included) has nothing to spawn. Rebuilding takes
// well under a second and also keeps the bundle in sync with the sources under test.
const bundle = Bun.spawnSync(['bun', 'run', 'build'], {
  cwd: new URL('../packages/pi-agent-server/', import.meta.url).pathname,
  stdout: 'inherit',
  stderr: 'inherit',
})
if (bundle.exitCode !== 0) {
  throw new Error('Unable to build the pi-agent-server bundle required by the e2e tests')
}

const sourceRoots = ['apps', 'packages', 'scripts']
const tracked = Bun.spawnSync(
  ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...sourceRoots],
  { stdout: 'pipe', stderr: 'pipe' },
)

if (tracked.exitCode !== 0) {
  throw new Error(`Unable to discover Bitlab tests: ${tracked.stderr.toString().trim()}`)
}

const files = tracked.stdout.toString().split('\0').filter(Boolean)
// Files that cannot share a `bun test` process with the rest of the suite.
const SERIAL_TESTS = new Set([
  'packages/shared/src/agent/__tests__/pi-conversation-flow.integration.test.ts',
  // bun's mock.module() is process-wide and leaks across files. browser-pane-manager
  // .test.ts replaces ../browser-cdp with a stub that never attaches a debugger, which
  // is what this file would import if they ran together.
  'apps/electron/src/main/__tests__/browser-cdp.test.ts',
])
const tests = files.filter(
  file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !SERIAL_TESTS.has(file),
)
const isolatedTests = files.filter(
  file => file.endsWith('.isolated.ts') || SERIAL_TESTS.has(file),
)

function runTests(testFiles: string[]): void {
  if (testFiles.length === 0) return
  const result = Bun.spawnSync([process.execPath, 'test', ...testFiles], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) process.exit(result.exitCode)
}

console.log(`Running ${tests.length} Bitlab test files`)
runTests(tests)

for (const file of isolatedTests) {
  console.log(`Running isolated test: ${file}`)
  runTests([`./${file}`])
}
