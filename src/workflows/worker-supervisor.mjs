#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const TRACKING_FAILURE_EXIT = 86;
const IDENTITY_FAILURE_EXIT = 78;
// Non-terminal ACP supervisors translate every confirmed backend exit to this
// sentinel. Any other supervisor status is therefore unambiguously a crash or
// failed containment report, even if an uncaught exception happens to exit 1.
const CONFIRMED_ACP_EXIT = 85;
// The owning cc process grants five seconds before it force-kills this
// supervisor. Report an unconfirmed descendant tree well before that outer
// deadline; otherwise the parent could kill only this supervisor's process
// group while the separately-grouped backend remains alive.
const DESCENDANT_CONFIRMATION_DEADLINE_MS = 3_500;
const CHILD_ENVIRONMENT_MAX_BYTES = 1024 * 1024;

function readChildEnvironment(fd) {
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, CHILD_ENVIRONMENT_MAX_BYTES + 1 - bytes));
			const count = readSync(fd, buffer, 0, buffer.length, null);
			if (count === 0) break;
			bytes += count;
			if (bytes > CHILD_ENVIRONMENT_MAX_BYTES) throw new Error("workflow child environment exceeds its bound");
			chunks.push(buffer.subarray(0, count));
		}
	} finally { closeSync(fd); }
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error("workflow child environment is invalid");
	}
	for (const [name, entry] of Object.entries(value)) {
		if (!name || name.includes("=") || name.includes("\0") || typeof entry !== "string" || entry.includes("\0")) {
			throw new Error("workflow child environment contains an invalid entry");
		}
	}
	return value;
}

// Windows cannot provide the same lifetime guarantee without a Job Object:
// taskkill/polling has an unavoidable spawn-and-escape race. Dynamic workflows
// therefore fail before launching any child on Windows in this release.
if (process.platform === "win32") {
	process.stderr.write("dynamic workflow workers require a POSIX process platform\n");
	process.exit(TRACKING_FAILURE_EXIT);
}

let launchArgs = process.argv.slice(2);
let preserveNaturalExit = false;
if (launchArgs[0] === "--preserve-exit") {
	preserveNaturalExit = true;
	launchArgs = launchArgs.slice(1);
}
let ownerStdin = false;
if (launchArgs[0] === "--owner-stdin") {
	ownerStdin = true;
	launchArgs = launchArgs.slice(1);
}
let statusFd;
if (launchArgs[0] === "--status-fd") {
	statusFd = Number(launchArgs[1]);
	if (!Number.isInteger(statusFd) || statusFd < 3) process.exit(64);
	launchArgs = launchArgs.slice(2);
}
let childEnvironment = process.env;
if (launchArgs[0] === "--child-env-fd") {
	const childEnvironmentFd = Number(launchArgs[1]);
	if (!Number.isInteger(childEnvironmentFd) || childEnvironmentFd < 3 || childEnvironmentFd === statusFd) process.exit(64);
	launchArgs = launchArgs.slice(2);
	try { childEnvironment = readChildEnvironment(childEnvironmentFd); }
	catch (error) {
		process.stderr.write(`workflow child environment validation failed: ${error.message ?? error}\n`);
		process.exit(64);
	}
}
let expectedCwdIdentity;
if (launchArgs[0] === "--cwd-identity") {
	try {
		expectedCwdIdentity = JSON.parse(Buffer.from(String(launchArgs[1] ?? ""), "base64url").toString("utf8"));
		launchArgs = launchArgs.slice(2);
		const canonical = path.resolve(String(expectedCwdIdentity?.canonicalRoot ?? ""));
		const before = lstatSync(canonical, { bigint: true });
		if (!before.isDirectory() || before.isSymbolicLink() ||
			String(before.dev) !== String(expectedCwdIdentity?.device) ||
			String(before.ino) !== String(expectedCwdIdentity?.inode) ||
			realpathSync(canonical) !== canonical) {
			throw new Error("approved workflow working directory identity changed");
		}
		// chdir installs an OS-held reference to this exact directory. The second
		// identity check closes the rename/substitution window; descendants inherit
		// the pinned cwd without resolving the user-controlled pathname again.
		process.chdir(canonical);
		const pinned = statSync(".", { bigint: true });
		if (!pinned.isDirectory() || String(pinned.dev) !== String(before.dev) ||
			String(pinned.ino) !== String(before.ino)) {
			throw new Error("approved workflow working directory changed while it was being pinned");
		}
	} catch (error) {
		process.stderr.write(`workflow working-directory validation failed: ${error.message ?? error}\n`);
		process.exit(IDENTITY_FAILURE_EXIT);
	}
}

