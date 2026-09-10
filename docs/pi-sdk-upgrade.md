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

**`pi-mcp-adapter`** is pinned `^2.25.0`. Every published version up to `2.32.1`
declares `peerDependencies: { "@earendil-works/pi-ai": "^0.84.1" }`, which excludes
`0.85.x`. Bun treats it as an optional peer, so the install succeeds and nothing
warns — but no adapter version formally claims `0.85` support. Upstream:
<https://github.com/nicobailon/pi-mcp-adapter>

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
- `bun run build` in `packages/pi-agent-server` succeeds.
- Subprocess smoke run against the bundled server: `init` with an injected
  `api_key` credential, then `ensure_session_ready`. The server emits `ready`,
  resolves the model through the new runtime (`api=anthropic-messages
  provider=anthropic`), and creates a session with 9 tools and the sub-agent
  extension installed — so the rewritten credential chain works at runtime, not
  just at the type level.
- The manual checklist above has **not** been run. It covers the OAuth paths the
  smoke run does not reach.
