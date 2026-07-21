# Dynamic Workflows WIP Handoff

Snapshot branch: `workflows-wip-2026-07-19`

This branch is a locally converged release candidate of the dynamic workflows
implementation. Iteration 84 returned clean across all three review roles, and
the exact-toolchain complete regression plus supplied-tarball install gates pass.
Final macOS validation and channel promotion are performed locally; this branch
does not add or require hosted CI workflows.

## Upstream integration

`origin/main` through `2927076` has been merged into this branch. That upstream
range adds self-healing main and `/btw` prompt queues, startup input capture,
terminal scrollback/state preservation, and rollback support for Codex,
OpenCode, Pi, and Claude. The queue changes were combined with workflow
delivery journaling so internal completions retain their durable
queued/sending/delivered/ambiguous states, while ordinary queued input uses the
new reconnect and watchdog behavior. The rollback service wiring is also
passed into workflow-created adapters, and conversation-changing rewinds rotate
workflow origin authority while code-only rewinds retain it.

Upstream now requires Node 22.19 or newer. The workflow plan and package
metadata follow that baseline; the earlier WIP promise that Disabled mode would
continue to support Node 22.0–22.18 no longer applies.

## User-visible scope implemented

- Workflows default to `Disabled`. The dormant path dynamically imports no
  workflow runtime, broker, manager, registry, history, MCP, or TUI modules.
- `/workflow-mode` selects `Disabled`, `Enabled — Clone Only`, or
  `Enabled — Flexible` and persists the choice.
- Clone Only binds every worker to the parent harness, verified model, and
  verified reasoning effort. Flexible allows configured and adapter-verified
  model/harness/effort combinations.
- Enabled sessions show workflow state in the footer. Disabled sessions retain
  the prior footer and `/status` behavior.
- Models on MCP-capable harnesses can author JavaScript workflows and launch
  them through the `Workflow` tool. Humans can launch saved workflows and open
  the workflow TUI independently of model MCP support.
- The TUI includes run/phase/agent/attempt hierarchy, source inspection,
  pause/resume, stop, agent restart, interrupted-run recovery, workflow save,
  and retained-worktree preview/apply flows.
- Runtime globals include `agent`, `parallel`, `pipeline`, `workflow`, `phase`,
  `log`, `args`, and token-budget helpers.

## Major implementation present

- `src/workflows/` contains the sandboxed JavaScript runtime, scheduler,
  manager, journal/recovery code, registry, authenticated broker and MCP
  helper, adapter executor, ownership locks, worktree management, process
  supervisor, schemas, types, and TUI projection.
- Harness interfaces and bundled adapters expose workflow cwd, model,
  reasoning-effort, read-only, usage, launch, and lifecycle capabilities.
- Workflow source execution is currently enabled only on macOS after fail-closed
  Seatbelt and Node permission-model probes. Persisted opt-in resolves to
  Disabled on unsupported platforms.
- Shared-checkout mutation and Git metadata operations use both path-stable and
  device/inode cross-process ownership locks. Worktree mutations remain
  explicit and are never merged automatically.
- Worker and Git subprocesses launch through process-tree supervisors. The
  manager owns a stdin lifetime pipe so manager death triggers bounded
  TERM/KILL/observed-descendant confirmation under the documented trusted-local-executable threat model.
- Model-authored launch uses an acknowledged broker handshake. Execution is
  held until a durable commit boundary, and post-commit response loss is
  reconciled by origin-bound task status rather than retrying the workflow.
- Journals, recovery capsules, history indexes, approvals, registry entries,
  and worktree markers use bounded reads and durable atomic replacement.
- npm packaging includes workflow modules, MIT and Apache-2.0 license files,
  NOTICE/provenance pins, the MCP SDK, Ajv, and Zod.

## Most recent hardening changes

Iterations 22 through 49 closed release, product, lifecycle, and security edge
cases found by the three independent review tracks. The latest fixes include:

1. An accepted stop writes a durable `run_stop_requested` record before its
   promise resolves; replay gives that intent precedence over a concurrently
   persisted completion.
2. Once a committed MCP launch enters reconciliation, later cancellation
   cannot downgrade it into the ordinary rollbackable cancellation path.
3. Manager-only crash coverage freezes the exact installed-artifact manager
   and converges on its descendant tree before the crash, then continues
   following descendants during owner-pipe teardown.
