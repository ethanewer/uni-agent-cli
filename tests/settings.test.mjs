import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AcpClient,
	applyHarnessSettings,
	autoPermissionOutcome,
	copyCodexRolloutWithNewId,
	findCodexRolloutPath,
	loadForkIds,
	recordForkId,
	findConfigValue,
	findMode,
	flattenModes,
	HarnessApp,
	hideCursorDuringRender,
	isVsCodeAutoActivationCommand,
	isVsCodeTerminal,
	loadConfig,
	readCodexThreadState,
	resolveThemeName,
	rewriteFullScreenClear,
	saveSettingsPatch,
	shouldDropVsCodeAutoActivationInput,
	stabilizeGrowingRenderedLines,
	stabilizeMutableRenderedLines,
	streamingMutableTail,
	themeNames,
} from "../src/pi-harness.mjs";

function clipboardReplayHarness() {
	const replayed = [];
	const app = Object.create(HarnessApp.prototype);
	app.bufferedClipboardPasteInput = [];
	app.clipboardPasteInProgress = false;
	app.ui = {
		handleInput(data) {
			replayed.push(data);
		},
	};
	return { app, replayed };
}

function afterToolHarness() {
	let cancelCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.busy = true;
	app.afterToolCancelPending = false;
	app.cancelRequested = false;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.seenToolThisTurn = false;
	app.promptQueue = [{ text: "queued", timing: "afterTool" }];
	app.client = {
		cancel() {
			cancelCount += 1;
		},
	};
	app.statusState = "working";
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	return { app, cancelCount: () => cancelCount };
}

function busyPromptHarness(agentName = "codex-acp") {
	const prompts = [];
	let cancelCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = true;
	app.cancelRequested = false;
	app.sessionSwitchInProgress = false;
	app.activeKey = agentName === "codex-acp" ? "codex" : "claude";
	app.config = config;
	app.client = {
		agentInfo: { name: agentName },
		prompt(prompt) {
			prompts.push(prompt);
			return new Promise(() => {});
		},
		cancel() {
			cancelCount += 1;
		},
	};
	app.sessionStates = new Map([[app.activeKey, { agentInfo: { name: agentName } }]]);
	app.promptQueue = [];
	app.promptQueueDrainScheduled = false;
	app.afterToolCancelPending = false;
	app.seenToolThisTurn = false;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.promptForActiveCapabilities = (text) => text;
	return { app, prompts, cancelCount: () => cancelCount };
}

function unsendHarness({ initialState, currentState = initialState } = {}) {
	const prompts = [];
	let cancelCount = 0;
	let resolvePrompt;
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = false;
	app.cancelRequested = false;
	app.afterToolCancelPending = false;
	app.sessionSwitchInProgress = false;
	app.transport = "acp";
	app.activeKey = "codex";
	app.config = config;
	app.client = {
		sessionId: "codex-session",
		agentInfo: { name: "codex-acp" },
		exited: false,
		prompt(prompt) {
			prompts.push(prompt);
			return new Promise((resolve) => {
				resolvePrompt = resolve;
			});
		},
		cancel() {
			cancelCount += 1;
		},
		forceResolvePrompt() {
			resolvePrompt?.({ stopReason: "cancelled" });
			return true;
		},
	};
	app.sessionStates = new Map([["codex", { agentInfo: { name: "codex-acp" } }]]);
	app.chat = {
		children: [],
		addChild(child) {
			this.children.push(child);
		},
		removeChild(child) {
			const index = this.children.indexOf(child);
			if (index !== -1) this.children.splice(index, 1);
		},
	};
	app.editor = {
		text: "",
		getText() {
			return this.text;
		},
		setText(text) {
			this.text = text;
		},
	};
	app.promptQueue = [];
	app.pendingUserEchoes = [];
	app.pendingUnsendPrompt = undefined;
	app.codexThreadStateSnapshot = initialState;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.seenToolThisTurn = false;
	app.pendingPromptDisplay = undefined;
	app.clipboardImages = [];
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.promptForActiveCapabilities = (text) => text;
	app.readCodexThreadState = () => currentState;
	app.restagePromptImages = HarnessApp.prototype.restagePromptImages;
	return { app, prompts, cancelCount: () => cancelCount };
}

function voiceKeyHarness(controllerOverrides = {}) {
	const calls = [];
	const editor = {
		onSubmit(text) {
			calls.push(["submit", text]);
		},
	};
	const controller = {
		isRecording: () => true,
		isTranscribing: () => false,
		toggle() {
			calls.push("toggle");
		},
		queue() {
			calls.push("queue");
		},
		finish() {
			calls.push("finish");
		},
		cancel() {
			calls.push("cancel");
		},
		...controllerOverrides,
	};
	const app = Object.create(HarnessApp.prototype);
	app.voiceController = controller;
	app.voiceModeEnabled = true;
	app.editor = editor;
	app.ui = { requestRender() {} };
	return { app, calls };
}

function normalizedToolStatusEvents(statuses) {
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "fake-session";
	client.onEvent = (event) => events.push(event);
	client.bufferingSessionUpdates = false;
	for (const status of statuses) {
		client.handleSessionUpdate({
			sessionId: "fake-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				status,
			},
		});
	}
	return events.map((event) => event.status);
}

// handleLine must classify an incoming message by the absence of `method`, not by
// pending-id membership: a backend request whose id collides with one of our
// in-flight request ids must be routed as a request, not mis-resolved as a reply.
{
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "s";
	client.pending = new Map();
	const eventTypes = [];
	client.onEvent = (event) => eventTypes.push(event.type);
	let resolved = false;
	let rejected = false;
	client.pending.set(3, { method: "session/prompt", resolve: () => (resolved = true), reject: () => (rejected = true) });
	let terminalHandled = false;
	client.handleTerminalRequest = async () => (terminalHandled = true);
	// Backend reuses id 3 for its OWN request while our prompt (id 3) is in flight.
	client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "terminal/create", params: {} }));
	assert.equal(resolved, false);
	assert.equal(rejected, false);
	assert.equal(client.pending.has(3), true);
	assert.equal(terminalHandled, true);
	assert.ok(eventTypes.includes("backend_activity"));
}

// A genuine response (id present, no method) still resolves the matching pending request.
{
	const client = Object.create(AcpClient.prototype);
	client.pending = new Map();
	client.onEvent = () => {};
	let resolvedWith;
	client.pending.set(3, { method: "session/prompt", resolve: (value) => (resolvedWith = value), reject: () => {} });
	client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { stopReason: "end_turn" } }));
	assert.deepEqual(resolvedWith, { stopReason: "end_turn" });
	assert.equal(client.pending.has(3), false);
}

const config = {
	defaultAgent: "codex",
	agents: {
		claude: {
			label: "Claude Code",
			transport: "acp",
			acp: { command: "claude-agent-acp", args: [] },
		},
		codex: {
			label: "Codex",
			transport: "acp",
			acp: { command: "codex-acp", args: [] },
		},
		cursor: {
			label: "Cursor Agent",
			transport: "acp",
			acp: { command: "cursor-agent", args: ["acp"] },
		},
		"terminus-2": {
			label: "Terminus-2",
			transport: "acp",
			acp: { command: "python3", args: ["src/harnesses/terminus_2/bridge.py"] },
		},
		"mini-swe-agent": {
			label: "mini-swe-agent",
			transport: "acp",
			acp: { command: "python3", args: ["src/harnesses/mini_swe_agent/bridge.py"] },
		},
	},
};

