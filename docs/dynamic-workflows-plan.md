# Dynamic Workflows for `cc`

Status: WIP snapshot; twenty-one three-review iterations completed, iteration-21 fixes awaiting full tests and iteration-22 review

Policy amendment: workflows are disabled by default. `/workflow-mode` persists
one of `disabled`, `clone-only`, or `flexible` (`/workflows mode` is also
available after opt-in).
Clone Only snapshots the originating harness, verified model, and observable
reasoning effort and enforces that exact tuple for every worker; script-level
attempts to change it fail before adapter launch. Flexible permits any
configured pair that the adapter can apply and verify. When Flexible omits all
routing fields, the originating harness inherits each independently verified
parent model and effort field; an unavailable effort never causes a verified
parent model to be dropped. Selecting another harness uses that harness's
configured defaults only when the connected adapter verifies the active model; an unverified configured ID fails before prompting. The selected policy is
enforced by the manager/executor, not merely represented in the TUI.

Disabled compatibility is a hard boundary: except for the opt-in
`/workflow-mode` command, cc follows its pre-workflow startup, command catalog,
rendering, status, adapter configuration, and shutdown paths. Workflow modules
are dynamically imported only after opt-in; disabled startup does not create a
registry, manager, broker, history reader, summary component, or MCP server.
It does not scan workflow files or add workflow state to `/status` or the
persistent footer. cc's own `/workflow` and `/workflows` commands enter
autocomplete only while enabled; same-named commands advertised by a backend
remain visible and backend-routed exactly as they were before this feature.
This makes the default feature dormant rather than merely denied.
Switching an enabled session back to Disabled closes the workflow page, stops
and awaits every run and worker process tree, retires completion deliveries,
stops and unloads the broker/manager/registry, and reconnects the active harness
to the same durable conversation without workflow MCP configuration or adapter
wrappers. A session that cannot be durably reloaded is detached after its tree
is confirmed stopped; any tree that cannot be confirmed stopped prevents a
normal Disabled transition and requires process recovery/restart. Shutdown
therefore returns to the dormant pre-feature path as well.
Workflow-mode transitions run on one FIFO lifecycle tail: rapid enable/disable
requests cannot overlap subsystem startup, rollback, adapter replacement, or
teardown, a failed request does not poison later queued intent, and process
shutdown freezes and joins the transition tail before snapshotting workflow
resources for teardown. If a disable permanently stops the manager but cannot
finish backend teardown, the retained subsystem is marked restart-required and
cannot be reused by a later queued enable. Shutdown initiates bounded backend
termination before joining an in-flight transition, so a disable waiting on an
internal prompt drain cannot deadlock process exit.
Switching directly between Clone Only and Flexible reloads the same durable
conversation with a freshly injected MCP server, so the model-facing tool
description and broker enforcement always advertise the same current policy.
The first Disabled→Enabled transition does the same reload for an already
connected main harness, assigning its workflow adapter identity immediately;
an existing `/btw` fork is retired because it cannot be safely reinjected.

## Goal and compatibility boundary

Add Claude Code-style dynamic workflows to `cc`: the active model can author a JavaScript orchestration program at runtime; `cc` approves and starts it in the background; the program coordinates many agents; and `/workflows` provides a live hierarchical TUI with pause, resume, stop, restart, inspect, and save controls.