4. The workflow TUI keeps identity-bound selections visible even when only one
   summary line fits in the viewport.
5. The foreground launcher and detached terminal-restoration helper restore
   input/signal state after ordinary exit, signals, and wrapper `SIGKILL`.
6. Completion delivery escapes untrusted structured fields, `/btw` startup is
   lifecycle-cancellable, and journal close failures remain retryable.
7. Project helper and worker termination failures retain a sticky restart fence
   until descendant death is confirmed; corrupt launch markers are isolated to
   their run without hiding healthy history.
8. npm dependencies are exactly pinned and the shipped shrinkwrap requires
   `sha512` integrity for registry artifacts. Release automation packs once and
   reuses that immutable candidate through every gate.
9. Local release validation retains fixed booleans and counts rather than raw
   secret-bearing model output, and every gate consumes the same immutable
   candidate produced from the reviewed checkout.
10. Commit rollback is single-flight, a sticky restart fence revokes every
    already-admitted launch, and a marker published during fencing remains
    durable while its source is aborted before execution.
11. The direct npm bin captures its own exact termios state and has both source
    and installed-tarball `SIGKILL` restoration coverage.
12. The package is explicitly private because the unscoped public npm name is
    unrelated. Promotion uses immutable git-backed local channels and follows
    the reviewed full commit SHA.
13. The installed-bin `SIGKILL` gate proves raw mode differs from the baseline
    before killing the manager, so a no-op restoration cannot pass.
14. The authenticated driver unexports the model credential for pack, install,
    postinstall, Git, and evidence subprocesses, exposing it only to the tmux
    server that launches the installed CLI.
15. The local release command emits validated commit/digest/package provenance
    only after the portable, macOS, and authenticated gates pass.
16. `/btw` close, backend-exit recovery, detached queue drains, and mutation
    recovery partition internal completion deliveries from human input. Only
    human prompts/commands can return to the main composer; completions retire
    durably against their original session.
17. A `/btw` backend whose process tree cannot be confirmed stopped remains in
    a strong failed-retirement set. Final cc shutdown force-stops and retries
    that exact client and exits nonzero if confirmation still fails.
18. Deterministic, standalone package/E2E, and git-channel dependency installs
    scrub model and registry credentials and ignore ambient npm user config.
    The authenticated key crosses a one-use owner-only file into the installed
    CLI after tmux starts credential-free.
19. Missing-native guidance refers only to the exact original tarball or local
    channel install; it never recommends the unrelated public npm package.
20. A failed durable `ambiguous` delivery write is retained and retried rather
    than discarded. `ambiguous` supersedes a racing generic retirement, and a
    crash after the durable `sending` boundary recovers as ambiguous.
21. Both the direct Claude SDK/native pair and the separately pinned nested
    Claude ACP SDK/native pair are identity-, version-, and executable-checked
    by postinstall and immutable channel verification.
22. The authenticated key is exported only by the private installed-CLI shell
    immediately before direct `exec`; it is never placed in a child argv.
23. Worktree apply preview is modal, direct SDK validation is bound to cc's
    root dependency pins, and Windows installed-artifact verification fails
    hard on missing native payloads.
24. Shutdown retries and removes a rolled-back launch whose first durable
    cleanup failed, instead of waiting forever for a run that never executed.
25. Dependency installation scrubs secret-shaped and provider credentials, and
    channel verification follows npm's actual nested Claude ACP native layout.
26. Legacy pre-workflow channel snapshots remain installable without the new
    shrinkwrap manifest, while workflow-era releases require it; Tab cannot
    escape a modal worktree apply preview.
27. Retained commit-ambiguous launches remain a shutdown error, and channel
    syntax/help verification runs with the same credential-free environment as
    dependency installation.
28. Oversized patches cannot be applied from a truncated TUI preview, hidden
    inspection views have no destructive stop shortcut, and modal help matches
    its captured focus behavior.
29. Registry/proxy URL userinfo is scrubbed from install and verification
    subprocesses, and shutdown completes all release/archive/termination checks
    before aggregating ownership-release failures.
30. Async worktree previews are bound to the originating page, restore modal
    focus, and enforce the truncation prohibition again at the host boundary.
31. Credential scrubbing conservatively excludes URL userinfo, query strings,
    fragments, and malformed userinfo from every install gate. Pre-workflow
    channel snapshots retain their historical two-adapter/native verification
    contract, and shutdown retries archive/release convergence to a clean pass.
