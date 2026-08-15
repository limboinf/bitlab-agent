/**
 * Per-turn grant acceptance tests (docs/skills-design.md acceptance 10 and 11).
 *
 * 10: a skill declaring `Bash(rm:*)` gets the declaration displayed and the
 *     call prompted anyway; in safe mode every grant is inert.
 * 11: a grant applies for the invoking turn and is gone on the next user
 *     message; re-invoking re-applies it. Unlisted tools keep prompting.
 */
import { describe, expect, it } from 'bun:test';
import { grantsToolCall, parseToolPatterns } from '../tool-grants.ts';

const patterns = (...declarations: string[]) => parseToolPatterns(declarations);

describe('pattern parsing', () => {
  it('accepts a bare tool name', () => {
    expect(grantsToolCall(patterns('Read'), 'Read', {})).toBe(true);
  });

  it('matches regardless of the casing an author used', () => {
    expect(grantsToolCall(patterns('read'), 'Read', {})).toBe(true);
    expect(grantsToolCall(patterns('BASH'), 'Bash', { command: 'ls' })).toBe(true);
  });

  it('ignores empty declarations', () => {
    expect(parseToolPatterns([])).toHaveLength(0);
    expect(parseToolPatterns(undefined)).toHaveLength(0);
    expect(grantsToolCall(patterns('  '), 'Read', {})).toBe(false);
  });
});

describe('argument prefixes', () => {
  it('grants a command family', () => {
    const declared = patterns('Bash(git:*)');

    expect(grantsToolCall(declared, 'Bash', { command: 'git status' })).toBe(true);
    expect(grantsToolCall(declared, 'Bash', { command: 'git commit -m "x"' })).toBe(true);
    expect(grantsToolCall(declared, 'Bash', { command: 'git' })).toBe(true);
  });

  it('does not leak past the prefix', () => {
    const declared = patterns('Bash(git:*)');

    // The prefix is a command, not a substring: `gitleaks` is a different one.
    expect(grantsToolCall(declared, 'Bash', { command: 'gitleaks detect' })).toBe(false);
    expect(grantsToolCall(declared, 'Bash', { command: 'rm -rf /' })).toBe(false);
    expect(grantsToolCall(declared, 'Bash', { command: 'echo git' })).toBe(false);
  });

  it('does not degrade into a bare-tool grant when there is no argument', () => {
    expect(grantsToolCall(patterns('Bash(git:*)'), 'Bash', {})).toBe(false);
  });

  it('treats a bare wildcard as granting the tool', () => {
    expect(grantsToolCall(patterns('Bash(*)'), 'Bash', { command: 'anything' })).toBe(true);
  });

  it('only reads arguments for bash', () => {
    // A file path is not a command; `Write(src:*)` must not read as a path grant.
    expect(grantsToolCall(patterns('Write(src:*)'), 'Write', { file_path: 'src/a.ts' })).toBe(false);
    expect(grantsToolCall(patterns('Write'), 'Write', { file_path: 'src/a.ts' })).toBe(true);
  });
});

describe('acceptance 11: unlisted tools keep prompting', () => {
  it('grants only what was declared', () => {
    const declared = patterns('Read', 'Bash(git:*)');

    expect(grantsToolCall(declared, 'Read', {})).toBe(true);
    expect(grantsToolCall(declared, 'Write', { file_path: 'a.ts' })).toBe(false);
    expect(grantsToolCall(declared, 'Edit', { file_path: 'a.ts' })).toBe(false);
    expect(grantsToolCall(declared, 'Bash', { command: 'npm publish' })).toBe(false);
  });
});
