import assert from "node:assert/strict";

import {
	CHECKPOINT_FILE_CHANGE_LIMIT,
	CHECKPOINT_PATH_MAX_BYTES,
	checkpointsFromSessionMessages,
	formatCheckpointRewindResult,
	normalizeCheckpointListResponse,
	normalizeCheckpointRewindResponse,
	parseCheckpointListParams,
	parseCheckpointRewindParams,
	sessionMessageText,
} from "../src/harness/checkpoints.mjs";
import {
	performClaudeCheckpointRewind,
	prepareClaudeSessionRequest,
} from "../src/harness/claude-acp-bridge.mjs";
import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { ClaudeAdapter } from "../src/harness/adapters/claude.mjs";
import { capabilitiesFromWire, checkAdapterConformance } from "../src/harness/interface.mjs";
import { AcpClient, HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

assert.deepEqual(parseCheckpointListParams({ sessionId: "session", limit: 20 }), { sessionId: "session", limit: 20 });
assert.deepEqual(parseCheckpointRewindParams({ sessionId: "session", checkpointId: "message", mode: "both" }), {
	sessionId: "session",
	checkpointId: "message",
	mode: "both",
});
assert.throws(() => parseCheckpointRewindParams({ sessionId: "session", checkpointId: "message", mode: "erase" }), /mode/u);
assert.equal(sessionMessageText({ content: [{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }] }), "one\ntwo");

const messages = [
	{ type: "user", uuid: "u1", parent_tool_use_id: null, message: { content: "First request" } },
	{ type: "assistant", uuid: "a1", parent_tool_use_id: null, message: { content: "Answer" } },
	{ type: "user", uuid: "nested", parent_tool_use_id: "tool", message: { content: "Nested" } },
	{ type: "user", uuid: "u2", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Second\nrequest" }] } },
	{ type: "user", uuid: "image", parent_tool_use_id: null, message: { content: [{ type: "image", source: {} }] } },
	{ type: "user", uuid: "command", parent_tool_use_id: null, message: { content: "<command-name>/model</command-name>" } },
];
assert.deepEqual(checkpointsFromSessionMessages(messages), {
	checkpoints: [
		{ id: "u1", summary: "First request" },
		{ id: "u2", summary: "Second request" },
		{ id: "image", summary: "User message" },
	],
});
const manyMessages = Array.from({ length: 205 }, (_, index) => ({
	type: "user",
	uuid: `u-${index}`,
	parent_tool_use_id: null,
	message: { content: `Request ${index}` },
}));
assert.deepEqual(checkpointsFromSessionMessages(manyMessages, { limit: 2 }), {
	checkpoints: [
		{ id: "u-203", summary: "Request 203" },
		{ id: "u-204", summary: "Request 204" },
	],
});
assert.deepEqual(normalizeCheckpointListResponse({ checkpoints: [{ id: "u1", summary: "First" }] }), {
	checkpoints: [{ id: "u1", summary: "First" }],
});
assert.deepEqual(normalizeCheckpointRewindResponse({
	ok: true,
	mode: "both",
	sessionId: "fork",
	filesChanged: ["src/a.js"],
	insertions: 2,
	deletions: 3,
}), {
	ok: true,
	mode: "both",
	sessionId: "fork",
	filesChanged: ["src/a.js"],
	insertions: 2,
	deletions: 3,
});
assert.deepEqual(normalizeCheckpointRewindResponse({
	ok: true,
	mode: "code",
	filesChanged: ["safe.js", "x".repeat(CHECKPOINT_PATH_MAX_BYTES + 1), "bad\u0000path"],
}), {
	ok: true,
	mode: "code",
	filesChanged: ["safe.js"],
});
assert.equal(normalizeCheckpointRewindResponse({
	ok: true,
	mode: "code",
	filesChanged: Array.from({ length: CHECKPOINT_FILE_CHANGE_LIMIT + 1 }, (_, index) => `file-${index}`),
}).filesChanged.length, CHECKPOINT_FILE_CHANGE_LIMIT);
assert.throws(() => normalizeCheckpointRewindResponse({ ok: true, mode: "conversation" }), /sessionId/u);
assert.match(formatCheckpointRewindResult({
	ok: true,
	mode: "both",
	sessionId: "fork",
	filesChanged: ["src/a.js"],
	insertions: 2,
	deletions: 3,
}), /original session is still resumable[\s\S]*1 file[\s\S]*2 insertions · 3 deletions/u);

// The built-in bridge forces SDK file checkpointing without mutating the
// caller's meta, while retaining the background-task bridge's prepared values.
const originalRequest = {
	cwd: "/tmp",
	_meta: { keep: true, claudeCode: { options: { model: "sonnet", enableFileCheckpointing: false } } },
};
const preparedRequest = prepareClaudeSessionRequest({
	prepareSessionRequest(params) {
		return {
			params: {
				...params,
				_meta: { ...params._meta, claudeCode: { ...params._meta.claudeCode, emitRawSDKMessages: [] } },
			},
			forwardRawSdkMessages: false,
		};
	},
}, originalRequest);
assert.equal(originalRequest._meta.claudeCode.options.enableFileCheckpointing, false);
assert.equal(preparedRequest.params._meta.keep, true);
assert.equal(preparedRequest.params._meta.claudeCode.options.model, "sonnet");
assert.equal(preparedRequest.params._meta.claudeCode.options.enableFileCheckpointing, true);

const sdkMessages = [{
	type: "user",
	uuid: "checkpoint-1",
	parent_tool_use_id: null,
	message: { content: "Start here" },
}];
const rewindCalls = [];
const checkpointSession = {
	cwd: "/project",
	query: {
		async rewindFiles(id, options = {}) {
			rewindCalls.push([id, options]);
			return { canRewind: true, filesChanged: ["src/a.js"], insertions: 1, deletions: 2 };
		},
	},
};
const sdk = {
	getSessionMessages: async (sessionId, options) => {
		assert.equal(sessionId, "source");
		assert.equal(options, undefined, "checkpoint lookup must search independently of the live cwd");
		return sdkMessages;
	},
	forkSession: async (sessionId, options) => {
		assert.equal(sessionId, "source");
		assert.deepEqual(options, { upToMessageId: "checkpoint-1" });
		return { sessionId: "checkpoint-fork" };
	},
	deleteSession: async () => assert.fail("successful rewind must retain its fork"),
};
assert.deepEqual(await performClaudeCheckpointRewind({
	sessionId: "source",
	checkpointId: "checkpoint-1",
	mode: "both",
}, checkpointSession, sdk), {
	ok: true,
	mode: "both",
	sessionId: "checkpoint-fork",
	filesChanged: ["src/a.js"],
	insertions: 1,
	deletions: 2,
});
assert.deepEqual(rewindCalls, [
	["checkpoint-1", { dryRun: true }],
	["checkpoint-1", {}],
]);

let removedFork;
let rewindAttempt = 0;
await assert.rejects(() => performClaudeCheckpointRewind({
	sessionId: "source",
	checkpointId: "checkpoint-1",
	mode: "both",
}, {
	...checkpointSession,
	query: {
		async rewindFiles() {
			rewindAttempt += 1;
			if (rewindAttempt === 1) return { canRewind: true };
			throw new Error("rewind failed");
		},
	},
}, {
	...sdk,
	deleteSession: async (sessionId, options) => { removedFork = [sessionId, options]; },
}), /rewind failed/u);
assert.deepEqual(removedFork, ["checkpoint-fork", undefined]);
await assert.rejects(() => performClaudeCheckpointRewind({
	sessionId: "source",
	checkpointId: "not-in-transcript",
	mode: "conversation",
}, checkpointSession, sdk), /not a user message/u);

const checkpointWire = { capabilities: { _meta: { cc: { checkpoints: true } } } };
assert.equal(capabilitiesFromWire(checkpointWire).checkpoints, true);
assert.equal(capabilitiesFromWire({ capabilities: {} }).checkpoints, false);

const adapterCalls = [];
const fakeConnection = {
	sessionId: "adapter-session",
	async initialize() {},
	stop() {},
	getSessionInfo() { return checkpointWire; },
	async listCheckpoints(options) { adapterCalls.push(["list", options]); return { checkpoints: [] }; },
	async rewindCheckpoint(id, mode, options) { adapterCalls.push(["rewind", id, mode, options]); return { ok: true, mode }; },
};
const adapter = new BaseAcpAdapter("fake", { label: "Fake", acp: { command: "fake" } }, {}, {
	connectionFactory: () => fakeConnection,
});
await adapter.connect({ createSession: false });
assert.equal(adapter.capabilities.checkpoints, true);
assert.equal(checkAdapterConformance(adapter).ok, true);
await adapter.listCheckpoints({ limit: 10 });
await adapter.rewindCheckpoint("checkpoint-1", "code", { marker: true });
assert.deepEqual(adapterCalls, [
	["list", { limit: 10 }],
	["rewind", "checkpoint-1", "code", { marker: true }],
]);
await adapter.stopAndWait();
const declaredClaude = new ClaudeAdapter("claude", ClaudeAdapter.defaultAgentConfig, {}, {
	connectionFactory: () => fakeConnection,
});
assert.equal(declaredClaude.capabilities.checkpoints, true);
const customClaude = new ClaudeAdapter("claude", {
	...ClaudeAdapter.defaultAgentConfig,
	acp: { command: "/custom/claude-acp", args: [] },
}, {}, { connectionFactory: () => fakeConnection });
assert.equal(customClaude.capabilities.checkpoints, false);

// Code-only rewind owns the session-transition gate for the entire filesystem
// mutation. Session commands are deferred and harness replacement is rejected
// until the adapter confirms the working tree is consistent again.
await (async () => {
	let releaseRewind;
	const rewindStarted = new Promise((resolve) => { releaseRewind = resolve; });
	let finishRewind;
	const rewindGate = new Promise((resolve) => { finishRewind = resolve; });
	const definition = { label: "Fake" };
	const client = {
		sessionId: "source",
		exited: false,
		async rewindCheckpoint() {
			releaseRewind();
			await rewindGate;
			return { ok: true, mode: "code", filesChanged: [] };
		},
	};
	const app = Object.create(HarnessApp.prototype);
	const deferred = [];
	const notices = [];
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: definition, other: { label: "Other" } } },
		client,
		ready: true,
		busy: false,
		btwThread: undefined,
		sessionSwitchInProgress: false,
		selectionActionInProgress: true,
		configUpdateTokens: new Set(),
		configUpdateCount: 0,
		statusState: "",
		deferredLocalSlashCommands: [],
		ui: { requestRender() {} },
		updateSpinner() {},
		addCommandMessage() {},
		addNotice(message) { notices.push(message); },
		addError(message) { assert.fail(message); },
		deferLocalSlashCommand(name) { deferred.push(name); },
		switchAgent: async () => assert.fail("harness replacement raced code rewind"),
	});
	const context = app.captureActiveAgentContext({ includeClient: true });
	const rewinding = app.applyCheckpointRewind(context, "source", { id: "checkpoint-1", summary: "Start" }, "code");
	await rewindStarted;
	assert.equal(app.sessionSwitchInProgress, true);
	await app.runLocalSlashCommand("clear", "");
	await app.handleHarnessCommand("/harness other");
	assert.deepEqual(deferred, []);
	assert.ok(notices.some((message) => /already starting a new session/iu.test(message)));
	assert.ok(notices.some((message) => /session transition/u.test(message)));
	finishRewind();
	assert.equal(await rewinding, true);
	assert.equal(app.sessionSwitchInProgress, false);
})();