{
	const { app, replayed } = clipboardReplayHarness();
	app.bufferClipboardPasteInput("\r");
	app.bufferClipboardPasteInput("n");
	app.flushBufferedClipboardPasteInput({ allowSubmit: true });
	assert.deepEqual(replayed, ["\r", "n"]);
	assert.deepEqual(app.bufferedClipboardPasteInput, []);
}

{
	const { app, replayed } = clipboardReplayHarness();
	app.bufferClipboardPasteInput("a");
	app.bufferClipboardPasteInput("\r");
	app.bufferClipboardPasteInput("b");
	app.bufferClipboardPasteInput("\n");
	app.bufferClipboardPasteInput("c");
	app.flushBufferedClipboardPasteInput({ allowSubmit: false });
	assert.deepEqual(replayed, ["a", "b", "c"]);
	assert.deepEqual(app.bufferedClipboardPasteInput, []);
}

{
	const { app, calls } = voiceKeyHarness();
	const consumed = app.handleVoiceKey("", {
		isSpace: false,
		isModifiedSpace: false,
		isCtrlSpace: false,
		isSubmit: true,
		isTab: false,
		isCancel: false,
	});
	assert.equal(consumed, true);
	assert.deepEqual(calls, ["toggle"]);
	assert.equal(typeof app.voiceOriginalOnSubmit, "function");
}

{
	const { app, calls } = voiceKeyHarness({
		isRecording: () => false,
	});
	const consumed = app.handleVoiceKey("", {
		isSpace: false,
		isModifiedSpace: false,
		isCtrlSpace: false,
		isSubmit: true,
		isTab: false,
		isCancel: false,
	});
	assert.equal(consumed, false);
	assert.deepEqual(calls, []);
}

{
	const { app, calls } = voiceKeyHarness();
	const consumed = app.handleVoiceKey("", {
		isSpace: false,
		isModifiedSpace: false,
		isCtrlSpace: false,
		isSubmit: false,
		isTab: true,
		isCancel: false,
	});
	assert.equal(consumed, true);
	assert.deepEqual(calls, ["queue"]);
	assert.equal(typeof app.voiceOriginalOnSubmit, "function");
}

{
	const { app, calls } = voiceKeyHarness({
		isRecording: () => false,
		isTranscribing: () => true,
	});
	const consumed = app.handleVoiceKey("", {
		isSpace: false,
		isModifiedSpace: false,
		isCtrlSpace: false,
		isSubmit: false,
		isTab: true,
		isCancel: false,
	});
	assert.equal(consumed, true);
	assert.deepEqual(calls, []);
}

{
	const submitted = [];
	const app = Object.create(HarnessApp.prototype);
	app.voicePendingSubmit = "typed suffix";
	app.handleSubmit = (text, opts) => {
		submitted.push({ text, opts });
	};
	app.handleVoiceQueue("spoken text");
	assert.deepEqual(submitted, [{ text: "spoken text typed suffix", opts: { queueTiming: "afterTurn" } }]);
	assert.equal(app.voicePendingSubmit, undefined);
}

{
	const submitted = [];
	const app = Object.create(HarnessApp.prototype);
	app.voicePendingSubmit = "typed only";
	app.handleSubmit = (text, opts) => {
		submitted.push({ text, opts });
	};
	app.handleVoiceQueue("");
	assert.deepEqual(submitted, [{ text: "typed only", opts: { queueTiming: "afterTurn" } }]);
	assert.equal(app.voicePendingSubmit, undefined);
}

{
	const { app, calls } = voiceKeyHarness();
	app.focusedThread = "main";
	app.busy = true;
	app.btwThread = undefined;
	app.clipboardPasteInProgress = false;
	app.editor.getText = () => "typed";
	app.editor.setText = () => {
		calls.push("setText");
	};
	app.editor.autocompleteState = undefined;
	app.handlePageScroll = () => false;
	app.queueCurrentInput = () => {
		calls.push("queueCurrentInput");
		return true;
	};
	const result = app.handleGlobalInput("\t");
	assert.deepEqual(result, { consume: true });
	assert.deepEqual(calls, ["queue"]);
}

// While a clipboard paste is resolving, busy-steering must not consume input:
// Tab/Esc are buffered for in-order replay so they act on the post-paste editor
// state rather than the still-stale current text.
{
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.menuHandle = undefined;
	app.btwThread = undefined;
	app.focusedThread = "main";
	app.busy = true;
	app.clipboardPasteInProgress = true;
	app.bufferedClipboardPasteInput = [];
	app.voiceController = undefined;
	app.editor = { getText: () => "typed", autocompleteState: undefined };
	app.handlePageScroll = () => false;
	app.queueCurrentInput = () => calls.push("queueCurrentInput");
	app.interruptViaEscape = () => calls.push("interruptViaEscape");
	app.tryUnsendPendingPrompt = () => {
		calls.push("tryUnsend");
		return false;
	};
	app.ui = { requestRender() {}, handleInput() {} };

	assert.deepEqual(app.handleGlobalInput("\t"), { consume: true });
	assert.deepEqual(app.handleGlobalInput("\x1b"), { consume: true });
	assert.deepEqual(app.handleGlobalInput("hello"), { consume: true });
	// Nothing was steered or interrupted; every keystroke went to the paste buffer.
	assert.deepEqual(calls, []);
	assert.deepEqual(app.bufferedClipboardPasteInput, ["\t", "\x1b", "hello"]);
}

// /btw command routing must mirror the main dispatcher's precedence: a command the
// backend advertises stays reachable (sent to the fork) even when it shares a name
// with a local command; a non-advertised local command runs on the main path; and
// reserved UI commands always run locally. The /model case exercises the overlap
// that the precedence fix addresses (it must reach the fork, not be shadowed locally).
await (async () => {
	const submitted = [];
	const localRan = [];
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "btw";
	app.activeKey = "codex";
	app.config = config;
	app.sessionStates = new Map([["codex", {}]]);
	app.availableCommands = new Map([["codex", [{ name: "model" }]]]);
	app.btwThread = { submit: (text) => submitted.push(text) };
	app.editor = { addToHistory() {}, getText: () => "", setText() {} };
	app.consumeImagePromptParts = () => undefined;
	app.runLocalSlashCommand = async (name) => localRan.push(name);
	app.lastKnownEditorText = "";
	await app.handleSubmit("/model"); // backend advertises "model" -> fork (not shadowed)
	await app.handleSubmit("/effort"); // local, not advertised -> main path
	await app.handleSubmit("/diff"); // reserved UI command -> always local
	assert.deepEqual(submitted, ["/model"]);
	assert.deepEqual(localRan, ["effort", "diff"]);
})();

