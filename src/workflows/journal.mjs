import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { acquireOwnershipLock } from "./ownership-lock.mjs";
import { readBoundedHandle, syncDirectory } from "./durability.mjs";
import { ensureWorkflowPrivateDirectory } from "./state-root.mjs";
import { WORKFLOW_LIMITS } from "./types.mjs";

export const WORKFLOW_JOURNAL_VERSION = 1;
const WORKFLOW_HISTORY_INDEX_VERSION = 1;
const WORKFLOW_HISTORY_INDEX_BYTES = 1024 * 1024;
const WORKFLOW_RECOVERY_FALLBACK_VERSION = 1;
const WORKFLOW_RECOVERY_FALLBACK_BYTES = 1024 * 1024;
const WORKFLOW_LAUNCH_COMMIT_VERSION = 1;
const WORKFLOW_LAUNCH_COMMIT_BYTES = 4096;
const WORKTREE_INDEX_SCAN_MAX_ENTRIES = 50_000;
const WORKTREE_INDEX_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const WORKTREE_INDEX_SCAN_TIMEOUT_MS = 5_000;
const HISTORY_DISCOVERY_MAX_ENTRIES = 50_000;
const HISTORY_DISCOVERY_TIMEOUT_MS = 5_000;
const historyIndexTails = new Map();

function readFailure(error, bytes) {
	const consumed = Math.max(0, Number(error?.workflowReadBytes) || 0) + Math.max(0, Number(bytes) || 0);
	try {
		error.workflowReadBytes = consumed;
		return error;
	} catch {
		return Object.assign(new Error(error?.message ?? String(error), { cause: error }), {
			code: error?.code,
			workflowReadBytes: consumed,
		});
	}
}

function safeRunId(value) {
	const id = String(value ?? "");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id) || id === "." || id === "..") {
		throw new Error("workflow run id is invalid");
	}
	return id;
}

function safeWorktreeSegment(value) {
	return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
}

function validDirectoryIdentity(identity) {
	return Boolean(identity) && typeof identity === "object" && !Array.isArray(identity) &&
		typeof identity.device === "string" && Boolean(identity.device) && typeof identity.inode === "string" && Boolean(identity.inode);
}

