import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { transformWorkflowSource } from "./meta.mjs";
import { WORKFLOW_LIMITS, boundedWorkflowText, safeJson } from "./types.mjs";

const CHILD_FILE = fileURLToPath(new URL("./sandbox-child.mjs", import.meta.url));
const MACOS_SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let probeResult;

function seatbeltLiteral(value) {
	const text = String(value);
	if (/[\u0000\r\n]/u.test(text)) throw new Error("workflow sandbox path contains an unsupported character");
	return JSON.stringify(text);
}

function resolveDyldPath(reference, owner, executable) {
	const suffix = reference.replace(/^@(rpath|loader_path|executable_path)\/?/u, "");
	const candidates = reference.startsWith("@loader_path/")
		? [path.join(path.dirname(owner), suffix)]
		: reference.startsWith("@executable_path/")
			? [path.join(path.dirname(executable), suffix)]
			: reference.startsWith("@rpath/")
				? [path.join(path.dirname(owner), suffix), path.join(path.dirname(executable), "..", "lib", suffix)]
				: [reference];
	for (const candidate of candidates) {
		try { return fs.realpathSync(candidate); } catch { /* try the next loader location */ }
	}
	// Modern macOS keeps many /usr/lib and framework images only in the signed
	// dyld shared cache. system.sb grants those platform resources; there is no
	// filesystem object to add to the private manifest or recurse through.
	if (reference.startsWith("/usr/lib/") || reference.startsWith("/System/Library/")) return undefined;
	throw new Error(`workflow sandbox could not resolve the Node runtime dependency ${reference}`);
}

function nodeRuntimeFiles(executable) {
	const files = new Set([executable]);
	const pending = [executable];
	while (pending.length > 0) {
		if (files.size > 256) throw new Error("workflow sandbox Node dependency manifest is unexpectedly large");
		const owner = pending.pop();
		const inspected = spawnSync("/usr/bin/otool", ["-L", owner], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
		if (inspected.status !== 0) throw new Error(`workflow sandbox could not inspect Node runtime dependencies: ${inspected.stderr?.trim() || "otool failed"}`);
		for (const line of inspected.stdout.split("\n").slice(1)) {
			const marker = line.indexOf(" (");
			if (marker < 0) continue;
			const reference = line.slice(0, marker).trim();
			if (!reference) continue;
			const dependency = resolveDyldPath(reference, owner, executable);
			if (!dependency) continue;
			if (path.isAbsolute(reference)) files.add(path.resolve(reference));
			if (!files.has(dependency)) {
				files.add(dependency);
				pending.push(dependency);
			}
		}
	}
	return files;
}

function deniedRuntimeSibling(executable, readableFiles) {
	const root = path.resolve(path.dirname(executable), "..");
	for (const name of ["LICENSE", "README.md", "INSTALL_RECEIPT.json", "package.json"]) {
		const candidate = path.join(root, name);
		try {
			if (fs.statSync(candidate).isFile() && !readableFiles.has(fs.realpathSync(candidate))) return candidate;
		} catch { /* optional probe target */ }
	}
	return undefined;
}

function addManifestPath(target, readableFiles) {
	const absolute = path.resolve(target);
	readableFiles.add(absolute);
	try { readableFiles.add(fs.realpathSync(absolute)); } catch { /* dependency inspection validates required targets */ }
	let cursor = path.parse(absolute).root;
	for (const segment of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, segment);
		try {
			if (fs.lstatSync(cursor).isSymbolicLink()) readableFiles.add(cursor);
		} catch { break; }
	}
}

function homebrewLibraryDirectory(file) {
	const directory = path.dirname(file);
	return /^\/(?:opt\/homebrew|usr\/local)\/(?:opt\/[^/]+|Cellar\/[^/]+\/[^/]+)\/lib(?:\/|$)/u.test(directory)
		? directory
		: undefined;
}

