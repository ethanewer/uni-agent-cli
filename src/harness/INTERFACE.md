# The `HarnessAdapter` interface

> A single, unified boundary between `cc` and every agent harness.
> Implemented under `src/harness/` and enforced by
> `tests/adapter_boundary.test.mjs` plus `tests/harness_adapter.test.mjs`.

## Purpose

Every live main or `/btw` session crosses the same `HarnessAdapter` boundary.
The TUI consumes normalized capabilities, methods, and events; it never reaches
through an adapter to a harness's wire protocol or raw SDK messages.

Harness-specific behavior belongs in one of two places:

- a per-harness adapter, for launch settings, capabilities, live-session
  operations, and storage semantics such as Codex copy-forking; or
- a per-harness bridge behind that adapter, when a real harness SDK operation
  has no ACP v1 equivalent. The built-in Claude bridge uses this path for cwd,
  context append, tasks, checkpoints, branch names, and Remote Control.

Host-only rendering, input, and process orchestration stay in the TUI. The TUI
may retain normalized presentation state returned by the interface, but scopes
it to the owning adapter connection and session. For example, Remote Control's
`{enabled,url,error?}` display state is never read from Claude internals and a
harness/session transition cannot reuse another session's URL. ACP plan,
Claude Task/TodoWrite, and Cursor todo snapshots likewise become one bounded
`checklist` event/state consumed by `/todos`; `/tasks` remains the separate
background-process lifecycle surface. The persistent
permission indicator likewise reads the unified adapter/host permission policy,
not a harness-specific mode ID. Cold management operations that do not
participate in a live model turn may use
adapter-injected services, but cannot create a competing live-session path.

A single harness-agnostic permissions engine (`src/harness/permissions.mjs`)
owns the policy: it generates each backend's native auto-approve dialect from
one unified `permissions.mode`, persists "allow always" grants cc-side, and
decides allow/deny/ask uniformly. Harness knowledge is data in a dialect table
(`auto`/`gatedAuto`/`prompt`/`infer`) extensible through
`registerPermissionDialect()`. `BaseAcpAdapter` invokes the engine, so adapter
subclasses carry no permission decision code. See `docs/permissions-audit.md`.

## The abstraction

`cc` talks to **one live-session interface** — `HarnessAdapter`. Each harness
adapts to that interface, which is the single target for future harnesses.

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
| `delete` | bool | wire (`sessionCapabilities.delete`) | session deletion |
| `models` | bool | wire (`configOptions` model) | `/model` |
| `modes` | bool | wire (`modes`/`configOptions`) | `/mode`, `/plan` |
| `reasoningEffort` | bool | wire (`configOptions` thought_level) | `/effort` |
| `image` | bool | wire (`promptCapabilities.image`) | image paste |
| `retractPrompt` | bool | declared | unsend (Esc retract) |
| `commandPresets` | string[] | declared | local preset dialogs (e.g. `/review`) |
| `interactiveRequests` | bool | declared | backend-initiated prompts (`ask_question`…) |
| `autoApprove` | bool | unified engine (`permissions.mjs`, from mode) | permission auto-accept |
| `terminal` | bool | always true (cc executes) | shared terminal |
| `mcp` | bool | ACP v1 stdio baseline (`mcpCapabilities` adds optional transports) | MCP servers supplied when a session starts |
| `audio` | bool | wire (future) | audio prompt parts |
| `embeddedContext` | bool | wire (`promptCapabilities.embeddedContext`) | structured `@file` prompt resources |
| `auth` | bool | wire (`authMethods`) | ACP authentication-method selection |
| `logout` | bool | wire (`agentCapabilities.auth.logout`) | ACP logout flow |
| `changeWorkingDirectory` | bool | negotiated cc extension | local `/cd <path>` |
| `appendContext` | bool | negotiated cc extension | context-only shell results |
| `backgroundTasks` | bool | negotiated cc extension | `/tasks` lifecycle list/stop/background |
| `checkpoints` | bool | negotiated cc extension | `/rewind`, `/checkpoint`, `/undo` list/restore |
| `remoteControl` | bool | negotiated cc extension | `/remote-control [name\|off]`, `/rc` |
| `namedFork` | bool | negotiated cc extension | optional branch name in `/branch [name]` |

## The contract

### Required (every adapter)

```text
key: string
label: string
capabilities: Capabilities          // valid after connect(); pre-connect = declared subset
buildLaunchSpec(settings): AgentSpec // native-settings → spawn args/env/sessionMeta/startupMode/autoApprove
async connect(options?)              // spawn + initialize (+ first session unless {createSession:false})
async newSession(options?)
async prompt(parts): {stopReason, usage?} // usage is normalized turn accounting when advertised
cancel()
stop(): Promise                         // terminal close; signals synchronously
stopAndWait(): Promise                  // complete process-tree teardown
forceResolvePrompt(): boolean           // settle a cancelled prompt if needed
async acquireSessionLoadGuard(id): release  // hold adapter-owned safety fences across loadSession
setRuntimePermissionMode(mode?)         // host-owned in-memory policy override
getSessionInfo(): SessionInfo        // sessionId, capabilities, configOptions, models, modes, agentInfo
```