const catalogApp = Object.create(HarnessApp.prototype);
Object.assign(catalogApp, {
	activeKey: "fake",
	focusedThread: "main",
	client: { capabilities: { checkpoints: true } },
	config: { agents: { fake: { label: "Fake" } } },
	sessionStates: new Map([["fake", { capabilities: { checkpoints: true } }]]),
	availableCommands: new Map([["fake", []]]),
	commandsLoaded: new Set(["fake"]),
	themeName: "system",
	isCodexBackendActive: () => false,
});
const checkpointCommands = localSlashCommands(catalogApp).map((entry) => entry.name);
assert.ok(checkpointCommands.includes("rewind"));
assert.ok(checkpointCommands.includes("checkpoint"));
assert.ok(checkpointCommands.includes("undo"));
for (const alias of ["rewind", "checkpoint", "undo"]) {
	assert.equal(catalogApp.slashCommandRoute(alias), "local", `${alias} must not leak to the backend`);
}
catalogApp.client.capabilities = {};
catalogApp.sessionStates.set("fake", { capabilities: {} });
catalogApp.availableCommands.set("fake", [
	{ name: "rewind", description: "backend rewind" },
	{ name: "checkpoint", description: "backend checkpoint" },
	{ name: "undo", description: "backend undo" },
]);
assert.ok(localSlashCommands(catalogApp).some((entry) => entry.name === "undo"), "aliases stay in autocomplete before capability negotiation");
for (const alias of ["rewind", "checkpoint", "undo"]) {
	assert.equal(catalogApp.slashCommandRoute(alias), "local", `${alias} must remain local when the harness is unsupported`);
}

