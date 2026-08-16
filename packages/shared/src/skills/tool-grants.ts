/**
 * Per-turn tool grants declared by an activated skill.
 *
 * Claude Code's semantics, adopted verbatim because Bitlab uses the same skill
 * format and diverging would surprise anyone carrying skills between the two
 * (docs/skills-design.md §5.10):
 *
 *   - the grant covers the turn that invoked the skill, and clears when the
 *     user sends the next message;
 *   - it only widens. Tools that are not listed keep their normal prompts, and
 *     nothing here can turn a refusal into an allowance;
 *   - deny paths still win. Safe mode blocks writes outright and never reaches
 *     the prompt decision, and dangerous commands stay prompted regardless.
 *
 * `disallowed-tools` is the narrowing counterpart — not in the spec, but Claude
 * Code supports it and a skill that says which tools it has no business calling
 * is worth honouring. It refuses the call outright, and it is checked before
 * any grant, so a skill cannot allow and disallow its way past itself.
 *
 * Patterns are the spec's own: a bare tool name (`Read`), or a tool with an
 * argument prefix (`Bash(git:*)`). Names match the SDK's canonical casing,
 * which is what the permission engine sees.
 */

/** One parsed `allowed-tools` entry. */
interface ToolPattern {
  tool: string;
  /** Argument prefix for `Tool(prefix:*)` forms; absent means the bare tool. */
  argumentPrefix?: string;
}

function parsePattern(raw: string): ToolPattern | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const parenthesised = /^([A-Za-z_][\w-]*)\(([^)]*)\)$/.exec(trimmed);
  if (!parenthesised) return { tool: trimmed.toLowerCase() };

  const argument = parenthesised[2]!.trim();
  // `git:*` and `git:` both mean "any git command"; a bare `*` means any
  // argument at all, which is the same as granting the tool outright.
  const prefix = argument.replace(/\*+$/, '').replace(/:$/, '');
  return {
    tool: parenthesised[1]!.toLowerCase(),
    ...(prefix ? { argumentPrefix: prefix.toLowerCase() } : {}),
  };
}

/** Parse an `allowed-tools` declaration into matchable patterns. */
export function parseToolPatterns(declarations: readonly string[] | undefined): ToolPattern[] {
  if (!declarations?.length) return [];
  return declarations.map(parsePattern).filter((pattern): pattern is ToolPattern => pattern !== null);
}

/**
 * The value an argument prefix is matched against. Only bash carries one
 * meaningfully — a file tool's path is not a command, and treating it as one
 * would let `Write(src:*)` read as a path grant it was never defined to be.
 */
function argumentFor(toolName: string, input: Record<string, unknown>): string | undefined {
  if (toolName.toLowerCase() !== 'bash') return undefined;
  return typeof input.command === 'string' ? input.command.trim().toLowerCase() : undefined;
}

/**
 * Whether the declared patterns cover this call.
 *
 * A pattern with an argument prefix only ever matches a tool that has an
 * argument to compare; it never degrades into a bare-tool grant.
 */
export function grantsToolCall(
  patterns: readonly ToolPattern[],
  toolName: string,
  input: Record<string, unknown>
): boolean {
  if (!patterns.length) return false;
  const tool = toolName.toLowerCase();
  const argument = argumentFor(toolName, input);

  return patterns.some((pattern) => {
    if (pattern.tool !== tool) return false;
    if (!pattern.argumentPrefix) return true;
    if (argument === undefined) return false;
    return argument === pattern.argumentPrefix || argument.startsWith(`${pattern.argumentPrefix} `);
  });
}

export type { ToolPattern };
