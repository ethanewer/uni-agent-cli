import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boundedWorkflowText, WORKFLOW_LIMITS } from "./types.mjs";
import { readBoundedHandle, syncDirectory } from "./durability.mjs";
import { acquireOwnershipLock, acquireWorkflowRunLease } from "./ownership-lock.mjs";
import { ensureWorkflowPrivateDirectory } from "./state-root.mjs";
import { trustedExecutableOnPath, userControlledPathRoots } from "./trusted-executable.mjs";

const GIT_OUTPUT_LIMIT = 32 * 1024 * 1024;
const WORKER_TRACKING_FAILURE_EXIT = 86;
const CHILD_ENVIRONMENT_MAX_BYTES = 1024 * 1024;
const ORPHAN_RECOVERY_LIMIT = 2048;
// Reconciliation performs several independently supervised Git validations
// under one aggregate deadline. Give that complete sequence the same bounded
// budget as an ordinary Git operation so loaded macOS runners do not retain a
// clean orphan merely because setup consumed the former 30-second allowance.
const ORPHAN_RECOVERY_TIMEOUT_MS = WORKFLOW_LIMITS.gitOperationTimeoutMs;
const ORPHAN_DISCOVERY_MAX_ENTRIES = 50_000;
const APPLY_PATH_LIMIT = 10_000;
const DISABLED_HOOKS_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
const WORKFLOW_WORKER_SUPERVISOR = fileURLToPath(new URL("./worker-supervisor.mjs", import.meta.url));

function credentialBearingUrl(value) {
	if (typeof value !== "string" || !value.includes("://")) return false;
	try {
		const parsed = new URL(value);
		return Boolean(parsed.username || parsed.password || parsed.search || parsed.hash);
	} catch { return true; }
}

function credentialFreeGitEnvironment(environment = process.env) {
	const scrubbed = {};
	for (const [name, value] of Object.entries(environment)) {
		if (/^GIT_/iu.test(name) || /(?:key|token|secret|password|credential|auth)/iu.test(name) ||
			/(?:^|_)pat(?:_|$)/iu.test(name) || /^npm_config_.*(?:auth|token|userconfig|globalconfig)/iu.test(name) ||
			/[\r\n]/u.test(String(value ?? "")) || credentialBearingUrl(value)) continue;
		scrubbed[name] = value;
	}
	scrubbed.PATH = "/usr/bin:/bin";
	scrubbed.LANG = "C";
	scrubbed.LC_ALL = "C";
	scrubbed.GIT_NO_REPLACE_OBJECTS = "1";
	scrubbed.GIT_TERMINAL_PROMPT = "0";
	return scrubbed;
}

let trustedWorkflowGit;
function workflowGitExecutable() {
	if (trustedWorkflowGit) return trustedWorkflowGit;
	const resolutionEnvironment = credentialFreeGitEnvironment();
	resolutionEnvironment.PATH = [process.env.PATH, "/usr/bin", "/bin"].filter(Boolean).join(path.delimiter);
	trustedWorkflowGit = trustedExecutableOnPath("git", resolutionEnvironment, userControlledPathRoots(process.cwd()), {
		requireRootOwnership: true,
	});
	return trustedWorkflowGit;
}

function boundedLexicalCandidate(heap, candidate, limit) {
	const greater = (left, right) => left.key > right.key;
	const siftUp = (index) => {
		while (index > 0) {
			const parent = Math.floor((index - 1) / 2);
			if (!greater(heap[index], heap[parent])) break;
			[heap[index], heap[parent]] = [heap[parent], heap[index]];
			index = parent;
		}
	};
	const siftDown = (index) => {
		while (true) {
			const left = index * 2 + 1;
			const right = left + 1;
			let largest = index;
			if (left < heap.length && greater(heap[left], heap[largest])) largest = left;
			if (right < heap.length && greater(heap[right], heap[largest])) largest = right;
			if (largest === index) return;
			[heap[index], heap[largest]] = [heap[largest], heap[index]];
			index = largest;
		}
	};
	if (heap.length < limit) {
		heap.push(candidate);
		siftUp(heap.length - 1);
		return;
	}
	if (candidate.key >= heap[0].key) return;
	heap[0] = candidate;
	siftDown(0);
}

async function assertProjectDirectoryIdentity(cwd, expected) {
	if (!expected) return;
	const canonical = path.resolve(expected.canonicalRoot);
	if (path.resolve(cwd) !== canonical) throw Object.assign(new Error("workflow project path changed before worktree creation"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
	const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	try {
		const stat = await handle.stat({ bigint: true });
		if (!stat.isDirectory() || String(stat.dev) !== String(expected.device) || String(stat.ino) !== String(expected.inode)) {
			throw Object.assign(new Error("workflow project identity changed before worktree creation"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
		}
	} finally { await handle.close(); }
}

const POSIX_PS = process.platform === "win32" ? undefined
	: existsSync("/bin/ps") ? "/bin/ps" : existsSync("/usr/bin/ps") ? "/usr/bin/ps" : undefined;

function refreshPosixDescendants(rootPid, tracked, psPath = POSIX_PS) {
	if (!rootPid || process.platform === "win32") return true;
	if (!psPath) return false;
	const result = spawnSync(psPath, ["-axo", "pid=,ppid=,lstart="], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 1000, maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) return false;
	const rows = String(result.stdout).split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line))
		.filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] }))
		.filter(({ pid, ppid }) => Number.isInteger(pid) && pid > 0 && Number.isInteger(ppid) && ppid >= 0);
	const live = new Map(rows.map((row) => [row.pid, row.started]));
	for (const [pid, started] of tracked) {
		if (live.get(pid) !== started) tracked.delete(pid);
	}
	const parents = new Set([rootPid, ...tracked.keys()]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const { pid, ppid, started } of rows) {
			if (pid === process.pid || tracked.has(pid) || !parents.has(ppid)) continue;
			tracked.set(pid, started);
			parents.add(pid);
			changed = true;
		}
	}
	return true;
}

/**
 * Verify the external capabilities required by worktree-isolated agents before
 * the user enables workflows. Runtime Git calls continue to fail closed if the
 * capability later disappears.
 */
export function probeWorkflowGitSupport(options = {}) {
	if (process.platform === "win32") {
		return { ok: false, message: "Dynamic workflows currently require macOS or Linux." };
	}
	let gitPath;
	try { gitPath = options.gitPath ?? workflowGitExecutable(); }
	catch { return { ok: false, message: "Dynamic workflows require a trusted executable Git installation." }; }
	const gitProbe = spawnSync(gitPath, ["--version"], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, windowsHide: true, timeout: 2000,
	});
	if (gitProbe.error || gitProbe.status !== 0) {
		return { ok: false, message: "Dynamic workflows require an executable Git installation." };
	}
	if (process.platform !== "win32") {
		const psPath = Object.hasOwn(options, "psPath") ? options.psPath : POSIX_PS;
		if (!refreshPosixDescendants(process.pid, new Map(), psPath)) {
			return {
				ok: false,
				message: "Dynamic workflows require permission to inspect child processes with ps so Git worktree operations can be cancelled safely.",
			};
		}
	}
	return { ok: true };
}

function taskkill(pid, force = false) {
	if (!pid || process.platform !== "win32") return false;
	const systemRoot = process.env.SystemRoot || process.env.WINDIR;
	const executable = systemRoot ? path.join(systemRoot, "System32", "taskkill.exe") : "taskkill.exe";
	try {
		const result = spawnSync(executable, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
			stdio: "ignore", shell: false, windowsHide: true, timeout: GIT_TREE_STOP_TIMEOUT_MS,
		});
		return !result.error && result.status === 0;
	} catch { return false; }
}