let expectedPathIdentity;
if (launchArgs[0] === "--path-identity") {
	try {
		expectedPathIdentity = JSON.parse(Buffer.from(String(launchArgs[1] ?? ""), "base64url").toString("utf8"));
		launchArgs = launchArgs.slice(2);
	} catch (error) {
		process.stderr.write(`workflow path-identity decoding failed: ${error.message ?? error}\n`);
		process.exit(IDENTITY_FAILURE_EXIT);
	}
}

let expectedGitDirectoryIdentity;
if (launchArgs[0] === "--git-dir-identity") {
	try {
		expectedGitDirectoryIdentity = JSON.parse(Buffer.from(String(launchArgs[1] ?? ""), "base64url").toString("utf8"));
		launchArgs = launchArgs.slice(2);
	} catch (error) {
		process.stderr.write(`workflow Git-directory identity decoding failed: ${error.message ?? error}\n`);
		process.exit(IDENTITY_FAILURE_EXIT);
	}
}

const [command, ...args] = launchArgs;
if (!command) process.exit(64);

// Git resolves its common directory independently of cwd. Recheck that stored
// inode in the supervisor immediately before each child spawn (including
// filter inspection and the final mutating apply) so a pathname substitution
// cannot redirect shared repository metadata after manager-side validation.
let gitDirectoryFd;
let gitCommonDirectoryFd;
function openPinnedDirectory(identity, label) {
	const canonical = path.resolve(String(identity?.canonicalRoot ?? ""));
	if (realpathSync(canonical) !== canonical) throw new Error(`${label} path is not canonical`);
	const fd = openSync(canonical, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
	const current = fstatSync(fd, { bigint: true });
	if (!current.isDirectory() || String(current.dev) !== String(identity?.device) || String(current.ino) !== String(identity?.inode)) {
		closeSync(fd);
		throw new Error(`${label} identity changed`);
	}
	return fd;
}
if (expectedPathIdentity || expectedGitDirectoryIdentity) {
	try {
		if (!expectedPathIdentity || !expectedGitDirectoryIdentity) throw new Error("both Git metadata identities are required");
		gitDirectoryFd = openPinnedDirectory(expectedGitDirectoryIdentity, "workflow Git directory");
		gitCommonDirectoryFd = openPinnedDirectory(expectedPathIdentity, "workflow Git common directory");
		childEnvironment = {
			...childEnvironment,
			// macOS fdesc paths cannot be traversed (`/dev/fd/N/objects` fails),
			// so Git cannot consume the held descriptors as repository paths. Keep
			// both validated descriptors open across spawn and give Git the exact
			// canonical paths whose identities they pin.
			GIT_DIR: path.resolve(expectedGitDirectoryIdentity.canonicalRoot),
			GIT_COMMON_DIR: path.resolve(expectedPathIdentity.canonicalRoot),
			GIT_WORK_TREE: ".",
		};
	} catch (error) {
		if (gitDirectoryFd !== undefined) closeSync(gitDirectoryFd);
		if (gitCommonDirectoryFd !== undefined) closeSync(gitCommonDirectoryFd);
		process.stderr.write(`workflow Git metadata validation failed: ${error.message ?? error}\n`);
		process.exit(IDENTITY_FAILURE_EXIT);
	}
}

let child;
try {
	child = spawn(command, args, {
		// Deliberately omit cwd: inherit the supervisor's OS-held cwd reference.
		env: childEnvironment,
		stdio: gitDirectoryFd === undefined
			? ["pipe", "pipe", "pipe"]
			: ["pipe", "pipe", "pipe", gitDirectoryFd, gitCommonDirectoryFd],
		shell: false,
		windowsHide: true,
		detached: true,
	});
} finally {
	if (gitDirectoryFd !== undefined) closeSync(gitDirectoryFd);
	if (gitCommonDirectoryFd !== undefined) closeSync(gitCommonDirectoryFd);
}
const tracked = new Map();
const psPath = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
let stopping = false;
let closed = false;
let naturalExitStatus;

function exitConfirmed(code, signal) {
	if (preserveNaturalExit && statusFd !== undefined) {
		try { writeFileSync(statusFd, `${JSON.stringify({ code: Number.isInteger(code) ? code : null, signal: signal ?? null })}\n`); }
		catch { process.exit(TRACKING_FAILURE_EXIT); }
		process.exit(CONFIRMED_ACP_EXIT);
	}
	process.exit(preserveNaturalExit ? (Number.isInteger(code) ? code : signal ? 1 : 0) : CONFIRMED_ACP_EXIT);
}

function refreshDescendants() {
	if (!child.pid || !psPath || !existsSync(psPath)) return false;
	const result = spawnSync(psPath, ["-axo", "pid=,ppid=,lstart="], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 1000, maxBuffer: 4 * 1024 * 1024,
		env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
	});
	if (result.error || result.status !== 0) return false;
	const rows = String(result.stdout).split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line))
		.filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), started: match[3] }));
	const live = new Map(rows.map((row) => [row.pid, row.started]));
	for (const [pid, started] of tracked) if (live.get(pid) !== started) tracked.delete(pid);
	const parents = new Set([child.pid, ...tracked.keys()]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (row.pid === process.pid || tracked.has(row.pid) || !parents.has(row.ppid)) continue;
			tracked.set(row.pid, row.started);
			parents.add(row.pid);
			changed = true;
		}
	}
	return true;
}

