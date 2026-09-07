# Connections and models

Connections are configured in Settings and stored without plaintext credentials in the configuration files. API keys are written through the credential manager; session JSONL and exports contain only connection/model identifiers.

## Supported connection forms

| Form | Provider preset | Notes |
|---|---|---|
| ChatGPT Plus | `openai-codex` | Craft ChatGPT OAuth; executed by Pi |
| Claude Pro/Max | `anthropic` | Craft Claude OAuth; executed by Pi |
| Pi provider preset | any preset bundled with `@earendil-works/pi-ai` 0.80.6 (anthropic, openai, google, deepseek, xai, mistral, groq, openrouter, …) | Auth via API key |
| Custom `openai-completions` | user-supplied base URL | API key optional (Ollama uses empty key) |
| Custom `anthropic-messages` | user-supplied base URL | API key optional |
| Local Ollama | `http://127.0.0.1:11434/v1` | No auth, OpenAI-completions protocol |

GitHub Copilot, Craft gateway, Sources OAuth, and generic OAuth connections are not supported. The two retained subscription flows use Craft's OAuth implementation; no Claude Agent SDK or Copilot SDK is installed.

## Connection type vs authentication type

These two fields come from `LlmConnection` in `packages/shared/src/config/llm-connections.ts` and together describe how Bitlab reaches a model.

| Field | Code values | Decides |
|---|---|---|
| `providerType` | `pi`, `pi_compat` | Which transport Pi uses to talk to the model |
| `authType` | `oauth`, `api_key`, `api_key_with_endpoint`, `none` | How the credential is supplied |
| `customEndpoint.api` | `openai-completions`, `anthropic-messages` | Which HTTP protocol `pi_compat` speaks |
| `customEndpoint.supportsThinking` | `true`, `false` (default) | Whether requests carry a reasoning-effort parameter derived from the session's thinking level. Off by default because endpoints that don't understand the parameter reject the request. Override per model with `supportsThinking` on the model entry. |

`pi` is Pi's native transport: the Pi SDK already knows OpenAI, Anthropic, Google, DeepSeek, xAI, Mistral, Groq, and OpenRouter. `pi_compat` is used for everything else (Ollama, vLLM, DashScope, an Azure OpenAI deployment, a private gateway) — you must give Pi a `baseUrl` and tell it which generic protocol to use. `authType` only describes the credential that accompanies the request. The four "forms" above map onto those three fields as follows.

| Form | `providerType` | `authType` | `customEndpoint.api` |
|---|---|---|---|
| ChatGPT Plus | `pi` | `oauth` | — |
| Claude Pro/Max | `pi` | `oauth` | — |
| Pi provider preset | `pi` | `api_key` | — |
| Custom `openai-completions` | `pi_compat` | `api_key_with_endpoint` | `openai-completions` |
| Custom `anthropic-messages` | `pi_compat` | `api_key_with_endpoint` | `anthropic-messages` |
| Local Ollama | `pi_compat` | `none` | `openai-completions` |

### Example connection records

A direct Anthropic API key (Pi preset):

```json
{
  "slug": "anthropic-api",
  "providerType": "pi",
  "authType": "api_key",
  "piAuthProvider": "anthropic"
}
```

ChatGPT Plus through Pi OAuth:

```json
{
  "slug": "chatgpt-plus",
  "providerType": "pi",
  "authType": "oauth",
  "piAuthProvider": "openai-codex"
}
```

Claude Pro/Max through Pi OAuth uses the same shape with `slug: "claude-max"` and `piAuthProvider: "anthropic"`.

DeepSeek through a custom endpoint:

```json
{
  "slug": "deepseek",
  "providerType": "pi_compat",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://api.deepseek.com",
  "customEndpoint": { "api": "openai-completions" },
  "piAuthProvider": "openai"
}
```

A reasoning model behind a private gateway — reasoning asked for at the connection level, with one text-only model opting out:

