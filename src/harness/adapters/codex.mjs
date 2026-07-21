// Codex adapter — the most tightly coupled harness. Re-homes every codex-only
// branch from pi-harness.mjs behind interface methods: copy-fork, prompt unsend,
// the /review preset dialog, and CODEX_CONFIG translation. It reuses the
// exact exported production helpers so behavior is identical.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BaseAcpAdapter, REVIEW_PRESET } from "../acp-base.mjs";
import { mergeEnvironments } from "../acp-runtime.mjs";
import { adapterVersionAtLeast, BUNDLED_ACP_ADAPTERS } from "../bundled-adapters.mjs";
import {
	assertCheckpointModeSupported,
	normalizeCheckpointRewindResponse,
} from "../checkpoints.mjs";
import {
	assertCodexCheckpointTurnRemoved,
	codexCheckpointForkParams,
	codexCheckpointReadParams,
	codexCheckpointRollbackPlan,
	codexCheckpointsFromThreadRead,
} from "../codex-checkpoints.mjs";
import { codexPersistentForkSession } from "../codex-thread.mjs";

const CODEX_ACP_AGENT_NAME = BUNDLED_ACP_ADAPTERS.codex.packageName;

function parseCodexConfig(value) {
	try {
		const parsed = JSON.parse(value ?? "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export class CodexAdapter extends BaseAcpAdapter {
	static workflowMcpLaunch = true;

	codexService(name, options = {}) {
		const service = this.services?.codex?.[name] ?? this.services?.[name];
		if (typeof service === "function") return service;
		if (options.optional === true) return undefined;
		throw new Error(`Codex adapter requires the host service ${name}()`);
	}

	declaredCapabilities() {
		return {
			fork: "copy",
			retractPrompt: true,
			commandPresets: ["review"],
			checkpoints: true,
			checkpointModes: ["conversation"],
		};
	}

	// Unsend is only safe against the maintained Codex ACP backend. Narrow only
	// once connected to a live backend;
	// pre-connect, keep the declared capability (the contract says pre-connect caps
	// expose the declared subset). Pointing the codex key at another bridge then keeps
	// unsend off rather than advertising a feature that backend can't honor.
	refineCapabilities(caps) {
		if (this.connection) {
			const maintained = this.connection.agentInfo?.name === CODEX_ACP_AGENT_NAME;
			const checkpointCompatible = maintained && adapterVersionAtLeast(
				this.connection.agentInfo?.version,
				BUNDLED_ACP_ADAPTERS.codex.minimumVersion,
			);
			caps.retractPrompt = maintained;
			caps.checkpoints = checkpointCompatible;
			caps.checkpointModes = checkpointCompatible ? ["conversation"] : [];
		}
		return caps;
	}

	// The maintained adapter consumes Codex overrides as a JSON object. Preserve
	// any config supplied directly through env, then let explicit cc settings win.
	translateConfig(applied, config) {
		const existing = {
			...parseCodexConfig(process.env.CODEX_CONFIG),
			...parseCodexConfig(applied.env?.CODEX_CONFIG),
		};
		applied.env = {
			...(applied.env ?? {}),
			CODEX_CONFIG: JSON.stringify({ ...existing, ...config }),
		};
	}

	removeConfig(applied, names) {
		const parsed = {
			...parseCodexConfig(process.env.CODEX_CONFIG),
			...parseCodexConfig(applied.env?.CODEX_CONFIG),
		};
		for (const name of names) delete parsed[name];
		applied.env = { ...(applied.env ?? {}), CODEX_CONFIG: JSON.stringify(parsed) };
	}

	// Permission intent maps to the successor adapter's ACP modes through the
	// unified engine in BaseAcpAdapter.
	codexEnvironment() {
		const command = this.launchSpec?.acp ?? this.launchSpec;
		return mergeEnvironments([process.env, this.launchSpec?.env, command?.env]);
	}

	liveLeaseService(name) {
		return this.codexService(name, { optional: true });
	}

	canonicalSessionId(sessionId) {
		return String(sessionId ?? "").toLowerCase();
	}

	leaseBackendOptions(connection = this.connection) {
		return {
			backendPid: connection?.child?.pid,
			backendProcessGroup: process.platform !== "win32",
			backendPlatform: process.platform,
		};
	}

	acquireLiveLease(sessionId, connection = this.connection) {
		const acquire = this.liveLeaseService("acquireLiveSessionLease");
		if (!acquire) return undefined;
		const canonical = this.canonicalSessionId(sessionId);
		this.liveSessionLeases ??= new Map();
		if (this.liveSessionLeases.has(canonical)) return this.liveSessionLeases.get(canonical);
		const release = acquire(sessionId, this.leaseBackendOptions(connection));
		this.liveSessionLeases.set(canonical, release);
		return release;
	}

	releaseLiveLease(sessionId) {
		const canonical = this.canonicalSessionId(sessionId);
		const release = this.liveSessionLeases?.get(canonical);
		if (!release) return true;
		release();
		this.liveSessionLeases.delete(canonical);
		if (this.activeLiveSessionId === canonical) this.activeLiveSessionId = undefined;
		return true;
	}

	promoteLiveLease(sessionId, connection = this.connection) {
		const canonical = this.canonicalSessionId(sessionId);
		if (!canonical) throw new Error("Codex did not provide a session id to retain");
		this.acquireLiveLease(sessionId, connection);
		this.activeLiveSessionId = canonical;
		for (const leasedId of [...(this.liveSessionLeases?.keys() ?? [])]) {
			if (leasedId !== canonical) this.releaseLiveLease(leasedId);
		}
	}

	releaseAllLiveLeases() {
		for (const sessionId of [...(this.liveSessionLeases?.keys() ?? [])]) this.releaseLiveLease(sessionId);
	}

	async acquireLeaseOperation(operation) {
		const acquire = this.liveLeaseService("acquireForkOperationLock");
		return acquire ? await acquire({ operation }) : () => true;
	}

	async afterConnectionInitialized(connection) {
		if (connection?.sessionId) this.promoteLiveLease(connection.sessionId, connection);
	}

	async afterConnectionsRetired() {
		this.checkpointSnapshot = undefined;
		this.releaseAllLiveLeases();
	}

	async prompt(prompt) {
		this.checkpointSnapshot = undefined;
		return await super.prompt(prompt);
	}

	discardCheckpointSnapshot() {
		this.checkpointSnapshot = undefined;
	}

	async newSession(options = {}) {
		const releaseOperation = await this.acquireLeaseOperation("create Codex session");
		const connection = this.connection;
		const previousSessionId = this.canonicalSessionId(connection?.sessionId);
		let promoted = false;
		try {
			const beforeReplay = options.beforeReplay;
			const result = await super.newSession({
				...options,
				beforeReplay: async (response) => {
					this.promoteLiveLease(connection?.sessionId, connection);
					promoted = true;
					await beforeReplay?.(response);
				},
			});
			if (!promoted) {
				this.promoteLiveLease(connection?.sessionId, connection);
				promoted = true;
			}
			return result;
		} catch (error) {
			const currentSessionId = this.canonicalSessionId(connection?.sessionId);
			if (!promoted && currentSessionId && currentSessionId !== previousSessionId) {
				this.promoteLiveLease(currentSessionId, connection);
			}
			throw error;
		} finally {
			releaseOperation();
		}
	}

	async loadSession(sessionId, options = {}) {
		const releaseOperation = options._ccForkOperationLockHeld === true
			? () => true
			: await this.acquireLeaseOperation(`resume ${sessionId}`);
		const connection = this.connection;
		const targetId = this.canonicalSessionId(sessionId);
		const previousSessionId = this.canonicalSessionId(connection?.sessionId);
		let targetLeaseAcquired = false;
		let promoted = false;
		try {
			if (targetId !== this.activeLiveSessionId) {
				this.acquireLiveLease(sessionId, connection);
				targetLeaseAcquired = true;
			}
			const beforeReplay = options.beforeReplay;
			const loadOptions = { ...options };
			delete loadOptions._ccForkOperationLockHeld;
			const result = await super.loadSession(sessionId, {
				...loadOptions,
				beforeReplay: async (response) => {
					this.promoteLiveLease(sessionId, connection);
					promoted = true;
					await beforeReplay?.(response);
				},
			});
			if (!promoted) {
				this.promoteLiveLease(sessionId, connection);
				promoted = true;
			}
			return result;
		} catch (error) {
			const committed = this.canonicalSessionId(connection?.sessionId) === targetId && targetId !== previousSessionId;
			if (committed && !promoted) this.promoteLiveLease(sessionId, connection);
			else if (!committed && targetLeaseAcquired) this.releaseLiveLease(sessionId);
			throw error;
		} finally {
			releaseOperation();
		}
	}

	async listCheckpoints(options = {}) {
		if (!this.capabilities.checkpoints || !this.sessionId) {
			throw new Error("Codex checkpoint history is not available");
		}
		const resolveInvocation = this.codexService("resolveCodexInvocation");
		const runRequests = this.codexService("runCodexAppServerRequests");
		const invocation = resolveInvocation(this.launchSpec);
		if (!invocation) throw new Error("a compatible Codex CLI is required for rollback");
		const [response] = await runRequests(
			invocation,
			[{ method: "thread/read", params: codexCheckpointReadParams(this.sessionId) }],
			this.launchSpec,
		);
		const checkpoints = codexCheckpointsFromThreadRead(response, options);
		// The picker prevents turns and session transitions while it is open, and the
		// live-session lease prevents another cc process from mutating this thread.
		// Retain the exact snapshot so the selected rewind does not launch a second
		// app-server merely to read the same history again.
		this.checkpointSnapshot = { sessionId: this.canonicalSessionId(this.sessionId), response };
		return checkpoints;
	}

	async rewindCheckpoint(checkpointId, mode, options = {}) {
		assertCheckpointModeSupported(this.capabilities, mode);
		const releaseOperation = await this.acquireLeaseOperation(`rewind Codex checkpoint ${checkpointId}`);
		const connection = this.connection;
		const sourceSessionId = this.canonicalSessionId(connection?.sessionId);
		let forked;
		let invocation;
		let runRequests;
		let handoffPromise;
		let promoted = false;
		let reusedTranscript = false;
		let rollbackPlan;
		try {
			if (!sourceSessionId) throw new Error("Codex session is not ready");
			const resolveInvocation = this.codexService("resolveCodexInvocation");
			runRequests = this.codexService("runCodexAppServerRequests");
			invocation = resolveInvocation(this.launchSpec);
			if (!invocation) throw new Error("a compatible Codex CLI is required for rollback");
			const snapshot = this.checkpointSnapshot;
			this.checkpointSnapshot = undefined;
			if (snapshot?.sessionId === sourceSessionId) {
				rollbackPlan = codexCheckpointRollbackPlan(snapshot.response, checkpointId, {
					readLocalImage: (filePath) => fs.readFileSync(filePath),
				});
			}
			const requests = [];
			if (!rollbackPlan) {
				requests.push(
					{ method: "thread/read", params: codexCheckpointReadParams(sourceSessionId) },
					(results) => {
						rollbackPlan = codexCheckpointRollbackPlan(results.at(-1), checkpointId, {
							readLocalImage: (filePath) => fs.readFileSync(filePath),
						});
						return { method: "thread/fork", params: codexCheckpointForkParams(sourceSessionId, rollbackPlan.turnId) };
					},
				);
			} else {
				requests.push({ method: "thread/fork", params: codexCheckpointForkParams(sourceSessionId, rollbackPlan.turnId) });
			}
			requests.push(
				(results) => {
					forked = codexPersistentForkSession(results.at(-1), sourceSessionId);
					return { method: "thread/rollback", params: { threadId: forked.sessionId, numTurns: 1 } };
				},
				(results) => {
					assertCodexCheckpointTurnRemoved(results.at(-1), rollbackPlan);
					return {
						method: "thread/inject_items",
						params: { threadId: forked.sessionId, items: rollbackPlan.injectionItems },
					};
				},
			);
			await runRequests(
				invocation,
				requests,
				this.launchSpec,
				{
					// The persistent zero-turn fork exists only while this app-server owns
					// it. session/resume (or the compatibility session/load fallback) is
					// therefore the commit boundary: its successful return proves the
					// independent live ACP backend adopted the rolled-back
					// history, including injected input, before this temporary owner exits.
					// After that transfer the live backend, rather than this process's final
					// storage flush, is authoritative for the child session.
					acceptForcedTeardownAfterResponse: true,
					beforeTeardown: () => {
						handoffPromise = (async () => {
							this.codexService("recordForkId")(forked.sessionId, sourceSessionId, { required: true });
							this.acquireLiveLease(forked.sessionId, connection);
							const beforeReplay = options.beforeReplay;
							const canReuseTranscript = options.canReuseTranscript;
							const sessionOptions = { ...options };
							delete sessionOptions.preserveTranscript;
							delete sessionOptions.canReuseTranscript;
							const resumeAdvertised = Boolean(
								connection?.getSessionInfo?.()?.capabilities?.sessionCapabilities?.resume,
							);
							const reuseEligible = options.preserveTranscript === true &&
								typeof beforeReplay === "function" &&
								typeof canReuseTranscript === "function" &&
								resumeAdvertised &&
								typeof connection?.resumeSession === "function" &&
								await canReuseTranscript({ replayText: rollbackPlan.replayText }) === true;
							if (
								reuseEligible
							) {
								await connection.resumeSession(forked.sessionId, {
									...sessionOptions,
									beforeReplay: async (response) => {
										this.promoteLiveLease(forked.sessionId, connection);
										promoted = true;
										reusedTranscript = await beforeReplay(response, {
											reuseCurrentTranscript: true,
											replayText: rollbackPlan.replayText,
										}) === true;
										// Reuse eligibility is checked before session/resume commits. If
										// the transcript changes in that narrow window, establish the
										// authoritative empty replay view before attempting session/load;
										// a load failure must never leave the source transcript attached
										// to the already-adopted checkpoint branch.
										if (!reusedTranscript) await beforeReplay(response);
									},
								});
							}
							if (!reusedTranscript) {
								await super.loadSession(forked.sessionId, {
									...sessionOptions,
									beforeReplay: async (response) => {
										this.promoteLiveLease(forked.sessionId, connection);
										promoted = true;
										await beforeReplay?.(response);
									},
								});
							}
							if (!promoted) this.promoteLiveLease(forked.sessionId, connection);
						})();
						return handoffPromise;
					},
				},
			);
			if (!reusedTranscript) {
				for (const text of rollbackPlan.replayText) this.host.onEvent?.({ type: "user_text", text });
			}
			return normalizeCheckpointRewindResponse({ ok: true, mode, sessionId: forked.sessionId });
		} catch (error) {
			// Third-party host services may not use cc's transaction helper. Preserve
			// the same no-race contract at the adapter boundary before deciding whether
			// the child committed or is still disposable.
			if (handoffPromise) {
				try { await handoffPromise; }
				catch (handoffError) { error.checkpointHandoffError ??= handoffError; }
			}
			const currentSessionId = this.canonicalSessionId(connection?.sessionId);
			if (!promoted && currentSessionId && currentSessionId !== sourceSessionId) {
				this.promoteLiveLease(currentSessionId, connection);
			} else if (forked && (!currentSessionId || currentSessionId === sourceSessionId)) {
				this.releaseLiveLease(forked.sessionId);
				const cleanupErrors = [];
				try {
					if (!invocation || !runRequests) throw new Error("Codex rollback cleanup lost its app-server invocation");
					await runRequests(invocation, [{ method: "thread/delete", params: { threadId: forked.sessionId } }], this.launchSpec);
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
				try {
					// A zero-turn native fork may disappear when its app-server exits, so
					// registry cleanup is independent of whether thread/delete still finds it.
					this.codexService("forgetForkIds")(forked.sessionId, { required: true });
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
				if (cleanupErrors.length === 1) error.checkpointForkCleanupError = cleanupErrors[0];
				else if (cleanupErrors.length > 1) {
					error.checkpointForkCleanupError = new AggregateError(cleanupErrors, "Codex rollback cleanup failed");
				}
			}
			throw error;
		} finally {
			releaseOperation();
		}
	}

	// codex-acp exposes no session/fork. Copy the parent's rollout JSONL to a new
	// id and session/load the copy: an isolated branch, parent untouched.
	async fork(parentSessionId, options = {}) {
		const acquireForkOperationLock = this.codexService("acquireForkOperationLock");
		const codexHome = this.codexService("codexHome");
		const findCodexRolloutPath = this.codexService("findCodexRolloutPath");
		const copyCodexRolloutWithNewId = this.codexService("copyCodexRolloutWithNewId");
		const recordForkId = this.codexService("recordForkId");
		const forgetForkIds = this.codexService("forgetForkIds");
		const releaseForkOperation = await acquireForkOperationLock({ operation: `fork ${parentSessionId}` });
		try {
			if (this.sessionId && this.canonicalSessionId(this.sessionId) !== this.canonicalSessionId(parentSessionId)) {
				throw new Error("the Codex source session changed before the fork could start");
			}
			const environment = this.codexEnvironment();
			const rolloutPath = findCodexRolloutPath(parentSessionId, path.join(codexHome(environment), "sessions"));
			if (!rolloutPath) throw new Error("could not locate the Codex session rollout to fork");
			if (rolloutPath.endsWith(".zst")) throw new Error("the Codex session rollout is compressed; cannot fork it");
			const newId = randomUUID();
			let copiedRolloutPath;
			try {
				copiedRolloutPath = copyCodexRolloutWithNewId(rolloutPath, parentSessionId, newId, {
					beforePublish: () => {
						recordForkId(newId, parentSessionId, { required: true });
					},
					});
			} catch (error) {
				forgetForkIds(newId, { required: true });
				throw error;
			}
			try {
				const loadOptions = { ...options };
				delete loadOptions.retainSessionLease;
				// The operation lock makes publishing ownership atomic with respect to
				// /resume in every other cc process. Publish the lease before session/load:
				// after that RPC starts, a detached ACP process may already be reading or
				// writing the copied rollout even if cc crashes before the request returns.
				if (this.lifecycleState !== "open" || !this.connection) {
					throw new Error("the Codex adapter stopped before fork ownership could be retained");
				}
				this.acquireLiveLease(newId, this.connection);
				const beforeReplay = loadOptions.beforeReplay;
				await super.loadSession(newId, {
					...loadOptions,
					beforeReplay: async (response) => {
						this.promoteLiveLease(newId, this.connection);
						await beforeReplay?.(response);
					},
				});
				this.promoteLiveLease(newId, this.connection);
				// stop() can begin while session/load is pending. Treat that as a failed
				// handoff; stop() retains the lease until it confirms process-tree exit.
				if (this.lifecycleState !== "open" || this.activeLiveSessionId !== this.canonicalSessionId(newId)) {
					throw new Error("the Codex adapter stopped before fork ownership could be retained");
				}
			} catch (error) {
				// stop() retains its saved connection and owns the live lease. Never clean
				// up the rollout until it confirms the complete backend process tree exited.
				await this.stop();
				fs.rmSync(copiedRolloutPath, { force: true });
				forgetForkIds(newId, { required: true });
				throw error;
			}
		} finally {
			releaseForkOperation();
		}
	}

	async acquireSessionLoadGuard(sessionId) {
		// loadSession owns the complete check/acquire/RPC/swap transaction so every
		// caller, including non-TUI lifecycle paths, receives the same protection.
		return () => true;
	}

	stop(options = {}) {
		const stopped = super.stop(options);
		if (!this.liveSessionLeaseStopPromise) {
			// A rejected stop means cc could not prove the process tree is gone. Keep
			// ownership fail-closed; a later process can reclaim it after this PID dies.
			this.liveSessionLeaseStopPromise = Promise.resolve(stopped).then((result) => {
				this.releaseAllLiveLeases();
				return result;
			});
		}
		return this.liveSessionLeaseStopPromise;
	}

	// Unsend: snapshot the on-disk thread state, then check it is unchanged before
	// retracting the just-sent prompt.
	snapshotRetractionState() {
		const readCodexThreadState = this.codexService("readCodexThreadState", { optional: true });
		const codexHome = this.codexService("codexHome", { optional: true });
		if (!readCodexThreadState || !codexHome) return undefined;
		return readCodexThreadState(
			this.sessionId,
			path.join(codexHome(this.codexEnvironment()), "state_5.sqlite"),
		);
	}

	canRetract(snapshot) {
		if (!snapshot) return false;
		const readCodexThreadState = this.codexService("readCodexThreadState", { optional: true });
		const codexHome = this.codexService("codexHome", { optional: true });
		if (!readCodexThreadState || !codexHome) return false;
		const current = readCodexThreadState(
			snapshot.sessionId,
			path.join(codexHome(this.codexEnvironment()), "state_5.sqlite"),
		);
		return Boolean(current && JSON.stringify(current) === JSON.stringify(snapshot));
	}

	// Codex always offers the /review preset; the base also fires it for any backend
	// advertising the review/review-branch/review-commit trio.
	interceptCommand(name, argument, backendNames = new Set()) {
		const generic = super.interceptCommand(name, argument, backendNames);
		if (generic) return generic;
		if (name === "review" && !argument && this.key === "codex") return REVIEW_PRESET;
		return null;
	}
}
