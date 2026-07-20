#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const TRACKING_FAILURE_EXIT = 86;
const IDENTITY_FAILURE_EXIT = 78;
// Non-terminal ACP supervisors translate every confirmed backend exit to this
// sentinel. Any other supervisor status is therefore unambiguously a crash or
// failed containment report, even if an uncaught exception happens to exit 1.
const CONFIRMED_ACP_EXIT = 85;
// The owning cc process grants 7.5 seconds before it force-kills this
// supervisor. Report an unconfirmed descendant tree well before that outer
// deadline; otherwise the parent could kill only this supervisor's process
// group while the separately-grouped backend remains alive.
const DESCENDANT_CONFIRMATION_DEADLINE_MS = 3_500;
const MINIMUM_ROOT_OBSERVATION_MS = 50;
const CHILD_ENVIRONMENT_MAX_BYTES = 1024 * 1024;
const supervisorProcessToken = randomUUID();
let linuxBootId;
if (process.platform === "linux") {
	try { linuxBootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
	catch { /* Linux descendant tracking fails closed if exact identities are unavailable. */ }
}

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
const childLaunchStartedAt = Date.now();
try {
	child = spawn(command, args, {
		// Deliberately omit cwd: inherit the supervisor's OS-held cwd reference.
		env: { ...childEnvironment, CC_WORKFLOW_SUPERVISOR_TOKEN: supervisorProcessToken },
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
const unidentified = new Set();
const psPath = existsSync("/bin/ps") ? "/bin/ps" : "/usr/bin/ps";
// Recent macOS releases can suppress process environments from `ps`, even for
// same-user children. Probe the just-spawned child once while its launch token
// is present; if unavailable, never perform the otherwise quadratic full-table
// token scan. Direct-child/group continuity remains the ownership proof.
const macEnvironmentTokensVisible = process.platform !== "darwin" || macProcessHasSupervisorToken(child.pid);
let stopping = false;
let trackingFailed = false;
let trackingFailureDetail;
let childProcessIdentity;
let childProcessStarted;
let childGroupGone = false;
let closed = false;
let naturalExitStatus;
let rootExitedBeforeOwnerShutdown = false;
let observedChildOutput = false;
child.stdout.on("data", () => { observedChildOutput = true; });
child.stderr.on("data", () => { observedChildOutput = true; });

function exitConfirmed(code, signal, errorCode) {
	if (preserveNaturalExit && statusFd !== undefined) {
		try { writeFileSync(statusFd, `${JSON.stringify({
			code: Number.isInteger(code) ? code : null,
			signal: signal ?? null,
			...(typeof errorCode === "string" && errorCode ? { errorCode } : {}),
		})}\n`); }
		catch { process.exit(TRACKING_FAILURE_EXIT); }
		process.exit(CONFIRMED_ACP_EXIT);
	}
	process.exit(preserveNaturalExit ? (Number.isInteger(code) ? code : signal ? 1 : 0) : CONFIRMED_ACP_EXIT);
}

function readProcessRows() {
	if (!child.pid || !psPath || !existsSync(psPath)) return undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = spawnSync(psPath, ["-axo", "pid=,ppid=,pgid=,lstart=,state=,comm="], {
			encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 1000, maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC" },
		});
		if (!result.error && result.status === 0) {
			return String(result.stdout).split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.*?)\s*$/u.exec(line))
				.filter(Boolean).map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4], state: match[5], command: match[6] }));
		}
		// An owner signal targets the supervisor's process group and can interrupt a
		// `ps` child which was already running while Node was blocked in spawnSync.
		// The signal is delivered to JavaScript only after this stack unwinds; one
		// immediate replacement probe is outside that already-delivered group signal.
	}
	return undefined;
}

function directChildRunningForOwnerShutdown(rowsOverride) {
	const rows = rowsOverride === undefined ? readProcessRows() : rowsOverride;
	const row = rows?.find((entry) => entry.pid === child.pid);
	if (!row || row.ppid !== process.pid || row.state.startsWith("Z") || row.pgid !== child.pid) return false;
	const currentIdentity = processIdentity(row);
	if (!childProcessIdentity) {
		// A reaped PID may be reused before Node dispatches the queued child-exit
		// callback. `processIdentity()` accepts the root only while it is still this
		// supervisor's live direct child and detached group leader.
		if (!currentIdentity) return false;
		childProcessIdentity = currentIdentity;
		childProcessStarted = row.started;
		return true;
	}
	if (currentIdentity) return currentIdentity === childProcessIdentity;
	// A previously token-proven macOS root may scrub its environment via exec,
	// but only while the same non-zombie direct child and start instant remain.
	return childProcessStarted === row.started && naturalExitStatus === undefined;
}

