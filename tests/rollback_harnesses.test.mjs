import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CodexAdapter } from "../src/harness/adapters/codex.mjs";
import { OpenCodeAdapter } from "../src/harness/adapters/opencode.mjs";
import { PiAdapter } from "../src/harness/adapters/pi.mjs";
import {
	codexCheckpointForkParams,
	codexCheckpointReadParams,
	codexCheckpointsFromThreadRead,
} from "../src/harness/codex-checkpoints.mjs";
import {
	openCodeCliInvocation,
	openCodeCheckpointsFromMessages,
	openCodeForkBoundary,
	openCodeForkCheckpointId,
	openCodeRewindStats,
	openCodeServerInvocation,
	withOpenCodeClient,
} from "../src/harness/opencode-checkpoints.mjs";
import {
	createPiCheckpointBranch,
	openPiSession,
	piAcpSessionMapPath,
	piCheckpointsFromSessionManager,
	registerPiAcpSession,
	unregisterPiAcpSession,
} from "../src/harness/pi-checkpoints.mjs";

const codexSource = "018f0000-0000-7000-8000-000000000001";
const codexTurn = "018f0000-0000-7000-8000-000000000002";
const codexChild = "018f0000-0000-7000-8000-000000000003";
const codexRead = {
	thread: {
		id: codexSource,
		turns: [
			{
				id: codexTurn,
				status: "completed",
				items: [{ type: "userMessage", content: [{ type: "text", text: "Implement rollback" }] }],
			},
			{
				id: "018f0000-0000-7000-8000-000000000004",
				status: "inProgress",
				items: [{ type: "userMessage", content: [{ type: "text", text: "still running" }] }],
			},
		],
	},
};
assert.deepEqual(codexCheckpointReadParams(codexSource), { threadId: codexSource, includeTurns: true });
assert.deepEqual(codexCheckpointForkParams(codexSource, codexTurn), {
	threadId: codexSource,
	ephemeral: false,
	lastTurnId: codexTurn,
});
assert.deepEqual(codexCheckpointsFromThreadRead(codexRead), {
	checkpoints: [{ id: codexTurn, summary: "Implement rollback" }],
});

function fakeConnection({ name, sessionId, failLoad = false, clearSessionOnLoadFailure = false, version = undefined }) {
	const versions = {
		"@agentclientprotocol/codex-acp": "1.1.4",
		OpenCode: "1.18.3",
		"pi-acp": "0.0.31",
	};
	return {
		agentInfo: { name, version: version ?? versions[name] ?? "test" },
		sessionId,
		async initialize() {},
		getSessionInfo() {
			return {
				capabilities: {
					loadSession: true,
					sessionCapabilities: { resume: {}, list: {}, fork: name === "OpenCode" ? {} : undefined },
				},
			};
		},
		async loadSession(next, options = {}) {
			if (failLoad) {
				if (clearSessionOnLoadFailure) this.sessionId = undefined;
				throw new Error("load failed");
			}
			this.sessionId = next;
			await options.beforeReplay?.({ sessionId: next });
		},
		stop() {},
	};
}

async function runFakeCodexTransaction(requests, onRequest, options = {}) {
	const results = [];
	for (const requestSpec of requests) {
		const request = typeof requestSpec === "function" ? requestSpec([...results]) : requestSpec;
		results.push(await onRequest(request));
	}
	await options.beforeTeardown?.([...results]);
	return results;
}

// Compatible newer adapters retain rollback, and maintained Codex backends
// retain prompt retraction independently of the checkpoint-version floor.
{
	const newerCodex = new CodexAdapter("codex", CodexAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => fakeConnection({
			name: "@agentclientprotocol/codex-acp",
			sessionId: codexSource,
			version: "1.1.5",
		}),
	});
	await newerCodex.connect({ createSession: false });
	assert.equal(newerCodex.capabilities.retractPrompt, true);
	assert.deepEqual(newerCodex.capabilities.checkpointModes, ["conversation"]);
	await newerCodex.stopAndWait();

	const olderOpenCode = new OpenCodeAdapter("opencode", OpenCodeAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => fakeConnection({ name: "OpenCode", sessionId: "ses-old", version: "1.18.2" }),
	});
	await olderOpenCode.connect({ createSession: false });
	assert.equal(olderOpenCode.capabilities.resume, true, "older OpenCode remains usable for chat and sessions");
	assert.equal(olderOpenCode.capabilities.checkpoints, false, "rollback stays gated on its compatible API floor");
	await olderOpenCode.stopAndWait();
}