The script surface will be intentionally close to Claude Code and to the MIT-licensed [`imsai-sh/open-dynamic-workflows`](https://github.com/imsai-sh/open-dynamic-workflows):

```js
export const meta = {
  name: "review-and-fix",
  description: "Review a change in parallel, then fix verified issues",
  phases: ["Review", "Fix"],
};

const reviews = await parallel([
  () => agent("Review correctness", { label: "correctness", phase: "Review" }),
  () => agent("Review tests", { harness: "codex", model: "gpt-5.3-codex", phase: "Review" }),
]);

phase("Fix");
return await agent(`Fix these verified issues:\n${reviews.join("\n")}`);
```

Supported globals:

- `agent(prompt, { harness?, model?, label?, phase?, schema?, isolation?, agentType?, readOnly? })`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `phase(title)`
- `log(message)`
- `workflow(name, args?)`
- `args`
- `budget.total`, `budget.spent()`, and `budget.remaining()`

`harness` is the cc-specific spelling of the reference implementation's executor selection. Omitting both `harness` and `model` uses the exact parent harness/model when that model can be observed. If the parent model cannot be observed, it uses that harness's configured default and labels the model as unverified rather than guessing. Selecting a different harness without a model uses that harness's configured default. An explicit model must be applied and verified by the adapter or the node fails before sending a prompt.

“Any supported model/harness pair” means every configured pair that the corresponding `HarnessAdapter` can launch and truthfully confirm. All bundled adapters will implement this extension. Third-party adapters remain loadable under the unchanged base interface; after workflow opt-in, an adapter without the optional worker extension fails closed as a worker. An adapter that implements the extension may use its normal configured launch default when no model is requested, while explicit model overrides fail closed until it advertises apply-and-verify support.

### Exact node option semantics

The runtime validates and freezes every option before scheduling:

- `harness`: configured adapter key; default is the origin harness.
- `model`: non-empty model ID; default follows the inheritance rules above.
- `label` and `phase`: bounded display strings only.
- `schema`: JSON Schema object compiled under the bounded Ajv policy. Regex-bearing
  `pattern`/`patternProperties` schemas are rejected because JavaScript regex
  evaluation has no enforceable host-side deadline.
- `isolation`: `"shared" | "worktree"`; default is `"shared"`.
- `readOnly`: boolean; default `false`. This is an enforcement request, not a declaration. The call fails before prompting unless the selected adapter can enter and verify a no-workspace-write mode.
- `agentType`: optional advertised agent/profile ID. It is applied through the adapter's generic config option and fails if that harness does not advertise the requested profile. It never implies read-only behavior.
- `cache`, if supplied for forward compatibility, must be `"never"`. This version deliberately does not replay completed model calls during recovery.

Shared-cwd mutating calls acquire a canonical-repository-identity lease shared
across cc processes, so two such calls cannot write concurrently. The lease is
an atomic hard-link ownership claim carrying a random token, PID, process-start
identity, and inode; only a demonstrably dead owner is reclaimed, and the
atomic reclaim gate starts a fresh ten-second grace interval at the first
fenced death observation rather than trusting lock-file age. Release verifies
the same token/inode, preventing stale-lock ABA. Enforced read-only
calls may run concurrently. `isolation: "worktree"` gives the attempt a
dedicated worktree and permits concurrent mutation; it fails before adapter
creation outside a suitable Git worktree. `isolation: "worktree", readOnly:
true` first creates the worktree and then applies/verifies adapter read-only
enforcement, failing before the prompt if either step fails. cc never
automatically merges a worktree. The TUI reports changed files and offers an
explicit apply operation with a diff/confirmation, while dirty or recoverable
worktrees are retained.
The approved launch directory is also captured as canonical root/device/inode
and revalidated from a no-follow directory handle before lock acquisition,
after the mutation lease, around worktree setup, after adapter connection, and
before every model prompt. A path replacement therefore fails closed before a
worker can be prompted in a different checkout.

Public numeric inputs are rejected rather than clamped. `tokenBudget` is either omitted/`null` (no token admission ceiling) or a safe integer from 1,000 through 1,000,000,000. `maxConcurrency` is omitted (default 8) or a safe integer from 1 through 16; effective run concurrency is `min(requested, configured global cap, configured run cap)` and the approval view shows both requested and effective values. Configuration may lower but not raise compiled maxima. In scripts, `budget.total` and `budget.remaining()` are `null` when unlimited; otherwise they are safe integers. `budget.spent()` is a non-negative safe integer carrying exact/estimated quality in the run projection rather than smuggling `Infinity` or `NaN` into source, hashing, or journals.

The source grammar matches the reference implementation: a pure `export const meta = { ... }` literal, ordinary JavaScript statements, top-level `await`, and an optional top-level `return`. Static/dynamic imports and other exports are syntax errors. Source is transformed by the reference's tested top-level `export const meta` removal and async-function wrapper; it does not require experimental VM modules.

## What is reused and what is new

### Ported from existing tested work

The following pure runtime pieces will be ported from `open-dynamic-workflows` with its MIT notice and adapted to ESM/cc naming:

- literal-only `meta` extraction and validation;
- progress event and result shapes;
- `agent`, `parallel`, `pipeline`, `phase`, and `log` behavior;
- deterministic guards for `Date`, timers, and randomness;
- append-only JSONL journal structure;
- schema validation and structured-output retry behavior;
- nested workflow depth and total-agent limits;
- reference runtime and progress projection tests.

The port is deliberately limited. The reference project's Claude/Codex subprocess executors, CLI parser, JSONL model-output parsers, and terminal renderer will not be used because they bypass cc's adapter and TUI interfaces. Its semaphore will be replaced with an abort-aware, app-global scheduler. Its worktree fallback and unconditional result replay will not be copied because they are unsafe for cc's mutable coding tasks.

Established dependencies are preferred over new protocol/security code:

- the official MCP JavaScript SDK for the stdio server/client protocol;
- Ajv for JSON Schema validation;
- macOS Seatbelt for the fail-closed OS isolation boundary, with Node's child-process, permission, and VM facilities as defense in depth;
- cc's existing `HarnessAdapter`, permission queue, normalized events, keybinding, theme, and Pi TUI components.

### New cc-specific code

Everything below is integration code that does not exist in the reference implementation:

- workflow launch capabilities on harness adapters;
- exact child-session cwd and model routing;
- an adapter-backed agent executor and global adapter ownership registry;
- a host-owned workflow manager and app-global scheduler;
- the MCP launch bridge and authenticated local broker;
- workflow-specific approval tied to exact source and limits;
- origin-safe completion delivery through cc's normal prompt queue;
- conservative persisted recovery that reruns the full script after explicit approval;
- worktree lifecycle and explicit apply/retain behavior;
- rich TUI views integrated with `/btw`, permissions, and the composer;
- settings, commands, packaging, documentation, and end-to-end tests.

## Feasibility gate before the full runtime

The first implementation milestone is a vertical adapter spike, not the JavaScript runtime. It must prove, with fake ACP servers and contract tests, that cc can do all of the following through its existing harness abstraction:

1. Start a child adapter with an explicit cwd.
2. Discover the resolved model, apply an explicit model, and verify it where advertised.
3. receive normalized streaming/tool/usage events and cancel the child process tree;
4. route overlapping child permission and elicitation requests through the shared queue;
5. inject and call the workflow launch surface from each workflow-capable bundled parent harness;
6. enqueue a hidden internal follow-up to one exact originating session.

If a bundled adapter cannot satisfy a claimed capability, the capability is reported as unsupported and the UI/tool reports the limitation. No fallback silently changes cwd, model, origin session, or harness.

## Architecture

### 1. Explicit adapter contract changes

Extend `HarnessAdapter` and its capability validation with workflow-facing operations instead of smuggling data through private agent fields:

```js
getWorkflowCapabilities() // { childCwd, modelOverride, modelVerification,
                          //   usage, mcpLaunch, terminalLaunch, enforcedReadOnly,
                          //   agentProfiles }
connect({ cwd?, mcpServers?, ...existingOptions })
getResolvedModel()        // { id, verified } | null
applyWorkflowModel(id)    // applies before first prompt, returns verified model
applyWorkflowReadOnly()   // enters and verifies a no-write mode before prompting
applyWorkflowAgentType(id)
```

The exact method names may be adjusted to fit the current interface. This extension is required and contract-tested for workflow-capable workers but remains optional in the base adapter conformance check, preserving pre-workflow third-party adapters. `AcpClient.sessionRequestParams()` will accept an explicit workflow-child cwd while retaining dynamic `process.cwd()` lookup for ordinary adapters. The bundled Python bridge will retain `session/new.cwd`; Terminus-2 and mini-swe-agent will use that session cwd rather than looking for a non-standard prompt cwd.

Model routing is harness-owned:

- adapters with ACP model config apply the option before the first prompt and read it back from `session_info`;
- launch-time-only adapters build a per-child launch spec with the requested model and report the resolved model after connection;
- workflow-child instances of the bundled Python bridges expose their configured model as an ACP config option and reject unknown/unapplicable changes; ordinary bridge sessions retain their pre-feature wire response;
- explicit model selection never degrades to a configured default after an apply/verification failure.

The generic workflow runtime sees only `{harness, model, cwd}` and never switches on a native CLI name.

`readOnly` is capability-gated independently of cc's approval UI. A host permission policy that merely asks before writes is not an enforced read-only mode. An adapter may advertise it only when the backend sandbox/permission mode blocks workspace writes for the entire child session. Bundled terminal agents that cannot establish this remain valid mutating workers but reject `readOnly: true`.

Usage becomes a normalized optional event/capability. cc treats each normalized `session/prompt` usage result as turn-level accounting and sums complete initial/correction measurements. A complete final-session snapshot may substitute only for a missing single-turn result, because after corrections it contains the latest turn rather than every prior delta. Partial or absent usage falls back for the whole attempt: the executor accounts every request and every raw intermediate/final text event before display/journal truncation at one token per UTF-8 byte plus a conservative 64 Ki-token backend-owned system/tool allowance per request; the result is explicitly marked estimated.

### 2. Pure workflow runtime (`src/workflows/`)

Add focused modules rather than expanding `pi-harness.mjs`:

- `types.mjs`: frozen script/event/result contracts and bounds.
- `meta.mjs`: literal metadata extraction without execution.
- `sandbox-parent.mjs` and `sandbox-child.mjs`: isolated script process and RPC.
- `schema.mjs`: Ajv compilation and bounded correction attempts.
- `journal.mjs`: versioned metadata, checksummed JSONL records, bounded history loading, and whole-script recovery metadata.
- `sandbox-child.mjs`: the runtime primitives exposed inside the isolated VM.
- `manager.mjs`: execution state, nesting, cancellation, and final results.
- `registry.mjs`: project/personal saved workflows.
- `worktrees.mjs`: isolated checkout creation, validation, retention, and cleanup.

The runtime depends on injected `executeAgent`, `executeNestedWorkflow`, scheduler, journal, and event-sink functions. It has no ACP or TUI imports.

### 3. Script process and threat model

`node:vm` alone is not a security boundary. Each workflow runs in a dedicated Node process with a small newline-framed RPC protocol to the manager. The child receives the approved source and arguments over stdin and can request only named runtime operations. It receives no adapter, socket, filesystem path, environment secret, or manager-owned object.

The sandbox child itself owns the VM bridge. It installs one frozen synchronous send callable with a null prototype, then creates the public `agent`/`phase`/`log`/nested-workflow wrappers inside the VM realm. Each async wrapper allocates its promise and pending `{resolve,reject}` entry inside the VM, assigns a monotonically increasing request ID, and passes only cloned request data plus that ID to the send callable. The callable returns only a primitive acknowledgement, never a host-realm promise.

When a validated parent response arrives, the child bounds and JSON-serializes its data, parses that plain data, and calls a VM-realm dispatcher reference retained only by the sandbox host. The approved source cannot name the send callable or dispatcher. The dispatcher settles and deletes the VM-owned pending entry. Rejections cross only as sanitized `{code,name,message}` data and are reconstructed as an error inside the VM. Unknown/duplicate IDs, unserializable values, late responses after cancellation, and response-order races are rejected or ignored according to the RPC state machine. No adapter, parent callback, promise, or broker object crosses the bridge.

The context is created with string and WebAssembly code generation disabled, strict wrappers, frozen exposed intrinsics, no dynamic import callback, and a small non-writable exposed surface. A reflected escape could at most reach the already OS-confined sandbox child; the security boundary remains the Seatbelt-restricted process, while parent RPC still accepts only the same bounded operations available through the public hooks.

The only production mode is strict mode. There is no silent trusted fallback. cc retains its baseline Node 22 requirement so Disabled mode remains backward compatible. This release executes workflow source only on macOS: enablement probes a deny-by-default Seatbelt profile around the exact Node executable, then separately probes Node's permission model. Workflow launch stays unavailable unless Seatbelt denies arbitrary filesystem read/write, network, and child-process creation and Node additionally denies filesystem, network, child-process, and worker access. This also makes Node 22.0–22.12 valid Disabled-mode runtimes even though workflow opt-in fails closed there. The child is spawned with `shell: false`, an explicit environment containing only `CC_WORKFLOW_SANDBOX=1` plus `OPENSSL_CONF=/dev/null` for deterministic Node startup, and exactly three pipe descriptors. No parent environment, inherited IPC descriptor, project cwd capability, or broker token is present.

Defense in depth:

- use a deny-by-default Seatbelt profile that admits system/Node runtime files plus the immutable sandbox bootstrap but denies user/project/temp reads, all filesystem writes, network, and child creation;
- retain Node's permission model inside that OS boundary so filesystem, network, child processes, workers, native addons, WASI, inspector, and environment secrets are denied again;
- run a `vm` context inside that restricted child with no `process`, `require`, dynamic import, usable WebAssembly code generation, timers, ambient clock, or randomness;
- remove external-memory allocators from the workflow VM, set V8 heap and independently monitored process-RSS ceilings, and enforce an overall wall-clock limit plus a five-second heartbeat deadline that kills synchronous infinite loops, in addition to the bounded limits below;
- validate every RPC message and ignore/terminate on unknown methods, invalid IDs, oversized frames, or protocol reentrancy violations;
- kill the full sandbox process tree on stop or shutdown and confirm exit.

The enable-time probes independently cover the OS boundary's denied filesystem reads/writes—including a real non-runtime file adjacent to the installed Node binary—network, child creation, and environment inheritance and Node's denied filesystem/network/child/worker capabilities. The Seatbelt manifest is derived from the exact executable and recursively inspected dynamic-library files; Homebrew receives only the individual dependency formula `lib` directories required by dyld, never a Node-installation parent, the complete Cellar/opt trees, or a caller-owned project tree. Runtime tests separately exercise missing process/require/bridge globals, string and Wasm generation denial, frozen arguments, malformed frames, bounded output, detached calls, heartbeat termination, and process-tree exit. Static and dynamic imports are rejected by the non-executing parser. A platform/Node build that fails either probe cannot execute workflow source.

Default enforceable limits, with the launch-relevant subset included in the approval identity, are: 256 KiB source, 64 KiB serialized args, 1 MiB RPC/worker-ACP frame, 512 KiB final result, 64 KiB per event text field, 1 MiB retained trace per agent, 8 MiB aggregate retained host-event data, sandbox-response backpressure, and worker-ACP stdin backpressure, 1,000 agents with 20 attempts per agent, nesting depth 4, 64 total/8 live sandbox processes per run, 10,000 total/2,048 pending sandbox RPC calls per run, 32 broker sockets with 64 total/16 per-socket in-flight requests, 16 active agents globally, 8 per run, 8 per harness, 2,048 pending leases, 60 launch attempts per minute, 1,000 remembered approvals in a 128 KiB file, 128 live/awaiting-delivery runs, 128 MiB sandbox heap, 256 MiB sandbox RSS, 30 minutes per agent, 2 hours per script, 10,000 projected events, 32 MiB journal data and 64 MiB metadata per run. Crossing a sandbox/RPC/worker-transport bound—including a child-to-parent request frame—aborts the entire run rather than returning a catchable local error. JSON args and operation results are parsed inside the VM realm, and host callbacks return only primitive sentinels, so approved code never receives a host-realm object or error constructor. Delivery-terminal runs move to a newest-100 ordinary in-memory history. Live runs and archived runs with retained worktrees share a 228-entry recovery-critical capacity: this preserves the ordinary 100 retained-worktree allowance while allowing an entire 128-run live crash cohort to change state without overflowing solely because of that transition. Recovered orphan markers are added to the same durable/indexed capacity; quarantined and other manual-recovery markers use explicit durable `actionable` index entries so independent cc processes share the same admission count. The durable index is bounded at 456 entries including recovery-unknown candidates, while the shared live/actionable constraint and 100-entry ordinary cap keep the normal known-state population at 328 or fewer. Startup uses one aggregate 128 MiB ledger shared by ordinary journal loading, recovery fallbacks, corrupt/invalid reads, and orphan-worktree journal attachment. The separate journal/metadata caps keep every valid run below that per-run reader ceiling, so clean terminal state never degrades into the launch-time interrupted fallback. A dead live run's independent capsule is considered before its large journal; aggregate exhaustion never overwrites an unread exact capsule, and orphan attachment cannot demote that candidate from recovery-critical live state before a later bounded startup reads it. Directory discovery counts every entry under a 50,000-entry/five-second bound, allows one additional bounded 128-run crash-window cohort, and fails closed on unexpected entry types before reconciling durable state to the steady-state cap. Retained-worktree classification streams directory entries under a shared 50,000-entry, 32 MiB, five-second scan budget and validates the full marker identity before treating `appliedAt` as non-actionable. Orphan discovery likewise must complete its bounded physical scan before it publishes a cursor or recovered set; a deadline/cap truncation, inaccessible child, symlink run entry, or non-regular marker fails workflow enablement rather than hiding retained state. History-index and imported-workflow read/modify/write operations use cross-process token/inode ownership locks plus fsynced atomic replacements. Opportunistic orphan-claim cleanup is signal-aware and bounded independently by entry count and five seconds; cancellation is never reinterpreted as evidence that a live claim is malformed. State readers reject non-regular paths with `lstat` before any potentially blocking open. The Ajv validator cache gives each entry an isolated Ajv instance and is LRU-bounded by both entry count and schema-source bytes, so eviction also releases Ajv's internal compiled-schema cache.

### 4. App-global scheduler and adapter-backed executor

Configured harness executables are trusted local software, matching cc's
foreground harness threat model. The parent-pipe supervisor owns their normal
process group and tracks observed detached descendants for lifecycle cleanup;
the preserve-natural-exit terminal path checks both observed descendants and
the owned process group before allowing the supervisor to exit;
controlled ACP shutdown reports a unique confirmed-tree exit sentinel only
after those checks; every other supervisor code or signal is recorded as a
sticky unconfirmed-tree failure, including a parent force-kill at its deadline;
workflow-owned ACP terminal subprocesses use the same sentinel plus a separate
bounded status pipe for the backend's natural exit code/signal, so terminal
semantics—including when descendants require cleanup—are preserved without
confusing supervisor loss for confirmation;
it is not an OS container and cannot contain a deliberately hostile executable
that daemonizes outside the inherited tree between process-table samples.

`src/workflows/scheduler.mjs` owns bounded app-global concurrency, not one semaphore per run. It enforces:

- a configurable global active-agent cap;
- a smaller per-run cap;
- optional per-harness caps;
- a bounded pending queue;
- FIFO fairness across runs;
- abort-aware waiting and pause gates;
- total-agent and nesting limits enforced by the manager.

`src/workflows/adapter-executor.mjs` executes one attempt in this order:

1. Resolve the harness and validate configuration plus requirements that can be checked before launch; live model/effort verification occurs after the fresh session connects.
2. Acquire the app-global scheduler lease. Until this succeeds, the worker remains queued with attempt zero; the lease grant atomically creates and journals the attempt.
3. Acquire the shared repository mutation lease when the call is shared and mutating, or allocate one clean attempt-owned worktree at `<run>/<agent>/<attempt>` when isolation is requested.
4. Clone the agent configuration and construct one workflow-owned adapter through `HarnessApp.createRuntimeAdapter()`.
5. Connect/create a fresh session using the resolved cwd.
6. Apply and verify the explicit/inherited model, optional agent profile, and requested read-only mode against that live session.
7. Send the prompt only after every requested property is verified.

A failed preflight/allocation never launches an adapter. A post-connect verification failure tears the adapter down without prompting. Each restart creates a new attempt, up to the per-agent cap, and when isolated creates a new clean worktree from the recorded base; a dirty older attempt worktree is retained rather than reused.

It consumes normalized events into bounded live/detail projections. For schema output it appends a JSON-only response contract, parses the bounded result, validates it with Ajv, and allows at most two correction prompts in the same child session.

Every attempt has an `AbortController` and generation ID. The scheduler-admission publication callback races that same signal, so a stalled journal write cannot retain an active lease or hang shutdown. Connect and every
pre-prompt model/effort/profile/read-only lifecycle RPC race the same agent
deadline. Abort immediately starts `stopAndWait()` even when no session exists,
then finalization joins that process-tree fence and removes interactive-request
ownership. A restarted attempt cannot resolve the original script promise after
its generation has been retired.

### 5. Workflow manager and orchestrator interaction

`src/workflows/manager.mjs`, owned by `HarnessApp`, is the sole mutable authority for runs. It stores:

- origin `{adapterId, sessionId, generation, harness, verifiedModel, cwd}`;
- immutable runtime events and bounded run/phase/agent projections;
- approval, source hash, limits, scheduler leases, attempts, adapters, and delivery state;
- persisted interrupted/completed run metadata.

The orchestrator interacts with a running workflow in three ways:

1. Starting: it calls `Workflow` and immediately receives `{taskId, status, name, phases}` after approval and durable allocation. Execution continues in the background.
2. Polling/control: it calls `WorkflowStatus({taskId, action?})` to inspect, pause, resume, or stop. Human TUI actions invoke the same manager methods.
3. Completion: the manager queues one hidden `<task-notification>` back to the exact originating session. The orchestrator can then summarize the result or continue its task. Intermediate agent output is available to the generated script, not injected into parent context.

The manager maintains a generation-aware registry of all main, `/btw`, and workflow adapters eligible for permission/elicitation requests. Requests are bounded, labeled with workflow/run/agent identity, and invalidated when their adapter generation ends. The existing global dialog queue remains the focus arbiter.

### 6. Workflow launch surfaces

Use the official MCP SDK for `src/workflows/mcp-server.mjs`. A private authenticated broker in the cc process owns all privileged operations. The stdio MCP process exposes:

- `Workflow({script|name, args?, tokenBudget?, maxConcurrency?})`
- `WorkflowStatus({taskId, action?: "status"|"pause"|"resume"|"stop"})`

MCP lifecycle coverage includes initialize, initialized, tools/list, tools/call, ping, cancellation, shutdown, and disconnect. The broker uses bounded input and output frames, bounded reflected request IDs, a hard per-socket queued-output ceiling with fail-closed backpressure, constant-time token checks, and a socket bound inside an atomically created and verified owner-only temporary directory (with socket chmod as defense in depth), plus origin/generation binding, revocation that aborts already-authenticated in-flight calls, and no generic method dispatch. A successful launch response carries an unpredictable one-use delivery token. The MCP bridge acknowledges the initial task response, receives the broker's matching acceptance confirmation, and sends a final confirmation ACK; only then does the manager commit execution, after which the bridge waits for the matching committed frame before returning tool success. The manager durably allocates the approved run but holds source execution behind these non-executing handshake stages. Timeout, disconnect, a rejected acceptance, or a failed response/confirmation write before the final ACK invokes the registered rollback while the run is still unexecuted, so a transport-level buffered write cannot strand a workflow that the originating model never received. Session-changing checkpoint rewinds rotate and bind a fresh token around the same commit/rollback boundary as load/fork, while code-only rewinds retain the current token. A failed Disabled→Enabled transition stops and unloads every newly constructed workflow object before returning the error, preserving the dormant Disabled boundary even when socket startup or settings persistence fails.

If the final committed frame is lost after the final ACK, the MCP bridge
reconciles the durable task ID through the origin-bound status method instead
of retrying the launch and duplicating execution. That internal reconciliation
requires the manager's execution-releasing commit state; a merely accepted,
still-rollbackable run cannot be mistaken for success. Every settled helper
call closes its per-call broker socket on both success and error.

For harnesses that genuinely host stdio MCP servers, cc injects this server at `session/new`. The Python bridges currently discard MCP configuration and truthfully report `mcpLaunch: false`: they remain usable as workers and humans can launch workflows while they are active, but their models cannot originate a workflow tool call through cc.

After opt-in, humans have `/workflow <name>` and `/workflows`, independent of whether the active model can originate a tool call. Arbitrary `scriptPath` input is intentionally not exposed: models submit source bytes or a pre-registered content-addressed name, avoiding a path traversal/symlink read primitive. Every bundled harness remains usable as a workflow worker, subject to its normal installed external prerequisites, even if it cannot itself originate a dynamic workflow tool.

Workflow child adapters do not receive the launch MCP server by default. Nested workflows use the script's `workflow()` primitive and share the parent run's limits.

### 7. Approval and source integrity

Workflow consent is separate from normal tool permission. The approval view shows workflow identity, origin tuple, phases, requested token budget/effective concurrency, exact approval hash, recovery warning when applicable, and whether routing is flexible. `View source` displays the exact captured source inside a fence longer than every model-authored backtick run, so source cannot escape or spoof the review surface.

Approval choices are Run once, Run and remember this exact workflow for the project, View source, and Cancel. A remembered approval is keyed by:

- canonical workflow identity and origin scope, including the project's race-safe canonical root/device/inode identity rather than only its path;
- SHA-256 identity over the exact source bytes and serialized args;
- runtime/API version;
- workflow mode, effective concurrency/compiled limits, and token admission settings;
- saved-file identity.

Named model launches resolve only to source bytes already imported into cc's content-addressed registry by an explicit human `/workflow <name>` launch. Project discovery never follows symlinks: roots and every candidate component are checked as owned regular directories/files, the final file is opened with no-follow flags, and the opened bytes are copied to the private registry before becoming callable by a model. Approval and execution use the same captured bytes; there is no second workspace-file read. Every nested imported workflow must carry the exact canonical-root/device/inode identity approved for its parent run, preventing namespace crossover after a directory replacement.

`disableWorkflows` and `CC_DISABLE_WORKFLOWS=1` disable injection and run commands.

### 8. Pause, stop, restart, and conservative persisted recovery

These terms are distinct:

- Pause closes the run's scheduler gate. Active agents finish; queued agents do not start.
- Resume after pause reopens that in-memory gate.
- Stop agent immediately publishes `stopping` on both the agent and its active attempt, aborts the current attempt, and returns a typed stopped result to the script after teardown. Run-level stop publishes the same truthful teardown state for every nonterminal agent/attempt.
- Restart agent immediately publishes `restarting`, retires and tears down the current generation, waits for confirmed exit, then runs the same prompt/options as a replacement generation. Only the replacement may settle the script promise, and repeated restart requests during that teardown are rejected instead of acknowledging a replacement that will not be created.
- Stop run atomically makes stop intent supersede any racing restart, aborts all active attempts, removes pending leases, waits for the sandbox and adapter process trees to exit, and journals both the run and active attempts as stopped. Stop remains admissible through the durable `run_completed` append; the manager checks abort immediately after that boundary and only then commits an in-memory completion flag that makes later stop requests return false.
- A process crash replays the bounded checksummed event journal into an interrupted projection, including attempt history and retained worktrees. Admission also writes a bounded, versioned independent recovery capsule containing source plus SHA-256, serialized args, token budget, requested/effective concurrency, project identity, run-directory device/inode, and complete policy origin before the event journal can grow. Active journal metadata must independently satisfy the same exact tuple. Only exact state may publish a rerunnable source or retire a live recovery slot; a partial display fallback remains inspectable but cannot launch recovery. If the shared startup ledger cannot read even an exact capsule, the candidate stays durably live/recovery-critical so a later startup can recover its exact inputs instead of replacing them with a generic archived fallback.
- Recover loads the exact persisted source/args/budget, creates a new run linked by `recoveryOf`, and asks for a recovery-specific approval that states every model call will rerun.

No completed agent result is replayed in this version. This is intentionally more conservative than the reference runtime because coding agents may already have changed a shared workspace or external service. `cache: "workspace"` is rejected. Recovery never begins automatically, and remembered approval for the original run does not cover the recovery identity.

Worktree isolation is fail-closed. Worktrees are attempt-owned with run/agent/attempt-scoped names, path-validated, and retained when they contain changes or when a worker committed a moved HEAD. Git subprocesses have an absolute timeout, run as owned process groups on POSIX, and poll the actual parent/child PID tree so ordinary helpers that call `setsid()` remain tracked. Every Git child after discovery—including filter inspection, status/preview, cleanup, and final apply—goes through a supervisor that changes into and rechecks the recorded checkout/repository device and inode. The supervisor opens both the worktree-specific Git directory and shared common directory with no-follow directory descriptors, rechecks their recorded device/inode values immediately before spawn, and holds those descriptors until Git has started. macOS does not permit Git to traverse `/dev/fd/N`, so Git receives the corresponding canonical metadata paths; concurrent hostile same-UID pathname replacement after the final check is outside the configured-harness trust boundary, just like a configured executable replacing itself during launch. Adapter workers use the same OS-held-cwd pattern for the approved project/worker directory. Cancellation escalates TERM to KILL and settles only after both the group and every observed descendant are confirmed gone; unavailable tracking fails closed. Dynamic workflows are macOS-only in this release; other platforms resolve persisted workflow settings to the dormant Disabled state before importing the subsystem. The bundled Terminus bridge holds its private tmux server as a foreground child so it stays inside the owned lifecycle. Every worker supervisor, including preserve-natural-exit terminal supervisors, treats its manager-owned stdin EOF as owner death and terminates/confirms the backend tree. As with configured harness executables, Git and any configured helper are trusted local programs: a deliberately hostile helper that daemonizes and exits between process-table samples is outside the lifecycle guarantee and is not a sandbox boundary. Repository hooks are disabled and configured filters are neutralized before project Git operations. This includes repository-identity discovery and retention cleanup, so stop/restart cannot hang behind a wedged observed Git child. Every mutating shared-checkout or Git operation acquires both a canonical path-stable lock and a device/inode-only identity lock for the checkout, then the same path/identity pair for the canonical Git common directory when distinct, and revalidates both fingerprints before entering the operation. The path lock spans same-path inode replacement, while the pathname-independent identity lock spans rename; the checkout-first/common-second hierarchy keeps one mutation domain if a worker creates, removes, renames, or replaces repository metadata while another process waits. A dead manager PID does not make any ownership lock reclaimable for ten seconds, which exceeds the worker supervisor's bounded EOF-triggered descendant shutdown fence. Repository identity falls back to the current directory only when a successfully spawned Git process conclusively reports that the directory is not a repository; missing Git, timeout, cancellation, identity substitution, and every other discovery error fail closed so separate subdirectories cannot split the cross-process mutation lock. Apply requires the same recorded repository and a target state matching the preview, including staged-index contents; cc shows the binary-capable patch and changed/untracked file list, performs `git apply --3way --check`, re-fingerprints the target after that potentially long check immediately before spawning the mutating Git operation, and asks for confirmation. The three-way apply uses an isolated copy of the target index so workflow changes land only in the working tree and preserve the user's staging area byte-for-byte. Preview and apply share one absolute Git deadline per operation, pass cancellation through every Git call, register a visible working-tree mutation gate that blocks conflicting prompts/shells/switches, and are synchronously aborted then awaited during shutdown. A conflict or target change detected before mutation leaves the target unchanged. Cleanup never silently discards unmerged edits or commits.

Worktree marker contents must reproduce the agent/attempt identity encoded by the filename as well as the run directory and checkout path. Before `git worktree add`, cc durably writes a `pre-add` marker containing the canonical repository/run/attempt identity. After the add, it validates the checkout root/device/inode plus the worktree-specific Git-directory and common-directory identities and atomically upgrades the marker to `ready`; status, preview, apply, release, and recovery verify that complete fingerprint before invoking Git. Startup reconciles an interrupted `pre-add` marker against Git's registered worktree list: an absent checkout is cleaned up, an exact checkout is fingerprinted and upgraded, and any identity mismatch or replacement remains actionable for manual recovery rather than being trusted.

The ten-second dead-owner delay begins under the atomic reclaim gate at the
first fenced death observation; it never derives from the age of an already-old
lock file.

Workflow ACP `session/new` receives `.` rather than the approved directory's
absolute pathname, preserving the supervisor's kernel-held cwd reference across
rename/substitution. Any unconfirmed worker, sandbox, or Git tree immediately
fences manager admission, aborts remaining runs, retains live run leases, and
requires process restart; cleanup and recovery may never downgrade that class
of error to a warning. ACP/configured child environments are serialized through
a bounded private descriptor; the trusted Node supervisor starts with a fixed
minimal environment (`PATH=/usr/bin:/bin` plus deterministic locale/time-zone
values), then applies the full
requested environment only to the identity-validated supervised child.

### 9. Journals and delivery semantics

Every workflow-owned state directory is created one component at a time and revalidated as private, current-user-owned, and non-symlink before use; production begins from the canonical prepared state root. History startup validates `workflow-runs` and each indexed run directory before any index read or ownership-lock write. The manager may pre-create a run directory while acquiring its live lease, but that directory is revalidated before persistence. Run metadata is written atomically and durably through an exclusive, randomized, owner-only temporary file followed by rename, syncing both the replacement and its parent directory; a predictable pre-created symlink can never be opened or truncated. The append-only `events.jsonl` is created exclusively so a raced final-path symlink fails before any append. Every metadata read, including the read-modify-write path, checks the file type and 64 MiB ceiling before allocation. Event/result records are appended in one serialized chain with sequence numbers, checksums, explicit durable boundaries for lifecycle/control events, schema versioning, truncated-tail recovery, and bounded startup history scans. Ownership-lock acquisition reaps demonstrably dead unlinked claims for that lock name (and grace-aged malformed pre-publication claims), while hard-linked claims remain governed by the token/inode stale-owner protocol. A retained orphan-worktree marker is attached to the in-memory recovery projection; archived apply takes the per-run update lock, consults bounded metadata without requiring a valid event tail, and durably publishes or reconstructs the recovered snapshot before the first target mutation.

History discovery recognizes only the exact version-4 randomized filename shape of an interrupted index replacement, and worktree discovery likewise recognizes the exact randomized recovery-cursor temporary shape, so owned crash artifacts cannot disable later recovery while arbitrary extra files still fail closed. Live ownership uses a private sibling `workflow-run-leases` namespace keyed by run ID rather than a lock inside the replaceable journal directory. Journal metadata and snapshots must reproduce both the enclosing run ID and its recorded directory device/inode before they can publish state. Approval, registry, saved-source, lock, journal, cursor, and marker readers precheck with `lstat`/descriptor type checks, open with no-follow plus nonblocking flags, and use fixed-cap descriptor reads, preventing FIFOs, replacement races, and post-`fstat` growth from blocking or exceeding startup bounds. Personal and project saved-workflow directories must be current-user-owned and reject group/world write permission before source discovery or save.

Completion delivery must not call `adapter.prompt()` directly. Add a host-owned `enqueueInternalPrompt({adapterId, sessionId, generation, parts, deliveryId})` that enters the same busy/queue state machine as a normal prompt while suppressing only the synthetic user echo.

Failed pre-execution launch cleanup holds the live run lease until the unindexed
directory is deleted and its parent fsynced; a cleanup error deliberately keeps
the process-owned claim live. Orphan worktree recovery removes a marker on
`ENOENT` only after independently proving the managed checkout itself is absent;
a missing repository/common-directory path retains the marker and surfaces an
actionable recovery error.

Delivery guarantees are separated by boundary:

- the completed workflow result is durably recorded once under its run ID;
- the journal records a stable `deliveryId` and queued/sending/delivered/ambiguous state;
- insertion into one live cc host queue is deduplicated by that ID;
- synthetic notification text is suppressed from the visible user transcript;
- ACP backend delivery is at-least-once, not exactly-once, because ACP prompt has no universal idempotency key or durable acknowledgement.

The notification includes its delivery ID and instructs the orchestrator to ignore a duplicate. If sending fails after the durable `sending` mark, cc records the state as ambiguous and leaves it visible in `/workflows`; it does not automatically resend or pretend to know whether the backend received it.

Normal delivery behavior:

- live exact origin idle: enqueue immediately;
- live exact origin busy: enqueue after its turn;
- origin session temporarily switched away on the same still-live adapter generation: retain and deliver if that generation later reloads the exact session, including across cc's sanctioned enabled-mode policy reload that replaces only the transient adapter ID;
- origin replaced or not resumable: keep the result durably visible in `/workflows` and show a notice; never redirect to another session.

There is no rebinding across adapter generations. A destroyed `/btw` adapter, a true harness replacement, or a restarted cc process makes automatic delivery ineligible even if a later adapter loads a session with the same ID; the result remains in `/workflows` for explicit human action.

After a cc restart, persisted delivery state remains inspectable but is not automatically rebound or resent.
An internal completion already removed from a `/btw` queue remains registered
as an active delivery submission. Side close, workflow disable, and process
shutdown await that submission's durable delivered, ambiguous, or retired
transition before unloading the workflow manager.

### 10. Budgets

Token budgets are admission controls, not falsely advertised hard ceilings. Before a new agent starts, exact accumulated usage is checked when available; otherwise the per-request UTF-8-byte-plus-backend-overhead estimate is checked and marked `~`. Schema contracts, correction requests, and intermediate outputs are all charged. A single in-flight model call can overshoot the remaining budget because ACP offers no universal mid-call token cutoff.

If a harness reports no usage after a prompt, the run is labeled estimated and bounded output/time limits provide enforceable backstops; an attempt that fails before prompting remains unknown. Budget exhaustion prevents new leases and raises a deterministic budget error into the script. Nested workflows share the same manager counter, and nested arguments are revalidated against the same 64 KiB serialized bound before registry lookup or sandbox allocation. Both run and attempt projections persist and display exact, estimated, or unknown usage quality across restart/crash replay.

### 11. TUI integration

Add `src/workflows/tui.mjs` using existing Pi TUI and cc theme primitives:

- `WorkflowTaskSummary`: coalesced compact active-run rows above the status/footer.
- `WorkflowPage`: full hierarchical run browser opened by `/workflows` or Enter on a summary.
- `WorkflowDetail`: bounded prompt, normalized tool activity, output/error, harness/model, attempt, usage, timing, and worktree data.
- an approved-source level inside `WorkflowPage`, plus save/approval dialogs.

When enabled, the persistent bottom status line includes `workflows clone only`
or `workflows flexible`. It has no workflow segment in Disabled mode, preserving
the old footer byte-for-byte for the same non-workflow state.

Hierarchy: runs → phases → agents → attempt detail, plus approved-source and worktree-patch preview views. Controls match Claude Code where applicable: arrows/Enter/right drill in, Escape/left goes back, `j`/`k` scroll, `p` pause/resume, `x` stop, `r` restart selected agent, `c` recover an interrupted run, `v` view source, and `s` to choose personal/project save scope with explicit collision-overwrite consent.

A queued agent has no attempt row until its worker actually starts; replay and the live TUI preserve the same distinction.

There will be one cc-owned page/focus stack rather than a second alternate-screen owner. `/btw`, workflow pages, permissions, elicitation, approval, and the composer use explicit precedence. Permission dialogs can interrupt a workflow page; closing them restores the previous selection/scroll. The main composer remains usable while workflows run.

The workflow page renders inside the existing root view with the command panel, composer, and status footer pinned below it. Opening it over `/btw` preserves that side thread and closing it restores the previous page. Selections are bound to run/phase/agent/attempt identities rather than mutable sorted-list indexes, so a newly arriving run cannot retarget a control. Runtime projections, retained tool tails, total host event count, and detail text are bounded, and narrow/short terminals use the same width/height clipping primitives as the rest of cc.

Every model-, workflow-, adapter-, repository-, and journal-controlled value is
escaped before it enters a terminal component. A shared host sanitizer renders
C0/C1 bytes, ANSI/OSC introducers, Unicode format/bidi controls, and Unicode
line separators as visible `\\uXXXX` text. Multi-line source/output/patch views
preserve only ordinary newlines; metadata, labels, refs, paths, tool titles,
errors, and menu text use a single-line projection. Host-generated styling is
applied after sanitization. Approval shows the sanitized projection while its
identity hash and execution continue to cover the exact original source bytes.
Regression fixtures exercise hostile metadata, source, output, tool titles,
errors, filenames, refs, and patches.

### 12. Saved workflows and packaging

Saved locations:

- project: `<project>/.cc/workflows/<name>.js`
- personal: `<cc-state>/workflows/<name>.js`

Project wins on collision. Project resolution/list/save receives the current launch or UI cwd on every operation, so `/cd` cannot leave it bound to the repository where workflows were first enabled. Metadata is parsed without executing source. Saving uses path containment checks, exclusive create/explicit overwrite, restrictive personal permissions, and atomic replacement.

Content-addressed named imports are keyed by the canonical project device/inode/root identity and workflow name. Model launches and nested `workflow()` calls must provide the originating project root, so importing a same-named workflow in another project cannot change or authorize the current run's nested source. Source objects are written to unique temporary files, fsynced, atomically linked at their hash path, and directory-synced before the import index commits; an existing object is accepted only after its complete bytes reproduce the requested hash.

Project-workflow namespace identity, discovery, reads, and saves use a small packaged Python helper because Node does
not expose portable `openat`-style directory-relative I/O. The helper walks the
canonical project root with no-follow directory descriptors, verifies the
opened descriptor still has the originally validated device/inode and ownership, creates/opens `.cc/workflows` relative to
held descriptors, enumerates entries from the held workflow descriptor, reads
final regular files with no-follow, and links or
replaces saved destinations relative to that same descriptor. If those POSIX
primitives or `python3` are unavailable, project I/O and model/nested named
imports fail closed. Personal workflows use a packaged Node helper that validates
the private root, changes into and rechecks that exact directory identity, then
performs all list/read/save operations relative to the stable child-process cwd;
they therefore remain available without Python. Runtime-submitted source also
remains launchable: its approval namespace uses the canonical launch directory
plus device/inode read from a no-follow Node directory handle, rechecked after
the approval dialog, without reading or writing project workflow paths. A human
personal-workflow launch skips its optional project import when the helper is
unavailable. This prevents a
same-user symlink-swap race between validation and file access.
One absolute ten-second deadline and abort signal are created before project
identity or path work and shared by every helper operation in that registry
request. Timeout/revocation terminates the helper process group, escalates to
SIGKILL, and resolves only after its exit is observed.

Update `package.json.files`, the lockfile, and package verification so `src/workflows/**`, the MCP entry point, notices, required dependencies, the project MIT license, the Apache-2.0 license for vendored Pier/Terminal-Bench portions, and Pier's upstream NOTICE attribution ship in the npm artifact. The package SPDX expression declares both MIT and Apache-2.0. Provenance is pinned in `NOTICE`: open-dynamic-workflows records an exact commit and archive SHA-256, the Pier-derived code records the byte-matched `datacurve-pier` 0.2.0 source-distribution SHA-256, and the Terminal-Bench-derived ACP bridge records the exact upstream commit that preceded the vendoring date. The clean-prefix package smoke test runs lifecycle scripts, verifies required ACP/native components, imports and exercises the installed workflow runtime/dependencies, and invokes the generated bin shim rather than relying on repository-only files. The paid live GPT-5.6 E2E likewise packs and installs first, then drives that installed shim. A protected `workflow_dispatch` release environment runs the deterministic gates plus that authenticated test and retains its log artifact; `npm run release:workflows` is the corresponding local release command. Ubuntu and Windows CI jobs cover Disabled-mode clean installation and import the installed persisted-mode resolver to prove Flexible is forced to Disabled without static workflow imports, including invocation of the generated Windows `.cmd` shim, while macOS retains the mandatory execution/TUI gate. `/workflow` lists saved workflows when invoked without a name.

The protected authenticated release job packs once and passes that exact
tarball to every gate, then retains the package, its SHA-256, the live result,
and logs as one artifact set.

## Changes to existing files

- `src/harness/interface.mjs` and `INTERFACE.md`: truthful workflow cwd/model/usage/launch capabilities and contract validation.
- `src/harness/acp-base.mjs` and ACP runtime: explicit session cwd/MCP options, resolved model verification, normalized usage.
- bundled adapters and Python bridges: model/cwd support and truthful launch capability.
- `src/pi-harness.mjs`: own the manager/scheduler, page stack, adapter registry, internal prompt queue, rendering, shutdown fence, and `/workflow-mode`/`/workflow`/`/workflows` commands using the existing command/keybinding machinery.
- `src/workflows/**`: runtime, process isolation, manager, broker, executor, persistence, worktrees, and TUI.
- `package.json`, lockfile, package tests, and `NOTICE`: dependencies, shipped files, and MIT attribution.
- `README.md`: script API, routing, launch-capability matrix, controls, limits, persistence, safety, and examples.

Existing structural tests that count `createRuntimeAdapter()` call sites will be updated to enforce the new centralized factory boundary rather than simply expecting the old count.

## Test plan

### Disabled compatibility tests

- default construction/startup does not import or construct workflow modules,
  scan workflow state, start a broker, or alter adapter launch configuration;
- ordinary ACP cwd lookup remains dynamic unless a workflow child supplies an
  explicit fixed cwd;
- legacy third-party adapters still satisfy the base interface while optional
  workflow-worker capability fails closed only after opt-in;
- the pre-feature footer, `/status`, shutdown ordering, and normal prompt queue
  are unchanged, while `/workflow-mode` is the only new cc-owned command;
- wire-level ordinary bridge sessions retain their pre-feature `session/new`
  response and do not expose workflow-only model mutation;
- executable shutdown coverage confirms a dormant broker is neither stopped nor
  inserted into the disabled shutdown fence;
- cc-owned workflow commands stay absent from the disabled merged catalog while
  same-named backend advertisements retain their original visibility/routing.

### Ported runtime tests

Adapt the reference tests for metadata, determinism, hooks, pipeline behavior, schema validation, nesting, events, journals, cancellation, and projections. Attribution comments identify the MIT source.

### Adapter and feasibility contract tests

- explicit child cwd reaches `session/new` and the actual worker;
- parent model observation and exact explicit model apply/verification;
- explicit unsupported/unknown model fails before prompt;
- adapter contract coverage verifies workflow workers reject unsupported cwd/model/read-only requirements rather than silently degrading;
- MCP configuration is not treated as supported when a bridge discards it;
- normalized usage and stop behavior are covered by adapter contracts and the existing harness regression suite.

### Runtime/security tests

- enable-time permission probing plus runtime attempts to access process, bridge globals, imports, string/Wasm generation, clocks, randomness, oversized RPC, detached continuations, and unresponsive loops;
- global/per-run/per-harness concurrency, FIFO fairness, bounded queues, pause, and abort while waiting;
- generation races during stop/restart;
- schema correction bounds and result bounds;
- nested shared budget and agent limits;
- worktree failure-closed behavior, dirty retention, and path-safe cleanup.

### Persistence/delivery tests

- checksums, serialized ordering, truncated tail, version mismatch, bounded history scans, and full-script recovery from persisted source;
- rejection of result caching and recovery-specific approval;
- exact-session busy/idle/unloaded/replaced completion races;
- durable delivery states plus live queue/transcript deduplication;
- broker token generation binding, revocation, permissions, disconnects, and malformed frames.

### MCP and TUI tests

- MCP initialize/list/call/ping/close plus broker disconnect cancellation, shutdown, bad-token, and malformed-frame behavior;
- approval contents and exact source-hash invalidation;
- task summary and all hierarchy/detail levels;
- hierarchy controls and narrow-terminal clipping, with the existing cc TUI regression suite covering shared composer, dialog, and `/btw` page behavior;
- active/completed/interrupted/recoverable and delivery states.

### End-to-end dummy projects

- create disposable Git projects with four and six independent modules so real
  worktree creation, worker processes, and completion delivery are exercised;
- have the fake orchestrator model generate and invoke the workflow through the
  injected MCP server, rather than calling the manager directly;
- prove Clone Only preserves the parent harness/model/effort and its requested
  concurrency cap, including pause/resume behavior;
- prove Flexible routes one run across configured Cursor/Codex-compatible
  adapters with distinct model/effort pairs and six overlapping workers;
- drive approval, footer state, every `/workflows` hierarchy/detail/source
  level, restart history, save dialog, narrow resize, live Clone Only ↔ Flexible
  policy reconnects, disable/reconnect, and clean shutdown through an actual
  tmux TUI session;
- retain a disabled baseline session that verifies the ordinary CLI has no
  workflow footer or workflow-specific launch wiring.

### Release gates

1. Adapter feasibility suite passes before runtime integration proceeds.
   Public workflow syntax, saved formats, and model-facing launch tools do not merge until this stop/go gate passes.
2. Workflow unit/integration/TUI tests pass.
3. Existing adapter-boundary and full `npm test` regression suites pass.
4. `npm pack --dry-run`, package-content tests, and a clean-prefix install of the generated tarball prove all workflow modules and notices ship and resolve outside the repository; channel promotion independently requires a checked-in workflow/runtime/license manifest, recursively syntax-checks every shipped JavaScript module, checks its documented `python3` prerequisite, and AST-parses every shipped Python source on supported POSIX channels so Disabled-mode lazy imports cannot hide an incomplete release.
5. The disposable four/six-way tmux E2E and the shared TUI smoke both pass,
   covering real worker execution as well as active, completed, restarted, and
   interrupted projections. Release automation invokes
   `npm run test:release`, whose mandatory workflow E2E fails rather than skips
   when the macOS `sandbox-exec` execution platform is unavailable and which
   also runs the complete regression/TUI/channel/package gates.
6. A live external-harness smoke is a release validation step after zero-token tests pass. `npm run test:workflows:e2e:live` is the explicit authenticated GPT-5.6/Codex entry point; it is intentionally not part of `prepublishOnly` or CI because it depends on a signed-in third-party CLI and incurs model usage.

## Implementation order

1. Land adapter contract/capability changes and the vertical feasibility tests for cwd, models, launch, permissions, completion queue, and process teardown.
2. Port the pure runtime with attribution, then replace unsafe reference pieces with the isolated process, global scheduler, and safe journal rules.
3. Add the adapter executor, manager, permission registry, worktrees, and exact/estimated usage accounting.
4. Add the broker plus MCP launch surface, approval/source hashing, and origin binding.
5. Add durable completion delivery and recovery.
6. Add task summary, unified page stack, hierarchy/detail TUI, and controls.
7. Add saved workflows, settings, disable controls, packaging, notices, and documentation.
8. Run every release gate and fix regressions before considering the feature complete.

## Acceptance criteria

- The active model can launch a workflow through every launch surface its adapter truthfully advertises; humans can launch one from every active harness.
- Every bundled adapter enters workflow execution only through its truthful live
  capability contract; explicit supported models are applied and verified before
  the first prompt, while unavailable executables/options fail closed. The
  authenticated external release smoke covers the installed GPT-5.6/Codex pair;
  other external harnesses require their own smoke before stronger runtime claims.
- Omitted routing on the origin harness inherits the observed parent tuple. A different harness may use its configured default only when the fresh worker session verifies that model; otherwise it fails before prompting.
- A workflow can mix configured harness/model pairs without directly invoking native model CLIs from workflow code.
- The parent conversation remains responsive, and permission/elicitation prompts remain interactive and correctly labeled.
- `/workflows` provides live hierarchical inspection and the documented controls without conflicting with `/btw` or dialogs.
- Recovery is explicit and reruns the exact persisted script without silently replaying any completed model result.
- Completion targets only the exact session on its original live adapter generation (which survives a sanctioned policy reload) or remains visibly persisted; there is no cross-generation rebinding or automatic ambiguous resend.
- Explicit isolation never falls back to the shared checkout, and unmerged worktree changes are not silently deleted.
- Budgets and usage are labeled exact/estimated/unknown, and admission limits are enforced as described.
- Shutdown confirms each workflow adapter's owned process group and every observed descendant are gone; the sandbox cannot create children. A trusted configured executable that deliberately daemonizes between process-table samples remains outside this lifecycle contract, as documented above.
- Packaging gates, workflow tests, TUI smoke, and the existing cc suite all pass.