// A local command (/model, /effort, …) deferred while a /resume load is in
// flight must be flushed when the switch completes, not left stuck in the queue.
await (async () => {
	const ran = [];
	const app = Object.create(HarnessApp.prototype);
	app.client = {
		sessionId: "old-session",
		capabilities: { loadSession: true },
		loadSession: async () => {},
	};
	app.sessionSwitchInProgress = false;
	app.deferredLocalSlashCommands = [{ name: "model", argument: "" }];
	app.resetConversationView = () => {};
	app.addCommandMessage = () => {};
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.ui = { requestRender() {} };
	app.runLocalSlashCommand = async (name, argument) => ran.push({ name, argument });
	await app.resumeSelectedSession({ sessionId: "new-session", title: "New" });
	assert.deepEqual(ran, [{ name: "model", argument: "" }]);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.sessionSwitchInProgress, false);
})();

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus("read-1", "running");
	app.trackToolStatus("read-2", "running");
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 0);
	assert.equal(app.cancelRequested, false);
	assert.equal(app.afterToolCancelPending, false);
	app.trackToolStatus("read-2", "complete");
	assert.equal(cancelCount(), 1);
	assert.equal(app.cancelRequested, true);
	assert.equal(app.afterToolCancelPending, true);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus("read-1", "running");
	app.trackToolStatus(undefined, "complete", { startsTool: false });
	assert.equal(cancelCount(), 1);
	assert.equal(app.activeToolIds.size, 0);
	assert.equal(app.cancelRequested, true);
	assert.equal(app.afterToolCancelPending, true);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus("read-1", "running");
	app.trackToolStatus(undefined, "complete", { startsTool: true });
	assert.equal(cancelCount(), 0);
	assert.deepEqual([...app.activeToolIds], ["read-1"]);
	assert.equal(app.cancelRequested, false);
	assert.equal(app.afterToolCancelPending, false);
}

{
	assert.deepEqual(
		normalizedToolStatusEvents(["finished", "finished-successfully", "timed out", "errored"]),
		["complete", "complete", "canceled", "error"],
	);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running");
	assert.equal(cancelCount(), 0);
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 1);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running");
	app.trackToolStatus(undefined, "running");
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 0);
	assert.equal(app.activeAnonymousToolCount, 1);
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 1);
	assert.equal(app.activeAnonymousToolCount, 0);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running", { startsTool: true });
	app.trackToolStatus(undefined, "running", { startsTool: false });
	assert.equal(app.activeAnonymousToolCount, 1);
	app.trackToolStatus(undefined, "complete", { startsTool: false });
	assert.equal(cancelCount(), 1);
	assert.equal(app.activeAnonymousToolCount, 0);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running", { startsTool: true });
	app.trackToolStatus(undefined, "complete", { startsTool: true });
	assert.equal(app.activeAnonymousToolCount, 1);
	assert.equal(cancelCount(), 0);
	app.trackToolStatus(undefined, "complete", { startsTool: false });
	assert.equal(app.activeAnonymousToolCount, 0);
	assert.equal(cancelCount(), 1);
}

{
	// Enter while busy queues "after tool"; with a tool still running the steer
	// waits for the tool boundary before canceling.
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	app.activeToolIds.add("read-1");
	await app.submitBackendPrompt("steer now");
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "steer now");
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(cancelCount(), 0);
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 1);
}

{
	// Enter queues after-tool; Tab queues after-turn. Only the after-tool item
	// triggers the boundary cancel.
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	app.activeToolIds.add("read-1");
	await app.submitBackendPrompt("first steer");
	await app.submitBackendPrompt("second queued", { queueTiming: "afterTurn" });
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 2);
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(app.promptQueue[1].timing, "afterTurn");
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 1);

	app.promptQueue.shift();
	app.cancelRequested = false;
	app.afterToolCancelPending = false;
	app.seenToolThisTurn = false;
	app.activeToolIds.clear();
	app.activeAnonymousToolCount = 0;
	app.trackToolStatus("next-turn-tool", "running");
	app.trackToolStatus("next-turn-tool", "complete");
	assert.equal(cancelCount(), 1);
}

{
	// Enter while busy with a tool already finished cancels immediately to steer.
	const { app, prompts, cancelCount } = busyPromptHarness("fake-acp");
	app.seenToolThisTurn = true;
	await app.submitBackendPrompt("queue after tool");
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "queue after tool");
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(cancelCount(), 1);
}

{
	// Tab keeps a slash command queued for after the turn without canceling.
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	await app.submitBackendPrompt("/review", { compactCommand: true, queueTiming: "afterTurn" });
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "/review");
	assert.equal(app.promptQueue[0].compactCommand, true);
	assert.equal(app.promptQueue[0].timing, "afterTurn");
	assert.equal(cancelCount(), 0);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("recall this");
	assert.deepEqual(prompts, ["recall this"]);
	assert.equal(app.chat.children.length, 1);
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.equal(cancelCount(), 1);
	assert.equal(app.editor.getText(), "recall this");
	assert.equal(app.chat.children.length, 0);
	assert.equal(app.pendingUnsendPrompt, undefined);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(app.busy, false);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: unchanged });
	app.promptQueue.push({ text: "queued prompt", timing: "afterTurn" });
	void app.flushPromptQueue();
	assert.deepEqual(prompts, ["queued prompt"]);
	assert.equal(app.promptQueue.length, 0);
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.equal(cancelCount(), 1);
	assert.equal(app.editor.getText(), "queued prompt");
	assert.equal(app.chat.children.length, 0);
}

{
	const emptySession = {
		sessionId: "codex-session",
		row: null,
		rollout: null,
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: emptySession });
	void app.submitBackendPrompt("first message");
	assert.deepEqual(prompts, ["first message"]);
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.equal(cancelCount(), 1);
	assert.equal(app.editor.getText(), "first message");
	assert.equal(app.chat.children.length, 0);
}

{
	const emptySession = {
		sessionId: "codex-session",
		row: null,
		rollout: null,
	};
	const rolloutCreated = {
		sessionId: "codex-session",
		row: null,
		rollout: { size: 40, mtimeMs: 1001 },
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: emptySession, currentState: rolloutCreated });
	void app.submitBackendPrompt("first message");
	assert.deepEqual(prompts, ["first message"]);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	app.interruptViaEscape();
	assert.equal(cancelCount(), 1);
	assert.equal(app.chat.children.length, 1);
}