The workflow worker extension is optional so adapters written against the
pre-workflow interface remain loadable while workflows are disabled:

```text
getWorkflowCapabilities(): WorkflowCapabilities
getResolvedModel(): {id, verified} | null
getWorkflowDefaults(): {model?, effort?}
async applyWorkflowModel(id): {id, verified}
async applyWorkflowReadOnly()
async applyWorkflowAgentType(id)
```

`WorkflowCapabilities` independently reports `childCwd`, `modelOverride`,
`modelVerification`, `usage`, `mcpLaunch`, `terminalLaunch`,
`enforcedReadOnly`, and `agentProfiles`. These are truthful launch/session
properties used by dynamic workflow workers; they are not inferred from a
backend name. An explicit workflow model or read-only request fails closed when
the adapter cannot apply and verify it. An adapter without the extension fails
closed as a workflow worker only after the user opts in; it still conforms to
the ordinary harness contract.

The workflow adapter factory is also passed `workflowLaunch: {model?, effort?}`
before construction. This permits launch-argument-only model selection; the
connected adapter must still return the exact selection from `getResolvedModel()`
with `verified: true`. `modelOverride` means a post-connect change is supported,
while `modelVerification` may be true for a read-only live model projection.
When `usage` is true, each completed `prompt()` may return normalized turn usage
under `usage`; missing measurements remain explicitly unknown and are charged by
the workflow runtime's conservative fallback.

### Optional (capability-gated — only called when the matching flag is set)

```text
async listSessions(): Session[]                 // sessionList
async loadSession(id)                           // resume
async deleteSession(id)                         // delete
async fork(parentSessionId)                     // fork !== false  (base = native; codex = copy)
async setConfigOption(id, value, type?)         // all advertised config options, including booleans
async setMode(id)                               // modes
async authenticate(methodId, meta?)             // auth; agent RPC or client-run terminal/env flow
async logout()                                  // logout
async changeWorkingDirectory(path, options?)    // changeWorkingDirectory
async appendContext(text)                       // appendContext
async listBackgroundTasks(options?)             // backgroundTasks
async stopBackgroundTask(taskId)                // backgroundTasks
async backgroundTasks(toolUseId?)               // backgroundTasks
async listCheckpoints(options?)                  // checkpoints
async rewindCheckpoint(id, mode, options?)       // checkpoints; conversation/both atomically loads the returned branch
async setRemoteControl({ enabled, name? })       // remoteControl; toggles only the existing local session
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
async onElicitationRequest(params): result       // optional; settles negotiated URL/form elicitation
elicitationCapabilities: { url?, form? }         // optional mode support; form must be explicit
async runTerminalAuthentication(spec, method)   // optional override for terminal auth/TUI suspension
async collectEnvironmentVariables(method, env)  // optional override for env_var credential input
```

`BaseAcpAdapter` resolves each advertised authentication method by type. Agent
methods use the ACP `authenticate` request. Client-run `terminal` and `env_var`
methods use the host overrides above (or the built-in terminal/prompt helpers),
then restart the ACP connection with the same resolved launch spec. Environment
credentials are kept only on that in-memory launch spec. Elicitation is
advertised only when `onElicitationRequest` is present. URL support remains the
compatibility default; form support must be explicitly declared through
`elicitationCapabilities.form`, so an agent cannot choose a UI flow the host
would necessarily cancel.

### Normalized events (identical to today's `AcpClient.onEvent` shape)

`text` · `user_text` · `commands` · `tool` · `tool_update` · `line` ·
`session_info` · `background_tasks` · `checklist` · `backend_activity` ·
`backend_exit` · `error` · `cursor_todos` (legacy compatibility).
Adapters speak this generic event vocabulary; raw plan/task SDK frames never
reach the TUI.

## Where harness differences live

| Difference | Adapter-side home |
| --- | --- |
| Fork semantics | `adapter.capabilities.fork` + `adapter.fork()`; Codex implements copy-fork |
| Session ownership | `acquireSessionLoadGuard()`; Codex rejects rollouts leased by another live cc process |
| Prompt retraction | `snapshotRetractionState()` / `canRetract()` |
| Command preset UI | `interceptCommand()` returns a normalized preset dialog |
| Native config/env/args/meta | `buildLaunchSpec()` and adapter translation hooks |
| Permissions | shared `permissions.mjs` policy and dialect data |
| Cursor interactive extensions | `handleExtensionRequest()` |
| Claude SDK-only operations | pinned bridge negotiates generic cc extension capabilities |

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

## Boundary enforcement

- `HarnessApp.createRuntimeAdapter()` is the only production constructor for
  main, `/btw`, and dynamic-workflow adapters.
- `createAcpConnection()` is the sole production `new AcpClient(...)` site. It
  is injected below the adapter boundary and is not exposed to TUI call sites.
- A built-in bridge is selected only for cc's exact pinned Claude adapter.
  Explicit custom ACP commands receive only capabilities they negotiate.
- Bridge messages are parsed, bounded, and normalized before they cross the
  adapter. Raw Claude SDK frames never enter the shared renderer.
- `tests/adapter_boundary.test.mjs` checks construction and wire-capability
  boundaries structurally; feature tests exercise every negotiated extension
  through transport, base adapter, and TUI layers.