// Transport conversation rewinds use the same buffered load path as /resume.
// A fork that fails before switch commit is removed; a committed fork is kept.
function checkpointTransport() {
	const client = Object.create(AcpClient.prototype);
	Object.assign(client, {
		sessionId: "source",
		capabilities: checkpointWire.capabilities,
		agentInfo: {},
		authMethods: [],
		configOptions: [],
		models: undefined,
		modes: undefined,
		sessionInfo: {},
	});
	return client;
}
const transport = checkpointTransport();
const transportRequests = [];
transport.request = async (method, params) => {
	transportRequests.push([method, params]);
	if (method.endsWith("/list")) return { checkpoints: [{ id: "checkpoint-1", summary: "Start" }] };
	return { ok: true, mode: params.mode, sessionId: "transport-fork" };
};
transport.loadSession = async (sessionId, options) => {
	transport.sessionId = sessionId;
	await options.beforeReplay?.();
};
assert.deepEqual(await transport.listCheckpoints({ limit: 4 }), {
	checkpoints: [{ id: "checkpoint-1", summary: "Start" }],
});
let replayCommitted = false;
assert.equal((await transport.rewindCheckpoint("checkpoint-1", "conversation", {
	beforeReplay: () => { replayCommitted = true; },
})).sessionId, "transport-fork");
assert.equal(transport.sessionId, "transport-fork");
assert.equal(replayCommitted, true);

