export type CliDomainNamespace = 'workspace' | 'session' | 'connections' | 'config'

export interface CliDomainPolicy {
  namespace: CliDomainNamespace
  helpCommand: string
  workspacePathScopes: string[]
  readActions: string[]
  quickExamples: string[]
  /** Optional workspace-relative paths guarded for direct Bash operations */
  bashGuardPaths?: string[]
}

const POLICIES: Record<CliDomainNamespace, CliDomainPolicy> = {
  workspace: {
    namespace: 'workspace',
    helpCommand: 'bitlab --help',
    workspacePathScopes: [],
    readActions: ['list'],
    quickExamples: ['bitlab workspace list'],
  },
  session: {
    namespace: 'session',
    helpCommand: 'bitlab --help',
    workspacePathScopes: [],
    readActions: ['list', 'messages'],
    quickExamples: ['bitlab session list', 'bitlab session messages <id>'],
  },
  connections: {
    namespace: 'connections',
    helpCommand: 'bitlab --help',
    workspacePathScopes: [],
    readActions: ['list'],
    quickExamples: ['bitlab connections list'],
  },
  config: {
    namespace: 'config',
    helpCommand: 'bitlab --help',
    workspacePathScopes: [],
    readActions: ['validate'],
    quickExamples: ['bitlab config validate'],
  },
}

export const CLI_DOMAIN_POLICIES = POLICIES

export interface CliDomainScopeEntry {
  namespace: CliDomainNamespace
  scope: string
}

function dedupeScopes(scopes: string[]): string[] {
  return [...new Set(scopes)]
}

/**
 * Canonical workspace-relative path scopes owned by bitlab CLI domains.
 * Use these for file-path ownership checks to avoid drift across call sites.
 */
export const BITLAB_AGENTS_CLI_OWNED_WORKSPACE_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.workspacePathScopes)
)

/**
 * Canonical workspace-relative path scopes guarded for direct Bash operations.
 */
export const BITLAB_AGENTS_CLI_OWNED_BASH_GUARD_PATH_SCOPES = dedupeScopes(
  Object.values(POLICIES).flatMap(policy => policy.bashGuardPaths ?? [])
)

/**
 * Namespace-aware workspace scope entries for bitlab CLI owned paths.
 */
export const BITLAB_AGENTS_CLI_WORKSPACE_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => policy.workspacePathScopes.map(scope => ({ namespace: policy.namespace, scope })))

/**
 * Namespace-aware Bash guard scope entries.
 */
export const BITLAB_AGENTS_CLI_BASH_GUARD_SCOPE_ENTRIES: CliDomainScopeEntry[] = Object.values(POLICIES)
  .flatMap(policy => (policy.bashGuardPaths ?? []).map(scope => ({ namespace: policy.namespace, scope })))

export interface BashPatternRule {
  pattern: string
  comment: string
}

/**
 * Derive the canonical Explore-mode read-only bitlab bash patterns from
 * CLI domain policies. Keeps permissions regexes aligned with command metadata.
 */
export function getBitlabReadOnlyBashPatterns(): BashPatternRule[] {
  const namespaces = Object.keys(POLICIES) as CliDomainNamespace[]
  const namespaceAlternation = namespaces.join('|')

  const rules: BashPatternRule[] = namespaces.map((namespace) => {
    const policy = POLICIES[namespace]
    const actions = policy.readActions.join('|')
    return {
      pattern: `^bitlab\\s+${namespace}\\s+(${actions})\\b`,
      comment: `bitlab ${namespace} read-only operations`,
    }
  })

  rules.push(
    { pattern: '^bitlab\\s*$', comment: 'bitlab bare invocation (prints help)' },
    { pattern: `^bitlab\\s+(${namespaceAlternation})\\s*$`, comment: 'bitlab entity help' },
    { pattern: `^bitlab\\s+(${namespaceAlternation})\\s+--help\\b`, comment: 'bitlab entity help flags' },
    { pattern: '^bitlab\\s+--(help|version|discover)\\b', comment: 'bitlab global flags' },
  )

  return rules
}

export function getCliDomainPolicy(namespace: CliDomainNamespace): CliDomainPolicy {
  return POLICIES[namespace]
}
