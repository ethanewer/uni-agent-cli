import { extractWorkflowJson, validateWorkflowSchemaBounded } from "./schema.mjs";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { acquireOwnershipLock, workflowRepositoryLockRoot } from "./ownership-lock.mjs";
import { boundedWorkflowText, normalizeAgentOptions, safeJson, WORKFLOW_LIMITS } from "./types.mjs";

const WORKFLOW_SUPERVISOR_STOP_WAIT_MS = 7_500;

function abortError(reason = "Agent stopped") {
	if (reason instanceof Error) return reason;
	const error = new Error(String(reason));
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal) {
	if (signal?.aborted) throw abortError(signal.reason);
}

async function assertApprovedProjectIdentity(identity, signal) {
	throwIfAborted(signal);
	if (!identity || typeof identity.canonicalRoot !== "string") {
		throw Object.assign(new Error("workflow project identity is unavailable"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
	}
	const root = path.resolve(identity.canonicalRoot);
	const flags = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0);
	let handle;
	try {
		handle = await fs.open(root, flags);
		const [stat, canonical] = await Promise.all([handle.stat({ bigint: true }), fs.realpath(root)]);
		if (!stat.isDirectory() || canonical !== root || String(stat.dev) !== String(identity.device) || String(stat.ino) !== String(identity.inode)) {
			throw new Error("identity mismatch");
		}
		throwIfAborted(signal);
		return root;
	} catch (error) {
		if (error?.code === "WORKFLOW_PROJECT_IDENTITY_CHANGED") throw error;
		throw Object.assign(new Error("Workflow project identity changed after approval; stop and launch it again from the intended project"), {
			code: "WORKFLOW_PROJECT_IDENTITY_CHANGED", cause: error,
		});
	} finally { await handle?.close(); }
}

function isUnconfirmedGitTreeFailure(error) {
	return error?.code === "WORKFLOW_GIT_TREE_TERMINATION_FAILED" || error?.code === "WORKFLOW_GIT_TREE_TRACKING_FAILED";
}

function workflowConfigOption(sessionInfo, category) {
	const options = sessionInfo?.configOptions ?? sessionInfo?.sessionInfo?.configOptions;
	return Array.isArray(options) ? options.find((option) => option?.category === category || option?.id === category) : undefined;
}

function workflowCapabilities(adapter, harness) {
	if (typeof adapter.getWorkflowCapabilities !== "function") {
		throw new Error(`harness ${harness} does not implement the optional workflow worker contract`);
	}
	const capabilities = adapter.getWorkflowCapabilities();
	if (!capabilities || typeof capabilities !== "object") {
		throw new Error(`harness ${harness} returned invalid workflow capabilities`);
	}
	for (const key of ["childCwd", "modelOverride", "modelVerification", "usage", "mcpLaunch", "terminalLaunch", "enforcedReadOnly", "agentProfiles"]) {
		if (Object.hasOwn(capabilities, key) && typeof capabilities[key] !== "boolean") {
			throw new Error(`harness ${harness} returned a non-boolean workflow capability: ${key}`);
		}
	}
	return capabilities;
}

function boundedEventValue(value, depth = 0) {
	if (typeof value === "string") return boundedWorkflowText(value);
	if (value === null || typeof value === "number" || typeof value === "boolean") return value;
	if (depth >= 8) return "[… nested value truncated …]";
	if (Array.isArray(value)) return value.slice(0, 1000).map((entry) => boundedEventValue(entry, depth + 1));
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).slice(0, 256).map(([key, entry]) => [
			boundedWorkflowText(key, 256),
			boundedEventValue(entry, depth + 1),
		]));
	}
	return String(value);
}

function boundedAdapterEvent(event) {
	const bounded = boundedEventValue(event);
	try {
		safeJson(bounded, "workflow adapter event", WORKFLOW_LIMITS.maxRpcBytes);
		return bounded;
	} catch {
		return {
			type: typeof event?.type === "string" ? boundedWorkflowText(event.type, 256) : "unknown",
			text: "[… adapter event exceeded the workflow event bound …]",
			truncated: true,
		};
	}
}

function saturatedByteAdd(total, increment) {
	if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(increment) || increment < 0 || total > Number.MAX_SAFE_INTEGER - increment) {
		return { value: Number.MAX_SAFE_INTEGER, overflowed: true };
	}
	return { value: total + increment, overflowed: false };
}

