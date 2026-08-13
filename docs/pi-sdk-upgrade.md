# Pi SDK upgrade: 0.80.6 → 0.84.1

Research notes, not a plan of record. Bitlab pins `@earendil-works/pi-ai`,
`@earendil-works/pi-coding-agent`, and `@earendil-works/pi-agent-core` at `0.80.6`
in four manifests. The three packages version in lockstep; `0.84.1` is current.

The upstream release notes for `0.84.0` read alarmingly — v4 lane-based sessions,
`message_update` losing its cumulative fields, TypeBox API removals. Almost none of
that applies to Bitlab. What does apply is narrower and lives entirely in the
credential layer, where it is not covered by type checking.

## Method

The version bisect below was produced by type-checking a probe file that imports
every Pi symbol Bitlab actually uses, against each candidate version in an isolated
project. To reproduce:

```bash
mkdir /tmp/piprobe && cd /tmp/piprobe && echo '{"name":"probe"}' > package.json
bun add @earendil-works/pi-coding-agent@<version> @earendil-works/pi-ai@<version> \
        @earendil-works/pi-agent-core@<version> typescript
# write the probe (see "API surface" below), then:
bunx tsc --noEmit --skipLibCheck --module preserve --moduleResolution bundler \
         --target esnext --strict probe.ts
```

## Where the break is

| Version | Breaking errors against Bitlab's API surface |
| --- | --- |
| 0.80.6 (current) | 0 |
| 0.80.10 | 4 |
| 0.81.1 | 4 |
| 0.82.1 | 4 |
| 0.83.0 | 4 |
| 0.84.1 | 4 |

The break lands between `0.80.6` and `0.80.7` — inside a patch bump — and the same
four errors persist unchanged through `0.84.1`. **There is no cheaper intermediate
version.** Upgrading one patch costs exactly what upgrading to `0.84.1` costs, so
there is no reason to target anything below `0.84.1`.

## What actually breaks

All four are in `packages/pi-agent-server/src/index.ts`:

| Symbol | Status in 0.84.1 |
| --- | --- |
| `AuthStorage` | no longer exported from the package root (the class still exists at `dist/core/auth-storage.d.ts`, which is not in the `exports` map, so a deep import is not available either) |
| `AuthCredential` | no longer exported |
| `AuthStorageBackend` | no longer exported |
| `ModelRegistry.inMemory(authStorage)` | static removed; the constructor is now `new ModelRegistry(runtime: ModelRuntime)` |

These hit [index.ts:534](../packages/pi-agent-server/src/index.ts) and
[index.ts:549](../packages/pi-agent-server/src/index.ts), where Bitlab builds its
credential chain:

```ts
moduleAuthStorage = PiAuthStorage.fromStorage(new OAuthSyncAuthStorageBackend());
// …
const modelRegistry = PiModelRegistry.inMemory(authStorage);
```

`OAuthSyncAuthStorageBackend` is Bitlab's own hook: it observes credential writes and
pushes refreshed OAuth tokens back to the main process. That is the mechanism behind
ChatGPT Plus and Claude Pro/Max subscription sign-in, so this upgrade is a rewrite of
the subscription auth path, not a version bump.

## What does not break

Verified against `0.84.1`, despite the release notes:

- **`SessionManager` is intact.** `forkFrom()`, `continueRecent()`, `inMemory()`,
  `getEntry()`, `branch()`, `createAgentSession()`, and `CreateAgentSessionOptions`
  all still resolve. The v4 lane-based `Session`/`SessionStorage`/`SessionRepo`
  rework replaced a lower layer Bitlab does not touch.
- **The `message_update` change is a no-op here.**
  [event-adapter.ts:326](../packages/shared/src/agent/backend/pi/event-adapter.ts)
  already reads `event.assistantMessageEvent` deltas and never depended on the
  removed cumulative `message` / `partial` fields — which is exactly the shape
  `0.84.0` now requires.
- **No removed TypeBox APIs are in use.** A repository-wide scan for `Type.Base`,
  `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`,
  `Type.Options`, and `Value.Mutate` returns nothing.
