/**
 * McpSettingsPage
 *
 * Settings page for MCP (Model Context Protocol) servers, laid out as a
 * connector console:
 * - Header area: description, server search, add button.
 * - Overview tiles: installed / running / available tools, derived from the
 *   current list (see mcp-derive.ts — no extra backend calls).
 * - Tabs: Installed (two-column card grid, click a card to expand its detail
 *   across the full row — only one detail open at a time), Discovered
 *   (project `.mcp.json` approval + other apps' config import) and Global
 *   settings (approval gate, direct tools, default lifecycle).
 * - Add/edit via form or pasted `{ "mcpServers": { ... } }` JSON block.
 *
 * Tab switches are pure client-side presentation; the underlying `mcp:*` RPC
 * CRUD, discovery and status-snapshot behavior is unchanged. All mutations
 * are followed by a re-list; the `mcp:changed` broadcast covers refreshes
 * triggered elsewhere.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AnimatePresence, motion } from 'motion/react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Globe,
  LogOut,
  Pencil,
  Plug,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'

import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { routes } from '@/lib/navigate'
import { cn } from '@/lib/utils'
import { useActiveWorkspace } from '@/context/AppShellContext'
import {
  SettingsCard,
  SettingsInput,
  SettingsMenuSelectRow,
  SettingsSegmentedControl,
  SettingsTextarea,
  SettingsToggle,
} from '@/components/settings'
import {
  DEFAULT_MCP_SETTINGS,
  isValidMcpServerName,
  mcpServerId,
  normalizeMcpRequestTimeout,
} from '@bitlab/shared/config/mcp'
import type {
  BitlabMcpServer,
  BitlabMcpSettings,
  DiscoveredHostConfig,
  DiscoveredMcpServer,
  McpLifecycle,
  McpOperationResult,
  McpSessionStatusDto,
} from '@bitlab/shared/config'
import {
  getMcpApi,
  type McpApi,
  type McpCredentialStatus,
  type McpDiscoverResult,
  type McpListResult,
  type McpTestResult,
} from '@/lib/mcp-rpc'
import {
  countRunningServers,
  filterServers,
  humanizeMcpMessage,
  mcpOperationErrorKey,
  mergeServerDisplays,
  sumAvailableTools,
  transportSummary,
  type McpDisplayStatus,
  type McpServerDisplay,
} from '@/lib/mcp-derive'

const LIFECYCLES: readonly McpLifecycle[] = ['lazy', 'lazy-keep-alive', 'eager', 'keep-alive']
const TAB_FADE = { duration: 0.15, ease: [0.4, 0, 0.2, 1] } as const

type McpView = 'installed' | 'discovered' | 'global'

// ============================================
// Small formatting / parsing helpers
// ============================================

/** Host label for discovered/import rows. */
function discoveredSummary(discovered: DiscoveredMcpServer): string {
  const t = discovered.transport
  if (t.type === 'stdio') return [t.command, ...(t.args ?? [])].filter(Boolean).join(' ')
  try {
    return new URL(t.url).host
  } catch {
    return t.url
  }
}

/** Non-empty lines of a textarea (one arg per line). */
function parseLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/** `KEY=value` / `Key: value` lines → record. Malformed lines are dropped. */
function parseKeyValueBlock(text: string, sep: ':' | '='): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const idx = line.indexOf(sep)
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function recordToKeyValueBlock(record: Record<string, string> | undefined, sep: string): string {
  if (!record) return ''
  return Object.entries(record)
    .map(([key, value]) => `${key}${sep}${value}`)
    .join('\n')
}

/** Comma-separated glob list ↔ string editor value. */
function globsToText(globs: string[] | undefined): string {
  return globs?.join(', ') ?? ''
}

/** ms ↔ the seconds shown in the timeout field ('' means "use the default"). */
function secondsFieldValue(ms: number | undefined): string {
  return typeof ms === 'number' && ms > 0 ? String(Math.round(ms / 1000)) : ''
}

function secondsFieldToMs(text: string): number | undefined {
  const seconds = Number(text.trim())
  if (!text.trim() || !Number.isFinite(seconds) || seconds <= 0) return undefined
  return normalizeMcpRequestTimeout(Math.round(seconds * 1000), 0) || undefined
}

function textToGlobs(text: string): string[] | undefined {
  const parsed = text
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
  return parsed.length ? parsed : undefined
}

// ============================================
// Status dot
// ============================================

const STATUS_DOT_CLASS: Record<McpDisplayStatus, string> = {
  connected: 'bg-emerald-500',
  cached: 'bg-emerald-500',
  'needs-auth': 'bg-amber-500',
  failed: 'bg-red-500',
  'not-connected': 'bg-muted-foreground/40',
  disabled: 'bg-muted-foreground/30',
  unknown: 'bg-muted-foreground/40',
}

function statusLabelKey(status: McpDisplayStatus): string {
  return `settings.mcp.status.${status}`
}

/** Display statuses that mean the server has a usable connection. */
const SIGNED_IN_STATUSES = new Set<McpDisplayStatus>(['connected', 'cached'])

// ============================================
// Overview stat tile
// ============================================

function StatTile({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl bg-background shadow-minimal px-4 py-3 min-w-0">
      <div className="text-lg font-semibold tabular-nums leading-tight">{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5 truncate">{label}</div>
    </div>
  )
}

// ============================================
// Server card
// ============================================

type TestState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'ok'; result: Extract<McpTestResult, { ok: true }> }
  | { state: 'error'; message: string; needsAuth: boolean }

type AuthState =
  | { state: 'idle' }
  | { state: 'signing' }
  | { state: 'ok' }
  | { state: 'error'; message: string }

/** Sign-out / reconnect share one slot: both are short, one-line outcomes. */
type ActionState =
  | { state: 'idle' }
  | { state: 'running'; label: string }
  | { state: 'done'; message: string; ok: boolean }

interface McpServerCardProps {
  server: BitlabMcpServer
  display: McpServerDisplay | undefined
  globalSettings: BitlabMcpSettings
  api: McpApi
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onMutate: (updater: (server: BitlabMcpServer) => BitlabMcpServer) => void
  onEdit: () => void
  onDelete: () => void
}

