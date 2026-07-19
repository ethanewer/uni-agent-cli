# Dynamic Workflows WIP Handoff

Snapshot branch: `workflows-wip-2026-07-19`

This branch is an intentionally in-progress checkpoint of the dynamic
workflows implementation. It is not yet release-certified and should not be
promoted to a release channel until the remaining work below is complete.

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
  TERM/KILL/descendant confirmation.
- Model-authored launch uses an acknowledged broker handshake. Execution is
  held until a durable commit boundary, and post-commit response loss is
  reconciled by origin-bound task status rather than retrying the workflow.
- Journals, recovery capsules, history indexes, approvals, registry entries,
  and worktree markers use bounded reads and durable atomic replacement.
- npm packaging includes workflow modules, MIT and Apache-2.0 license files,
  NOTICE/provenance pins, the MCP SDK, Ajv, and Zod.

## Most recent hardening changes

The twenty-first three-review iteration found several valid edge cases. The
following fixes are present in this snapshot but have not yet completed the
next clean review/test iteration:

1. MCP helper sockets now close on every terminal success/error path so repeated
   broker errors cannot exhaust the 32-socket bound.
2. Ambiguous final-confirmation write errors enter committed-task
   reconciliation instead of immediately inviting a duplicate launch.
3. Reconciliation now requires the manager's execution-releasing committed
   state; an accepted but rollbackable run is insufficient.
4. A new durable `launch-committed.json` marker distinguishes committed runs
   from crash-persisted pre-commit allocations. New-format uncommitted runs are
   discarded during startup instead of becoming recoverable workflows.
5. Shared-cwd worker teardown failures and unconfirmed Git helper trees retain
   their cross-process repository mutation locks until process death. They are
   not voluntarily released while an unconfirmed backend may still write.
6. The package-install and deterministic TUI scripts accept
   `CC_WORKFLOW_E2E_TARBALL` and install that exact candidate artifact.
7. Candidate package verification enumerates every workflow source plus both
   licenses, NOTICE, and package metadata directly from the supplied tarball.
8. The authenticated live test can persist sanitized workflow events, model and
   effort evidence, outputs, run completion, and delivery state outside its
   temporary directory.
9. The protected authenticated workflow now triggers on pushes to `workflows`
   as well as manual dispatch, uses a protected environment, and retains the
   tarball, digest, pack metadata, logs, and live result together.

## Review status

- Twenty-one review iterations have run.
- Each iteration used three independent Codex CLI reviewers in parallel with
  GPT-5.6 and high reasoning effort: security/lifecycle, product/TUI, and
  release/package review.
- That is 63 completed review passes.
- Iteration 21 produced valid findings. Their fixes are included here.
- Iteration 22 has not run. It must target the fixes above and return clean, or
  any valid findings must be fixed followed by another three-review iteration.

## Test status at this checkpoint

Confirmed before the latest iteration-21 hardening:

- The focused dynamic workflow runtime, sandbox, scheduler, journal, registry,
  adapter-executor, broker, and MCP suite passed.
- The clean-prefix package smoke passed both its ordinary pack path and a
  supplied-tarball install path.
- Earlier development runs exercised deterministic four-agent Clone Only and
  six-agent Flexible TUI workflows and a real installed-artifact GPT-5.6 High
  workflow. Those results predate the latest handshake/recovery/fencing changes
  and are not final release evidence.

After the latest hardening and the `origin/main` merge:

- JavaScript/Python syntax checks and `git diff --check` passed.
- `dynamic_workflows.test.mjs` completed successfully. The run exposed three
  synthetic termination-failure fixtures that correctly retained production
  repository fences but failed to release their test-only closures before
  later cases reused the same repository. Those fixtures now perform the same
  explicit test cleanup as the adjacent retained-fence cases; production has
  no voluntary release path.
- Upstream queue reliability, rollback-harness, real Codex/OpenCode/Pi
  rollback, checkpoint, settings, adapter, command-catalog, harness-feature,
  postinstall, channel-installer, and TUI smoke tests passed against the merged
  tree.
- The supplied-tarball package smoke has not been rerun since adding the commit
  marker, complete tarball enumeration, live evidence output, and upstream
  rollback dependencies.

Therefore this branch has no claim of a fully green current test run.

## Remaining work required

Complete these in order:

1. Pack one candidate artifact and run
   `CC_WORKFLOW_E2E_TARBALL=/absolute/path/cc-0.1.0.tgz bash tests/package_install_smoke.sh`.
2. Run review iteration 22 with three parallel GPT-5.6 High Codex CLI reviews.
   The security review must target commit-marker crash races, asynchronous
   commit/rollback/stop interleavings, ambiguous final-ACK errors, and retained
   mutation fences. The release review must inspect exact-artifact enumeration,
   branch-trigger availability, and retained live evidence. The product review
   must recheck Disabled dormancy, mode enforcement, footer behavior, and TUI
   controls. Repeat review iterations until clean or until reviewers stop
   producing valid findings.
3. After a clean review, run the deterministic installed-artifact gate:
   `CC_WORKFLOW_E2E_TARBALL=/absolute/path/cc-0.1.0.tgz CC_WORKFLOW_E2E_REQUIRED=1 bash tests/dynamic_workflows_e2e.sh`.
   It must pass the Disabled baseline, exact four-worker Clone Only route,
   exact six-worker Flexible route, real overlap, TUI navigation/actions,
   completion delivery, mode transitions, worktree behavior, and manager-only
   crash cleanup.
4. Run the complete release suite with `npm run test:release`. All ordinary
   pre-existing tests must remain green.
5. Run `npm run test:workflows:e2e:live` with real GPT-5.6 High against the same
   retained tarball. Confirm two workers become ready before either completes,
   exact model/effort routing, expected outputs, TUI projection, and delivery to
   the originating orchestrator. Retain the result JSON and package digest.
6. Inspect `git diff --check`, package contents, process table, and worktree for
   leaks or accidental files.
7. Update `docs/dynamic-workflows-plan.md` from its current iteration-21 wording
   to the final clean review and test status.
8. Install the resulting build into the intended local channel and verify the
   installed `cc` shim. No workflow-enabled local build has been installed from
   this snapshot yet.
9. Commit any final fixes and publish the release-ready branch. Do not treat
    this WIP snapshot commit as the final release commit.

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
  shutdown should report the termination failure while the real lock remains
  published until process death.
- The protected push trigger names the `workflows` branch. If the final branch
  name changes, update the trigger or merge/bootstrap the workflow on the
  default branch before relying on manual dispatch.
- The authenticated test incurs real model usage and requires macOS, tmux,
  Codex authentication/API credentials, and the protected release environment.

## Reference plan and provenance

The full architecture, security boundaries, imported-versus-cc-specific design,
and test plan are in `docs/dynamic-workflows-plan.md`. Upstream provenance and
license pins are in `NOTICE`.