// Codex: list only completed user turns, fork through the selected turn, remove
// its response, inject only its prompt, then atomically load the persistent child.
// Code rollback is rejected before any RPC.
{
	const connection = fakeConnection({ name: "@agentclientprotocol/codex-acp", sessionId: codexSource });
	const appServerCalls = [];
	const recorded = [];
	const replayed = [];
	const adapter = new CodexAdapter("codex", CodexAdapter.defaultAgentConfig, {
		onEvent: (event) => replayed.push(event),
	}, {
		connectionFactory: () => connection,
		services: {
			codex: {
				acquireForkOperationLock: async () => () => {},
				resolveCodexInvocation: () => ({ command: "codex-test", args: [] }),
				runCodexAppServerRequests: async (_invocation, requests, _agent, options) => await runFakeCodexTransaction(requests, async (request) => {
					appServerCalls.push(request);
					if (request.method === "thread/read") return codexRead;
					if (request.method === "thread/fork") return {
						thread: { id: codexChild, ephemeral: false, forkedFromId: codexSource, turns: [] },
					};
					if (request.method === "thread/rollback") return { thread: { id: codexChild, turns: [] } };
					if (request.method === "thread/inject_items") return {};
					throw new Error(`unexpected method ${request.method}`);
				}, options),
				recordForkId: (...args) => recorded.push(args),
				forgetForkIds: () => {},
			},
		},
	});
	await adapter.connect({ createSession: false });
	assert.deepEqual(adapter.capabilities.checkpointModes, ["conversation"]);
	assert.deepEqual(await adapter.listCheckpoints(), { checkpoints: [{ id: codexTurn, summary: "Implement rollback" }] });
	assert.equal((await adapter.rewindCheckpoint(codexTurn, "conversation")).sessionId, codexChild);
	assert.equal(connection.sessionId, codexChild);
	assert.equal(appServerCalls.find((call) => call.method === "thread/fork").params.lastTurnId, codexTurn);
	assert.deepEqual(appServerCalls.find((call) => call.method === "thread/rollback").params, {
		threadId: codexChild,
		numTurns: 1,
	});
	assert.deepEqual(appServerCalls.find((call) => call.method === "thread/inject_items").params.items, [{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "Implement rollback" }],
	}]);
	assert.deepEqual(replayed, [{ type: "user_text", text: "Implement rollback" }]);
	assert.equal(recorded.length, 1);
	await assert.rejects(() => adapter.rewindCheckpoint(codexTurn, "code"), /does not support code/u);
	await adapter.stopAndWait();
}

// A backend crash during session/load still releases the child lease and
// removes the persistent fork and registry entry.
{
	const connection = fakeConnection({
		name: "@agentclientprotocol/codex-acp",
		sessionId: codexSource,
		failLoad: true,
		clearSessionOnLoadFailure: true,
	});
	const methods = [];
	const forgotten = [];
	let releasedLeases = 0;
	const adapter = new CodexAdapter("codex", CodexAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => connection,
		services: { codex: {
			acquireForkOperationLock: async () => () => {},
			acquireLiveSessionLease: () => () => { releasedLeases += 1; },
			resolveCodexInvocation: () => ({ command: "codex-test", args: [] }),
			runCodexAppServerRequests: async (_invocation, requests, _agent, options) => await runFakeCodexTransaction(requests, async (request) => {
				const method = request.method;
				methods.push(method);
				if (method === "thread/read") return codexRead;
				if (method === "thread/fork") return { thread: { id: codexChild, ephemeral: false, forkedFromId: codexSource } };
				if (method === "thread/rollback") return { thread: { id: codexChild, turns: [] } };
				if (method === "thread/inject_items") return {};
				if (method === "thread/delete") throw new Error("already absent");
				throw new Error(`unexpected method ${method}`);
			}, options),
			recordForkId: () => {},
			forgetForkIds: (...args) => forgotten.push(args),
		} },
	});
	await adapter.connect({ createSession: false });
	await assert.rejects(() => adapter.rewindCheckpoint(codexTurn, "conversation"), /load failed/u);
	assert.deepEqual(methods, ["thread/read", "thread/fork", "thread/rollback", "thread/inject_items", "thread/delete"]);
	assert.equal(forgotten[0][0], codexChild);
	assert.equal(adapter.liveSessionLeases.has(codexChild), false);
	assert.equal(adapter.liveSessionLeases.has(codexSource), true);
	assert.equal(releasedLeases, 1);
	await adapter.stopAndWait();
}