{
	const emptySession = {
		sessionId: "codex-session",
		row: null,
		rollout: null,
	};
	const createdState = {
		sessionId: "codex-session",
		row: { updated_at_ms: 101, preview: "first message" },
		rollout: { size: 40, mtimeMs: 1001 },
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: emptySession, currentState: createdState });
	void app.submitBackendPrompt("first message");
	assert.deepEqual(prompts, ["first message"]);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	app.interruptViaEscape();
	assert.equal(cancelCount(), 1);
	assert.equal(app.chat.children.length, 1);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("recall this");
	app.promptQueue.push({ text: "queued after turn", timing: "afterTurn" });
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.equal(app.editor.getText(), "recall this\nqueued after turn");
	assert.equal(app.promptQueue.length, 0);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("recall this");
	app.promptQueue.push({ text: "queued after tool", timing: "afterTool" });
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	assert.equal(app.promptQueue.length, 1);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("already active");
	app.handleBackendEvent({ type: "text", text: "started" });
	assert.equal(app.pendingUnsendPrompt, undefined);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	assert.equal(app.chat.children.length, 3);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("backend progressed");
	app.handleBackendEvent({ type: "backend_activity" });
	assert.equal(app.pendingUnsendPrompt, undefined);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	assert.equal(app.chat.children.length, 1);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app, cancelCount } = unsendHarness({ initialState: unchanged });
	app.activeKey = "claude";
	app.client.agentInfo = { name: "claude-agent-acp" };
	app.sessionStates = new Map([["claude", { agentInfo: { name: "claude-agent-acp" } }]]);
	void app.submitBackendPrompt("not codex");
	assert.equal(app.pendingUnsendPrompt, undefined);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	app.interruptViaEscape();
	assert.equal(cancelCount(), 1);
	assert.equal(app.chat.children.length, 1);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	void app.submitBackendPrompt("recall [Image 1]", {
		promptParts: [
			{ type: "text", text: "recall " },
			{ type: "image", data: "aW1hZ2Ux", mimeType: "image/png" },
		],
	});
	app.editor.setText("next [Image 9]");
	app.clipboardImages = [{ label: "[Image 9]", data: "aW1hZ2U5", mimeType: "image/png" }];
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.equal(app.editor.getText(), "recall [Image 1]\nnext [Image 9]");
	assert.deepEqual(app.clipboardImages.map((image) => image.label), ["[Image 1]", "[Image 9]"]);
}

{
	const unchanged = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const { app } = unsendHarness({ initialState: unchanged });
	const previous = { render: () => ["previous"], invalidate() {} };
	app.chat.children.push(previous);
	void app.submitBackendPrompt("recall this");
	assert.equal(app.chat.children.length, 3);
	assert.equal(app.tryUnsendPendingPrompt(), true);
	assert.deepEqual(app.chat.children, [previous]);
}

{
	const initial = {
		sessionId: "codex-session",
		row: { updated_at_ms: 100, preview: "before" },
		rollout: { size: 20, mtimeMs: 1000 },
	};
	const changed = {
		sessionId: "codex-session",
		row: { updated_at_ms: 101, preview: "after" },
		rollout: { size: 40, mtimeMs: 1001 },
	};
	const { app, prompts, cancelCount } = unsendHarness({ initialState: initial, currentState: changed });
	void app.submitBackendPrompt("already received");
	assert.deepEqual(prompts, ["already received"]);
	assert.equal(app.tryUnsendPendingPrompt(), false);
	assert.equal(app.editor.getText(), "");
	assert.equal(app.chat.children.length, 1);
	app.interruptViaEscape();
	assert.equal(cancelCount(), 1);
	assert.equal(app.chat.children.length, 1);
}

{
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "codex-session";
	client.pending = new Map();
	client.bufferingSessionUpdates = false;
	client.onEvent = (event) => events.push(event);
	client.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "codex-session",
			update: {
				sessionUpdate: "usage_update",
				inputTokens: 1,
			},
		},
	}));
	assert.deepEqual(events, [{ type: "backend_activity" }]);
}

{
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "codex-session";
	client.pending = new Map();
	client.bufferingSessionUpdates = false;
	client.onEvent = (event) => events.push(event);
	client.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "stale-session",
			update: {
				sessionUpdate: "usage_update",
				inputTokens: 1,
			},
		},
	}));
	assert.deepEqual(events, []);
}

{
	const events = [];
	const writes = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "codex-session";
	client.pending = new Map();
	client.bufferingSessionUpdates = false;
	client.onEvent = (event) => events.push(event);
	client.writeSafe = (message) => writes.push(message);
	client.handleLine(JSON.stringify({
		jsonrpc: "2.0",
		id: 10,
		method: "unknown/request",
		params: {},
	}));
	assert.deepEqual(events, [{ type: "backend_activity" }]);
	assert.equal(writes[0].id, 10);
	assert.equal(writes[0].error.code, -32601);
}

{
	let invalidated = false;
	const app = Object.create(HarnessApp.prototype);
	app.ui = { terminal: { rows: 4 } };
	app.currentAssistantText = {
		invalidate: () => {
			invalidated = true;
		},
	};
	app.closeCurrentAssistantText();
	assert.equal(invalidated, true);
	assert.equal(app.currentAssistantText, undefined);
}

const applied = applyHarnessSettings(config, {
	agents: {
		claude: {
			settings: {
				model: "sonnet",
				permissions: { defaultMode: "bypassPermissions" },
			},
		},
		codex: {
			config: {
				model: "gpt-5",
				approval_policy: "never",
				sandbox_mode: "danger-full-access",
			},
		},
		cursor: {
			args: ["--model", "gpt-5", "--force", "--sandbox", "disabled", "--approve-mcps"],
		},
		"terminus-2": {
			args: ["--model", "openai/gpt-5", "--max-episodes", "2"],
		},
		"mini-swe-agent": {
			args: ["--model", "openai/gpt-5", "--no-yolo"],
		},
	},
});

assert.equal(applied.agents.claude._startupMode, "bypassPermissions");
assert.equal(applied.theme, "system");
assert.equal(applied.settings.theme, "system");
assert.equal(applied.agents.claude._autoPermissionRequests, true);
assert.deepEqual(applied.agents.claude._sessionMeta, {
	claudeCode: {
		options: {
			settings: {
				model: "sonnet",
				permissions: { defaultMode: "bypassPermissions" },
			},
		},
	},
});

assert.deepEqual(applied.agents.codex.acp.args, [
	"-c",
	"model=\"gpt-5\"",
	"-c",
	"approval_policy=\"never\"",
	"-c",
	"sandbox_mode=\"danger-full-access\"",
]);
assert.equal(applied.agents.codex._autoPermissionRequests, true);

assert.deepEqual(applied.agents.cursor.acp.args, [
	"--model",
	"gpt-5",
	"--force",
	"--sandbox",
	"disabled",
	"--approve-mcps",
	"acp",
]);
assert.equal(applied.agents.cursor._autoPermissionRequests, true);
assert.deepEqual(config.agents.cursor.acp.args, ["acp"]);
assert.deepEqual(applied.agents["terminus-2"].acp.args, [
	"src/harnesses/terminus_2/bridge.py",
	"--model",
	"openai/gpt-5",
	"--max-episodes",
	"2",
]);
assert.deepEqual(applied.agents["mini-swe-agent"].acp.args, [
	"src/harnesses/mini_swe_agent/bridge.py",
	"--model",
	"openai/gpt-5",
	"--no-yolo",
]);

// Back-compat: native settings now also resolve a unified _permissionMode.
assert.equal(applied.agents.claude._permissionMode, "auto");
assert.equal(applied.agents.codex._permissionMode, "auto");
assert.equal(applied.agents.cursor._permissionMode, "auto");
assert.equal(applied.agents["terminus-2"]._permissionMode, undefined);

