import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBoundedHandle } from "./durability.mjs";
import { ensureWorkflowPrivateDirectory } from "./state-root.mjs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROCESS_STARTED_AT = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();
const PS_PATH = process.platform === "win32" ? undefined : existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
const RECLAIM_MISSING_OWNER_GRACE_MS = 5000;
// A worker supervisor detects manager-pipe EOF and has a 3.5s bounded
// TERM/KILL/descendant-confirmation window. Never let a restarted cc reclaim
// locks solely from the manager PID before that old supervisor has had ample
// time to finish fencing its backend tree.
const RECLAIM_DEAD_OWNER_GRACE_MS = 10_000;
const ORPHAN_CLAIM_SCAN_MAX_ENTRIES = 10_000;
const ORPHAN_CLAIM_SCAN_TIMEOUT_MS = 5000;
const pendingReclaimReleases = new Set();
const pendingOwnershipReleases = new Set();
export const OWNERSHIP_LOCK_TEST_ONLY = Symbol("cc.workflow.ownership-lock.test-only");

async function finishReclaimRelease(release) {
	try {
		await release();
		pendingReclaimReleases.delete(release);
	} catch (error) {
		pendingReclaimReleases.add(release);
		throw error;
	}
}

async function retryPendingReclaimReleases() {
	const results = await Promise.allSettled([...pendingReclaimReleases].map((release) => finishReclaimRelease(release)));
	const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
	if (failures.length > 0) throw new AggregateError(failures, "workflow reclaim gates from a previous lock operation could not be released");
}

export async function retryOwnershipLockReleases() {
	const results = await Promise.allSettled([...pendingOwnershipReleases].map((release) => release()));
	const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
	if (failures.length > 0) throw new AggregateError(failures, "workflow ownership locks from a previous operation could not be released");
}

function abortError(reason = "Lock acquisition cancelled") {
	if (reason instanceof Error) return reason;
	const error = new Error(String(reason));
	error.name = "AbortError";
	return error;
}

const delay = (milliseconds, signal) => new Promise((resolve, reject) => {
	if (signal?.aborted) { reject(abortError(signal.reason)); return; }
	const finish = (callback, value) => { signal?.removeEventListener("abort", onAbort); callback(value); };
	const timer = setTimeout(() => finish(resolve), milliseconds);
	const onAbort = () => { clearTimeout(timer); finish(reject, abortError(signal.reason)); };
	signal?.addEventListener("abort", onAbort, { once: true });
});