export function macOsSandboxProfile() {
	const executable = fs.realpathSync(process.execPath);
	const runtimeFiles = nodeRuntimeFiles(executable);
	const readableFiles = new Set();
	for (const file of [...runtimeFiles, CHILD_FILE]) addManifestPath(file, readableFiles);
	const readable = [...readableFiles].map((file) => `(literal ${seatbeltLiteral(file)})`).join(" ");
	// dyld resolves Homebrew's versioned library symlinks by directory vnode, so
	// literals alone are insufficient. Grant only each dependency formula's lib
	// directory—not the Node prefix, Cellar, opt, or a caller-owned project tree.
	const readableLibraryDirectories = new Set([...runtimeFiles].map(homebrewLibraryDirectory).filter(Boolean));
	const libraryReadable = [...readableLibraryDirectories].map((directory) => `(subpath ${seatbeltLiteral(directory)})`).join(" ");
	const metadata = [...readableFiles].map((file) => `(path-ancestors ${seatbeltLiteral(file)})`).join(" ");
	return {
		executable,
		deniedRuntimePath: deniedRuntimeSibling(executable, readableFiles),
		profile: `(version 1)
(deny default)
(import "system.sb")
(allow process-exec (literal ${seatbeltLiteral(executable)}))
(allow signal (target self))
(allow file-read* file-test-existence file-map-executable
	  ${readable}
	  ${libraryReadable})
(allow file-read-metadata file-test-existence ${metadata})`,
	};
}

function productionSandboxCommand(nodeArguments) {
	if (process.platform === "darwin" && fs.existsSync(MACOS_SANDBOX_EXEC)) {
		const seatbelt = macOsSandboxProfile();
		return {
			command: MACOS_SANDBOX_EXEC,
			args: ["-p", seatbelt.profile, seatbelt.executable, ...nodeArguments],
			osBoundary: "macOS Seatbelt",
			seatbelt,
		};
	}
	return undefined;
}

function errorFromWire(value) {
	const error = new Error(String(value?.message ?? "Workflow sandbox failed"));
	error.name = String(value?.name ?? "Error");
	error.code = String(value?.code ?? "WORKFLOW_SANDBOX_FAILED");
	return error;
}

function killProcessTree(child, signal = "SIGTERM") {
	if (!child?.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (error?.code !== "ESRCH") {
			try { child.kill(signal); } catch { /* already gone */ }
		}
	}
}