// Unified, harness-agnostic permission mode: a single global `permissions.mode`
// generates each backend's native dialect (the inversion of fragile inference).
const unified = applyHarnessSettings(config, { permissions: { mode: "auto" } });
assert.equal(unified.agents.claude._permissionMode, "auto");
assert.equal(unified.agents.claude._autoPermissionRequests, true);
assert.equal(unified.agents.claude._startupMode, "bypassPermissions");
assert.deepEqual(unified.agents.claude._sessionMeta, {
	claudeCode: { options: { settings: { permissions: { defaultMode: "bypassPermissions" } } } },
});
assert.equal(unified.agents.codex._autoPermissionRequests, true);
assert.deepEqual(unified.agents.codex.acp.args, [
	"-c",
	"approval_policy=\"never\"",
	"-c",
	"sandbox_mode=\"danger-full-access\"",
]);
assert.equal(unified.agents.cursor._autoPermissionRequests, true);
assert.deepEqual(unified.agents.cursor.acp.args, ["--force", "acp"]);
// Generic harnesses with no native knob still auto-approve cc-side.
assert.equal(unified.agents["terminus-2"]._permissionMode, "auto");
assert.equal(unified.agents["terminus-2"]._autoPermissionRequests, true);

// Per-agent mode overrides the global default.
const mixed = applyHarnessSettings(config, {
	permissions: { mode: "auto" },
	agents: { codex: { permissions: { mode: "ask" } } },
});
assert.equal(mixed.agents.codex._permissionMode, "ask");
assert.equal(mixed.agents.codex._autoPermissionRequests, undefined);
assert.equal(mixed.agents.claude._autoPermissionRequests, true);

const previousDefaultCcConfig = process.env.CC_CONFIG;
const previousDefaultCcSettings = process.env.CC_SETTINGS;
process.env.CC_CONFIG = path.join(os.tmpdir(), `cc-missing-config-${process.pid}.json`);
process.env.CC_SETTINGS = path.join(os.tmpdir(), `cc-missing-settings-${process.pid}.json`);
const defaultConfig = loadConfig();
if (previousDefaultCcConfig === undefined) delete process.env.CC_CONFIG;
else process.env.CC_CONFIG = previousDefaultCcConfig;
if (previousDefaultCcSettings === undefined) delete process.env.CC_SETTINGS;
else process.env.CC_SETTINGS = previousDefaultCcSettings;
assert.ok(defaultConfig.agents["terminus-2"]);
assert.ok(defaultConfig.agents["mini-swe-agent"]);
assert.match(defaultConfig.agents["terminus-2"].acp.args[0], /terminus_2\/bridge\.py$/);
assert.match(defaultConfig.agents["mini-swe-agent"].acp.args[0], /mini_swe_agent\/bridge\.py$/);

assert.ok(themeNames().includes("tokyonight"));
assert.ok(themeNames().includes("matrix"));
assert.ok(themeNames().includes("cursor-dark"));
assert.ok(themeNames().includes("cursor-midnight"));
assert.ok(themeNames().includes("vscode-dark-modern"));
assert.ok(themeNames().includes("vscode-dark-2026"));
assert.equal(resolveThemeName("Tokyo Night"), "tokyonight");
assert.equal(resolveThemeName("onedark"), "one-dark");
assert.equal(resolveThemeName("catppuccin_macchiato"), "catppuccin-macchiato");
assert.equal(resolveThemeName("cursor"), "cursor-dark");
assert.equal(resolveThemeName("Cursor Dark Midnight"), "cursor-midnight");
assert.equal(resolveThemeName("Cursor Dark High Contrast"), "cursor-high-contrast");
assert.equal(resolveThemeName("VS Code Dark Modern"), "vscode-dark-modern");
assert.equal(resolveThemeName("VS Code Dark+"), "vscode-dark-plus");
assert.equal(resolveThemeName("dark plus"), "vscode-dark-plus");
assert.equal(resolveThemeName("Light 2026"), "vscode-light-2026");
assert.equal(resolveThemeName("missing-theme"), undefined);
assert.equal(applyHarnessSettings(config, { agents: {}, theme: "matrix" }).theme, "matrix");
assert.equal(applyHarnessSettings(config, { agents: {}, theme: "not-real" }).theme, "system");

const previousCcSettings = process.env.CC_SETTINGS;
const previousCcConfig = process.env.CC_CONFIG;
const tempSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-theme-settings-"));
try {
	const settingsFile = path.join(tempSettingsDir, "settings.json");
	fs.writeFileSync(
		settingsFile,
		`${JSON.stringify({ agents: { codex: { config: { model: "gpt-4.1" } } } }, null, 2)}\n`,
	);
	process.env.CC_SETTINGS = settingsFile;
	process.env.CC_CONFIG = path.join(process.cwd(), "tests", "fake_config.json");

	const saved = saveSettingsPatch({ theme: "onedark" });
	assert.equal(saved.theme, "one-dark");
	assert.deepEqual(saved.agents.codex.config, { model: "gpt-4.1" });
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).theme, "one-dark");

	const loaded = loadConfig();
	assert.equal(loaded.theme, "one-dark");
	assert.deepEqual(loaded.settings.agents.codex.config, { model: "gpt-4.1" });

	const configThemeFile = path.join(tempSettingsDir, "config-theme.json");
	const nestedThemeSettingsFile = path.join(tempSettingsDir, "nested-theme-settings.json");
	fs.writeFileSync(
		configThemeFile,
		`${JSON.stringify({ ...config, theme: "matrix" }, null, 2)}\n`,
	);
	fs.writeFileSync(
		nestedThemeSettingsFile,
		`${JSON.stringify({ agents: { codex: { config: { theme: "tokyonight" } } } }, null, 2)}\n`,
	);
	process.env.CC_CONFIG = configThemeFile;
	process.env.CC_SETTINGS = nestedThemeSettingsFile;
	const configThemeLoaded = loadConfig();
	assert.equal(configThemeLoaded.theme, "matrix");
	assert.equal(configThemeLoaded.settings.theme, "matrix");
	assert.equal(configThemeLoaded.settings.agents.codex.config.theme, "tokyonight");

	const configSettingsThemeFile = path.join(tempSettingsDir, "config-settings-theme.json");
	fs.writeFileSync(
		configSettingsThemeFile,
		`${JSON.stringify({ ...config, theme: "matrix", settings: { theme: "tokyonight" } }, null, 2)}\n`,
	);
	process.env.CC_CONFIG = configSettingsThemeFile;
	process.env.CC_SETTINGS = nestedThemeSettingsFile;
	const configSettingsThemeLoaded = loadConfig();
	assert.equal(configSettingsThemeLoaded.theme, "tokyonight");
	assert.equal(configSettingsThemeLoaded.settings.theme, "tokyonight");
} finally {
	if (previousCcSettings === undefined) delete process.env.CC_SETTINGS;
	else process.env.CC_SETTINGS = previousCcSettings;
	if (previousCcConfig === undefined) delete process.env.CC_CONFIG;
	else process.env.CC_CONFIG = previousCcConfig;
	fs.rmSync(tempSettingsDir, { recursive: true, force: true });
}

