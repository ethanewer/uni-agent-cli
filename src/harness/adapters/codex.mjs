// Codex adapter — the most tightly coupled harness. Re-homes every codex-only
// branch from pi-harness.mjs behind interface methods: copy-fork, prompt unsend,
// the /review preset dialog, and CODEX_CONFIG translation. It reuses the
// exact exported production helpers so behavior is identical.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BaseAcpAdapter, REVIEW_PRESET } from "../acp-base.mjs";
import { mergeEnvironments } from "../acp-runtime.mjs";

const CODEX_ACP_AGENT_NAME = "@agentclientprotocol/codex-acp";

function parseCodexConfig(value) {
	try {
		const parsed = JSON.parse(value ?? "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export class CodexAdapter extends BaseAcpAdapter {
	codexService(name, options = {}) {
		const service = this.services?.codex?.[name] ?? this.services?.[name];
		if (typeof service === "function") return service;
		if (options.optional === true) return undefined;
		throw new Error(`Codex adapter requires the host service ${name}()`);
	}

	declaredCapabilities() {
		return { fork: "copy", retractPrompt: true, commandPresets: ["review"] };
	}

	// Unsend is only safe against the maintained Codex ACP backend. Narrow only
	// once connected to a live backend;
	// pre-connect, keep the declared capability (the contract says pre-connect caps
	// expose the declared subset). Pointing the codex key at another bridge then keeps
	// unsend off rather than advertising a feature that backend can't honor.
	refineCapabilities(caps) {
		if (this.connection) caps.retractPrompt = this.connection.agentInfo?.name === CODEX_ACP_AGENT_NAME;
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
		this.releaseAllLiveLeases();
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

	async rewindCheckpoint(checkpointId, mode, options = {}) {
		if (mode === "code") return await super.rewindCheckpoint(checkpointId, mode, options);
		const releaseOperation = await this.acquireLeaseOperation(`rewind Codex checkpoint ${checkpointId}`);
		const connection = this.connection;
		const previousSessionId = this.canonicalSessionId(connection?.sessionId);
		let promoted = false;
		try {
			const beforeReplay = options.beforeReplay;
			const result = await super.rewindCheckpoint(checkpointId, mode, {
				...options,
				beforeReplay: async (response) => {
					this.promoteLiveLease(connection?.sessionId, connection);
					promoted = true;
					await beforeReplay?.(response);
				},
			});
			if (!promoted) this.promoteLiveLease(result?.sessionId ?? connection?.sessionId, connection);
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