function McpServerCard({
  server,
  display,
  globalSettings,
  api,
  expanded,
  onExpandedChange,
  onMutate,
  onEdit,
  onDelete,
}: McpServerCardProps) {
  const { t } = useTranslation()
  const [test, setTest] = useState<TestState>({ state: 'idle' })
  const [auth, setAuth] = useState<AuthState>({ state: 'idle' })
  const [action, setAction] = useState<ActionState>({ state: 'idle' })
  const [credential, setCredential] = useState<McpCredentialStatus | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [includeText, setIncludeText] = useState(() => globsToText(server.includeTools))
  const [excludeText, setExcludeText] = useState(() => globsToText(server.excludeTools))
  const [approveText, setApproveText] = useState(() => globsToText(server.approveTools))
  const [timeoutText, setTimeoutText] = useState(() => secondsFieldValue(server.requestTimeoutMs))

  /**
   * Read the adapter's outcome in the user's language, falling back to the
   * adapter's own prose (cleaned of the instructions it writes for the model).
   */
  const describeOutcome = useCallback((result: McpOperationResult, fallbackKey: string): string => {
    const key = mcpOperationErrorKey(result.code)
    if (key) return t(key)
    const message = humanizeMcpMessage(result.message ?? '')
    return message || t(fallbackKey)
  }, [t])

  // Effective runtime status: a disabled server is displayed as disabled even
  // if a stale snapshot still reports a live state, and a server nothing has
  // ever reported on is `unknown` rather than a guessed `not-connected`.
  const effectiveStatus: McpDisplayStatus = server.enabled
    ? (display?.status ?? 'unknown')
    : 'disabled'

  const toolCount = server.enabled ? display?.toolCount : undefined

  const handleTest = useCallback(async () => {
    setTest({ state: 'testing' })
    setShowTools(false)
    try {
      const result = await api.test(server)
      if (result && result.ok) {
        setTest({ state: 'ok', result })
      } else {
        // `needs-auth` is a sign-in prompt, not a broken server — the backend
        // separates the two deliberately, so the card must not flatten them.
        setTest({
          state: 'error',
          message: (result && !result.ok && result.error) || t('settings.mcp.test.failed'),
          needsAuth: result?.status === 'needs-auth',
        })
      }
    } catch (error) {
      setTest({
        state: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.test.failed'),
        needsAuth: false,
      })
    }
  }, [api, server, t])

  const canAuth = server.transport.type === 'http' && server.enabled
  // Credentials on disk are the honest answer to "am I signed in"; a live
  // connection or a sign-in that just succeeded are the earlier evidence.
  const signedIn = credential?.status === 'present'
    || auth.state === 'ok'
    || (credential === null && SIGNED_IN_STATUSES.has(effectiveStatus))

  const refreshCredential = useCallback(async () => {
    if (!api.credentials || server.transport.type !== 'http') return
    try {
      setCredential(await api.credentials({ id: server.id }))
    } catch {
      // A credential badge is decoration; its absence must not break the card.
      setCredential(null)
    }
  }, [api, server.id, server.transport.type])

  // Only when the detail is open: one subprocess round-trip per expanded card,
  // not one per server on every list render.
  useEffect(() => {
    if (expanded) void refreshCredential()
  }, [expanded, refreshCredential])

  const handleAuth = useCallback(async () => {
    setAuth({ state: 'signing' })
    setAction({ state: 'idle' })
    try {
      const result = await api.auth({ id: server.id })
      if (result?.ok) {
        setAuth({ state: 'ok' })
      } else {
        setAuth({ state: 'error', message: describeOutcome(result, 'settings.mcp.auth.failed') })
      }
    } catch (error) {
      setAuth({
        state: 'error',
        message: error instanceof Error ? error.message : t('settings.mcp.auth.failed'),
      })
    } finally {
      void refreshCredential()
    }
  }, [api, describeOutcome, refreshCredential, server.id, t])

  const handleCancelAuth = useCallback(async () => {
    await api.cancelAuth?.()
    // The in-flight auth call settles on its own with a `cancelled` outcome.
  }, [api])

  const handleSignOut = useCallback(async () => {
    if (!api.signOut) return
    setAuth({ state: 'idle' })
    setAction({ state: 'running', label: t('settings.mcp.auth.signingOut') })
    try {
      const result = await api.signOut({ id: server.id })
      setAction({
        state: 'done',
        ok: result?.ok === true,
        message: result?.ok ? t('settings.mcp.auth.signedOut') : describeOutcome(result, 'settings.mcp.auth.signOutFailed'),
      })
    } catch (error) {
      setAction({
        state: 'done',
        ok: false,
        message: error instanceof Error ? error.message : t('settings.mcp.auth.signOutFailed'),
      })
    } finally {
      void refreshCredential()
    }
  }, [api, describeOutcome, refreshCredential, server.id, t])

  const handleReconnect = useCallback(async () => {
    if (!api.reconnect) return
    setAction({ state: 'running', label: t('settings.mcp.reconnect.running') })
    try {
      const result = await api.reconnect({ id: server.id })
      setAction({
        state: 'done',
        ok: result?.ok === true,
        message: result?.ok ? t('settings.mcp.reconnect.ok') : describeOutcome(result, 'settings.mcp.reconnect.failed'),
      })
    } catch (error) {
      setAction({
        state: 'done',
        ok: false,
        message: error instanceof Error ? error.message : t('settings.mcp.reconnect.failed'),
      })
    }
  }, [api, describeOutcome, server.id, t])

  return (
    <div className={cn('min-w-0', expanded && 'md:col-span-2')}>
      <SettingsCard divided={false}>
      <button
        type="button"
        onClick={() => onExpandedChange(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-foreground/[0.02] transition-colors text-left"
      >
        <span
          className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT_CLASS[effectiveStatus])}
          title={t(statusLabelKey(effectiveStatus))}
          aria-label={t(statusLabelKey(effectiveStatus))}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn('text-sm font-medium truncate', !server.enabled && 'text-muted-foreground')}>
              {server.name}
            </span>
            <span className="inline-flex items-center h-5 px-2 text-[11px] font-medium rounded-[4px] bg-background shadow-minimal text-foreground/60 shrink-0">
              {t(`settings.mcp.source.${server.source}`)}
            </span>
            <span
              className="text-[11px] text-muted-foreground shrink-0"
              {...(display?.cached && server.enabled
                ? { title: t('settings.mcp.status.rememberedHint') }
                : {})}
            >
              {t(statusLabelKey(effectiveStatus))}
              {display?.cached && server.enabled ? ` · ${t('settings.mcp.status.remembered')}` : ''}
            </span>
          </div>
          <div className="text-xs text-muted-foreground truncate">
            {transportSummary(server)}
            {toolCount !== undefined && (
              <>
                {' · '}
                {t('settings.mcp.server.toolCount', { count: toolCount })}
              </>
            )}
          </div>
        </div>
        <span
          className="flex items-center gap-2 shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          <Switch
            checked={server.enabled}
            onCheckedChange={(checked) => onMutate((s) => ({ ...s, enabled: checked }))}
            aria-label={t('settings.mcp.server.enable')}
          />
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t border-border/50 divide-y divide-border/50">
              <SettingsToggle
                label={t('settings.mcp.server.trusted')}
                description={t('settings.mcp.server.trustedDesc')}
                checked={server.trusted}
                onCheckedChange={(checked) => onMutate((s) => ({ ...s, trusted: checked }))}
              />
              <SettingsToggle
                label={t('settings.mcp.server.directTools')}
                description={t('settings.mcp.server.directToolsDesc')}
                checked={server.directTools ?? globalSettings.directTools}
                onCheckedChange={(checked) => onMutate((s) => ({ ...s, directTools: checked }))}
              />
              <SettingsMenuSelectRow
                label={t('settings.mcp.server.lifecycle')}
                description={t('settings.mcp.server.lifecycleDesc')}
                value={server.lifecycle ?? 'default'}
                onValueChange={(value) =>
                  onMutate((s) => ({
                    ...s,
                    ...(value === 'default'
                      ? { lifecycle: undefined }
                      : { lifecycle: value as McpLifecycle }),
                  }))
                }
                options={[
                  {
                    value: 'default',
                    label: t('settings.mcp.lifecycle.default'),
                    description: t('settings.mcp.server.lifecycleDefaultDesc'),
                  },
                  ...LIFECYCLES.map((lifecycle) => ({
                    value: lifecycle,
                    label: t(`settings.mcp.lifecycle.${lifecycle}`),
                    description: t(`settings.mcp.lifecycleDesc.${lifecycle}`),
                  })),
                ]}
              />
              <div className="px-4 py-3.5 space-y-3">
                <SettingsInput
                  label={t('settings.mcp.server.includeTools')}
                  description={t('settings.mcp.server.includeToolsDesc')}
                  value={includeText}
                  onChange={setIncludeText}
                  onBlur={() => onMutate((s) => ({ ...s, includeTools: textToGlobs(includeText) }))}
                  placeholder="github__*"
                />
                <SettingsInput
                  label={t('settings.mcp.server.excludeTools')}
                  description={t('settings.mcp.server.excludeToolsDesc')}
                  value={excludeText}
                  onChange={setExcludeText}
                  onBlur={() => onMutate((s) => ({ ...s, excludeTools: textToGlobs(excludeText) }))}
                  placeholder="internal_*"
                />
                {/* Only meaningful on a trusted server: it carves exceptions
                    out of "never ask". An untrusted server already asks. */}
                {server.trusted && (
                  <SettingsInput
                    label={t('settings.mcp.server.approveTools')}
                    description={t('settings.mcp.server.approveToolsDesc')}
                    value={approveText}
                    onChange={setApproveText}
                    onBlur={() => onMutate((s) => ({ ...s, approveTools: textToGlobs(approveText) }))}
                    placeholder="*write*, *delete*"
                  />
                )}
                <SettingsInput
                  label={t('settings.mcp.server.requestTimeout')}
                  description={t('settings.mcp.server.requestTimeoutDesc', {
                    seconds: Math.round((globalSettings.requestTimeoutMs || 0) / 1000),
                  })}
                  value={timeoutText}
                  onChange={setTimeoutText}
                  onBlur={() => {
                    const requestTimeoutMs = secondsFieldToMs(timeoutText)
                    setTimeoutText(secondsFieldValue(requestTimeoutMs))
                    onMutate((s) => ({ ...s, requestTimeoutMs }))
                  }}
                  placeholder={t('settings.mcp.server.requestTimeoutPlaceholder')}
                />
                {server.originPath && (
                  <div className="text-xs text-muted-foreground truncate" title={server.originPath}>
                    <span className="text-foreground/60">{t('settings.mcp.server.origin')}:</span>{' '}
                    {server.originPath}
                  </div>
                )}
                {/* Inline test result */}
                {test.state === 'ok' && (
                  <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span className="flex-1">
                        {t('settings.mcp.test.ok', { count: test.result.toolCount })}
                      </span>
                      {test.result.tools.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowTools(!showTools)}
                          className="underline underline-offset-2 hover:text-foreground transition-colors"
                        >
                          {showTools
                            ? t('settings.mcp.test.hideTools')
                            : t('settings.mcp.test.showTools')}
                        </button>
                      )}
                    </div>
                    {showTools && (
                      <ul className="mt-2 space-y-1 max-h-32 overflow-y-auto font-mono">
                        {test.result.tools.map((tool) => (
                          <li key={tool.name} className="truncate" title={tool.description ?? tool.name}>
                            {tool.name}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                {test.state === 'error' && test.needsAuth && (
                  <div className="rounded-md bg-amber-500/5 border border-amber-500/20 px-3 py-2 text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{t('settings.mcp.test.needsAuth')}</span>
                  </div>
                )}
                {test.state === 'error' && !test.needsAuth && (
                  <div className="rounded-md bg-red-500/5 border border-red-500/20 px-3 py-2 text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
                    <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-all">
                      {t('settings.mcp.test.failed')}: {test.message}
                    </span>
                  </div>
                )}
                {/* What the credential store actually holds — the honest
                    answer to "am I signed in", independent of any connection. */}
                {canAuth && credential?.status === 'present' && auth.state !== 'signing' && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500 shrink-0" />
                    <span>
                      {t('settings.mcp.auth.credentialStored')}
                      {credential.expiresAt
                        ? ` · ${t('settings.mcp.auth.credentialExpires', {
                            time: new Date(credential.expiresAt * 1000).toLocaleString(),
                          })}`
                        : ''}
                    </span>
                  </div>
                )}
                {canAuth && credential?.status === 'unavailable' && (
                  <div className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span>{t('settings.mcp.auth.credentialUnavailable')}</span>
                  </div>
                )}
                {/* OAuth sign-in feedback */}
                {auth.state === 'signing' && (
                  <div className="rounded-md bg-blue-500/5 border border-blue-500/20 px-3 py-2 text-xs text-blue-700 dark:text-blue-400 flex items-start gap-1.5">
                    <Globe className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="flex-1">{t('settings.mcp.auth.browserHint')}</span>
                    {api.cancelAuth && (
                      <button
                        type="button"
                        onClick={handleCancelAuth}
                        className="underline underline-offset-2 hover:text-foreground transition-colors shrink-0"
                      >
                        {t('common.cancel')}
                      </button>
                    )}
                  </div>
                )}
                {action.state === 'running' && (
                  <div className="rounded-md bg-blue-500/5 border border-blue-500/20 px-3 py-2 text-xs text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
                    <RefreshCcw className="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <span>{action.label}</span>
                  </div>
                )}
                {action.state === 'done' && (
                  <div className={cn(
                    'rounded-md px-3 py-2 text-xs flex items-start gap-1.5 border',
                    action.ok
                      ? 'bg-emerald-500/5 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
                      : 'bg-red-500/5 border-red-500/20 text-red-600 dark:text-red-400',
                  )}>
                    {action.ok
                      ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                    <span className="break-all">{action.message}</span>
                  </div>
                )}
                {auth.state === 'ok' && (
                  <div className="rounded-md bg-emerald-500/5 border border-emerald-500/20 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>{t('settings.mcp.auth.success')}</span>
                  </div>
                )}
                {auth.state === 'error' && (
                  <div className="rounded-md bg-red-500/5 border border-red-500/20 px-3 py-2 text-xs text-red-600 dark:text-red-400 flex items-start gap-1.5">
                    <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="break-all">
                      {t('settings.mcp.auth.failed')}: {auth.message}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 px-4 py-2.5 flex-wrap">
                <Button
                  size="sm"
                  variant="default"
                  className="h-7 gap-1.5"
                  onClick={handleTest}
                  disabled={test.state === 'testing'}
                >
                  {test.state === 'testing' ? (
                    t('settings.mcp.test.testing')
                  ) : (
                    <>
                      <RefreshCcw className="h-3.5 w-3.5" />
                      {t('settings.mcp.test.run')}
                    </>
                  )}
                </Button>
                {server.enabled && api.reconnect && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
                    onClick={handleReconnect}
                    disabled={action.state === 'running'}
                  >
                    <Plug className="h-3.5 w-3.5" />
                    {t('settings.mcp.reconnect.run')}
                  </Button>
                )}
                {canAuth && (
                  <Button
                    size="sm"
                    variant={effectiveStatus === 'needs-auth' ? 'default' : 'ghost'}
                    className={
                      effectiveStatus === 'needs-auth'
                        ? 'h-7 gap-1.5'
                        : 'h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10'
                    }
                    onClick={handleAuth}
                    disabled={auth.state === 'signing'}
                  >
                    {auth.state === 'signing' ? (
                      t('settings.mcp.auth.signing')
                    ) : (
                      <>
                        <Globe className="h-3.5 w-3.5" />
                        {/* A signed-in server keeps the entry as a re-sign-in
                            (token expiry, account switch) — labelled so it does
                            not read as "you are not signed in". */}
                        {effectiveStatus === 'needs-auth'
                          ? t('settings.mcp.auth.signInNeeded')
                          : signedIn
                            ? t('settings.mcp.auth.signInAgain')
                            : t('settings.mcp.auth.signIn')}
                      </>
                    )}
                  </Button>
                )}
                {canAuth && signedIn && api.signOut && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
                    onClick={handleSignOut}
                    disabled={action.state === 'running'}
                  >
                    <LogOut className="h-3.5 w-3.5" />
                    {t('settings.mcp.auth.signOut')}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
                  onClick={onEdit}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('common.edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </SettingsCard>
    </div>
  )
}

// ============================================
// Add / Edit dialog
// ============================================

type TransportType = 'stdio' | 'http'

interface FormState {
  name: string
  transportType: TransportType
  command: string
  argsText: string
  envText: string
  url: string
  headersText: string
}

const EMPTY_FORM: FormState = {
  name: '',
  transportType: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
}

function formStateFromServer(server: BitlabMcpServer): FormState {
  const t = server.transport
  return {
    name: server.name,
    transportType: t.type,
    ...(t.type === 'stdio'
      ? {
          command: t.command,
          argsText: (t.args ?? []).join('\n'),
          envText: recordToKeyValueBlock(t.env, '='),
        }
      : {
          url: t.url,
          headersText: recordToKeyValueBlock(t.headers, ': '),
        }),
  } as FormState
}

interface ParsedJsonEntry {
  name: string
  transport: BitlabMcpServer['transport']
}

/**
 * Parse a standard `{ "mcpServers": { "<name>": { command?|url?, ... } } }`
 * block. Mirrors the shared package's discovery parsing rules client-side.
 */
function parseMcpJsonBlock(text: string): { entries: ParsedJsonEntry[]; error?: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], error: error instanceof Error ? error.message : String(error) }
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { entries: [] }
  }
  const entries: ParsedJsonEntry[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as {
      command?: unknown
      args?: unknown
      env?: unknown
      url?: unknown
      headers?: unknown
    }
    if (typeof entry.url === 'string' && /^https?:\/\//.test(entry.url)) {
      const headers =
        entry.headers && typeof entry.headers === 'object' && !Array.isArray(entry.headers)
          ? Object.fromEntries(Object.entries(entry.headers as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined
      entries.push({
        name,
        transport: { type: 'http', url: entry.url, ...(headers ? { headers } : {}) },
      })
    } else if (typeof entry.command === 'string' && entry.command.trim()) {
      entries.push({
        name,
        transport: {
          type: 'stdio',
          command: entry.command,
          ...(Array.isArray(entry.args) ? { args: entry.args.map(String) } : {}),
          ...(entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
            ? {
                env: Object.fromEntries(
                  Object.entries(entry.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]),
                ),
              }
            : {}),
        },
      })
    }
  }
  return { entries }
}

interface McpServerFormDialogProps {
  open: boolean
  /** Existing server when editing; null when adding. */
  editing: BitlabMcpServer | null
  existingNames: Set<string>
  api: McpApi
  onClose: () => void
  onSaved: () => void
}

function McpServerFormDialog({ open, editing, existingNames, api, onClose, onSaved }: McpServerFormDialogProps) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'form' | 'json'>('form')
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [jsonText, setJsonText] = useState('')
  const [saving, setSaving] = useState(false)

  // Reset local state each time the dialog opens for a specific target.
  useEffect(() => {
    if (!open) return
    setMode('form')
    setJsonText('')
    setSaving(false)
    setForm(editing ? formStateFromServer(editing) : EMPTY_FORM)
  }, [open, editing])

  const parsedJson = useMemo(() => (jsonText.trim() ? parseMcpJsonBlock(jsonText) : { entries: [] }), [jsonText])

  const nameError = useMemo(() => {
    const name = form.name.trim()
    if (!name) return undefined
    if (!isValidMcpServerName(name)) return t('settings.mcp.add.nameInvalid')
    if (name !== editing?.name && existingNames.has(name)) return t('settings.mcp.add.nameTaken')
    return undefined
  }, [form.name, editing, existingNames, t])

  const formValid =
    !nameError &&
    form.name.trim().length > 0 &&
    (form.transportType === 'stdio'
      ? form.command.trim().length > 0
      : /^https?:\/\//.test(form.url.trim()))

  const updateForm = useCallback((patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }))
  }, [])

  const handleSaveForm = useCallback(async () => {
    if (!formValid) return
    const name = form.name.trim()
    const transport: BitlabMcpServer['transport'] =
      form.transportType === 'stdio'
        ? {
            type: 'stdio',
            command: form.command.trim(),
            ...(parseLines(form.argsText).length ? { args: parseLines(form.argsText) } : {}),
            ...(Object.keys(parseKeyValueBlock(form.envText, '=')).length
              ? { env: parseKeyValueBlock(form.envText, '=') }
              : {}),
          }
        : {
            type: 'http',
            url: form.url.trim(),
            ...(Object.keys(parseKeyValueBlock(form.headersText, ':')).length
              ? { headers: parseKeyValueBlock(form.headersText, ':') }
              : {}),
          }

    const base: BitlabMcpServer = editing
      ? { ...editing, name, transport }
      : {
          id: mcpServerId(name),
          name,
          enabled: true,
          trusted: false,
          transport,
          source: 'user',
        }

    setSaving(true)
    try {
      await api.save(base)
      onSaved()
      onClose()
    } catch (error) {
      toast.error(t('settings.mcp.error.saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }, [api, editing, form.command, form.argsText, form.envText, form.name, form.transportType, form.url, form.headersText, formValid, onClose, onSaved, t])

  const handleSaveJson = useCallback(async () => {
    const entries = parsedJson.entries
    if (!entries.length) return
    setSaving(true)
    try {
      for (const entry of entries) {
        await api.save({
          id: mcpServerId(entry.name),
          name: entry.name,
          enabled: true,
          trusted: false,
          transport: entry.transport,
          source: 'user',
        })
      }
      onSaved()
      onClose()
    } catch (error) {
      toast.error(t('settings.mcp.error.saveFailed'), {
        description: error instanceof Error ? error.message : undefined,
      })
    } finally {
      setSaving(false)
    }
  }, [api, parsedJson.entries, onClose, onSaved, t])

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? t('settings.mcp.add.editTitle') : t('settings.mcp.add.title')}
          </DialogTitle>
          <DialogDescription>{t('settings.mcp.add.description')}</DialogDescription>
        </DialogHeader>

        {!editing && (
          <div className="flex items-center gap-2">
            <SettingsSegmentedControl
              size="sm"
              value={mode}
              onValueChange={(value) => setMode(value as 'form' | 'json')}
              options={[
                { value: 'form', label: t('settings.mcp.add.mode.form') },
                { value: 'json', label: t('settings.mcp.add.mode.json') },
              ]}
            />
          </div>
        )}

        {editing || mode === 'form' ? (
          <div className="space-y-4">
            <SettingsInput
              label={t('settings.mcp.add.name')}
              description={t('settings.mcp.add.nameDesc')}
              value={form.name}
              onChange={(value) => updateForm({ name: value })}
              placeholder="context7"
              error={nameError}
            />
            <div>
              <div className="text-sm font-medium mb-1.5">{t('settings.mcp.add.transport')}</div>
              <SettingsSegmentedControl
                size="sm"
                value={form.transportType}
                onValueChange={(value) => updateForm({ transportType: value as TransportType })}
                options={[
                  { value: 'stdio', label: t('settings.mcp.add.transportStdio') },
                  { value: 'http', label: t('settings.mcp.add.transportHttp') },
                ]}
              />
            </div>
            {form.transportType === 'stdio' ? (
              <>
                <SettingsInput
                  label={t('settings.mcp.add.command')}
                  value={form.command}
                  onChange={(value) => updateForm({ command: value })}
                  placeholder="npx"
                />
                <SettingsTextarea
                  label={t('settings.mcp.add.args')}
                  description={t('settings.mcp.add.argsDesc')}
                  value={form.argsText}
                  onChange={(value) => updateForm({ argsText: value })}
                  placeholder={'-y\n@upstash/context7-mcp'}
                  rows={3}
                />
                <SettingsTextarea
                  label={t('settings.mcp.add.env')}
                  description={t('settings.mcp.add.envDesc')}
                  value={form.envText}
                  onChange={(value) => updateForm({ envText: value })}
                  placeholder={'API_TOKEN=...\nDEBUG=1'}
                  rows={2}
                />
              </>
            ) : (
              <>
                <SettingsInput
                  label={t('settings.mcp.add.url')}
                  value={form.url}
                  onChange={(value) => updateForm({ url: value })}
                  placeholder="https://example.com/mcp"
                  type="url"
                />
                <SettingsTextarea
                  label={t('settings.mcp.add.headers')}
                  description={t('settings.mcp.add.headersDesc')}
                  value={form.headersText}
                  onChange={(value) => updateForm({ headersText: value })}
                  placeholder={'Authorization: Bearer ...'}
                  rows={2}
                />
              </>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <SettingsTextarea
              label={t('settings.mcp.add.jsonPaste')}
              description={t('settings.mcp.add.jsonDesc')}
              value={jsonText}
              onChange={setJsonText}
              placeholder={'{\n  "mcpServers": {\n    "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"] }\n  }\n}'}
              rows={8}
            />
            {jsonText.trim() && parsedJson.error && (
              <p className="text-sm text-destructive">
                {t('settings.mcp.add.jsonInvalid', { error: parsedJson.error })}
              </p>
            )}
            {jsonText.trim() && !parsedJson.error && parsedJson.entries.length === 0 && (
              <p className="text-sm text-destructive">{t('settings.mcp.add.jsonNoServers')}</p>
            )}
            {parsedJson.entries.length > 0 && (
              <div className="rounded-md border border-border/50 bg-muted/30 px-3 py-2">
                <div className="text-xs text-muted-foreground mb-1.5">
                  {t('settings.mcp.add.jsonPreview', { count: parsedJson.entries.length })}
                </div>
                <ul className="space-y-1 max-h-32 overflow-y-auto">
                  {parsedJson.entries.map((entry) => (
                    <li key={entry.name} className="text-xs flex items-baseline gap-2 min-w-0">
                      <Check className="h-3 w-3 text-emerald-500 shrink-0 translate-y-0.5" />
                      <span className="font-medium truncate">{entry.name}</span>
                      <span className="text-muted-foreground truncate">
                        {discoveredSummary({ name: entry.name, transport: entry.transport, originPath: '' })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          {editing || mode === 'form' ? (
            <Button onClick={handleSaveForm} disabled={!formValid || saving}>
              {saving ? t('common.saving') : t('common.save')}
            </Button>
          ) : (
            <Button onClick={handleSaveJson} disabled={parsedJson.entries.length === 0 || saving}>
              {saving ? t('common.saving') : t('settings.mcp.add.addServers')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================
// Delete confirmation dialog
// ============================================

interface McpDeleteDialogProps {
  server: BitlabMcpServer | null
  onClose: () => void
  onConfirm: (server: BitlabMcpServer) => void
}

function McpDeleteDialog({ server, onClose, onConfirm }: McpDeleteDialogProps) {
  const { t } = useTranslation()
  return (
    <Dialog open={server !== null} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {t('settings.mcp.delete.title')}
          </DialogTitle>
          <DialogDescription className="text-left pt-2">
            {t('settings.mcp.delete.message', { name: server?.name ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => server && onConfirm(server)}
            disabled={!server}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ============================================
// Discovered section
// ============================================

interface DiscoveredSectionProps {
  api: McpApi
  servers: BitlabMcpServer[]
  discovery: McpDiscoverResult | null
  discovering: boolean
  onRefresh: () => void
  onChanged: () => void
}

function DiscoveredSection({ api, servers, discovery, discovering, onRefresh, onChanged }: DiscoveredSectionProps) {
  const { t } = useTranslation()
  const [importing, setImporting] = useState(false)
  // Selection keyed by `${app}:${serverName}` for host-config imports.
  const [selection, setSelection] = useState<Set<string>>(new Set())

  const existingNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers])

  const toggleSelected = useCallback((key: string) => {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleApproveProject = useCallback(
    async (discovered: DiscoveredMcpServer) => {
      try {
        await api.save({
          id: mcpServerId(discovered.name),
          name: discovered.name,
          enabled: true,
          trusted: false,
          transport: discovered.transport,
          source: 'project',
          originPath: discovered.originPath,
        })
        onChanged()
      } catch (error) {
        toast.error(t('settings.mcp.error.saveFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    },
    [api, onChanged, t],
  )

  const handleImportHost = useCallback(
    async (host: DiscoveredHostConfig) => {
      const selected = host.servers.filter(
        (server) => selection.has(`${host.app}:${server.name}`) && !existingNames.has(server.name),
      )
      if (!selected.length) return
      setImporting(true)
      try {
        await api.import({
          servers: selected.map((server) => ({
            id: mcpServerId(server.name),
            name: server.name,
            enabled: true,
            trusted: false,
            transport: server.transport,
            source: 'import' as const,
            originPath: host.path,
          })),
        })
        setSelection((prev) => {
          const next = new Set(prev)
          for (const server of selected) next.delete(`${host.app}:${server.name}`)
          return next
        })
        onChanged()
      } catch (error) {
        toast.error(t('settings.mcp.error.importFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
      } finally {
        setImporting(false)
      }
    },
    [api, existingNames, importing, selection, onChanged, t],
  )

  const hasDiscovered =
    (discovery?.project.length ?? 0) > 0 || (discovery?.hosts.length ?? 0) > 0

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4 pl-1">
        <p className="text-sm text-muted-foreground min-w-0">
          {t('settings.mcp.discovered.description')}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 shrink-0"
          onClick={onRefresh}
          disabled={discovering}
        >
          <RefreshCcw className={cn('h-3.5 w-3.5', discovering && 'animate-spin')} />
          {discovering ? t('common.loading') : t('settings.mcp.discovered.refresh')}
        </Button>
      </div>
      {!hasDiscovered && (
        <SettingsCard divided={false}>
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">
            {discovery === null && discovering
              ? t('common.loading')
              : t('settings.mcp.discovered.empty')}
          </div>
        </SettingsCard>
      )}

      {(discovery?.project.length ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground pl-1">
            {t('settings.mcp.discovered.projectHint')}
          </div>
          <SettingsCard divided={false}>
            <div className="divide-y divide-border/50">
              {discovery!.project.map((discovered) => {
                const added = servers.some(
                  (s) => s.name === discovered.name && s.source === 'project',
                )
                return (
                  <div
                    key={`${discovered.originPath}:${discovered.name}`}
                    className="flex items-center gap-3 px-4 py-3"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{discovered.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {discoveredSummary(discovered)}
                      </div>
                    </div>
                    {added ? (
                      <span className="inline-flex items-center gap-1 h-7 px-3 text-xs text-muted-foreground">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        {t('settings.mcp.discovered.added')}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7"
                        onClick={() => handleApproveProject(discovered)}
                      >
                        {t('settings.mcp.discovered.approve')}
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </SettingsCard>
          <p className="text-xs text-muted-foreground pl-1">
            {t('settings.mcp.discovered.projectNote')}
          </p>
        </div>
      )}

      {(discovery?.hosts.length ?? 0) > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground pl-1">
            {t('settings.mcp.discovered.hostsHint')}
          </div>
          {discovery!.hosts.map((host) => {
            const selectedCount = host.servers.filter(
              (server) =>
                selection.has(`${host.app}:${server.name}`) && !existingNames.has(server.name),
            ).length
            return (
              <SettingsCard key={host.path} divided={false}>
                <div className="flex items-center justify-between gap-3 px-4 pt-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium">
                      {t(`settings.mcp.discovered.app.${host.app}`)}
                    </div>
                    <div className="text-xs text-muted-foreground truncate" title={host.path}>
                      {host.path}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7"
                    disabled={selectedCount === 0 || importing}
                    onClick={() => handleImportHost(host)}
                  >
                    {selectedCount > 0
                      ? t('settings.mcp.discovered.importSelected', { count: selectedCount })
                      : t('settings.mcp.discovered.import')}
                  </Button>
                </div>
                <div className="divide-y divide-border/50 mt-2 border-t border-border/50">
                  {host.servers.map((server) => {
                    const key = `${host.app}:${server.name}`
                    const added = existingNames.has(server.name)
                    const checked = selection.has(key) && !added
                    return (
                      <label
                        key={key}
                        className={cn(
                          'flex items-center gap-3 px-4 py-2.5',
                          !added && 'cursor-pointer hover:bg-foreground/[0.02] transition-colors',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 accent-foreground"
                          checked={checked}
                          disabled={added}
                          onChange={() => toggleSelected(key)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm truncate">{server.name}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {discoveredSummary(server)}
                          </div>
                        </div>
                        {added && (
                          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                            {t('settings.mcp.discovered.added')}
                          </span>
                        )}
                      </label>
                    )
                  })}
                </div>
              </SettingsCard>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ============================================
// Main Component
// ============================================

export default function McpSettingsPage() {
  const { t } = useTranslation()
  const workspace = useActiveWorkspace()

  const [api] = useState<McpApi | null>(() => getMcpApi())
  const [list, setList] = useState<McpListResult | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [settings, setSettings] = useState<BitlabMcpSettings>(DEFAULT_MCP_SETTINGS)
  const [globalTimeoutText, setGlobalTimeoutText] = useState('')
  const [view, setView] = useState<McpView>('installed')
  const [query, setQuery] = useState('')
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null)

  // Live snapshots keyed by the session that reported them, so a later report
  // from the same session replaces its predecessor instead of piling a stale
  // "connected" on top of a server that has since dropped.
  const [liveStatuses, setLiveStatuses] = useState<Record<string, McpSessionStatusDto>>({})

  const [discovery, setDiscovery] = useState<McpDiscoverResult | null>(null)
  const [discovering, setDiscovering] = useState(false)

  const [formOpen, setFormOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<BitlabMcpServer | null>(null)
  const [deletingServer, setDeletingServer] = useState<BitlabMcpServer | null>(null)

  const servers = useMemo(() => list?.servers ?? [], [list])

  const refreshList = useCallback(async () => {
    const mcpApi = getMcpApi()
    if (!mcpApi) return
    try {
      const result = await mcpApi.list()
      setList(result)
      setSettings(result.settings ?? DEFAULT_MCP_SETTINGS)
      setGlobalTimeoutText(secondsFieldValue((result.settings ?? DEFAULT_MCP_SETTINGS).requestTimeoutMs))
      setLiveStatuses(Object.fromEntries(result.statuses.map((entry) => [entry.sessionId, entry])))
      setListError(null)
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  const refreshDiscovery = useCallback(async () => {
    const mcpApi = getMcpApi()
    if (!mcpApi) return
    setDiscovering(true)
    try {
      const result = await mcpApi.discover({
        ...(workspace?.folderPath ? { workspaceRoot: workspace.folderPath } : {}),
      })
      setDiscovery(result)
    } catch {
      // Discovery is best-effort — the section just shows its empty state.
      setDiscovery({ project: [], hosts: [] })
    } finally {
      setDiscovering(false)
    }
  }, [workspace?.folderPath])

  // Initial load + refresh on mcp:changed broadcast. Discovery is loaded by
  // the folder-change effect below (which also fires on mount).
  useEffect(() => {
    if (!api) return
    refreshList()
    const cleanup = api.onChanged(() => {
      refreshList()
    })
    return cleanup
  }, [api, refreshList])

  // Adapter notices as toasts. Warnings and errors always surface; info lines
  // are the adapter's running commentary on its own tool registry ("direct
  // tools refreshed (+210, ~0, -0)") and are log material, not a popup — only
  // the ones about a sign-in the user just started are worth interrupting for.
  useEffect(() => {
    if (!api?.onNotify) return
    return api.onNotify((notice) => {
      if (notice.level === 'error') {
        toast.error(notice.message)
      } else if (notice.level === 'warning') {
        toast.warning(notice.message)
      } else if (/\bauth|sign[- ]?in|oauth|authenticat/i.test(notice.message)) {
        toast.message(notice.message)
      }
    })
  }, [api])

  // Live status snapshots. Without this the page only learns about connects,
  // failures and sign-ins by re-listing on `mcp:changed`.
  useEffect(() => {
    if (!api?.onStatus) return
    return api.onStatus((payload) => {
      setLiveStatuses((current) => ({ ...current, [payload.sessionId]: payload }))
    })
  }, [api])

  // Reload discovery when the workspace folder changes.
  useEffect(() => {
    refreshDiscovery()
  }, [refreshDiscovery])

  // One status per server name, merged across every live session's snapshot
  // and the backend's memory of earlier ones (the only state that survives the
  // transient session a sign-in runs in). See mcp-derive.ts for the join.
  const displayByName = useMemo(
    () => mergeServerDisplays(Object.values(liveStatuses), list?.lastKnown ?? []),
    [liveStatuses, list],
  )

  const existingNames = useMemo(() => new Set(servers.map((s) => s.name)), [servers])

  const filteredServers = useMemo(
    () => filterServers(servers, query, (source) => t(`settings.mcp.source.${source}`)),
    [query, servers, t],
  )

  const runningCount = useMemo(
    () => countRunningServers(servers, displayByName),
    [servers, displayByName],
  )

  const toolCount = useMemo(
    () => sumAvailableTools(servers, displayByName),
    [servers, displayByName],
  )

  const discoveredCount = useMemo(
    () =>
      (discovery?.project.filter((server) => !existingNames.has(server.name)).length ?? 0) +
      (discovery?.hosts.reduce(
        (total, host) =>
          total + host.servers.filter((server) => !existingNames.has(server.name)).length,
        0,
      ) ?? 0),
    [discovery, existingNames],
  )

  useEffect(() => {
    if (expandedServerId && !servers.some((server) => server.id === expandedServerId)) {
      setExpandedServerId(null)
    }
  }, [expandedServerId, servers])

  const handleMutateServer = useCallback(
    async (server: BitlabMcpServer, updater: (s: BitlabMcpServer) => BitlabMcpServer) => {
      if (!api) return
      try {
        await api.save(updater(server))
        await refreshList()
      } catch (error) {
        toast.error(t('settings.mcp.error.saveFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
        await refreshList()
      }
    },
    [api, refreshList, t],
  )

  const handleDeleteServer = useCallback(
    async (server: BitlabMcpServer) => {
      setDeletingServer(null)
      if (!api) return
      try {
        await api.delete({ id: server.id })
        await refreshList()
      } catch (error) {
        toast.error(t('settings.mcp.error.deleteFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
        await refreshList()
      }
    },
    [api, refreshList, t],
  )

  const handleSaveSettings = useCallback(
    async (patch: Partial<BitlabMcpSettings>) => {
      if (!api) return
      const next = { ...settings, ...patch }
      setSettings(next) // optimistic
      try {
        await api.saveSettings(next)
        await refreshList()
      } catch (error) {
        setSettings(settings) // roll back
        toast.error(t('settings.mcp.error.saveFailed'), {
          description: error instanceof Error ? error.message : undefined,
        })
      }
    },
    [api, refreshList, settings, t],
  )

  const openAddDialog = useCallback(() => {
    setEditingServer(null)
    setFormOpen(true)
  }, [])

  const openEditDialog = useCallback((server: BitlabMcpServer) => {
    setEditingServer(server)
    setFormOpen(true)
  }, [])

  if (!api) {
    return (
      <div className="h-full flex flex-col">
        <PanelHeader title={t('settings.mcp.title')} actions={<HeaderMenu route={routes.view.settings('mcp')} />} />
        <div className="flex-1 min-h-0 mask-fade-y">
          <ScrollArea className="h-full">
            <div className="px-5 py-7 max-w-5xl mx-auto">
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0 mt-0.5" />
                <p className="text-sm text-amber-600 dark:text-amber-300/80">
                  {t('settings.mcp.error.unavailable')}
                </p>
              </div>
            </div>
          </ScrollArea>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t('settings.mcp.title')} actions={<HeaderMenu route={routes.view.settings('mcp')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-5xl mx-auto">
            <div className="space-y-6">
              {/* Header: description + search + add */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-muted-foreground">{t('settings.mcp.description')}</p>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 sm:w-60">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t('settings.mcp.search.placeholder')}
                      aria-label={t('settings.mcp.search.placeholder')}
                      className="h-8 w-full rounded-lg bg-background shadow-minimal pl-8 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
                    />
                  </div>
                  <Button size="sm" className="gap-1.5 shrink-0" onClick={openAddDialog}>
                    <Plus className="h-3.5 w-3.5" />
                    {t('settings.mcp.servers.add')}
                  </Button>
                </div>
              </div>

              {/* Overview stats (derived from the current list) */}
              <div className="grid grid-cols-3 gap-2">
                <StatTile value={servers.length} label={t('settings.mcp.stats.installed')} />
                <StatTile value={runningCount} label={t('settings.mcp.stats.running')} />
                <StatTile value={toolCount} label={t('settings.mcp.stats.tools')} />
              </div>

              {listError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-red-500 flex-shrink-0 mt-0.5" />
                  <p className="text-sm text-red-600 dark:text-red-400 break-all">{listError}</p>
                </div>
              )}

              <Tabs value={view} onValueChange={(value) => setView(value as McpView)}>
                <TabsList>
                  <TabsTrigger value="installed">{t('settings.mcp.tabs.installed')}</TabsTrigger>
                  <TabsTrigger value="discovered" className="gap-1.5">
                    {t('settings.mcp.tabs.discovered')}
                    {discoveredCount > 0 && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        ({discoveredCount})
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="global">{t('settings.mcp.tabs.global')}</TabsTrigger>
                </TabsList>

                {/* Installed: two-column card grid, one expanded detail at a time */}
                <TabsContent value="installed" className="mt-4">
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={TAB_FADE}
                  >
                    {!listError && servers.length === 0 ? (
                      <SettingsCard divided={false}>
                        <div className="px-4 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            {t('settings.mcp.servers.empty')}
                          </p>
                          <p className="text-xs text-muted-foreground/70 mt-1">
                            {t('settings.mcp.servers.emptyHint')}
                          </p>
                        </div>
                      </SettingsCard>
                    ) : servers.length > 0 && filteredServers.length === 0 ? (
                      <SettingsCard divided={false}>
                        <div className="px-4 py-8 text-center">
                          <p className="text-sm text-muted-foreground">
                            {t('settings.mcp.servers.searchEmpty')}
                          </p>
                        </div>
                      </SettingsCard>
                    ) : servers.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-start">
                        {filteredServers.map((server) => (
                          <McpServerCard
                            key={server.id}
                            server={server}
                            display={displayByName.get(server.name)}
                            globalSettings={settings}
                            api={api}
                            expanded={expandedServerId === server.id}
                            onExpandedChange={(expanded) =>
                              setExpandedServerId(expanded ? server.id : null)
                            }
                            onMutate={(updater) => handleMutateServer(server, updater)}
                            onEdit={() => openEditDialog(server)}
                            onDelete={() => setDeletingServer(server)}
                          />
                        ))}
                      </div>
                    ) : null}
                  </motion.div>
                </TabsContent>

                {/* Discovered: project approval + cross-app import */}
                <TabsContent value="discovered" className="mt-4">
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={TAB_FADE}
                  >
                    <DiscoveredSection
                      api={api}
                      servers={servers}
                      discovery={discovery}
                      discovering={discovering}
                      onRefresh={refreshDiscovery}
                      onChanged={refreshList}
                    />
                  </motion.div>
                </TabsContent>

                {/* Global settings */}
                <TabsContent value="global" className="mt-4">
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={TAB_FADE}
                  >
                    <div className="space-y-3">
                      <p className="text-sm text-muted-foreground pl-1">
                        {t('settings.mcp.global.description')}
                      </p>
                      <SettingsCard>
                        <SettingsToggle
                          label={t('settings.mcp.global.requireApproval')}
                          description={t('settings.mcp.global.requireApprovalDesc')}
                          checked={settings.requireApproval}
                          onCheckedChange={(checked) =>
                            handleSaveSettings({ requireApproval: checked })
                          }
                        />
                        <SettingsToggle
                          label={t('settings.mcp.global.directTools')}
                          description={t('settings.mcp.global.directToolsDesc')}
                          checked={settings.directTools}
                          onCheckedChange={(checked) => handleSaveSettings({ directTools: checked })}
                        />
                        <SettingsMenuSelectRow
                          label={t('settings.mcp.global.lifecycle')}
                          description={t('settings.mcp.global.lifecycleDesc')}
                          value={settings.lifecycle}
                          onValueChange={(value) =>
                            handleSaveSettings({ lifecycle: value as McpLifecycle })
                          }
                          options={LIFECYCLES.map((lifecycle) => ({
                            value: lifecycle,
                            label: t(`settings.mcp.lifecycle.${lifecycle}`),
                            description: t(`settings.mcp.lifecycleDesc.${lifecycle}`),
                          }))}
                        />
                        <div className="px-4 py-3.5">
                          <SettingsInput
                            label={t('settings.mcp.global.requestTimeout')}
                            description={t('settings.mcp.global.requestTimeoutDesc')}
                            value={globalTimeoutText}
                            onChange={setGlobalTimeoutText}
                            onBlur={() => {
                              const requestTimeoutMs = secondsFieldToMs(globalTimeoutText)
                                ?? DEFAULT_MCP_SETTINGS.requestTimeoutMs
                              setGlobalTimeoutText(secondsFieldValue(requestTimeoutMs))
                              handleSaveSettings({ requestTimeoutMs })
                            }}
                            placeholder={String(DEFAULT_MCP_SETTINGS.requestTimeoutMs / 1000)}
                          />
                        </div>
                      </SettingsCard>
                    </div>
                  </motion.div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Add / Edit dialog */}
      <McpServerFormDialog
        open={formOpen}
        editing={editingServer}
        existingNames={existingNames}
        api={api}
        onClose={() => setFormOpen(false)}
        onSaved={refreshList}
      />

      {/* Delete confirmation */}
      <McpDeleteDialog
        server={deletingServer}
        onClose={() => setDeletingServer(null)}
        onConfirm={handleDeleteServer}
      />
    </div>
  )
}
