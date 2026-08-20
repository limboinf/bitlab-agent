# Interface sounds

Bitlab plays a short cue when something changes that you would otherwise have to
watch for: a turn finished, an agent is blocked on your approval, a message went
out. Sound is always additive — every cue has a visual, textual, and ARIA
equivalent that is unchanged when sound is off.

Cues come from [`uisfx`](https://uisfx.com/) using the **`minimal`** pack ("dry,
precise, almost invisible"). The library synthesizes each cue with the Web Audio
API at runtime; no audio files are bundled, fetched, or written to disk, so cues
work offline and add nothing to the installer.

The renderer is shared between Electron and the WebUI, so everything below
applies to both.

## What makes a sound

| Event | Cue | Fired when |
|---|---|---|
| Prompt sent | `send` | The submit handler runs |
| Prompt sent mid-turn | `queued` | Same handler, when the session is already processing |
| **Turn finished** | `complete` | The `complete` session event arrives |
| Turn failed | `error` | `error` or `typed_error` |
| Turn stopped | `stop` | `interrupted` — not on the Stop button itself |
| **Approval required** | `warning` | A tool permission or admin approval request arrives |
| Approval granted | `unlock` | After the response is acknowledged by the backend |
| Approval denied | `cancel` | After the response is acknowledged by the backend |
| Session deleted | `delete` | After the deletion is committed |
| Remote transport reconnecting | `connecting` (loop) | `connecting` / `reconnecting`, remote transports only |
| Remote transport recovered | `connect` | Loop stops, and the connection had actually dropped |
| Remote transport lost | `disconnect` | `disconnected` / `failed` |
| Typing | `typing` | Every local text-entry `input` event; off by default |

Outcome cues fire on the event that resolved the work, never on the click that
requested it, so a cue is always a true statement about state.

Sessions marked `hidden` (mini-agent sessions) stay silent, the same filter the
OS notifications use.

### What deliberately makes no sound

Hover, list selection, tab and panel changes, scrolling, background refreshes,
toasts, and disabled controls. A long `processing` bed while the agent works is
also intentionally absent: it would run for minutes at a time.

## Preferences

**Settings → App → Sound**

| Control | Default | Effect |
|---|---|---|
| Interface sounds | on | Master switch |
| Volume | Medium (0.7) | Soft 0.4 / Medium 0.7 / Loud 1.0 |
| Keystroke sounds | off | Adds the `typing` cue to local text entry |

Stored in `localStorage` alongside the app's other device-scoped preferences
(theme, appearance) rather than in the main-process settings file — speakers
belong to the machine you are sitting at, so a Desktop window and a WebUI tab on
a phone are free to disagree.

| Key | Value |
|---|---|
| `craft-sound-enabled` | `true` \| `false` |
| `craft-sound-volume` | `0`–`1` |
| `craft-sound-typing` | `true` \| `false` |

`prefers-reduced-motion` is not treated as an audio preference.

## Implementation

| Module | Responsibility |
|---|---|
| [`lib/sfx/cues.ts`](../apps/electron/src/renderer/lib/sfx/cues.ts) | Event → cue mapping and the transport reducer. No React, no player |
| [`lib/sfx/controller.ts`](../apps/electron/src/renderer/lib/sfx/controller.ts) | Unlock gate, loop registry, per-cue cooldown |
| [`lib/sfx/player.ts`](../apps/electron/src/renderer/lib/sfx/player.ts) | Module-level singleton, first-gesture unlock, teardown |
| [`lib/sfx/preferences.ts`](../apps/electron/src/renderer/lib/sfx/preferences.ts) | The single persistence seam, read by both the player and the atom |
| [`atoms/sfx.ts`](../apps/electron/src/renderer/atoms/sfx.ts) | Preference state for the settings UI |
| [`hooks/useSfx.ts`](../apps/electron/src/renderer/hooks/useSfx.ts) | `useSfx`, `useSfxPreferences`, `useSfxRuntime` |

### Unlock

Nothing plays on load. A capture-phase `pointerdown` / `keydown` listener resumes
the `AudioContext` on the first genuine gesture. Until then, asynchronous cues
are **dropped rather than queued** — otherwise your first click would replay a
reconnect that happened ten minutes ago. Gesture cues (`send`, `typing`, the
settings controls) play synchronously inside their handler.

### Lifetime

The player is a module singleton, not component state: React Strict Mode's
double mount and panel remounts cannot produce a second `AudioContext`. It is
disposed once, on `pagehide`. The `AudioContext` is created by `uisfx`, so there
is no caller-owned context to close separately.

### Loops

`connecting` is the only loop. Starts are idempotent; the loop stops on success,
failure, mute, workspace switch, component cleanup, and disposal, and its handle
is cleared each time. A workspace switch calls `stopAll()` and then re-asserts
the loop, so a connection that is still visibly reconnecting does not go silent.

### Cooldowns

`send` and `queued` are guarded for 150 ms, which absorbs a control that answers
both pointer and keyboard activation. Outcome cues are guarded for 400 ms so
several sessions finishing in the same tick produce one cue. `typing` is never
throttled.

## Tests

`apps/electron/src/renderer/lib/sfx/__tests__/` covers semantic mapping, cue
timing, suppression before unlock, loop idempotence and cleanup on every exit,
mute persistence, pointer/keyboard de-duplication, singleton reuse across
remounts, and degradation to silence without a `window`. One test renders every
cue the app references through `uisfx`'s own recipe renderer, so a cue name that
disappears upstream fails the suite rather than the app.