// A harness picked via /harness is persisted to settings and becomes the
// default on the next load; a stale/unknown key falls back to config.
{
	const prevSettings = process.env.CC_SETTINGS;
	const prevConfig = process.env.CC_CONFIG;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-harness-"));
	try {
		const settingsFile = path.join(dir, "settings.json");
		process.env.CC_SETTINGS = settingsFile;
		process.env.CC_CONFIG = path.join(process.cwd(), "tests", "fake_config.json");

		const saved = saveSettingsPatch({ defaultAgent: "cursor" });
		assert.equal(saved.defaultAgent, "cursor");
		assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).defaultAgent, "cursor");
		assert.equal(loadConfig().defaultAgent, "cursor");

		// A persisted key that no longer maps to an agent falls back to the config default.
		saveSettingsPatch({ defaultAgent: "ghost-harness" });
		assert.equal(loadConfig().defaultAgent, "fake");

		// applyHarnessSettings ignores a key with no matching agent.
		assert.equal(applyHarnessSettings(config, { agents: {}, defaultAgent: "claude" }).defaultAgent, "claude");
		assert.equal(applyHarnessSettings(config, { agents: {}, defaultAgent: "nope" }).defaultAgent, config.defaultAgent);
	} finally {
		if (prevSettings === undefined) delete process.env.CC_SETTINGS;
		else process.env.CC_SETTINGS = prevSettings;
		if (prevConfig === undefined) delete process.env.CC_CONFIG;
		else process.env.CC_CONFIG = prevConfig;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

assert.deepEqual(
	autoPermissionOutcome({
		options: [
			{ kind: "reject_once", name: "Reject", optionId: "reject" },
			{ kind: "allow_once", name: "Allow", optionId: "allow" },
		],
	}),
	{ outcome: "selected", optionId: "allow" },
);

// Auto-accept no longer escalates to the broadest grant: when every allow option
// is "always", it takes the first/narrower one ("auto" mode) rather than hunting
// for the all-bypassing option. (Pre-overhaul this preferred bypassPermissions.)
assert.deepEqual(
	autoPermissionOutcome({
		options: [
			{ kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
			{ kind: "allow_always", name: "Yes, and bypass permissions", optionId: "bypassPermissions" },
			{ kind: "reject_once", name: "No, keep planning", optionId: "plan" },
		],
	}),
	{ outcome: "selected", optionId: "auto" },
);

assert.deepEqual(
	autoPermissionOutcome({
		options: [{ kind: "reject_once", name: "Reject", optionId: "reject" }],
	}),
	{ outcome: "cancelled" },
);

const fullClear = "\x1b[2J\x1b[H\x1b[3J";
assert.equal(rewriteFullScreenClear(`${fullClear}rendered`), "\x1b8\x1b[J\x1b7rendered");
assert.equal(rewriteFullScreenClear(`${fullClear}rendered`, { alternateScreen: true }), "\x1b[2J\x1b[Hrendered");
assert.equal(rewriteFullScreenClear(`${fullClear}rendered`, { fullClearReplacement: "\r\x1b[4A\x1b[J\x1b7" }), "\r\x1b[4A\x1b[J\x1b7rendered");
assert.equal(rewriteFullScreenClear(`before\x1b[3Jafter`), "beforeafter");

{
	let replacement;
	const app = Object.create(HarnessApp.prototype);
	app.ui = {
		previousLines: ["question", "answer"],
		previousHeight: 10,
		previousViewportTop: 0,
		hardwareCursorRow: 1,
		terminal: {
			rows: 10,
			columns: 80,
			useFullClearReplacementOnce(value) {
				replacement = value;
			},
		},
	};
	app.prepareResizeFullClear();
	assert.equal(replacement, "\r\x1b[1A\x1b[J\x1b7");
}

{
	let replacement;
	const app = Object.create(HarnessApp.prototype);
	app.ui = {
		previousLines: Array.from({ length: 14 }, (_, index) => `line ${index}`),
		previousHeight: 10,
		previousViewportTop: 4,
		hardwareCursorRow: 13,
		terminal: {
			rows: 10,
			columns: 80,
			useFullClearReplacementOnce(value) {
				replacement = value;
			},
		},
	};
	app.prepareResizeFullClear();
	assert.equal(replacement, fullClear);
}

{
	let replacement;
	const app = Object.create(HarnessApp.prototype);
	app.ui = {
		previousLines: ["x".repeat(20), "y".repeat(20)],
		previousHeight: 10,
		previousViewportTop: 0,
		hardwareCursorRow: 1,
		terminal: {
			rows: 10,
			columns: 5,
			useFullClearReplacementOnce(value) {
				replacement = value;
			},
		},
	};
	app.prepareResizeFullClear();
	assert.equal(replacement, fullClear);
}
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "old", lines: ["a", "b", "c", "d", "tail"] },
		{ width: 20, text: "older", lines: ["A", "B", "C", "D", "tail", "new"] },
		2,
	),
	["a", "b", "c", "D", "tail", "new"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "old", lines: ["a", "b"] },
		{ width: 30, text: "older", lines: ["A", "B", "new"] },
		2,
	),
	["A", "B", "new"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "# old", lines: ["# old"], renderer: "plain" },
		{ width: 20, text: "# older", lines: ["old", "new"], renderer: "markdown" },
		2,
	),
	["old", "new"],
);
assert.deepEqual(
	stabilizeMutableRenderedLines(
		{ width: 20, lines: ["old running", "old complete", "tail"] },
		{ width: 20, lines: ["new complete", "old complete", "tail", "new tail"] },
		1,
	),
	["old running", "old complete", "tail", "new tail"],
);
assert.equal(
	streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n", 8),
	8,
);
assert.equal(
	streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n", 7, { width: 80, renderer: "plain" }),
	6,
);
assert.equal(
	streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n\n", 8),
	4,
);
assert.equal(
	streamingMutableTail("| A | B |\n|-|-|\n| x | y |", 5, { width: 80, renderer: "plain" }),
	5,
);
assert.equal(
	streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n", 9, {
		width: 80,
		renderer: "markdown",
		previousRenderer: "plain",
		previousText: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |",
		previousRenderedLineCount: 7,
	}),
	9,
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{
			width: 80,
			text: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n",
			lines: ["Intro", "", "┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ x │ y │", "└───┴───┘"],
		},
		{
			width: 80,
			text: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n| longer value | y |\n",
			lines: ["Intro", "", "┌──────────────┬───┐", "│ A            │ B │", "├──────────────┼───┤", "│ x            │ y │", "├──────────────┼───┤", "│ longer value │ y │", "└──────────────┴───┘"],
		},
		streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n| longer value | y |\n", 9, { width: 80, renderer: "plain" }),
	),
	["Intro", "", "┌──────────────┬───┐", "│ A            │ B │", "├──────────────┼───┤", "│ x            │ y │", "├──────────────┼───┤", "│ longer value │ y │", "└──────────────┴───┘"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{
			width: 80,
			text: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |",
			lines: ["Intro", "", "┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ x │ y │", "└───┴───┘"],
		},
		{
			width: 80,
			text: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n| longer value | y |\n\nNext",
			lines: ["Intro", "", "┌──────────────┬───┐", "│ A            │ B │", "├──────────────┼───┤", "│ x            │ y │", "├──────────────┼───┤", "│ longer value │ y │", "└──────────────┴───┘", "", "Next"],
		},
		streamingMutableTail("Intro\n\n| A | B |\n| --- | --- |\n| x | y |\n| longer value | y |\n\nNext", 11, {
			width: 80,
			renderer: "plain",
			previousText: "Intro\n\n| A | B |\n| --- | --- |\n| x | y |",
			previousRenderedLineCount: 7,
		}),
	),
	["Intro", "", "┌──────────────┬───┐", "│ A            │ B │", "├──────────────┼───┤", "│ x            │ y │", "├──────────────┼───┤", "│ longer value │ y │", "└──────────────┴───┘", "", "Next"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{
			width: 80,
			text: "| A | B |\n| --- | --- |\nshort",
			lines: ["┌───────┬───┐", "│ A     │ B │", "├───────┼───┤", "│ short │   │", "└───────┴───┘"],
		},
		{
			width: 80,
			text: "| A | B |\n| --- | --- |\nsubstantially longer value",
			lines: ["┌────────────────────────────┬───┐", "│ A                          │ B │", "├────────────────────────────┼───┤", "│ substantially longer value │   │", "└────────────────────────────┴───┘"],
		},
		streamingMutableTail("| A | B |\n| --- | --- |\nsubstantially longer value", 5, {
			width: 80,
			renderer: "plain",
			previousText: "| A | B |\n| --- | --- |\nshort",
			previousRenderedLineCount: 5,
		}),
	),
	["┌────────────────────────────┬───┐", "│ A                          │ B │", "├────────────────────────────┼───┤", "│ substantially longer value │   │", "└────────────────────────────┴───┘"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{
			width: 80,
			text: "> | A | B |\n> |---|---|\n> | x | y |",
			lines: ["│ ┌───┬───┐", "│ │ A │ B │", "│ ├───┼───┤", "│ │ x │ y │", "│ └───┴───┘"],
		},
		{
			width: 80,
			text: "> | A | B |\n> |---|---|\n> | x | y |\n> | substantially longer value | y |",
			lines: ["│ ┌────────────────────────────┬───┐", "│ │ A                          │ B │", "│ ├────────────────────────────┼───┤", "│ │ x                          │ y │", "│ ├────────────────────────────┼───┤", "│ │ substantially longer value │ y │", "│ └────────────────────────────┴───┘"],
		},
		streamingMutableTail("> | A | B |\n> |---|---|\n> | x | y |\n> | substantially longer value | y |", 7, {
			width: 80,
			renderer: "plain",
			previousText: "> | A | B |\n> |---|---|\n> | x | y |",
			previousRenderedLineCount: 5,
		}),
	),
	["│ ┌────────────────────────────┬───┐", "│ │ A                          │ B │", "│ ├────────────────────────────┼───┤", "│ │ x                          │ y │", "│ ├────────────────────────────┼───┤", "│ │ substantially longer value │ y │", "│ └────────────────────────────┴───┘"],
);
assert.equal(
	streamingMutableTail("- | A | B |\n  |---|---|\n  | x | y |", 5, { width: 80, renderer: "plain" }),
	5,
);
// A ~~~ line inside a ```-opened code fence is content, not a close (CommonMark):
// the open block stays mutable (tail = openSourceLines + 2 = 8), not the default 4.
assert.equal(
	streamingMutableTail("```js\nconst a = 1;\n~~~\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;", 8),
	8,
);
// A matching ``` fence still closes the block, so the (non-table) trailing text
// falls back to the default mutable tail of 4.
assert.equal(
	streamingMutableTail("```js\nconst a = 1;\n```\nplain text after\nmore\nlines\nhere", 9),
	4,
);
// CommonMark: a closing fence must be at least as long as the opener. A 3-backtick
// line inside a 4-backtick-opened block does NOT close it, so the open block stays
// mutable (openSourceLines from line 0 = 7, tail = 7 + 2 = 9), not the default 4.
assert.equal(
	streamingMutableTail("````js\nconst a = 1;\n```\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;", 9),
	9,
);
// A longer (or equal) matching fence does close it: a 4-backtick close ends a
// 4-backtick-opened block, so trailing plain text falls back to the default 4.
assert.equal(
	streamingMutableTail("````js\nconst a = 1;\n````\nplain text after\nmore\nlines\nhere", 9),
	4,
);
// A close-looking line carrying an info string is content, not a close (CommonMark),
// so the block stays mutable rather than freezing early.
assert.equal(
	streamingMutableTail("```\nconst a = 1;\n```js\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;", 8),
	8,
);
assert.equal(hideCursorDuringRender("\x1b[?2026hrendered"), "\x1b[?2026h\x1b[?25lrendered");
assert.equal(hideCursorDuringRender("\x1b[?2026h\x1b[?25lrendered"), "\x1b[?2026h\x1b[?25lrendered");
assert.equal(hideCursorDuringRender("plain cursor move"), "plain cursor move");
assert.equal(isVsCodeTerminal({ TERM_PROGRAM: "vscode" }), true);
assert.equal(isVsCodeTerminal({ VSCODE_PID: "123" }), true);
assert.equal(isVsCodeTerminal({ TERM_PROGRAM: "Apple_Terminal" }), false);
assert.equal(isVsCodeAutoActivationCommand("source /Users/ethanewer/wbl-agent-data/.venv/bin/activate"), true);
assert.equal(isVsCodeAutoActivationCommand('. "/Users/ethanewer/wbl agent data/.venv/bin/activate"'), true);
assert.equal(isVsCodeAutoActivationCommand("conda activate base"), true);
assert.equal(isVsCodeAutoActivationCommand("mamba activate 'project env'"), true);
assert.equal(isVsCodeAutoActivationCommand("micromamba activate"), true);
assert.equal(isVsCodeAutoActivationCommand("pyenv activate agent-env"), true);
assert.equal(isVsCodeAutoActivationCommand("source code analysis"), false);
assert.equal(isVsCodeAutoActivationCommand("source README.md"), false);
assert.equal(isVsCodeAutoActivationCommand("conda activate base is broken"), false);
assert.equal(isVsCodeAutoActivationCommand("source /tmp/.venv/bin/activate\nexplain this"), false);
assert.equal(shouldDropVsCodeAutoActivationInput("source /tmp/.venv/bin/activate", {}, { TERM_PROGRAM: "vscode" }), false);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "vscode" },
	),
	true,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 50, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "vscode" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 250 },
		{ TERM_PROGRAM: "vscode" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "Apple_Terminal" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput("source README.md", { burst: { text: "source README.md", maxGapMs: 1, lastAt: 100 }, now: 110 }, { TERM_PROGRAM: "vscode" }),
	false,
);

