import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { AdapterWorkflowExecutor } from "./adapter-executor.mjs";
import { discoverWorkflowHistoryCandidates, indexWorkflowHistoryCandidate, isExactRecoverySnapshot, readWorkflowHistoryIndex, readWorkflowJournal, readWorkflowJournalMeta, readWorkflowLaunchCommit, readWorkflowRecoveryFallback, replaceWorkflowHistoryIndex, WorkflowJournal, writeWorkflowLaunchCommit, writeWorkflowRecoveryFallback } from "./journal.mjs";
import { extractWorkflowMeta } from "./meta.mjs";
import { acquireOwnershipLock, acquireWorkflowRunLease, retryOwnershipLockReleases } from "./ownership-lock.mjs";
import { WorkflowSandbox } from "./sandbox-parent.mjs";
import { WorkflowScheduler } from "./scheduler.mjs";
import { normalizeAgentOptions, normalizeWorkflowLaunch, normalizeWorkflowMode, RUN_STATES, safeJson, WORKFLOW_LIMITS } from "./types.mjs";
import { WorkflowWorktrees } from "./worktrees.mjs";
import { readBoundedHandle, syncDirectory } from "./durability.mjs";
import { ensureWorkflowPrivateDirectory } from "./state-root.mjs";

function now() { return new Date().toISOString(); }

const WORKFLOW_APPROVAL_VERSION = 2;

async function atomicJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", 0o600);
	try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
	finally { await handle.close(); }
	await fs.rename(temporary, file);
	await syncDirectory(path.dirname(file));
}

function publicError(error) {
	return { name: error?.name ?? "Error", code: error?.code ?? "WORKFLOW_FAILED", message: error?.message ?? String(error) };
}

function isUnconfirmedGitTreeFailure(error) {
	return error?.code === "WORKFLOW_GIT_TREE_TERMINATION_FAILED" || error?.code === "WORKFLOW_GIT_TREE_TRACKING_FAILED";
}

function checkedUsageAdd(left, right) {
	if (!Number.isSafeInteger(left) || left < 0 || !Number.isSafeInteger(right) || right < 0) return undefined;
	const total = left + right;
	return Number.isSafeInteger(total) ? total : undefined;
}

function measuredUsageTokens(usage) {
	if (usage?.overflowed === true) return { tokens: Number.MAX_SAFE_INTEGER, overflow: true };
	for (const key of ["totalTokens", "total_tokens"]) {
		const value = Number(usage?.[key]);
		if (Number.isSafeInteger(value) && value >= 0) return { tokens: value, overflow: false };
		if (Number.isFinite(value) && value >= 0 && usage?.[key] !== undefined) return { tokens: Number.MAX_SAFE_INTEGER, overflow: true };
	}
	const parts = ["inputTokens", "input_tokens", "outputTokens", "output_tokens", "cacheReadTokens", "cache_read_tokens"];
	let total = 0;
	let found = false;
	for (const key of parts) {
		const value = Number(usage?.[key]);
		if (Number.isSafeInteger(value) && value >= 0) {
			const next = checkedUsageAdd(total, value);
			if (next === undefined) return { tokens: Number.MAX_SAFE_INTEGER, overflow: true };
			total = next; found = true;
		} else if (Number.isFinite(value) && value >= 0 && usage?.[key] !== undefined) {
			return { tokens: Number.MAX_SAFE_INTEGER, overflow: true };
		}
	}
	return found ? { tokens: total, overflow: false } : undefined;
}

function accountRunUsage(run, usage, usageEstimate, usageComplete = false) {
	const measured = usageComplete === true ? measuredUsageTokens(usage) : undefined;
	if (measured !== undefined) {
		const total = checkedUsageAdd(run.usage.tokens, measured.tokens);
		if (measured.overflow || total === undefined) {
			run.usage.tokens = Number.MAX_SAFE_INTEGER;
			run.usage.overflowed = true;
			run.usage.estimatedCalls += 1;
		} else {
			run.usage.tokens = total;
			run.usage.exactCalls += 1;
		}
	} else {
		const estimate = Number.isSafeInteger(usageEstimate?.tokens) && usageEstimate.tokens >= 0
			? usageEstimate.tokens
			: Number.MAX_SAFE_INTEGER;
		run.usage.tokens = checkedUsageAdd(run.usage.tokens, estimate) ?? Number.MAX_SAFE_INTEGER;
		if (run.usage.tokens === Number.MAX_SAFE_INTEGER || usageEstimate?.overflowed === true) run.usage.overflowed = true;
		run.usage.estimatedCalls += 1;
	}
	run.usage.quality = run.usage.estimatedCalls > 0 || run.usage.overflowed ? "estimated" : "exact";
}

function replayRunUsage(value) {
	if (!value || typeof value !== "object") return undefined;
	const tokens = Number.isSafeInteger(value.tokens) && value.tokens >= 0 ? value.tokens : undefined;
	if (tokens === undefined) return undefined;
	const exactCalls = Number.isSafeInteger(value.exactCalls) && value.exactCalls >= 0 ? value.exactCalls : 0;
	const estimatedCalls = Number.isSafeInteger(value.estimatedCalls) && value.estimatedCalls >= 0 ? value.estimatedCalls : 0;
	const overflowed = value.overflowed === true;
	return {
		tokens,
		quality: overflowed || estimatedCalls > 0 ? "estimated" : exactCalls > 0 ? "exact" : "unknown",
		exactCalls,
		estimatedCalls,
		...(overflowed ? { overflowed: true } : {}),
	};
}