32. Async previews are discarded when their run/agent/attempt selection moves,
    and failed native-command retirements receive a fresh final process-tree
    confirmation. Channel reuse is checked against a full installed-content manifest,
    legacy installs use only their committed lockfile/adapters, every installer
    child gets a credential-free environment, and all external shrinkwrap
    entries require SHA-512 integrity.
33. Windows terminal release fails hard unless whole-tree signalling was
    confirmed, CR/LF URL values cannot bypass credential scrubbing, final
    delivery retirement is followed by another archive/lease convergence pass,
    and release reuse compares only content plus executable semantics. Preview
    selection generations prevent move-away-and-back races, inspection views
    expose no hidden mutations, and the Windows artifact gate scrubs its full
    lifecycle environment while preserving native optional dependencies.
34. Shutdown awaits every active delivery submission even when a sibling fence
    fails, POSIX gates reject raw CR/LF environment values, and npm user plus
    global configuration are nulled across release installs. Commit-named
    releases carry a complete installed-content digest so reuse detects drift
    without depending on the current npm layout. Tiny preview and picker
    viewports cannot confirm actions until both target context and change
    disclosure are visible.
35. The final manager pass rejects every retained unarchived run while the
    pre-delivery pass explicitly permits queued completions. Rollback validates
    the installed content manifest; manifest-less legacy installs must be
    rematerialized from their exact Git commit before they can become a rollback
    target. Mixed-case npm config aliases and arbitrary multiline values are
    scrubbed, and separate owner-only empty npmrc files avoid npm's double-load
    failure.
    Picker and preview confirmation also fail closed before first render and at
    widths too narrow to disclose the target.
36. Delivery-submission retirement is internally all-settled, Windows and
    candidate-pack steps reject arbitrary multiline environment values, and
    candidate packing uses distinct private npmrc files. Rollback now requires
    an explicit versioned full-content manifest, so deleting a modern digest
    cannot downgrade modified dependencies into legacy verification.
37. Every outer delivery/shutdown fence is all-settled, verification augments
    only its already-scrubbed executable path, and shell release gates match
    credential names without regard to casing. Installed content manifests now
    carry their own required schema version. The mode picker discloses active
    workflow termination, recovery completion cannot steal a selection after
    navigation, and apply confirmations wrap exact branch, commit, and file
    identities and fail closed until their final confirmation fits in full.
38. Final shutdown attempts both manager convergence passes, durable delivery
    retirement, and broker revocation even after an earlier failure. Rollback
    link swaps carry a recoverable transaction record, and legacy releases are
    upgraded only after their complete installed tree matches a freshly
    reconstructed exact Git and shrinkwrap closure. Python verification cannot
    resolve a release-local shim, and every external shrinkwrap entry requires
    approved registry provenance plus SHA-512 integrity. Apply preview unlocks
    only after every wrapped target and changed-file identity row was displayed;
    recovery level navigation is generation-fenced, changed disable counts
    require renewed confirmation, and blocked confirmations explain why Enter
    is disabled.
39. Lock provenance validation is shared by release and channel installs,
    release content manifests cover file and directory permissions, Python is
    resolved to an external absolute executable, stale crash locks are reclaimed
    only for a pending rollback transaction, and both transaction targets are
    fully validated before link mutation. PAT credentials are scrubbed, partial
    workflow startup is converged before references are cleared, and shutdown
    aggregates every concurrent failure. Non-page pickers receive the real
    terminal height, apply disclosure distinguishes scrolling from resizing,
    and an unobservably fast unowned supervisor root fails closed.
40. Failed workflow startup retains exact manager and broker handles until every
    cleanup succeeds, aggregates concurrent cleanup failures, and final shutdown
    joins any in-flight subsystem startup before snapshotting resources. Rollback
    prevalidates both modern or legacy targets with repository context, recovery
    detects PID reuse, and immutable manifests include the release-root mode.
    Release verification and runtime project I/O share one external absolute
    Python resolver. Direct disable arguments require active-run confirmation;
    destructive pickers need only disclose the complete title, selected action,
    and controls; oversized previews report their permanent apply prohibition
    first; recovery approvals show the full run identity; and scroll help names
    both arrow and j/k controls.
