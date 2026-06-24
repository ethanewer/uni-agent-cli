# The `HarnessAdapter` interface

> A single, unified boundary between `cc` and every agent harness.
> Prototype lives under `src/harness/`. Verified by `tests/harness_adapter.test.mjs`.

## The problem

Today `cc` mostly talks to backends through one generic `AcpClient`, but a
handful of harness-specific behaviours are sprinkled through `pi-harness.mjs`
as `this.activeKey === "codex"` / `agentInfo.name === "codex-acp"` branches and
name-keyed `switch` statements:

| Coupling | Where (today) |
| --- | --- |
| Codex copy-fork (`~/.codex` rollout) | `runBtw` ladder + `forkCodexSession` |
| Codex prompt **unsend** | `isCodexAcpActive` + `readCodexThreadState` + `tryUnsendPendingPrompt` |
| Codex `/review` preset dialog | `shouldOpenCodexReviewDialog` / `openCodexReviewDialog` |
| Codex `-c key=value` config | `applyConfigSettings` (key === "codex") |
| Claude `_meta` settings | `applyNativeSettings` (key === "claude") |
| Cursor arg-insert-before-`acp` | `applyNativeArgs` (key === "cursor") |
| Cursor `/btw` refusal | `runBtw` (key === "cursor") |
| Permission auto-accept inference | ~~`applyNativePermissionSetting` (per-name)~~ → now the unified engine (`permissions.mjs`) |

Adding a harness that needs *any* of these means editing those switches.

> **Permissions are no longer per-name.** A single harness-agnostic engine
> (`src/harness/permissions.mjs`) owns the policy: it *generates* each backend's
> native auto-approve dialect from one unified `permissions.mode`, persists "allow
> always" grants cc-side, and decides allow/deny/ask uniformly. `BaseAcpAdapter`
> calls it (`applyPermissionMode`), so adapters carry zero permission code. See
> `docs/permissions-audit.md`.

## The abstraction

`cc` should talk to **one interface** — `HarnessAdapter` — and never name a
harness. Each harness ships an adapter that adapts it to the interface. The
interface is the **single target** every future harness adapts to.

```
        ┌─────────────────────────────────────────────┐
  cc ──▶ │            HarnessAdapter (interface)        │ ◀── the single target
        └─────────────────────────────────────────────┘
              ▲          ▲          ▲           ▲
        BaseAcpAdapter   │          │           │
              ▲          │          │           │
   ┌──────────┼──────────┼──────────┼───────────┼─────────── adapters ──┐
   │ ClaudeAdapter  CodexAdapter  CursorAdapter  OpenCodeAdapter  …       │
   └──────────────────────────────────────────────────────────────────┘
                                   │
                         AcpConnection (transport)
                       (real AcpClient, or a fake in tests)
```

- **`BaseAcpAdapter`** implements the entire generic-ACP floor + every
  capability-gated feature by wrapping an `AcpConnection`. Most harnesses are a
  ~10-line subclass of it.
- **Per-harness adapters** override only the hooks for their niceties.
- `cc` constructs adapters through `createAdapter(key, agentConfig, host)` and
  uses only interface methods + the declared `capabilities`.

## Capabilities (everything optional)

`adapter.capabilities` is a plain descriptor. Every feature is optional; a
harness that doesn't set a flag simply doesn't get that feature, and `cc`
degrades gracefully. Flags are either **declared** by the adapter (static) or
**derived from the wire** after `connect()` (dynamic).

| Capability | Type | Source | Gates |
| --- | --- | --- | --- |
| `fork` | `false \| "native" \| "copy"` | declared + wire | `/btw` side thread |
| `resume` | bool | wire (`loadSession`/`resume`) | `/resume` load |
| `sessionList` | bool | wire (`sessionCapabilities.list`) | `/resume` picker |
| `models` | bool | wire (`configOptions` model) | `/model` |
| `modes` | bool | wire (`modes`/`configOptions`) | `/mode`, `/plan` |
| `reasoningEffort` | bool | wire (`configOptions` thought_level) | `/effort` |
| `image` | bool | wire (`promptCapabilities.image`) | image paste |
| `retractPrompt` | bool | declared | unsend (Esc retract) |
| `commandPresets` | string[] | declared | local preset dialogs (e.g. `/review`) |
| `interactiveRequests` | bool | declared | backend-initiated prompts (`ask_question`…) |
| `autoApprove` | bool | unified engine (`permissions.mjs`, from mode) | permission auto-accept |
| `terminal` | bool | always true (cc executes) | shared terminal |
| `mcp` | bool | wire (future) | MCP servers |
| `audio` | bool | wire (future) | audio prompt parts |
| `embeddedContext` | bool | wire (future) | `@file` embedded context |
| `auth` | bool | wire (`authMethods`) (future) | ACP auth flow |

## The contract

### Required (every adapter)