function configuredConcurrency(value, fallback, maximum, label) {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} must be a safe integer from 1 to ${maximum}`);
	}
	return value;
}

function workflowSaveName(value) {
	let normalized = String(value ?? "workflow")
		.normalize("NFKD")
		.replace(/[^a-zA-Z0-9._-]+/gu, "-")
		.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9._-]+$/gu, "")
		.slice(0, 128);
	if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(normalized) || normalized.endsWith(".")) normalized = `workflow-${normalized.replace(/\.+$/u, "")}`;
	return normalized || "workflow";
}

function snapshotHasActionableWorktree(snapshot) {
	for (const agent of snapshot?.agents ?? []) {
		const worktrees = [agent.worktree, ...(agent.attempts ?? []).map((attempt) => attempt.worktree)];
		if (worktrees.some((worktree) =>
			!worktree?.appliedAt && (worktree?.retained || worktree?.quarantined || worktree?.recoveryError),
		)) return true;
	}
	return false;
}

function snapshotWithUpdatedWorktree(snapshot, agentId, attemptNumber, worktree) {
	return Object.freeze({
		...snapshot,
		agents: snapshot.agents.map((entry) => entry.id === agentId ? {
			...entry,
			...(entry.attempt === attemptNumber ? { worktree } : {}),
			attempts: (entry.attempts ?? []).map((candidate) => candidate.number === attemptNumber ? { ...candidate, worktree } : candidate),
		} : entry),
	});
}

function snapshotRun(run) {
	return Object.freeze({
		id: run.id,
		name: run.meta.name,
		saveName: run.saveName ?? workflowSaveName(run.meta.name),
		description: run.meta.description,
		phases: run.meta.phases,
		currentPhase: run.currentPhase,
		status: run.status,
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		origin: { harness: run.origin.harness, model: run.origin.model, effort: run.origin.effort, workflowMode: run.origin.workflowMode, cwd: run.origin.cwd },
		tokenBudget: run.tokenBudget,
		requestedConcurrency: run.requestedConcurrency,
		effectiveConcurrency: run.effectiveConcurrency,
		maxConcurrency: run.effectiveConcurrency,
		args: run.args,
		usage: { ...run.usage },
		result: run.result,
			error: run.error,
			delivery: run.delivery,
			recoveryOf: run.recoveryOf,
		agents: [...run.agents.values()].map((agent) => ({
			id: agent.id,
			label: agent.options.label ?? `Agent ${agent.number}`,
			phase: agent.options.phase ?? agent.phase,
			prompt: agent.prompt,
			status: agent.status,
			harness: agent.harness,
			model: agent.model,
			effort: agent.effort,
			attempt: agent.attempt,
			output: agent.output,
			error: agent.error,
			usage: agent.usage,
			usageQuality: agent.usageQuality,
			worktree: agent.worktree,
			startedAt: agent.startedAt,
			finishedAt: agent.finishedAt,
			tools: agent.tools.slice(-100),
			attempts: (agent.attempts ?? []).map((attempt) => ({
				number: attempt.number,
				status: attempt.status,
				model: attempt.model,
				effort: attempt.effort,
				output: attempt.output,
				error: attempt.error,
				usage: attempt.usage,
				usageQuality: attempt.usageQuality,
				worktree: attempt.worktree,
				startedAt: attempt.startedAt,
				finishedAt: attempt.finishedAt,
				tools: (attempt.tools ?? []).slice(-100),
			})),
		})),
	});
}

function replayInterruptedSnapshot(meta, records, fallbackName) {
	const agents = new Map();
	let currentPhase = meta.meta?.phases?.[0];
	let terminal;
	let runUsage = replayRunUsage(meta.snapshot?.usage) ?? { tokens: 0, quality: "unknown", exactCalls: 0, estimatedCalls: 0 };
	for (const record of records) {
		const event = record?.event;
		if (!event || typeof event !== "object") continue;
		runUsage = replayRunUsage(event.runUsage) ?? runUsage;
		if (event.type === "run_completed") {
			// A durable user stop is monotonic. Cancellation-insensitive workflow
			// code can return after stop intent was recorded; a crash before the
			// final stopped record must not resurrect that run as completed.
			if (terminal?.status !== "stopped") terminal = { status: "completed", result: event.result, error: undefined, finishedAt: event.at };
			continue;
		}
		if (event.type === "run_stop_requested") {
			terminal = { status: "stopped", result: undefined, error: event.error, finishedAt: event.at };
			continue;
		}
		if (event.type === "run_failed") {
			if (terminal?.status !== "stopped") terminal = {
				status: event.status === "stopped" ? "stopped" : "failed",
				result: undefined, error: event.error, finishedAt: event.at,
			};
			continue;
		}
		if (event.type === "phase") currentPhase = String(event.title ?? "").slice(0, 256) || currentPhase;
		if (event.type === "agent_queued" && typeof event.agentId === "string") {
			const options = event.options && typeof event.options === "object" ? event.options : {};
			const selectedHarness = options.harness ?? meta.origin?.harness;
			const inheritsOriginModel = selectedHarness === meta.origin?.harness && options.model === undefined;
			const inheritsOriginEffort = selectedHarness === meta.origin?.harness && options.effort === undefined;
			agents.set(event.agentId, {
				id: event.agentId,
				label: options.label ?? `Agent ${agents.size + 1}`,
				phase: options.phase ?? currentPhase,
				prompt: event.prompt ?? "",
				status: "queued",
				harness: selectedHarness,
				model: options.model ? { id: options.model, verified: false } : inheritsOriginModel ? meta.origin?.model : null,
				effort: options.effort ? { id: options.effort, verified: false } : inheritsOriginEffort ? meta.origin?.effort : null,
				attempt: 0,
				output: "",
				error: undefined,
				usage: null,
				usageQuality: "unknown",
				worktree: null,
				startedAt: undefined,
				finishedAt: undefined,
				tools: [],
				attempts: [],
			});
			continue;
		}
		const agent = typeof event.agentId === "string" ? agents.get(event.agentId) : undefined;
		if (!agent) continue;
		const number = Number.isSafeInteger(event.attempt) && event.attempt > 0 ? event.attempt : agent.attempt || 1;
		let attempt = agent.attempts.find((entry) => entry.number === number);
		if (event.type === "agent_started") {
			attempt ??= { number, status: "running", model: agent.model, effort: agent.effort, output: "", error: undefined, usage: null, usageQuality: "unknown", worktree: null, startedAt: event.at, finishedAt: undefined, tools: [] };
			if (!agent.attempts.includes(attempt)) agent.attempts.push(attempt);
			agent.attempt = number; agent.status = attempt.status; agent.startedAt = event.at;
			continue;
		}
		attempt ??= agent.attempts.at(-1);
		if (event.type === "agent_agent_ready") {
			agent.model = event.model; agent.effort = event.effort; agent.worktree = event.worktree;
			if (attempt) { attempt.model = event.model; attempt.effort = event.effort; attempt.worktree = event.worktree; }
		} else if (event.type === "agent_text") {
			agent.output = `${agent.output}${event.text ?? ""}`.slice(-WORKFLOW_LIMITS.maxTraceBytes);
			if (attempt) attempt.output = `${attempt.output}${event.text ?? ""}`.slice(-WORKFLOW_LIMITS.maxTraceBytes);
		} else if (["agent_tool", "agent_tool_update"].includes(event.type)) {
			const tool = { type: event.type, id: event.id, title: event.title, status: event.status };
			agent.tools.push(tool); attempt?.tools.push(tool);
			if (agent.tools.length > WORKFLOW_LIMITS.maxRetainedTools) agent.tools.splice(0, agent.tools.length - WORKFLOW_LIMITS.maxRetainedTools);
			if (attempt?.tools.length > WORKFLOW_LIMITS.maxRetainedTools) attempt.tools.splice(0, attempt.tools.length - WORKFLOW_LIMITS.maxRetainedTools);
		} else if (event.type === "agent_worktree") {
			agent.worktree = event.worktree;
			if (attempt) attempt.worktree = event.worktree;
		} else if (["worktree_apply_started", "worktree_apply_cancelled", "worktree_applied"].includes(event.type)) {
			agent.worktree = event.worktree;
			if (attempt) attempt.worktree = event.worktree;
		} else if (event.type === "agent_restarting") {
			if (attempt) Object.assign(attempt, {
				status: "restarted", error: event.error, output: event.output ?? attempt.output,
				usage: event.usage ?? attempt.usage, usageQuality: event.usageQuality ?? attempt.usageQuality,
				worktree: event.worktree ?? attempt.worktree, finishedAt: event.at,
			});
			agent.status = "restarting";
		} else if (event.type === "agent_completed") {
			agent.status = "completed"; agent.output = event.output ?? agent.output; agent.usage = event.usage; agent.usageQuality = event.usageQuality ?? agent.usageQuality; agent.worktree = event.worktree ?? agent.worktree; agent.finishedAt = event.at;
			if (attempt) Object.assign(attempt, { status: "completed", output: agent.output, usage: agent.usage, usageQuality: agent.usageQuality, worktree: agent.worktree, finishedAt: event.at });
		} else if (event.type === "agent_failed") {
			agent.status = event.status ?? "failed"; agent.error = event.error; agent.output = event.output ?? agent.output;
			agent.usage = event.usage ?? agent.usage; agent.usageQuality = event.usageQuality ?? agent.usageQuality; agent.worktree = event.worktree ?? agent.worktree; agent.finishedAt = event.at;
			if (attempt) Object.assign(attempt, {
				status: agent.status, error: event.error, output: agent.output, usage: agent.usage, usageQuality: agent.usageQuality,
				worktree: agent.worktree, finishedAt: event.at,
			});
		}
	}
	for (const agent of agents.values()) {
		if (["queued", "running", "restarting", "stopping"].includes(agent.status)) agent.status = "interrupted";
		for (const attempt of agent.attempts) {
			if (["queued", "running", "restarting", "stopping"].includes(attempt.status)) attempt.status = "interrupted";
		}
	}
	return {
		id: meta.id, name: meta.meta?.name ?? fallbackName, saveName: meta.saveName ?? workflowSaveName(meta.meta?.name ?? fallbackName), description: meta.meta?.description ?? "Recovered workflow",
		phases: meta.meta?.phases ?? [], currentPhase, status: terminal?.status ?? "interrupted",
		createdAt: meta.createdAt, startedAt: meta.startedAt, finishedAt: terminal?.finishedAt ?? meta.finishedAt,
		origin: meta.origin, args: meta.args ?? null, tokenBudget: meta.tokenBudget ?? null,
		requestedConcurrency: meta.requestedConcurrency ?? meta.maxConcurrency,
		effectiveConcurrency: meta.effectiveConcurrency ?? meta.maxConcurrency,
		maxConcurrency: meta.effectiveConcurrency ?? meta.maxConcurrency,
		usage: runUsage,
		delivery: meta.delivery ?? (terminal ? { state: "not-delivered-after-restart" } : undefined), recoveryOf: meta.recoveryOf,
		result: terminal?.result ?? meta.result, error: terminal?.error ?? meta.error, agents: [...agents.values()],
	};
}

export class WorkflowManager {
	constructor(options) {
		this.harnesses = options.harnesses;
		this.createAdapter = options.createAdapter;
		this.registry = options.registry;
		this.stateRoot = options.stateRoot;
		this.writeLaunchCommit = options.writeLaunchCommit ?? writeWorkflowLaunchCommit;
		this.approve = options.approve ?? (async () => false);
		this.onChange = options.onChange ?? (() => {});
		this.onComplete = options.onComplete ?? (() => {});
		this.onRestartRequired = options.onRestartRequired ?? options.onTerminationFailure ?? (() => {});
		this.registerAdapter = options.registerAdapter ?? (() => {});
		this.unregisterAdapter = options.unregisterAdapter ?? (() => {});
		const configured = options.concurrency ?? {};
		const injectedGlobal = Number.isSafeInteger(options.scheduler?.globalLimit) ? options.scheduler.globalLimit : undefined;
		const injectedHarness = Number.isSafeInteger(options.scheduler?.harnessLimit) ? options.scheduler.harnessLimit : undefined;
		this.concurrency = Object.freeze({
			global: configuredConcurrency(configured.global, injectedGlobal ?? WORKFLOW_LIMITS.globalConcurrency, WORKFLOW_LIMITS.globalConcurrency, "workflowGlobalConcurrency"),
			perRun: configuredConcurrency(configured.perRun, WORKFLOW_LIMITS.maxRunConcurrency, WORKFLOW_LIMITS.maxRunConcurrency, "workflowRunConcurrency"),
			perHarness: configuredConcurrency(configured.perHarness, injectedHarness ?? 8, WORKFLOW_LIMITS.globalConcurrency, "workflowHarnessConcurrency"),
		});
		this.scheduler = options.scheduler ?? new WorkflowScheduler({
			...(options.schedulerOptions ?? {}),
			globalLimit: this.concurrency.global,
			harnessLimit: this.concurrency.perHarness,
		});
		this.worktrees = new WorkflowWorktrees(path.join(this.stateRoot, "workflow-worktrees"));
		this.historyReadBudget = Number.isSafeInteger(options.historyReadBudget) && options.historyReadBudget > 0
			? Math.min(options.historyReadBudget, 128 * 1024 * 1024)
			: 128 * 1024 * 1024;
		this.sandboxTerminationFailures = [];
		this.terminationFailure = undefined;
		this.restartRequiredFailure = undefined;
		this.failedStartCleanups = new Set();
		this.executor = new AdapterWorkflowExecutor({
			createAdapter: this.createAdapter,
			scheduler: this.scheduler,
			worktrees: this.worktrees,
			onAdapterStart: (adapter, call) => this.registerAdapter(adapter, call),
			onAdapterStop: (adapter, call) => this.unregisterAdapter(adapter, call),
			onTerminationFailure: (error) => this.#fenceTerminationFailure(error),
			onRestartRequired: (error) => this.#requireRestart(error),
		});
		this.runs = new Map();
		this.history = new Map();
		this.historySources = new Map();
		this.historyOrigins = new Map();
		this.deferredRecoveryRuns = new Set();
		this.pendingApprovals = new Set();
		this.worktreeOperations = new Set();
		this.startTimes = [];
		this.pendingStarts = 0;
		this.stopping = false;
		this.approvalsFile = path.join(this.stateRoot, "workflow-approvals.json");
		this.approvals = undefined;
		this.approvalWriteTail = Promise.resolve();
	}

	#fenceTerminationFailure(error) {
		if (this.terminationFailure) return;
		this.terminationFailure = error;
		this.#requireRestart(error);
		const reason = Object.assign(new Error("A workflow process tree could not be confirmed stopped; restart cc before launching more workflows", { cause: error }), {
			code: "WORKFLOW_PROCESS_TREE_UNCONFIRMED",
		});
		for (const run of this.runs.values()) {
			if (!run.abortController.signal.aborted) run.abortController.abort(reason);
			for (const sandbox of run.sandboxes ?? []) sandbox.stop();
			this.scheduler.cancelRun(run.id, reason.message);
		}
	}

	#requireRestart(error) {
		if (this.restartRequiredFailure) return;
		this.restartRequiredFailure = error;
		const reason = Object.assign(new Error("The workflow subsystem requires a restart; no workflow work may continue", { cause: error }), {
			code: "WORKFLOW_RESTART_REQUIRED",
		});
		for (const pending of this.pendingApprovals) pending.controller.abort(reason);
		for (const run of this.runs.values()) {
			if (run.completionCommitted || ["completed", "failed", "stopped"].includes(run.status)) continue;
			if (!run.abortController.signal.aborted) run.abortController.abort(reason);
			for (const sandbox of run.sandboxes) sandbox.stop();
			this.scheduler.cancelRun(run.id, reason.message);
		}
		try { this.onRestartRequired(error); } catch { /* the manager fence remains authoritative */ }
	}

	async #cleanupUncommittedRun(run) {
		this.failedStartCleanups.add(run);
		try {
			try { await run.journal.close(); }
			catch (error) {
				// A final sync failure is irrelevant when deleting an uncommitted
				// journal, but an unclosed descriptor makes cleanup untrustworthy.
				if (error?.journalHandleClosed !== true) throw error;
			}
			// Index publication may have renamed successfully before reporting a
			// post-commit fsync error. Removal is idempotent, so always issue it.
			await run.journal.removeFromIndex(run.createdAt);
			await fs.rm(run.journal.directory, { recursive: true, force: true });
			await syncDirectory(run.journal.root);
			await run.releaseLease?.();
			run.releaseLease = undefined;
			this.failedStartCleanups.delete(run);
		} catch (error) {
			this.#requireRestart(error);
			throw error;
		}
	}

	async loadHistory() {
		await ensureWorkflowPrivateDirectory(this.stateRoot);
		const root = path.join(this.stateRoot, "workflow-runs");
		await ensureWorkflowPrivateDirectory(root);
		const recoveryLeases = [];
		const preacquiredLeases = new Map();
		const protectedRunIds = new Set();
		const recoveryOwnedRunIds = new Set();
		let indexed;
		let indexFailure;
		try { indexed = await readWorkflowHistoryIndex(root); }
		catch (error) { indexFailure = error; indexed = []; }
		await fs.mkdir(root, { recursive: true, mode: 0o700 });
		const releaseRecovery = await acquireOwnershipLock(path.join(root, ".history-recovery.lock"), { timeoutMs: 30_000 });
		try {
			// The index is derived state. Always compare its bounded contents with the
			// bounded run-directory set so a crash between durable meta creation and
			// index publication cannot make a run permanently invisible.
			try { indexed = await readWorkflowHistoryIndex(root); indexFailure = undefined; }
			catch (error) { indexFailure = error; indexed = []; }
			const discovered = await discoverWorkflowHistoryCandidates(root);
			const indexedIds = new Set(indexed.map((entry) => entry.id));
			const missing = indexFailure ? discovered : discovered.filter((entry) => !indexedIds.has(entry.id));
			if (missing.length > 0 || indexFailure) {
				for (const candidate of missing) {
					await ensureWorkflowPrivateDirectory(path.join(root, candidate.id));
					try {
						const release = await acquireWorkflowRunLease(this.stateRoot, candidate.id, {
							timeoutMs: 0, waitForDeadOwnerReclaim: true,
						});
						preacquiredLeases.set(candidate.id, release);
						recoveryLeases.push(release);
						recoveryOwnedRunIds.add(candidate.id);
					} catch (error) {
						if (error?.code !== "WORKFLOW_LOCK_TIMEOUT") throw error;
						candidate.state = "live";
						protectedRunIds.add(candidate.id);
					}
				}
				// A dead missing run is recoverable directly from its directory and will
				// enter the compacted index when it is archived below. Only still-owned
				// live runs must be durably admitted before recovery continues. This avoids
				// ever publishing a crash-window overflow that the steady-state reader rejects.
				if (indexFailure) await replaceWorkflowHistoryIndex(root, []);
				for (const candidate of missing) {
					if (candidate.state === "live") await indexWorkflowHistoryCandidate(root, candidate);
				}
				indexed = [...(indexFailure ? [] : indexed), ...missing];
			}
		} finally { await releaseRecovery(); }
		const candidates = indexed
			.map((entry) => ({ name: entry.id, state: entry.state, createdAt: entry.createdAt }))
			.sort((left, right) => (left.state === "archived" ? 1 : 0) - (right.state === "archived" ? 1 : 0) || String(right.createdAt).localeCompare(String(left.createdAt)));
		try {
		let bytes = 0;
			for (const candidate of candidates) {
				if (candidate.state === "actionable") continue;
				await ensureWorkflowPrivateDirectory(path.join(root, candidate.name));
				if (bytes >= this.historyReadBudget && candidate.state !== "live") continue;
				let leaseAcquired = false;
				let fallback;
				let fallbackExact = false;
				let fallbackFailure;
				try {
				const directory = path.join(root, candidate.name);
				if (candidate.state !== "archived") {
					let releaseLease;
					try {
						releaseLease = preacquiredLeases.get(candidate.name) ?? await acquireWorkflowRunLease(this.stateRoot, candidate.name, {
							timeoutMs: 0, waitForDeadOwnerReclaim: true,
						});
					}
					catch (error) {
						if (error?.code === "WORKFLOW_LOCK_TIMEOUT") { protectedRunIds.add(candidate.name); continue; }
						throw error;
					}
						if (!preacquiredLeases.has(candidate.name)) recoveryLeases.push(releaseLease);
						recoveryOwnedRunIds.add(candidate.name);
						leaseAcquired = true;
					}
					// Preserve the exact launch-time recovery capsule before a potentially
					// large journal consumes the aggregate startup reader budget.
					if (candidate.state !== "archived") {
						const remaining = this.historyReadBudget - bytes;
						if (remaining <= 0) {
							fallbackFailure = Object.assign(new Error("workflow startup history budget exhausted"), { code: "WORKFLOW_HISTORY_BUDGET" });
						} else {
							try {
								const recovered = await readWorkflowRecoveryFallback(directory, { maxBytes: remaining });
								bytes += recovered.bytes;
								fallback = recovered.snapshot;
								fallbackExact = recovered.exact;
							} catch (error) {
								bytes = Math.min(this.historyReadBudget, bytes + Math.max(0, Number(error?.workflowReadBytes) || 0));
								fallbackFailure = error;
							}
						}
					}
					if (bytes >= this.historyReadBudget) throw Object.assign(new Error("workflow startup history budget exhausted"), { code: "WORKFLOW_HISTORY_BUDGET" });
					const loaded = await readWorkflowJournal(directory, { maxBytes: this.historyReadBudget - bytes });
					bytes += loaded.bytes;
						const meta = loaded.meta;
					if (meta.id !== candidate.name || (meta.snapshot?.id !== undefined && meta.snapshot.id !== candidate.name)) {
							throw Object.assign(new Error("workflow journal identity does not match its run directory"), { code: "WORKFLOW_JOURNAL_CORRUPT" });
						}
						if (meta.launchCommitRequired === true) {
							const commit = await readWorkflowLaunchCommit(directory, candidate.name);
							bytes = Math.min(this.historyReadBudget, bytes + commit.bytes);
							if (!commit.committed) {
								const persisted = new WorkflowJournal(root, candidate.name);
								await persisted.removeFromIndex(candidate.createdAt);
								await fs.rm(directory, { recursive: true, force: true });
								await syncDirectory(root);
								this.deferredRecoveryRuns.delete(candidate.name);
								continue;
							}
						}
					const persistedActive = ["pending", "running", "paused", "stopping"].includes(meta.snapshot?.status ?? meta.status);
					const journalExact = isExactRecoverySnapshot({
						recoveryExactVersion: 1, source: meta.source, sourceHash: meta.sourceHash, args: meta.args,
						tokenBudget: meta.tokenBudget, requestedConcurrency: meta.requestedConcurrency,
						effectiveConcurrency: meta.effectiveConcurrency, projectIdentity: meta.projectIdentity,
						runDirectoryIdentity: meta.runDirectoryIdentity, recoveryOrigin: meta.origin,
					});
					if (persistedActive && !journalExact) throw Object.assign(new Error("active workflow journal is missing exact recovery inputs"), { code: "WORKFLOW_JOURNAL_CORRUPT" });
					if (journalExact) {
						this.historySources.set(meta.id, meta.source);
						this.historyOrigins.set(meta.id, meta.origin);
					}
					this.deferredRecoveryRuns.delete(candidate.name);
					let snapshot = persistedActive ? replayInterruptedSnapshot(meta, loaded.records, candidate.name) : meta.snapshot ?? {
					id: meta.id, name: meta.meta?.name ?? candidate.name, saveName: meta.saveName ?? workflowSaveName(meta.meta?.name ?? candidate.name), description: meta.meta?.description ?? "Recovered workflow",
					phases: meta.meta?.phases ?? [], currentPhase: undefined,
					status: ["pending", "running", "paused", "stopping"].includes(meta.status) ? "interrupted" : meta.status,
					createdAt: meta.createdAt, startedAt: meta.startedAt, finishedAt: meta.finishedAt,
						origin: meta.origin, args: meta.args ?? null, tokenBudget: meta.tokenBudget ?? null,
						requestedConcurrency: meta.requestedConcurrency ?? meta.maxConcurrency,
						effectiveConcurrency: meta.effectiveConcurrency ?? meta.maxConcurrency,
						maxConcurrency: meta.effectiveConcurrency ?? meta.maxConcurrency,
					usage: { tokens: 0, quality: "unknown" }, delivery: meta.delivery, recoveryOf: meta.recoveryOf,
					result: meta.result, error: meta.error, agents: [],
				};
				if (["pending", "running", "paused", "stopping"].includes(snapshot.status)) snapshot.status = "interrupted";
				const deliveryInterrupted = ["not-ready", "pending", "queued", "waiting-for-session", "sending"].includes(snapshot.delivery?.state);
				if (deliveryInterrupted && candidate.state !== "archived") {
					const sendWasPossible = snapshot.delivery?.state === "sending";
					const delivery = {
						...snapshot.delivery,
						state: sendWasPossible ? "ambiguous" : "not-delivered-after-restart",
						message: sendWasPossible
							? "cc restarted after delivery began but before it could be confirmed"
							: "cc restarted before delivery could be sent",
						updatedAt: now(),
					};
					snapshot = { ...snapshot, delivery };
					const persisted = new WorkflowJournal(root, snapshot.id);
					await persisted.updateMeta({ delivery, snapshot });
				}
				// The owning process is demonstrably gone because this loader holds the
				// run lease. Recovered state is inspectable/recoverable history, not a
				// live admission slot, even when the crash preceded delivery creation.
				if (candidate.state !== "archived") {
					const persisted = new WorkflowJournal(root, snapshot.id);
					await persisted.markArchived(snapshot.createdAt);
				}
				this.history.set(snapshot.id, Object.freeze(snapshot));
				} catch (error) {
					bytes = Math.min(this.historyReadBudget, bytes + Math.max(0, Number(error?.workflowReadBytes) || 0));
					if (!fallback && !fallbackFailure) {
						try {
							const remaining = this.historyReadBudget - bytes;
							if (remaining <= 0) throw Object.assign(new Error("workflow startup history budget exhausted"), { code: "WORKFLOW_HISTORY_BUDGET" });
							const recovered = await readWorkflowRecoveryFallback(path.join(root, candidate.name), { maxBytes: remaining });
							bytes += recovered.bytes;
							fallback = recovered.snapshot;
							fallbackExact = recovered.exact;
						} catch (fallbackError) {
							bytes = Math.min(this.historyReadBudget, bytes + Math.max(0, Number(fallbackError?.workflowReadBytes) || 0));
							fallbackFailure = fallbackError;
						}
					}
					if (fallback?.id === candidate.name) {
						if (fallback.launchCommitRequired === true) {
							try {
								const commit = await readWorkflowLaunchCommit(path.join(root, candidate.name), candidate.name);
								bytes = Math.min(this.historyReadBudget, bytes + commit.bytes);
								if (!commit.committed) {
									const persisted = new WorkflowJournal(root, candidate.name);
									await persisted.removeFromIndex(candidate.createdAt);
									await fs.rm(path.join(root, candidate.name), { recursive: true, force: true });
									await syncDirectory(root);
									this.deferredRecoveryRuns.delete(candidate.name);
									continue;
								}
							} catch (commitError) {
								bytes = Math.min(this.historyReadBudget, bytes + Math.max(0, Number(commitError?.workflowReadBytes) || 0));
								error = commitError;
								fallback = undefined;
								fallbackExact = false;
								fallbackFailure = commitError;
							}
						}
					}
					if (fallback?.id === candidate.name) {
					this.deferredRecoveryRuns.delete(candidate.name);
					if (leaseAcquired && candidate.state !== "archived" && fallbackExact) {
						// recovery.json may have reached disk immediately before a crash in
						// the fallback-to-archive transition. The lease proves the old owner is
						// gone, so finish retiring its live admission slot before continuing.
						const persisted = new WorkflowJournal(root, candidate.name);
						await persisted.markArchived(fallback.createdAt ?? candidate.createdAt);
					} else if (leaseAcquired && candidate.state !== "archived") this.deferredRecoveryRuns.add(candidate.name);
					if (fallbackExact) {
						this.historySources.set(candidate.name, fallback.source);
						this.historyOrigins.set(candidate.name, fallback.recoveryOrigin);
					}
					const {
						source: _source, sourceHash: _sourceHash, recoveryOrigin: _recoveryOrigin,
						recoveryExactVersion: _recoveryExactVersion, projectIdentity: _projectIdentity,
						runDirectoryIdentity: _runDirectoryIdentity, ...visibleFallback
					} = fallback;
					this.history.set(candidate.name, Object.freeze(visibleFallback));
					continue;
				}
				const interrupted = Object.freeze({
						id: candidate.name, name: "Interrupted workflow", saveName: candidate.name,
						description: "Workflow history could not be read safely during startup recovery",
						phases: ["Recovery"], currentPhase: "Recovery", status: "interrupted",
						createdAt: candidate.createdAt, startedAt: undefined, finishedAt: undefined,
						origin: undefined, args: null, tokenBudget: null, requestedConcurrency: 1,
						effectiveConcurrency: 1, maxConcurrency: 1, usage: { tokens: 0, quality: "unknown" },
						delivery: { state: "origin-retired" }, result: undefined,
						error: publicError(error), agents: [],
					});
				if (leaseAcquired && candidate.state !== "archived") {
						// A corrupt/absent capsule can be replaced and retired. A capsule that
						// merely did not fit remains indexed as recovery-critical live history;
						// after newer successful candidates become archived, the next startup
						// prioritizes and loads this exact capsule before ordinary journals.
					const persisted = new WorkflowJournal(root, candidate.name);
						// Budget exhaustion means the exact capsule was not inspected, not that
						// it was invalid. Preserve it on disk for a later bounded startup.
						if (fallbackFailure?.code !== "WORKFLOW_HISTORY_BUDGET") {
							await writeWorkflowRecoveryFallback(path.join(root, candidate.name), interrupted);
						}
						if (fallbackFailure?.code !== "WORKFLOW_HISTORY_BUDGET") {
							await persisted.markArchived(candidate.createdAt);
						} else this.deferredRecoveryRuns.add(candidate.name);
				}
				if (fallbackFailure?.code !== "WORKFLOW_HISTORY_BUDGET") this.history.set(candidate.name, interrupted);
			}
		}
		const knownWorktrees = new Set();
		const appliedWorktrees = new Map();
		for (const snapshot of this.history.values()) {
			for (const agent of snapshot.agents ?? []) {
				if (agent.worktree?.directory) {
					knownWorktrees.add(agent.worktree.directory);
					if (agent.worktree.appliedAt) appliedWorktrees.set(path.resolve(agent.worktree.directory), agent.worktree.appliedAt);
				}
				for (const attempt of agent.attempts ?? []) if (attempt.worktree?.directory) {
					knownWorktrees.add(attempt.worktree.directory);
					if (attempt.worktree.appliedAt) appliedWorktrees.set(path.resolve(attempt.worktree.directory), attempt.worktree.appliedAt);
				}
			}
		}
			const orphans = await this.worktrees.reconcileOrphans(knownWorktrees, {
				protectedRunIds,
				ownedRunIds: recoveryOwnedRunIds,
				appliedWorktrees,
				withRepositoryMutation: typeof this.executor.withRepositoryMutation === "function"
					? (repository, signal, operation) => this.executor.withRepositoryMutation(repository, signal, operation)
					: undefined,
			});
			// Orphan reconciliation consumes the same aggregate startup journal
			// budget instead of beginning an independent second read pass.
			const orphanRecovery = { journalBytes: bytes, attemptedRuns: new Set() };
		for (const worktree of orphans) await this.#attachRecoveredWorktree(worktree, orphanRecovery);
		const recoveredIds = new Set(orphans.map((worktree) => worktree.runId));
		for (const candidate of indexed.filter((entry) => entry.state === "actionable")) {
			if (!recoveredIds.has(candidate.id)) await new WorkflowJournal(root, candidate.id).removeFromIndex(candidate.createdAt);
		}
		this.onChange();
		} finally {
			const releaseResults = await Promise.allSettled(recoveryLeases.map((release) => release()));
			const releaseErrors = releaseResults.filter((result) => result.status === "rejected").map((result) => result.reason);
			if (releaseErrors.length > 0) {
				const error = Object.assign(new AggregateError(releaseErrors, "workflow startup recovery leases could not be released; restart cc before enabling workflows"), {
					code: "WORKFLOW_RECOVERY_LEASE_RELEASE_FAILED",
				});
				this.#requireRestart(error);
				throw error;
			}
		}
	}

	async #attachRecoveredWorktree(worktree, recovery = { journalBytes: 0, attemptedRuns: new Set() }) {
		let existing = this.history.get(worktree.runId);
		if (!existing && !recovery.attemptedRuns.has(worktree.runId) && recovery.journalBytes < this.historyReadBudget) {
			recovery.attemptedRuns.add(worktree.runId);
			try {
				const loaded = await readWorkflowJournal(path.join(this.stateRoot, "workflow-runs", worktree.runId), { maxBytes: this.historyReadBudget - recovery.journalBytes });
				recovery.journalBytes += loaded.bytes;
				if (loaded.meta.snapshot?.id === worktree.runId) {
					existing = loaded.meta.snapshot;
					this.history.set(worktree.runId, Object.freeze(existing));
					if (typeof loaded.meta.source === "string") this.historySources.set(worktree.runId, loaded.meta.source);
					if (loaded.meta.origin && typeof loaded.meta.origin === "object") this.historyOrigins.set(worktree.runId, loaded.meta.origin);
				}
				} catch (error) {
					recovery.journalBytes = Math.min(this.historyReadBudget,
						recovery.journalBytes + Math.max(0, Number(error?.workflowReadBytes) || 0));
					// A marker without a usable journal is reconstructed below.
				}
		}
		const attempts = [{
			number: worktree.attempt, status: "interrupted", model: null, effort: null, output: "",
			error: worktree.recoveryError ? { message: worktree.recoveryError } : undefined,
			usage: null, worktree, startedAt: undefined, finishedAt: undefined, tools: [],
		}];
		const recoveredAgent = {
			id: worktree.agentId, number: Number(String(worktree.agentId).split(":").at(-1)) || 1,
			prompt: "Recovered after an interrupted worktree launch", options: { isolation: "worktree" }, phase: "Recovery",
			harness: undefined, model: null, effort: null, status: "interrupted", attempt: worktree.attempt,
			attempts, output: "", error: worktree.recoveryError ? { message: worktree.recoveryError } : undefined,
			usage: null, worktree, tools: [], startedAt: undefined, finishedAt: undefined,
		};
		if (existing) {
			const agents = [...(existing.agents ?? [])];
			const index = agents.findIndex((agent) => agent.id === worktree.agentId);
			if (index < 0) agents.push(recoveredAgent);
			else {
				const agent = agents[index];
				const priorAttempts = [...(agent.attempts ?? [])];
				const attemptIndex = priorAttempts.findIndex((attempt) => attempt.number === worktree.attempt);
				if (attemptIndex < 0) priorAttempts.push(attempts[0]);
				else {
					const priorWorktree = priorAttempts[attemptIndex].worktree;
					priorAttempts[attemptIndex] = { ...priorAttempts[attemptIndex], worktree: {
						...worktree,
						...(priorWorktree?.appliedAt ? { appliedAt: priorWorktree.appliedAt } : {}),
						...(priorWorktree?.applyState ? { applyState: priorWorktree.applyState, applyStartedAt: priorWorktree.applyStartedAt } : {}),
					} };
				}
				const selectedWorktree = agent.attempt === worktree.attempt
					? priorAttempts.find((attempt) => attempt.number === worktree.attempt)?.worktree ?? worktree
					: agent.worktree;
				agents[index] = { ...agent, worktree: selectedWorktree, attempts: priorAttempts };
			}
			const snapshot = Object.freeze({ ...existing, agents });
			this.history.set(existing.id, snapshot);
			await this.#publishRecoveredWorktree(snapshot, worktree);
			return;
		}
		const createdAt = new Date().toISOString();
		const snapshot = Object.freeze({
			id: worktree.runId, name: "Recovered workflow worktree", description: "A retained worktree survived an interrupted workflow launch",
			phases: ["Recovery"], currentPhase: "Recovery", status: "interrupted", createdAt, startedAt: undefined,
			finishedAt: undefined, origin: undefined, args: null, tokenBudget: null, requestedConcurrency: 1,
			effectiveConcurrency: 1, maxConcurrency: 1, usage: { tokens: 0, quality: "unknown" }, delivery: { state: "origin-retired" },
			result: undefined, error: worktree.recoveryError ? { message: worktree.recoveryError } : undefined, agents: [recoveredAgent],
		});
		this.history.set(worktree.runId, snapshot);
		await this.#publishRecoveredWorktree(snapshot, worktree);
	}

	async #publishRecoveredWorktree(snapshot, worktree) {
		const actionableHistory = [...this.history.values()].filter(snapshotHasActionableWorktree).length;
		if (this.runs.size + actionableHistory > WORKFLOW_LIMITS.maxActionableHistoryRuns) {
			throw Object.assign(new Error("Recovered workflow worktrees exceed the bounded actionable-history capacity; apply or remove retained worktrees before enabling workflows"), { code: "WORKFLOW_ACTIONABLE_HISTORY_LIMIT" });
		}
		// Normal retained markers have a trustworthy run ID and participate in the
		// durable history capacity/eviction invariant. Quarantined malformed
		// markers use a synthetic display ID and are re-discovered fail-closed.
		if ((worktree?.quarantined || worktree?.recoveryError) && !this.deferredRecoveryRuns.has(snapshot.id)) {
			await indexWorkflowHistoryCandidate(path.join(this.stateRoot, "workflow-runs"), {
				id: snapshot.id, createdAt: snapshot.createdAt, state: "actionable",
			});
		} else if (worktree?.retained && !this.deferredRecoveryRuns.has(snapshot.id)) {
			await indexWorkflowHistoryCandidate(path.join(this.stateRoot, "workflow-runs"), {
				id: snapshot.id, createdAt: snapshot.createdAt, state: "archived",
			});
		}
	}

	async #readApprovalSet() {
		let parsed;
		let handle;
		try {
			const before = await fs.lstat(this.approvalsFile);
			if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow approval store is not a regular file");
			handle = await fs.open(this.approvalsFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > WORKFLOW_LIMITS.maxApprovalFileBytes) throw new Error("workflow approval store exceeds its read bound");
			parsed = JSON.parse((await readBoundedHandle(handle, WORKFLOW_LIMITS.maxApprovalFileBytes, "workflow approval store exceeds its read bound")).toString("utf8"));
		} catch (error) { if (error?.code !== "ENOENT") throw error; }
		finally { await handle?.close(); }
		const keys = Array.isArray(parsed?.keys)
			? parsed.keys.filter((key) => typeof key === "string" && /^[a-f0-9]{64}$/u.test(key)).slice(-WORKFLOW_LIMITS.maxRememberedApprovals)
			: [];
		return new Set(keys);
	}

	async #approvalSet(options = {}) {
		if (this.approvals && options.refresh !== true) return this.approvals;
		this.approvals = await this.#readApprovalSet();
		return this.approvals;
	}

	async #rememberApproval(key) {
		const operation = this.approvalWriteTail.then(async () => {
			const release = await acquireOwnershipLock(`${this.approvalsFile}.lock`, { timeoutMs: 30_000 });
			try {
				// Re-read after acquiring the process-wide lock so concurrent cc
				// instances merge remembered approvals instead of overwriting them.
				const next = await this.#readApprovalSet();
				next.delete(key);
				next.add(key);
				const retained = new Set([...next].slice(-WORKFLOW_LIMITS.maxRememberedApprovals));
				await atomicJson(this.approvalsFile, { version: WORKFLOW_APPROVAL_VERSION, keys: [...retained] });
				this.approvals = retained;
			} finally { await release(); }
		});
		this.approvalWriteTail = operation.catch(() => {});
		return operation;
	}

	#approvalIdentity({ launch, sourceHash, origin, saved, recoveryOf, projectIdentity }) {
		const value = {
			version: WORKFLOW_APPROVAL_VERSION,
			sourceHash,
			args: launch.args,
			tokenBudget: launch.tokenBudget,
			requestedConcurrency: launch.requestedConcurrency,
			effectiveConcurrency: launch.effectiveConcurrency,
			mode: origin.workflowMode,
			project: {
				canonicalRoot: projectIdentity.canonicalRoot,
				device: projectIdentity.device,
				inode: projectIdentity.inode,
			},
			origin: { harness: origin.harness, model: origin.model, effort: origin.effort },
			saved: saved ? { name: saved.name, scope: saved.scope, hash: saved.hash } : null,
			recoveryOf: recoveryOf ?? null,
			limits: {
				globalConcurrency: this.concurrency.global,
				runConcurrency: this.concurrency.perRun,
				harnessConcurrency: this.concurrency.perHarness,
				maxAgents: WORKFLOW_LIMITS.maxAgents,
				maxDepth: WORKFLOW_LIMITS.maxDepth,
				maxSandboxes: WORKFLOW_LIMITS.maxSandboxes,
				maxLiveSandboxes: WORKFLOW_LIMITS.maxLiveSandboxes,
				maxSandboxRequests: WORKFLOW_LIMITS.maxSandboxRequests,
				maxPendingSandboxRequests: WORKFLOW_LIMITS.maxPendingSandboxRequests,
			},
		};
		return { key: createHash("sha256").update(JSON.stringify(value)).digest("hex"), value };
	}

	#admitStart() {
		if (this.restartRequiredFailure || this.failedStartCleanups.size > 0) {
			throw Object.assign(new Error("The workflow subsystem has unresolved cleanup state; restart cc before launching more workflows", { cause: this.restartRequiredFailure }), {
				code: "WORKFLOW_RESTART_REQUIRED",
			});
		}
		const cutoff = Date.now() - 60_000;
		this.startTimes = this.startTimes.filter((value) => value > cutoff);
		if (this.startTimes.length >= WORKFLOW_LIMITS.maxStartsPerMinute) {
			throw Object.assign(new Error("Dynamic workflow launch rate limit exceeded"), { code: "WORKFLOW_RATE_LIMIT" });
		}
		if (this.runs.size + this.pendingStarts >= WORKFLOW_LIMITS.maxLiveRuns) {
			throw Object.assign(new Error("Too many live or awaiting-delivery workflows; inspect or finish existing runs first"), { code: "WORKFLOW_LIVE_LIMIT" });
		}
		const actionableHistory = [...this.history.values()].filter(snapshotHasActionableWorktree).length;
		if (this.runs.size + this.pendingStarts + actionableHistory >= WORKFLOW_LIMITS.maxActionableHistoryRuns) {
			throw Object.assign(new Error("Live and retained-worktree workflow recovery is at capacity; apply retained worktrees before launching more workflows"), { code: "WORKFLOW_ACTIONABLE_HISTORY_LIMIT" });
		}
		this.startTimes.push(Date.now());
		this.pendingStarts += 1;
	}

	async start(input, origin, options = {}) {
		if (process.platform === "win32") {
			throw Object.assign(new Error("Dynamic workflows currently require macOS or Linux"), { code: "WORKFLOW_PLATFORM_UNSUPPORTED" });
		}
		if (this.stopping) throw Object.assign(new Error("Dynamic workflow manager is stopping"), { code: "WORKFLOW_STOPPING" });
		const workflowMode = normalizeWorkflowMode(origin?.workflowMode);
		if (!origin || workflowMode === "disabled") {
			throw Object.assign(new Error("Dynamic workflows are disabled; use /workflow-mode to enable them"), { code: "WORKFLOW_DISABLED" });
		}
		if (workflowMode === "clone-only" && (origin.model?.verified !== true || typeof origin.model?.id !== "string" || !origin.model.id)) {
			throw Object.assign(new Error("Clone Only requires the parent harness to report a verified model"), { code: "WORKFLOW_CLONE_MODEL_UNVERIFIED" });
		}
		if (workflowMode === "clone-only" && (!origin.effort?.verified || !origin.effort?.id)) {
			throw Object.assign(new Error("Clone Only requires the parent harness to report a verified reasoning effort"), { code: "WORKFLOW_CLONE_EFFORT_UNVERIFIED" });
		}
		this.#admitStart();
		try {
		origin = { ...origin, workflowMode };
		const normalizedLaunch = normalizeWorkflowLaunch(input);
		const launch = Object.freeze({
			...normalizedLaunch,
			requestedConcurrency: normalizedLaunch.maxConcurrency,
			effectiveConcurrency: Math.min(
				normalizedLaunch.maxConcurrency,
				this.concurrency.global,
				this.concurrency.perRun,
				...(workflowMode === "clone-only" ? [this.concurrency.perHarness] : []),
			),
		});
		let source;
		let saved;
		const preApprovalDeadline = Date.now() + 10_000;
		if (launch.name) {
			const resolutionController = new AbortController();
			const abortResolution = () => resolutionController.abort(options.signal?.reason ?? Object.assign(new Error("Workflow launch cancelled"), { code: "WORKFLOW_CANCELLED" }));
			const resolutionTimer = setTimeout(() => resolutionController.abort(Object.assign(new Error("project workflow discovery timed out"), { code: "WORKFLOW_PROJECT_IO_TIMEOUT" })), Math.max(1, preApprovalDeadline - Date.now()));
			if (options.signal?.aborted) abortResolution();
			else options.signal?.addEventListener("abort", abortResolution, { once: true });
			try {
				saved = await this.registry.resolve(launch.name, origin.authority === "human"
					? { projectRoot: origin.cwd, signal: resolutionController.signal, deadline: preApprovalDeadline }
					: { requireImported: true, projectRoot: origin.cwd, signal: resolutionController.signal, deadline: preApprovalDeadline });
				source = saved.source;
			} finally { clearTimeout(resolutionTimer); options.signal?.removeEventListener("abort", abortResolution); }
			} else source = launch.script;
			const meta = extractWorkflowMeta(source);
			const sourceHash = createHash("sha256").update(source).digest("hex");
			// Project workflow reads already require the race-safe dirfd helper. Inline
			// source and personal workflows need only a stable approval namespace, so
			// use Node directory identity and keep them available without Python/POSIX
			// project-I/O primitives as promised by the compatibility contract.
			const readApprovalProjectIdentity = saved?.scope === "project"
				? (requestOptions) => this.registry.projectIdentity(origin.cwd, requestOptions)
				: (requestOptions) => this.registry.approvalProjectIdentity(origin.cwd, requestOptions);
			const projectIdentity = saved?.scope === "project"
				? saved.projectIdentity
				: await readApprovalProjectIdentity({ signal: options.signal, deadline: preApprovalDeadline });
			if (!projectIdentity || ["canonicalRoot", "device", "inode"].some((key) => typeof projectIdentity[key] !== "string")) {
				throw Object.assign(new Error("Resolved project workflow is missing its source-bound project identity"), { code: "WORKFLOW_PROJECT_IDENTITY_MISSING" });
			}
			const approvalIdentity = this.#approvalIdentity({ launch, sourceHash, origin, saved, recoveryOf: options.recoveryOf, projectIdentity });
		const remembered = (await this.#approvalSet({ refresh: true })).has(approvalIdentity.key);
		const approvalController = new AbortController();
		const abortApproval = () => approvalController.abort(options.signal?.reason ?? Object.assign(new Error("Workflow launch cancelled"), { code: "WORKFLOW_CANCELLED" }));
		if (options.signal?.aborted) abortApproval();
		else options.signal?.addEventListener("abort", abortApproval, { once: true });
		let settlePending;
		const pending = {
			controller: approvalController,
			settled: new Promise((resolve) => { settlePending = resolve; }),
		};
		this.pendingApprovals.add(pending);
		const ensureLaunchActive = () => {
			if (approvalController.signal.aborted) throw approvalController.signal.reason;
			if (this.restartRequiredFailure || this.failedStartCleanups.size > 0) {
				throw Object.assign(new Error("The workflow subsystem has unresolved cleanup state; restart cc before launching more workflows", { cause: this.restartRequiredFailure }), {
					code: "WORKFLOW_RESTART_REQUIRED",
				});
			}
			if (this.stopping) throw Object.assign(new Error("Dynamic workflow manager is stopping"), { code: "WORKFLOW_STOPPING" });
		};
		let run;
		try {
			ensureLaunchActive();
			const approvalTask = remembered
				? Promise.resolve({ approved: true, remembered: true })
				: Promise.resolve(this.approve({
					launch, meta, source, sourceHash, origin, saved, signal: approvalController.signal,
					approvalKey: approvalIdentity.key, approvalIdentity: approvalIdentity.value,
					routingDynamic: origin.workflowMode === "flexible", recoveryOf: options.recoveryOf,
				}));
			const cancellation = new Promise((_, reject) => {
				approvalController.signal.addEventListener("abort", () => reject(approvalController.signal.reason), { once: true });
			});
				const approval = await Promise.race([approvalTask, cancellation]);
				ensureLaunchActive();
				const approved = approval === true || approval?.approved === true;
				if (!approved) throw Object.assign(new Error("Workflow was not approved"), { code: "WORKFLOW_NOT_APPROVED" });
					const confirmedProjectIdentity = await readApprovalProjectIdentity({ signal: approvalController.signal, deadline: Date.now() + 10_000 });
				if (["canonicalRoot", "device", "inode"].some((key) => confirmedProjectIdentity[key] !== projectIdentity[key])) {
					throw Object.assign(new Error("Workflow project identity changed during approval; review and launch it again"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
				}
				if (approval?.remember === true) {
				await this.#rememberApproval(approvalIdentity.key);
				ensureLaunchActive();
			}
			if (saved && origin.authority === "human") {
				await this.registry.importResolved(saved, origin.cwd, {
					signal: approvalController.signal,
					expectedProjectIdentity: projectIdentity,
				});
				ensureLaunchActive();
			}
			const id = randomUUID();
			const releaseLease = await acquireWorkflowRunLease(this.stateRoot, id, { timeoutMs: 30_000, signal: approvalController.signal });
					run = {
				id, meta, saveName: saved?.name ?? workflowSaveName(meta.name), source, sourceHash, args: launch.args, origin: Object.freeze({ ...origin }), projectIdentity: Object.freeze({ ...confirmedProjectIdentity }), recoveryOf: options.recoveryOf,
					tokenBudget: launch.tokenBudget,
					requestedConcurrency: launch.requestedConcurrency,
					effectiveConcurrency: launch.effectiveConcurrency,
					maxConcurrency: launch.effectiveConcurrency,
				status: "pending", currentPhase: meta.phases[0], createdAt: now(), startedAt: undefined, finishedAt: undefined,
				usage: { tokens: 0, quality: "unknown", exactCalls: 0, estimatedCalls: 0 }, result: undefined, error: undefined, delivery: { state: "not-ready" },
				events: [], agents: new Map(), agentCount: 0, sandboxCount: 0, liveSandboxCount: 0,
				rpcCount: 0, pendingRpcCount: 0, hostEventCount: 0, hostEventBytes: 0,
					abortController: new AbortController(), sandboxes: new Set(), agentExecutions: new Set(), sandboxExecutions: new Set(),
					journal: new WorkflowJournal(path.join(this.stateRoot, "workflow-runs"), id), releaseLease, metadataTail: Promise.resolve(),
					responseAcceptanceState: options.deferExecution === true ? "awaiting" : "accepted", commitPromise: undefined, rollbackPromise: undefined,
				};
					await run.journal.initialize({
						id, meta, saveName: run.saveName, sourceHash, source, args: launch.args, origin: run.origin, projectIdentity: run.projectIdentity, status: run.status,
						launchCommitRequired: true,
					createdAt: run.createdAt, tokenBudget: launch.tokenBudget,
					requestedConcurrency: launch.requestedConcurrency,
					effectiveConcurrency: launch.effectiveConcurrency,
					maxConcurrency: launch.effectiveConcurrency,
						recoveryOf: options.recoveryOf,
					});
					// Keep a small, independently readable recovery capsule before the
					// event journal can grow. Startup budget exhaustion or journal corruption
					// can then retire the dead live slot without losing the exact rerun inputs.
					await writeWorkflowRecoveryFallback(run.journal.directory, {
						...snapshotRun(run), status: "interrupted", recoveryExactVersion: 1, launchCommitRequired: true,
						source: run.source, sourceHash: run.sourceHash, projectIdentity: run.projectIdentity,
						runDirectoryIdentity: run.journal.directoryIdentity, recoveryOrigin: run.origin,
					});
			ensureLaunchActive();
				this.scheduler.configureRun(id, launch.effectiveConcurrency);
			await this.#record(run, { type: "run_created", status: "pending" }, true);
			ensureLaunchActive();
				this.runs.set(id, run);
				if (options.deferExecution !== true) await this.commitStart(id);
				void run.execution?.catch(() => {});
			return { taskId: id, status: run.status, name: meta.name, phases: meta.phases };
		} catch (error) {
			if (error?.code === "WORKFLOW_PROJECT_HELPER_TERMINATION_UNCONFIRMED") this.#requireRestart(error);
			// A marker that was renamed before a directory-fsync failure is visible
			// durable state with an uncertain crash outcome. Keep its journal, lease,
			// and marker intact for restart recovery instead of treating it like an
			// allocation that never crossed the publication boundary.
			if (run && !run.execution && run.responseAcceptanceState !== "commit-ambiguous") {
				this.scheduler.closeRun(run.id);
				this.runs.delete(run.id);
				try { await this.#cleanupUncommittedRun(run); }
				catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Workflow launch failed and its partial durable state could not be cleaned; restart cc");
				}
			}
			throw error;
		} finally {
			options.signal?.removeEventListener("abort", abortApproval);
			this.pendingApprovals.delete(pending);
			settlePending();
		}
		} finally { this.pendingStarts -= 1; }
	}

	acceptStart(id) {
		const run = this.runs.get(id);
		if (!run || run.responseAcceptanceState !== "awaiting" || run.execution) {
			throw Object.assign(new Error("Workflow launch is no longer awaiting response acceptance"), { code: "WORKFLOW_LAUNCH_NOT_PENDING" });
		}
		if (this.restartRequiredFailure || this.failedStartCleanups.size > 0) {
			throw Object.assign(new Error("The workflow subsystem requires a restart before this launch can be accepted", { cause: this.restartRequiredFailure }), { code: "WORKFLOW_RESTART_REQUIRED" });
		}
		if (this.stopping || run.abortController.signal.aborted) {
			throw Object.assign(new Error("Workflow launch was cancelled before its response was accepted"), { code: "WORKFLOW_LAUNCH_CANCELLED" });
		}
		run.responseAcceptanceState = "accepted";
		return true;
	}

	async commitStart(id) {
		const run = this.runs.get(id);
		if (!run || run.responseAcceptanceState !== "accepted" || run.execution) {
			throw Object.assign(new Error("Workflow launch response was not accepted before commit"), { code: "WORKFLOW_LAUNCH_NOT_ACCEPTED" });
		}
		if (this.restartRequiredFailure || this.failedStartCleanups.size > 0 || run.abortController.signal.aborted) {
			throw Object.assign(new Error("Workflow launch cannot commit because the subsystem requires restart", { cause: this.restartRequiredFailure ?? run.abortController.signal.reason }), { code: "WORKFLOW_RESTART_REQUIRED" });
		}
		run.responseAcceptanceState = "committing";
		let markerPublished = false;
		const releaseCommittedExecution = () => {
			run.responseAcceptanceState = "committed";
			run.execution ??= this.#executeRun(run);
			void run.execution.catch(() => {});
		};
		const commit = (async () => {
			await this.writeLaunchCommit(run.journal.directory, run.id, run.journal.directoryIdentity, {
				onPublished: () => {
					// The atomic rename is the irreversible launch boundary. Cancellation
					// racing the subsequent directory fsync must await this transaction; it
					// can no longer clean a visible marker as an uncommitted allocation.
					markerPublished = true;
					if (run.responseAcceptanceState === "committing") run.responseAcceptanceState = "published";
				},
			});
			if (!markerPublished) throw new Error("Workflow launch commit marker was not published");
			// A sticky restart fence can arrive while the marker write is awaiting I/O.
			// The marker is now durable and must remain reconcilable, but source must
			// not execute: publish the committed state with an already-aborted signal.
			if (this.restartRequiredFailure && !run.abortController.signal.aborted) {
				run.abortController.abort(Object.assign(new Error("Workflow launch cancelled because the subsystem requires restart", { cause: this.restartRequiredFailure }), { code: "WORKFLOW_RESTART_REQUIRED" }));
			}
			releaseCommittedExecution();
			return true;
		})();
		run.commitPromise = commit;
		try { return await commit; }
		catch (error) {
			if (markerPublished) {
				const ambiguous = Object.assign(new Error("Workflow launch marker was renamed but its directory durability could not be confirmed; restart cc", { cause: error }), {
					code: "WORKFLOW_LAUNCH_COMMIT_AMBIGUOUS",
				});
				run.responseAcceptanceState = "commit-ambiguous";
				run.commitAmbiguousError = ambiguous;
				this.#requireRestart(ambiguous);
				throw ambiguous;
			}
			if (run.responseAcceptanceState === "committing") run.responseAcceptanceState = "accepted";
			throw error;
		} finally {
			if (run.commitPromise === commit) run.commitPromise = undefined;
		}
	}

	async rollbackStart(id) {
		const run = this.runs.get(id);
		if (!run) return false;
		if (run.rollbackPromise) return run.rollbackPromise;
		const rollback = (async () => {
			if (run.responseAcceptanceState === "commit-ambiguous") throw run.commitAmbiguousError;
			if (["committing", "published", "commit-cancelled"].includes(run.responseAcceptanceState)) {
				run.responseAcceptanceState = "commit-cancelled";
				if (!run.abortController.signal.aborted) run.abortController.abort(Object.assign(new Error("Workflow launch cancelled during commit"), { code: "WORKFLOW_LAUNCH_CANCELLED" }));
				await run.commitPromise?.catch(() => {});
				// commitStart can discover a post-rename durability failure while this
				// rollback is waiting. Re-check the terminal ambiguity before any cleanup.
				if (run.responseAcceptanceState === "commit-ambiguous") throw run.commitAmbiguousError;
			}
			if (run.responseAcceptanceState === "committed" || run.execution) return this.stop(id);
			run.responseAcceptanceState = "rolled-back";
			this.scheduler.closeRun(id);
			await this.#cleanupUncommittedRun(run);
			this.runs.delete(id);
			return true;
		})();
		run.rollbackPromise = rollback;
		try { return await rollback; }
		finally { if (run.rollbackPromise === rollback) run.rollbackPromise = undefined; }
	}

	async #executeRun(run) {
		let finalStatus = "failed";
		try {
			if (run.abortController.signal.aborted) throw run.abortController.signal.reason;
			run.status = "running";
			run.startedAt = now();
			await this.#record(run, { type: "run_started" }, true);
			run.result = await this.#executeSource(run, run.source, run.args, 0);
			if (run.abortController.signal.aborted) throw run.abortController.signal.reason;
			await this.#record(run, { type: "run_completed", result: run.result, runUsage: { ...run.usage } }, true);
			if (run.abortController.signal.aborted) throw run.abortController.signal.reason;
			run.completionCommitted = true;
			finalStatus = "completed";
		} catch (error) {
			if (!run.abortController.signal.aborted) run.abortController.abort(error);
			for (const sandbox of run.sandboxes) sandbox.stop();
			run.error = publicError(error);
			const userStopped = run.abortController.signal.reason?.code === "WORKFLOW_STOPPED";
			finalStatus = userStopped && error?.code !== "WORKFLOW_JOURNAL_FAILED" ? "stopped" : "failed";
			await this.#record(run, { type: "run_failed", status: finalStatus, error: run.error, runUsage: { ...run.usage } }, true).catch(() => {});
		} finally {
			await Promise.allSettled([...run.agentExecutions, ...run.sandboxExecutions]);
			run.finishedAt = now();
			this.scheduler.closeRun(run.id);
			let deliveryPersisted = true;
			const releaseInitialMetadata = await this.#acquireRunMetadata(run);
			try {
				run.status = finalStatus;
				run.delivery = {
					state: "pending",
					deliveryId: `workflow:${run.id}:complete`,
					updatedAt: now(),
				};
				await run.journal.updateMeta({
					status: finalStatus,
					startedAt: run.startedAt,
					finishedAt: run.finishedAt,
					result: run.result,
					error: run.error,
					delivery: run.delivery,
					snapshot: snapshotRun(run),
				});
			} catch (error) {
				deliveryPersisted = false;
				run.delivery = { ...run.delivery, state: "failed-to-persist", message: error.message ?? String(error), updatedAt: now() };
			} finally { await releaseInitialMetadata(); }
			this.#changed(run);
			let completionDelivery;
			let completionError;
			try {
				if (!deliveryPersisted) throw new Error("workflow completion was not queued because its durable delivery record could not be written");
				completionDelivery = await Promise.resolve(this.onComplete(snapshotRun(run), run.origin));
			} catch (error) {
				completionError = error;
			}
			const releaseFinalMetadata = await this.#acquireRunMetadata(run);
			try {
				// Delivery can advance concurrently while onComplete is queueing or even
				// sending a fast side-thread prompt. Only resolve our own still-pending
				// state; never overwrite sending/delivered/ambiguous progress.
				if (run.delivery?.state === "pending") {
					if (completionError) {
						run.delivery = {
							...run.delivery,
							state: deliveryPersisted ? "failed-to-queue" : "failed-to-persist",
							message: completionError.message ?? String(completionError),
							updatedAt: now(),
						};
					} else if (completionDelivery?.state) {
						run.delivery = { ...run.delivery, ...completionDelivery, updatedAt: now() };
					}
				}
				// The live lease is the recovery fence. Never mark execution settled or
				// archive/release that lease unless final delivery state is durable and the
				// journal has closed successfully.
				await run.journal.updateMeta({ delivery: run.delivery, snapshot: snapshotRun(run) });
				await run.journal.close();
				run.executionSettled = true;
				await this.#archiveIfSettled(run);
			} finally { await releaseFinalMetadata(); }
		}
	}

	async #executeSource(run, source, args, depth) {
		if (depth > WORKFLOW_LIMITS.maxDepth) throw new Error(`workflow nesting exceeds ${WORKFLOW_LIMITS.maxDepth}`);
		run.sandboxCount += 1;
		run.liveSandboxCount += 1;
		if (run.sandboxCount > WORKFLOW_LIMITS.maxSandboxes || run.liveSandboxCount > WORKFLOW_LIMITS.maxLiveSandboxes) {
			run.liveSandboxCount -= 1;
			const error = Object.assign(new Error("workflow exceeded its nested sandbox limit"), { code: "WORKFLOW_SANDBOX_LIMIT" });
			run.abortController.abort(error);
			for (const active of run.sandboxes) active.stop();
			throw error;
		}
		const sandbox = new WorkflowSandbox({
			source, args, tokenBudget: run.tokenBudget,
			onTerminationFailure: (error) => {
				this.sandboxTerminationFailures.push(error);
				this.#fenceTerminationFailure(error);
			},
				onEvent: (event) => {
					if (event.type === "phase") run.currentPhase = String(event.title).slice(0, 256);
					this.#recordDetached(run, event);
			},
			onRequest: (operation, payload) => this.#sandboxRequest(run, operation, payload, depth),
		});
		run.sandboxes.add(sandbox);
		const execution = sandbox.run(run.abortController.signal);
		run.sandboxExecutions.add(execution);
		try { return await execution; }
		finally {
			run.sandboxes.delete(sandbox);
			run.sandboxExecutions.delete(execution);
			run.liveSandboxCount -= 1;
		}
	}

	async #assertRunProjectIdentity(run, signal = run.abortController.signal) {
		const expected = run.projectIdentity;
		if (!expected) throw Object.assign(new Error("workflow project identity is unavailable"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
		const current = await this.registry.approvalProjectIdentity(run.origin.cwd, { signal });
		if (["canonicalRoot", "device", "inode"].some((key) => current[key] !== expected[key])) {
			throw Object.assign(new Error("Workflow project identity changed after approval; stop and launch it again from the intended project"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
		}
	}

	async #acquireRunMetadata(run) {
		const previous = run.metadataTail ?? Promise.resolve();
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		run.metadataTail = previous.catch(() => {}).then(() => held);
		await previous.catch(() => {});
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			release();
		};
	}

	async #sandboxRequest(run, operation, payload, depth) {
		if (run.abortController.signal.aborted) throw run.abortController.signal.reason ?? new Error("workflow stopped");
		run.rpcCount += 1;
		run.pendingRpcCount += 1;
		if (run.rpcCount > WORKFLOW_LIMITS.maxSandboxRequests || run.pendingRpcCount > WORKFLOW_LIMITS.maxPendingSandboxRequests) {
			run.pendingRpcCount -= 1;
			const error = Object.assign(new Error("workflow exceeded its sandbox RPC limit"), { code: "WORKFLOW_RPC_LIMIT" });
			run.abortController.abort(error);
			for (const sandbox of run.sandboxes) sandbox.stop();
			throw error;
		}
		try {
		if (operation === "budget") {
			if (payload?.query === "spent") return run.usage.tokens;
			if (payload?.query === "remaining") return run.tokenBudget === null ? null : Math.max(0, run.tokenBudget - run.usage.tokens);
			throw new Error("unknown budget query");
		}
				if (operation === "workflow") {
				if (depth >= WORKFLOW_LIMITS.maxDepth) throw new Error(`workflow nesting exceeds ${WORKFLOW_LIMITS.maxDepth}`);
				safeJson(payload?.args ?? null, "Nested workflow args", WORKFLOW_LIMITS.maxArgsBytes);
				await this.#assertRunProjectIdentity(run, run.abortController.signal);
					const saved = await this.registry.resolve(payload?.name, { requireImported: true, projectRoot: run.origin.cwd, signal: run.abortController.signal });
					if (!saved.projectIdentity || ["canonicalRoot", "device", "inode"].some((key) => saved.projectIdentity[key] !== run.projectIdentity[key])) {
						throw Object.assign(new Error("Nested workflow project identity changed after the parent launch was approved"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
					}
			await this.#record(run, { type: "nested_workflow", name: saved.name, depth: depth + 1 });
			return this.#executeSource(run, saved.source, payload?.args ?? null, depth + 1);
		}
			if (operation !== "agent") throw new Error(`unknown workflow operation: ${operation}`);
			if (typeof payload?.prompt !== "string" || !payload.prompt.trim()) throw new Error("agent prompt must be a non-empty string");
			if (Buffer.byteLength(payload.prompt, "utf8") > WORKFLOW_LIMITS.maxEventText) throw new Error(`agent prompt exceeds ${WORKFLOW_LIMITS.maxEventText} bytes`);
		if (++run.agentCount > WORKFLOW_LIMITS.maxAgents) throw new Error(`workflow exceeds ${WORKFLOW_LIMITS.maxAgents} agents`);
		if (run.tokenBudget !== null && run.usage.tokens >= run.tokenBudget) throw Object.assign(new Error("workflow token budget is exhausted"), { code: "WORKFLOW_BUDGET_EXHAUSTED" });
		let options = normalizeAgentOptions(payload.options);
		if (run.origin.workflowMode === "clone-only") {
			if (options.harness && options.harness !== run.origin.harness) throw Object.assign(new Error("Clone Only workflows cannot select a different harness"), { code: "WORKFLOW_CLONE_POLICY" });
			if (options.model && options.model !== run.origin.model.id) throw Object.assign(new Error("Clone Only workflows cannot select a different model"), { code: "WORKFLOW_CLONE_POLICY" });
			if (options.effort && options.effort !== run.origin.effort?.id) throw Object.assign(new Error("Clone Only workflows cannot select a different reasoning effort"), { code: "WORKFLOW_CLONE_POLICY" });
			if (options.agentType) throw Object.assign(new Error("Clone Only workflows cannot select a different agent profile"), { code: "WORKFLOW_CLONE_POLICY" });
			options = Object.freeze({
				...options,
				harness: run.origin.harness,
				model: run.origin.model.id,
				...(run.origin.effort?.id ? { effort: run.origin.effort.id } : {}),
			});
		}
			const number = run.agentCount;
			const selectedHarness = options.harness ?? run.origin.harness;
			const inheritsOriginModel = selectedHarness === run.origin.harness && options.model === undefined;
			const inheritsOriginEffort = selectedHarness === run.origin.harness && options.effort === undefined;
			const agent = {
				id: `${run.id}:${number}`, number, prompt: payload.prompt, options, phase: run.currentPhase,
				harness: selectedHarness,
				model: options.model ? { id: options.model, verified: false } : inheritsOriginModel ? run.origin.model : null,
				effort: options.effort ? { id: options.effort, verified: false } : inheritsOriginEffort ? run.origin.effort : null,
			status: "queued", attempt: 0, attempts: [], output: "", error: undefined, usage: null, usageQuality: "unknown", worktree: null, tools: [], restart: false, stop: false,
		};
		run.agents.set(agent.id, agent);
		await this.#record(run, { type: "agent_queued", agentId: agent.id, prompt: agent.prompt, options });
		const execution = this.#runAgent(run, agent);
		run.agentExecutions.add(execution);
		try { return await execution; }
		finally { run.agentExecutions.delete(execution); }
		} finally { run.pendingRpcCount -= 1; }
	}

	async #runAgent(run, agent) {
		while (true) {
			if (agent.stop) {
				agent.status = "stopped";
				agent.finishedAt = now();
				const error = Object.assign(new Error("Workflow agent stopped before launch"), { code: "WORKFLOW_AGENT_STOPPED" });
				agent.error = publicError(error);
				await this.#record(run, { type: "agent_failed", agentId: agent.id, attempt: agent.attempt, status: agent.status, error: agent.error });
				throw error;
			}
			if (agent.attempt >= WORKFLOW_LIMITS.maxAttemptsPerAgent) {
				throw Object.assign(new Error(`workflow agent exceeded ${WORKFLOW_LIMITS.maxAttemptsPerAgent} attempts`), { code: "WORKFLOW_ATTEMPT_LIMIT" });
			}
			const plannedAttempt = agent.attempt + 1;
			agent.restart = false;
			agent.controller = new AbortController();
			const onRunAbort = () => agent.controller.abort(run.abortController.signal.reason);
			if (run.abortController.signal.aborted) onRunAbort();
			else run.abortController.signal.addEventListener("abort", onRunAbort, { once: true });
			let attemptRecord;
			const publishAttempt = async () => {
				if (attemptRecord) return;
				if (agent.controller.signal.aborted) throw agent.controller.signal.reason;
				agent.attempt = plannedAttempt;
				agent.status = "running";
				agent.startedAt = now();
				agent.output = "";
				agent.error = undefined;
				agent.usage = null;
				agent.usageQuality = "unknown";
				agent.worktree = null;
				agent.tools = [];
				attemptRecord = {
					number: plannedAttempt, status: agent.status, model: agent.model, effort: agent.effort,
					output: "", error: undefined, usage: null, usageQuality: "unknown", worktree: null,
					startedAt: agent.startedAt, finishedAt: undefined, tools: [],
				};
				agent.attempts.push(attemptRecord);
				await this.#record(run, { type: "agent_started", agentId: agent.id, attempt: plannedAttempt, harness: agent.harness });
			};
			let usageAccounted = false;
			try {
				await this.#assertRunProjectIdentity(run, agent.controller.signal);
				if (this.executor.managesAdmission !== true) await publishAttempt();
				const result = await this.executor.execute({
					runId: run.id, agentId: agent.id, attempt: plannedAttempt, prompt: agent.prompt, options: agent.options,
					origin: run.origin, projectIdentity: run.projectIdentity, harnesses: this.harnesses, signal: agent.controller.signal,
					onAdmitted: publishAttempt,
					onEvent: (event) => this.#agentEvent(run, agent, event),
					admit: () => {
						if (run.tokenBudget !== null && run.usage.tokens >= run.tokenBudget) {
							throw Object.assign(new Error("workflow token budget is exhausted"), { code: "WORKFLOW_BUDGET_EXHAUSTED" });
						}
					},
					beforeRelease: ({ outcome, error }) => {
						const usage = outcome?.usage ?? error?.workflowUsage;
						if (usageAccounted || (!outcome && !Object.hasOwn(error ?? {}, "workflowUsage"))) return;
						accountRunUsage(
							run,
							usage,
							outcome?.usageEstimate ?? error?.workflowUsageEstimate,
							outcome?.usageComplete === true || error?.workflowUsageComplete === true,
						);
						usageAccounted = true;
					},
					onWorktreeCreated: async (worktree) => {
						if (!attemptRecord) throw new Error("workflow executor created a worktree before scheduler admission");
						agent.worktree = worktree;
						attemptRecord.worktree = worktree;
						await this.#record(run, { type: "agent_worktree", agentId: agent.id, attempt: plannedAttempt, worktree }, true);
					},
				});
				if (agent.controller.signal.aborted) throw agent.controller.signal.reason;
				if (!attemptRecord) throw new Error("workflow executor completed without scheduler admission");
				agent.status = "completed";
				agent.output = result.output;
				agent.model = result.model;
				agent.effort = result.effort;
				agent.usage = result.usage;
				agent.usageQuality = result.usageComplete === true ? "exact" : "estimated";
				agent.worktree = result.worktree;
				agent.finishedAt = now();
				Object.assign(attemptRecord, {
					status: "completed",
					model: result.model,
					effort: result.effort,
					output: result.output,
					usage: result.usage,
					usageQuality: agent.usageQuality,
					worktree: result.worktree,
					finishedAt: agent.finishedAt,
				});
				await this.#record(run, { type: "agent_completed", agentId: agent.id, attempt: agent.attempt, output: agent.output, usage: agent.usage, usageQuality: agent.usageQuality, runUsage: { ...run.usage }, worktree: agent.worktree });
				return result.value;
			} catch (error) {
				const failureHasUsage = Object.hasOwn(error ?? {}, "workflowUsage");
				const failureUsage = failureHasUsage ? error.workflowUsage : null;
				const failureOutput = Object.hasOwn(error ?? {}, "workflowOutput") ? String(error.workflowOutput ?? "").slice(-WORKFLOW_LIMITS.maxTraceBytes) : agent.output;
				if (failureHasUsage) agent.usage = failureUsage;
				agent.usageQuality = failureHasUsage ? (error?.workflowUsageComplete === true ? "exact" : "estimated") : "unknown";
				agent.output = failureOutput;
				if (!attemptRecord) {
					agent.status = agent.stop ? "stopped" : "failed";
					agent.error = publicError(error);
					agent.finishedAt = now();
					await this.#record(run, {
						type: "agent_failed", agentId: agent.id, attempt: agent.attempt, status: agent.status, error: agent.error,
						output: agent.output, usage: agent.usage, usageQuality: agent.usageQuality, runUsage: { ...run.usage }, worktree: agent.worktree,
					});
					throw error;
				}
				attemptRecord.usage = failureUsage;
				attemptRecord.usageQuality = agent.usageQuality;
				attemptRecord.output = failureOutput;
				attemptRecord.worktree = agent.worktree;
				if (agent.restart && !agent.stop && !run.abortController.signal.aborted) {
					attemptRecord.status = "restarted";
					attemptRecord.error = publicError(error);
					attemptRecord.finishedAt = now();
					await this.#record(run, {
						type: "agent_restarting", agentId: agent.id, attempt: agent.attempt,
						error: attemptRecord.error, output: attemptRecord.output, usage: attemptRecord.usage, usageQuality: attemptRecord.usageQuality, runUsage: { ...run.usage }, worktree: attemptRecord.worktree,
					});
					continue;
				}
				agent.status = agent.stop ? "stopped" : "failed";
				agent.error = publicError(error);
				agent.finishedAt = now();
				attemptRecord.status = agent.status;
				attemptRecord.error = agent.error;
				attemptRecord.finishedAt = agent.finishedAt;
				await this.#record(run, {
					type: "agent_failed", agentId: agent.id, attempt: agent.attempt, status: agent.status, error: agent.error,
					output: attemptRecord.output, usage: attemptRecord.usage, usageQuality: attemptRecord.usageQuality, runUsage: { ...run.usage }, worktree: attemptRecord.worktree,
				});
				throw error;
			} finally {
				run.abortController.signal.removeEventListener("abort", onRunAbort);
			}
		}
	}

	#agentEvent(run, agent, event) {
		const type = String(event?.type ?? "unknown").slice(0, 128);
		const cleanupCritical = type === "worktree";
		if (run.abortController.signal.aborted && !cleanupCritical) return;
		const projected = type === "text"
			? { type, text: String(event?.text ?? "") }
			: (type === "tool" || type === "tool_update")
				? { type, id: event?.id, title: event?.title, status: event?.status }
				: type === "agent_ready"
					? { type, harness: event?.harness, model: event?.model, effort: event?.effort, cwd: event?.cwd, worktree: event?.worktree }
					: type === "worktree"
						? { type, worktree: event?.worktree }
						: { type, message: event?.message, title: event?.title, status: event?.status, code: event?.code };
		const eventBytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
		if (!cleanupCritical) {
			run.hostEventCount = (run.hostEventCount ?? 0) + 1;
			run.hostEventBytes = (run.hostEventBytes ?? 0) + eventBytes;
		}
		if (!cleanupCritical && (run.hostEventCount > WORKFLOW_LIMITS.maxProjectedEvents || run.hostEventBytes > WORKFLOW_LIMITS.maxHostEventBytes)) {
			const error = Object.assign(new Error("workflow adapter emitted too much progress data"), { code: "WORKFLOW_EVENT_LIMIT" });
			run.abortController.abort(error);
			for (const sandbox of run.sandboxes) sandbox.stop();
			return;
		}
		const attempt = agent.attempts?.find((entry) => entry.number === agent.attempt);
		if (projected.type === "text") {
			agent.output = `${agent.output}${projected.text}`.slice(-WORKFLOW_LIMITS.maxTraceBytes);
			if (attempt) attempt.output = `${attempt.output}${projected.text}`.slice(-WORKFLOW_LIMITS.maxTraceBytes);
		}
		if (projected.type === "tool" || projected.type === "tool_update") {
			const tool = { type: projected.type, id: projected.id, title: projected.title, status: projected.status };
			agent.tools.push(tool);
			attempt?.tools.push(tool);
			if (agent.tools.length > WORKFLOW_LIMITS.maxRetainedTools) agent.tools.splice(0, agent.tools.length - WORKFLOW_LIMITS.maxRetainedTools);
			if (attempt?.tools.length > WORKFLOW_LIMITS.maxRetainedTools) attempt.tools.splice(0, attempt.tools.length - WORKFLOW_LIMITS.maxRetainedTools);
		}
		if (projected.type === "agent_ready") {
			agent.model = projected.model; agent.effort = projected.effort; agent.worktree = projected.worktree;
			if (attempt) { attempt.model = projected.model; attempt.effort = projected.effort; attempt.worktree = projected.worktree; }
		}
		if (projected.type === "worktree") {
			agent.worktree = projected.worktree;
			if (attempt) attempt.worktree = projected.worktree;
		}
		this.#recordDetached(run, { ...projected, type: `agent_${projected.type}`, agentId: agent.id }, projected.type === "worktree");
	}

	#recordDetached(run, event, durable = false) {
		void this.#record(run, event, durable).catch((cause) => {
			if (run.abortController.signal.aborted) return;
			const error = Object.assign(new Error(`workflow journal failed: ${cause?.message ?? cause}`), { code: "WORKFLOW_JOURNAL_FAILED", cause });
			run.abortController.abort(error);
			for (const sandbox of run.sandboxes) sandbox.stop();
		});
	}

	async #record(run, event, durable = false) {
		const wrapped = { at: now(), ...event };
		run.events.push(wrapped);
		if (run.events.length > WORKFLOW_LIMITS.maxProjectedEvents) run.events.splice(0, run.events.length - WORKFLOW_LIMITS.maxProjectedEvents);
		await run.journal.append(wrapped, { durable });
		this.#changed(run);
	}

	#changed(run) { this.onChange(snapshotRun(run)); }

	async #archiveIfSettled(run) {
		if (!run?.executionSettled || !["delivered", "origin-retired", "ambiguous", "failed-to-queue", "failed-to-persist", "not-delivered-after-restart"].includes(run.delivery?.state)) return false;
		// The live lease remains the cross-process ownership fence when any worker,
		// sandbox, or Git tree has not been confirmed gone.
		if (this.terminationFailure) return false;
		await run.journal.markArchived(run.createdAt);
		await run.releaseLease?.();
		run.releaseLease = undefined;
		const snapshot = snapshotRun(run);
		this.history.set(run.id, snapshot);
		this.historySources.set(run.id, run.source);
		this.historyOrigins.set(run.id, run.origin);
		this.runs.delete(run.id);
		const excess = [...this.history.values()]
			.filter((entry) => !snapshotHasActionableWorktree(entry))
			.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
			.slice(WORKFLOW_LIMITS.maxHistoryRuns);
		for (const entry of excess) { this.history.delete(entry.id); this.historySources.delete(entry.id); this.historyOrigins.delete(entry.id); }
		this.onChange(snapshot);
		return true;
	}

	list() {
		const live = [...this.runs.values()].map(snapshotRun);
		const archived = [...this.history.values()].filter((entry) => !this.runs.has(entry.id));
		return [...live, ...archived].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
	}
	get(id) { const run = this.runs.get(id); return run ? snapshotRun(run) : this.history.get(id); }
	getSource(id) { return this.runs.get(id)?.source ?? this.historySources.get(id); }
	async recover(id, origin, options = {}) {
		const archived = this.history.get(id);
		if (!archived || archived.status !== "interrupted") throw new Error("Only an interrupted persisted workflow can be recovered");
		const source = this.historySources.get(id);
		if (!source) throw new Error("The interrupted workflow source is unavailable");
		return this.start({
			script: source,
			args: archived.args ?? null,
			tokenBudget: archived.tokenBudget ?? null,
			maxConcurrency: archived.requestedConcurrency ?? archived.maxConcurrency,
		}, origin, { recoveryOf: id, signal: options.signal });
	}

	async markDelivery(id, state, fields = {}) {
		const run = this.runs.get(id);
		if (!run) return false;
		const release = await this.#acquireRunMetadata(run);
		try {
			if (this.runs.get(id) !== run) return false;
			const { confirmedNotSent = false, ...deliveryFields } = fields;
			// A generic retirement must never overwrite `sending`: at that point a
			// backend may already have consumed the prompt, so only delivered or
			// ambiguous is safe. The two pre-send revalidation sites opt in after
			// proving the exact target changed before prompt() was called.
			if (run.delivery?.state === "sending" && state === "origin-retired" && confirmedNotSent !== true) return false;
			if (["delivered", "ambiguous"].includes(run.delivery?.state) && state !== run.delivery.state) return false;
			const delivery = { ...run.delivery, state, ...deliveryFields, updatedAt: now() };
			await run.journal.updateMeta({ delivery, snapshot: { ...snapshotRun(run), delivery } });
			run.delivery = delivery;
			this.#changed(run);
			await this.#archiveIfSettled(run);
			return true;
		} finally { await release(); }
	}
	async save(id, scope = "personal", options = {}) {
		const run = this.runs.get(id);
		const archived = run ? undefined : this.history.get(id);
		const source = run?.source ?? this.historySources.get(id);
		if (!source || (!run && !archived)) throw new Error("Only workflows retained by this cc process can be saved");
		return this.registry.save(run?.saveName ?? archived.saveName ?? workflowSaveName(run?.meta.name ?? archived.name), source, {
			scope, overwrite: options.overwrite === true,
			projectRoot: options.projectRoot ?? run?.origin.cwd ?? archived.origin?.cwd,
		});
	}

	async #withWorktreeOperation(options, operation) {
		if (this.stopping) throw Object.assign(new Error("Dynamic workflow manager is stopping"), { code: "WORKFLOW_STOPPING" });
		const controller = new AbortController();
		const abortExternal = () => controller.abort(options?.signal?.reason ?? Object.assign(new Error("Workflow worktree operation cancelled"), { code: "WORKFLOW_WORKTREE_CANCELLED" }));
		if (options?.signal?.aborted) abortExternal();
		else options?.signal?.addEventListener("abort", abortExternal, { once: true });
		const deadline = Date.now() + WORKFLOW_LIMITS.gitOperationTimeoutMs;
		const timer = setTimeout(() => controller.abort(Object.assign(new Error("Workflow worktree operation timed out"), { code: "WORKFLOW_GIT_TIMEOUT" })), WORKFLOW_LIMITS.gitOperationTimeoutMs);
		timer.unref?.();
		const task = Promise.resolve().then(() => operation(controller.signal, deadline));
		const tracked = { controller, settled: task.then(() => undefined, () => undefined) };
		this.worktreeOperations.add(tracked);
		try { return await task; }
		finally {
			clearTimeout(timer);
			options?.signal?.removeEventListener("abort", abortExternal);
			this.worktreeOperations.delete(tracked);
		}
	}

	abortWorktreeOperations(reason = Object.assign(new Error("Workflow worktree operation cancelled during shutdown"), { code: "WORKFLOW_STOPPING" })) {
		for (const operation of this.worktreeOperations) operation.controller.abort(reason);
	}

	async previewWorktree(runId, agentId, attemptNumber = undefined, options = {}) {
		const run = this.get(runId);
		const agent = run?.agents.find((entry) => entry.id === agentId);
		const attempt = attemptNumber === undefined ? undefined : agent?.attempts?.find((entry) => entry.number === attemptNumber);
		const worktree = attempt?.worktree ?? agent?.worktree;
		if (!worktree?.retained) throw new Error("This attempt has no retained worktree changes");
		if (worktree.applyState === "unconfirmed") throw new Error("A previous apply may have modified the target but did not finish journaling; inspect the target manually before proceeding");
		return this.#withWorktreeOperation(options, (signal, deadline) => this.worktrees.diff(worktree, { signal, deadline }));
	}

	async applyWorktree(runId, agentId, options = {}) {
		const liveRun = this.runs.get(runId);
		const archivedRun = liveRun ? undefined : this.history.get(runId);
		if (!liveRun && archivedRun) return this.#applyArchivedWorktree(runId, agentId, options);
		if (!liveRun) throw new Error(`unknown workflow task: ${runId}`);
		// Hold the same metadata fence used by delivery finalization and archival for
		// the complete apply transaction. The run cannot move into history with a stale
		// snapshot while an apply is publishing its unconfirmed/confirmed boundaries.
		const releaseMetadata = await this.#acquireRunMetadata(liveRun);
		try {
			if (this.runs.get(runId) !== liveRun) return await this.#applyArchivedWorktree(runId, agentId, options);
			return await this.#applyLiveWorktree(liveRun, agentId, options);
		} finally { await releaseMetadata(); }
	}

	async #applyLiveWorktree(liveRun, agentId, options) {
		const agent = liveRun.agents.get(agentId);
		const attemptNumber = options.attempt ?? agent?.attempt;
		const attempt = agent?.attempts?.find((entry) => entry.number === attemptNumber);
		const worktree = attempt?.worktree ?? (agent?.attempt === attemptNumber ? agent?.worktree : undefined);
		if (!worktree?.retained) throw new Error("This attempt has no retained worktree changes");
		if (worktree.appliedAt) throw new Error("These worktree changes were already applied by cc");
		if (worktree.applyState === "unconfirmed") throw new Error("A previous apply may have modified the target but did not finish journaling; inspect the target manually before proceeding");
		let applyingWorktree;
		const applied = await this.#withWorktreeOperation(options, (signal, deadline) => this.executor.withRepositoryMutation(
			worktree.repository,
			signal,
			() => this.worktrees.apply(worktree, {
				expectedTarget: options.expectedTarget, signal, deadline,
				onValidated: async () => {
					applyingWorktree = { ...worktree, applyState: "unconfirmed", applyStartedAt: now() };
					if (attempt) attempt.worktree = applyingWorktree;
					if (agent.attempt === attemptNumber) agent.worktree = applyingWorktree;
					if (["pending", "running", "paused", "stopping"].includes(liveRun.status)) {
						await this.#record(liveRun, { type: "worktree_apply_started", agentId, attempt: attemptNumber, worktree: applyingWorktree }, true);
					} else {
						await liveRun.journal.updateMeta({ snapshot: snapshotRun(liveRun) });
						this.#changed(liveRun);
					}
				},
				onValidationInvalidated: async () => {
					if (attempt) attempt.worktree = worktree;
					if (agent.attempt === attemptNumber) agent.worktree = worktree;
					if (["pending", "running", "paused", "stopping"].includes(liveRun.status)) {
						await this.#record(liveRun, { type: "worktree_apply_cancelled", agentId, attempt: attemptNumber, worktree }, true);
					} else {
						await liveRun.journal.updateMeta({ snapshot: snapshotRun(liveRun) });
						this.#changed(liveRun);
					}
					applyingWorktree = undefined;
				},
			}),
		));
		if (!applyingWorktree) throw new Error("workflow worktree apply skipped its durable validation boundary");
		const { applyState: _applyState, applyStartedAt: _applyStartedAt, ...confirmedWorktree } = applyingWorktree;
		const appliedWorktree = { ...confirmedWorktree, appliedAt: applied.appliedAt };
		if (liveRun) {
			if (attempt) attempt.worktree = appliedWorktree;
			if (agent.attempt === attemptNumber) agent.worktree = appliedWorktree;
			if (["pending", "running", "paused", "stopping"].includes(liveRun.status)) {
				await this.#record(liveRun, { type: "worktree_applied", agentId, attempt: attemptNumber, worktree: appliedWorktree }, true);
			} else {
				await liveRun.journal.updateMeta({ snapshot: snapshotRun(liveRun) });
				this.#changed(liveRun);
			}
		}
		const cleanup = await this.#withWorktreeOperation(options, (signal, deadline) => this.executor.withRepositoryMutation(
			appliedWorktree.repository,
			signal,
			() => this.worktrees.finalizeApplied(appliedWorktree, applied.appliedAt, { signal, deadline }),
		)).catch((error) => {
			if (isUnconfirmedGitTreeFailure(error)) throw error;
			return { removed: false, warning: error.message ?? String(error) };
		});
		return { stat: applied.stat, bytes: applied.bytes, appliedAt: applied.appliedAt, ...(cleanup.warning ? { cleanupWarning: cleanup.warning } : {}) };
	}

	async #applyArchivedWorktree(runId, agentId, options = {}) {
		const root = path.join(this.stateRoot, "workflow-runs");
		const directory = path.join(root, runId);
		const release = await acquireOwnershipLock(path.join(directory, ".archive-update.lock"), {
			timeoutMs: WORKFLOW_LIMITS.gitTimeoutMs,
			signal: options.signal,
		});
		try {
			let persistedMeta;
			try { persistedMeta = (await readWorkflowJournalMeta(directory)).meta; }
			catch { /* a marker-only/corrupt-journal recovery may have only the in-memory projection */ }
			const recoveredRun = this.history.get(runId);
			const persistedRun = persistedMeta?.snapshot;
			const worktreeFrom = (snapshot) => {
				const candidateAgent = snapshot?.agents?.find((entry) => entry.id === agentId);
				const candidateAttemptNumber = options.attempt ?? candidateAgent?.attempt;
				const candidateAttempt = candidateAgent?.attempts?.find((entry) => entry.number === candidateAttemptNumber);
				return candidateAttempt?.worktree ?? (candidateAgent?.attempt === candidateAttemptNumber ? candidateAgent?.worktree : undefined);
			};
			// The bounded persisted snapshot remains authoritative whenever it knows
			// this worktree. A startup-reconciled orphan exists only in the in-memory
			// projection until the pre-mutation durable boundary below.
			const archivedRun = worktreeFrom(persistedRun) ? persistedRun : recoveredRun ?? persistedRun;
			if (!archivedRun || archivedRun.id !== runId || !Array.isArray(archivedRun.agents)) {
				throw new Error("The archived workflow journal has no usable snapshot");
			}
			const agent = archivedRun.agents.find((entry) => entry.id === agentId);
			const attemptNumber = options.attempt ?? agent?.attempt;
			const attempt = agent?.attempts?.find((entry) => entry.number === attemptNumber);
			const worktree = attempt?.worktree ?? (agent?.attempt === attemptNumber ? agent?.worktree : undefined);
			if (!worktree?.retained) throw new Error("This attempt has no retained worktree changes");
			if (worktree.appliedAt) throw new Error("These worktree changes were already applied by cc");
			if (worktree.applyState === "unconfirmed") throw new Error("A previous apply may have modified the target but did not finish journaling; inspect the target manually before proceeding");
			const journal = new WorkflowJournal(root, runId);
			let metadataReadable = Boolean(persistedMeta);
			const persistSnapshot = async (snapshot) => {
				if (metadataReadable) {
					await journal.updateMeta({ snapshot });
					return;
				}
				await journal.replaceMetaForRecovery({
					status: snapshot.status,
					createdAt: snapshot.createdAt,
					...(this.historySources.has(runId) ? { source: this.historySources.get(runId) } : {}),
					...(this.historyOrigins.has(runId) ? { origin: this.historyOrigins.get(runId) } : {}),
					snapshot,
				});
				metadataReadable = true;
			};
			let applyingWorktree;
			let applyingSnapshot;
			const applied = await this.#withWorktreeOperation(options, (signal, deadline) => this.executor.withRepositoryMutation(
				worktree.repository,
				signal,
				() => this.worktrees.apply(worktree, {
					expectedTarget: options.expectedTarget, signal, deadline,
					onValidated: async () => {
						applyingWorktree = { ...worktree, applyState: "unconfirmed", applyStartedAt: now() };
						applyingSnapshot = snapshotWithUpdatedWorktree(archivedRun, agentId, attemptNumber, applyingWorktree);
						await persistSnapshot(applyingSnapshot);
						this.history.set(runId, applyingSnapshot);
						this.onChange(applyingSnapshot);
					},
					onValidationInvalidated: async () => {
						const restored = snapshotWithUpdatedWorktree(applyingSnapshot, agentId, attemptNumber, worktree);
						await persistSnapshot(restored);
						this.history.set(runId, restored);
						this.onChange(restored);
						applyingWorktree = undefined;
						applyingSnapshot = undefined;
					},
				}),
			));
			if (!applyingWorktree || !applyingSnapshot) throw new Error("workflow worktree apply skipped its durable validation boundary");
			const { applyState: _applyState, applyStartedAt: _applyStartedAt, ...confirmedWorktree } = applyingWorktree;
			const appliedWorktree = { ...confirmedWorktree, appliedAt: applied.appliedAt };
			const snapshot = snapshotWithUpdatedWorktree(applyingSnapshot, agentId, attemptNumber, appliedWorktree);
			await persistSnapshot(snapshot);
			this.history.set(runId, snapshot);
			this.onChange(snapshot);
			const cleanup = await this.#withWorktreeOperation(options, (signal, deadline) => this.executor.withRepositoryMutation(
				appliedWorktree.repository,
				signal,
				() => this.worktrees.finalizeApplied(appliedWorktree, applied.appliedAt, { signal, deadline }),
			)).catch((error) => {
				if (isUnconfirmedGitTreeFailure(error)) throw error;
				return { removed: false, warning: error.message ?? String(error) };
			});
			return { stat: applied.stat, bytes: applied.bytes, appliedAt: applied.appliedAt, ...(cleanup.warning ? { cleanupWarning: cleanup.warning } : {}) };
		} finally { await release(); }
	}

	status(id, action = "status", requester = undefined) {
		const run = this.runs.get(id);
		const archived = run ? undefined : this.history.get(id);
		if (!run && !archived) throw new Error(`unknown workflow task: ${id}`);
		const owner = run?.origin ?? this.historyOrigins.get(id);
		if (requester && (
			!Object.is(requester.sessionId, owner?.sessionId) ||
			requester.generation !== owner?.generation ||
			requester.thread !== owner?.thread
		)) throw Object.assign(new Error("workflow task belongs to a different origin session"), { code: "WORKFLOW_ORIGIN_MISMATCH" });
		if (!run) {
			if (action !== "status") throw new Error(`a ${archived.status} workflow cannot be ${action}d`);
			return archived;
		}
		if (action === "pause") {
			if (run.status !== "running") throw new Error("only a running workflow can be paused");
			run.status = "paused"; this.scheduler.pause(id); this.#recordDetached(run, { type: "run_paused" }, true);
		} else if (action === "resume") {
			if (run.status !== "paused") throw new Error("only a paused workflow can be resumed");
			run.status = "running"; this.scheduler.resume(id); this.#recordDetached(run, { type: "run_resumed" }, true);
		} else if (action === "stop") {
			const stopping = this.stop(id);
			if (stopping && typeof stopping.then === "function") return stopping.then(() => snapshotRun(run));
		}
		else if (action !== "status") throw new Error(`unknown workflow action: ${action}`);
		return snapshotRun(run);
	}

	isStartCommitted(id) {
		const run = this.runs.get(id);
		if (run) return run.responseAcceptanceState === "committed" && Boolean(run.execution);
		return this.history.has(id);
	}

	isStartCommitAmbiguous(id) {
		return this.runs.get(id)?.responseAcceptanceState === "commit-ambiguous";
	}

	stop(id) {
		const run = this.runs.get(id);
		if (!run || run.completionCommitted || !["pending", "running", "paused"].includes(run.status)) return false;
		if (run.responseAcceptanceState === "commit-ambiguous") {
			this.#requireRestart(run.commitAmbiguousError);
			return false;
		}
		if (!run.execution) {
			if (["awaiting", "accepted", "committing", "published", "commit-cancelled"].includes(run.responseAcceptanceState)) {
				void this.rollbackStart(id).catch((error) => this.#requireRestart(error));
				return true;
			}
			// A rolled-back launch with failed durable cleanup owns no execution and
			// has already closed its journal. Shutdown retries that cleanup directly;
			// it must never append an ordinary run-stop record to the retired handle.
			return false;
		}
		run.status = "stopping";
		for (const agent of run.agents.values()) {
			if (!["completed", "failed", "stopped"].includes(agent.status)) {
				agent.stop = true;
				agent.restart = false;
				agent.status = "stopping";
				const attempt = agent.attempts?.find((entry) => entry.number === agent.attempt);
				if (attempt && !["completed", "failed", "stopped", "restarted"].includes(attempt.status)) attempt.status = "stopping";
			}
		}
		run.abortController.abort(Object.assign(new Error("Workflow stopped"), { code: "WORKFLOW_STOPPED" }));
		for (const sandbox of run.sandboxes) sandbox.stop();
		this.scheduler.cancelRun(id, "Workflow stopped");
		this.#changed(run);
		const persistStop = (async () => {
			// Final delivery metadata and journal closure use the same lock. Joining
			// that queue makes a synchronously accepted stop durable before close,
			// including the narrow race after execution settles but before its final
			// status is projected.
			const releaseMetadata = await this.#acquireRunMetadata(run);
			try { await this.#record(run, { type: "run_stop_requested", status: "stopped" }, true); }
			finally { await releaseMetadata(); }
			return true;
		})();
		return persistStop.then(
			() => true,
			(error) => {
				this.#requireRestart(error);
				throw error;
			},
		);
	}

	restartAgent(runId, agentId) {
		const run = this.runs.get(runId);
		const agent = run?.agents.get(agentId);
		if (!agent || agent.status !== "running" || agent.attempt >= WORKFLOW_LIMITS.maxAttemptsPerAgent) return false;
		agent.restart = true;
		agent.status = "restarting";
		agent.controller.abort(Object.assign(new Error("Agent restarting"), { code: "WORKFLOW_AGENT_RESTART" }));
		this.#changed(run);
		return true;
	}

	stopAgent(runId, agentId) {
		const run = this.runs.get(runId);
		const agent = run?.agents.get(agentId);
		if (!agent || !["queued", "running", "restarting"].includes(agent.status)) return false;
		agent.stop = true;
		agent.restart = false;
		agent.status = "stopping";
		const attempt = agent.attempts?.find((entry) => entry.number === agent.attempt);
		if (attempt && !["completed", "failed", "stopped", "restarted"].includes(attempt.status)) attempt.status = "stopping";
		agent.controller?.abort(Object.assign(new Error("Agent stopped"), { code: "WORKFLOW_AGENT_STOPPED" }));
		this.#changed(run);
		return true;
	}

	async stopAll(options = {}) {
		this.stopping = true;
		const worktreeOperations = [...this.worktreeOperations];
		this.abortWorktreeOperations();
		const pendingApprovals = [...this.pendingApprovals];
		for (const pending of pendingApprovals) pending.controller.abort(Object.assign(new Error("Workflow launch cancelled during shutdown"), { code: "WORKFLOW_STOPPING" }));
		const unacceptedRuns = [...this.runs.values()].filter((run) => ["awaiting", "accepted", "committing", "published", "commit-cancelled", "commit-ambiguous"].includes(run.responseAcceptanceState) && !run.execution);
		const unacceptedRollbacks = await Promise.allSettled(unacceptedRuns.map((run) => this.rollbackStart(run.id)));
		const stopRequests = [...this.runs.values()].map((run) => Promise.resolve(this.stop(run.id)));
		// Attach rejection handlers before awaiting rollback/pending-start phases;
		// a fast durable stop failure must remain part of the final aggregate rather
		// than becoming a temporarily unhandled rejection.
		const stopRequestSettlement = Promise.allSettled(stopRequests);
		await Promise.allSettled(pendingApprovals.map((pending) => pending.settled));
		while (this.pendingStarts > 0) await new Promise((resolve) => setTimeout(resolve, 20));
		const failedStartCleanupRuns = [...this.failedStartCleanups];
		const failedStartCleanupResults = await Promise.allSettled(failedStartCleanupRuns.map((run) => this.#cleanupUncommittedRun(run)));
		for (let index = 0; index < failedStartCleanupResults.length; index += 1) {
			const run = failedStartCleanupRuns[index];
			if (failedStartCleanupResults[index].status === "fulfilled" && !run.execution && run.responseAcceptanceState === "rolled-back") {
				this.scheduler.closeRun(run.id);
				if (this.runs.get(run.id) === run) this.runs.delete(run.id);
			}
		}
		const settlingRuns = [...this.runs.values()].filter((run) =>
			run.responseAcceptanceState !== "commit-ambiguous" && Boolean(run.execution));
		const runSettlements = await Promise.allSettled(settlingRuns.map(async (run) => {
			while (!RUN_STATES.slice(4).includes(run.status)) await new Promise((resolve) => setTimeout(resolve, 20));
			await run.execution;
		}));
		const stopRequestResults = await stopRequestSettlement;
		await Promise.allSettled(worktreeOperations.map((operation) => operation.settled));
		// Archiving may itself discover a transient lease-release failure. Alternate
		// archive and global release retries until an entire pass is clean, and only
		// report the final unresolved state rather than stale earlier failures.
		let archiveRetryResults = [];
		let releaseRetryResults = [];
		for (let attempt = 0; attempt < 3; attempt += 1) {
			archiveRetryResults = await Promise.allSettled([...this.runs.values()].map((run) => this.#archiveIfSettled(run)));
			releaseRetryResults = await Promise.allSettled([
				Promise.resolve().then(() => this.executor.retryMutationReleases?.()),
				Promise.resolve().then(() => retryOwnershipLockReleases()),
			]);
			if (archiveRetryResults.every((result) => result.status === "fulfilled" && (options.requireArchived === false || result.value !== false)) &&
				releaseRetryResults.every((result) => result.status === "fulfilled")) break;
		}
		const convergenceErrors = releaseRetryResults.filter((result) => result.status === "rejected").map((result) => result.reason);
		try { this.executor.assertTerminationConfirmed?.(); }
		catch (error) { convergenceErrors.push(error); }
		convergenceErrors.push(...this.sandboxTerminationFailures);
		const failedStartCleanupErrors = unacceptedRollbacks
			.flatMap((result, index) => result.status === "rejected" && (
				this.failedStartCleanups.has(unacceptedRuns[index]) ||
				unacceptedRuns[index]?.responseAcceptanceState === "commit-ambiguous"
			) ? [result.reason] : [])
			.concat(failedStartCleanupResults.filter((result) => result.status === "rejected").map((result) => result.reason));
		const archiveRetryErrors = archiveRetryResults.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (options.requireArchived !== false && this.runs.size > 0) {
			archiveRetryErrors.push(new Error(`workflow shutdown retained ${this.runs.size} unarchived run(s) after delivery convergence`));
		}
		const failures = failedStartCleanupErrors.concat(runSettlements
			.flatMap((result, index) => result.status === "rejected" && this.runs.has(settlingRuns[index].id) ? [result.reason] : [])
			.concat(stopRequestResults.filter((result) => result.status === "rejected").map((result) => result.reason), archiveRetryErrors, convergenceErrors));
		if (failures.length > 0) {
			if (failedStartCleanupErrors.length > 0) {
				throw Object.assign(new AggregateError(failures, "workflow shutdown could not clean failed launch state or complete every concurrent shutdown phase"), {
					code: "WORKFLOW_START_CLEANUP_INCOMPLETE",
				});
			}
			const convergenceOnly = archiveRetryErrors.length === 0 && runSettlements.every((result) => result.status === "fulfilled") && stopRequestResults.every((result) => result.status === "fulfilled");
			const shutdownMessage = convergenceOnly
				? "workflow shutdown could not be confirmed stopped or release every ownership fence"
				: convergenceErrors.length > 0
					? "workflow shutdown left one or more unarchived runs and one or more process trees or ownership fences could not be confirmed stopped"
					: "workflow shutdown left one or more unarchived runs after delivery convergence";
			throw Object.assign(new AggregateError(failures, shutdownMessage), {
				code: "WORKFLOW_ARCHIVE_INCOMPLETE",
			});
		}
	}
}