41. Workflow and recovery approvals require their complete warning title,
    selected action, and controls before Enter is enabled, while all workflow
    modes remain selectable at 80 columns. Missing Python no longer disables
    inline or personal workflows. Linux lock owners use parsed `/proc` start
    ticks and new macOS owners add a random process-visible instance marker to
    distinguish same-second PID reuse. Windows release jobs scrub PAT-style
    credentials, and legacy verification accepts safe restrictive install-root
    modes while continuing to reject group/world-writable roots.
42. Project Python discovery excludes every user-controlled ancestor of the
    startup directory, worker descendants use exact Linux boot/start identities
    plus a macOS launch discriminator, and Windows installer recovery records
    process creation time. Full-disclosure pickers show all alternatives when
    space permits and otherwise wrap the selected action and every control;
    overwrite, preview-width, and pause/resume disclosures are consistent.
    Channel promotion is transactionally replayable and directory-synced,
    PAT scrubbing preserves PATH, required optional native packages are forced
    into artifact installs, and reclaim-gate cleanup vacates its public name
    atomically before recursive removal.
43. Stale reclaim gates are likewise atomically retired and identity-checked,
    macOS descendant tracking rejects missing launch discriminators, and Python
    exclusion stops at the first root-owned non-writable boundary so system
    interpreters remain usable. Width-blocked pickers advertise disabled Enter,
    saved-workflow overwrite names the exact normalized `.js` file, and every
    workflow fallback state obeys the terminal width contract.
44. Channel launch/GC guards record and compare the same reuse-safe process
    identities as the installer lock. A failed macOS descendant identity is now
    sticky: the supervisor immediately fences the workflow, never signals an
    unidentified PID, and can never later report a confirmed shutdown.
    Run-error, missing-run, and missing changed-file rows also preserve the
    narrow-terminal width contract.
45. Full-disclosure pickers invalidate confirmation eligibility on every
    selection or query change, every workflow heading clips to the terminal,
    and a successful apply surfaces retained-worktree cleanup warnings. Channel
    release leases now carry stable, reuse-safe process identities. Worker
    signals revalidate descendant lifetimes immediately before use, recover
    fast-exit same-group helpers only through the random supervisor token, and
    permanently latch a process group once no identity-verified member remains.
46. Filter clearing also invalidates full-disclosure eligibility, changed-file
    summaries carry an independent truncation flag that disables interactive
    apply, and workflow-page notices remain visible in an inline banner. Live
    installer locks are preserved when their current identity cannot be read.
    Ordinary managed-terminal groups carry an inherited random token and are
    never signalled after that identity disappears; macOS channel runners
    re-exec once so their stable lease token exists from process start.
47. Ordinary POSIX managed terminals now launch under trusted lifecycle
    supervision, so same-group descendants remain terminable even after
    scrubbing their environment. Resize start invalidates destructive full-
    disclosure pickers, successful workflow saves surface an inline page
    notice, and a three-row viewport never overflows. macOS channel runner
    tokens are bound to the current PID, and release-content ordering is locale-
    independent.
48. The terminal supervisor receives the requested child environment through a
    private pipe, so harness-controlled Node loader options cannot alter the
    trusted wrapper. macOS runner leases use their already-established PID-bound
    token and fail safe on remote token-probe errors. Protected validation checks
    complete successful live evidence, supplied local candidates are content-
    bound to the checkout, and legacy reconstruction tolerates safe restrictive
    npm umasks while preserving owner executable semantics. Final worktree apply
    confirmation includes every exact changed-file identity.
49. Lifecycle observation uses an external process-table probe, so backends
    cannot hide by adopting the probe's process name. Resize start also
    invalidates active apply-preview disclosure. Supplied release candidates are
    replaced with the private checkout-produced byte-identical snapshot before
    any gate runs, and authenticated evidence requires exactly the two requested
    worker outputs with no combined-substring shortcut.
50. Ordinary POSIX terminals now share the identity-aware descendant supervisor
    used by workflow children. It retains kernel process-group ownership for
    environment-scrubbed members, discovers inherited-token peers that detach
    before their root exits, and refuses unconfirmed cleanup. Authenticated live
    evidence correlates each completion ID with its queued worker label before
    accepting that worker's exact output.