export function probeWorkflowSandbox(options = {}) {
	if (probeResult && !options.force) return probeResult;
	let sandboxCommand;
	try { sandboxCommand = productionSandboxCommand([]); }
	catch (error) {
		probeResult = Object.freeze({ ok: false, node: process.version, message: `workflow OS sandbox dependency inspection failed: ${error.message ?? error}` });
		return probeResult;
	}
	if (!sandboxCommand) {
		probeResult = Object.freeze({
			ok: false,
			node: process.version,
			message: `workflow OS sandbox is unavailable on ${process.platform}; this release requires macOS sandbox-exec`,
		});
		return probeResult;
	}
	const probeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-workflow-sandbox-probe-"));
	const deniedPath = path.join(probeDirectory, "secret");
	fs.writeFileSync(deniedPath, "secret", { mode: 0o600 });
	const osCode = String.raw`
const fs = require("node:fs");
const child = require("node:child_process");
const net = require("node:net");
const denied = {};
try { fs.readFileSync(process.argv[1]); denied.read = false; } catch (error) { denied.read = ["EPERM", "EACCES"].includes(error?.code); }
try { fs.writeFileSync(process.argv[1] + ".write", "x"); denied.write = false; } catch (error) { denied.write = ["EPERM", "EACCES"].includes(error?.code); }
if (process.argv[2]) { try { fs.readFileSync(process.argv[2]); denied.runtime = false; } catch (error) { denied.runtime = ["EPERM", "EACCES"].includes(error?.code); } } else denied.runtime = true;
const spawned = child.spawnSync(process.execPath, ["-e", ""]); denied.child = ["EPERM", "EACCES"].includes(spawned.error?.code);
const socket = net.createConnection({ host: "127.0.0.1", port: 9 });
let finished = false;
const finish = (value) => { if (finished) return; finished = true; denied.net = value; process.stdout.write(JSON.stringify({ denied, inherited: process.env.CC_WORKFLOW_PROBE_SECRET })); };
socket.once("connect", () => { socket.destroy(); finish(false); });
socket.once("error", (error) => finish(["EPERM", "EACCES"].includes(error?.code)));
setTimeout(() => { socket.destroy(); finish(false); }, 1000).unref();
`;
	const osResult = spawnSync(sandboxCommand.command, [
		"-p", sandboxCommand.seatbelt.profile, sandboxCommand.seatbelt.executable, "-e", osCode, deniedPath, sandboxCommand.seatbelt.deniedRuntimePath ?? "",
	], {
		encoding: "utf8",
		timeout: 5000,
		env: { CC_WORKFLOW_SANDBOX: "1", OPENSSL_CONF: "/dev/null" },
		windowsHide: true,
	});
	const code = String.raw`
const fs = require("node:fs");
const child = require("node:child_process");
const worker = require("node:worker_threads");
const denied = {};
try { fs.readFileSync(process.argv[1]); denied.read = false; } catch (error) { denied.read = error?.code === "ERR_ACCESS_DENIED"; }
try { fs.writeFileSync(process.argv[1] + ".cc-probe", "x"); denied.write = false; } catch (error) { denied.write = error?.code === "ERR_ACCESS_DENIED"; }
try { denied.net = process.permission.has("net") === false; } catch { denied.net = false; }
try { child.spawnSync(process.execPath, ["-e", ""]); denied.child = false; } catch (error) { denied.child = error?.code === "ERR_ACCESS_DENIED"; }
try { new worker.Worker("", { eval: true }); denied.worker = false; } catch (error) { denied.worker = error?.code === "ERR_ACCESS_DENIED"; }
const inherited = process.env.CC_WORKFLOW_PROBE_SECRET;
process.stdout.write(JSON.stringify({ denied, inherited }));
`;
	const result = spawnSync(process.execPath, ["--permission", "--no-addons", "--disable-sigusr1", "-e", code, path.resolve(options.deniedPath ?? deniedPath)], {
		encoding: "utf8",
		timeout: 5000,
		env: { CC_WORKFLOW_SANDBOX: "1" },
		windowsHide: true,
	});
	let detail;
	let osDetail;
	try { detail = JSON.parse(result.stdout || "{}"); } catch { detail = {}; }
	try { osDetail = JSON.parse(osResult.stdout || "{}"); } catch { osDetail = {}; }
	fs.rmSync(probeDirectory, { recursive: true, force: true });
	const osOk = osResult.status === 0 && ["read", "write", "runtime", "net", "child"].every((name) => osDetail.denied?.[name] === true) && osDetail.inherited === undefined;
	const nodeOk = result.status === 0 && ["read", "write", "net", "child", "worker"].every((name) => detail.denied?.[name] === true) && detail.inherited === undefined;
	const ok = osOk && nodeOk;
	probeResult = Object.freeze({
		ok,
		node: process.version,
		message: ok
			? `strict workflow sandbox available (${sandboxCommand.osBoundary} + Node permission defense in depth)`
			: `workflow sandbox probe failed${!osOk && osResult.stderr ? ` (OS: ${osResult.stderr.trim()})` : ""}${!nodeOk && result.stderr ? ` (Node: ${result.stderr.trim()})` : ""}`,
	});
	return probeResult;
}

export class WorkflowSandbox {
	constructor(options) {
		this.source = options.source;
		this.args = options.args ?? null;
		this.tokenBudget = options.tokenBudget ?? null;
		this.onRequest = options.onRequest;
		this.onEvent = options.onEvent ?? (() => {});
		this.onTerminationFailure = options.onTerminationFailure ?? (() => {});
		this.timeoutMs = Math.min(options.timeoutMs ?? WORKFLOW_LIMITS.defaultScriptTimeoutMs, WORKFLOW_LIMITS.maxScriptTimeoutMs);
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? WORKFLOW_LIMITS.heartbeatTimeoutMs;
		this.requestLimit = Math.min(options.requestLimit ?? WORKFLOW_LIMITS.maxSandboxRequests, WORKFLOW_LIMITS.maxSandboxRequests);
		this.pendingRequestLimit = Math.min(options.pendingRequestLimit ?? WORKFLOW_LIMITS.maxPendingSandboxRequests, WORKFLOW_LIMITS.maxPendingSandboxRequests);
		this.child = undefined;
		this.finished = false;
		this.pendingRequests = new Set();
		this.terminate = undefined;
	}

