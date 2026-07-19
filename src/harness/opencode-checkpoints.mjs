import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import {
	CHECKPOINT_LIMIT,
	checkpointSummary,
	normalizeCheckpointListResponse,
} from "./checkpoints.mjs";

const require = createRequire(import.meta.url);
const START_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT = 16_384;

export function openCodeCheckpointsFromMessages(messages, options = {}) {
	const limit = Number.isInteger(options.limit)
		? Math.max(1, Math.min(CHECKPOINT_LIMIT, options.limit))
		: CHECKPOINT_LIMIT;
	const checkpoints = [];
	for (const message of Array.isArray(messages) ? messages : []) {
		if (message?.info?.role !== "user" || typeof message.info.id !== "string") continue;
		const text = (Array.isArray(message.parts) ? message.parts : [])
			.filter((part) => part?.type === "text" && part.synthetic !== true && part.ignored !== true && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
		checkpoints.push({ id: message.info.id, summary: checkpointSummary(text) || "User message" });
	}
	return normalizeCheckpointListResponse({ checkpoints: checkpoints.slice(-limit) });
}

export function requireOpenCodeCheckpoint(messages, checkpointId) {
	const id = String(checkpointId ?? "").trim();
	if (!openCodeCheckpointsFromMessages(messages).checkpoints.some((entry) => entry.id === id)) {
		throw new Error("checkpoint is not a user message in this OpenCode session");
	}
	return id;
}

// OpenCode's native fork boundary is exclusive. Forking at the message after
// the selected user prompt preserves that prompt while discarding its response
// and everything that followed it, matching the other harnesses' semantics.
export function openCodeForkBoundary(messages, checkpointId) {
	const id = requireOpenCodeCheckpoint(messages, checkpointId);
	const entries = Array.isArray(messages) ? messages : [];
	const index = entries.findIndex((message) => message?.info?.id === id);
	for (let cursor = index + 1; cursor < entries.length; cursor += 1) {
		const nextId = entries[cursor]?.info?.id;
		if (typeof nextId === "string" && nextId) return nextId;
	}
	return undefined;
}

// OpenCode assigns fresh message IDs when a session is forked. Match the
// selected user prompt by its ordinal position so a disposable full-history
// fork can own the session revert marker while its file changes affect the
// shared workspace.
export function openCodeForkCheckpointId(sourceMessages, forkMessages, checkpointId) {
	const sourceId = requireOpenCodeCheckpoint(sourceMessages, checkpointId);
	const sourceCheckpoints = openCodeCheckpointsFromMessages(sourceMessages).checkpoints;
	const forkCheckpoints = openCodeCheckpointsFromMessages(forkMessages).checkpoints;
	const index = sourceCheckpoints.findIndex((entry) => entry.id === sourceId);
	const fork = forkCheckpoints[index];
	if (!fork || fork.summary !== sourceCheckpoints[index]?.summary) {
		throw new Error("OpenCode checkpoint history changed while preparing file rollback");
	}
	return fork.id;
}

export function openCodeRewindStats(session) {
	const diffs = Array.isArray(session?.summary?.diffs) ? session.summary.diffs : undefined;
	if (!diffs || diffs.length === 0) return {};
	return {
		filesChanged: diffs.map((entry) => entry?.file).filter((file) => typeof file === "string" && file),
		insertions: diffs.reduce((sum, entry) => sum + safeCount(entry?.additions), 0),
		deletions: diffs.reduce((sum, entry) => sum + safeCount(entry?.deletions), 0),
	};
}

export function openCodeResponseData(result, operation) {
	if (result?.error) {
		const detail = result.error?.message ?? result.error?._tag ?? JSON.stringify(result.error);
		throw new Error(`OpenCode ${operation} failed: ${detail}`);
	}
	if (result && Object.hasOwn(result, "data")) return result.data;
	return result;
}

export async function withOpenCodeClient(directory, operation, options = {}) {
	options.processTracker?.assertOpen();
	const cli = openCodeCliInvocation(options);
	const port = await reservePort();
	const username = "cc-checkpoint";
	const password = randomBytes(24).toString("base64url");
	const child = spawn(cli.command, [...cli.prefixArgs, "serve", "--hostname=127.0.0.1", `--port=${port}`], {
		cwd: directory,
		env: {
			...(options.env ?? process.env),
			OPENCODE_SERVER_USERNAME: username,
			OPENCODE_SERVER_PASSWORD: password,
		},
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	let unregister = () => {};
	try {
		unregister = options.processTracker?.register(() => stopChild(child)) ?? unregister;
		await waitForServer(child, port, (chunk) => { output = appendBounded(output, chunk); });
		const authorization = Buffer.from(`${username}:${password}`).toString("base64");
		const client = createOpencodeClient({
			baseUrl: `http://127.0.0.1:${port}`,
			directory,
			headers: { Authorization: `Basic ${authorization}` },
		});
		return await operation(client);
	} catch (error) {
		if (output.trim() && !String(error?.message ?? error).includes(output.trim())) {
			error.message = `${error.message}\n${output.trim()}`;
		}
		throw error;
	} finally {
		try {
			await stopChild(child);
		} finally {
			unregister();
		}
	}
}

export function openCodeCliInvocation(options = {}) {
	if (typeof options.cliCommand === "string" && options.cliCommand) {
		const prefixArgs = Array.isArray(options.cliPrefixArgs) && options.cliPrefixArgs.every((arg) => typeof arg === "string")
			? [...options.cliPrefixArgs]
			: [];
		return { command: options.cliCommand, prefixArgs };
	}
	if (typeof options.cliPath === "string" && options.cliPath) {
		return { command: options.cliPath, prefixArgs: [] };
	}
	const packageJson = require.resolve("opencode-ai/package.json");
	const metadata = require(packageJson);
	const relative = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.opencode;
	if (typeof relative !== "string" || !relative) throw new Error("the bundled OpenCode CLI has no executable");
	return { command: path.resolve(path.dirname(packageJson), relative), prefixArgs: [] };
}

// Convert the exact shell-free ACP launch into the sibling server launch used
// by rollback. Only a terminal `acp` mode is replaceable without guessing about
// wrapper semantics; all preceding resolver and configured arguments survive.
export function openCodeServerInvocation(invocation) {
	if (typeof invocation?.executable !== "string" || !invocation.executable) return undefined;
	if (!Array.isArray(invocation.prefixArgs) || !invocation.prefixArgs.every((arg) => typeof arg === "string")) return undefined;
	if (!Array.isArray(invocation.commandArgs) || !invocation.commandArgs.every((arg) => typeof arg === "string")) return undefined;
	const prefixArgs = [...invocation.prefixArgs, ...invocation.commandArgs];
	if (prefixArgs.at(-1) !== "acp") return undefined;
	prefixArgs.pop();
	return { command: invocation.executable, prefixArgs };
}

async function reservePort() {
	const server = net.createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : undefined;
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	if (!Number.isInteger(port)) throw new Error("could not reserve an OpenCode server port");
	return port;
}

async function waitForServer(child, port, onOutput) {
	await new Promise((resolve, reject) => {
		let settled = false;
		let stdout = "";
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			error ? reject(error) : resolve();
		};
		const timer = setTimeout(() => finish(new Error(`OpenCode server did not start within ${START_TIMEOUT_MS}ms`)), START_TIMEOUT_MS);
		child.once("error", finish);
		child.once("exit", (code, signal) => finish(new Error(`OpenCode server exited before startup (${signal ?? code ?? "unknown"})`)));
		child.stderr?.on("data", (chunk) => onOutput(String(chunk)));
		child.stdout?.on("data", (chunk) => {
			const text = String(chunk);
			onOutput(text);
			stdout = appendBounded(stdout, text);
			if (stdout.includes(`http://127.0.0.1:${port}`)) finish();
		});
	});
}

async function stopChild(child) {
	if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
	const closed = new Promise((resolve) => {
		child.once("close", resolve);
		child.once("error", resolve);
	});
	child.kill("SIGTERM");
	const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
	try {
		await closed;
	} finally {
		clearTimeout(timer);
	}
}

function appendBounded(value, next) {
	const combined = `${value}${next}`;
	return combined.length > OUTPUT_LIMIT ? combined.slice(-OUTPUT_LIMIT) : combined;
}

function safeCount(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