51. A recycled numeric PGID can no longer regain signalling authority from an
    untracked group member after any recorded identity mismatch. Repository
    mutation locks publish a durable, token-bound poison fence when descendant
    shutdown cannot be confirmed, so a restarted process cannot reclaim them
    while an escaped mutator may survive. Live evidence now binds the two exact
    readiness IDs, prompts, labels, models, efforts, and outputs end to end.
52. Repository mutation locks durably arm their token-bound owner-death fence
    before any mutator can launch, so `SIGKILL` cannot bypass fencing by
    preventing the executor from observing supervisor failure. A token-proven
    macOS process retains its original kernel process-group lease across an
    environment-scrubbing `exec`, while detached unproven processes still fail
    closed. Workflow pages now honor even zero-, one-, and two-row terminal
    heights without emitting an oversized frame.
53. Git supervisors now return a dedicated, bounded status attestation only
    after the separately-grouped backend tree is confirmed gone; killing the
    supervisor before that boundary retains the mutation fence instead of
    masquerading as an ordinary timeout or cancellation. macOS tokenless root
    continuity is bound to its token-proven start instant and ends when the
    direct child is reaped, preventing PID/PGID reuse from regaining signalling
    authority. Exact approval-source rendering clips its chrome to real zero-,
    one-, and two-row terminal heights.
54. A streaming workflow backend root that disappears before owner-driven
    shutdown now fails containment instead of attesting a clean tree, covering
    helpers that detach and scrub the launch token before the first process-table
    sample. Workflow modals own the complete tiny viewport, so one- and two-row
    terminals visibly show that Enter is disabled instead of hiding the picker
    behind status chrome. Local release runs retain their immutable tarball,
    digest, package/commit provenance, deterministic result, authenticated live
    result, and validation record in one external evidence directory.
55. Owner EOF or signal handling now synchronously proves the streaming root is
    still the same live non-zombie child, so a queued child-exit callback cannot
    relabel a pre-dead backend as clean owner-driven shutdown. One-row workflow
    modals reserve their sole line for the disabled-confirmation warning, the
    macOS exact-source interrupt fixture carries its real editor dependency, and
    Enter/Right no longer reset scroll in non-navigable inspection views.
56. Owner-driven shutdown attestation now requires the backend root to remain a
    direct child, and a failed durable mutation-fence arm rolls back its
    published lock. Tiny pickers use an atomic width-fitting disabled label,
    while Ctrl-C visibly returns exact-source inspection to its approval.
    Local authenticated releases validate every retained evidence field before
    publication, atomically retain failed-gate results, and candidate checksum
    files name the portable tarball basename.
57. Mutation-lock release remains retryable through persistent-fence deletion
    and directory sync, while the macOS manager-only crash fixture recognizes
    the manager's validated ownership marker. Tiny exact-source views reserve a
    visible return affordance, workflow-page Ctrl-C feedback stays on the page,
    and source/apply round trips preserve detail scroll. Candidate-preparation
    failures now retain atomic structured results even when the authenticated
    gate cannot run.
58. Sticky subsystem restart fences now abort running as well as prepared
    workflows, stop their sandboxes, and cancel scheduler admission. The macOS
    manager-crash fixture binds follow-up signals to process start identities.
    Coalesced workflow/source navigation stays with the visible view, and an
    empty dashboard keeps Ctrl-C feedback visible. Dirty checkout and invalid
    shrinkwrap failures retain structured release evidence. Local artifact
    gates explicitly materialize OpenCode after ignore-scripts installs, while
    the authenticated gate exposes its key only to the installed CLI.
59. The local release gate keeps model credentials out of packing, dependency
    installation, Git, and retained evidence. Blocked Ctrl-D explanations stay inside
    focused workflow/source views and describe the bounded force-exit gesture;
    one- through three-row dashboards prioritize Ctrl-C feedback over chrome.
60. Blocked exits now remain visible above workflow modals, preserve an atomic
    repeat-within-two-seconds instruction in narrow source/dashboard views, and
    tiny terminals cannot focus a hidden composer. Portable coverage runs
    before the macOS-only test boundary. Immutable channel installs resolve
    root-owned Git/tar tools and invoke npm beside the active Node runtime;
    dangling Windows junctions are replaceable. The local release command
    rejects any failed validation prerequisite.
