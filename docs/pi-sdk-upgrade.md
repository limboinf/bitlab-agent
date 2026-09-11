# Pi SDK upgrade: 0.80.6 → 0.85.1

Record of a completed upgrade, not a plan. Bitlab pinned `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, and `@earendil-works/pi-agent-core` at `0.80.6`;
all three now sit at `0.85.1`. The three packages version in lockstep and all four
manifests moved together:

| Manifest | Packages pinned |
| --- | --- |
| [package.json](../package.json) | `pi-ai`, `pi-coding-agent` |
| [packages/shared/package.json](../packages/shared/package.json) | `pi-ai`, `pi-coding-agent`, `pi-agent-core` |
| [packages/pi-agent-server/package.json](../packages/pi-agent-server/package.json) | `pi-ai`, `pi-coding-agent`, `pi-agent-core` |
| [packages/server-core/package.json](../packages/server-core/package.json) | `pi-ai` |

The break lands between `0.80.6` and `0.80.7` — inside a patch bump — and the same
errors persist unchanged through `0.85.1`. There was no cheaper intermediate version,
so the upgrade went straight to current.

The upstream release notes for `0.84.0` read alarmingly — v4 lane-based sessions,
`message_update` losing its cumulative fields, TypeBox API removals. Almost none of
that applied. What did apply lived almost entirely in the credential layer, where it
is not covered by type checking.

## What broke, and how it was resolved

### Credential storage: `AuthStorage` is gone

`AuthStorage`, `AuthStorageBackend`, and `AuthCredential` stopped being exported at
`0.80.8`. The class still exists in `dist/`, but not in the `exports` map, so a deep
import was not an option either.

Bitlab's `OAuthSyncAuthStorageBackend` — the hook that observed credential writes and
pushed refreshed OAuth tokens back to the main process — was replaced by
`OAuthSyncCredentialStore extends InMemoryCredentialStore` (imported from
`@earendil-works/pi-ai`, not `pi-coding-agent`), at
[index.ts:409](../packages/pi-agent-server/src/index.ts).

The new class overrides one method: `modify()`. That is the SDK's only write path —
login, logout, and the pre-request refresh of an expiring token all funnel through it
— so wrapping it catches every rotation without reaching into SDK internals. The
override calls `super.modify()`, captures the previous credential, and emits
`oauth_credential_update` when an OAuth credential actually changed. The base class
owns per-provider serialization, so the hand-rolled `withLock` / `withLockAsync`
pair went away entirely. A small `set()` helper wraps `modify()` for the
unconditional writes the main process injects (`piAuth`, the legacy `apiKey`
fallback, and the `token_update` message).

### Registry construction: `ModelRegistry.inMemory()` is gone

```ts
// before
const modelRegistry = PiModelRegistry.inMemory(authStorage);