assert.deepEqual(
	flattenModes({
		modes: {
			availableModes: [
				{ id: "agent", name: "Agent" },
				{ modeId: "plan", label: "Plan", description: "Draft before editing" },
			],
		},
	}),
	[
		{ id: "agent", name: "Agent", description: undefined },
		{ id: "plan", name: "Plan", description: "Draft before editing" },
	],
);
assert.deepEqual(
	findMode({ modes: { availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] } }, "plan"),
	{ id: "plan", name: "Plan", description: undefined },
);
assert.deepEqual(
	findConfigValue(
		{
			options: [
				{ value: "agent", name: "Agent" },
				{ value: "plan", name: "Plan" },
			],
		},
		"plan",
	),
	{ value: "plan", name: "Plan", description: undefined },
);

async function captureSessionRequests(methodName) {
	const requests = [];
	const client = new AcpClient(
		{
			_sessionMeta: { claudeCode: { options: { settings: { model: "sonnet" } } } },
			_startupMode: "bypassPermissions",
		},
		() => {},
	);
	client.capabilities = methodName === "loadSession" ? { loadSession: true } : {};
	client.request = async (method, params) => {
		requests.push({ method, params });
		return method === "session/set_mode" ? {} : { configOptions: [] };
	};

	await client[methodName]("previous-session");
	return requests;
}