	async run(signal) {
		const probe = probeWorkflowSandbox();
		if (!probe.ok) throw Object.assign(new Error(probe.message), { code: "WORKFLOW_SANDBOX_UNAVAILABLE" });
		if (signal?.aborted) throw signal.reason ?? new Error("Workflow aborted");
		const transformed = transformWorkflowSource(this.source);
		const args = [
			"--permission",
			`--allow-fs-read=${CHILD_FILE}`,
			"--no-addons",
			"--disable-sigusr1",
			"--jitless",
			`--max-old-space-size=${WORKFLOW_LIMITS.sandboxHeapMb}`,
			CHILD_FILE,
		];
		const sandboxCommand = productionSandboxCommand(args);
		if (!sandboxCommand) throw Object.assign(new Error("workflow OS sandbox is unavailable"), { code: "WORKFLOW_SANDBOX_UNAVAILABLE" });
		const child = spawn(sandboxCommand.command, sandboxCommand.args, {
			cwd: "/",
			env: { CC_WORKFLOW_SANDBOX: "1", OPENSSL_CONF: "/dev/null", LANG: "C", LC_ALL: "C", TZ: "UTC" },
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
			windowsHide: true,
		});
		this.child = child;
		return new Promise((resolve, reject) => {
			let output = "";
			let stderr = "";
			let lastHeartbeat = Date.now();
			let settled = false;
			let resultReady = false;
			let resultValue;
			let workflowEventBytes = 0;
			let workflowEventCount = 0;
			let requestCount = 0;
			let quiescenceTimer;
			let completingSuccess = false;
			let successKillTimer;
			let successConfirmationTimer;
			let terminationError;
			let terminationKillTimer;
			let terminationConfirmationTimer;
			let memoryCheckTimer;
			let memoryCheckActive = false;
			let outboundQueue = [];
			let outboundQueueBytes = 0;
			let outboundWriteActive = false;
			const decoder = new StringDecoder("utf8");
			const finish = (error, value) => {
				if (settled) return;
				settled = true;
				this.finished = true;
				this.terminate = undefined;
				clearTimeout(wallTimer);
				clearInterval(heartbeatTimer);
				clearTimeout(quiescenceTimer);
				clearTimeout(successKillTimer);
				clearTimeout(successConfirmationTimer);
				clearTimeout(terminationKillTimer);
				clearTimeout(terminationConfirmationTimer);
				clearInterval(memoryCheckTimer);
				outboundQueue = [];
				outboundQueueBytes = 0;
				signal?.removeEventListener("abort", onAbort);
				if (error) reject(error);
				else resolve(value);
			};
			// macOS does not enforce RLIMIT_AS for Node processes. The approved VM has
			// no external-memory constructors and V8 has a heap ceiling; additionally
			// fence unexpected runtime/native growth with an independent RSS monitor.
			memoryCheckTimer = setInterval(() => {
				if (settled || memoryCheckActive || !child.pid) return;
				memoryCheckActive = true;
				const meter = spawn("/bin/ps", ["-o", "rss=", "-p", String(child.pid)], { stdio: ["ignore", "pipe", "ignore"] });
				let rss = "";
				meter.stdout.on("data", (chunk) => { rss += chunk.toString("utf8").slice(0, 64); });
				meter.once("close", () => {
					memoryCheckActive = false;
					if (settled) return;
					const rssKb = Number.parseInt(rss.trim(), 10);
					if (Number.isFinite(rssKb) && rssKb > WORKFLOW_LIMITS.sandboxRssMb * 1024) {
						terminate(Object.assign(new Error("workflow sandbox exceeded its process memory limit"), { code: "WORKFLOW_SANDBOX_MEMORY_LIMIT" }));
					}
				});
				meter.once("error", () => { memoryCheckActive = false; });
			}, 100);
			const terminate = (error) => {
				if (settled || terminationError) return;
				terminationError = error;
				killProcessTree(child, "SIGTERM");
				// Keep these timers referenced. Normal settlement comes from the child exit
				// event; a missing post-SIGKILL event becomes an explicit process fence so
				// workflow disable/shutdown cannot wait forever or claim clean teardown.
				terminationKillTimer = setTimeout(() => {
					killProcessTree(child, "SIGKILL");
					terminationConfirmationTimer = setTimeout(() => {
						const failure = Object.assign(new Error("workflow sandbox process tree did not report exit after SIGKILL"), {
							code: "WORKFLOW_SANDBOX_TREE_TERMINATION_FAILED",
							cause: terminationError,
						});
						try { this.onTerminationFailure(failure); } catch { /* preserve the process fence */ }
						finish(failure);
					}, 1500);
				}, 1500);
			};
			this.terminate = terminate;
			const flushOutbound = () => {
				if (settled || outboundWriteActive || outboundQueue.length === 0 || child.stdin.destroyed || child.stdin.writableEnded) return;
				outboundWriteActive = true;
				const current = outboundQueue[0];
				try {
					child.stdin.write(current.serialized, (error) => {
						outboundWriteActive = false;
						if (settled) return;
						outboundQueue.shift();
						outboundQueueBytes -= current.bytes;
						if (error) terminate(error);
						else flushOutbound();
					});
				} catch (error) {
					outboundWriteActive = false;
					terminate(error);
				}
			};
			const send = (message) => {
				if (settled || child.stdin.destroyed || child.stdin.writableEnded) return false;
				const serialized = `${safeJson(message, "sandbox response")}\n`;
				const bytes = Buffer.byteLength(serialized, "utf8");
				if (outboundQueueBytes + bytes > WORKFLOW_LIMITS.maxHostEventBytes) {
					terminate(Object.assign(new Error("workflow sandbox response queue exceeded its host memory bound"), { code: "WORKFLOW_SANDBOX_RESPONSE_QUEUE_LIMIT" }));
					return false;
				}
				outboundQueue.push({ serialized, bytes });
				outboundQueueBytes += bytes;
				flushOutbound();
				return true;
			};
			const sendOperationResponse = (id, ok, value) => {
				try {
					if (ok) send({ type: "response", id, ok: true, value: value ?? null });
					else send({ type: "response", id, ok: false, error: {
						name: String(value?.name ?? "Error").slice(0, 128),
						code: String(value?.code ?? "WORKFLOW_OPERATION_FAILED").slice(0, 128),
						message: String(value?.message ?? value).slice(0, WORKFLOW_LIMITS.maxEventText),
					} });
				} catch (error) {
					terminate(Object.assign(new Error(`workflow operation response crossed the bounded sandbox channel: ${String(error?.message ?? error).slice(0, 1024)}`, { cause: error }), { code: "WORKFLOW_RESPONSE_TOO_LARGE" }));
				}
			};
			const maybeFinish = () => {
				if (!resultReady || this.pendingRequests.size > 0 || settled || quiescenceTimer) return;
				// A response can schedule another unawaited runtime call in the VM's next
				// microtask turn. Require a short quiet period before declaring the graph
				// drained, and cancel it as soon as another request arrives.
				quiescenceTimer = setTimeout(() => {
					quiescenceTimer = undefined;
					if (!resultReady || this.pendingRequests.size > 0 || settled) return;
					completingSuccess = true;
					killProcessTree(child, "SIGTERM");
					successKillTimer = setTimeout(() => {
						killProcessTree(child, "SIGKILL");
						successConfirmationTimer = setTimeout(() => {
							const failure = Object.assign(new Error("completed workflow sandbox process tree did not report exit after SIGKILL"), {
								code: "WORKFLOW_SANDBOX_TREE_TERMINATION_FAILED",
							});
							try { this.onTerminationFailure(failure); } catch { /* preserve the process fence */ }
							finish(failure);
						}, 1500);
					}, 1500);
				}, 50);
				quiescenceTimer.unref?.();
			};
			const receive = (message) => {
				if (message?.type === "heartbeat") { lastHeartbeat = Date.now(); return; }
				if (message?.type === "result") {
					safeJson(message.value, "workflow result", WORKFLOW_LIMITS.maxResultBytes);
					if (resultReady) throw new Error("workflow sandbox produced duplicate results");
					resultReady = true;
					resultValue = message.value;
					maybeFinish();
					return;
				}
				if (message?.type === "fatal") { terminate(errorFromWire(message.error)); return; }
				if (message?.type !== "request" || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.operation !== "string") {
					throw new Error("invalid workflow sandbox message");
				}
				requestCount += 1;
				if (requestCount > this.requestLimit) {
					terminate(Object.assign(new Error("workflow sandbox exceeded its total RPC request limit"), { code: "WORKFLOW_RPC_LIMIT" }));
					return;
				}
				if (resultReady) {
					// Calls created after the top-level workflow returned are detached
					// continuations, not part of the approved graph. Reject them without
					// ever dispatching a new adapter operation.
					send({ type: "response", id: message.id, ok: false, error: {
						name: "Error",
						code: "WORKFLOW_DETACHED_CALL",
						message: "workflow runtime calls cannot start after the top-level workflow returns",
					} });
					return;
				}
					if (["phase", "log"].includes(message.operation)) {
						workflowEventCount += 1;
						if (workflowEventCount > WORKFLOW_LIMITS.maxProjectedEvents) throw new Error("workflow emitted too many progress events");
						const field = message.operation === "phase" ? "title" : "message";
						const value = boundedWorkflowText(message.payload?.[field]);
						workflowEventBytes += Buffer.byteLength(value, "utf8");
						if (workflowEventBytes > WORKFLOW_LIMITS.maxTraceBytes) throw new Error("workflow progress events exceed the retained text bound");
						this.onEvent({ type: message.operation, [field]: value });
					return;
				}
				if (this.pendingRequests.has(message.id)) throw new Error("duplicate workflow sandbox request");
				if (this.pendingRequests.size >= this.pendingRequestLimit) {
					terminate(Object.assign(new Error("workflow sandbox exceeded its pending RPC request limit"), { code: "WORKFLOW_RPC_LIMIT" }));
					return;
				}
				if (quiescenceTimer) { clearTimeout(quiescenceTimer); quiescenceTimer = undefined; }
				this.pendingRequests.add(message.id);
				Promise.resolve(this.onRequest(message.operation, message.payload)).then(
					(value) => sendOperationResponse(message.id, true, value),
					(error) => sendOperationResponse(message.id, false, error),
				).finally(() => { this.pendingRequests.delete(message.id); maybeFinish(); });
			};
			child.stdout.on("data", (chunk) => {
				try {
					output += decoder.write(chunk);
					if (Buffer.byteLength(output, "utf8") > WORKFLOW_LIMITS.maxRpcBytes) throw new Error("workflow sandbox output frame is too large");
					let newline;
					while ((newline = output.indexOf("\n")) >= 0) {
						const line = output.slice(0, newline);
						output = output.slice(newline + 1);
						if (line) receive(JSON.parse(line));
					}
				} catch (error) { terminate(error); }
			});
			child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
			child.stdin.on("error", (error) => {
				if (!settled && error?.code !== "ERR_STREAM_WRITE_AFTER_END") terminate(error);
			});
			child.once("error", finish);
			child.once("exit", (code, exitSignal) => {
				if (settled) return;
				if (terminationError) finish(terminationError);
				else if (completingSuccess) finish(undefined, resultValue);
				else finish(new Error(`Workflow sandbox exited before producing a result (${exitSignal ?? code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
			});
			const onAbort = () => terminate(signal.reason instanceof Error ? signal.reason : new Error("Workflow stopped"));
			signal?.addEventListener("abort", onAbort, { once: true });
			const wallTimer = setTimeout(() => terminate(Object.assign(new Error("Workflow script timed out"), { code: "WORKFLOW_TIMEOUT" })), this.timeoutMs);
			wallTimer.unref?.();
			const heartbeatTimer = setInterval(() => {
				if (Date.now() - lastHeartbeat > this.heartbeatTimeoutMs) {
					terminate(Object.assign(new Error("Workflow sandbox stopped responding"), { code: "WORKFLOW_HEARTBEAT_TIMEOUT" }));
				}
			}, Math.max(500, Math.floor(this.heartbeatTimeoutMs / 2)));
			heartbeatTimer.unref?.();
			send({ type: "init", source: transformed, args: this.args, tokenBudget: this.tokenBudget, syncTimeoutMs: 1000 });
		});
	}

	stop() {
		if (this.finished || !this.child) return;
		try { this.child.stdin.write('{"type":"cancel"}\n'); } catch { /* closed */ }
		if (this.terminate) this.terminate(Object.assign(new Error("Workflow sandbox stopped"), { code: "WORKFLOW_STOPPED" }));
		else killProcessTree(this.child, "SIGTERM");
	}
}

export function workflowSandboxBootstrapPath() {
	return fs.realpathSync(CHILD_FILE);
}