function filterNeutralizationArguments(configuredKeys) {
	const drivers = new Set();
	for (const key of String(configuredKeys).split(/\r?\n/u).filter(Boolean)) {
		const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key.trim());
		if (!match || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(match[1])) {
			throw Object.assign(new Error("workflow Git encountered an invalid filter driver name"), { code: "WORKFLOW_GIT_FILTER_INSPECTION_FAILED" });
		}
		drivers.add(match[1]);
	}
	return [
		"-c", `core.attributesFile=${DISABLED_HOOKS_PATH}`,
		...[...drivers].flatMap((driver) => [
			"-c", `filter.${driver}.clean=`,
			"-c", `filter.${driver}.smudge=`,
			"-c", `filter.${driver}.process=`,
			"-c", `filter.${driver}.required=false`,
		]),
	];
}

function signalGitTree(child, signal) {
	if (!child?.pid) return false;
	if (process.platform === "win32") {
		const force = signal === "SIGKILL";
		if (taskkill(child.pid, force)) return "tree";
		if (!force && taskkill(child.pid, true)) return "tree";
		try { return child.kill(signal) ? "direct" : false; } catch { return false; }
	}
	try { process.kill(-child.pid, signal); return "tree"; }
	catch (error) {
		if (error?.code !== "ESRCH") {
			try { return child.kill(signal); } catch { /* already exited */ }
		}
	}
	return false;
}

async function git(cwd, args, options = {}) {
	if (options.signal?.aborted) throw options.signal.reason ?? Object.assign(new Error("workflow Git operation cancelled"), { name: "AbortError" });
	if (process.platform === "win32") {
		throw Object.assign(new Error("Dynamic workflows currently require macOS or Linux"), { code: "WORKFLOW_PLATFORM_UNSUPPORTED" });
	}
	if (process.platform !== "win32" && !POSIX_PS) {
		throw Object.assign(new Error("workflow Git descendant tracking is unavailable"), { code: "WORKFLOW_GIT_TREE_TRACKING_FAILED" });
	}
	const deadline = options.deadline ?? Date.now() + WORKFLOW_LIMITS.gitTimeoutMs;
	const timeoutError = () => Object.assign(new Error(`workflow Git ${safeSegment(args[0] ?? "operation")} timed out`), {
		code: "WORKFLOW_GIT_TIMEOUT",
		operation: String(args[0] ?? "operation"),
	});
	let gitPath;
	try { gitPath = options.gitPath ?? workflowGitExecutable(); }
	catch (error) {
		throw Object.assign(new Error(`workflow Git executable is not trusted: ${error.message}`), { code: "WORKFLOW_GIT_UNTRUSTED" });
	}
	let remaining = deadline - Date.now();
	if (remaining <= 0) throw timeoutError();
	let filterArguments = Array.isArray(options.filterArguments) ? options.filterArguments : [];
	if (!Array.isArray(options.filterArguments) && options.skipFilterInspection !== true) {
		const configuredKeys = await git(cwd, [
			"config", "--includes", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
		], { ...options, skipFilterInspection: true, acceptedExitCodes: [0, 1], deadline });
		filterArguments = filterNeutralizationArguments(configuredKeys);
		remaining = deadline - Date.now();
		if (remaining <= 0) throw timeoutError();
	}
	return await new Promise((resolve, reject) => {
		const gitArguments = [
			"-c", `core.hooksPath=${DISABLED_HOOKS_PATH}`,
			"-c", "core.fsmonitor=false",
			...filterArguments,
			"-C", options.cwdIdentity ? "." : cwd,
			...args,
		];
		// Every Git process runs behind the existing out-of-process supervisor. It
		// owns descendant polling and tree shutdown, so a stalled/full-table `ps`
		// cannot block the TUI event loop and concurrent Git calls share no sync work
		// in the main process.
		const launchExecutable = process.execPath;
		const launchArguments = [
			WORKFLOW_WORKER_SUPERVISOR,
			"--preserve-exit",
			"--owner-stdin",
			"--status-fd", "3",
			"--child-env-fd", "4",
			...(options.cwdIdentity
				? ["--cwd-identity", Buffer.from(JSON.stringify(options.cwdIdentity)).toString("base64url")]
				: []),
			...(options.pathIdentity
				? ["--path-identity", Buffer.from(JSON.stringify(options.pathIdentity)).toString("base64url")]
				: []),
			...(options.gitDirectoryIdentity
				? ["--git-dir-identity", Buffer.from(JSON.stringify(options.gitDirectoryIdentity)).toString("base64url")]
				: []),
			gitPath, ...gitArguments,
		];
		const childEnvironment = credentialFreeGitEnvironment();
		for (const [name, value] of Object.entries(options.env ?? {})) {
			if (name !== "GIT_INDEX_FILE" || typeof value !== "string" || !path.isAbsolute(value) || /[\r\n]/u.test(value)) {
				throw Object.assign(new Error("workflow Git received an unsupported child environment override"), { code: "WORKFLOW_GIT_ENVIRONMENT_UNSAFE" });
			}
			childEnvironment.GIT_INDEX_FILE = value;
		}
		const serializedChildEnvironment = JSON.stringify(childEnvironment);
		if (Buffer.byteLength(serializedChildEnvironment, "utf8") > CHILD_ENVIRONMENT_MAX_BYTES) {
			reject(Object.assign(new Error("workflow Git child environment exceeds 1 MiB"), { code: "WORKFLOW_GIT_ENVIRONMENT_TOO_LARGE" }));
			return;
		}
		const child = spawn(launchExecutable, launchArguments, {
			cwd: options.cwdIdentity ? os.tmpdir() : cwd,
			detached: process.platform !== "win32",
			env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
			stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"], shell: false, windowsHide: true,
		});
		child.stdin.on("error", () => {});
		let statusBuffer = "";
		let statusOverflow = false;
		child.stdio[3].setEncoding("utf8");
		child.stdio[3].on("error", () => { statusOverflow = true; });
		child.stdio[3].on("data", (chunk) => {
			statusBuffer += chunk;
			if (Buffer.byteLength(statusBuffer, "utf8") > 1024) {
				statusOverflow = true;
				child.stdio[3].destroy();
			}
		});
		child.stdio[4].on("error", () => {});
		child.stdio[4].end(serializedChildEnvironment);
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let terminationReason;
		let spawnError;
		let settled = false;
		let killTimer;
		const terminate = (reason) => {
			if (terminationReason || settled) return;
			terminationReason = reason;
			signalGitTree(child, "SIGTERM");
			killTimer = setTimeout(() => {
				// The supervisor forces its worker after 750 ms and spends up to five
				// seconds proving the tree is gone. Only reap the supervisor after that
				// confirmation window, never before it can finish its ownership fence.
				signalGitTree(child, "SIGKILL");
			}, 5500);
			killTimer.unref?.();
		};
		const onAbort = () => terminate(options.signal.reason ?? Object.assign(new Error("workflow Git operation cancelled"), { name: "AbortError" }));
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => terminate(timeoutError()), Math.min(WORKFLOW_LIMITS.gitTimeoutMs, Math.max(1, remaining)));
		timeout.unref?.();
		const append = (chunks, chunk, stream) => {
			if (stream === "stdout") stdoutBytes += chunk.length;
			else stderrBytes += chunk.length;
			if (stdoutBytes > GIT_OUTPUT_LIMIT || stderrBytes > GIT_OUTPUT_LIMIT) {
				terminate(Object.assign(new Error("workflow Git output exceeded its bound"), { code: "WORKFLOW_GIT_OUTPUT_TOO_LARGE" }));
				return;
			}
			chunks.push(chunk);
		};
		child.stdout.on("data", (chunk) => append(stdout, chunk, "stdout"));
		child.stderr.on("data", (chunk) => append(stderr, chunk, "stderr"));
		child.once("error", (error) => { spawnError = error; });
		child.once("close", async (code, signal) => {
			if (settled) return;
			settled = true;
			child.stdin.end();
			clearTimeout(timeout);
			clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			const output = Buffer.concat(stdout).toString("utf8");
			const errorOutput = Buffer.concat(stderr).toString("utf8");
			if (code === WORKER_TRACKING_FAILURE_EXIT) {
				reject(Object.assign(new Error(errorOutput.trim() || "workflow Git descendant tracking failed"), { code: "WORKFLOW_GIT_TREE_TRACKING_FAILED" }));
				return;
			}
			if (code === 78) {
				reject(Object.assign(new Error("workflow Git checkout or repository identity changed before child launch"), {
					code: "WORKFLOW_GIT_IDENTITY_CHANGED", stderr: errorOutput,
				}));
				return;
			}
			let backendStatus;
			if (code === 85 && !signal && !statusOverflow) {
				try {
					const parsed = JSON.parse(statusBuffer.trim());
					if ((!Number.isInteger(parsed?.code) && parsed?.code !== null) ||
						(parsed?.signal !== null && typeof parsed?.signal !== "string") ||
						(parsed?.errorCode !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/u.test(parsed.errorCode))) throw new Error("invalid status");
					backendStatus = { code: parsed.code, signal: parsed.signal, errorCode: parsed.errorCode };
				} catch { /* handled by the containment failure below */ }
			}
			if (!backendStatus) {
				reject(Object.assign(new Error(
					errorOutput.trim() || `workflow Git supervisor exited without confirmed backend-tree status (${signal ?? code})`,
				), { code: "WORKFLOW_GIT_TREE_TERMINATION_FAILED" }));
				return;
			}
			if (terminationReason) { reject(terminationReason); return; }
			if (spawnError) { reject(spawnError); return; }
			if (backendStatus.errorCode) {
				reject(Object.assign(new Error(errorOutput.trim() || `workflow Git failed to spawn (${backendStatus.errorCode})`), { code: backendStatus.errorCode }));
				return;
			}
			if (backendStatus.code === 0 || options.acceptedExitCodes?.includes(backendStatus.code)) { resolve(output); return; }
			const error = new Error(`git ${args[0] ?? "operation"} failed${backendStatus.signal ? ` (${backendStatus.signal})` : ""}: ${errorOutput.trim() || `exit ${backendStatus.code}`}`);
			error.code = backendStatus.code;
			error.signal = backendStatus.signal;
			error.killed = false;
			error.stdout = output;
			error.stderr = errorOutput;
			reject(error);
		});
	});
}