// PPID legitimately changes when a backend root exits before its helpers. The
// process group and executable remain stable across that reparenting and,
// combined with the kernel-reported start instant, prevent a recycled PID from
// inheriting an old descendant record.
function processIdentity(row, verifyParent = false) {
	if (process.platform === "linux") {
		if (!linuxBootId) return undefined;
		try {
			const stat = readFileSync(`/proc/${row.pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const fields = close >= 0 ? stat.slice(close + 2).trim().split(/\s+/u) : [];
			const currentPpid = Number(fields[1]);
			const currentPgid = Number(fields[2]);
			const startTicks = fields[19];
			if (!startTicks || currentPgid !== row.pgid || (verifyParent && currentPpid !== row.ppid)) return undefined;
			return `linux:${linuxBootId}:${startTicks}`;
		} catch { return undefined; }
	}
	// Modern macOS can suppress another process's environment even for the same
	// user, so the inherited token is not a universally available root probe.
	// The spawned root is nevertheless unambiguous while it remains our live
	// direct child and its own detached process-group leader: no unrelated
	// process can acquire this PPID, and a reaped `ps` helper inherits our group
	// instead of the backend's numeric PGID. Bind that relationship to the
	// kernel-reported start instant so an environment-scrubbing exec is safe.
	if (row.pid === child.pid && row.ppid === process.pid && row.pgid === child.pid && !row.state.startsWith("Z")) {
		return JSON.stringify(["mac-root", row.pid, row.pgid, row.started]);
	}
	// The random inherited token remains an additional discriminator for
	// descendants on macOS versions which permit the process-table probe.
	if (hasSupervisorToken(row.pid)) {
		return JSON.stringify(["mac-token", row.pid, row.pgid, row.started, supervisorProcessToken]);
	}
	// Callers register this fallback only after proving the process is a live
	// descendant through PPID closure. Revalidation binds its second-resolution
	// start instant to both process group and executable. A later exec or an
	// indistinguishable same-second PID reuse therefore fails closed instead of
	// authorizing a signal to the changed process.
	return JSON.stringify(["mac-lineage", row.pid, row.pgid, row.started, row.command]);
}

function hasSupervisorToken(pid) {
	if (process.platform === "linux") {
		try {
			return readFileSync(`/proc/${pid}/environ`).toString("utf8").split("\0")
				.includes(`CC_WORKFLOW_SUPERVISOR_TOKEN=${supervisorProcessToken}`);
		} catch { return false; }
	}
	if (!macEnvironmentTokensVisible) return false;
	return macProcessHasSupervisorToken(pid);
}

function macProcessHasSupervisorToken(pid) {
	const tokenResult = spawnSync(psPath, ["eww", "-p", String(pid), "-o", "command="], {
		encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], shell: false, timeout: 1000, maxBuffer: 1024 * 1024,
	});
	return tokenResult.status === 0 && tokenResult.stdout.includes(`CC_WORKFLOW_SUPERVISOR_TOKEN=${supervisorProcessToken}`);
}

function macLineageLifetimeContinues(previousIdentity, currentIdentity) {
	if (process.platform !== "darwin") return false;
	try {
		const previous = JSON.parse(previousIdentity);
		const current = JSON.parse(currentIdentity);
		return previous?.[0] === "mac-lineage" && current?.[0] === "mac-lineage" &&
			previous[1] === current[1] && previous[3] === current[3];
	} catch { return false; }
}

function refreshDescendants(discoverTokenPeers = false, rowsOverride) {
	if (trackingFailed) return false;
	const rows = rowsOverride === undefined ? readProcessRows() : rowsOverride;
	if (!rows) {
		trackingFailureDetail ??= "process table could not be read";
		return false;
	}
	const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
	const childRow = rowsByPid.get(child.pid);
	if (childRow && !childRow.state.startsWith("Z")) {
		const currentChildIdentity = processIdentity(childRow);
		if (!childProcessIdentity && childRow.ppid !== process.pid) {
			// Until the root is proven as this supervisor's live direct child, its
			// numeric PID and inherited token are insufficient: a queued child-exit
			// callback can race PID reuse. Never authorize that unrelated process group.
			unidentified.add(child.pid);
			trackingFailureDetail ??= `root ${child.pid} lost its direct-parent identity`;
		} else if (!currentChildIdentity) {
			// A process already proven by the per-launch token cannot leave and have
			// its numeric PID/PGID reused before the direct-child exit callback reaps
			// it. Keep that kernel group lease across an environment-scrubbing exec,
			// but bind it to the observed start instant and revoke it on child exit.
			if (!childProcessIdentity || childProcessStarted !== childRow.started || childRow.pgid !== child.pid ||
				childGroupGone || naturalExitStatus !== undefined) {
				unidentified.add(child.pid);
				trackingFailureDetail ??= `root ${child.pid} could not be reidentified`;
			}
		}
		else if (!childProcessIdentity) {
			childProcessIdentity = currentChildIdentity;
			childProcessStarted = childRow.started;
		}
		else if (currentChildIdentity !== childProcessIdentity) childGroupGone = true;
	}
	const lineageParents = new Set([child.pid, ...tracked.keys()]);
	for (const [pid, recordedIdentity] of tracked) {
		const row = rowsByPid.get(pid);
		const currentIdentity = row ? processIdentity(row) : undefined;
		if (!row || row.state.startsWith("Z")) tracked.delete(pid);
		else if (currentIdentity && currentIdentity !== recordedIdentity) {
			// A proven live child can call exec()/setsid() between process-table
			// samples. While its PPID is still inside the already-proven lineage, keep
			// the same PID/start lifetime and adopt the new executable/group tuple.
			if (lineageParents.has(row.ppid) && macLineageLifetimeContinues(recordedIdentity, currentIdentity)) {
				tracked.set(pid, currentIdentity);
			} else {
				tracked.delete(pid);
				unidentified.add(pid);
				trackingFailureDetail ??= `descendant ${pid} changed identity`;
			}
		}
		else if (!currentIdentity && (row.pgid !== child.pid || childGroupGone)) {
			unidentified.add(pid);
			trackingFailureDetail ??= `descendant ${pid} could not be reidentified`;
		}
	}
	const parents = new Set([child.pid, ...tracked.keys()]);
	const discovered = [];
	let changed = true;
	while (changed) {
		changed = false;
		for (const row of rows) {
			if (row.state.startsWith("Z") || row.pid === process.pid || tracked.has(row.pid) || parents.has(row.pid) || !parents.has(row.ppid)) continue;
			discovered.push(row);
			parents.add(row.pid);
			changed = true;
		}
	}
	// A backend may create a detached process group and exit before the next
	// periodic PPID scan. At root exit/shutdown, recover those reparented peers by
	// the unguessable environment token inherited from this supervisor launch.
	// This intentionally runs only at those lifecycle boundaries rather than on
	// every poll, avoiding a process-table-wide environment probe at steady state.
	if (discoverTokenPeers && macEnvironmentTokensVisible) {
		for (const row of rows) {
			if (row.state.startsWith("Z") || row.pid === process.pid || row.pid === child.pid || tracked.has(row.pid) || parents.has(row.pid)) continue;
			if (hasSupervisorToken(row.pid)) discovered.push(row);
		}
	}
	for (const row of discovered) {
		const discoveredIdentity = processIdentity(row, true);
		if (discoveredIdentity) tracked.set(row.pid, discoveredIdentity);
		// Members which remain in the backend's original process group are owned
		// by that still-live kernel group identity and are signalled as a group.
		// Detached descendants require their own reuse-safe identity.
		else if (row.pgid !== child.pid) {
			unidentified.add(row.pid);
			trackingFailureDetail ??= `new detached descendant ${row.pid} could not be identified`;
		}
	}
	if (unidentified.size > 0) {
		// A freshly observed descendant without a reuse-safe identity cannot be
		// followed or safely signalled after reparenting. Latch the failure so a
		// later clean scan can never turn the shutdown into a false confirmation;
		// never send a signal to a PID whose lifetime cannot be revalidated.
		trackingFailed = true;
		return false;
	}
	return true;
}

function verifiedChildGroupRows(rowsOverride) {
	if (!child.pid || childGroupGone) return [];
	if (trackingFailed) return undefined;
	const rows = rowsOverride === undefined ? readProcessRows() : rowsOverride;
	if (!rows) { trackingFailed = true; return undefined; }
	let ownedMember = false;
	for (const row of rows) {
		if (row.pgid !== child.pid || row.state.startsWith("Z")) continue;
		const recordedIdentity = row.pid === child.pid ? childProcessIdentity : tracked.get(row.pid);
		const currentIdentity = row.pid === child.pid || recordedIdentity ? processIdentity(row) : undefined;
		if (row.pid === child.pid && currentIdentity && !childProcessIdentity) {
			if (row.ppid !== process.pid) trackingFailed = true;
			else {
				childProcessIdentity = currentIdentity;
				childProcessStarted = row.started;
				ownedMember = true;
			}
		} else if (recordedIdentity && currentIdentity === recordedIdentity) ownedMember = true;
		else if (recordedIdentity && !currentIdentity && row.pgid === child.pid && !childGroupGone &&
			(row.pid !== child.pid || (naturalExitStatus === undefined && row.started === childProcessStarted))) {
			// The identity was token-proven before an exec scrubbed its environment;
			// the still-live original process group remains a non-reusable lease.
			ownedMember = true;
		}
		else if (row.pid === child.pid && !currentIdentity) trackingFailed = true;
		else if (recordedIdentity) trackingFailed = true;
		else if (!recordedIdentity && hasSupervisorToken(row.pid)) {
			const groupMemberIdentity = processIdentity(row);
			if (groupMemberIdentity) {
				tracked.set(row.pid, groupMemberIdentity);
				ownedMember = true;
			}
		}
		else if (!childGroupGone) {
			// A PGID cannot be reused while any member of the existing group remains.
			// This safely retains ownership of same-group helpers which intentionally
			// replaced their environment and therefore no longer carry our token.
			ownedMember = true;
		}
	}
	// An identity mismatch permanently revokes group ownership. A second,
	// untracked member of a recycled numeric PGID must never re-authorize it.
	if (trackingFailed) return undefined;
	if (!ownedMember) {
		// Once no identity-verified member remains, this numeric PGID is never
		// considered ours again; the kernel may recycle it immediately.
		childGroupGone = true;
		return [];
	}
	return rows;
}

function signalChildGroup(signal, rowsOverride) {
	const rows = verifiedChildGroupRows(rowsOverride);
	if (!rows || rows.length === 0) return false;
	try { process.kill(-child.pid, signal); return true; }
	catch (error) {
		if (error?.code === "ESRCH") childGroupGone = true;
		else trackingFailed = true;
		return false;
	}
}

function childGroupAlive(rowsOverride) {
	const rows = verifiedChildGroupRows(rowsOverride);
	if (!rows) return true;
	if (rows.length === 0) return false;
	try { process.kill(-child.pid, 0); return true; }
	catch (error) {
		if (error?.code === "ESRCH") { childGroupGone = true; return false; }
		trackingFailed = true;
		return true;
	}
}

function signalTracked(signal, rowsOverride) {
	const rows = rowsOverride === undefined ? readProcessRows() : rowsOverride;
	if (!rows) { trackingFailed = true; return false; }
	const rowsByPid = new Map(rows.map((row) => [row.pid, row]));
	for (const [pid, recordedIdentity] of tracked) {
		const row = rowsByPid.get(pid);
		if (row?.state.startsWith("Z")) {
			tracked.delete(pid);
			continue;
		}
		const currentIdentity = row ? processIdentity(row) : undefined;
		if (row && currentIdentity && currentIdentity !== recordedIdentity &&
			(row.ppid === child.pid || tracked.has(row.ppid)) &&
			macLineageLifetimeContinues(recordedIdentity, currentIdentity)) {
			tracked.set(pid, currentIdentity);
		}
		const effectiveIdentity = tracked.get(pid);
		if (row && !currentIdentity && row.pgid === child.pid && !childGroupGone) continue;
		if (!row || currentIdentity !== effectiveIdentity) {
			tracked.delete(pid);
			if (row && !currentIdentity) trackingFailed = true;
			continue;
		}
		try { process.kill(pid, signal); }
		catch (error) {
			if (error?.code === "ESRCH") tracked.delete(pid);
			else trackingFailed = true;
		}
	}
	return true;
}

function fenceTrackingFailure() {
	trackingFailed = true;
	if (!stopping) shutdown();
}

function shutdown() {
	if (stopping) return;
	const startedAt = Date.now();
	// One kernel snapshot must drive each shutdown phase. Re-reading the entire
	// process table for the root, descendants, group, and detached children made
	// the nominal deadline additive under a slow `ps`, allowing the owner to kill
	// this supervisor before it could report or fence an unconfirmed backend.
	const shutdownRows = readProcessRows() ?? null;
	if (!preserveNaturalExit && naturalExitStatus === undefined && !directChildRunningForOwnerShutdown(shutdownRows)) {
		// A signal/EOF can be dispatched before Node's already-queued child-exit
		// callback. Do not let that event ordering relabel a pre-dead backend as an
		// owner-driven shutdown with a clean attestation.
		rootExitedBeforeOwnerShutdown = true;
	}
	stopping = true;
	clearInterval(descendantTimer);
	const trackingReady = !trackingFailed && refreshDescendants(true, shutdownRows);
	signalChildGroup("SIGTERM", shutdownRows);
	signalTracked("SIGTERM", shutdownRows);
	let forced = false;
	const confirm = setInterval(() => {
		const confirmationRows = readProcessRows() ?? null;
		const trackingConfirmed = refreshDescendants(false, confirmationRows);
		if (!trackingReady || !trackingConfirmed) {
			signalChildGroup("SIGKILL", confirmationRows);
			signalTracked("SIGKILL", confirmationRows);
			const detail = trackingFailureDetail ? `: ${trackingFailureDetail}` : "";
			process.stderr.write(`workflow worker descendant tracking failed during shutdown${detail}\n`);
			clearInterval(confirm);
			process.exit(TRACKING_FAILURE_EXIT);
		}
		if (!forced && Date.now() - startedAt >= 750) {
			forced = true;
			signalTracked("SIGKILL", confirmationRows);
			signalChildGroup("SIGKILL", confirmationRows);
		}
		if (!childGroupAlive(confirmationRows) && tracked.size === 0) {
			clearInterval(confirm);
			if (rootExitedBeforeOwnerShutdown) {
				process.stderr.write("workflow streaming backend exited before owner-driven shutdown\n");
				process.exit(TRACKING_FAILURE_EXIT);
			}
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
const descendantTimer = setInterval(() => {
	if (!refreshDescendants()) fenceTrackingFailure();
}, 250);
descendantTimer.unref?.();
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, shutdown);
// Streaming workers inherently use stdin as their manager-owned lifetime pipe.
// Preserve-natural-exit callers opt in when stdin is ownership (managed
// terminals); short-lived Git supervisors instead use stdin only as /dev/null.
if (!preserveNaturalExit || ownerStdin) {
	process.stdin.on("end", shutdown);
	process.stdin.on("error", shutdown);
	// A piped readable remains paused when it has only an `end` listener. Start
	// consuming the owner pipe in every mode where EOF is the lifetime signal;
	// otherwise manager death can leave a streaming worker running indefinitely.
	process.stdin.resume();
}
process.stdout.on("error", shutdown);
process.stderr.on("error", shutdown);
child.once("error", (error) => {
	process.stderr.write(`${error.message}\n`);
	if (!child.pid) {
		clearInterval(descendantTimer);
		exitConfirmed(null, null, error?.code ?? "CHILD_SPAWN_FAILED");
	}
	shutdown();
});
child.once("exit", (code, signal) => {
	naturalExitStatus = { code, signal };
	if (stopping) return;
	if (!preserveNaturalExit) {
		// Streaming ACP workers are owned by the manager's stdin lifetime. Their
		// backend root must therefore never disappear before owner-driven shutdown:
		// a root that exits between process-table samples could have daemonized an
		// environment-scrubbed helper which is no longer discoverable by PPID or the
		// launch token. Fence instead of issuing a false clean-tree attestation.
		rootExitedBeforeOwnerShutdown = true;
		shutdown();
		return;
	}
	// `close` waits for inherited stdout/stderr descriptors. Begin owned tree
	// retirement from `exit` if an observed helper outlives its backend root.
	// Do not use the process-group probe until `close`: at `exit` the unreaped
	// leader itself can still make its otherwise-empty group appear live.
	if (!refreshDescendants(true) || tracked.size > 0) shutdown();
});
child.once("close", (code, signal) => {
	closed = true;
	clearInterval(descendantTimer);
	if (stopping) return;
	if (!expectedCwdIdentity && !ownerStdin && !observedChildOutput && Date.now() - childLaunchStartedAt < MINIMUM_ROOT_OBSERVATION_MS) {
		process.stderr.write("workflow worker exited before descendant containment could be observed\n");
		process.exit(TRACKING_FAILURE_EXIT);
	}
	const closeRows = readProcessRows() ?? null;
	if (!refreshDescendants(true, closeRows)) {
		process.stderr.write("workflow worker descendant tracking failed before exit\n");
		process.exit(TRACKING_FAILURE_EXIT);
	}
	if (preserveNaturalExit && tracked.size === 0 && !childGroupAlive(closeRows)) {
		exitConfirmed(code, signal);
	}
	if (tracked.size > 0 || childGroupAlive(closeRows)) { shutdown(); return; }
	exitConfirmed(code, signal);
});
if (preserveNaturalExit) child.stdin.end();
else process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
child.stdin.on("error", () => { if (!closed) shutdown(); });