// after
moduleModelRuntime = await PiModelRuntime.create({
  credentials: credentialStore,
  refreshOnCreate: false,
});
const modelRegistry = new PiModelRegistry(moduleModelRuntime);
```

`ModelRuntime` is the new owner of credentials and `ModelRuntime.create()` is async,
so `createAuthenticatedRegistry()` became async
([index.ts:868](../packages/pi-agent-server/src/index.ts)) along with both of its
callers — `ensureSession()` and `queryLlm()`. The runtime is memoized at module
scope next to the credential store, and both are reset to `null` on re-init so a
fresh pair is built.

`refreshOnCreate: false` is deliberate: credentials come from the main process and
the catalog is repo-owned, so the create-time network refresh buys nothing and would
add startup latency to every ephemeral `queryLlm` session.

### Session options: two fields became one

`CreateAgentSessionOptions.authStorage` and `.modelRegistry` were replaced by a
single `modelRuntime` option, at
[index.ts:998](../packages/pi-agent-server/src/index.ts) (main session) and
[index.ts:1496](../packages/pi-agent-server/src/index.ts) (ephemeral `queryLlm`
session). The registry is still built, but only for Bitlab's own model resolution
and custom-endpoint registration — the session takes the runtime.

### `ResourceLoader` grew two members

`getSystemPromptSource()` and `getAppendSystemPromptSources()` are now part of the
interface. `BitlabResourceLoader` implements both as straight delegation, at
[resource-loader.ts:126](../packages/pi-agent-server/src/resource-loader.ts) and
[resource-loader.ts:134](../packages/pi-agent-server/src/resource-loader.ts). They
are diagnostics-only; Bitlab's skill seams still hook `getSystemPrompt()`.

### `Agent.streamFn` → `Agent.streamFunction`

A rename, nothing more. The timing instrumentation is unaffected: `instrumentStreamFn`
in [llm-request-timing.ts](../packages/pi-agent-server/src/llm-request-timing.ts)
still brackets the SDK's own function, and the assignment at
[index.ts:1188](../packages/pi-agent-server/src/index.ts) just points at the new
property name. Comments in `llm-request-timing.ts` and
[execution-metrics.ts](../packages/core/src/types/execution-metrics.ts) were updated
to match.

### `KnownProvider` and `BuiltinProvider` diverged

The package root's `KnownProvider` union and the `pi-ai/compat` catalog's
`BuiltinProvider` union are no longer the same set: `0.85.1`'s `KnownProvider`
includes runtime-only providers such as `radius`, which `getModels()` does not accept.
[models-pi.ts:178](../packages/shared/src/config/models-pi.ts) now narrows to
`BuiltinProvider`, imported from `@earendil-works/pi-ai/compat`.

### The skill-catalog gate widened to `read` *or* `bash`

`pi-coding-agent`'s system-prompt builder used to append `<available_skills>` only
when the `read` tool was active. In `0.85.1` it resolves
`["read", "bash"].find(t => tools.includes(t))` and emits the catalog with
bash-flavoured wording when `read` is absent. `PiSkillBridge.assertCatalogVisible()`
mirrored the old `read`-only rule and now over-reported, so it was widened to match
— see [skill-bridge.ts](../packages/pi-agent-server/src/skill-bridge.ts).

This is an upstream improvement, not a break. It has no effect on Bitlab in
practice: the built-in tool set always includes `read`, and `selectedTools` has no
production caller that withholds it.

## What did not break

Verified against `0.85.1`, despite the release notes:

- **`SessionManager` is intact.** `forkFrom()`, `continueRecent()`, `inMemory()`,
  `getEntry()`, `branch()`, `createAgentSession()`, and `CreateAgentSessionOptions`
  all still resolve. The v4 lane-based `Session`/`SessionStorage`/`SessionRepo`
  rework replaced a lower layer Bitlab does not touch.
- **The `message_update` change is a no-op here.**
  [event-adapter.ts:338](../packages/shared/src/agent/backend/pi/event-adapter.ts)
  already reads `event.assistantMessageEvent` deltas and never depended on the
  removed cumulative `message` / `partial` fields — which is exactly the shape
  `0.84.0` onwards requires.
- **No removed TypeBox APIs are in use.** A repository-wide scan for `Type.Base`,
  `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`,
  `Type.Options`, and `Value.Mutate` returns nothing.
- **All three deep imports survive.** `pi-ai/compat` (`getModels`, `getProviders`),
  `pi-ai/bedrock-provider`, and `pi-ai/api/bedrock-converse-stream.lazy` are still in
  the `exports` map.
- **`ModelRegistry.getApiKeyAndHeaders()` and `.refresh()` signature changes do not
  reach us.** The only caller is a test assertion, which still passes.

## Known risks / not covered by type checking

The credential rewrite is the kind of change type checking signs off on and users
discover. **This checklist has not been run yet.**

- Sign in with a **ChatGPT Plus** subscription and with a **Claude Pro/Max**
  subscription, and confirm the OAuth callback completes.
- Leave a session idle past token expiry and confirm the **refreshed token is
  persisted** and synced back to the main process, rather than forcing a re-login.
  This is the single highest-risk path: it now depends on the SDK routing its
  pre-request refresh through `CredentialStore.modify()`.
- Confirm an **API-key** connection and a **custom OpenAI/Anthropic-compatible
  endpoint** still resolve models.
- Confirm **Ollama** still enumerates local models.
- Exercise **session fork/branch**, streaming output, and tool calls end to end.
- Run the desktop app against a clean config root:
  `rm -rf /tmp/bitlab-smoke && BITLAB_CONFIG_DIR=/tmp/bitlab-smoke bun run electron:dev`

## Open items

Two third-party pins were left alone. Recorded as facts, not decisions.

**`pi-mcp-adapter`** stays pinned `^2.25.0`. Its `peerDependencies` declare
`"@earendil-works/pi-ai": "^0.84.1"`, which formally excludes `0.85.x` — but that
range is **stale metadata, not a real incompatibility**, and it was verified
empirically rather than assumed (see Verification status). `2.32.1` declares the
identical range, so bumping buys nothing. The adapter's only runtime import from
pi-ai is `complete` from `pi-ai/compat`, which `0.85.1` still exports; everything
else it takes from pi-ai is type-only. Upstream:
<https://github.com/nicobailon/pi-mcp-adapter>

Three MCP paths were *not* exercised and remain unproven: **sampling** (the one
file with a real pi-ai value dependency), **HTTP transport + OAuth**
(`mcp_auth` / `mcp_logout`), and the **approval handshake**.

**`@tintinweb/pi-subagents`** is pinned `0.17.1`. Its peer range is `>=0.80.0`, so
`0.85.1` is formally satisfied and the pin can stay. `0.19.0` declares `>=0.84.0`,
but moving there crosses `0.18.0`, which changed default behaviour:

| | 0.17.1 | 0.18.0+ |
| --- | --- | --- |
| `Agent` call | runs inline | runs in the background by default, returns an id + preview; results fetched via `get_subagent_result` |
| `maxConcurrent` default | 4 | 10 |
| Esc | — | interrupts only the current turn |

That is a product-behaviour change, not a compatibility fix, and was deliberately
left out of this upgrade.

## Verification status

- `bun run validate:dev` passes — typecheck across all 9 packages, 52 shared tests,
  19 doc-tool tests.
- `bun run test` passes: **3784 pass / 11 skip / 0 fail** across 331 files, plus
  all 11 isolated/serial files green individually. One genuine upgrade regression
  surfaced and was fixed — the skill-catalog gate above.
- **Pi session integration** (`pi-conversation-flow.integration.test.ts`) passes
  against the local SSE fixture: two completions, `tool_start` / `tool_result`
  emitted, `text_complete` before `complete`, per-request timing ordered after the
  answer, no SDK-internal payload leakage. This is the real-subprocess regression
  signal and it is clean.
- `bun run lint` — 0 errors (50 pre-existing warnings, none from this change).
  i18n parity / usage / sorted all OK.
- `bun run build` in `packages/pi-agent-server` succeeds.
- Subprocess smoke run against the bundled server: `init` with an injected
  `api_key` credential, then `ensure_session_ready`. The server emits `ready`,
  resolves the model through the new runtime (`api=anthropic-messages
  provider=anthropic`), and creates a session with 9 tools and the sub-agent
  extension installed — so the rewritten credential chain works at runtime, not
  just at the type level.
- **MCP proven end to end on `0.85.1`** against a real stdio MCP server: the
  adapter installs, `mcp_status` reports `connected` with `toolCount: 2`, the
  `initialize` / `tools/list` handshake round-trips, and a `tools/call` returns a
  live result. Both the `mcp` proxy tool and the prefixed direct tools register.
- **WebUI end to end.** Server on `:9100` with an isolated `BITLAB_CONFIG_DIR`,
  Vite on `:5175`. The app connects, renders the workspace/session shell, the
  settings and connector pages load, and a seeded connection is correctly reported
  as unauthenticated. The model catalog carries through the whole chain: the
  default-model picker lists `Claude Opus 5` ("anthropic model via Pi"), selecting
  it persists `defaultModel: "pi/claude-opus-5"` and 13 synced models into
  `config.json`. `claude-opus-5` does **not** exist in the `0.80.6` catalog — this
  is the upgrade's user-visible payoff, confirmed in the UI rather than inferred.
- The manual checklist above has **not** been run. It covers the OAuth
  subscription paths that none of the above reach.

## Follow-up candidate (not part of this upgrade)

`PI_EXTRA_MODELS` in [models-pi.ts](../packages/shared/src/config/models-pi.ts)
carries a `deepseek-v4-flash-vision-exp` alias whose stated exit condition is
"once an SDK upgrade ships the same id". `0.85.1` ships it, with `input`
already `["text", "image"]`, so `getPiCatalogModels()`'s `!known.has(m.id)` filter
now skips the alias entirely — it is dead code. The sibling `deepseek-flash`
(V4.1 Flash) entry is **still required**; the SDK catalog does not carry that id.
Left alone deliberately: it touches vision-model routing and is unrelated to the
SDK bump.
