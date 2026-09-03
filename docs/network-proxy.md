# Network proxy

Settings can enable HTTP and HTTPS proxy URLs plus a comma-separated no-proxy list.
Leaving them empty is the normal case: Bitlab falls back to the proxy the machine
already uses.

## Where the proxy comes from

Resolved once at startup, and again whenever the setting is saved. First match wins:

| Priority | Source | Notes |
|---|---|---|
| 1 | In-app setting | An explicit "off" means direct — it does not fall through |
| 2 | `HTTP_PROXY` / `HTTPS_PROXY` env vars | Only visible when the app is launched from a shell |
| 3 | Operating system proxy | Read through Chromium, including PAC scripts |
| 4 | Direct | |

The third row exists because Node's HTTP stack ignores the OS proxy entirely,
while Chromium follows it. Without that step a fully proxied machine still dialed
out direct from the Node side, so region-locked endpoints (OpenAI's OAuth token
exchange, for one) rejected the app while the user's browser reached them fine.

`session.resolveProxy()` answers in PAC syntax (`DIRECT`, `PROXY host:port`,
`SOCKS5 host:port`, or a fallback list). Bitlab takes the first entry it can dial;
SOCKS4 is skipped because undici cannot use it. A system-derived proxy is applied
to the Node side only — Chromium keeps following the OS itself, so its per-URL PAC
routing stays intact.

The resolved proxy is also exported to spawned subprocesses as `HTTP_PROXY` /
`HTTPS_PROXY`, since a subprocess has its own Node runtime and cannot see either
the dispatcher or the OS setting.

Check `[proxy] Applying proxy settings` in the main log to see which source won.

## Where the proxy applies

| Layer | Uses the proxy |
|---|---|
| Electron network session | yes |
| Model requests (Pi subprocess) | yes |
| `web_search`, `web_fetch` retrieval | yes |
| Browser pane (Renderer process) | yes |
| Pi SDK subprocess outbound HTTPS | yes |
| Localhost / `127.0.0.1` requests | no (treated as `no_proxy`) |
| `localhost`-only Ollama | no |

## Redaction guarantee

Proxy credentials are sensitive. They must not appear in:

- Server logs (`~/.bitlab/logs/bitlab-server-*.log`)
- Session JSONL
- Session exports

The shared network interceptor redacts the following keys before any I/O:

```text
authorization, cookie, set-cookie, x-api-key, token, key, secret,
password, credential, auth
```

## Configuring

Per-workspace settings → "Network proxy":

```text
HTTP proxy:        http://user:pass@proxy.example:8080
HTTPS proxy:       (optional; falls back to HTTP proxy)
No proxy:          localhost,127.0.0.1,.local
```

`No proxy` is parsed as a comma-separated host/CIDR list. Wildcards (`*.local`) and CIDR ranges (`10.0.0.0/8`) are supported.

## Environment override

The proxy settings page can be temporarily overridden by exporting the standard env vars before launching the app:

| Variable | Layer |
|---|---|
| `HTTP_PROXY` / `http_proxy` | Used by Node-side HTTP clients in the headless server |
| `HTTPS_PROXY` / `https_proxy` | Same, for HTTPS |
| `NO_PROXY` / `no_proxy` | Comma-separated no-proxy list |
| `ALL_PROXY` | Default when `HTTP_PROXY`/`HTTPS_PROXY` is unset |

These are read only when the in-app setting is empty — saving a setting takes
precedence, including when it is switched off. Note that an app launched from the
Dock or Finder inherits no shell environment at all, which is why the OS proxy
fallback matters more than these variables in practice.

## Sandbox notes

On macOS, NSLocalNetworkUsageDescription is set so the Browser pane can reach LAN addresses with explicit user permission. Without the prompt, LAN access is silently denied and never appears in the privacy pane.

## Prefer the OS proxy

Bitlab picks the OS proxy up on its own, so leaving the in-app setting empty is
the recommended setup:

- macOS: System Settings → Network → Proxies
- Linux: `HTTP_PROXY` env var via systemd user environment
- Windows: Settings → Network & Internet → Proxy

This avoids dragging credentials into Bitlab's setting file and keeps them out of any future import/export scenario.