async function processStartMarker(pid, signal) {
	if (process.platform === "win32") {
		const systemRoot = process.env.SystemRoot || process.env.WINDIR;
		const powershell = systemRoot
			? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: "powershell.exe";
		try {
			const { stdout } = await execFileAsync(powershell, [
				"-NoProfile", "-NonInteractive", "-Command",
				`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
			], { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true, signal });
			return stdout.trim() || undefined;
		} catch {
			if (signal?.aborted) throw abortError(signal.reason);
			return undefined;
		}
	}
	if (!PS_PATH) return undefined;
	try {
		const { stdout } = await execFileAsync(PS_PATH, ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", windowsHide: true,
			env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" }, signal,
		});
		return stdout.trim() || undefined;
	} catch {
		if (signal?.aborted) throw abortError(signal.reason);
		return undefined;
	}
}

let ownStartMarkerPromise;
function ownStartMarker() {
	ownStartMarkerPromise ??= processStartMarker(process.pid);
	return ownStartMarkerPromise;
}

async function ownerIsDemonstrablyDead(owner, stat, signal) {
	if (signal?.aborted) throw abortError(signal.reason);
	if (!Number.isSafeInteger(owner?.pid) || owner.pid < 1) return false;
	try { process.kill(owner.pid, 0); }
	catch (error) {
		if (error?.code === "ESRCH") return true;
		return false;
	}
	if (!owner.processStartMarker) return false;
	const liveMarker = await processStartMarker(owner.pid, signal);
	return Boolean(liveMarker && liveMarker !== owner.processStartMarker);
}

async function readLockOwner(lockFile) {
	const before = await fs.lstat(lockFile);
	if (!before.isFile() || before.isSymbolicLink()) throw new Error("workflow ownership lock is invalid");
	const handle = await fs.open(lockFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 2 || stat.size > 4096) throw new Error("workflow ownership lock is invalid");
		return { owner: JSON.parse((await readBoundedHandle(handle, 4096, "workflow ownership lock is invalid")).toString("utf8")), stat };
	} finally { await handle.close(); }
}

async function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

async function cleanupOrphanClaims(lockFile, { deadline, signal } = {}) {
	const directory = path.dirname(lockFile);
	const basename = path.basename(lockFile);
	const prefix = `.${basename}.`;
	let entries;
	try { entries = await fs.opendir(directory); }
	catch (error) { if (error?.code === "ENOENT") return; throw error; }
	let scanned = 0;
	for await (const entry of entries) {
		if (signal?.aborted) throw abortError(signal.reason);
		scanned += 1;
		if (scanned > ORPHAN_CLAIM_SCAN_MAX_ENTRIES || Date.now() >= deadline) return;
		if (!entry.name.startsWith(prefix) || !entry.name.endsWith(".claim")) continue;
		const candidate = path.join(directory, entry.name);
		let stat;
		try { stat = await fs.lstat(candidate); }
		catch (error) { if (error?.code === "ENOENT") continue; throw error; }
		if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
		let removable = false;
		try {
			const { owner } = await readLockOwner(candidate);
			const expected = `${prefix}${owner.pid}.${owner.token}.claim`;
			removable = entry.name === expected && await ownerIsDemonstrablyDead(owner, stat, signal);
		} catch (error) {
			if (signal?.aborted) throw abortError(signal.reason);
			// A crash can interrupt the claim write itself. Only reap an unlinked,
			// unchanged malformed inode after a grace period.
			removable = Date.now() - stat.mtimeMs >= RECLAIM_MISSING_OWNER_GRACE_MS;
		}
		if (!removable) continue;
		try {
			const latest = await fs.lstat(candidate);
			if (latest.nlink === 1 && await sameFile(latest, stat)) await fs.unlink(candidate);
		} catch (error) { if (error?.code !== "ENOENT") throw error; }
	}
}

async function readReclaimOwner(directory) {
	const directoryStat = await fs.lstat(directory);
	if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error("workflow reclaim gate is invalid");
	try {
		const { owner } = await readLockOwner(path.join(directory, "owner.json"));
		return { owner, directoryStat };
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
		return { owner: undefined, directoryStat };
	}
}

async function acquireReclaimGate(directory, owner, deadline, signal) {
	const candidate = `${directory}.${process.pid}.${owner.token}.claim`;
	await fs.mkdir(candidate, { mode: 0o700 });
	try {
		let handle;
		try {
			handle = await fs.open(path.join(candidate, "owner.json"), "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(owner)}\n`);
			await handle.sync();
		} finally { await handle?.close(); }
		while (true) {
			try {
				await fs.rename(candidate, directory);
				break;
			} catch (error) {
				if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
				let occupied;
				try { occupied = await readReclaimOwner(directory); }
				catch (inspectError) {
					if (inspectError?.code === "ENOENT") continue;
					throw inspectError;
				}
				const age = Date.now() - occupied.directoryStat.mtimeMs;
				const recoverable = occupied.owner
					? await ownerIsDemonstrablyDead(occupied.owner, occupied.directoryStat)
					: age >= RECLAIM_MISSING_OWNER_GRACE_MS;
				if (recoverable) {
					// Re-read immediately before removal. A populated gate is published by
					// one rename, so missing metadata is only a legacy/crash remnant.
					const latest = await readReclaimOwner(directory).catch((latestError) => {
						if (latestError?.code === "ENOENT") return undefined;
						throw latestError;
					});
					if (!latest) continue;
					const sameGate = await sameFile(latest.directoryStat, occupied.directoryStat);
					const sameOwner = latest.owner?.token === occupied.owner?.token;
					const stillRecoverable = latest.owner
						? sameOwner && await ownerIsDemonstrablyDead(latest.owner, latest.directoryStat)
						: Date.now() - latest.directoryStat.mtimeMs >= RECLAIM_MISSING_OWNER_GRACE_MS;
					if (sameGate && stillRecoverable) await fs.rm(directory, { recursive: true, force: true });
					continue;
				}
				if (Date.now() >= deadline) throw Object.assign(new Error("timed out acquiring workflow ownership lock"), { code: "WORKFLOW_LOCK_TIMEOUT" });
				await delay(25, signal);
			}
		}
		let released = false;
		let releasePromise;
		return async () => {
			if (released) return;
			if (!releasePromise) releasePromise = (async () => {
				const occupied = await readReclaimOwner(directory);
				if (occupied.owner?.token !== owner.token) throw new Error("workflow reclaim gate changed before release");
				await fs.rm(directory, { recursive: true });
				released = true;
			})();
			try { await releasePromise; }
			catch (error) { releasePromise = undefined; throw error; }
		};
	} finally {
		await fs.rm(candidate, { recursive: true, force: true }).catch(() => {});
	}
}

/**
 * Acquire an inter-process lock using an already-written claim hard-linked into
 * the well-known lock path. The link is the atomic ownership transition, so a
 * crash can never leave a half-written lock whose owner cannot be identified.
 */
export async function acquireOwnershipLock(lockFile, options = {}) {
	const resolved = path.resolve(lockFile);
	if (options.signal?.aborted) throw abortError(options.signal.reason);
	await retryPendingReclaimReleases();
	await retryOwnershipLockReleases();
	const deadline = Date.now() + (options.timeoutMs ?? 2 * 60 * 60 * 1000);
	const testGrace = options[OWNERSHIP_LOCK_TEST_ONLY]?.deadOwnerGraceMs;
	const deadOwnerGraceMs = Number.isSafeInteger(testGrace) && testGrace >= 1 && testGrace <= RECLAIM_DEAD_OWNER_GRACE_MS
		? testGrace
		: RECLAIM_DEAD_OWNER_GRACE_MS;
	await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
	if (Date.now() < deadline) {
		await cleanupOrphanClaims(resolved, {
			deadline: Math.min(deadline, Date.now() + ORPHAN_CLAIM_SCAN_TIMEOUT_MS),
			signal: options.signal,
		});
	}
	const token = randomUUID();
	const claim = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${token}.claim`);
	const owner = {
		version: 1, token, pid: process.pid, processStartedAt: PROCESS_STARTED_AT,
		processStartMarker: await ownStartMarker(), createdAt: new Date().toISOString(),
	};
	let claimHandle;
	try {
		claimHandle = await fs.open(claim, "wx", 0o600);
		await claimHandle.writeFile(`${JSON.stringify(owner)}\n`);
		await claimHandle.sync();
	} finally { await claimHandle?.close(); }
	const claimStat = await fs.lstat(claim);
	try {
		let attempted = false;
		while (true) {
			if (options.signal?.aborted) throw abortError(options.signal.reason);
			// A zero timeout means "one non-blocking acquisition attempt", not "fail
			// before inspecting the lock". Enforce the deadline only on retries.
			if (attempted && Date.now() >= deadline) throw Object.assign(new Error("timed out acquiring workflow ownership lock"), { code: "WORKFLOW_LOCK_TIMEOUT" });
			attempted = true;
			try {
				await fs.link(claim, resolved);
				break;
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				try {
					const occupied = await readLockOwner(resolved);
					if (await ownerIsDemonstrablyDead(occupied.owner, occupied.stat)) {
						const reclaimDirectory = `${resolved}.reclaim`;
						const releaseReclaim = await acquireReclaimGate(reclaimDirectory, owner, deadline, options.signal);
						try {
							const latest = await readLockOwner(resolved);
							if (!await sameFile(latest.stat, occupied.stat) || latest.owner?.token !== occupied.owner?.token || !await ownerIsDemonstrablyDead(latest.owner, latest.stat)) continue;
							// The reclaim gate is the atomic first-death-observation fence. Hold it
							// throughout a fresh grace interval so an old supervisor can finish its
							// EOF-triggered backend-tree shutdown even when the lock itself is old.
							const graceEndsAt = Date.now() + deadOwnerGraceMs;
							await delay(Math.max(0, Math.min(graceEndsAt, deadline) - Date.now()), options.signal);
							if (Date.now() < graceEndsAt) continue;
							const confirmed = await readLockOwner(resolved);
							if (confirmed.owner?.token === occupied.owner?.token && await sameFile(confirmed.stat, occupied.stat) && await ownerIsDemonstrablyDead(confirmed.owner, confirmed.stat)) {
								await fs.unlink(resolved).catch((unlinkError) => { if (unlinkError?.code !== "ENOENT") throw unlinkError; });
								const abandonedClaim = path.join(
									path.dirname(resolved),
									`.${path.basename(resolved)}.${confirmed.owner.pid}.${confirmed.owner.token}.claim`,
								);
								try {
									const abandonedStat = await fs.lstat(abandonedClaim);
									if (await sameFile(abandonedStat, confirmed.stat)) await fs.unlink(abandonedClaim);
								} catch (claimError) {
									if (claimError?.code !== "ENOENT") throw claimError;
								}
							}
						} finally { await finishReclaimRelease(releaseReclaim); }
						continue;
					}
				} catch (inspectError) {
					if (inspectError?.code === "ENOENT") continue;
					throw inspectError;
				}
				if (Date.now() >= deadline) throw Object.assign(new Error("timed out acquiring workflow ownership lock"), { code: "WORKFLOW_LOCK_TIMEOUT" });
				await delay(25, options.signal);
			}
		}
		let released = false;
		let releasePromise;
		const releaseOwnership = async () => {
			if (released) return;
			if (!releasePromise) releasePromise = (async () => {
				const occupied = await readLockOwner(resolved);
				if (occupied.owner?.token !== token || !(await sameFile(occupied.stat, claimStat))) {
					throw new Error("workflow ownership lock changed before release");
				}
				await fs.unlink(resolved);
				released = true;
				pendingOwnershipReleases.delete(releaseOwnership);
				await fs.unlink(claim).catch(() => {});
			})();
			try { await releasePromise; }
			catch (error) {
				// Keep both the published lock and its claim retryable after transient
				// validation/unlink failures. Once the published unlink succeeds,
				// `released` is authoritative and claim cleanup is best-effort.
				releasePromise = undefined;
				pendingOwnershipReleases.add(releaseOwnership);
				throw error;
			}
		};
		return releaseOwnership;
	} catch (error) {
		await fs.unlink(claim).catch(() => {});
		throw error;
	}
}

export async function acquireWorkflowRunLease(stateRoot, runId, options = {}) {
	const id = String(runId ?? "");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(id) || id === "." || id === "..") throw new Error("workflow run id is invalid");
	const root = path.resolve(stateRoot);
	await ensureWorkflowPrivateDirectory(root);
	const directory = path.join(root, "workflow-run-leases");
	await ensureWorkflowPrivateDirectory(directory);
	return acquireOwnershipLock(path.join(directory, `${id}.lock`), options);
}

export async function workflowRepositoryLockRoot() {
	// Repository mutation locks must converge even when two cc processes have
	// different TMPDIR/TEMP or settings overrides. `os.userInfo()` is resolved
	// from the operating-system account rather than those process environments.
	const account = os.userInfo();
	const root = path.join(account.homedir, ".cc-workflow-repository-locks");
	try { await fs.mkdir(root, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
	const stat = await fs.lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) || (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
		throw new Error("workflow repository lock root must be an owned private directory");
	}
	return await fs.realpath(root);
}