function operationOptions(options = {}) {
	return { ...options, deadline: options.deadline ?? Date.now() + WORKFLOW_LIMITS.gitOperationTimeoutMs };
}

function rootIdentity(fingerprint) {
	return Object.freeze({
		canonicalRoot: fingerprint.canonicalRoot,
		device: String(fingerprint.device),
		inode: String(fingerprint.inode),
	});
}

function commonIdentity(fingerprint) {
	return Object.freeze({
		canonicalRoot: fingerprint.commonDirectory,
		device: String(fingerprint.commonDevice),
		inode: String(fingerprint.commonInode),
	});
}

function gitDirectoryIdentity(fingerprint) {
	return Object.freeze({
		canonicalRoot: fingerprint.gitDirectory,
		device: String(fingerprint.gitDevice),
		inode: String(fingerprint.gitInode),
	});
}

function pinnedFingerprintOperation(options, fingerprint) {
	return operationOptions({
		...options,
		cwdIdentity: rootIdentity(fingerprint),
		pathIdentity: commonIdentity(fingerprint),
		gitDirectoryIdentity: gitDirectoryIdentity(fingerprint),
	});
}

async function assertStoredDirectoryIdentity(canonicalRoot, device, inode, message) {
	const canonical = path.resolve(canonicalRoot);
	let resolved;
	try { resolved = await fs.realpath(canonical); }
	catch (error) { throw Object.assign(new Error(message, { cause: error }), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" }); }
	if (resolved !== canonical) throw Object.assign(new Error(message), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" });
	let handle;
	try {
		handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
		const stat = await handle.stat({ bigint: true });
		if (!stat.isDirectory() || String(stat.dev) !== String(device) || String(stat.ino) !== String(inode)) {
			throw Object.assign(new Error(message), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" });
		}
	} catch (error) {
		if (error?.code === "WORKFLOW_GIT_IDENTITY_CHANGED") throw error;
		throw Object.assign(new Error(message, { cause: error }), { code: "WORKFLOW_GIT_IDENTITY_CHANGED" });
	} finally { await handle?.close(); }
}

function isConclusiveNonRepository(error) {
	// Only Git's own, locale-stabilized "not a repository" response permits
	// the shared-directory fallback. Spawn failures, timeouts, cancellation,
	// unsafe-repository errors, and every other discovery failure must prevent a
	// mutating worker from launching rather than splitting the repository lock.
	return error?.code === 128
		&& !error?.killed
		&& !error?.signal
		&& /fatal: not a git repository(?: \(or any of the parent directories\))?:/u.test(String(error?.stderr ?? ""));
}

function safeSegment(value) {
	return String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 96);
}

function isUnconfirmedGitTreeFailure(error) {
	return error?.code === "WORKFLOW_GIT_TREE_TERMINATION_FAILED" || error?.code === "WORKFLOW_GIT_TREE_TRACKING_FAILED";
}

export class WorkflowWorktrees {
	constructor(root, options = {}) {
		this.root = path.resolve(root);
		this.gitPath = options.gitPath;
		this.retained = new Set();
	}

	async repositoryIdentity(cwd, options = {}) {
		if (this.gitPath && !options.gitPath) options = { ...options, gitPath: this.gitPath };
		const realCwd = await fs.realpath(cwd);
		let pinnedOptions = options;
		if (!options.cwdIdentity) {
			const stat = await fs.lstat(realCwd, { bigint: true });
			pinnedOptions = { ...options, cwdIdentity: { canonicalRoot: realCwd, device: String(stat.dev), inode: String(stat.ino) } };
		}
		try {
			const top = (await git(realCwd, ["rev-parse", "--show-toplevel"], pinnedOptions)).trim();
			return await fs.realpath(top);
		} catch (error) {
			if (!isConclusiveNonRepository(error)) throw error;
			return realCwd;
		}
	}

	async repositoryLockIdentity(cwd, options = {}) {
		if (this.gitPath && !options.gitPath) options = { ...options, gitPath: this.gitPath };
		const realCwd = await fs.realpath(cwd);
		let pinnedOptions = options;
		if (!options.cwdIdentity) {
			const stat = await fs.lstat(realCwd, { bigint: true });
			pinnedOptions = { ...options, cwdIdentity: { canonicalRoot: realCwd, device: String(stat.dev), inode: String(stat.ino) } };
		}
		try {
			const common = (await git(realCwd, ["rev-parse", "--git-common-dir"], pinnedOptions)).trim();
			const resolved = path.isAbsolute(common) ? common : path.resolve(realCwd, common);
			return await fs.realpath(resolved);
		} catch (error) {
			if (!isConclusiveNonRepository(error)) throw error;
			return realCwd;
		}
	}

	async repositoryFingerprint(cwd, options = {}) {
		if (this.gitPath && !options.gitPath) options = { ...options, gitPath: this.gitPath };
		const canonicalRoot = await this.repositoryIdentity(cwd, options);
		const rootStat = await fs.lstat(canonicalRoot, { bigint: true });
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("workflow repository root must be a real directory");
		// Metadata discovery must observe Git's real paths. Descriptor-backed Git
		// operations deliberately report /dev/fd paths, so never carry a previous
		// metadata pin into this one-time discovery step.
		const { pathIdentity: _ignoredCommonIdentity, gitDirectoryIdentity: _ignoredGitIdentity, ...discoveryOptions } = options;
		const rootPinnedOptions = {
			...discoveryOptions,
			cwdIdentity: { canonicalRoot, device: String(rootStat.dev), inode: String(rootStat.ino) },
		};
		const commonDirectory = await this.repositoryLockIdentity(canonicalRoot, rootPinnedOptions);
		const commonStat = await fs.lstat(commonDirectory, { bigint: true });
		if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) throw new Error("workflow Git common directory must be a real directory");
		const gitDirectoryOutput = (await git(canonicalRoot, ["rev-parse", "--absolute-git-dir"], rootPinnedOptions)).trim();
		const gitDirectory = await fs.realpath(path.isAbsolute(gitDirectoryOutput) ? gitDirectoryOutput : path.resolve(canonicalRoot, gitDirectoryOutput));
		const gitStat = await fs.lstat(gitDirectory, { bigint: true });
		if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error("workflow Git directory must be a real directory");
		return Object.freeze({
			canonicalRoot,
			device: String(rootStat.dev),
			inode: String(rootStat.ino),
			commonDirectory,
			commonDevice: String(commonStat.dev),
			commonInode: String(commonStat.ino),
			gitDirectory,
			gitDevice: String(gitStat.dev),
			gitInode: String(gitStat.ino),
		});
	}

	async create({ cwd, expectedProjectIdentity, runId, agentId, attempt, signal }) {
		if (process.platform === "win32") {
			throw Object.assign(new Error("Dynamic workflows currently require macOS or Linux"), { code: "WORKFLOW_PLATFORM_UNSUPPORTED" });
		}
		cwd = await fs.realpath(cwd);
		const operation = operationOptions({ signal, ...(this.gitPath ? { gitPath: this.gitPath } : {}) });
		const pinnedOperation = operationOptions({ signal, cwdIdentity: expectedProjectIdentity, ...(this.gitPath ? { gitPath: this.gitPath } : {}) });
		await assertProjectDirectoryIdentity(cwd, expectedProjectIdentity);
		const top = await this.repositoryIdentity(cwd, pinnedOperation);
		const topStat = await fs.lstat(top, { bigint: true });
		const repositoryFingerprint = await this.repositoryFingerprint(top, {
			...operation,
			cwdIdentity: { canonicalRoot: top, device: String(topStat.dev), inode: String(topStat.ino) },
		});
		const repositoryOperation = pinnedFingerprintOperation(operation, repositoryFingerprint);
		const inside = (await git(top, ["rev-parse", "--is-inside-work-tree"], repositoryOperation)).trim();
		if (inside !== "true") throw new Error("worktree isolation requires a Git worktree");
		const base = (await git(top, ["rev-parse", "HEAD"], repositoryOperation)).trim();
		await assertProjectDirectoryIdentity(cwd, expectedProjectIdentity);
		const directory = path.join(this.root, safeSegment(runId), `${safeSegment(agentId)}-${attempt}`);
		if (!directory.startsWith(`${this.root}${path.sep}`)) throw new Error("unsafe workflow worktree path");
		await ensureWorkflowPrivateDirectory(path.dirname(this.root));
		await ensureWorkflowPrivateDirectory(this.root);
		await ensureWorkflowPrivateDirectory(path.dirname(directory));
		const record = Object.freeze({ stage: "pre-add", directory, repository: top, repositoryFingerprint, base, runId, agentId, attempt });
		await this.#writeMarker(record);
		try { await git(top, ["worktree", "add", "--detach", directory, base], repositoryOperation); }
		// A Git error is not proof that shared metadata or the checkout was never
		// created (especially when descendant tracking itself failed). Retain the
		// durable marker; startup reconciliation safely removes it if the directory
		// is conclusively absent, or surfaces the worktree otherwise.
		catch (error) { throw error; }
		try {
			const canonicalWorkerRoot = await fs.realpath(directory);
			const workerRootStat = await fs.lstat(canonicalWorkerRoot, { bigint: true });
			const checkoutFingerprint = await this.repositoryFingerprint(canonicalWorkerRoot, {
				...operation,
				cwdIdentity: { canonicalRoot: canonicalWorkerRoot, device: String(workerRootStat.dev), inode: String(workerRootStat.ino) },
			});
			if (checkoutFingerprint.canonicalRoot !== canonicalWorkerRoot) throw new Error("workflow checkout repository root changed during creation");
			for (const key of ["commonDirectory", "commonDevice", "commonInode"]) {
				if (String(checkoutFingerprint[key]) !== String(repositoryFingerprint[key])) throw new Error("workflow checkout common Git directory does not match its repository");
			}
			const validatedRecord = Object.freeze({ ...record, stage: "ready", checkoutFingerprint });
			await this.#writeMarker(validatedRecord);
			const relativeCwd = path.relative(top, cwd);
			if (path.isAbsolute(relativeCwd) || relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) {
				throw Object.assign(new Error("workflow launch directory is outside its repository"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
			}
			const requestedWorkerCwd = path.resolve(canonicalWorkerRoot, relativeCwd);
			const canonicalWorkerCwd = await fs.realpath(requestedWorkerCwd);
			if (canonicalWorkerCwd !== canonicalWorkerRoot && !canonicalWorkerCwd.startsWith(`${canonicalWorkerRoot}${path.sep}`)) {
				throw Object.assign(new Error("workflow worktree launch directory escaped its checkout"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
			}
			const workerStat = await fs.lstat(canonicalWorkerCwd, { bigint: true });
			if (!workerStat.isDirectory() || workerStat.isSymbolicLink()) {
				throw Object.assign(new Error("workflow worktree identity is invalid"), { code: "WORKFLOW_PROJECT_IDENTITY_CHANGED" });
			}
			return Object.freeze({
				...validatedRecord,
				workerCwd: canonicalWorkerCwd,
				workerIdentity: Object.freeze({
					canonicalRoot: canonicalWorkerCwd,
					device: String(workerStat.dev),
					inode: String(workerStat.ino),
				}),
			});
		} catch (validationError) {
			const cleanup = pinnedFingerprintOperation({ deadline: Date.now() + WORKFLOW_LIMITS.gitOperationTimeoutMs }, repositoryFingerprint);
			try {
				await git(record.repository, ["worktree", "remove", "--force", record.directory], cleanup);
				await this.#removeMarker(record);
			} catch (cleanupError) {
				throw Object.assign(new AggregateError(
					[validationError, cleanupError],
					`workflow worktree launch validation failed and its checkout was retained for startup recovery: ${validationError.message ?? validationError}`,
				), { code: "WORKFLOW_WORKTREE_CLEANUP_FAILED" });
			}
			throw validationError;
		}
	}

	async status(record, options = {}) {
		const operation = operationOptions(options);
		const { checkoutOperation } = await this.#validate(record, operation);
		const porcelain = (await git(record.directory, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], checkoutOperation)).trim();
		const head = (await git(record.directory, ["rev-parse", "HEAD"], checkoutOperation)).trim();
		const headMoved = head !== record.base;
		const committed = headMoved
			? (await git(record.directory, ["--no-optional-locks", "diff", "--no-textconv", "--name-status", record.base, "HEAD", "--", "."], checkoutOperation)).trim()
			: "";
		const allChangedFiles = [
			...(porcelain ? porcelain.split("\n") : []),
			...(committed ? committed.split("\n") : []),
		];
		const changedFiles = allChangedFiles.slice(0, 1000);
		return { dirty: Boolean(porcelain), head, headMoved, changedFiles, changedFilesTruncated: allChangedFiles.length > changedFiles.length };
	}

	async #diff(record, options = {}, includeFullPatch = false) {
		const operation = operationOptions(options);
		const { repository, checkoutOperation, repositoryOperation } = await this.#validate(record, operation);
		// Intent-to-add makes untracked files part of the binary patch without
		// staging their contents or changing the checked-out files.
		await git(record.directory, ["add", "-N", "--", "."], checkoutOperation);
		const patchText = await git(record.directory, ["--no-optional-locks", "diff", "--binary", "--no-ext-diff", "--no-textconv", record.base, "--", "."], checkoutOperation);
		const bytes = Buffer.byteLength(patchText, "utf8");
		if (bytes === 0) throw new Error("retained workflow worktree has no changes to apply");
		const stat = (await git(record.directory, ["--no-optional-locks", "diff", "--no-textconv", "--stat", record.base, "--", "."], checkoutOperation)).trim();
		const target = await this.#targetState(repository, repositoryOperation);
		const status = await this.status(record, operation);
		const { changedFiles, changedFilesTruncated } = status;
		const patchHash = createHash("sha256").update(patchText).digest("hex");
		let patch = patchText;
		let patchTruncated = false;
		if (!includeFullPatch && bytes > WORKFLOW_LIMITS.maxTraceBytes) {
			patch = boundedWorkflowText(patchText, WORKFLOW_LIMITS.maxTraceBytes);
			patchTruncated = true;
		}
		return { patch, stat, bytes, patchTruncated, changedFiles, changedFilesTruncated, target: { ...target, patchHash, divergedFromBase: target.head !== record.base } };
	}

	async diff(record, options = {}) {
		return this.#diff(record, options, false);
	}

	async apply(record, options = {}) {
		const operation = operationOptions(options);
		const { repository, checkoutOperation, repositoryOperation } = await this.#validate(record, operation);
		const preview = await this.#diff(record, operation, true);
		const appliedPaths = await this.#changedPathNames(record, checkoutOperation);
		const expected = options.expectedTarget;
		if (!expected) throw new Error("worktree apply requires a confirmed target checkout preview");
		if (preview.target.patchHash !== expected.patchHash) throw new Error("the retained worktree patch changed after preview; preview and confirm it again");
		for (const key of ["head", "branch", "statusFingerprint"]) {
			if (preview.target[key] !== expected[key]) throw new Error("the target checkout changed after preview; preview and confirm the worktree apply again");
		}
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "cc-workflow-apply-"));
		const patchFile = path.join(temporary, "changes.patch");
		const temporaryIndex = path.join(temporary, "index");
		try {
			await fs.writeFile(patchFile, preview.patch, { mode: 0o600, flag: "wx" });
			const targetIndexValue = (await git(repository, ["rev-parse", "--git-path", "index"], repositoryOperation)).trim();
			const targetIndex = path.isAbsolute(targetIndexValue) ? targetIndexValue : path.resolve(repository, targetIndexValue);
			try { await fs.copyFile(targetIndex, temporaryIndex); }
			catch (error) {
				if (error?.code !== "ENOENT") throw error;
				await git(repository, ["read-tree", "HEAD"], { ...repositoryOperation, env: { GIT_INDEX_FILE: temporaryIndex } });
			}
			const isolatedIndexOperation = { ...repositoryOperation, env: { GIT_INDEX_FILE: temporaryIndex } };
			await git(repository, ["apply", "--3way", "--check", patchFile], isolatedIndexOperation);
			// `--check` can take long enough for an editor or hook to move an
			// unrelated target file. Revalidate after it, immediately before the
			// mutating git process is spawned; the manager also serializes every cc
			// mutation of this repository around this entire operation.
			const finalTarget = await this.#targetState(repository, repositoryOperation);
			for (const key of ["head", "branch", "statusFingerprint"]) {
				if (finalTarget[key] !== expected[key]) throw new Error("the target checkout changed during apply validation; preview and confirm the worktree apply again");
			}
			const configuredKeys = await git(repository, [
				"config", "--includes", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$",
			], { ...repositoryOperation, skipFilterInspection: true, acceptedExitCodes: [0, 1] });
			const finalFilterArguments = filterNeutralizationArguments(configuredKeys);
			await options.onValidated?.({ preview, target: finalTarget });
			const postJournalTarget = await this.#targetState(repository, repositoryOperation);
			for (const key of ["head", "branch", "statusFingerprint"]) {
				if (postJournalTarget[key] !== expected[key]) {
					await options.onValidationInvalidated?.({ preview, target: postJournalTarget });
					throw new Error("the target checkout changed while the apply intent was being saved; preview and confirm the worktree apply again");
				}
			}
			await git(repository, ["apply", "--3way", patchFile], { ...isolatedIndexOperation, filterArguments: finalFilterArguments });
			// The apply intent is already durable at this point. Flush every path
			// affected by the patch and its directory chain before reporting success,
			// so a persisted appliedAt marker never outruns the target checkout.
			await this.#syncAppliedPaths(repository, appliedPaths);
			return {
				...preview,
				patch: preview.bytes > WORKFLOW_LIMITS.maxTraceBytes
					? boundedWorkflowText(preview.patch, WORKFLOW_LIMITS.maxTraceBytes)
					: preview.patch,
				patchTruncated: preview.bytes > WORKFLOW_LIMITS.maxTraceBytes,
				appliedAt: new Date().toISOString(),
			};
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	}

	async release(record, options = {}) {
		const operation = operationOptions(options);
		const status = await this.status(record, operation).catch((error) => {
			if (isUnconfirmedGitTreeFailure(error)) throw error;
			return { dirty: true, changedFiles: [], releaseError: error.message ?? String(error) };
		});
		if (status.dirty || status.headMoved) {
			try {
				// Validate that the retained state has a bounded, reproducible binary
				// patch. Public previews may be truncated, but apply recomputes and uses
				// the complete patch. An over-limit Git payload is discarded from this
				// isolated checkout instead of creating permanent unapplyable state.
				await this.diff(record, operation);
			} catch (error) {
				if (error?.code !== "WORKFLOW_GIT_OUTPUT_TOO_LARGE") throw error;
				this.retained.add(record.directory);
				return {
					retained: true, ...status,
					releaseError: "workflow worktree patch exceeded the 32 MiB automatic preview/apply bound; the isolated checkout was retained for manual recovery",
				};
			}
			this.retained.add(record.directory);
			return { retained: true, ...status };
		}
		const repositoryOperation = pinnedFingerprintOperation(operation, record.repositoryFingerprint);
		await git(record.repository, ["worktree", "remove", record.directory], repositoryOperation);
		await this.#removeMarker(record);
		return { retained: false, ...status };
	}

	async finalizeApplied(record, appliedAt, options = {}) {
		if (typeof appliedAt !== "string" || !appliedAt) throw new Error("applied worktree cleanup requires a durable applied timestamp");
		const operation = operationOptions(options);
		const appliedRecord = Object.freeze({ ...record, appliedAt });
		// Mark non-actionable before removing the dirty checkout. If cleanup is
		// interrupted, history admission and startup recovery can distinguish an
		// already-applied checkout from changes that still need user action.
		await this.#writeMarker(appliedRecord);
		try {
			const { repositoryOperation } = await this.#validate(record, operation);
			await git(record.repository, ["worktree", "remove", "--force", record.directory], repositoryOperation);
			await this.#removeMarker(record);
			this.retained.delete(record.directory);
			return { removed: true };
		} catch (error) {
			if (isUnconfirmedGitTreeFailure(error)) throw error;
			return { removed: false, warning: error.message ?? String(error) };
		}
	}

	async reconcileOrphans(knownDirectories = [], options = {}) {
		await ensureWorkflowPrivateDirectory(path.dirname(this.root));
		await ensureWorkflowPrivateDirectory(this.root);
		const known = new Set([...knownDirectories].map((directory) => path.resolve(directory)));
		const recovered = [];
		const deadline = options.deadline ?? Date.now() + ORPHAN_RECOVERY_TIMEOUT_MS;
		const cursor = await this.#readRecoveryCursor();
		let scanned = 0;
		let lastCursor;
		const processMarker = async (runDirectory, marker) => {
			const quarantineSuffix = ".cc-worktree.json.quarantine-";
			if (marker.includes(quarantineSuffix)) {
				const directory = marker.slice(0, marker.indexOf(quarantineSuffix));
				const hash = createHash("sha256").update(path.resolve(`${directory}.cc-worktree.json`)).digest("hex").slice(0, 24);
				recovered.push({
					runId: `quarantined-marker-${hash}`, agentId: `quarantined-marker-${hash}:1`, attempt: 1,
					directory, retained: false, orphaned: true, quarantined: true, quarantine: marker,
					recoveryError: "Malformed workflow worktree marker remains quarantined; inspect the adjacent checkout manually",
				});
				return;
			}
			let record;
			try { record = await this.#readMarker(marker); }
			catch (error) {
				const hash = createHash("sha256").update(path.resolve(marker)).digest("hex").slice(0, 24);
				const quarantine = `${marker}.quarantine-${hash}`;
				try {
					await fs.rename(marker, quarantine);
					await syncDirectory(path.dirname(marker));
				} catch (quarantineError) {
					if (quarantineError?.code !== "ENOENT") {
						recovered.push({
							runId: `quarantined-marker-${hash}`, agentId: `quarantined-marker-${hash}:1`, attempt: 1,
							directory: marker.slice(0, -".cc-worktree.json".length), retained: false, orphaned: true, quarantined: false,
							recoveryError: `Malformed workflow worktree marker could not be quarantined: ${quarantineError.message ?? quarantineError}`,
						});
					}
					return;
				}
				recovered.push({
					runId: `quarantined-marker-${hash}`, agentId: `quarantined-marker-${hash}:1`, attempt: 1,
					directory: marker.slice(0, -".cc-worktree.json".length), retained: false, orphaned: true, quarantined: true,
					quarantine,
					recoveryError: `Malformed workflow worktree marker was quarantined: ${error.message ?? error}`,
				});
				return;
			}
			if (options.protectedRunIds?.has(record.runId)) return;
			let releaseLease;
			if (!options.ownedRunIds?.has(record.runId)) {
				try {
					releaseLease = await acquireWorkflowRunLease(path.dirname(this.root), record.runId, { timeoutMs: 0 });
				} catch (error) {
					if (error?.code === "WORKFLOW_LOCK_TIMEOUT") return;
					throw error;
				}
			}
			const represented = known.has(path.resolve(record.directory));
			try {
				const reconcileRecord = async () => {
					if (!record.checkoutFingerprint) {
						record = await this.#recoverPreValidationMarker(record, deadline);
						if (!record) return;
					}
					const appliedAt = record.appliedAt ?? options.appliedWorktrees?.get(path.resolve(record.directory));
					if (appliedAt) {
						if (!record.appliedAt) await this.#writeMarker({ ...record, appliedAt });
						try {
							const { repositoryOperation } = await this.#validate(record, { deadline });
							await git(record.repository, ["worktree", "remove", "--force", record.directory], repositoryOperation);
						} catch (error) {
							if (error?.code !== "ENOENT") throw error;
						}
						await this.#removeMarker(record);
						return;
					}
					await fs.lstat(record.directory);
					const status = await this.status(record, { deadline });
					if (!status.dirty && !status.headMoved) {
						await this.release(record, { deadline });
						if (represented) recovered.push({ ...record, ...status, retained: false, reconciled: true });
						return;
					}
					recovered.push({ ...record, ...status, retained: true, orphaned: !represented, reconciled: true });
				};
				if (options.withRepositoryMutation) {
					const lockController = new AbortController();
					const lockTimer = setTimeout(() => lockController.abort(Object.assign(
						new Error("workflow orphan recovery repository lock timed out"),
						{ code: "WORKFLOW_ORPHAN_RECOVERY_TIMEOUT" },
					)), Math.max(1, deadline - Date.now()));
					lockTimer.unref?.();
					try { await options.withRepositoryMutation(record.repository, lockController.signal, reconcileRecord); }
					finally { clearTimeout(lockTimer); }
				} else await reconcileRecord();
			} catch (error) {
				if (isUnconfirmedGitTreeFailure(error)) throw error;
				if (error?.code === "ENOENT") {
					let checkoutMissing = false;
					try { await fs.lstat(record.directory); }
					catch (checkoutError) {
						if (checkoutError?.code === "ENOENT") checkoutMissing = true;
						else throw checkoutError;
					}
					if (checkoutMissing) {
						try {
							// Checkout absence alone is insufficient: `git worktree add` may
							// have published shared metadata before a crash. Require the
							// repository metadata identities, inspect its durable worktree
							// list, and remove an exact stale registration before the marker.
							await assertStoredDirectoryIdentity(record.repositoryFingerprint.canonicalRoot, record.repositoryFingerprint.device, record.repositoryFingerprint.inode, "workflow worktree repository identity changed");
							await assertStoredDirectoryIdentity(record.repositoryFingerprint.commonDirectory, record.repositoryFingerprint.commonDevice, record.repositoryFingerprint.commonInode, "workflow worktree repository common-directory identity changed");
							await assertStoredDirectoryIdentity(record.repositoryFingerprint.gitDirectory, record.repositoryFingerprint.gitDevice, record.repositoryFingerprint.gitInode, "workflow worktree repository Git-directory identity changed");
							const repositoryOperation = pinnedFingerprintOperation({ deadline }, record.repositoryFingerprint);
							const listed = await git(record.repositoryFingerprint.canonicalRoot, ["worktree", "list", "--porcelain"], repositoryOperation);
							const registeredPath = listed.split(/\r?\n/u)
								.filter((line) => line.startsWith("worktree "))
								.map((line) => path.resolve(line.slice("worktree ".length)))
								.find((candidate) => candidate === path.resolve(record.checkoutFingerprint.canonicalRoot));
							if (registeredPath) await git(record.repositoryFingerprint.canonicalRoot, ["worktree", "remove", "--force", registeredPath], repositoryOperation);
							await this.#removeMarker(record);
							return;
						} catch (cleanupError) {
							recovered.push({ ...record, retained: true, orphaned: true, recoveryError: cleanupError.message ?? String(cleanupError) });
							return;
						}
					}
				}
				recovered.push({ ...record, retained: true, orphaned: true, recoveryError: error.message ?? String(error) });
			} finally { await releaseLease?.(); }
		};
		// Stream directory entries and retain only the next bounded lexical window.
		// This preserves deterministic cursor fairness without materializing an
		// attacker-sized directory or its non-marker contents in memory.
		const afterCursor = [];
		const wrapped = [];
		const discoveryDeadline = Math.max(Date.now(), deadline - 1000);
		let discoveryEntries = 0;
		const admitDiscoveryEntry = () => {
			discoveryEntries += 1;
			if (discoveryEntries > ORPHAN_DISCOVERY_MAX_ENTRIES || Date.now() >= discoveryDeadline) {
				throw Object.assign(new Error("workflow orphan marker discovery exceeded its bounded scan; reduce retained worktree state before enabling workflows"), { code: "WORKFLOW_ORPHAN_DISCOVERY_LIMIT" });
			}
		};
		let root;
		try { root = await fs.opendir(this.root); } catch (error) { if (error?.code !== "ENOENT") throw error; }
		if (root) for await (const runEntry of root) {
			admitDiscoveryEntry();
			if (runEntry.isSymbolicLink?.()) throw Object.assign(new Error("workflow orphan run entry must not be a symlink"), { code: "WORKFLOW_ORPHAN_ENTRY_INVALID" });
			if (!runEntry.isDirectory()) {
				const interruptedCursorWrite = /^\.recovery-cursor\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u.test(runEntry.name);
				if (runEntry.isFile() && (runEntry.name === ".recovery-cursor" || interruptedCursorWrite)) continue;
				throw Object.assign(new Error("workflow orphan run entry must be a directory"), { code: "WORKFLOW_ORPHAN_ENTRY_INVALID" });
			}
			const runDirectory = path.join(this.root, runEntry.name);
			let directory;
			try { directory = await fs.opendir(runDirectory); }
			catch (error) { if (error?.code === "ENOENT") continue; throw error; }
			let empty = true;
			for await (const entry of directory) {
				admitDiscoveryEntry();
				empty = false;
				const markerName = entry.name.endsWith(".cc-worktree.json") || entry.name.includes(".cc-worktree.json.quarantine-");
				if (!markerName) continue;
				if (!entry.isFile() || entry.isSymbolicLink?.()) throw Object.assign(new Error("workflow orphan marker must be a regular file"), { code: "WORKFLOW_ORPHAN_ENTRY_INVALID" });
				const candidate = { key: `${runEntry.name}/${entry.name}`, runDirectory, marker: path.join(runDirectory, entry.name) };
				boundedLexicalCandidate(cursor && candidate.key <= cursor ? wrapped : afterCursor, candidate, ORPHAN_RECOVERY_LIMIT);
			}
			if (empty) await fs.rmdir(runDirectory).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error; });
		}
		const candidates = [
			...afterCursor.sort((left, right) => left.key.localeCompare(right.key)),
			...wrapped.sort((left, right) => left.key.localeCompare(right.key)),
		].slice(0, ORPHAN_RECOVERY_LIMIT);
		for (const candidate of candidates) {
			if (Date.now() >= deadline) break;
			scanned += 1;
			lastCursor = candidate.key;
			await processMarker(candidate.runDirectory, candidate.marker);
		}
		if (lastCursor) await this.#writeRecoveryCursor(lastCursor);
		return recovered;
	}

	async #changedPathNames(record, options) {
		const output = await git(record.directory, ["--no-optional-locks", "diff", "--no-textconv", "--name-status", "-z", record.base, "--", "."], options);
		const fields = output.split("\0");
		const names = [];
		for (let index = 0; index < fields.length && fields[index];) {
			const status = fields[index++];
			const count = /^[RC]/u.test(status) ? 2 : 1;
			for (let offset = 0; offset < count; offset += 1) {
				const name = fields[index++];
				if (!name) throw new Error("invalid changed-path list for workflow apply");
				names.push(name);
				if (names.length > APPLY_PATH_LIMIT) throw new Error(`workflow apply affects more than ${APPLY_PATH_LIMIT} paths`);
			}
		}
		if (names.length === 0) throw new Error("retained workflow worktree has no changed paths to apply");
		return [...new Set(names)];
	}

	async #syncAppliedPaths(repository, names) {
		const root = path.resolve(repository);
		const directories = new Set([root]);
		for (const name of names) {
			const target = path.resolve(root, name);
			if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("unsafe changed path in workflow apply");
			let stat;
			try { stat = await fs.lstat(target); }
			catch (error) { if (error?.code !== "ENOENT") throw error; }
			if (stat?.isFile()) {
				let handle;
				try {
					handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
					if ((await handle.stat()).isFile()) await handle.sync();
				} catch (error) {
					if (!["ENOENT", "ELOOP"].includes(error?.code)) throw error;
				} finally { await handle?.close(); }
			}
			let parent = stat?.isDirectory() ? target : path.dirname(target);
			while (parent === root || parent.startsWith(`${root}${path.sep}`)) {
				directories.add(parent);
				if (parent === root) break;
				parent = path.dirname(parent);
			}
		}
		for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
			await syncDirectory(directory);
		}
	}

	#markerPath(record) { return `${path.resolve(record.directory)}.cc-worktree.json`; }

	async #readRecoveryCursor() {
		let handle;
		try {
			const cursorFile = path.join(this.root, ".recovery-cursor");
			const before = await fs.lstat(cursorFile);
			if (!before.isFile() || before.isSymbolicLink()) throw new Error("invalid workflow recovery cursor");
			handle = await fs.open(cursorFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		}
		catch (error) { if (error?.code === "ENOENT") return ""; throw error; }
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 512) return "";
			return (await readBoundedHandle(handle, 512, "invalid workflow recovery cursor")).toString("utf8").trim();
		} finally { await handle.close(); }
	}

	async #writeRecoveryCursor(cursor) {
		const destination = path.join(this.root, ".recovery-cursor");
		const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
		let handle;
		try {
			handle = await fs.open(temporary, "wx", 0o600);
			await handle.writeFile(`${String(cursor).slice(0, 511)}\n`);
			await handle.sync();
		} finally { await handle?.close(); }
		await fs.rename(temporary, destination);
		await syncDirectory(this.root);
	}

	async #recoverPreValidationMarker(record, deadline) {
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.canonicalRoot, record.repositoryFingerprint.device, record.repositoryFingerprint.inode, "workflow worktree repository identity changed");
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.commonDirectory, record.repositoryFingerprint.commonDevice, record.repositoryFingerprint.commonInode, "workflow worktree repository common-directory identity changed");
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.gitDirectory, record.repositoryFingerprint.gitDevice, record.repositoryFingerprint.gitInode, "workflow worktree repository Git-directory identity changed");
		const repositoryOperation = pinnedFingerprintOperation({ deadline }, record.repositoryFingerprint);
		const listed = await git(record.repositoryFingerprint.canonicalRoot, ["worktree", "list", "--porcelain"], repositoryOperation);
		const canonicalRoot = await fs.realpath(this.root);
		const expectedCanonicalDirectory = path.join(canonicalRoot, path.relative(this.root, record.directory));
		const registeredPath = listed.split(/\r?\n/u)
			.filter((line) => line.startsWith("worktree "))
			.map((line) => path.resolve(line.slice("worktree ".length)))
			.find((candidate) => candidate === path.resolve(expectedCanonicalDirectory));
		let directory;
		try { directory = await fs.realpath(record.directory); }
		catch (error) {
			if (error?.code !== "ENOENT") throw error;
			if (registeredPath) await git(record.repositoryFingerprint.canonicalRoot, ["worktree", "remove", "--force", registeredPath], repositoryOperation);
			await this.#removeMarker(record);
			return undefined;
		}
		if (directory !== expectedCanonicalDirectory) throw new Error("workflow pre-validation checkout identity changed");
		const directoryStat = await fs.lstat(directory, { bigint: true });
		const checkoutFingerprint = await this.repositoryFingerprint(directory, {
			deadline,
			cwdIdentity: { canonicalRoot: directory, device: String(directoryStat.dev), inode: String(directoryStat.ino) },
		});
		for (const key of ["commonDirectory", "commonDevice", "commonInode"]) {
			if (String(checkoutFingerprint[key]) !== String(record.repositoryFingerprint[key])) throw new Error("workflow pre-validation checkout common Git directory does not match its repository");
		}
		const ready = Object.freeze({ ...record, stage: "ready", checkoutFingerprint });
		await this.#writeMarker(ready);
		return ready;
	}

	async #writeMarker(record) {
		const marker = this.#markerPath(record);
		const temporary = `${marker}.${process.pid}.${randomUUID()}.tmp`;
		let handle;
		try {
			handle = await fs.open(temporary, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ version: 1, ...record })}\n`);
			await handle.sync();
		} finally { await handle?.close(); }
		await fs.rename(temporary, marker);
		await syncDirectory(path.dirname(marker));
	}

	async #readMarker(marker) {
		let handle;
		try {
			const before = await fs.lstat(marker);
			if (!before.isFile() || before.isSymbolicLink()) throw new Error("invalid workflow worktree marker");
			handle = await fs.open(marker, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
		}
		catch (error) { throw error; }
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > 16 * 1024) throw new Error("invalid workflow worktree marker");
			const record = JSON.parse((await readBoundedHandle(handle, 16 * 1024, "invalid workflow worktree marker")).toString("utf8"));
			const fingerprintKeys = ["canonicalRoot", "device", "inode", "commonDirectory", "commonDevice", "commonInode", "gitDirectory", "gitDevice", "gitInode"];
			const preValidation = record?.stage === "pre-add" && record.checkoutFingerprint === undefined;
			if (
				record?.version !== 1 || !record.directory || !record.repository || !record.base || !record.runId || !record.agentId || !Number.isSafeInteger(record.attempt) ||
				!fingerprintKeys.every((key) => record.repositoryFingerprint?.[key] !== undefined) ||
				(!preValidation && !fingerprintKeys.every((key) => record.checkoutFingerprint?.[key] !== undefined)) ||
				(record.stage !== undefined && !["pre-add", "ready"].includes(record.stage))
			) {
				throw new Error("invalid workflow worktree marker");
			}
			const expectedDirectory = marker.slice(0, -".cc-worktree.json".length);
			const expectedRunDirectory = path.join(this.root, safeSegment(record.runId));
			const expectedMarkerName = `${safeSegment(record.agentId)}-${record.attempt}.cc-worktree.json`;
			if (path.basename(marker) !== expectedMarkerName || path.dirname(marker) !== expectedRunDirectory || path.resolve(record.directory) !== path.resolve(expectedDirectory) || !path.resolve(record.directory).startsWith(`${this.root}${path.sep}`)) {
				throw new Error("unsafe workflow worktree marker");
			}
			return Object.freeze({
				stage: preValidation ? "pre-add" : "ready",
				directory: path.resolve(record.directory), repository: path.resolve(record.repository),
				repositoryFingerprint: Object.freeze({
					canonicalRoot: path.resolve(record.repositoryFingerprint.canonicalRoot),
					device: String(record.repositoryFingerprint.device), inode: String(record.repositoryFingerprint.inode),
					commonDirectory: path.resolve(record.repositoryFingerprint.commonDirectory),
					commonDevice: String(record.repositoryFingerprint.commonDevice), commonInode: String(record.repositoryFingerprint.commonInode),
					gitDirectory: path.resolve(record.repositoryFingerprint.gitDirectory),
					gitDevice: String(record.repositoryFingerprint.gitDevice), gitInode: String(record.repositoryFingerprint.gitInode),
				}),
				base: String(record.base),
				runId: String(record.runId), agentId: String(record.agentId), attempt: record.attempt,
				...(preValidation ? {} : { checkoutFingerprint: Object.freeze({
					canonicalRoot: path.resolve(record.checkoutFingerprint.canonicalRoot),
					device: String(record.checkoutFingerprint.device), inode: String(record.checkoutFingerprint.inode),
					commonDirectory: path.resolve(record.checkoutFingerprint.commonDirectory),
					commonDevice: String(record.checkoutFingerprint.commonDevice), commonInode: String(record.checkoutFingerprint.commonInode),
					gitDirectory: path.resolve(record.checkoutFingerprint.gitDirectory),
					gitDevice: String(record.checkoutFingerprint.gitDevice), gitInode: String(record.checkoutFingerprint.gitInode),
				}) }),
				...(typeof record.appliedAt === "string" && record.appliedAt ? { appliedAt: record.appliedAt } : {}),
			});
		} finally { await handle.close(); }
	}

	async #removeMarker(record) {
		const marker = this.#markerPath(record);
		await fs.unlink(marker).catch((error) => { if (error?.code !== "ENOENT") throw error; });
		await syncDirectory(path.dirname(marker));
		await fs.rmdir(path.dirname(marker)).catch((error) => { if (!["ENOENT", "ENOTEMPTY"].includes(error?.code)) throw error; });
	}

	async #validate(record, options = {}) {
		if (!record?.directory || !record?.repository || !record?.repositoryFingerprint || !record?.checkoutFingerprint || !record?.base) throw new Error("invalid workflow worktree record");
		const root = await fs.realpath(this.root);
		const directory = await fs.realpath(record.directory);
		if (!directory.startsWith(`${root}${path.sep}`)) throw new Error("workflow worktree is outside the managed root");
		if (directory !== record.checkoutFingerprint.canonicalRoot) throw new Error("workflow worktree checkout identity changed");
		await assertStoredDirectoryIdentity(directory, record.checkoutFingerprint.device, record.checkoutFingerprint.inode, "workflow worktree checkout identity changed");
		await assertStoredDirectoryIdentity(record.checkoutFingerprint.commonDirectory, record.checkoutFingerprint.commonDevice, record.checkoutFingerprint.commonInode, "workflow worktree checkout common-directory identity changed");
		await assertStoredDirectoryIdentity(record.checkoutFingerprint.gitDirectory, record.checkoutFingerprint.gitDevice, record.checkoutFingerprint.gitInode, "workflow worktree checkout Git-directory identity changed");
		const checkoutOperation = pinnedFingerprintOperation(options, record.checkoutFingerprint);
		if (path.resolve(record.repository) !== record.repositoryFingerprint.canonicalRoot) throw new Error("workflow worktree repository identity changed");
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.canonicalRoot, record.repositoryFingerprint.device, record.repositoryFingerprint.inode, "workflow worktree repository identity changed");
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.commonDirectory, record.repositoryFingerprint.commonDevice, record.repositoryFingerprint.commonInode, "workflow worktree repository common-directory identity changed");
		await assertStoredDirectoryIdentity(record.repositoryFingerprint.gitDirectory, record.repositoryFingerprint.gitDevice, record.repositoryFingerprint.gitInode, "workflow worktree repository Git-directory identity changed");
		const repositoryOperation = pinnedFingerprintOperation(options, record.repositoryFingerprint);
		const repository = record.repositoryFingerprint.canonicalRoot;
		return { repository, checkoutOperation, repositoryOperation };
	}

	async #targetState(repository, options = {}) {
		const head = (await git(repository, ["rev-parse", "HEAD"], options)).trim();
		const branch = (await git(repository, ["rev-parse", "--abbrev-ref", "HEAD"], options)).trim();
		const status = await git(repository, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
		const trackedDiff = await git(repository, ["--no-optional-locks", "diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], options);
		const stagedDiff = await git(repository, ["--no-optional-locks", "diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--", "."], options);
		const untracked = (await git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], options))
			.split("\0").filter(Boolean).sort();
		const untrackedHashes = [];
		for (const file of untracked) {
			const hash = (await git(repository, ["hash-object", "--", file], options)).trim();
			untrackedHashes.push(`${file}\0${hash}`);
		}
		const statusFingerprint = createHash("sha256")
			.update(status).update("\0").update(trackedDiff).update("\0").update(stagedDiff).update("\0").update(untrackedHashes.join("\0"))
			.digest("hex");
		return {
			head,
			branch,
			dirty: Boolean(status.trim()),
			statusFingerprint,
		};
	}
}