function conservativeUsageEstimate(exchanges) {
	let tokens = 0;
	let inputBytes = 0;
	let outputBytes = 0;
	let overflowed = false;
	for (const exchange of exchanges) {
		const inputTotal = saturatedByteAdd(inputBytes, exchange.inputBytes);
		inputBytes = inputTotal.value;
		const outputTotal = saturatedByteAdd(outputBytes, exchange.outputBytes);
		outputBytes = outputTotal.value;
		const visible = saturatedByteAdd(exchange.inputBytes, exchange.outputBytes);
		const charge = saturatedByteAdd(visible.value, WORKFLOW_LIMITS.unknownUsageOverheadPerRequest);
		const tokenTotal = saturatedByteAdd(tokens, charge.value);
		tokens = tokenTotal.value;
		overflowed ||= Boolean(exchange.overflowed || inputTotal.overflowed || outputTotal.overflowed || visible.overflowed || charge.overflowed || tokenTotal.overflowed);
	}
	return Object.freeze({
		tokens,
		requestCount: exchanges.length,
		inputBytes,
		outputBytes,
		overflowed,
		method: "utf8-bytes-plus-backend-overhead",
	});
}

function completeUsageTokens(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	for (const key of ["totalTokens", "total_tokens"]) {
		if (!Object.hasOwn(usage, key)) continue;
		const value = usage[key];
		if (Number.isSafeInteger(value) && value >= 0) return { tokens: value, overflowed: false };
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return { tokens: Number.MAX_SAFE_INTEGER, overflowed: true };
		}
		return undefined;
	}
	const inputKey = Object.hasOwn(usage, "inputTokens") ? "inputTokens"
		: Object.hasOwn(usage, "input_tokens") ? "input_tokens" : undefined;
	const outputKey = Object.hasOwn(usage, "outputTokens") ? "outputTokens"
		: Object.hasOwn(usage, "output_tokens") ? "output_tokens" : undefined;
	if (!inputKey || !outputKey) return undefined;
	const cacheKey = Object.hasOwn(usage, "cacheReadTokens") ? "cacheReadTokens"
		: Object.hasOwn(usage, "cache_read_tokens") ? "cache_read_tokens" : undefined;
	const values = [usage[inputKey], usage[outputKey], ...(cacheKey ? [usage[cacheKey]] : [])];
	if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
		const allFinite = values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0);
		if (allFinite) {
			return { tokens: Number.MAX_SAFE_INTEGER, overflowed: true };
		}
		return undefined;
	}
	let tokens = 0;
	let overflowed = false;
	for (const value of values) {
		const total = saturatedByteAdd(tokens, value);
		tokens = total.value;
		overflowed ||= total.overflowed;
	}
	return { tokens, overflowed };
}

function aggregateUsage(exchanges, finalSessionUsage) {
	let tokens = 0;
	let overflowed = false;
	let complete = exchanges.length > 0;
	for (const exchange of exchanges) {
		const measured = completeUsageTokens(exchange.usage);
		if (!measured) { complete = false; break; }
		const total = saturatedByteAdd(tokens, measured.tokens);
		tokens = total.value;
		overflowed ||= measured.overflowed || total.overflowed;
	}
	// cc normalizes session/prompt usage as turn-level accounting. A single fresh
	// turn may fall back to the final session snapshot; after corrections that
	// snapshot contains only the latest turn and cannot reconstruct missing turns.
	if (!complete && exchanges.length === 1 && exchanges[0].usage == null) {
		const measured = completeUsageTokens(finalSessionUsage);
		if (measured) return {
			usage: { totalTokens: measured.tokens, ...(measured.overflowed ? { overflowed: true } : {}) },
			complete: true,
		};
	}
	if (complete) return { usage: { totalTokens: tokens, ...(overflowed ? { overflowed: true } : {}) }, complete: true };
	return { usage: finalSessionUsage ?? null, complete: false };
}

async function applyWorkflowEffort(adapter, harness, requested) {
	const before = workflowConfigOption(adapter.getSessionInfo(), "thought_level");
	if (!requested) return before?.currentValue ? { id: before.currentValue, verified: true } : null;
	if (before?.currentValue === requested) return { id: requested, verified: true };
	if (!before || typeof adapter.setConfigOption !== "function") {
		throw new Error(`harness ${harness} cannot apply an explicit workflow reasoning effort`);
	}
	await adapter.setConfigOption(before.id ?? "thought_level", requested, before.type);
	const after = workflowConfigOption(adapter.getSessionInfo(), "thought_level");
	if (after?.currentValue !== requested) throw new Error(`harness ${harness} could not verify workflow reasoning effort ${requested}`);
	return { id: requested, verified: true };
}