// A failed Codex session/load removes the persistent child and its fork index
// record, while leaving the source session active.
{
	const connection = fakeConnection({
		name: "@agentclientprotocol/codex-acp",
		sessionId: codexSource,
		failLoad: true,
	});
	const methods = [];
	const forgotten = [];
	const adapter = new CodexAdapter("codex", CodexAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => connection,
		services: {
			codex: {
				acquireForkOperationLock: async () => () => {},
				resolveCodexInvocation: () => ({ command: "codex-test", args: [] }),
				runCodexAppServerRequests: async (_invocation, requests, _agent, options) => await runFakeCodexTransaction(requests, async (request) => {
					const method = request.method;
					methods.push(method);
					if (method === "thread/read") return codexRead;
					if (method === "thread/fork") return { thread: { id: codexChild, ephemeral: false, forkedFromId: codexSource } };
					if (method === "thread/rollback") return { thread: { id: codexChild, turns: [] } };
					if (method === "thread/inject_items") return {};
					if (method === "thread/delete") return {};
					throw new Error(`unexpected method ${method}`);
				}, options),
				recordForkId: () => {},
				forgetForkIds: (...args) => forgotten.push(args),
			},
		},
	});
	await adapter.connect({ createSession: false });
	await assert.rejects(() => adapter.rewindCheckpoint(codexTurn, "conversation"), /load failed/u);
	assert.deepEqual(methods, ["thread/read", "thread/fork", "thread/rollback", "thread/inject_items", "thread/delete"]);
	assert.equal(forgotten[0][0], codexChild);
	assert.equal(connection.sessionId, codexSource);
	await adapter.stopAndWait();
}

const openCodeMessages = [
	{
		info: { id: "msg-user", role: "user" },
		parts: [
			{ type: "text", text: "First request", synthetic: false },
			{ type: "text", text: "hidden", synthetic: true },
		],
	},
	{ info: { id: "msg-assistant", role: "assistant", parentID: "msg-user" }, parts: [] },
];
const openCodeFileMessages = [
	{
		info: { id: "msg-file-user", role: "user" },
		parts: [{ type: "text", text: "First request", synthetic: false }],
	},
	{ info: { id: "msg-file-assistant", role: "assistant", parentID: "msg-file-user" }, parts: [] },
];
assert.deepEqual(openCodeCheckpointsFromMessages(openCodeMessages), {
	checkpoints: [{ id: "msg-user", summary: "First request" }],
});
assert.equal(openCodeForkBoundary(openCodeMessages, "msg-user"), "msg-assistant");
assert.equal(openCodeForkBoundary(openCodeMessages.slice(0, 1), "msg-user"), undefined);
assert.equal(openCodeForkCheckpointId(openCodeMessages, openCodeFileMessages, "msg-user"), "msg-file-user");
assert.deepEqual(openCodeRewindStats({ summary: { diffs: [
	{ file: "a.js", additions: 2, deletions: 1 },
	{ file: "b.js", additions: 3, deletions: 4 },
] } }), { filesChanged: ["a.js", "b.js"], insertions: 5, deletions: 5 });
assert.deepEqual(openCodeRewindStats({}), {}, "missing revert stats must not be rendered as hard zeroes");
assert.deepEqual(openCodeCliInvocation({
	cliCommand: "/opt/global/bin/node",
	cliPrefixArgs: ["/opt/global/lib/opencode.js"],
}), {
	command: "/opt/global/bin/node",
	prefixArgs: ["/opt/global/lib/opencode.js"],
});
assert.deepEqual(openCodeServerInvocation({
	executable: "/usr/bin/npx",
	prefixArgs: [],
	commandArgs: ["-y", "opencode", "acp"],
}), {
	command: "/usr/bin/npx",
	prefixArgs: ["-y", "opencode"],
});
assert.equal(openCodeServerInvocation({
	executable: "/opt/custom/opencode-acp-wrapper",
	prefixArgs: [],
	commandArgs: [],
}), undefined, "an opaque ACP-only wrapper must not advertise rollback");

