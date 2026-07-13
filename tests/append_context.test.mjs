import assert from "node:assert/strict";

import {
	APPEND_CONTEXT_MAX_BYTES,
	claudeContextMessage,
	normalizeAppendContextResponse,
	parseAppendContextParams,
} from "../src/harness/append-context.mjs";
import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { appendClaudeContext } from "../src/harness/claude-acp-bridge.mjs";
import { capabilitiesFromWire } from "../src/harness/interface.mjs";
import { formatShellContext, formatShellFollowup } from "../src/harness/shell-input.mjs";
import { AcpClient, HarnessApp } from "../src/pi-harness.mjs";

const meta = { _meta: { cc: { appendContext: true } } };
assert.equal(capabilitiesFromWire({ capabilities: meta }).appendContext, true);
assert.equal(capabilitiesFromWire({ capabilities: {} }).appendContext, false);

assert.deepEqual(parseAppendContextParams({ sessionId: "session", text: "context\n" }), {
	sessionId: "session",
	text: "context\n",
});
assert.throws(() => parseAppendContextParams({ sessionId: "session", text: "" }), /non-empty/u);
assert.throws(
	() => parseAppendContextParams({ sessionId: "session", text: "x".repeat(APPEND_CONTEXT_MAX_BYTES + 1) }),
	/exceeds/u,
);
assert.deepEqual(normalizeAppendContextResponse({ appended: true }), { appended: true });
assert.throws(() => normalizeAppendContextResponse({ appended: false }), /invalid/u);
assert.deepEqual(claudeContextMessage("result", "session"), {
	type: "user",
	message: { role: "user", content: "result" },
	parent_tool_use_id: null,
	shouldQuery: false,
	session_id: "session",
});

// The bridge must use the maintained adapter's long-lived Pushable. Feeding a
// finite iterable through Query.streamInput calls endInput() and closes every
// later turn for the session.
const pushed = [];
const ensured = [];
const appendSession = {
	queryClosed: false,
	input: { push(message) { pushed.push(message); } },
	query: {
		streamInput() { assert.fail("appendContext must not close the Query input stream"); },
	},
};
const appendAgent = {
	sessions: { session: appendSession },
	ensureConsumer(session, sessionId) { ensured.push([session, sessionId]); },
};
assert.deepEqual(appendClaudeContext(appendAgent, { sessionId: "session", text: "context-only" }), {
	appended: true,
});
assert.deepEqual(pushed, [claudeContextMessage("context-only", "session")]);
assert.deepEqual(ensured, [[appendSession, "session"]]);
appendSession.queryClosed = true;
assert.throws(
	() => appendClaudeContext(appendAgent, { sessionId: "session", text: "too late" }),
	/session has ended/u,
);

const connection = Object.create(AcpClient.prototype);
Object.assign(connection, {
	sessionId: "session",
	capabilities: meta,
	agentInfo: {},
	authMethods: [],
	configOptions: [],
	models: undefined,
	modes: undefined,
	sessionInfo: {},
});
let request;
connection.request = async (method, params) => {
	request = { method, params };
	return { appended: true };
};
assert.deepEqual(await connection.appendContext("context"), { appended: true });
assert.deepEqual(request, {
	method: "cc/session/append_context",
	params: { sessionId: "session", text: "context" },
});

const fakeConnection = {
	capabilities: meta,
	sessionId: "session",
	async initialize() {},
	async prompt() {},
	cancel() {},
	stop() {},
	getSessionInfo() { return { capabilities: this.capabilities }; },
	async appendContext(text) { return { text }; },
};
const adapter = new BaseAcpAdapter("fake", { acp: { command: "fake" } }, {}, {
	connectionFactory: () => fakeConnection,
});
await adapter.connect({ createSession: false });
assert.equal(adapter.capabilities.appendContext, true);
assert.deepEqual(await adapter.appendContext("context"), { text: "context" });
await adapter.stopAndWait();

const shellResult = { command: "pwd", code: 0, stdout: "/tmp", stderr: "" };
assert.doesNotMatch(formatShellContext(shellResult), /Respond to the command result/u);
assert.match(formatShellFollowup(shellResult), /Respond to the command result/u);

// Context-only shell output (respondToBashCommands: false) is injected into the
// live session's model context, so it marks the conversation as started: a later
// pre-conversation /cd must not quietly discard the session holding it.
{
	const appended = [];
	const client = {
		exited: false,
		sessionId: "live",
		capabilities: { appendContext: true },
		async appendContext(text) { appended.push(text); },
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: {} }, settings: { respondToBashCommands: false } },
		conversationStarted: false,
		client,
		ready: true,
		busy: false,
		statusState: "",
		sessionSwitchInProgress: false,
		activeShellInputCount: 0,
		shellInputsRunning: 0,
		ui: { requestRender() {} },
		updateSpinner() {},
		addUserMessage() {},
		addNotice(message) { assert.fail(message); },
		addError(message) { assert.fail(message); },
	});
	await app.runShellInput("echo context-only-shell");
	assert.equal(appended.length, 1);
	assert.match(appended[0], /context-only-shell/u);
	assert.equal(app.conversationStarted, true, "injected shell context makes the session a conversation");
}

console.log("append context tests passed");