61. Windows trusted-tool lookup now applies `PATHEXT` and admits candidates only
    beneath protected system/program installation roots. Terminal shrink events
    restore dashboard focus before a composer disappears, and model-launch
    approval pickers surface the same bounded blocked-exit gesture without an
    underlying workflow page. Supervisor root identity now requires direct-child
    continuity before authorizing a process group, and the Linux exit-race
    regression accepts both kernel disappearance error codes.
62. Windows channel-tool roots now derive from the loader-resolved operating-
    system DLL path rather than caller-controlled environment variables.
    Durable stop intent is monotonic during crash replay even if a completion
    record follows it. Workflow pickers project their live filter inside the
    modal, one-row dashboards use an atomic exit hint, coalesced Ctrl-D bytes
    are dispatched in order, and shrink-under-modal restores dashboard focus.
63. Windows channel tools are limited to exact System32/Git roots and every
    candidate/ancestor ACL must deny unprivileged replacement; installer and
    generated-runner identity probes also use loader-derived PowerShell and
    absolute POSIX `ps`. Coalesced ANSI navigation is tokenized atomically and
    revalidates its interaction owner. Local releases pin Node 22.19.0, while
    authenticated npm lifecycle scripts run in an explicit empty, allowlisted
    environment before the model key is transferred to the CLI.
64. Immutable channel resolution and archives disable Git replacement refs.
    Local release candidates enforce and record exact Node
    22.19.0/npm 10.9.3 toolchain provenance. Zero-row approvals cannot become
    selectable and one-/two-row normal-layout approvals own their visible
    viewport. Windows channel promotion and runner coordination now fail closed
    rather than using PowerShell to authenticate its own ACL or module-loaded
    CIM output as a PID-reuse boundary.
65. Every local provenance Git command now uses a trusted absolute executable
    with replacement objects disabled. Local packaging, deterministic, and
    authenticated consumers use npm beside exact Node and bind its CLI digest
    into candidate and validation evidence; channel materialization enforces
    its Node/npm floor and records the same toolchain identity. Lockfile root
    metadata matches package dependencies. Tiny ordinary pickers disclose the
    selected action before enabling Enter and always render disabled feedback.
66. Selection, filtering, clearing, and resize now invalidate confirmation for
    every picker until the current target is rendered; permission y/n shortcuts
    use that same guard and cannot choose a filtered option. Release gates pass
    an absolute Node/npm pair through installed-artifact tests, document the
    exact npm contract, and bind package name/version to hashed npm pack
    metadata that every candidate consumer independently verifies.
67. Permission prompts require complete wrapped title/action disclosure and
    compact workflow summaries expose textual status. Installer stale-lock
    reclamation uses atomic rename ownership with exclusive token/inode release.
    Validated promotion consumes the candidate tarball and records its digest
    instead of rebuilding source from Git; macOS gates require a usable local
    tmux installation.
68. Iteration 79 made validated promotion independently anchor the reviewed
    commit and deterministically reproduce its npm tarball before accepting the
    recorded digest. The verified tarball is pinned through a no-follow
    descriptor into private staging, archive links/special entries are rejected,
    completed release trees and their parent are fsynced, and replay state
    precedes first launcher publication. Complete dead installer owners are
    atomically reclaimable even before a first-install transaction exists.
    Workflow-worker prompt chrome visibly escapes terminal/bidi controls,
    maximum-size phase metadata remains launchable, and recovery opened from
    `/btw` retains that exact session and lifecycle signal.
69. Iteration 80 removes every inherited `GIT_*` provenance override and binds
    Git explicitly to the reviewed checkout. Both candidate creation and
    source reproduction pin the byte digest of npm 10.9.3 shipped with official
    Node 22.19.0 archives. Candidate tar parsing now bounds compressed and
    expanded bytes, entry count, per-entry size, and path length before using
    the immutable snapshot. Installer ownership is constructed and fsynced in
    a private claim directory before atomic publication, so a killed creator
    cannot strand an ownerless canonical lock. Terminal smoke tests navigate,
    wait for the newly selected row to render, and only then confirm.
70. Iteration 81 binds release provenance to a deterministic digest of the
    complete official npm 10.9.3 installation rather than its small CLI loader.
    Candidate verification bounds and descriptor-pins the tarball and every
    sidecar before reading them. Channel and workflow Git operations use a
    trusted absolute executable, scrub credentials and inherited `GIT_*`
    overrides, and bind repository operations with an explicit `-C`. The
    destructive workflow-mode smoke waits for the disclosed active-run count
    and selected `Stop and disable` row before confirming.