const failedTransport = checkpointTransport();
failedTransport.request = async (_method, params) => ({ ok: true, mode: params.mode, sessionId: "failed-fork" });
failedTransport.loadSession = async () => { throw new Error("load failed"); };
let deletedFork;
failedTransport.deleteSession = async (id) => { deletedFork = id; };
await assert.rejects(() => failedTransport.rewindCheckpoint("checkpoint-1", "conversation"), /load failed/u);
assert.equal(deletedFork, "failed-fork");
assert.equal(failedTransport.sessionId, "source");

const committedTransport = checkpointTransport();
committedTransport.request = failedTransport.request;
committedTransport.loadSession = async (id) => {
	committedTransport.sessionId = id;
	throw new Error("replay callback failed");
};
committedTransport.deleteSession = async () => assert.fail("a committed fork must not be deleted");
await assert.rejects(() => committedTransport.rewindCheckpoint("checkpoint-1", "conversation"), /replay callback failed/u);
assert.equal(committedTransport.sessionId, "failed-fork");

// The host's second picker always exposes all three portable modes in the
// Claude ordering, and it never runs from a side thread.
const pickerApp = Object.create(HarnessApp.prototype);
let picker;
let selectedMode;
Object.assign(pickerApp, {
	busy: false,
	btwThread: undefined,
	sessionSwitchInProgress: false,
	isCheckpointContextActive: () => true,
	openSelection(title, entries, onSelect) { picker = { title, entries, onSelect }; },
	closeMenu() {},
	applyCheckpointRewind: async (_context, _sessionId, _checkpoint, mode) => { selectedMode = mode; },
});
assert.equal(pickerApp.openCheckpointModeSelection({ client: {} }, "source", { id: "checkpoint-1", summary: "Start" }), true);
assert.equal(picker.title, "What should be rewound?");
assert.deepEqual(picker.entries.map((entry) => entry.value), ["both", "conversation", "code"]);
await picker.onSelect(picker.entries[1]);
assert.equal(selectedMode, "conversation");