async function awaitAbortable(promise, signal) {
	throwIfAborted(signal);
	let onAbort;
	const stopped = new Promise((_, reject) => {
		onAbort = () => reject(abortError(signal.reason));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try { return await Promise.race([promise, stopped]); }
	finally { signal.removeEventListener("abort", onAbort); }
}

function withTimeout(signal, timeoutMs) {
	const controller = new AbortController();
	const onAbort = () => controller.abort(signal.reason ?? abortError());
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => controller.abort(Object.assign(new Error("Workflow agent timed out"), { code: "WORKFLOW_AGENT_TIMEOUT" })), timeoutMs);
	timer.unref?.();
	return {
		signal: controller.signal,
		close: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); },
	};
}

export class AdapterWorkflowExecutor {
	constructor(options) {
		this.createAdapter = options.createAdapter;
		this.scheduler = options.scheduler;
		this.worktrees = options.worktrees;
		this.onAdapterStart = options.onAdapterStart ?? (() => {});
		this.onAdapterStop = options.onAdapterStop ?? (() => {});
		this.onTerminationFailure = options.onTerminationFailure ?? (() => {});
		this.onRestartRequired = options.onRestartRequired ?? this.onTerminationFailure;
		this.mutationTails = new Map();
		this.failedMutationReleases = new Set();
		this.retainedMutationFences = new Set();
		this.terminationFailures = [];
		this.managesAdmission = true;
	}

	recordTerminationFailure(error) {
		if (this.terminationFailures.includes(error)) return;
		this.terminationFailures.push(error);
		this.onTerminationFailure(error);
	}

	assertTerminationConfirmed() {
		if (this.terminationFailures.length === 0) return;
		throw new AggregateError(
			[...this.terminationFailures],
			"one or more workflow worker process trees could not be confirmed stopped",
		);
	}

	async retryMutationReleases() {
		const results = await Promise.allSettled([...this.failedMutationReleases].map((release) => release()));
		const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
		if (failures.length > 0) throw new AggregateError(failures, "one or more workflow repository mutation locks could not be released");
	}