71. Iteration 82 authenticates the complete npm installation before any npm
    code executes and rechecks it around version, pack, and install operations.
    Local validation now binds the exact validation toolchain; workflow
    artifacts verify against their shipped shrinkwrap without requiring npm's
    excluded package lock; and the cross-platform matrix invokes npm through
    Bash on Windows. Disabled ordinary terminals retain their direct pre-
    workflow spawn path, while Git failure/cancellation fixtures inject exact
    test executables without weakening the trusted production resolver.
72. Iteration 83 made the local release entrypoint authenticate the complete
    Node 22.19.0/npm 10.9.3 installation before any release npm command runs.
    Git pre-spawn failures now cross the supervisor's
    structured status channel, so an absolute executable that disappears is
    reported as `ENOENT` without falsely fencing a repository mutation lock.

## Review status

- Iterations 1 through 81, 83, and 84 completed all three review passes.
  Iteration 82 returned release and product findings, while its security pass
  exited before a verdict. In total, 251 review passes returned verdicts.
- Each iteration used three independent Codex CLI reviewers in parallel with
  GPT-5.6 and high reasoning effort: security/lifecycle, product/TUI, and
  release/package review.
- Iterations 52 through 83 produced valid findings. Their fixes are included
  here. Iteration 84 returned clean in all three roles on staged fingerprint
  `063985bf4f80828b5f8b98584c90e84efc91fad7eb6e13d1a3a6c340bf6a39e3`.

## Test status at this checkpoint

Using the checksum-pinned official Node 22.19.0/npm 10.9.3 runtime, the complete
`npm test` regression passes, including the portable workflow suite, settings,
rollback E2Es, adapters, permissions, channel installer, postinstall, and shared
TUI smoke. JavaScript/Python/shell syntax, shrinkwrap integrity,
and `git diff --check` pass. A single retained 91-file candidate was packed at
SHA-256 `c39f134d509d342347957656b8912006f1263ceb5e72291f88614b24aa05fb72`;
its clean-prefix supplied-tarball installation smoke passes from an empty cwd.
The portable Linux workflow and package checks passed. Windows is not fully
supported and is outside this signoff.

Earlier development runs exercised the installed-artifact deterministic and
authenticated macOS paths, but final evidence must always be regenerated for
the exact commit being promoted.

## Local release procedure

Complete these after committing/publishing the reviewed tree:

1. With the exact Node 22.19.0/npm 10.9.3 toolchain, set an empty absolute
   `CC_WORKFLOW_RELEASE_DIR` and run `npm run release:workflows` on macOS. It
   runs the complete deterministic suite and the authenticated GPT-5.6-Sol High
   installed-artifact E2E against one retained candidate.
2. Retain `dynamic-workflows-validated.json`, the result JSON, candidate
   provenance, checksum, pack metadata, and tarball as local release evidence.
3. Install the intended local channel from that exact retained validated
   candidate with `--candidate-dir --expected-commit <reviewed-full-sha>` and
   verify the installed `cc` shim. Do not
   target the unrelated public npm `cc` package. Any later source fix
   invalidates the candidate and restarts review and release gates.

## Known areas needing special scrutiny

- `WorkflowManager.commitStart()` is now asynchronous because it must durably
  write the launch marker before releasing execution. Stop, shutdown, broker
  revocation, response failure, and manager crash around that await boundary
  need adversarial coverage.
- Startup recovery requires the commit marker only for new journals carrying
  `launchCommitRequired: true`, preserving compatibility with earlier synthetic
  and legacy journal fixtures. Verify that corrupt or missing new-format
  markers fail closed without hiding retained worktrees.
- `AdapterWorkflowExecutor.retainedMutationFences` intentionally has no
  production release path. Tests directly release synthetic retained closures
  only to avoid poisoning later cases in the same test process. Manager
  shutdown should report the termination failure while the real lock and its
  pre-armed owner-death marker remain published. Killing the owner does not
  clear that marker; a later process must require explicit manual recovery.
- The authenticated test incurs real model usage and requires macOS, tmux,
  and Codex authentication/API credentials.

## Reference plan and provenance

The full architecture, security boundaries, imported-versus-cc-specific design,
and test plan are in `docs/dynamic-workflows-plan.md`. Upstream provenance and
license pins are in `NOTICE`.
