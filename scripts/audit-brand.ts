#!/usr/bin/env bun

/**
 * Brand audit for shipped source.
 *
 * Bitlab is a derivative of Craft Agents OSS. Upstream brand strings are legal
 * attribution in NOTICE, LICENSE, and docs/, but inside code, build scripts, and
 * packaged resources they are leakage: a wrong scope, URL scheme, config root, or
 * env prefix reaching an installer is a user-visible bug.
 *
 * This replaces the removed `audit:craft-reuse` lineage audit. That one compared
 * hashes against an upstream checkout; this one only asks whether what we ship
 * still says someone else's name.
 *
 * Add `bitlab-brand-audit-ignore` to a line to exempt it (tests that assert the
 * absence of a brand string legitimately have to contain it).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dir, '..')

/** Substitutions from docs/upstream-sync.md, checked as literal substrings. */
const forbidden = [
  { pattern: '@craft-agent/', use: '@bitlab/' },
  { pattern: 'craftagents://', use: 'bitlab://' },
  { pattern: '.craft-agent', use: '.bitlab' },
  { pattern: 'CRAFT_AGENT_', use: 'BITLAB_' },
  { pattern: 'Craft Agents', use: 'Bitlab' },
  { pattern: 'Craft-Agents', use: 'Bitlab' },
  { pattern: 'Craft Docs', use: 'Bitlab contributors' },
]

/**
 * Everything here is compiled into the app, copied into an installer, or decides
 * what an installer is named. Prose written for readers — NOTICE, LICENSE, docs/,
 * README, issue templates — legitimately names the upstream project and is not
 * scanned.
 */
const roots = ['apps', 'packages', 'scripts', '.github/workflows']

const skipDirectories = new Set([
  'node_modules', 'dist', 'out', 'build', 'release', 'vendor',
  'coverage', '__pycache__', '.vite', '.git', '.turbo',
])

const scannedExtensions = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.yml', '.yaml',
  '.sh', '.ps1', '.py', '.md', '.html', '.css', '.plist', '.txt', '.env',
])

const exemptComment = 'bitlab-brand-audit-ignore'

/** This file spells out every pattern by definition. */
const selfPath = import.meta.path

function* walk(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (skipDirectories.has(entry.name)) continue
      yield* walk(path)
    } else if (entry.isFile() && scannedExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      yield path
    }
  }
}

type Violation = { file: string; line: number; text: string; use: string }

const violations: Violation[] = []
let scanned = 0

for (const name of roots) {
  const base = join(root, name)
  try {
    if (!statSync(base).isDirectory()) continue
  } catch {
    continue
  }
  for (const path of walk(base)) {
    if (path === selfPath) continue
    scanned += 1
    const lines = readFileSync(path, 'utf8').split('\n')
    lines.forEach((text, index) => {
      if (text.includes(exemptComment)) return
      for (const { pattern, use } of forbidden) {
        if (!text.includes(pattern)) continue
        violations.push({
          file: relative(root, path),
          line: index + 1,
          text: text.trim().slice(0, 120),
          use: `${pattern} → ${use}`,
        })
      }
    })
  }
}

if (violations.length > 0) {
  console.error(`Brand audit failed: ${violations.length} upstream brand string(s) in shipped source.\n`)
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  [${violation.use}]`)
    console.error(`    ${violation.text}`)
  }
  console.error('\nAttribution belongs in NOTICE, LICENSE, and docs/ — not in code or installers.')
  console.error(`Append \`${exemptComment}\` to a line that must keep the string.`)
  process.exit(1)
}

console.log(`Brand audit passed: ${scanned} files, no upstream brand strings in shipped source.`)