	async execute(call) {
		if (process.platform === "win32") {
			throw Object.assign(new Error("Dynamic workflows currently require macOS or Linux"), { code: "WORKFLOW_PLATFORM_UNSUPPORTED" });
		}
		const options = normalizeAgentOptions(call.options);
		const harness = options.harness ?? call.origin.harness;
		if (!call.harnesses[harness]) throw new Error(`Unknown workflow harness: ${harness}`);
		if (options.readOnly) {
			const probe = this.createAdapter({
				harness,
				agentConfig: call.harnesses[harness],
				onEvent: () => {},
				isCurrent: () => false,
				runId: call.runId,
				agentId: call.agentId,
			});
			if (!workflowCapabilities(probe, harness).enforcedReadOnly) {
				throw new Error(`harness ${harness} cannot enforce workflow read-only mode`);
			}
		}
		const releaseSchedule = await this.scheduler.acquire({ runId: call.runId, harness, signal: call.signal });
		const timeout = withTimeout(call.signal, WORKFLOW_LIMITS.defaultAgentTimeoutMs);
		const terminationFailureCount = this.terminationFailures.length;
		let releaseMutation;
		let worktree;
		let outcome;
		let failure;
		try {
			await awaitAbortable(Promise.resolve().then(() => call.onAdmitted?.()), timeout.signal);
			// Schema compilation is off-thread but still consumes memory and a worker.
			// Keep it behind the same global/run/harness admission as the agent so a
			// parallel graph cannot bypass scheduler bounds with validator workers.
			if (Object.hasOwn(options, "schema")) {
				await validateWorkflowSchemaBounded(options.schema, null, { signal: timeout.signal });
			}
			call.admit?.();
			let cwd = await assertApprovedProjectIdentity(call.projectIdentity, timeout.signal);
			if (options.isolation === "worktree") {
				// `git worktree add` mutates shared metadata under the repository's
				// common directory. Serialize only that short setup operation; the
				// isolated workers themselves still execute concurrently.
				worktree = await this.withRepositoryMutation(cwd, timeout.signal, async () => this.worktrees.create({
					cwd: await assertApprovedProjectIdentity(call.projectIdentity, timeout.signal),
					expectedProjectIdentity: call.projectIdentity,
					runId: call.runId, agentId: call.agentId, attempt: call.attempt, signal: timeout.signal,
				}));
				await call.onWorktreeCreated?.(worktree);
				cwd = worktree.workerCwd ?? worktree.directory;
			} else if (!options.readOnly) {
				releaseMutation = await this.#acquireRepositoryMutation(cwd, timeout.signal);
				cwd = await assertApprovedProjectIdentity(call.projectIdentity, timeout.signal);
			}
			throwIfAborted(timeout.signal);
			outcome = await this.#runAdapter({ ...call, options, harness, cwd, worktree, signal: timeout.signal });
			return outcome;
		} catch (error) {
			failure = error;
			throw error;
		} finally {
			try {
				if (worktree) {
					// Worker cancellation must not cancel cleanup before it starts. Give
					// repository-lock acquisition and Git removal their own bounded signal,
					// then propagate the original stop/restart/timeout after cleanup.
					const cleanupController = new AbortController();
					const cleanupTimer = setTimeout(() => cleanupController.abort(Object.assign(
						new Error("Workflow worktree cleanup timed out"),
						{ code: "WORKFLOW_WORKTREE_CLEANUP_TIMEOUT" },
					)), WORKFLOW_LIMITS.gitTimeoutMs);
					cleanupTimer.unref?.();
					// Removal updates the same shared worktree registry and therefore
					// uses the repository lock as setup and interactive apply operations.
					let status;
					try {
						status = await this.withRepositoryMutation(
							worktree.repository,
							cleanupController.signal,
							() => this.worktrees.release(worktree, { signal: cleanupController.signal }),
						).catch((error) => {
							if (isUnconfirmedGitTreeFailure(error)) {
								this.recordTerminationFailure(error);
								throw error;
							}
							return { retained: true, dirty: true, changedFiles: [], releaseError: error.message ?? String(error) };
						});
					} finally {
						clearTimeout(cleanupTimer);
					}
					const projected = { ...worktree, ...status };
					if (outcome) outcome.worktree = projected;
					call.onEvent?.({ type: "worktree", agentId: call.agentId, attempt: call.attempt, worktree: projected });
					if (outcome) throwIfAborted(timeout.signal);
				}
			} finally {
				try {
					call.beforeRelease?.({ outcome, error: failure });
				} finally {
					timeout.close();
					// If teardown could not confirm the mutating backend tree is gone,
					// retain both the in-process queue and cross-process ownership files
					// for this process lifetime. The owner-death marker was durably armed
					// before launch, so a restarted process requires manual recovery even
					// if this cc process is killed before reaching this finally block.
					try {
						if (releaseMutation && this.terminationFailures.length > terminationFailureCount) {
							await releaseMutation.poison?.();
							this.retainedMutationFences.add(releaseMutation);
						}
						else await releaseMutation?.();
					} finally { releaseSchedule(); }
				}
			}
		}
	}