```text
key: string
label: string
capabilities: Capabilities          // valid after connect(); pre-connect = declared subset
buildLaunchSpec(settings): AgentSpec // native-settings → spawn args/env/sessionMeta/startupMode/autoApprove
async connect(options?)              // spawn + initialize (+ first session unless {createSession:false})
async newSession(options?)
async prompt(parts): {stopReason}
cancel()
stop()
getSessionInfo(): SessionInfo        // sessionId, capabilities, configOptions, models, modes, agentInfo
```

### Optional (capability-gated — only called when the matching flag is set)

```text
async listSessions(): Session[]                 // sessionList
async loadSession(id)                           // resume
async fork(parentSessionId)                     // fork !== false  (base = native; codex = copy)
async setConfigOption(id, value)                // models/modes/reasoningEffort
async setMode(id)                               // modes
snapshotRetractionState(): token | undefined    // retractPrompt
canRetract(token): boolean                      // retractPrompt
interceptCommand(name, arg, backendNames): PresetDialog | null   // commandPresets
async handleExtensionRequest(method, params): result | undefined // interactiveRequests
```

### The host (what `cc` provides to an adapter)

```text
onEvent(event)                          // normalized UI events (see below)
async requestPermission(params): outcome
async requestInteraction(method, params): result
```

### Normalized events (identical to today's `AcpClient.onEvent` shape)

`text` · `user_text` · `commands` · `tool` · `tool_update` · `line` ·
`session_info` · `backend_activity` · `backend_exit` · `error` · `cursor_todos`.
`cc`'s renderer is unchanged — adapters speak the event vocabulary it already
consumes.

## How each coupling collapses

| Old coupling | New home (no harness name in cc) |
| --- | --- |
| `runBtw` fork ladder | `if (adapter.capabilities.fork) await adapter.fork(parentId)` |
| `forkCodexSession` | `CodexAdapter.fork()` (`fork: "copy"`) |
| unsend `isCodexAcpActive`/state | `adapter.snapshotRetractionState()` / `adapter.canRetract()` |
| `/review` dialog | `adapter.interceptCommand("review", …)` → `PresetDialog` |
| `-c` / `_meta` / arg-insert | `adapter.buildLaunchSpec(settings)` |
| auto-accept inference + auto/ask/deny + "allow always" | unified `permissions.mjs` engine (mode → native config + cc-side decision + persisted grants) → `capabilities.autoApprove` |
| cursor/* extensions | already wire-method-gated in transport; surfaced via `handleExtensionRequest` |
| cursor `/btw` refusal | falls out of `capabilities.fork === false` (no special case) |

## Adding a harness

1. Write `adapters/<name>.mjs` extending `BaseAcpAdapter` (override only what
   differs — usually just `buildLaunchSpec` for native flags).
2. Add one line to `registry.mjs`.

No change to the interface, the base, or `cc`. opencode and pi are each a
~15-line file (see `adapters/opencode.mjs`, `adapters/pi.mjs`). What a harness
*doesn't* implement is simply a capability it doesn't advertise.

## What stays on cc's side (generic orchestration, not harness coupling)

These are deliberately *not* in the adapter — they are backend-agnostic cc
behavior that reads adapter outputs:

- **Fork-id recording** (`recordForkId(adapter.sessionId)`) for the `/resume`
  "(fork)" label — cc UI state; the new id is exposed via `adapter.sessionId`.
- **Stop-reason notices** — cc reads `{stopReason}` returned by `adapter.prompt`.
- **Prompt-part / image-paste splitting** — cc builds prompt parts and gates
  image parts on `adapter.capabilities.image`.
- **Unsend lifecycle** (when to snapshot / arm / disarm on Esc) — generic; only
  the "is the last prompt still retractable?" judgment is the adapter's
  (`snapshotRetractionState()` / `canRetract()`).

See `host-example.mjs` for the exact generic helpers (`openSideThread`,
`dispatchSlashCommand`, `armUnsend`/`canUnsend`) — these are the name-free
replacements for the per-harness branches, and they are exercised by the tests.

## Wiring it into cc (the remaining integration step)

This prototype is verified standalone (and via `host-example.mjs`), but `cc`
(`pi-harness.mjs`) does not yet consume it. Integration is mechanical:

1. In `HarnessApp`, replace `new AcpClient(agent, …)` with
   `createAdapter(activeKey, agent, host, { settings })`; route all calls through
   the adapter; drop `applyAgentSettings` in favor of `adapter.buildLaunchSpec`.
2. `runBtw`: replace the cursor refusal + `supportsFork()`/`forkCodexSession`
   ladder with `openSideThread(forkAdapter, parentId)`.
3. `handleSlashCommand`: replace `shouldOpenCodexReviewDialog`/`isKnownCodexReviewCommand`
   with `dispatchSlashCommand(adapter, …)`.
4. Unsend: replace `isCodexAcpActive()` + `readCodexThreadState()` with
   `armUnsend`/`canUnsend`.
5. Permissions/cursor: pass `requestPermission`/`requestInteraction` into the
   host; delete the `agent._autoPermissionRequests ? …` branches (the adapter
   now owns auto-accept for both permissions and interactive prompts).
6. Delete the name-keyed `applyConfigSettings`/`applyNativeSettings`/
   `applyNativePermissionSetting`/`applyNativeArgs` switches.