for (const methodName of ["loadSession", "resumeSession"]) {
	const requests = await captureSessionRequests(methodName);
	assert.equal(requests[0].method, methodName === "loadSession" ? "session/load" : "session/resume");
	assert.equal(requests[0].params.sessionId, "previous-session");
	assert.deepEqual(requests[0].params._meta, {
		claudeCode: {
			options: {
				settings: { model: "sonnet" },
			},
		},
	});
	assert.equal(requests[1].method, "session/set_mode");
	assert.equal(requests[1].params.sessionId, "previous-session");
	assert.equal(requests[1].params.modeId, "bypassPermissions");
}

const promptRequests = [];
const imagePromptClient = new AcpClient({ command: "fake" }, () => {});
imagePromptClient.sessionId = "image-session";
imagePromptClient.request = async (method, params) => {
	promptRequests.push({ method, params });
	return {};
};
await imagePromptClient.prompt([
	{ type: "text", text: "describe " },
	{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
]);
assert.deepEqual(promptRequests, [
	{
		method: "session/prompt",
		params: {
			sessionId: "image-session",
			prompt: [
				{ type: "text", text: "describe " },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		},
	},
]);

const earlyEvents = [];
const earlyUpdateClient = new AcpClient({ command: "fake" }, (event) => earlyEvents.push(event));
earlyUpdateClient.sessionId = "current-session";
earlyUpdateClient.capabilities = { loadSession: true };
earlyUpdateClient.request = async (method) => {
	if (method === "session/load") {
		earlyUpdateClient.handleSessionUpdate({
			sessionId: "stale-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "stale history" },
			},
		});
		earlyUpdateClient.handleSessionUpdate({
			sessionId: "previous-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "early history" },
			},
		});
		return { configOptions: [] };
	}
	return {};
};
await earlyUpdateClient.loadSession("previous-session");
assert.deepEqual(
	earlyEvents.filter((event) => event.type === "text").map((event) => event.text),
	["early history"],
);

const newSessionOrder = [];
const earlyNewClient = new AcpClient({ command: "fake" }, (event) => {
	if (event.type === "text") newSessionOrder.push(event.text);
});
earlyNewClient.request = async (method) => {
	if (method === "session/new") {
		earlyNewClient.handleSessionUpdate({
			sessionId: "fresh-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "fresh welcome" },
			},
		});
		return { sessionId: "fresh-session", configOptions: [] };
	}
	return {};
};
await earlyNewClient.newSession({
	beforeReplay: () => {
		newSessionOrder.push("before replay");
	},
});
assert.deepEqual(newSessionOrder, ["before replay", "fresh welcome"]);

// Codex /btw fork helpers: locate the rollout by id and copy it to a new id.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-"));
	const oldId = "11111111-1111-1111-1111-111111111111";
	const newId = "22222222-2222-2222-2222-222222222222";
	const dayDir = path.join(root, "sessions", "2026", "06", "18");
	fs.mkdirSync(dayDir, { recursive: true });
	const rollout = path.join(dayDir, `rollout-2026-06-18T10-00-00-${oldId}.jsonl`);
	fs.writeFileSync(rollout, `{"type":"session_meta","id":"${oldId}"}\n{"type":"item","thread_id":"${oldId}","text":"hi"}\n`);
	// Add an older day to confirm newest-first does not matter for a single match.
	const found = findCodexRolloutPath(oldId, path.join(root, "sessions"));
	assert.equal(found, rollout);
	assert.equal(findCodexRolloutPath("does-not-exist", path.join(root, "sessions")), undefined);
	const copy = copyCodexRolloutWithNewId(found, oldId, newId);
	assert.equal(path.basename(copy), `rollout-2026-06-18T10-00-00-${newId}.jsonl`);
	const copied = fs.readFileSync(copy, "utf8");
	assert.ok(!copied.includes(oldId), "old id must be fully replaced");
	assert.ok(copied.includes(`"id":"${newId}"`), "new id must appear in the header");
	assert.ok(copied.includes(`"thread_id":"${newId}"`), "new id must appear in item records");
	// Original rollout is untouched.
	assert.ok(fs.readFileSync(rollout, "utf8").includes(oldId), "parent rollout must be untouched");
	fs.rmSync(root, { recursive: true, force: true });
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-db-"));
	const missingDb = path.join(root, "state_5.sqlite");
	assert.equal(readCodexThreadState("new-session", missingDb), undefined);
	assert.equal(fs.existsSync(missingDb), false);
	fs.rmSync(root, { recursive: true, force: true });
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-db-"));
	const dbPath = path.join(root, "state_5.sqlite");
	const sqliteAvailable = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
	if (sqliteAvailable.status === 0) {
		const createDb = spawnSync("sqlite3", [
			dbPath,
			[
				"create table threads (",
				"id text, rollout_path text, updated_at text, updated_at_ms integer, has_user_event integer, archived integer,",
				"tokens_used integer, title text, first_user_message text, preview text, model text, reasoning_effort text",
				");",
			].join(" "),
		], { encoding: "utf8" });
		assert.equal(createDb.status, 0, createDb.stderr || createDb.error?.message);
		assert.deepEqual(readCodexThreadState("new-session", dbPath), {
			sessionId: "new-session",
			row: null,
			rollout: null,
		});
		const dayDir = path.join(root, "sessions", "2026", "06", "21");
		fs.mkdirSync(dayDir, { recursive: true });
		const rollout = path.join(dayDir, "rollout-2026-06-21T10-00-00-new-session.jsonl");
		fs.writeFileSync(rollout, "{\"type\":\"item\",\"text\":\"first message\"}\n");
		const state = readCodexThreadState("new-session", dbPath);
		assert.equal(state.sessionId, "new-session");
		assert.equal(state.row, null);
		assert.equal(state.rollout.size, fs.statSync(rollout).size);
	}
	fs.rmSync(root, { recursive: true, force: true });
}

// Fork registry: /btw fork session ids are recorded (deduped, persisted) so the
// resume picker can label them.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-forks-"));
	const prev = process.env.CC_FORKS;
	process.env.CC_FORKS = path.join(dir, "forks.json");
	try {
		assert.equal(loadForkIds().size, 0);
		recordForkId("fork-aaa");
		recordForkId("fork-bbb");
		recordForkId("fork-aaa"); // dedup
		recordForkId(""); // ignored
		recordForkId(undefined); // ignored
		const ids = loadForkIds();
		assert.equal(ids.size, 2);
		assert.ok(ids.has("fork-aaa") && ids.has("fork-bbb"));
		// Persisted across a fresh load.
		assert.ok(loadForkIds().has("fork-bbb"));
	} finally {
		if (prev === undefined) delete process.env.CC_FORKS;
		else process.env.CC_FORKS = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