	async #runAdapter(call) {
		let active = true;
		let adapter;
		let text = "";
		let traceBytes = 0;
		let prompted = false;
		let activeExchange;
		const exchanges = [];
		const attachUsageAccounting = (failure) => {
			if (!prompted) return failure;
			let finalSessionUsage = null;
			try {
				const sessionInfo = adapter.getSessionInfo();
				finalSessionUsage = sessionInfo?.sessionInfo?.usage ?? sessionInfo?.usage ?? null;
			} catch { /* usage is optional; preserve the worker or teardown failure */ }
			const accounting = aggregateUsage(exchanges, finalSessionUsage);
			const details = {
				workflowUsage: accounting.usage,
				workflowUsageComplete: accounting.complete,
				workflowUsageEstimate: conservativeUsageEstimate(exchanges),
				workflowOutput: text,
			};
			if (failure && typeof failure === "object") {
				try { return Object.assign(failure, details); }
				catch { /* immutable failures are wrapped below */ }
			}
			return Object.assign(new Error(failure?.message ?? String(failure), { cause: failure }), {
				name: failure?.name ?? "Error",
				code: failure?.code,
				...details,
			});
		};
		const emit = (event) => call.onEvent?.({ ...event, agentId: call.agentId, attempt: call.attempt });
		const onEvent = (event) => {
			if (!active) return;
			// Usage accounting observes the raw response stream. Projection bounds are
			// solely a storage/TUI concern and must never lower the fail-closed charge.
			if (activeExchange) {
				let rawBytes;
				try { rawBytes = Buffer.byteLength(JSON.stringify(event) ?? String(event), "utf8"); }
				catch {
					rawBytes = Number.MAX_SAFE_INTEGER;
					activeExchange.overflowed = true;
				}
				const total = saturatedByteAdd(activeExchange.outputBytes, rawBytes);
				activeExchange.outputBytes = total.value;
				activeExchange.overflowed ||= total.overflowed;
			}
			const projected = boundedAdapterEvent(event);
			if (projected?.type === "text") {
				const chunk = projected.text;
				const room = WORKFLOW_LIMITS.maxTraceBytes - traceBytes;
				if (room > 0) {
					const kept = Buffer.from(chunk).subarray(0, room).toString("utf8");
					text += kept;
					traceBytes += Buffer.byteLength(kept);
				}
			}
			emit(projected);
		};
		// Give factories the requested tuple before construction as well as retaining
		// the live-session verification/apply path below. Some harnesses can select a
		// model only in their launch arguments and cannot switch after connect.
			const inheritParentModel = call.options.model === undefined && call.harness === call.origin.harness;
			const inheritParentEffort = call.options.effort === undefined && call.harness === call.origin.harness;
			const inheritedModel = inheritParentModel && call.origin.model?.verified === true &&
				typeof call.origin.model.id === "string" && call.origin.model.id ? call.origin.model.id : undefined;
			const inheritedEffort = inheritParentEffort && call.origin.effort?.verified === true &&
				typeof call.origin.effort.id === "string" && call.origin.effort.id ? call.origin.effort.id : undefined;
			const launchModel = call.options.model ?? inheritedModel;
			const launchEffort = call.options.effort ?? inheritedEffort;
		adapter = this.createAdapter({
			harness: call.harness,
			agentConfig: call.harnesses[call.harness],
				workflowLaunch: { model: launchModel, effort: launchEffort },
			onEvent,
			isCurrent: () => active,
			runId: call.runId,
			agentId: call.agentId,
		});
		this.onAdapterStart(adapter, call);
		let stopPromise;
		const stopAdapter = () => {
			if (!stopPromise) {
				try { stopPromise = Promise.resolve(adapter.stopAndWait(WORKFLOW_SUPERVISOR_STOP_WAIT_MS)); }
				catch (error) { stopPromise = Promise.reject(error); }
			}
			return stopPromise;
		};
		const onAbort = () => {
			adapter.cancel?.();
			// connect/config RPCs may be hung before a session exists, where cancel is
			// ineffective. Begin process-tree retirement synchronously; the lifecycle
			// await below loses its abort race and finally joins this same stop fence.
			void stopAdapter().catch(() => {});
		};
		call.signal.addEventListener("abort", onAbort, { once: true });
		try {
			throwIfAborted(call.signal);
			await assertApprovedProjectIdentity(call.projectIdentity, call.signal);
			const before = workflowCapabilities(adapter, call.harness);
			if (!before.childCwd) throw new Error(`harness ${call.harness} cannot start in the requested workflow cwd`);
			if (call.options.readOnly && !before.enforcedReadOnly) throw new Error(`harness ${call.harness} cannot enforce workflow read-only mode`);
			await awaitAbortable(adapter.connect({
				cwd: call.cwd,
				workflowCwdIdentity: call.worktree?.workerIdentity ?? call.projectIdentity,
			}), call.signal);
			await assertApprovedProjectIdentity(call.projectIdentity, call.signal);
			throwIfAborted(call.signal);
			const live = workflowCapabilities(adapter, call.harness);
			const configuredDefaults = typeof adapter.getWorkflowDefaults === "function" ? adapter.getWorkflowDefaults() : {};
			const requestedModel = launchModel;
			const requiresVerifiedForeignDefault = !requestedModel && call.harness !== call.origin.harness;
			let resolvedModel = typeof adapter.getResolvedModel === "function" ? adapter.getResolvedModel() : null;
			if (requestedModel) {
				if (resolvedModel?.verified !== true || resolvedModel.id !== requestedModel) {
					if (!live.modelOverride || !live.modelVerification) throw new Error(`harness ${call.harness} cannot verify model ${requestedModel}`);
					if (typeof adapter.applyWorkflowModel !== "function") throw new Error(`harness ${call.harness} cannot apply workflow model ${requestedModel}`);
					resolvedModel = await awaitAbortable(adapter.applyWorkflowModel(requestedModel), call.signal);
					throwIfAborted(call.signal);
					if (resolvedModel?.verified !== true || resolvedModel.id !== requestedModel) {
						throw new Error(`harness ${call.harness} could not verify workflow model ${requestedModel}`);
					}
				}
			}
			if (!requestedModel && configuredDefaults?.model) {
				if (resolvedModel?.verified !== true || resolvedModel.id !== configuredDefaults.model) {
					throw new Error(`harness ${call.harness} could not verify its configured workflow model ${configuredDefaults.model}`);
				}
			}
			if (requiresVerifiedForeignDefault && (resolvedModel?.verified !== true || typeof resolvedModel.id !== "string" || !resolvedModel.id)) {
				throw new Error(`harness ${call.harness} could not verify its default workflow model`);
			}
			// An omitted same-harness tuple inherits each parent field that could be
			// verified. A different Flexible harness uses its configured pair.
			const requestedEffort = launchEffort ?? configuredDefaults?.effort;
			let resolvedEffort = await awaitAbortable(applyWorkflowEffort(adapter, call.harness, requestedEffort), call.signal);
			throwIfAborted(call.signal);
			if (call.options.agentType) {
				if (typeof adapter.applyWorkflowAgentType !== "function") throw new Error(`harness ${call.harness} cannot apply workflow agent profiles`);
				await awaitAbortable(adapter.applyWorkflowAgentType(call.options.agentType), call.signal); throwIfAborted(call.signal);
			}
			if (call.options.readOnly) {
				if (typeof adapter.applyWorkflowReadOnly !== "function") throw new Error(`harness ${call.harness} cannot enforce workflow read-only mode`);
				await awaitAbortable(adapter.applyWorkflowReadOnly(), call.signal); throwIfAborted(call.signal);
			}
			// Config mutations are not assumed independent. A backend may implicitly
			// change its model while applying effort/profile/read-only settings, so read
			// the complete tuple back only after every mutation and fail before prompting.
			const finalModel = typeof adapter.getResolvedModel === "function" ? adapter.getResolvedModel() : null;
			if (requestedModel && (finalModel?.verified !== true || finalModel.id !== requestedModel)) {
				throw new Error(`harness ${call.harness} changed workflow model after configuration; expected ${requestedModel}`);
			}
			if (!requestedModel && configuredDefaults?.model && (finalModel?.verified !== true || finalModel.id !== configuredDefaults.model)) {
				throw new Error(`harness ${call.harness} changed its configured workflow model after configuration; expected ${configuredDefaults.model}`);
			}
			if (requiresVerifiedForeignDefault && (finalModel?.verified !== true || typeof finalModel.id !== "string" || !finalModel.id)) {
				throw new Error(`harness ${call.harness} could not verify its final default workflow model`);
			}
			if (finalModel) resolvedModel = finalModel;
			const finalSessionInfo = adapter.getSessionInfo();
			const finalEffort = workflowConfigOption(finalSessionInfo, "thought_level");
			if (requestedEffort && finalEffort?.currentValue !== requestedEffort) {
				throw new Error(`harness ${call.harness} changed workflow reasoning effort after configuration; expected ${requestedEffort}`);
			}
			if (finalEffort?.currentValue) resolvedEffort = { id: finalEffort.currentValue, verified: true };
			const finalAgentType = workflowConfigOption(finalSessionInfo, "agent");
			if (call.options.agentType && finalAgentType?.currentValue !== call.options.agentType) {
				throw new Error(`harness ${call.harness} changed workflow agent profile after configuration; expected ${call.options.agentType}`);
			}
			emit({ type: "agent_ready", harness: call.harness, model: resolvedModel, effort: resolvedEffort, cwd: call.cwd, worktree: call.worktree });
			const runPrompt = async (prompt) => {
				throwIfAborted(call.signal);
				await assertApprovedProjectIdentity(call.projectIdentity, call.signal);
				text = "";
				traceBytes = 0;
				prompted = true;
				const exchange = {
					inputBytes: Buffer.byteLength(prompt, "utf8"),
					outputBytes: 0,
					overflowed: false,
				};
				activeExchange = exchange;
				try {
					const promptResult = await awaitAbortable(adapter.prompt([{ type: "text", text: prompt }]), call.signal);
					exchange.usage = promptResult?.usage;
					throwIfAborted(call.signal);
					return text.trim();
				} finally {
					if (activeExchange === exchange) activeExchange = undefined;
					exchanges.push(exchange);
				}
			};
			const hasSchema = Object.hasOwn(call.options, "schema");
			const schemaContract = hasSchema
				? `\n\nReturn only JSON matching this JSON Schema:\n${JSON.stringify(call.options.schema)}`
				: "";
			let output = await runPrompt(`${call.prompt}${schemaContract}`);
			let structured;
			if (hasSchema) {
				for (let correction = 0; correction <= 2; correction += 1) {
					try {
						structured = extractWorkflowJson(output);
						const validation = await validateWorkflowSchemaBounded(call.options.schema, structured, { signal: call.signal });
						if (validation.ok) break;
						if (correction === 2) throw new Error(`Structured response failed schema validation: ${validation.errors.join("; ")}`);
						output = await runPrompt(`Return only corrected JSON matching this JSON Schema:\n${JSON.stringify(call.options.schema)}\nProblems: ${validation.errors.join("; ")}`);
					} catch (error) {
						if (correction === 2) throw error;
						output = await runPrompt(`Return only valid JSON matching this JSON Schema:\n${JSON.stringify(call.options.schema)}\nParse error: ${error.message ?? error}`);
					}
			}
			}
			const sessionInfo = adapter.getSessionInfo();
			const finalSessionUsage = sessionInfo?.sessionInfo?.usage ?? sessionInfo?.usage ?? null;
			const accounting = aggregateUsage(exchanges, finalSessionUsage);
			return {
				value: hasSchema ? structured : output,
				output,
				harness: call.harness,
				model: resolvedModel,
				effort: resolvedEffort,
				usage: accounting.usage,
				usageComplete: accounting.complete,
				usageEstimate: conservativeUsageEstimate(exchanges),
				worktree: null,
			};
		} catch (error) {
			throw attachUsageAccounting(error);
		} finally {
			active = false;
			call.signal.removeEventListener("abort", onAbort);
			// Revoke UI ownership before waiting for process teardown. This closes any
			// permission/elicitation dialog synchronously, so a retired worker cannot
			// keep an actionable prompt visible during its shutdown timeout.
			let ownershipError;
			try { this.onAdapterStop(adapter, call); } catch (error) { ownershipError = error; }
			let stopError;
			try { await stopAdapter(); }
			catch (error) {
				stopError = error;
					// Workflow adapters launch through a supervisor whose backend owns a
					// separate process group. Any stop failure, including a force-killed
					// supervisor, is therefore a process-wide shutdown fence.
					this.recordTerminationFailure(error);
			}
			if (ownershipError) throw attachUsageAccounting(ownershipError);
			if (stopError) throw attachUsageAccounting(stopError);
		}
	}

	#acquireMutation(key, signal, scope = "identity") {
		if (signal?.aborted) return Promise.reject(abortError(signal.reason));
		const queueKey = `${scope}:${key}`;
		const previous = this.mutationTails.get(queueKey) ?? Promise.resolve();
		let release;
		const held = new Promise((resolve) => { release = resolve; });
		const tail = previous.catch(() => {}).then(() => held);
		this.mutationTails.set(queueKey, tail);
		return Promise.race([
			previous.catch(() => {}),
			new Promise((_, reject) => signal?.addEventListener("abort", () => reject(abortError(signal.reason)), { once: true })),
		]).then(async () => {
			let releaseProcessLock;
			try {
				const canonical = await fs.realpath(key);
				const stat = await fs.lstat(canonical, { bigint: true });
				const identity = scope === "path"
					? `path\0${canonical}`
					: `identity\0${stat.dev}\0${stat.ino}`;
				const lockRoot = await workflowRepositoryLockRoot();
				const lockFile = path.join(lockRoot, `${createHash("sha256").update(identity).digest("hex")}.lock`);
				releaseProcessLock = await acquireOwnershipLock(lockFile, { signal, ownerDeathFence: true });
			} catch (error) {
				release();
				if (this.mutationTails.get(queueKey) === tail) this.mutationTails.delete(queueKey);
				throw error;
			}
			let done = false;
			let releasePromise;
				const releaseMutation = async () => {
				if (done) return;
				if (!releasePromise) releasePromise = (async () => {
					await releaseProcessLock();
					done = true;
					this.failedMutationReleases.delete(releaseMutation);
					release();
					if (this.mutationTails.get(queueKey) === tail) this.mutationTails.delete(queueKey);
				})();
				try { await releasePromise; }
				catch (error) {
					releasePromise = undefined;
					this.failedMutationReleases.add(releaseMutation);
					try { this.onRestartRequired(error); } catch { /* the held queue/lock remain authoritative */ }
					throw error;
				}
				};
				releaseMutation.poison = () => releaseProcessLock.poison?.();
				return releaseMutation;
		}, (error) => {
			release();
			// The cancelled tail must remain visible until `previous` settles or a
			// later mutation could bypass the operation ahead of it. Retire it as soon
			// as that chain drains so unique cancelled repository identities do not
			// remain strongly referenced forever.
			void tail.then(() => {
				if (this.mutationTails.get(queueKey) === tail) this.mutationTails.delete(queueKey);
			});
			throw error;
		});
	}

	async #acquireRepositoryMutation(cwd, signal) {
		const fingerprint = async (target) => {
			const canonical = await fs.realpath(target);
			const stat = await fs.lstat(canonical, { bigint: true });
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error("workflow repository lock identity must be a real directory"), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" });
			return { canonical, device: String(stat.dev), inode: String(stat.ino) };
		};
		const checkout = await fingerprint(cwd);
		const releases = [];
		try {
			releases.push(await this.#acquireMutation(checkout.canonical, signal, "path"));
			releases.push(await this.#acquireMutation(checkout.canonical, signal, "identity"));
			throwIfAborted(signal);
			const discoveredCommon = await (this.worktrees.repositoryLockIdentity?.(checkout.canonical, { signal })
				?? this.worktrees.repositoryIdentity(checkout.canonical, { signal }));
			const common = await fingerprint(discoveredCommon);
			if (common.canonical !== checkout.canonical) {
				releases.push(await this.#acquireMutation(common.canonical, signal, "path"));
				releases.push(await this.#acquireMutation(common.canonical, signal, "identity"));
			}
			throwIfAborted(signal);
			const confirmedCheckout = await fingerprint(cwd);
			const confirmedCommon = await fingerprint(await (this.worktrees.repositoryLockIdentity?.(checkout.canonical, { signal })
				?? this.worktrees.repositoryIdentity(checkout.canonical, { signal })));
			if (["canonical", "device", "inode"].some((field) => confirmedCheckout[field] !== checkout[field] || confirmedCommon[field] !== common[field])) {
				throw Object.assign(new Error("workflow repository identity changed while acquiring its mutation locks"), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" });
			}
		} catch (error) {
			const settled = await Promise.allSettled([...releases].reverse().map((release) => release()));
			const releaseErrors = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
			if (releaseErrors.length) throw new AggregateError([error, ...releaseErrors], "workflow repository identity changed and its mutation locks could not be released");
			throw error;
		}
			const releaseRepositoryMutation = async () => {
				const settled = await Promise.allSettled([...releases].reverse().map((release) => release()));
				const errors = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
				if (errors.length) throw new AggregateError(errors, "workflow repository mutation locks could not be released");
			};
			releaseRepositoryMutation.poison = async () => {
				const settled = await Promise.allSettled(releases.map((release) => release.poison?.()));
				const errors = settled.filter((result) => result.status === "rejected").map((result) => result.reason);
				if (errors.length) throw new AggregateError(errors, "workflow repository mutation locks could not be persistently fenced");
			};
			return releaseRepositoryMutation;
	}

	async withRepositoryMutation(cwd, signal, operation) {
		const release = await this.#acquireRepositoryMutation(cwd, signal);
		let retainFence = false;
		try { throwIfAborted(signal); return await operation(); }
		catch (error) {
			if (isUnconfirmedGitTreeFailure(error)) {
				this.recordTerminationFailure(error);
				retainFence = true;
			}
			throw error;
		}
		finally {
			if (retainFence) {
				await release.poison?.();
				this.retainedMutationFences.add(release);
			}
			else await release();
		}
	}
}