// A PATH-resolved OpenCode executable can disappear between ACP startup and a
// rollback request. Spawn emits error/close but no exit; teardown must reject
// promptly instead of hanging the operation or NativeProcessTracker shutdown.
{
	const missing = path.join(os.tmpdir(), `cc-missing-opencode-${process.pid}-${Date.now()}`);
	const startedAt = Date.now();
	await assert.rejects(
		() => withOpenCodeClient(process.cwd(), async () => assert.fail("a missing server cannot run an operation"), {
			cliCommand: missing,
		}),
		/ENOENT|spawn/u,
	);
	assert.ok(Date.now() - startedAt < 2_000, "spawn failure teardown returns without waiting for a nonexistent exit event");
}

function openCodeClient(calls) {
	let fullForks = 0;
	return {
		session: {
			messages: async (params) => {
				calls.push(["messages", params]);
				return { data: params.sessionID === "ses-files" ? openCodeFileMessages : openCodeMessages };
			},
			fork: async (params) => {
				calls.push(["fork", params]);
				if (params.messageID) return { data: { id: "ses-child" } };
				fullForks += 1;
				return { data: { id: fullForks === 1 ? "ses-files" : `ses-files-${fullForks}` } };
			},
			revert: async (params) => {
				calls.push(["revert", params]);
				return { data: { summary: { diffs: [{ file: "src/a.js", additions: 1, deletions: 2 }] } } };
			},
			unrevert: async (params) => { calls.push(["unrevert", params]); return { data: {} }; },
			delete: async (params) => { calls.push(["delete", params]); return { data: true }; },
		},
	};
}

// Once a code-only revert succeeds, failure to delete its disposable session
// cannot compensate (undo) the requested workspace change.
{
	const calls = [];
	const connection = fakeConnection({ name: "OpenCode", sessionId: "ses-source" });
	const client = openCodeClient(calls);
	client.session.delete = async (params) => {
		calls.push(["delete", params]);
		throw new Error("cleanup failed");
	};
	const adapter = new OpenCodeAdapter("opencode", OpenCodeAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => connection,
		services: { openCode: { withClient: async (_directory, operation) => await operation(client) } },
	});
	await adapter.connect({ cwd: process.cwd(), createSession: false });
	assert.deepEqual(await adapter.rewindCheckpoint("msg-user", "code"), {
		ok: true,
		mode: "code",
		filesChanged: ["src/a.js"],
		insertions: 1,
		deletions: 2,
	});
	assert.equal(calls.some(([name]) => name === "unrevert"), false);
	assert.equal(connection.sessionId, "ses-source");
	await adapter.stopAndWait();
}

// OpenCode: both-mode forks after retaining the selected prompt, restores files, and
// loads the child. A failed load compensates the file revert and deletes the child.
{
	const calls = [];
	const connection = fakeConnection({ name: "OpenCode", sessionId: "ses-source" });
	connection.launchInvocation = { executable: "/opt/global/bin/opencode", prefixArgs: [], commandArgs: ["acp"] };
	const clientOptions = [];
	const adapter = new OpenCodeAdapter("opencode", OpenCodeAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => connection,
		services: { openCode: { withClient: async (_directory, operation, options) => {
			clientOptions.push(options);
			return await operation(openCodeClient(calls));
		} } },
	});
	await adapter.connect({ cwd: process.cwd(), createSession: false });
	assert.deepEqual(adapter.capabilities.checkpointModes, ["both", "conversation", "code"]);
	assert.deepEqual(await adapter.listCheckpoints(), { checkpoints: [{ id: "msg-user", summary: "First request" }] });
	assert.equal(clientOptions[0].cliCommand, "/opt/global/bin/opencode", "rollback reuses the active PATH-resolved executable");
	assert.deepEqual(await adapter.rewindCheckpoint("msg-user", "both"), {
		ok: true,
		mode: "both",
		sessionId: "ses-child",
		filesChanged: ["src/a.js"],
		insertions: 1,
		deletions: 2,
	});
	assert.equal(connection.sessionId, "ses-child");
	assert.ok(calls.some(([name]) => name === "fork"));
	assert.equal(calls.find(([name]) => name === "fork")[1].messageID, "msg-assistant");
	const revertCall = calls.find(([name]) => name === "revert");
	assert.equal(revertCall[1].sessionID, "ses-files", "the source conversation never owns the file revert marker");
	assert.equal(revertCall[1].messageID, "msg-file-user");
	assert.ok(calls.some(([name, params]) => name === "delete" && params.sessionID === "ses-files"));
	await adapter.stopAndWait();
}