```json
{
  "slug": "my-gateway",
  "providerType": "pi_compat",
  "authType": "api_key_with_endpoint",
  "baseUrl": "https://gateway.example.com/v1",
  "customEndpoint": { "api": "openai-completions", "supportsThinking": true },
  "models": [
    { "id": "gpt-5.6-sol", "contextWindow": 262144 },
    { "id": "fast-draft", "supportsThinking": false }
  ]
}
```

Reasoning that the endpoint *returns* (`reasoning_content` and friends) is parsed and rendered regardless of this flag — `supportsThinking` only controls what Bitlab asks for.

Local Ollama, no auth:

```json
{
  "slug": "ollama-local",
  "providerType": "pi_compat",
  "authType": "none",
  "baseUrl": "http://localhost:11434",
  "customEndpoint": { "api": "openai-completions" },
  "models": ["llama3.1:8b", "qwen2.5-coder:7b"]
}
```

## Operations

| Operation | Where | Effect |
|---|---|---|
| Add | Settings → Connections | Stores base URL, protocol, model list, and credential reference |
| Edit | Settings → Connections | Updates the same record; old credential reference is removed only when explicitly cleared |
| Delete | Settings → Connections | Removes the record and the credential reference |
| Test | per-row button | Sends a "ping" via Pi; succeeds on first token |
| Sync models | per-row button | Re-fetches the provider's model list |
| Manual model | add-model form | Inserts a model the provider did not advertise |
| Default | toggle | Sets the connection used when a session has no override |

A custom endpoint does not fall back to a key from another connection. Use the test action before selecting a connection for a session.

## Credential lifecycle

```text
Settings UI / Craft OAuth flow
   │  API key or OAuth access + refresh + expiry
   ▼
@bitlab/shared/credentials
   │  persist to <configDir>/credentials.enc (AES-256-GCM, key derived from
   │  the machine's hardware UUID) — readable from every Bitlab process
   ▼
connection record (no plaintext key)
   │
   ▼
runtime: full credential injected into Pi AuthStorage
   │
   ▼
Pi refresh: updated OAuth credential returned to the parent and persisted
```

When you delete a connection, the stored credential is removed *iff* no other connection still uses it. Tests inject fake backends rather than writing real credential stores; see `packages/shared/src/credentials/__tests__/`.

### Backends

`CredentialManager` holds a priority-ordered list of backends and picks per
credential via each backend's `accepts()`. Reads walk every eligible backend;
writes go to the highest-priority one that accepts the credential.

| Backend | Priority | Available in | Holds |
| --- | --- | --- | --- |
| `safe-storage` | 200 | Electron main process only | MCP OAuth tokens |
| `secure-storage` | 100 | every process | everything else |

MCP OAuth tokens are the exception because of who reads them. pi-mcp-adapter
runs inside the agent subprocess — a `bun` binary — and used to reach the OS
keychain from there. macOS binds a keychain entry to the code identity that
created it, and `bun` is an unstable one: several copies exist on a developer's
machine, signed by two different teams, and the vendored copy is re-signed on
every build. Every mismatch is another "bun wants to use your confidential
information" prompt. Electron's `safeStorage` binds the entry to the app bundle
(`app.bitlab.desktop`) instead, which is stable for the life of the product.

The subprocess therefore never touches the OS store: it is seeded with a
snapshot over `init` and reports changes back as `mcp_secret_write` /
`mcp_secret_delete`, which the main process persists and mirrors to the other
live sessions. See `packages/pi-agent-server/src/mcp/keyring-store.ts`.

LLM keys deliberately stay on `secure-storage`: `safe-storage` cannot be read
by a headless `packages/server` run, so moving them would hide every desktop
credential from the server on the same machine. A headless run authenticates
its own MCP servers and stores those tokens in `credentials.enc`.

## Limitations

- Bitlab does not look at environment variables as a substitute for storing credentials. The Desktop and WebUI always read from the credential manager.
- Per-workspace connections are not implemented; the registry is global. A workspace can still pin a single `defaultConnectionId`.
- Quota and rate-limit monitoring is delegated to the provider; Bitlab surfaces provider-reported errors verbatim.

## Verifying a connection

Connections are managed from Desktop or WebUI under Settings → Connections, where
each entry can be listed, tested, and promoted to default. Both clients read and
write the same connection registry.
