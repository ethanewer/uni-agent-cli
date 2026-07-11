import assert from "node:assert/strict";

import {
	BACKGROUND_TASK_LIST_LIMIT,
	BackgroundTaskStore,
	formatBackgroundTaskList,
	normalizeBackgroundTaskActionResponse,
	normalizeBackgroundTaskListResponse,
	parseBackgroundTaskListParams,
	parseBackgroundTasksCommand,
	parseBackgroundTasksBackgroundParams,
	parseBackgroundTaskStopParams,
	sdkMessageMatchesFilter,
	withBackgroundTaskSdkEvents,
} from "../src/harness/background-tasks.mjs";
import {
	CLAUDE_BACKGROUND_TASK_SESSION_LIMIT,
	ClaudeBackgroundTaskBridge,
} from "../src/harness/claude-background-tasks.mjs";
import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { ClaudeAdapter } from "../src/harness/adapters/claude.mjs";
import { capabilitiesFromWire, checkAdapterConformance } from "../src/harness/interface.mjs";
import { AcpClient, HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

const original = [{ type: "assistant" }];
const injected = withBackgroundTaskSdkEvents({
	cwd: "/tmp",
	_meta: { keep: true, claudeCode: { keepClaude: true, emitRawSDKMessages: original } },
});
assert.notEqual(injected.params._meta.claudeCode.emitRawSDKMessages, original);
assert.deepEqual(original, [{ type: "assistant" }], "the caller's filters are not mutated");
assert.equal(injected.params._meta.keep, true);
assert.equal(injected.params._meta.claudeCode.keepClaude, true);
assert.equal(injected.params._meta.claudeCode.emitRawSDKMessages.length, 6);
assert.deepEqual(injected.forwardRawSdkMessages, original);
assert.equal(sdkMessageMatchesFilter(original, { type: "assistant" }), true);
assert.equal(sdkMessageMatchesFilter(original, { type: "system", subtype: "task_started" }), false);

const all = withBackgroundTaskSdkEvents({ _meta: { claudeCode: { emitRawSDKMessages: true } } });
assert.equal(all.params._meta.claudeCode.emitRawSDKMessages, true);
assert.equal(all.forwardRawSdkMessages, true);

assert.deepEqual(parseBackgroundTaskListParams({ sessionId: "s1", limit: 20 }), { sessionId: "s1", limit: 20 });
assert.deepEqual(parseBackgroundTaskStopParams({ sessionId: "s1", taskId: "task-1" }), { sessionId: "s1", taskId: "task-1" });
assert.deepEqual(parseBackgroundTasksBackgroundParams({ sessionId: "s1" }), { sessionId: "s1" });
assert.deepEqual(parseBackgroundTasksBackgroundParams({ sessionId: "s1", toolUseId: "tool-1" }), {
	sessionId: "s1",
	toolUseId: "tool-1",
});
assert.throws(() => parseBackgroundTaskListParams({ sessionId: "s1", limit: BACKGROUND_TASK_LIST_LIMIT + 1 }), /limit/u);
assert.throws(() => parseBackgroundTaskStopParams({ sessionId: "s1", taskId: "bad\u0000id" }), /taskId/u);
assert.deepEqual(parseBackgroundTasksCommand(""), { action: "list" });
assert.deepEqual(parseBackgroundTasksCommand("stop task-1"), { action: "stop", taskId: "task-1" });
assert.deepEqual(parseBackgroundTasksCommand("background"), { action: "background" });
assert.deepEqual(parseBackgroundTasksCommand("background tool-1"), { action: "background", toolUseId: "tool-1" });
assert.throws(() => parseBackgroundTasksCommand("stop"), /usage/u);

const store = new BackgroundTaskStore();
assert.equal(store.applySdkMessage({ type: "assistant" }), false);
assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "task_started",
	task_id: "task-1",
	tool_use_id: "tool-1",
	description: "Explore\u001b[31m repository\u001b[0m\u001b]52;c;secret\u0007",
	subagent_type: "Explore",
	task_type: "local_agent",
}), true);
assert.deepEqual(store.list().tasks[0], {
	id: "task-1",
	status: "running",
	isBackgrounded: false,
	toolUseId: "tool-1",
	type: "local_agent",
	subagentType: "Explore",
	description: "Explore repository",
	ambient: false,
});

assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "task_progress",
	task_id: "task-1",
	description: "Explore repository",
	last_tool_name: "Read",
	summary: "Found entry points",
	usage: { total_tokens: 1234, tool_uses: 7, duration_ms: 800 },
}), true);
assert.equal(store.list().tasks[0].usage.totalTokens, 1234);

assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "background_tasks_changed",
	tasks: [{ task_id: "task-1", task_type: "local_agent", description: "Explore repository" }],
}), true);
assert.equal(store.list().tasks[0].isBackgrounded, true);

assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "task_updated",
	task_id: "task-1",
	patch: { status: "paused", error: "waiting" },
}), true);
assert.equal(store.list().tasks[0].status, "paused");

assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "task_updated",
	task_id: "task-1",
	patch: { status: "running", is_backgrounded: true },
}), true);
assert.equal(store.list().tasks[0].isBackgrounded, true);

assert.equal(store.applySdkMessage({
	type: "system",
	subtype: "task_notification",
	task_id: "task-1",
	status: "completed",
	output_file: "/tmp/task-1.output",
	summary: "Done",
	usage: { total_tokens: 2000, tool_uses: 10, duration_ms: 1200 },
}), true);
const completed = store.list().tasks[0];
assert.equal(completed.status, "completed");
assert.equal(completed.isBackgrounded, false);
assert.equal(completed.outputFile, "/tmp/task-1.output");
const display = formatBackgroundTaskList(store.list());
assert.match(display, /task-1/u);
assert.match(display, /2,000 tokens/u);
assert.match(display, /\/tasks stop <task-id>/u);
assert.match(formatBackgroundTaskList({ revision: 0, tasks: [] }), /No background tasks/u);

// Level messages have replace semantics and can discover a task even if an
// earlier edge was missed. Repeating an identical frame does not bump revision.
const revision = store.revision;
const level = {
	type: "system",
	subtype: "background_tasks_changed",
	tasks: [{ task_id: "task-2", task_type: "bash", description: "Run tests" }],
};
assert.equal(store.applySdkMessage(level), true);
const afterLevel = store.revision;
assert.ok(afterLevel > revision);
assert.equal(store.applySdkMessage(level), false);
assert.equal(store.revision, afterLevel);
assert.equal(store.list().tasks.find((task) => task.id === "task-2").isBackgrounded, true);

// Storage and public output are bounded, preferring eviction of old terminal
// records over active tasks.
const tiny = new BackgroundTaskStore({ limit: 2 });
for (const id of ["one", "two", "three"]) {
	tiny.applySdkMessage({ type: "system", subtype: "task_started", task_id: id, description: id });
	if (id !== "three") tiny.applySdkMessage({ type: "system", subtype: "task_notification", task_id: id, status: "completed", summary: id, output_file: "" });
}
assert.equal(tiny.list().tasks.length, 2);
assert.ok(tiny.list().tasks.some((task) => task.id === "three"));

assert.deepEqual(normalizeBackgroundTaskListResponse(store.list({ limit: 2 })), store.list({ limit: 2 }));
assert.throws(() => normalizeBackgroundTaskListResponse({ revision: -1, tasks: [] }), /invalid/u);
assert.deepEqual(normalizeBackgroundTaskActionResponse({ ok: true }, "stop"), { ok: true });
assert.deepEqual(normalizeBackgroundTaskActionResponse({ ok: true, backgrounded: false }, "background"), {
	ok: true,
	backgrounded: false,
});