async function directoryIdentity(directory) {
	const stat = await fs.lstat(path.resolve(directory), { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("workflow journal directory identity is invalid");
	return Object.freeze({ device: String(stat.dev), inode: String(stat.ino) });
}

async function assertDirectoryIdentity(directory, expected) {
	if (!validDirectoryIdentity(expected)) throw new Error("workflow journal directory identity is missing");
	const current = await directoryIdentity(directory);
	if (current.device !== expected.device || current.inode !== expected.inode) throw new Error("workflow journal directory identity changed");
	return current;
}

export function isExactRecoverySnapshot(snapshot) {
	if (snapshot?.recoveryExactVersion !== 1 || typeof snapshot.source !== "string" || snapshot.source.length === 0 ||
		Buffer.byteLength(snapshot.source, "utf8") > WORKFLOW_LIMITS.maxSourceBytes ||
		typeof snapshot.sourceHash !== "string" || snapshot.sourceHash !== createHash("sha256").update(snapshot.source).digest("hex")) return false;
	if (!Object.hasOwn(snapshot, "args") || !Object.hasOwn(snapshot, "tokenBudget") ||
		!Object.hasOwn(snapshot, "requestedConcurrency") || !Object.hasOwn(snapshot, "effectiveConcurrency")) return false;
	let args;
	try { args = JSON.stringify(snapshot.args); } catch { return false; }
	if (args === undefined || Buffer.byteLength(args, "utf8") > WORKFLOW_LIMITS.maxArgsBytes) return false;
	if (snapshot.tokenBudget !== null && (!Number.isSafeInteger(snapshot.tokenBudget) || snapshot.tokenBudget < 1000 || snapshot.tokenBudget > 1_000_000_000)) return false;
	if (!Number.isSafeInteger(snapshot.requestedConcurrency) || snapshot.requestedConcurrency < 1 || snapshot.requestedConcurrency > WORKFLOW_LIMITS.maxRunConcurrency ||
		!Number.isSafeInteger(snapshot.effectiveConcurrency) || snapshot.effectiveConcurrency < 1 || snapshot.effectiveConcurrency > snapshot.requestedConcurrency) return false;
	if (!validDirectoryIdentity(snapshot.runDirectoryIdentity)) return false;
	const identity = snapshot.projectIdentity;
	if (!identity || typeof identity !== "object" || Array.isArray(identity) ||
		["canonicalRoot", "device", "inode"].some((key) => typeof identity[key] !== "string" || !identity[key])) return false;
	const origin = snapshot.recoveryOrigin;
	return Boolean(origin) && typeof origin === "object" && !Array.isArray(origin) &&
		typeof origin.harness === "string" && Boolean(origin.harness) &&
		["clone-only", "flexible"].includes(origin.workflowMode) && typeof origin.cwd === "string" && Boolean(origin.cwd) &&
		typeof origin.adapterId === "string" && Boolean(origin.adapterId) && typeof origin.sessionId === "string" && Boolean(origin.sessionId) &&
		Number.isSafeInteger(origin.generation) && origin.generation >= 0 && ["main", "btw"].includes(origin.thread);
}

async function readBoundedFile(file, maximum, options = {}) {
	let handle;
	try {
		const before = await fs.lstat(file);
		if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow journal path is not a regular file");
		handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	}
	catch (error) {
		if (options.optional && error?.code === "ENOENT") return { text: "", bytes: 0 };
		throw error;
	}
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("workflow journal path is not a regular file");
		if (stat.size > maximum) throw Object.assign(new Error("workflow journal exceeds the startup read bound"), { code: "WORKFLOW_HISTORY_BUDGET" });
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		try {
			while (offset < buffer.length) {
				const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
		} catch (error) { throw readFailure(error, offset); }
		return { text: buffer.subarray(0, offset).toString("utf8"), bytes: offset };
	} finally { await handle.close(); }
}

function checksum(previous, sequence, event) {
	return createHash("sha256")
		.update(previous)
		.update("\0")
		.update(String(sequence))
		.update("\0")
		.update(JSON.stringify(event))
		.digest("hex");
}

async function atomicJson(file, value, options = {}) {
	const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
	let handle;
	try {
		handle = await fs.open(temporary, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporary, file);
		options.onPublished?.();
		await syncDirectory(path.dirname(file));
	} finally {
		await handle?.close();
		await fs.unlink(temporary).catch((error) => { if (error?.code !== "ENOENT") throw error; });
	}
}

async function archivedRunHasManagedWorktree(root, runId, budget) {
	const directory = path.join(path.dirname(root), "workflow-worktrees", runId);
	try {
		const entries = await fs.opendir(directory);
		for await (const entry of entries) {
			budget.entries += 1;
			if (budget.entries > WORKTREE_INDEX_SCAN_MAX_ENTRIES || Date.now() >= budget.deadline) {
				throw Object.assign(new Error("workflow worktree marker discovery exceeded its bounded scan"), { code: "WORKFLOW_HISTORY_SCAN_LIMIT" });
			}
			const markerName = entry.name.endsWith(".cc-worktree.json") || entry.name.includes(".cc-worktree.json.quarantine-");
			if (!markerName) continue;
			if (!entry.isFile() || entry.isSymbolicLink?.()) return true;
			if (entry.name.includes(".cc-worktree.json.quarantine-")) {
				// Startup reconciliation deliberately keeps malformed marker bytes beside
				// the checkout for manual recovery. Preserve the associated run journal too.
				return true;
			}
			if (!entry.name.endsWith(".cc-worktree.json")) continue;
			let handle;
				try {
					handle = await fs.open(path.join(directory, entry.name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
					const stat = await handle.stat();
					if (!stat.isFile() || stat.size > 16 * 1024) return true;
					budget.bytes += stat.size;
					if (budget.bytes > WORKTREE_INDEX_SCAN_MAX_BYTES || Date.now() >= budget.deadline) {
						throw Object.assign(new Error("workflow worktree marker discovery exceeded its bounded scan"), { code: "WORKFLOW_HISTORY_SCAN_LIMIT" });
					}
					const marker = JSON.parse((await readBoundedHandle(handle, 16 * 1024, "invalid workflow worktree marker")).toString("utf8"));
					const expectedDirectory = path.join(directory, entry.name.slice(0, -".cc-worktree.json".length));
					const expectedMarkerName = `${safeWorktreeSegment(marker?.agentId)}-${marker?.attempt}.cc-worktree.json`;
					const valid = marker?.version === 1 && marker.runId === runId && entry.name === expectedMarkerName && typeof marker.directory === "string" &&
						path.resolve(marker.directory) === path.resolve(expectedDirectory) && typeof marker.repository === "string" &&
						typeof marker.base === "string" && marker.base && typeof marker.agentId === "string" && marker.agentId &&
						Number.isSafeInteger(marker.attempt) && marker.attempt > 0 &&
						["canonicalRoot", "device", "inode", "commonDirectory", "commonDevice", "commonInode"].every((key) => marker.repositoryFingerprint?.[key] !== undefined) &&
						["canonicalRoot", "device", "inode", "commonDirectory", "commonDevice", "commonInode"].every((key) => marker.checkoutFingerprint?.[key] !== undefined);
					if (!valid || typeof marker.appliedAt !== "string" || !marker.appliedAt) return true;
				} catch (error) {
					if (error?.code === "WORKFLOW_HISTORY_SCAN_LIMIT") throw error;
				// Ambiguous or malformed markers remain actionable until startup
				// reconciliation can inspect them safely.
				return true;
			} finally { await handle?.close(); }
		}
		return false;
	} catch (error) {
		if (error?.code === "ENOENT") return false;
		if (error?.code === "WORKFLOW_HISTORY_SCAN_LIMIT") throw error;
		// Eviction is optional; an ambiguous worktree directory must preserve the
		// journal needed to inspect and durably mark a later explicit apply.
		return true;
	}
}

async function updateHistoryIndex(root, runId, createdAt, state = "live") {
	const indexFile = path.join(root, "index.json");
	const previous = historyIndexTails.get(root) ?? Promise.resolve();
	const operation = previous.catch(() => {}).then(async () => {
		let published = false;
		try {
			const release = await acquireOwnershipLock(path.join(root, ".index.lock"), { timeoutMs: 30_000 });
			try {
			let parsed;
			try {
				const read = await readBoundedFile(indexFile, WORKFLOW_HISTORY_INDEX_BYTES);
				parsed = JSON.parse(read.text);
			} catch (error) {
				if (error?.code !== "ENOENT") throw error;
			}
			const runs = Array.isArray(parsed?.runs) ? parsed.runs.filter((entry) => {
				try { safeRunId(entry?.id); } catch { return false; }
				return typeof entry.createdAt === "string" && entry.createdAt.length <= 64;
			}) : [];
			const merged = state === "remove"
				? runs.filter((entry) => entry.id !== runId)
				: [{ id: runId, createdAt, state }, ...runs.filter((entry) => entry.id !== runId)];
			const newest = (entries) => entries
				.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || a.id.localeCompare(b.id));
			// Live/awaiting-delivery runs are recovery-critical and get their own
			// capacity. Archived history is capped independently so a stream of short
			// completed workflows cannot evict an older still-running workflow.
			const live = newest(merged.filter((entry) => entry.state === "live"));
			if (live.length > WORKFLOW_LIMITS.maxLiveRuns) {
				throw Object.assign(new Error("Too many live or awaiting-delivery workflows; inspect or finish existing runs first"), { code: "WORKFLOW_LIVE_LIMIT" });
			}
			const unknown = newest(merged.filter((entry) => entry.state === "unknown"));
			if (unknown.length > WORKFLOW_LIMITS.maxHistoryRuns + WORKFLOW_LIMITS.maxActionableHistoryRuns) {
				throw new Error("workflow recovery index exceeds its unknown-run bound");
			}
			const allArchived = newest(merged.filter((entry) => entry.state === "archived"));
			const ordinaryArchived = [];
			const actionableArchived = newest(merged.filter((entry) => entry.state === "actionable"));
			const markerScanBudget = {
				entries: 0,
				bytes: 0,
				deadline: Date.now() + WORKTREE_INDEX_SCAN_TIMEOUT_MS,
			};
			for (const entry of allArchived) {
				if (await archivedRunHasManagedWorktree(root, entry.id, markerScanBudget)) actionableArchived.push(entry);
				else ordinaryArchived.push(entry);
			}
			if (actionableArchived.length > WORKFLOW_LIMITS.maxActionableHistoryRuns) {
				throw Object.assign(new Error("Too many archived workflows still have managed worktrees; apply or remove existing worktrees first"), { code: "WORKFLOW_ACTIONABLE_HISTORY_LIMIT" });
			}
			if (live.length + actionableArchived.length > WORKFLOW_LIMITS.maxActionableHistoryRuns) {
				throw Object.assign(new Error("Live and retained-worktree workflow recovery is at capacity; apply retained worktrees before launching more workflows"), { code: "WORKFLOW_ACTIONABLE_HISTORY_LIMIT" });
			}
			const maximum = WORKFLOW_LIMITS.maxLiveRuns + WORKFLOW_LIMITS.maxHistoryRuns + WORKFLOW_LIMITS.maxActionableHistoryRuns;
			const recoveryCriticalCount = live.length + unknown.length + actionableArchived.length;
			if (recoveryCriticalCount > maximum) {
				throw Object.assign(new Error("Workflow recovery history is at capacity; inspect or finish recovery-unknown workflows first"), { code: "WORKFLOW_HISTORY_LIMIT" });
			}
			// Ordinary completed history is the only safely-evictable category. Trim it
			// below its normal per-state cap when recovery-critical states need the shared
			// reader capacity, while always retaining managed worktrees and live recovery.
			const archived = ordinaryArchived.slice(0, Math.min(WORKFLOW_LIMITS.maxHistoryRuns, maximum - recoveryCriticalCount));
			const next = newest([...live, ...unknown, ...archived, ...actionableArchived]);
			await atomicJson(indexFile, { version: WORKFLOW_HISTORY_INDEX_VERSION, runs: next }, { onPublished: () => { published = true; } });
			const retainedIds = new Set(next.map((entry) => entry.id));
			const evictedArchived = merged.filter((entry) => entry.state === "archived" && !retainedIds.has(entry.id));
			for (const entry of evictedArchived) {
				// IDs are validated above and the root is fixed by the journal. `rm`
				// removes a malicious symlink itself rather than following it.
				await fs.rm(path.join(root, entry.id), { recursive: true, force: true });
				await syncDirectory(root);
			}
			} finally { await release(); }
		} catch (error) {
			if (error && typeof error === "object") error.workflowHistoryIndexPublished = published;
			throw error;
		}
	});
	historyIndexTails.set(root, operation);
	try { await operation; }
	finally { if (historyIndexTails.get(root) === operation) historyIndexTails.delete(root); }
}

export async function indexWorkflowHistoryCandidate(root, entry) {
	if (!entry || typeof entry !== "object") throw new Error("workflow history candidate is invalid");
	const state = ["archived", "actionable"].includes(entry.state) ? entry.state : "live";
	await updateHistoryIndex(path.resolve(root), safeRunId(entry.id), typeof entry.createdAt === "string" ? entry.createdAt : "", state);
}

export async function discoverWorkflowHistoryCandidates(root) {
	let directory;
	try { directory = await fs.opendir(root); }
	catch (error) { if (error?.code === "ENOENT") return []; throw error; }
	const candidates = [];
	// The durable index is capped at the steady-state reader bound, but a process
	// can crash after creating its run directory or after publishing an eviction
	// and before deleting the evicted directory. Allow one bounded live-run cohort
	// of crash-window slack so startup can reconcile those directories in place.
	const maximum = WORKFLOW_LIMITS.maxLiveRuns + WORKFLOW_LIMITS.maxHistoryRuns + WORKFLOW_LIMITS.maxActionableHistoryRuns + WORKFLOW_LIMITS.maxLiveRuns;
	const deadline = Date.now() + HISTORY_DISCOVERY_TIMEOUT_MS;
	let scanned = 0;
	for await (const entry of directory) {
		scanned += 1;
		if (scanned > HISTORY_DISCOVERY_MAX_ENTRIES || Date.now() >= deadline) throw Object.assign(new Error("workflow run discovery exceeded its bounded scan"), { code: "WORKFLOW_HISTORY_SCAN_LIMIT" });
		if (entry.isSymbolicLink?.()) throw new Error("workflow run discovery encountered a symlink");
		if (!entry.isDirectory()) {
			const interruptedIndexWrite = /^index\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u.test(entry.name);
			if (entry.isFile() && (entry.name === "index.json" || interruptedIndexWrite || /^\.\.?(?:index|history-recovery)\.lock(?:\.|$)/u.test(entry.name))) continue;
			throw new Error(`workflow run discovery encountered an invalid state entry: ${entry.name}`);
		}
		let id;
		try { id = safeRunId(entry.name); }
		catch {
				if (/^\.\.?(?:index|history-recovery)\.lock(?:\.|$)/u.test(entry.name)) continue;
			throw new Error("workflow run discovery encountered an invalid directory");
		}
		candidates.push({ id, createdAt: "", state: "unknown" });
		if (candidates.length > maximum) {
			throw new Error("workflow run directory exceeds its bounded recovery capacity");
		}
	}
	return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

export async function replaceWorkflowHistoryIndex(root, entries) {
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const maximum = WORKFLOW_LIMITS.maxLiveRuns + WORKFLOW_LIMITS.maxHistoryRuns + WORKFLOW_LIMITS.maxActionableHistoryRuns;
	if (!Array.isArray(entries) || entries.length > maximum) throw new Error("replacement workflow history index exceeds its entry bound");
	const runs = entries.map((entry) => ({
		id: safeRunId(entry?.id),
		createdAt: typeof entry?.createdAt === "string" && entry.createdAt.length <= 64 ? entry.createdAt : "",
		state: ["live", "archived", "actionable", "unknown"].includes(entry?.state) ? entry.state : "unknown",
	}));
	const release = await acquireOwnershipLock(path.join(root, ".index.lock"), { timeoutMs: 30_000 });
	try { await atomicJson(path.join(root, "index.json"), { version: WORKFLOW_HISTORY_INDEX_VERSION, runs }); }
	finally { await release(); }
}

export async function writeWorkflowRecoveryFallback(directory, snapshot) {
	if (!snapshot || typeof snapshot !== "object" || typeof snapshot.id !== "string") throw new Error("workflow recovery fallback snapshot is invalid");
	await atomicJson(path.join(path.resolve(directory), "recovery.json"), {
		version: WORKFLOW_RECOVERY_FALLBACK_VERSION,
		snapshot,
	});
}

export async function readWorkflowRecoveryFallback(directory, options = {}) {
	const maximum = Math.max(1, Math.min(WORKFLOW_RECOVERY_FALLBACK_BYTES, options.maxBytes ?? WORKFLOW_RECOVERY_FALLBACK_BYTES));
	const read = await readBoundedFile(path.join(path.resolve(directory), "recovery.json"), maximum);
	try {
		const parsed = JSON.parse(read.text);
		if (parsed?.version !== WORKFLOW_RECOVERY_FALLBACK_VERSION || !parsed.snapshot || typeof parsed.snapshot.id !== "string") {
			throw new Error("workflow recovery fallback is invalid");
		}
		let exact = isExactRecoverySnapshot(parsed.snapshot);
		if (exact) {
			try { await assertDirectoryIdentity(directory, parsed.snapshot.runDirectoryIdentity); }
			catch { exact = false; }
		}
		return { snapshot: parsed.snapshot, bytes: read.bytes, exact };
	} catch (error) { throw readFailure(error, read.bytes); }
}

export async function writeWorkflowLaunchCommit(directory, runId, expectedDirectoryIdentity, options = {}) {
	const id = safeRunId(runId);
	const resolved = path.resolve(directory);
	await ensureWorkflowPrivateDirectory(resolved);
	const identity = await assertDirectoryIdentity(resolved, expectedDirectoryIdentity);
	await atomicJson(path.join(resolved, "launch-committed.json"), {
		version: WORKFLOW_LAUNCH_COMMIT_VERSION,
		id,
		runDirectoryIdentity: identity,
	}, { onPublished: options.onPublished });
}

export async function readWorkflowLaunchCommit(directory, runId) {
	const id = safeRunId(runId);
	let read;
	try { read = await readBoundedFile(path.join(path.resolve(directory), "launch-committed.json"), WORKFLOW_LAUNCH_COMMIT_BYTES); }
	catch (error) {
		if (error?.code === "ENOENT") return { committed: false, bytes: 0 };
		throw error;
	}
	try {
		const parsed = JSON.parse(read.text);
		if (parsed?.version !== WORKFLOW_LAUNCH_COMMIT_VERSION || parsed.id !== id || !validDirectoryIdentity(parsed.runDirectoryIdentity)) {
			throw new Error("workflow launch commit marker is invalid");
		}
		await assertDirectoryIdentity(directory, parsed.runDirectoryIdentity);
		return { committed: true, bytes: read.bytes };
	} catch (error) { throw readFailure(error, read.bytes); }
}

export async function readWorkflowHistoryIndex(root) {
	let read;
	try { read = await readBoundedFile(path.join(root, "index.json"), WORKFLOW_HISTORY_INDEX_BYTES); }
	catch (error) { if (error?.code === "ENOENT") return []; throw error; }
	const parsed = JSON.parse(read.text);
	if (parsed?.version !== WORKFLOW_HISTORY_INDEX_VERSION || !Array.isArray(parsed.runs)) {
		throw new Error("unsupported or invalid workflow history index");
	}
	if (parsed.runs.length > WORKFLOW_LIMITS.maxLiveRuns + WORKFLOW_LIMITS.maxHistoryRuns + WORKFLOW_LIMITS.maxActionableHistoryRuns) {
		throw new Error("workflow history index exceeds its entry bound");
	}
	return parsed.runs.map((entry) => ({
		id: safeRunId(entry?.id),
		createdAt: typeof entry?.createdAt === "string" ? entry.createdAt : "",
		state: ["live", "archived", "actionable", "unknown"].includes(entry?.state) ? entry.state : "live",
	}));
}

export class WorkflowJournal {
	constructor(root, runId) {
		this.root = path.resolve(root);
		this.runId = safeRunId(runId);
		this.directory = path.join(this.root, this.runId);
		this.metaFile = path.join(this.directory, "meta.json");
		this.eventsFile = path.join(this.directory, "events.jsonl");
		this.sequence = 0;
		this.previousChecksum = "0".repeat(64);
		this.bytes = 0;
		this.tail = Promise.resolve();
		this.handle = undefined;
		this.indexed = false;
		this.directoryIdentity = undefined;
	}

	async initialize(meta) {
		const parent = path.dirname(this.root);
		await ensureWorkflowPrivateDirectory(parent);
		await ensureWorkflowPrivateDirectory(this.root);
		let directoryCreated = false;
		try { await fs.mkdir(this.directory, { mode: 0o700 }); directoryCreated = true; }
		catch (error) { if (error?.code !== "EEXIST") throw error; }
		if (directoryCreated) await syncDirectory(this.root);
		await ensureWorkflowPrivateDirectory(this.directory);
		this.directoryIdentity = await directoryIdentity(this.directory);
		const initialMeta = { version: WORKFLOW_JOURNAL_VERSION, ...meta, runDirectoryIdentity: this.directoryIdentity };
		if (Buffer.byteLength(JSON.stringify(initialMeta), "utf8") > WORKFLOW_LIMITS.maxJournalMetaBytes) throw new Error("workflow journal metadata exceeds its size limit");
		await atomicJson(this.metaFile, initialMeta);
		// Treat publication as potentially committed before awaiting it: a rename
		// can succeed and its following directory fsync can fail. The manager's
		// failed-start cleanup therefore always issues an idempotent index removal
		// before deleting this directory or releasing the live run lease.
		this.indexed = true;
		try {
			await updateHistoryIndex(this.root, this.runId, typeof meta?.createdAt === "string" ? meta.createdAt : new Date().toISOString(), "live");
		} catch (error) {
			// A pre-publication capacity/read/write failure is conclusively absent
			// from the index and may preserve the historical direct-Journal cleanup
			// behavior. Post-rename failures stay intact for lease-owning manager
			// rollback, which must issue a durable idempotent removal.
			if (error?.workflowHistoryIndexPublished === false && directoryCreated) {
				await fs.rm(this.directory, { recursive: true, force: true });
				await syncDirectory(this.root);
				this.indexed = false;
			}
			throw error;
		}
		try {
			this.handle = await fs.open(this.eventsFile, "wx", 0o600);
			await this.handle.sync();
			await syncDirectory(this.directory);
		} catch (error) {
			// Do not perform a best-effort rollback here. The caller owns the run
			// lease and must keep it until durable index removal, directory deletion,
			// and parent fsync all succeed (or remain retryable at shutdown).
			throw error;
		}
	}

	async markArchived(createdAt) {
		await updateHistoryIndex(this.root, this.runId, typeof createdAt === "string" ? createdAt : new Date().toISOString(), "archived");
	}

	async removeFromIndex(createdAt) {
		await updateHistoryIndex(this.root, this.runId, typeof createdAt === "string" ? createdAt : new Date().toISOString(), "remove");
		this.indexed = false;
	}

	append(event, options = {}) {
		const operation = async () => {
			if (!this.handle) throw new Error("workflow journal is not initialized");
			if (this.writeFailure) throw this.writeFailure;
			const sequence = this.sequence + 1;
			const hash = checksum(this.previousChecksum, sequence, event);
			const record = { sequence, previousChecksum: this.previousChecksum, checksum: hash, event };
			const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
			const nextBytes = this.bytes + line.length;
			if (nextBytes > WORKFLOW_LIMITS.maxJournalBytes) throw new Error("workflow journal size limit exceeded");
			try {
				let offset = 0;
				while (offset < line.length) {
					const { bytesWritten } = await this.handle.write(line, offset, line.length - offset);
					if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw new Error("workflow journal append made no progress");
					offset += bytesWritten;
				}
				if (options.durable === true) await this.handle.sync();
			} catch (cause) {
				// The file may now end in a partial record. Fence all later appends so a
				// valid-looking record can never be written after that corrupt tail.
				this.writeFailure = Object.assign(new Error(`workflow journal append failed: ${cause.message ?? cause}`, { cause }), { code: "WORKFLOW_JOURNAL_FAILED" });
				throw this.writeFailure;
			}
			this.sequence = sequence;
			this.bytes = nextBytes;
			this.previousChecksum = hash;
			return record;
		};
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}

	async updateMeta(fields) {
		const operation = async () => {
			const { meta: current } = await readWorkflowJournalMeta(this.directory, { maxBytes: WORKFLOW_LIMITS.maxJournalMetaBytes });
			const next = { ...current, ...fields };
			if (Buffer.byteLength(JSON.stringify(next), "utf8") > WORKFLOW_LIMITS.maxJournalMetaBytes) throw new Error("workflow journal metadata exceeds its size limit");
			await atomicJson(this.metaFile, next);
		};
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return await result;
	}

	async replaceMetaForRecovery(fields) {
		const operation = async () => {
			const runDirectoryIdentity = await directoryIdentity(this.directory);
			const next = { version: WORKFLOW_JOURNAL_VERSION, ...fields, id: this.runId, runDirectoryIdentity };
			if (Buffer.byteLength(JSON.stringify(next), "utf8") > WORKFLOW_LIMITS.maxJournalMetaBytes) throw new Error("workflow journal metadata exceeds its size limit");
			await atomicJson(this.metaFile, next);
		};
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return await result;
	}

	async close() {
		await this.tail;
		if (!this.handle) return;
		const handle = this.handle;
		let syncError;
		try { await handle.sync(); }
		catch (error) { syncError = error; }
		try { await handle.close(); }
		catch (closeError) {
			if (syncError) throw new AggregateError([syncError, closeError], "Workflow journal sync and close both failed");
			throw closeError;
		}
		if (this.handle === handle) this.handle = undefined;
		if (syncError) {
			try { Object.defineProperty(syncError, "journalHandleClosed", { value: true }); } catch {}
			throw syncError;
		}
	}
}

export async function readWorkflowJournalMeta(directory, options = {}) {
	const maximum = Math.max(1, Math.min(WORKFLOW_LIMITS.maxJournalMetaBytes, options.maxBytes ?? WORKFLOW_LIMITS.maxJournalMetaBytes));
	const read = await readBoundedFile(path.join(path.resolve(directory), "meta.json"), maximum);
	try {
		const meta = JSON.parse(read.text);
		if (meta.version !== WORKFLOW_JOURNAL_VERSION) throw new Error(`unsupported workflow journal version ${meta.version}`);
		await assertDirectoryIdentity(directory, meta.runDirectoryIdentity);
		return { meta, bytes: read.bytes };
	} catch (error) { throw readFailure(error, read.bytes); }
}

export async function readWorkflowJournal(directory, options = {}) {
	const maximum = Math.max(1, options.maxBytes ?? 128 * 1024 * 1024);
	const eventsFile = path.join(directory, "events.jsonl");
	const metaRead = await readWorkflowJournalMeta(directory, { maxBytes: maximum });
	let eventsRead;
	try {
		const meta = metaRead.meta;
		eventsRead = await readBoundedFile(eventsFile, maximum - metaRead.bytes, { optional: true });
		await assertDirectoryIdentity(directory, meta.runDirectoryIdentity);
		const text = eventsRead.text;
		const records = [];
		let previous = "0".repeat(64);
		let expected = 1;
		const lines = text.split("\n");
		const hasPartialTail = text.length > 0 && !text.endsWith("\n");
		let truncated = false;
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			if (!line) {
				if (index === lines.length - 1) continue;
				throw Object.assign(new Error(`workflow journal contains an empty record at sequence ${expected}`), { code: "WORKFLOW_JOURNAL_CORRUPT" });
			}
			let record;
			try { record = JSON.parse(line); }
			catch (error) {
				if (hasPartialTail && index === lines.length - 1) { truncated = true; break; }
				throw Object.assign(new Error(`workflow journal contains malformed JSON at sequence ${expected}`, { cause: error }), { code: "WORKFLOW_JOURNAL_CORRUPT" });
			}
			if (record.sequence !== expected || record.previousChecksum !== previous ||
				record.checksum !== checksum(previous, record.sequence, record.event)) {
				if (hasPartialTail && index === lines.length - 1) { truncated = true; break; }
				throw Object.assign(new Error(`workflow journal checksum chain is invalid at sequence ${expected}`), { code: "WORKFLOW_JOURNAL_CORRUPT" });
			}
			records.push(record);
			previous = record.checksum;
			expected += 1;
		}
		return { meta, records, truncated, bytes: metaRead.bytes + eventsRead.bytes };
	} catch (error) { throw readFailure(error, metaRead.bytes + (eventsRead?.bytes ?? 0)); }
}