- **All three deep imports survive.** `pi-ai/compat` (`getModels`, `getProviders`),
  `pi-ai/bedrock-provider`, and `pi-ai/api/bedrock-converse-stream.lazy` are still in
  the `exports` map.
- **`ModelRegistry.getApiKeyAndHeaders()` and `.refresh()` signature changes do not
  reach us.** Bitlab calls neither.

## Migration sketch

The replacement API is public and the shape of the fix is known:

1. `CredentialStore` and `Credential` are exported from **`@earendil-works/pi-ai`**
   (not from `pi-coding-agent`). `AuthStorage implements CredentialStore`, so
   `CredentialStore` is the contract that replaces `AuthStorageBackend`.

   ```ts
   import type { CredentialStore, Credential } from '@earendil-works/pi-ai'
   ```

   Its shape differs from `AuthStorageBackend`: `read(providerId, options?)` and
   `list(options?)` are async, and writes go through a single serialized callback
   that receives the current credential and returns the new one. Bitlab's OAuth
   fan-out logic ports into that write callback.

2. `ModelRuntime` is the new owner of credentials, and it accepts the store
   directly:

   ```ts
   import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent'

   const runtime = await ModelRuntime.create({
     credentials: oauthSyncStore,
     refreshOnCreate: false,   // Bitlab injects credentials itself
   })
   const modelRegistry = new ModelRegistry(runtime)
   ```

   `ModelRuntime.create()` is async, so `createAuthenticatedRegistry()` and its
   callers become async. `CreateAgentSessionOptions` also accepts `modelRuntime`
   directly, which may remove a layer.

3. `AuthCredential` → `Credential` from `pi-ai`. The package root still exports
   `readStoredCredential`, plus `CredentialSynchronizationError` and
   `CredentialSynchronizationOperation` (`"login" | "logout" | "setRuntimeApiKey" |
   "removeRuntimeApiKey"`) for reporting sync failures.

## API surface to probe

Bitlab imports these; keep the list current when writing a probe file.

- `pi-coding-agent`: `AgentSession`, `AgentSessionEvent`, `AgentToolResult<T>`,
  `CreateAgentSessionOptions`, `ToolDefinition`, `SessionManager`, `SettingsManager`,
  `ModelRegistry`, `createAgentSession`, and the `create{Bash,Edit,Find,Grep,Ls,Read,Write}ToolDefinition`
  factories — plus the four broken symbols above.
- `pi-ai`: `Api`, `AssistantMessage`, `AssistantMessageEvent`, `KnownProvider`,
  `Model<TApi>`, `TextContent`, `isContextOverflow`.
- `pi-agent-core`: `AgentEvent`, `AgentToolResult`, `ThinkingLevel`.
- Deep: `pi-ai/compat`, `pi-ai/bedrock-provider`,
  `pi-ai/api/bedrock-converse-stream.lazy`.

Note that `AgentToolResult` and `Model` are generic (`AgentToolResult<T>`,
`Model<TApi>`) in every version including `0.80.6` — a probe that omits the type
argument reports two errors that are artifacts of the probe, not regressions.

## Verification beyond type checking

The credential rewrite is the kind of change type checking signs off on and users
discover. Before shipping an upgrade:

- Sign in with a **ChatGPT Plus** subscription and with a **Claude Pro/Max**
  subscription, and confirm the OAuth callback completes.
- Leave a session idle past token expiry and confirm the **refreshed token is
  persisted** and synced back to the main process, rather than forcing a re-login.
- Confirm an **API-key** connection and a **custom OpenAI/Anthropic-compatible
  endpoint** still resolve models.
- Confirm **Ollama** still enumerates local models.
- Exercise **session fork/branch**, streaming output, and tool calls end to end.
- Run the desktop app against a clean config root:
  `rm -rf /tmp/bitlab-smoke && BITLAB_CONFIG_DIR=/tmp/bitlab-smoke bun run electron:dev`

All four manifests must move together: [package.json](../package.json),
[packages/shared/package.json](../packages/shared/package.json),
[packages/pi-agent-server/package.json](../packages/pi-agent-server/package.json),
and [packages/server-core/package.json](../packages/server-core/package.json).
`packages/shared` and `packages/pi-agent-server` also pin `pi-agent-core` directly.