{
	const calls = [];
	const connection = fakeConnection({ name: "OpenCode", sessionId: "ses-source", failLoad: true });
	const adapter = new OpenCodeAdapter("opencode", OpenCodeAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => connection,
		services: { openCode: { withClient: async (_directory, operation) => await operation(openCodeClient(calls)) } },
	});
	await adapter.connect({ cwd: process.cwd(), createSession: false });
	await assert.rejects(() => adapter.rewindCheckpoint("msg-user", "both"), /load failed/u);
	assert.deepEqual(calls.slice(-3).map(([name]) => name), ["unrevert", "delete", "delete"]);
	assert.equal(calls.findLast(([name]) => name === "unrevert")[1].sessionID, "ses-files");
	assert.equal(connection.sessionId, "ses-source");
	await adapter.stopAndWait();
}

// Pi: its public session tree is copied through the selected user entry into a
// distinct persisted session. Even a user-only branch is materialized so ACP can load it.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pi-rollback-test-"));
	try {
		const source = SessionManager.create(root, path.join(root, "sessions"));
		const checkpointId = source.appendMessage({ role: "user", content: "Pi request", timestamp: Date.now() });
		source.appendMessage({ role: "assistant", content: [{ type: "text", text: "Pi response" }], timestamp: Date.now() });
		const sourceSessionId = source.getSessionId();
		const sourceFile = source.getSessionFile();
		assert.equal((await openPiSession(sourceSessionId, {
			cwd: root,
			env: { PI_CODING_AGENT_SESSION_DIR: path.dirname(sourceFile) },
		})).path, sourceFile, "Pi lookup honors the explicit session directory");
		const customAgentDir = path.join(root, "agent");
		fs.mkdirSync(customAgentDir);
		fs.writeFileSync(path.join(customAgentDir, "settings.json"), JSON.stringify({ sessionDir: path.dirname(sourceFile) }));
		assert.equal((await openPiSession(sourceSessionId, {
			cwd: root,
			env: { PI_CODING_AGENT_DIR: customAgentDir },
		})).path, sourceFile, "Pi lookup honors settings.json sessionDir");
		const projectSettingsDir = path.join(root, ".pi");
		fs.mkdirSync(projectSettingsDir);
		fs.writeFileSync(
			path.join(projectSettingsDir, "settings.json"),
			JSON.stringify({ sessionDir: "sessions" }),
		);
		fs.writeFileSync(
			path.join(customAgentDir, "settings.json"),
			JSON.stringify({ sessionDir: path.join(root, "wrong-global-sessions") }),
		);
		assert.equal((await openPiSession(sourceSessionId, {
			cwd: root,
			env: { PI_CODING_AGENT_DIR: customAgentDir },
		})).path, sourceFile, "Pi lookup honors a relative project sessionDir override");
		const branch = createPiCheckpointBranch(source, checkpointId);
		assert.notEqual(branch.sessionId, sourceSessionId);
		assert.equal(fs.existsSync(branch.sessionFile), true);
		const reopened = SessionManager.open(branch.sessionFile);
		assert.deepEqual(piCheckpointsFromSessionManager(reopened), {
			checkpoints: [{ id: checkpointId, summary: "Pi request" }],
		});
		const piAcpHome = path.join(root, "home");
		const registration = registerPiAcpSession(branch, { env: { HOME: piAcpHome }, now: 0 });
		assert.equal(registration.mapPath, piAcpSessionMapPath({ env: { HOME: piAcpHome } }));
		const registeredMap = JSON.parse(fs.readFileSync(registration.mapPath, "utf8"));
		assert.deepEqual(registeredMap.sessions[branch.sessionId], {
			sessionId: branch.sessionId,
			cwd: root,
			sessionFile: branch.sessionFile,
			updatedAt: "1970-01-01T00:00:00.000Z",
		});
		assert.equal(unregisterPiAcpSession(registration), true);
		assert.equal(JSON.parse(fs.readFileSync(registration.mapPath, "utf8")).sessions[branch.sessionId], undefined);

		let injectedConcurrentWrite = false;
		const retriedRegistration = registerPiAcpSession(branch, {
			env: { HOME: piAcpHome },
			now: 1,
			_testBeforeMapCommit: ({ mapPath }) => {
				if (injectedConcurrentWrite) return;
				injectedConcurrentWrite = true;
				fs.writeFileSync(mapPath, `${JSON.stringify({
					version: 1,
					sessions: { concurrent: { sessionId: "concurrent", cwd: root, sessionFile: sourceFile, updatedAt: "now" } },
				}, null, 2)}\n`);
			},
		});
		const retriedMap = JSON.parse(fs.readFileSync(retriedRegistration.mapPath, "utf8"));
		assert.equal(retriedMap.sessions.concurrent.sessionId, "concurrent", "a racing pi-acp write survives retry");
		assert.equal(retriedMap.sessions[branch.sessionId].sessionFile, branch.sessionFile);
		retriedMap.sessions[branch.sessionId].updatedAt = "changed-by-pi-acp";
		fs.writeFileSync(retriedRegistration.mapPath, `${JSON.stringify(retriedMap, null, 2)}\n`);
		assert.equal(unregisterPiAcpSession(retriedRegistration), false, "cleanup never overwrites a newer same-session entry");

		const connection = fakeConnection({ name: "pi-acp", sessionId: sourceSessionId });
		const registrations = [];
		const adapter = new PiAdapter("pi", PiAdapter.defaultAgentConfig, {}, {
			connectionFactory: () => connection,
			services: { pi: {
				openSession: async () => ({ manager: SessionManager.open(sourceFile), path: sourceFile }),
				registerSession: async (created) => { registrations.push(created); return { created }; },
				unregisterSession: async () => { throw new Error("successful rollback must retain its registration"); },
			} },
		});
		await adapter.connect({ cwd: root, createSession: false });
		assert.deepEqual(adapter.capabilities.checkpointModes, ["conversation"]);
		assert.deepEqual(await adapter.listCheckpoints(), { checkpoints: [{ id: checkpointId, summary: "Pi request" }] });
		const result = await adapter.rewindCheckpoint(checkpointId, "conversation");
		assert.notEqual(result.sessionId, sourceSessionId);
		assert.equal(connection.sessionId, result.sessionId);
		assert.equal(registrations[0].sessionId, result.sessionId);
		await assert.rejects(() => adapter.rewindCheckpoint(checkpointId, "code"), /does not support code/u);
		await adapter.stopAndWait();

		const filesBeforeFailedLoad = new Set(fs.readdirSync(path.dirname(sourceFile)));
		const failingConnection = fakeConnection({ name: "pi-acp", sessionId: sourceSessionId, failLoad: true });
		let unregistered = 0;
		const failingAdapter = new PiAdapter("pi", PiAdapter.defaultAgentConfig, {}, {
			connectionFactory: () => failingConnection,
			services: { pi: {
				openSession: async () => ({ manager: SessionManager.open(sourceFile), path: sourceFile }),
				registerSession: async (created) => ({ created }),
				unregisterSession: async () => { unregistered += 1; },
			} },
		});
		await failingAdapter.connect({ cwd: root, createSession: false });
		await assert.rejects(() => failingAdapter.rewindCheckpoint(checkpointId, "conversation"), /load failed/u);
		assert.deepEqual(new Set(fs.readdirSync(path.dirname(sourceFile))), filesBeforeFailedLoad);
		assert.equal(failingConnection.sessionId, sourceSessionId);
		assert.equal(unregistered, 1);
		await failingAdapter.stopAndWait();
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

console.log("rollback harnesses: Codex, OpenCode, and Pi branch/revert safety verified");
