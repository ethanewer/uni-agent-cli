import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { CodexAdapter } from "../src/harness/adapters/codex.mjs";
import { resolveCodexInvocation, runCodexAppServerRequests } from "../src/pi-harness.mjs";

const packageBin = path.resolve("node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
const baseInvocation = fs.existsSync(packageBin)
	? resolveCodexInvocation({ env: { CODEX_PATH: packageBin } })
	: undefined;

if (!baseInvocation) {
	console.log("Codex rollback E2E skipped: the optional native Codex CLI is unavailable on this platform");
	process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-rollback-e2e-"));
const codexHome = path.join(root, "codex-home");
fs.mkdirSync(codexHome);
const providerRequests = [];
const answers = [
	"earlier answer retained",
	"selected answer must disappear",
	"follow-up answer",
];
const provider = http.createServer(async (request, response) => {
	let body = "";
	for await (const chunk of request) body += String(chunk);
	providerRequests.push(JSON.parse(body));
	const index = providerRequests.length - 1;
	const answer = answers[index] ?? `answer ${index}`;
	const responseId = `resp_cc_${index}`;
	const itemId = `msg_cc_${index}`;
	const createdAt = Math.floor(Date.now() / 1_000);
	const item = {
		id: itemId,
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: answer, annotations: [], logprobs: [] }],
	};
	const base = {
		id: responseId,
		object: "response",
		created_at: createdAt,
		status: "in_progress",
		background: false,
		error: null,
		incomplete_details: null,
		instructions: null,
		max_output_tokens: null,
		model: "cc-rollback-model",
		output: [],
		parallel_tool_calls: true,
		previous_response_id: null,
		reasoning: { effort: null, summary: null },
		store: false,
		temperature: null,
		text: { format: { type: "text" } },
		tool_choice: "auto",
		tools: [],
		top_p: null,
		truncation: "disabled",
		usage: null,
		user: null,
		metadata: {},
	};
	const completed = {
		...base,
		status: "completed",
		output: [item],
		usage: {
			input_tokens: 1,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 2,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 3,
		},
	};
	const events = [
		{ type: "response.created", sequence_number: 0, response: base },
		{ type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { ...item, status: "in_progress", content: [] } },
		{ type: "response.content_part.added", sequence_number: 2, item_id: itemId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [], logprobs: [] } },
		{ type: "response.output_text.delta", sequence_number: 3, item_id: itemId, output_index: 0, content_index: 0, delta: answer, logprobs: [] },
		{ type: "response.output_text.done", sequence_number: 4, item_id: itemId, output_index: 0, content_index: 0, text: answer, logprobs: [] },
		{ type: "response.content_part.done", sequence_number: 5, item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] },
		{ type: "response.output_item.done", sequence_number: 6, output_index: 0, item },
		{ type: "response.completed", sequence_number: 7, response: completed },
	];
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`);
});

async function main() {
	let seedServer;
	let inspectServer;
	let adapter;
	try {
	await new Promise((resolve, reject) => {
		provider.once("error", reject);
		provider.listen(0, "127.0.0.1", resolve);
	});
	const address = provider.address();
	assert.equal(typeof address, "object");
	const providerConfig = `model_providers.cc_rollback={ name="cc-rollback", base_url="http://127.0.0.1:${address.port}/v1", env_key="CC_ROLLBACK_API_KEY", wire_api="responses" }`;
	const invocation = {
		command: baseInvocation.command,
		args: [
			...(baseInvocation.args ?? []),
			"-c", "model_provider=\"cc_rollback\"",
			"-c", "model=\"cc-rollback-model\"",
			"-c", providerConfig,
		],
	};
	const environment = { CODEX_HOME: codexHome, CC_ROLLBACK_API_KEY: "local-test-key" };

	seedServer = await LiveCodexAppServer.start(invocation, environment);
	const started = await seedServer.request("thread/start", {
		model: "cc-rollback-model",
		modelProvider: "cc_rollback",
		cwd: root,
		approvalPolicy: "never",
		sandbox: "read-only",
		ephemeral: false,
	});
	const sourceSessionId = started.thread.id;
	const earlierTurnId = await seedServer.completeTurn(sourceSessionId, "earlier prompt retained");
	const selectedTurnId = await seedServer.completeTurn(sourceSessionId, "selected prompt retained without response");
	await seedServer.close();
	seedServer = undefined;

	const replayed = [];
	const connection = {
		agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.1.4" },
		sessionId: sourceSessionId,
		async initialize() {},
		getSessionInfo() { return { capabilities: { loadSession: true } }; },
		async loadSession(sessionId, options = {}) {
			// A zero-turn fork is discoverable by another Codex process only while
			// the forking app-server still owns it. This mirrors codex-acp's live
			// session/load and proves the production pre-teardown handoff boundary.
			inspectServer = await LiveCodexAppServer.start(invocation, environment);
			const loaded = await inspectServer.request("thread/resume", { threadId: sessionId });
			assert.deepEqual(loaded.thread.turns.map((turn) => turn.id), [earlierTurnId]);
			this.sessionId = sessionId;
			await options.beforeReplay?.({ sessionId });
		},
		stop() {},
	};
	adapter = new CodexAdapter("codex", {}, { onEvent: (event) => replayed.push(event) }, {
		launchSpec: { env: environment },
		connectionFactory: () => connection,
		services: { codex: {
			acquireForkOperationLock: async () => () => {},
			resolveCodexInvocation: () => invocation,
			// Give the temporary source owner no natural-exit grace after the ACP
			// handoff. The helper must terminate it while the independently resumed
			// backend keeps the injected prompt and remains able to start a real turn.
			runCodexAppServerRequests: (requestInvocation, requests, agent, options = {}) =>
				runCodexAppServerRequests(requestInvocation, requests, agent, {
					...options,
					terminationGraceMs: options.beforeTeardown ? 0 : options.terminationGraceMs,
				}),
			recordForkId: () => {},
			forgetForkIds: () => {},
		} },
	});
	await adapter.connect({ cwd: root, createSession: false });
	const result = await adapter.rewindCheckpoint(selectedTurnId, "conversation");
	assert.notEqual(result.sessionId, sourceSessionId);
	assert.equal(connection.sessionId, result.sessionId);
	assert.deepEqual(replayed, [{ type: "user_text", text: "selected prompt retained without response" }]);

	const child = await inspectServer.request("thread/read", { threadId: result.sessionId, includeTurns: true });
	assert.deepEqual(child.thread.turns.map((turn) => turn.id), [earlierTurnId]);
	assert.equal(JSON.stringify(child.thread.turns).includes("earlier answer retained"), true);
	assert.equal(JSON.stringify(child.thread.turns).includes("selected answer must disappear"), false);
	await inspectServer.completeTurn(result.sessionId, "follow-up prompt");

	const followUpRequest = providerRequests[2];
	assert.ok(followUpRequest, "the child starts a real follow-up model turn");
	const modelHistory = JSON.stringify(followUpRequest.input);
	assert.match(modelHistory, /earlier prompt retained/u);
	assert.match(modelHistory, /earlier answer retained/u);
	assert.match(modelHistory, /selected prompt retained without response/u);
	assert.doesNotMatch(modelHistory, /selected answer must disappear/u);
	assert.match(modelHistory, /follow-up prompt/u);

		console.log("Codex rollback E2E: selected response removed while its prompt remains in live model history passed");
	} finally {
		await adapter?.stopAndWait().catch(() => {});
		await seedServer?.close().catch(() => {});
		await inspectServer?.close().catch(() => {});
		await new Promise((resolve) => provider.close(() => resolve()));
		fs.rmSync(root, { recursive: true, force: true });
	}
}

class LiveCodexAppServer {
	static async start(invocation, environment) {
		const instance = new LiveCodexAppServer(invocation, environment);
		await instance.initialize();
		return instance;
	}

	constructor(invocation, environment) {
		this.child = spawn(invocation.command, [...(invocation.args ?? []), "app-server", "--stdio"], {
			cwd: root,
			env: { ...process.env, ...environment },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.nextId = 0;
		this.pending = new Map();
		this.completed = [];
		this.completionWaiters = [];
		this.stderr = "";
		this.lines = readline.createInterface({ input: this.child.stdout });
		this.lines.on("line", (line) => this.handleLine(line));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = `${this.stderr}${String(chunk)}`.slice(-16_384);
		});
	}

	async initialize() {
		await this.request("initialize", {
			clientInfo: { name: "cc-rollback-e2e", title: "cc rollback e2e", version: "0.1.0" },
			capabilities: { experimentalApi: true },
		});
		this.child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
	}

	request(method, params) {
		return new Promise((resolve, reject) => {
			const id = ++this.nextId;
			this.pending.set(id, { resolve, reject, method });
			this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
		});
	}

	async completeTurn(threadId, text) {
		const started = await this.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
			approvalPolicy: "never",
			sandboxPolicy: { type: "readOnly" },
		});
		await this.waitForTurn(threadId, started.turn.id);
		return started.turn.id;
	}

	waitForTurn(threadId, turnId) {
		const index = this.completed.findIndex((entry) => entry?.threadId === threadId && entry?.turn?.id === turnId);
		if (index >= 0) {
			this.completed.splice(index, 1);
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.completionWaiters = this.completionWaiters.filter((entry) => entry.resolve !== resolve);
				reject(new Error(`Codex turn did not complete: ${this.stderr}`));
			}, 10_000);
			this.completionWaiters.push({ threadId, turnId, resolve, timer });
		});
	}

	handleLine(line) {
		const message = JSON.parse(line);
		if (message.method === "turn/completed") {
			const index = this.completionWaiters.findIndex((entry) =>
				entry.threadId === message.params?.threadId && entry.turnId === message.params?.turn?.id);
			if (index >= 0) {
				const [waiter] = this.completionWaiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve();
			} else {
				this.completed.push(message.params);
			}
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
		else pending.resolve(message.result ?? {});
	}

	async close() {
		if (!this.child) return;
		const child = this.child;
		this.child = undefined;
		const closed = new Promise((resolve) => child.once("close", resolve));
		child.stdin.end();
		const timer = setTimeout(() => child.kill("SIGTERM"), 1_000);
		await Promise.race([
			closed,
			new Promise((_, reject) => setTimeout(() => reject(new Error("Codex app-server did not close")), 5_000)),
		]);
		clearTimeout(timer);
		this.lines.close();
	}
}

await main();