const bridge = new ClaudeBackgroundTaskBridge();
const prepared = bridge.prepareSessionRequest({ _meta: { claudeCode: { emitRawSDKMessages: [{ type: "assistant" }] } } });
bridge.registerSession("sdk-session", prepared.forwardRawSdkMessages);
const lifecycle = bridge.consumeRawNotification({
	sessionId: "sdk-session",
	message: {
		type: "system",
		subtype: "task_started",
		task_id: "task-bridge",
		description: "Bridge task",
		session_id: "sdk-session",
	},
});
assert.equal(lifecycle.recognized, true);
assert.equal(lifecycle.changed, true);
assert.equal(lifecycle.forwardRaw, false, "bridge-injected task frames stay private");
assert.equal(lifecycle.notification.tasks[0].id, "task-bridge");
const callerRaw = bridge.consumeRawNotification({
	sessionId: "sdk-session",
	message: { type: "assistant", session_id: "sdk-session" },
});
assert.equal(callerRaw.forwardRaw, true, "an explicit caller raw subscription is preserved");
const mismatched = bridge.consumeRawNotification({
	sessionId: "sdk-session",
	message: { type: "system", subtype: "task_started", task_id: "wrong", session_id: "other-session" },
});
assert.equal(mismatched.changed, false);
for (const invalidSessionId of [undefined, 42]) {
	const malformed = bridge.consumeRawNotification({
		sessionId: "sdk-session",
		message: {
			type: "system",
			subtype: "task_started",
			task_id: `missing-owner-${String(invalidSessionId)}`,
			...(invalidSessionId !== undefined ? { session_id: invalidSessionId } : {}),
		},
	});
	assert.equal(malformed.changed, false, "lifecycle frames require an exact SDK session owner");
}
assert.equal(bridge.list("sdk-session").tasks.some((task) => task.id === "wrong"), false);
assert.equal(bridge.list("sdk-session").tasks.some((task) => task.id.startsWith("missing-owner")), false);
bridge.registerSession("sdk-session", false, { reset: true });
assert.deepEqual(bridge.list("sdk-session"), { revision: 0, tasks: [], total: 0 }, "a restarted SDK query resets process-local task state");
bridge.removeSession("sdk-session");
assert.deepEqual(bridge.list("sdk-session"), { revision: 0, tasks: [], total: 0 });

// `/clear` creates a new SDK session without necessarily closing the historical
// one first. Keep that process-local registry bounded and evict least-recently
// registered state rather than retaining a task store for every old session.
const boundedSessions = new ClaudeBackgroundTaskBridge({ sessionLimit: 2 });
boundedSessions.registerSession("oldest");
boundedSessions.registerSession("recent");
boundedSessions.consumeRawNotification({
	sessionId: "oldest",
	message: { type: "system", subtype: "task_started", task_id: "old-task", session_id: "oldest" },
});
boundedSessions.registerSession("newest");
assert.equal(boundedSessions.sessions.size, 2);
assert.deepEqual(boundedSessions.list("oldest"), { revision: 0, tasks: [], total: 0 });
assert.equal(boundedSessions.sessions.has("recent"), true);
assert.equal(boundedSessions.sessions.has("newest"), true);
assert.equal(new ClaudeBackgroundTaskBridge().sessionLimit, CLAUDE_BACKGROUND_TASK_SESSION_LIMIT);

const taskWire = { capabilities: { _meta: { cc: { backgroundTasks: true } } } };
assert.equal(capabilitiesFromWire(taskWire).backgroundTasks, true);
assert.equal(capabilitiesFromWire({ capabilities: {} }).backgroundTasks, false);
const calls = [];
const fakeConnection = {
	sessionId: "adapter-session",
	async initialize() {},
	getSessionInfo() { return taskWire; },
	async listBackgroundTasks(options) { calls.push(["list", options]); return { revision: 0, tasks: [] }; },
	async stopBackgroundTask(taskId) { calls.push(["stop", taskId]); return { ok: true }; },
	async backgroundTasks(toolUseId) { calls.push(["background", toolUseId]); return { ok: true, backgrounded: true }; },
};
const adapter = new BaseAcpAdapter("fake", { label: "Fake", acp: { command: "fake", args: [] } }, {}, {
	connectionFactory: () => fakeConnection,
});
await adapter.connect({ createSession: false });
assert.equal(adapter.capabilities.backgroundTasks, true);
assert.equal(checkAdapterConformance(adapter).ok, true);
await adapter.listBackgroundTasks({ limit: 10 });
await adapter.stopBackgroundTask("task-1");
await adapter.backgroundTasks("tool-1");
assert.deepEqual(calls, [["list", { limit: 10 }], ["stop", "task-1"], ["background", "tool-1"]]);
const declaredClaude = new ClaudeAdapter("claude", ClaudeAdapter.defaultAgentConfig, {}, {
	connectionFactory: () => fakeConnection,
});
assert.equal(declaredClaude.capabilities.backgroundTasks, true);
const customClaude = new ClaudeAdapter("claude", {
	...ClaudeAdapter.defaultAgentConfig,
	acp: { command: "/custom/claude-acp", args: [] },
}, {}, { connectionFactory: () => fakeConnection });
assert.equal(customClaude.capabilities.backgroundTasks, false);