function childGroupAlive() {
	if (!child.pid) return false;
	try { process.kill(-child.pid, 0); return true; }
	catch (error) { return error?.code !== "ESRCH"; }
}

function signalTracked(signal) {
	for (const pid of tracked.keys()) {
		try { process.kill(pid, signal); }
		catch { /* absence is expected during teardown */ }
	}
}

function shutdown() {
	if (stopping) return;
	stopping = true;
	clearInterval(descendantTimer);
	const trackingReady = refreshDescendants();
	try { process.kill(-child.pid, "SIGTERM"); }
	catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
	signalTracked("SIGTERM");
	let forced = false;
	const startedAt = Date.now();
	const confirm = setInterval(() => {
		const trackingConfirmed = refreshDescendants();
		if (!trackingReady || !trackingConfirmed) {
			try { process.kill(-child.pid, "SIGKILL"); } catch { /* best effort before fencing */ }
			signalTracked("SIGKILL");
			process.stderr.write("workflow worker descendant tracking failed during shutdown\n");
			clearInterval(confirm);
			process.exit(TRACKING_FAILURE_EXIT);
		}
		if (!forced && Date.now() - startedAt >= 750) {
			forced = true;
			signalTracked("SIGKILL");
			try { process.kill(-child.pid, "SIGKILL"); }
			catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
		}
		if (!childGroupAlive() && tracked.size === 0) {
			clearInterval(confirm);
			exitConfirmed(naturalExitStatus?.code ?? 1, naturalExitStatus?.signal ?? null);
		}
		if (Date.now() - startedAt >= DESCENDANT_CONFIRMATION_DEADLINE_MS) {
			process.stderr.write("workflow worker escaped descendants could not be confirmed stopped\n");
			clearInterval(confirm);
			process.exit(TRACKING_FAILURE_EXIT);
		}
	}, 50);
}

// Ordinary configured harnesses are trusted local programs; 250 ms still tracks
// long-lived detached helpers without launching hundreds of `ps` scans/second at
// the global worker ceiling. Explicit foreground ownership covers bundled tmux.
const descendantTimer = setInterval(refreshDescendants, 250);
descendantTimer.unref?.();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, shutdown);
// Streaming workers inherently use stdin as their manager-owned lifetime pipe.
// Preserve-natural-exit callers opt in when stdin is ownership (managed
// terminals); short-lived Git supervisors instead use stdin only as /dev/null.
if (!preserveNaturalExit || ownerStdin) {
	process.stdin.on("end", shutdown);
	process.stdin.on("error", shutdown);
	if (preserveNaturalExit) process.stdin.resume();
}
process.stdout.on("error", shutdown);
process.stderr.on("error", shutdown);
child.once("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	if (!child.pid) {
		clearInterval(descendantTimer);
		process.exit(error?.code === "ENOENT" ? 127 : 126);
	}
	shutdown();
});
child.once("exit", (code, signal) => {
	naturalExitStatus = { code, signal };
	if (stopping) return;
	// `close` waits for inherited stdout/stderr descriptors. Begin owned tree
	// retirement from `exit` if an observed helper outlives its backend root.
	// Do not use the process-group probe until `close`: at `exit` the unreaped
	// leader itself can still make its otherwise-empty group appear live.
	if (!refreshDescendants() || tracked.size > 0) shutdown();
});
child.once("close", (code, signal) => {
	closed = true;
	clearInterval(descendantTimer);
	if (stopping) return;
	if (!refreshDescendants()) {
		process.stderr.write("workflow worker descendant tracking failed before exit\n");
		process.exit(TRACKING_FAILURE_EXIT);
	}
	if (preserveNaturalExit && tracked.size === 0 && !childGroupAlive()) {
		exitConfirmed(code, signal);
	}
	if (tracked.size > 0 || childGroupAlive()) { shutdown(); return; }
	exitConfirmed(code, signal);
});
if (preserveNaturalExit) child.stdin.end();
else process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdin.on("error", () => { if (!closed) shutdown(); });