const firstPickerClient = {
	capabilities: { checkpoints: true },
	sessionId: "source",
	exited: false,
	async listCheckpoints() {
		return {
			checkpoints: [
				{ id: "older", summary: "Older request" },
				{ id: "latest", summary: "Latest request" },
			],
		};
	},
};
const firstPickerApp = Object.create(HarnessApp.prototype);
let firstPicker;
Object.assign(firstPickerApp, {
	activeKey: "fake",
	transport: "acp",
	activeAgentGeneration: 1,
	client: firstPickerClient,
	ready: true,
	busy: false,
	focusedThread: "main",
	btwThread: undefined,
	sessionSwitchInProgress: false,
	selectionActionInProgress: false,
	asyncPickerLoads: new Set(),
	asyncPickerLoadCount: 0,
	configUpdateTokens: new Set(),
	configUpdateCount: 0,
	permissionPromptActive: false,
	menuHandle: undefined,
	deferredLocalSlashCommands: [],
	config: { agents: { fake: { label: "Fake" } } },
	ui: { requestRender() {} },
	addCommandMessage() {},
	addNotice(text) { assert.fail(`unexpected notice: ${text}`); },
	addError(text) { assert.fail(`unexpected error: ${text}`); },
	updateSpinner() {},
	openSelection(title, entries, onSelect) { firstPicker = { title, entries, onSelect }; },
	schedulePromptQueueDrain() {},
});
assert.equal(await firstPickerApp.openCheckpointRewind(), true);
assert.equal(firstPicker.title, "Rewind to checkpoint");
assert.deepEqual(firstPicker.entries.map((entry) => entry.value.id), ["latest", "older"]);

let resumedPrevious;
firstPickerApp.previousClearedSession = { key: "fake", sessionId: "before-clear" };
firstPickerApp.closeMenu = () => {};
firstPickerApp.resumeSelectedSession = async (session, options) => { resumedPrevious = { session, options }; };
assert.equal(await firstPickerApp.openCheckpointRewind(), true);
assert.equal(firstPicker.entries[0].previousSession.sessionId, "before-clear");
assert.equal(firstPicker.entries[0].label, "/resume before-clear (previous session)");
await firstPicker.onSelect(firstPicker.entries[0]);
assert.deepEqual(resumedPrevious, {
	session: { sessionId: "before-clear", title: "Previous session" },
	options: { displayText: "/resume before-clear (previous session)" },
});

const sideOutput = [];
const side = {};
const sideApp = Object.create(HarnessApp.prototype);
Object.assign(sideApp, {
	focusedThread: "btw",
	btwThread: side,
	ui: { requestRender() {} },
	captureSessionCommandTarget: () => ({ targetThread: side }),
	isSessionCommandTargetActive: () => true,
	addSessionTargetCommand: (_target, text) => sideOutput.push(text),
	addSessionTargetNotice: (_target, text) => sideOutput.push(text),
});
assert.equal(await sideApp.openCheckpointRewind("", "rewind", { targetThread: side }), false);
assert.equal(await sideApp.openCheckpointRewind("", "undo", { targetThread: side }), false);
assert.ok(sideOutput.some((line) => line.includes("only from the main session")));

console.log("checkpoint tests passed");