const extensionClient = Object.create(AcpClient.prototype);
const extensionEvents = [];
Object.assign(extensionClient, {
	sessionId: "transport-session",
	capabilities: taskWire.capabilities,
	agentInfo: {},
	authMethods: [],
	configOptions: [],
	models: undefined,
	modes: undefined,
	sessionInfo: {},
	backgroundTasksSnapshot: { revision: 0, tasks: [], total: 0 },
	onEvent: (event) => extensionEvents.push(event),
});
const extensionRequests = [];
extensionClient.request = async (method, params) => {
	extensionRequests.push([method, params]);
	if (method.endsWith("/list")) return { revision: 1, tasks: [] };
	if (method.endsWith("/background")) return { ok: true, backgrounded: true };
	return { ok: true };
};
await extensionClient.listBackgroundTasks({ limit: 12 });
await extensionClient.stopBackgroundTask("task-transport");
await extensionClient.backgroundTasks("tool-transport");
assert.deepEqual(extensionRequests.map(([method]) => method), [
	"cc/session/tasks/list",
	"cc/session/tasks/stop",
	"cc/session/tasks/background",
]);
extensionClient.handleLine(JSON.stringify({
	jsonrpc: "2.0",
	method: "cc/session/tasks/changed",
	params: {
		sessionId: "transport-session",
		revision: 2,
		tasks: [{ id: "live", status: "running", isBackgrounded: true, description: "Live task" }],
	},
}));
assert.equal(extensionClient.backgroundTasksSnapshot.tasks[0].id, "live");
assert.ok(extensionEvents.some((event) => event.type === "background_tasks"));

const commandClient = {
	capabilities: { backgroundTasks: true },
	sessionId: "command-session",
	exited: false,
	async listBackgroundTasks() {
		return { revision: 1, tasks: [{ id: "task-command", status: "running", isBackgrounded: true, description: "Command task" }] };
	},
	async stopBackgroundTask(taskId) { this.stopped = taskId; return { ok: true }; },
	async backgroundTasks(toolUseId) { this.backgrounded = toolUseId ?? true; return { ok: true, backgrounded: true }; },
};
const commandApp = Object.create(HarnessApp.prototype);
const commandOutput = [];
Object.assign(commandApp, {
	activeKey: "fake",
	transport: "acp",
	activeAgentGeneration: 1,
	client: commandClient,
	ready: true,
	focusedThread: "main",
	config: { agents: { fake: { label: "Fake" } } },
	sessionStates: new Map([["fake", { capabilities: commandClient.capabilities }]]),
	availableCommands: new Map([["fake", []]]),
	commandsLoaded: new Set(["fake"]),
	themeName: "system",
	ui: { requestRender() {} },
	isCodexBackendActive: () => false,
	prepareSessionConfigCommandTarget: async () => ({
		agentContext: { key: "fake", generation: 1, transport: "acp" },
		client: commandClient,
		sessionId: "command-session",
	}),
	isSessionCommandTargetActive: () => true,
	addSessionTargetCommand: (_target, text) => { commandOutput.push(text); return true; },
	addSessionTargetNotice: (_target, text) => { commandOutput.push(text); return true; },
	addSessionTargetError: (_target, text) => { commandOutput.push(`error:${text}`); return true; },
});
assert.ok(localSlashCommands(commandApp).some((entry) => entry.name === "tasks"));
assert.equal(commandApp.slashCommandRoute("tasks"), "local");
await commandApp.runBackgroundTasksCommand("");
assert.ok(commandOutput.some((text) => text.includes("task-command")));
await commandApp.runBackgroundTasksCommand("stop task-command");
assert.equal(commandClient.stopped, "task-command");
await commandApp.runBackgroundTasksCommand("background tool-command");
assert.equal(commandClient.backgrounded, "tool-command");

console.log("ok - background task protocol, normalization, and bounded lifecycle state");
