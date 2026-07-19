import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as zlib from "node:zlib";
import { setKittyProtocolActive } from "@mariozechner/pi-tui/dist/keys.js";
import { ProcessTerminal } from "@mariozechner/pi-tui/dist/terminal.js";
import {
	AcpClient,
	acquireForkOperationLock,
	agentMentionsFromConfigOptions,
	agentSupportsLogout,
	applyHarnessSettings,
	autoPermissionOutcome,
	buildEmbeddedFilePromptParts,
	BtwThread,
	collectEnvironmentAuthenticationVariables,
	configureCcKeybindings,
	copyCodexRolloutWithNewId,
	createHarnessTerminal,
	effectiveActivityStatus,
	findCodexRolloutPath,
	forgetForkIds,
	loadCodexForkDescendantIds,
	loadForkDescendantIds,
	loadForkIds,
	loadForkParents,
	migrateLegacyForkRegistry,
	mergeEnvironments,
	recordForkId,
	findConfigValue,
	findMode,
	flattenModes,
	HarnessApp,
	hideCursorDuringRender,
	isVsCodeAutoActivationCommand,
	isVsCodeTerminal,
	loadConfig,
	LazyCombinedAutocompleteProvider,
	listLocalCodexSessions,
	linuxExternalUrlLauncherPath,
	localSlashCommands,
	normalizeAdditionalDirectories,
	normalizeMcpServers,
	openExternalUrl,
	readCodexThreadState,
	resolveAcpExecutable,
	resolveAgentAcpExecutable,
	resolveCodexInvocation,
	resolvePackageLocalAcpExecutable,
	resolveThemeName,
	rewriteFullScreenClear,
	runCodexCommand,
	runTerminalAuthentication,
	saveSettingsPatch,
	SelectionPanel,
	shouldDropVsCodeAutoActivationInput,
	singleLineMenuText,
	stabilizeGrowingRenderedLines,
	stabilizeMutableRenderedLines,
	streamingMutableTail,
	themeNames,
	versionAtLeast,
	windowsExplorerPath,
	writeSecretClipboardText,
} from "../src/pi-harness.mjs";

assert.equal(singleLineMenuText("first\nsecond\tthird"), "first second third");
assert.equal(singleLineMenuText("safe\x1b[2J\x1b]0;owned\x07 title"), "safe title");
assert.equal(singleLineMenuText("\x1b[31msession\nidentifier\x1b[0m"), "session identifier");
assert.equal(singleLineMenuText("approve \u202edeny\u2066 choice"), "approve \u202edeny\u2066 choice", "ordinary selection rendering remains unchanged while workflows are disabled");
{
	let nestedOptionReads = 0;
	const emptyGroups = Array.from({ length: 10_000 }, () => Object.defineProperty({}, "options", {
		get() {
			nestedOptionReads += 1;
			return [];
		},
	}));
	emptyGroups.push({ value: "unbounded-tail" });
	assert.deepEqual(agentMentionsFromConfigOptions([{ id: "agent", options: emptyGroups }]), []);
	assert.equal(nestedOptionReads, 256, "empty grouped-option accessors are inspected through a bounded prefix");
}
{
	const keybindings = configureCcKeybindings();
	for (const sequence of [
		"\x1b[13;2u", // Kitty Shift+Return
		"\x1b[13;3u", // Kitty Option/Alt+Return
		"\x1b[57414;3u", // Kitty Option/Alt+numpad Enter
		"\x1b[27;3;13~", // xterm modifyOtherKeys Option/Alt+Return
		"\x1b\r", // legacy Meta/Option+Return
	]) {
		assert.equal(keybindings.matches(sequence, "tui.input.newLine"), true, `expected ${JSON.stringify(sequence)} to insert a newline`);
	}
	assert.equal(keybindings.matches("\r", "tui.input.newLine"), false, "plain Return must not insert a newline");
	assert.equal(keybindings.matches("\r", "tui.input.submit"), true, "plain Return still submits");
	assert.deepEqual(keybindings.getConflicts(), []);
}
{
	// A lone LF is only normalized to CR (Enter) in legacy mode. With the Kitty
	// protocol active, "\n" is a shift+enter text mapping (e.g. Ghostty's
	// `shift+enter=text:\n`) and must reach the TUI unchanged so it inserts a
	// newline instead of submitting the prompt.
	const originalStart = ProcessTerminal.prototype.start;
	const originalStop = ProcessTerminal.prototype.stop;
	const originalWrite = ProcessTerminal.prototype.write;
	let handleInput;
	ProcessTerminal.prototype.start = function (onInput) {
		handleInput = onInput;
	};
	ProcessTerminal.prototype.stop = () => {};
	ProcessTerminal.prototype.write = () => {};
	try {
		const received = [];
		const terminal = createHarnessTerminal();
		terminal.start((data) => received.push(data), () => {});
		setKittyProtocolActive(false);
		handleInput("\n");
		handleInput("pasted\n");
		setKittyProtocolActive(true);
		handleInput("\n");
		terminal.stop();
		assert.deepEqual(received, ["\r", "pasted\n", "\n"]);
	} finally {
		setKittyProtocolActive(false);
		ProcessTerminal.prototype.start = originalStart;
		ProcessTerminal.prototype.stop = originalStop;
		ProcessTerminal.prototype.write = originalWrite;
	}
}
{
	const panel = new SelectionPanel("Resume\nsession", [{ label: "first\nsecond", description: "date\npath" }], () => {});
	const lines = panel.render(80);
	assert.ok(lines.every((line) => !line.includes("\n") && !line.includes("\r")));
	assert.ok(lines.some((line) => line.includes("first second") && line.includes("date path")));
	const narrow = new SelectionPanel("Resume session", [{ label: "x".repeat(1_000), description: "y".repeat(1_000) }], () => {});
	assert.ok(narrow.render(40).every((line) => singleLineMenuText(line).length <= 39));

	const filter = new SelectionPanel("Resume session", [
		{ label: "Needle Session", value: "019f-test-session" },
	], () => {});
	filter.handleInput("\x1b[200~\x1b[31mNeedle\nsession\x1b[0m\x1b[201~");
	assert.equal(filter.query, "Needle session");
	assert.equal(filter.filteredEntries().length, 1);
	filter.handleInput("\x15");
	filter.handleInput("\x1b[200~019f-test-session\x1b[201~");
	assert.equal(filter.query, "019f-test-session");
	assert.equal(filter.filteredEntries().length, 1);
	filter.handleInput("\x15");
	filter.handleInput("Needle\nSession");
	assert.equal(filter.query, "Needle Session");
}

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

function busyPromptHarness(agentName = "@agentclientprotocol/codex-acp") {
	const prompts = [];
	let cancelCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = true;
	app.cancelRequested = false;
	app.sessionSwitchInProgress = false;
	app.activeKey = agentName === "@agentclientprotocol/codex-acp" ? "codex" : "claude";
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

// Canceling a /btw turn settles only that active turn. Messages submitted while
// it was busy are committed FIFO entries and must continue automatically, but a
// closed/replaced side thread must never be revived by a late prompt result.
await (async () => {
	const makeThread = () => {
		const prompts = [];
		let releaseFirst;
		const client = {
			exited: false,
			capabilities: {},
			prompt(prompt) {
				prompts.push(prompt);
				if (prompts.length === 1) {
					return new Promise((resolve) => { releaseFirst = resolve; });
				}
				return Promise.resolve({ stopReason: "end_turn" });
			},
			cancel() {},
		};
		const app = {
			btwThread: undefined,
			ui: { terminal: { rows: 24 } },
			promptForActiveCapabilities: (text) => text,
			onThreadActivity() {},
		};
		const thread = new BtwThread(app, client, "");
		app.btwThread = thread;
		thread.ready = true;
		thread.state = "ready";
		thread.statusState = "";
		return { app, client, thread, prompts, releaseFirst: (result) => releaseFirst(result) };
	};

	const live = makeThread();
	const firstTurn = live.thread.submit("first");
	await Promise.resolve();
	await live.thread.submit("second");
	assert.deepEqual(live.prompts, ["first"]);
	assert.deepEqual(live.thread.queue.map((entry) => entry.text), ["second"]);
	live.thread.interrupt();
	live.releaseFirst({ stopReason: "cancelled" });
	await firstTurn;
	await Promise.resolve();
	assert.deepEqual(live.prompts, ["first", "second"]);
	assert.deepEqual(live.thread.queue, []);
	assert.equal(live.thread.busy, false);

	const replaced = makeThread();
	const replacedFirstTurn = replaced.thread.submit("old first");
	await Promise.resolve();
	await replaced.thread.submit("old second");
	replaced.thread.interrupt();
	replaced.app.btwThread = { replacement: true };
	replaced.releaseFirst({ stopReason: "cancelled" });
	await replacedFirstTurn;
	await Promise.resolve();
	assert.deepEqual(replaced.prompts, ["old first"]);
	assert.deepEqual(replaced.thread.queue.map((entry) => entry.text), ["old second"]);

	const missingClient = makeThread();
	const missingClientFirstTurn = missingClient.thread.submit("missing first");
	await Promise.resolve();
	await missingClient.thread.submit("missing second");
	missingClient.thread.interrupt();
	missingClient.thread.client = undefined;
	missingClient.releaseFirst({ stopReason: "cancelled" });
	await missingClientFirstTurn;
	await Promise.resolve();
	assert.deepEqual(missingClient.prompts, ["missing first"]);
	assert.deepEqual(missingClient.thread.queue.map((entry) => entry.text), ["missing second"]);

	const identityQueued = makeThread();
	const identityFirstTurn = identityQueued.thread.submit("identity first");
	await Promise.resolve();
	await identityQueued.thread.submit("who are you?");
	await identityQueued.thread.submit("after identity");
	identityQueued.releaseFirst({ stopReason: "end_turn" });
	await identityFirstTurn;
	for (let tick = 0; tick < 4; tick += 1) await Promise.resolve();
	assert.deepEqual(
		identityQueued.prompts,
		["identity first", "after identity"],
		"the local identity response does not reach the backend and drains the next queued prompt",
	);
	assert.deepEqual(identityQueued.thread.queue, []);
	assert.deepEqual(identityQueued.thread.pendingUserEchoes, []);
	const identityTranscript = identityQueued.thread.chat.render(200).join("\n");
	assert.equal(identityTranscript.match(/who are you\?/giu)?.length, 1, "the queued identity question is rendered once");
	assert.equal(identityTranscript.match(/I’m cc/gu)?.length, 1, "the local identity response is rendered once");

	const structuredIdentity = makeThread();
	const structuredParts = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
	structuredIdentity.app.promptForActiveCapabilities = (_text, parts) => parts;
	structuredIdentity.client.prompt = async (prompt) => {
		structuredIdentity.prompts.push(prompt);
		return { stopReason: "end_turn" };
	};
	await structuredIdentity.thread.submit("who are you?", structuredParts);
	assert.deepEqual(structuredIdentity.prompts, [structuredParts], "a structured side identity prompt reaches the backend intact");
})();

// A dead side backend no longer owns autocomplete. Keeping its last advertised
// list authoritative made a focused /btw pane show and route stale commands.
{
	let autocompleteUpdates = 0;
	const app = {
		btwThread: undefined,
		focusedThread: "btw",
		ui: { terminal: { rows: 24 } },
		updateAutocomplete() { autocompleteUpdates += 1; },
		onThreadActivity() {},
	};
	const thread = new BtwThread(app, { exited: true }, "");
	app.btwThread = thread;
	thread.availableCommands = [{ name: "stale-side-command" }];
	thread.commandsLoaded = true;
	thread.handleEvent({ type: "backend_exit" });
	assert.deepEqual(thread.availableCommands, []);
	assert.equal(thread.commandsLoaded, false);
	assert.equal(autocompleteUpdates, 1);
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
		agentInfo: { name: "@agentclientprotocol/codex-acp" },
		capabilities: { retractPrompt: true },
		exited: false,
		snapshotRetractionState: () => initialState,
		canRetract: (snapshot) => Boolean(snapshot && JSON.stringify(snapshot) === JSON.stringify(currentState)),
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
	app.sessionStates = new Map([["codex", { agentInfo: { name: "@agentclientprotocol/codex-acp" } }]]);
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

function normalizedToolStatusEvents(statuses, options = {}) {
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "fake-session";
	client.onEvent = (event) => events.push(event);
	client.bufferingSessionUpdates = false;
	for (const status of statuses) {
		const statusFields = options.nestedFields ? { fields: { status } } : { status };
		client.handleSessionUpdate({
			sessionId: "fake-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "tool-1",
				...statusFields,
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

await (async () => {
	let stopped = false;
	let sessionCreated = false;
	const client = Object.create(AcpClient.prototype);
	client.agent = { label: "Codex", _requiredAgentName: "@agentclientprotocol/codex-acp" };
	client.start = () => {};
	client.stop = () => (stopped = true);
	client.newSession = async () => (sessionCreated = true);
	client.request = async () => ({
		agentInfo: { name: "codex-acp", version: "0.16.0" },
		agentCapabilities: {},
		authMethods: [],
	});
	await assert.rejects(
		client.initialize(),
		/Unsupported Codex ACP adapter.*expected @agentclientprotocol\/codex-acp.*Reinstall cc/,
	);
	assert.equal(stopped, true);
	assert.equal(sessionCreated, false, "legacy identity is rejected before session/new or session/set_mode");
})();

assert.equal(versionAtLeast("1.1.2", "1.1.0"), true);
assert.equal(versionAtLeast("1.0.9", "1.1.0"), false);
assert.equal(versionAtLeast("1.1.0-beta.1", "1.1.0"), false);

await (async () => {
	let stopped = false;
	let sessionCreated = false;
	const client = Object.create(AcpClient.prototype);
	client.agent = {
		label: "Codex",
		_requiredAgentName: "@agentclientprotocol/codex-acp",
		_minimumAgentVersion: "1.1.2",
	};
	client.start = () => {};
	client.stop = () => (stopped = true);
	client.newSession = async () => (sessionCreated = true);
	client.request = async () => ({
		agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.1.1" },
		agentCapabilities: {},
		authMethods: [],
	});
	await assert.rejects(client.initialize(), /Codex ACP adapter 1\.1\.1 is too old.*1\.1\.2.*Reinstall cc/);
	assert.equal(stopped, true);
	assert.equal(sessionCreated, false);
})();

await (async () => {
	let stopped = false;
	const client = Object.create(AcpClient.prototype);
	client.agent = {
		label: "Claude Code",
		_requiredAgentName: "@agentclientprotocol/claude-agent-acp",
		_minimumAgentVersion: "0.58.1",
	};
	client.start = () => {};
	client.stop = () => (stopped = true);
	client.newSession = async () => assert.fail("identity must be checked before session/new");
	client.request = async () => ({
		agentInfo: { name: "claude-agent-acp", version: "0.58.1" },
		agentCapabilities: {},
		authMethods: [],
	});
	await assert.rejects(
		client.initialize(),
		/Unsupported Claude Code ACP adapter.*@agentclientprotocol\/claude-agent-acp/,
	);
	assert.equal(stopped, true);
})();

// Native session mutation can wait for the ACP process to release its files.
await (async () => {
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		queueMicrotask(() => {
			child.signalCode = "SIGTERM";
			child.emit("close", null, "SIGTERM");
		});
		return true;
	};
	const client = Object.create(AcpClient.prototype);
	client.child = child;
	client.terminals = new Map();
	client.pending = new Map();
	client.stopping = false;
	client.exited = false;
	await client.stopAndWait(100);
	assert.equal(client.exited, true);
	assert.equal(child.killed, true);
})();

// Windows cannot safely discover descendants after an ACP root has already
// exited: taskkill /T would act on a potentially recycled PID. Exercise that
// platform-specific branch on every host and require a fatal replacement fence
// unless a prior tree-aware shutdown already confirmed the tree gone.
await (async () => {
	const preExitedClient = (processTreeConfirmedGone) => {
		const client = Object.create(AcpClient.prototype);
		client.child = {
			pid: 424242,
			exitCode: 0,
			signalCode: null,
			once() {},
		};
		client.childClosed = true;
		client.childExitObserved = true;
		client.processGroupConfirmedGone = processTreeConfirmedGone;
		client.exitedProcessGroupForceSignalled = false;
		client.terminals = new Map();
		client.pending = new Map();
		client.stopping = false;
		client.exited = true;
		return client;
	};

	await assert.rejects(
		() => preExitedClient(false).stopAndWaitOwned(10, { platform: "win32" }),
		(error) => {
			assert.equal(error.code, "PROCESS_TREE_TERMINATION_FAILED");
			assert.match(error.message, /Windows process tree could not be confirmed stopped/);
			return true;
		},
	);
	await preExitedClient(true).stopAndWaitOwned(10, { platform: "win32" });
})();

// A caller may initiate Windows shutdown with stop() and only wait after the
// root has exited. Preserve taskkill's successful tree result across that gap,
// including whether the graceful /T attempt had to fall back to /T /F.
await (async () => {
	const stoppedClient = () => {
		const child = {
			pid: 424244,
			exitCode: null,
			signalCode: null,
			once() {},
		};
		const client = Object.create(AcpClient.prototype);
		client.child = child;
		client.childClosed = false;
		client.childExitObserved = false;
		client.processGroupConfirmedGone = false;
		client.exitedProcessGroupForceSignalled = false;
		client.terminals = new Map();
		client.pending = new Map();
		client.stopping = false;
		client.exited = false;
		return { child, client };
	};

	const graceful = stoppedClient();
	const gracefulTermination = graceful.client.stop({
		platform: "win32",
		runWindowsTaskkill: (_pid, force) => !force,
	});
	assert.equal(gracefulTermination.treeSignalled, true);
	assert.equal(graceful.client.processGroupConfirmedGone, true);
	assert.equal(graceful.client.exitedProcessGroupForceSignalled, false);
	graceful.child.exitCode = 0;
	graceful.client.childClosed = true;
	graceful.client.childExitObserved = true;
	await graceful.client.stopAndWaitOwned(10, {
		platform: "win32",
		runWindowsTaskkill: () => assert.fail("a pre-exited Windows PID must not be signalled again"),
	});

	const forced = stoppedClient();
	const forcedTermination = forced.client.stop({
		platform: "win32",
		runWindowsTaskkill: (_pid, force) => force,
	});
	assert.equal(forcedTermination.treeSignalled, true);
	assert.equal(forcedTermination.forceSignalled, true);
	assert.equal(forced.client.processGroupConfirmedGone, true);
	assert.equal(forced.client.exitedProcessGroupForceSignalled, true);
	forced.child.exitCode = 1;
	forced.client.childClosed = true;
	forced.client.childExitObserved = true;
	await assert.rejects(
		() => forced.client.stopAndWaitOwned(10, {
			platform: "win32",
			runWindowsTaskkill: () => assert.fail("a pre-exited Windows PID must not be signalled again"),
		}),
		(error) => {
			assert.equal(error.code, "PROCESS_TREE_FORCE_KILLED");
			assert.match(error.message, /force-killed/);
			return true;
		},
	);
})();

// If graceful taskkill /T fails but the immediate /T /F fallback succeeds, the
// tree is confirmed gone but the shutdown was still forced. Surface that fact
// so native session mutations abort instead of touching freshly released files.
await (async () => {
	const child = new EventEmitter();
	child.pid = 424243;
	child.exitCode = null;
	child.signalCode = null;
	const calls = [];
	const client = Object.create(AcpClient.prototype);
	client.child = child;
	client.terminals = new Map();
	client.pending = new Map();
	client.stopping = false;
	client.exited = false;
	await assert.rejects(
		() => client.stopAndWaitOwned(100, {
			platform: "win32",
			runWindowsTaskkill(pid, force) {
				calls.push([pid, force]);
				if (!force) return false;
				setTimeout(() => {
					child.exitCode = 1;
					child.emit("close", 1, null);
				}, 1);
				return true;
			},
		}),
		(error) => {
			assert.equal(error.code, "PROCESS_TREE_FORCE_KILLED");
			assert.match(error.message, /graceful shutdown failed.*force-killed/);
			return true;
		},
	);
	assert.deepEqual(calls, [[424243, false], [424243, true]]);
})();

// A backend that ignores graceful shutdown is force-killed, and stopAndWait
// does not reject until the child has emitted close and is safe to replace.
await (async () => {
	const signals = [];
	let closed = false;
	const child = new EventEmitter();
	child.exitCode = null;
	child.signalCode = null;
	child.kill = (signal) => {
		signals.push(signal);
		if (signal === "SIGKILL") {
			setTimeout(() => {
				closed = true;
				child.signalCode = "SIGKILL";
				child.emit("close", null, "SIGKILL");
			}, 15);
		}
		return true;
	};
	const client = Object.create(AcpClient.prototype);
	client.child = child;
	client.terminals = new Map();
	client.pending = new Map();
	client.stopping = false;
	client.exited = false;
	await assert.rejects(
		() => client.stopAndWait(10),
		(error) => {
			assert.equal(closed, true, "timeout rejection waits for the force-killed child to close");
			assert.match(error.message, /did not exit within 10ms.*process tree was force-killed/);
			return true;
		},
	);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
})();

// A direct ACP child can close promptly while a same-group descendant ignores
// SIGTERM with detached stdio. stopAndWait must treat the process group, rather
// than direct `close`, as the lifecycle boundary and reap it before rejecting.
if (process.platform !== "win32") await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acp-tree-stop-"));
	const parentScript = path.join(root, "parent.mjs");
	const descendantScript = path.join(root, "descendant.mjs");
	const readyFile = path.join(root, "descendant.pid");
	let descendantPid;
	let groupPid;
	try {
		fs.writeFileSync(descendantScript, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.CC_DESCENDANT_READY, String(process.pid));
setInterval(() => {}, 1_000);
`);
		fs.writeFileSync(parentScript, `
import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
  env: { ...process.env, CC_DESCENDANT_READY: ${JSON.stringify(readyFile)} },
});
setInterval(() => {}, 1_000);
`);
		const client = new AcpClient({ command: process.execPath, args: [parentScript] }, () => {});
		client.start();
		groupPid = client.child.pid;
		for (let attempt = 0; attempt < 200 && !fs.existsSync(readyFile); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(fs.existsSync(readyFile), true, "descendant installed its SIGTERM handler");
		descendantPid = Number(fs.readFileSync(readyFile, "utf8"));
		await assert.rejects(
			() => client.stopAndWait(50),
			(error) => {
				assert.match(error.message, /did not exit within 50ms.*process tree was force-killed/);
				assert.throws(
					() => process.kill(-groupPid, 0),
					(candidate) => candidate?.code === "ESRCH",
					"the ACP process group is quiescent before stopAndWait rejects",
				);
				return true;
			},
		);
	} finally {
		if (Number.isInteger(groupPid)) {
			try { process.kill(-groupPid, "SIGKILL"); } catch {}
		}
		if (Number.isInteger(descendantPid)) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// If an adapter root crashes before replacement starts, its exit callback owns
// the last safe opportunity to sweep a still-live detached group. stopAndWait
// must then observe that cleanup without ever re-signalling a numeric PGID after
// absence was confirmed (the kernel may already have recycled it).
if (process.platform !== "win32") await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acp-preclosed-tree-"));
	const parentScript = path.join(root, "parent.mjs");
	const descendantScript = path.join(root, "descendant.mjs");
	const readyFile = path.join(root, "descendant.pid");
	let descendantPid;
	let groupPid;
	try {
		fs.writeFileSync(descendantScript, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.CC_DESCENDANT_READY, String(process.pid));
setInterval(() => {}, 1_000);
`);
		fs.writeFileSync(parentScript, `
import { spawn } from "node:child_process";
import fs from "node:fs";
spawn(process.execPath, [${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
  env: { ...process.env, CC_DESCENDANT_READY: ${JSON.stringify(readyFile)} },
});
const readyPoll = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(readyFile)})) return;
  clearInterval(readyPoll);
  process.exit(0);
}, 5);
`);
		const client = new AcpClient({ command: process.execPath, args: [parentScript] }, () => {});
		client.start();
		groupPid = client.child.pid;
		for (let attempt = 0; attempt < 400 && (!fs.existsSync(readyFile) || !client.childClosed); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(client.childClosed, true, "adapter root exited before replacement requested shutdown");
		assert.equal(fs.existsSync(readyFile), true, "descendant announced readiness before the adapter root exited");
		descendantPid = Number(fs.readFileSync(readyFile, "utf8"));
		await assert.rejects(
			() => client.stopAndWait(50),
			(error) => {
				assert.equal(error.code, "PROCESS_TREE_FORCE_KILLED");
				assert.throws(
					() => process.kill(-groupPid, 0),
					(candidate) => candidate?.code === "ESRCH",
					"pre-closed adapter descendants are gone before replacement can continue",
				);
				return true;
			},
		);
		assert.equal(client.processGroupConfirmedGone, true);

		// Once absence is sticky, stopAndWait must not inspect or signal the old PGID.
		// Give the fake the current process' PID: any negative-PID signal would be
		// observable (and destructive), while the confirmed-gone path returns directly.
		const stale = Object.create(AcpClient.prototype);
		stale.child = { pid: process.pid, exitCode: 0, signalCode: null };
		stale.childClosed = true;
		stale.childExitObserved = true;
		stale.processGroupConfirmedGone = true;
		stale.exitedProcessGroupForceSignalled = false;
		stale.terminals = new Map();
		stale.pending = new Map();
		stale.stopping = false;
		stale.exited = true;
		await stale.stopAndWait(10);
	} finally {
		if (Number.isInteger(groupPid)) {
			try { process.kill(-groupPid, "SIGKILL"); } catch {}
		}
		if (Number.isInteger(descendantPid)) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Replacement turns cannot overtake an ordinary /btw retirement. The wait lives
// inside the switch mutex, so even a caller that starts immediately after close
// cannot launch another backend until the side process tree is confirmed gone.
await (async () => {
	let releaseSideStop;
	const sideStop = new Promise((resolve) => { releaseSideStop = resolve; });
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.agentSwitchTail = undefined;
	app.btwShutdownTail = sideStop;
	app.replacementProcessFence = undefined;
	app.reportReplacementProcessFence = () => calls.push("fence");
	app.switchAgentUnlocked = async () => { calls.push("replacement"); };
	const switching = app.switchAgent("codex");
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(calls, [], "replacement launch waits behind the side shutdown fence");
	releaseSideStop();
	await switching;
	assert.deepEqual(calls, ["replacement"]);
})();

// Exit owns a replacement already queued behind another lifecycle wait. The
// queued turn must observe `stopping` after the wait and stopAndExit must await
// its lifecycle tail before returning control to the shell.
await (async () => {
	let releaseTransition;
	const transitionGate = new Promise((resolve) => { releaseTransition = resolve; });
	const events = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		stopping: false,
		agentSwitchTail: undefined,
		btwShutdownTail: transitionGate,
		btwThread: undefined,
		client: undefined,
		replacementProcessFence: undefined,
		spinnerTimer: undefined,
		markdownPreloadTimer: undefined,
		startupConnectTimer: undefined,
		voiceController: undefined,
		workflowManager: undefined,
		workflowBroker: {
			stop() { events.push("workflow:stop"); },
		},
		clearCancelGraceTimer() {},
		cancelPermissionPrompts() {},
		reportReplacementProcessFence() {},
		async switchAgentUnlocked() { events.push("replacement"); },
		ui: { stop() { events.push("ui:stop"); } },
	});
	const switching = app.switchAgent("codex");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const exiting = app.stopAndExit({ exit: (code) => events.push(`exit:${code}`) });
	assert.deepEqual(events, ["ui:stop"]);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(events.includes("exit:0"), false, "in-flight replacement still gates process exit");
	releaseTransition();
	await Promise.all([switching, exiting]);
	assert.deepEqual(events, ["ui:stop", "exit:0"]);
})();

// TUI exit installs both stopAndWait operations before terminal teardown and
// does not invoke process.exit until their bounded tree waiters have settled.
await (async () => {
	const events = [];
	let releaseMain;
	let releaseSide;
	const mainGate = new Promise((resolve) => { releaseMain = resolve; });
	const sideGate = new Promise((resolve) => { releaseSide = resolve; });
	const mainClient = {
		async stopAndWait() {
			events.push("main:start");
			await mainGate;
			events.push("main:end");
		},
	};
	const sideClient = {
		cancel() { events.push("side:cancel"); },
		async stopAndWait() {
			events.push("side:start");
			await sideGate;
			events.push("side:end");
		},
	};
	const sideThread = { client: sideClient, clearCancelGraceTimer() {} };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		spinnerTimer: undefined,
		markdownPreloadTimer: undefined,
		voiceController: undefined,
		btwThread: sideThread,
		btwShutdownTail: undefined,
		btwShutdownClients: new WeakMap(),
		focusedThread: "btw",
		mainView: {},
		client: mainClient,
		ready: true,
		clearCancelGraceTimer() {},
		cancelPermissionPrompts() {},
		clearEditorSideThreadBinding() {},
		cancelInteractiveRequestsForClient() {},
		updateAutocomplete() {},
		updateSpinner() {},
		forceFullRepaint() {},
		recordReplacementProcessFence() { return false; },
		addError(message) { events.push(`error:${message}`); },
		ui: {
			terminal: { exitAlternateScreen() {} },
			requestRender() {},
			stop() { events.push("ui:stop"); },
		},
	});
	const exiting = app.stopAndExit({ exit: (code) => events.push(`exit:${code}`) });
	assert.deepEqual(events, ["side:cancel", "side:start", "main:start", "ui:stop"]);
	releaseSide();
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(events.includes("exit:0"), false, "main tree still gates process exit");
	releaseMain();
	await exiting;
	assert.deepEqual(events.slice(-3), ["side:end", "main:end", "exit:0"]);
})();

// Shutdown owns every rejection and waits for all cleanup before reporting a
// nonzero exit. Pending foreground UI is invalidated before terminal teardown.
await (async () => {
	const events = [];
	let releaseNative;
	const nativeGate = new Promise((resolve) => { releaseNative = resolve; });
	const foreground = { commandName: "resume", cancelled: false };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		stopping: false,
		foregroundOperation: foreground,
		client: {
			async stopAndWait() {
				events.push("main:start");
				const error = new Error("main process tree remains live");
				error.code = "PROCESS_TREE_TERMINATION_FAILED";
				throw error;
			},
		},
		nativeProcessTracker: {
			async stopAndWait() {
				events.push("native:start");
				await nativeGate;
				events.push("native:end");
			},
		},
		btwThread: undefined,
		btwShutdownTail: undefined,
		agentSwitchTail: undefined,
		spinnerTimer: undefined,
		markdownPreloadTimer: undefined,
		startupConnectTimer: undefined,
		voiceController: undefined,
		clearCancelGraceTimer() {},
		cancelPermissionPrompts() {},
		ui: { stop() { events.push("ui:stop"); } },
	});
	const exiting = app.stopAndExit({ exit: (code) => events.push(`exit:${code}`) });
	assert.equal(foreground.cancelled, true);
	assert.equal(app.foregroundOperation, undefined);
	assert.deepEqual(events, ["main:start", "native:start", "ui:stop"]);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events.some((event) => event.startsWith("exit:")), false);
	releaseNative();
	await exiting;
	assert.deepEqual(events.slice(-2), ["native:end", "exit:1"]);
})();

// Losing the controlling terminal can make the renderer's final restoration
// throw during SIGHUP. Shutdown must still reap the backend and return instead
// of leaving an orphaned cc process holding the revoked PTY open.
await (async () => {
	const events = [];
	let releaseMain;
	const mainGate = new Promise((resolve) => { releaseMain = resolve; });
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		client: {
			async stopAndWait() {
				events.push("main:start");
				await mainGate;
				events.push("main:end");
			},
		},
		btwThread: undefined,
		btwShutdownTail: undefined,
		agentSwitchTail: undefined,
		spinnerTimer: undefined,
		markdownPreloadTimer: undefined,
		startupConnectTimer: undefined,
		voiceController: undefined,
		clearCancelGraceTimer() {},
		cancelPermissionPrompts() {},
		ui: {
			stop() {
				events.push("ui:stop");
				throw new Error("controlling terminal is gone");
			},
		},
	});
	const exiting = app.stopAndExit({ exit: (code) => events.push(`exit:${code}`) });
	assert.deepEqual(events, ["main:start", "ui:stop"]);
	releaseMain();
	await exiting;
	assert.deepEqual(events, ["main:start", "ui:stop", "main:end", "exit:1"]);
})();

// SIGHUP means the controlling terminal is already being revoked. Its shutdown
// path skips terminal restoration (which can block inside open(2)) while still
// waiting for backend ownership to settle before exiting.
await (async () => {
	const events = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		client: { async stopAndWait() { events.push("main:stop"); } },
		btwThread: { client: {} },
		btwShutdownTail: undefined,
		agentSwitchTail: undefined,
		spinnerTimer: undefined,
		markdownPreloadTimer: undefined,
		startupConnectTimer: undefined,
		voiceController: undefined,
		clearCancelGraceTimer() {},
		cancelPermissionPrompts(options) {
			events.push(`permissions:cancel:${options.skipUi === true ? "no-ui" : "ui"}`);
		},
		closeBtw(options) {
			events.push(`side:close:${options.skipUi === true ? "no-ui" : "ui"}`);
			this.btwThread = undefined;
			return Promise.resolve();
		},
		ui: { stop() { events.push("ui:stop"); } },
	});
	await app.stopAndExit({ skipUiStop: true, exit: (code) => events.push(`exit:${code}`) });
	assert.deepEqual(events, ["permissions:cancel:no-ui", "side:close:no-ui", "main:stop", "exit:0"]);
})();

// Terminal-loss cancellation resolves every interactive request without asking
// the revoked TUI to close or refocus its modal component.
{
	const outcomes = [];
	const active = {
		kind: "permission",
		resolve: (outcome) => outcomes.push(["active", outcome]),
	};
	const queued = {
		kind: "cursor",
		method: "cursor/ask_question",
		resolve: (outcome) => outcomes.push(["queued", outcome]),
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		permissionQueue: [queued],
		permissionPromptActive: true,
		activeInteractiveRequest: active,
		menuHandle: {},
		menuEditorText: "private input",
		commandPanel: { clear() {} },
		closeMenu: () => assert.fail("terminal-loss cancellation must not call the TUI"),
	});
	app.cancelPermissionPrompts({ skipUi: true });
	assert.deepEqual(outcomes, [
		["queued", { outcome: { outcome: "cancelled" } }],
		["active", { outcome: "cancelled" }],
	]);
	assert.equal(app.permissionPromptActive, false);
	assert.equal(app.activeInteractiveRequest, undefined);
	assert.equal(app.menuHandle, undefined);
	assert.equal(app.menuEditorText, undefined);
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

await (async () => {
	let providerSets = 0;
	let refreshes = 0;
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.config = config;
	app.themeName = "system";
	app.sessionStates = new Map();
	app.availableCommands = new Map();
	app.lastAutocompleteKey = undefined;
	app.editor = {
		autocompleteProvider: undefined,
		setAutocompleteProvider(provider) {
			providerSets += 1;
			this.autocompleteProvider = provider;
		},
		refreshAutocompleteForCurrentInput() {
			refreshes += 1;
		},
	};

	app.updateAutocomplete();
	const provider = app.editor.autocompleteProvider;
	app.availableCommands.set("codex", [{ name: "review", description: "Review changes" }]);
	app.updateAutocomplete();

	assert.equal(providerSets, 1, "command discovery updates the existing provider without closing autocomplete");
	assert.equal(app.editor.autocompleteProvider, provider);
	assert.equal(refreshes, 2, "already-typed slash input is re-evaluated after each command-set change");
	const suggestions = await provider.getSuggestions(["/r"], 0, 2, { force: false, signal: new AbortController().signal });
	assert.ok(suggestions.items.some((item) => item.value === "review"));
})();

function codexConfig(agent) {
	return JSON.parse(agent.env?.CODEX_CONFIG ?? "{}");
}

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

// /btw uses the shared dispatcher with its own live command list: side-only
// backend commands stay reachable, main-only commands are not leaked into the
// fork, non-advertised local commands run on the main path, and Codex's local
// /goal view shortcut retains precedence over the advertised backend command.
await (async () => {
	const submitted = [];
	const localRan = [];
	const sideNotices = [];
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "btw";
	app.activeKey = "codex";
	app.config = config;
	app.sessionStates = new Map([["codex", {}]]);
	app.availableCommands = new Map([["codex", [{ name: "model" }, { name: "goal" }, { name: "main-only" }]]]);
	app.commandsLoaded = new Set(["codex"]);
	app.btwThread = {
		availableCommands: [{ name: "model" }, { name: "goal" }, { name: "side-only" }],
		commandsLoaded: true,
		submit: (text) => submitted.push(text),
		addNotice: (text) => sideNotices.push(text),
	};
	app.editor = { addToHistory() {}, getText: () => "", setText() {} };
	app.consumeImagePromptParts = () => undefined;
	app.runLocalSlashCommand = async (name) => localRan.push(name);
	app.onThreadActivity = () => {};
	app.lastKnownEditorText = "";
	app.btwThread.commandsLoaded = false;
	await app.handleSubmit("/cold-side-only"); // no fork list yet -> preserve cold-start forwarding
	app.btwThread.commandsLoaded = true;
	await app.handleSubmit("/model"); // backend advertises "model" -> fork (not shadowed)
	await app.handleSubmit("/effort"); // local, not advertised -> main path
	await app.handleSubmit("/diff"); // reserved UI command -> always local
	await app.handleSubmit("/goal view"); // Codex wrapper owns its local goal viewer
	await app.handleSubmit("/goal pause"); // other goal operations remain backend-native
	await app.handleSubmit("/side-only"); // authoritative fork command -> fork
	await app.handleSubmit("/main-only"); // absent from authoritative fork list -> reject locally
	assert.deepEqual(submitted, ["/cold-side-only", "/model", "/goal pause", "/side-only"]);
	assert.deepEqual(localRan, ["effort", "diff", "goal"]);
	assert.deepEqual(sideNotices, ["Unknown command: /main-only"]);
})();

// /help describes the focused thread's authoritative backend commands just as
// routing and autocomplete do. Until the fork publishes its list, retain the
// main session's commands as the cold-start fallback.
{
	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "btw";
	app.activeKey = "codex";
	app.config = config;
	app.themeName = "system";
	app.client = { capabilities: {} };
	app.sessionStates = new Map([["codex", {}]]);
	app.availableCommands = new Map([["codex", [{ name: "main-only", description: "Main command" }]]]);
	app.btwThread = {
		availableCommands: [{ name: "side-only", description: "Side command" }],
		commandsLoaded: true,
	};
	app.addNotice = (text) => notices.push(text);

	app.showHelp();
	assert.match(notices.at(-1), /^\/side-only\s+Side command$/m);
	assert.doesNotMatch(notices.at(-1), /^\/main-only\b/m);

	app.btwThread.commandsLoaded = false;
	app.showHelp();
	assert.match(notices.at(-1), /^\/main-only\s+Main command$/m);
	assert.doesNotMatch(notices.at(-1), /^\/side-only\b/m);
}

// Dynamic local completions belong to the focused ACP session. A side fork can
// advertise a different model/config surface from main, so derive `/model` (and
// the other generated config commands) from its live getSessionInfo snapshot.
{
	const modelOption = (value) => ({
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: value,
		options: [{ value, name: value }],
	});
	let sideInfoReads = 0;
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		focusedThread: "btw",
		themeName: "system",
		config,
		client: { capabilities: {}, configOptions: [modelOption("main-client")] },
		sessionStates: new Map([["codex", { capabilities: {}, configOptions: [modelOption("main-state")] }]]),
		btwThread: {
			client: {
				capabilities: {},
				getSessionInfo() {
					sideInfoReads += 1;
					return { capabilities: {}, configOptions: [modelOption("side-model")] };
				},
			},
		},
	});
	const model = localSlashCommands(app).find((command) => command.name === "model");
	assert.equal(sideInfoReads, 1);
	assert.equal(model.argumentHint, "[side-model]");
	assert.deepEqual(model.getArgumentCompletions("").map((entry) => entry.value), ["side-model"]);
}

// A review dialog opened from /btw remains bound to that fork. Its direct preset
// must not await the side model turn, while editable presets must not leave the
// main transcript's pending-display decoration behind.
await (async () => {
	const sideSubmitted = [];
	const mainSubmitted = [];
	const notices = [];
	let selection;
	let editorText = "";
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "btw";
	app.activeKey = "codex";
	app.config = config;
	app.sessionStates = new Map([["codex", {}]]);
	app.availableCommands = new Map([["codex", []]]);
	app.commandsLoaded = new Set(["codex"]);
	const sideThread = {
		client: {
			exited: false,
			capabilities: { commandPresets: ["review"] },
			interceptCommand(name, argument, backendNames) {
				return name === "review" && !argument && backendNames.has("review-branch") && backendNames.has("review-commit")
					? { kind: "preset-dialog" }
					: null;
			},
		},
		availableCommands: [{ name: "review" }, { name: "review-branch" }, { name: "review-commit" }],
		commandsLoaded: true,
		submit(text) {
			sideSubmitted.push(text);
			return {
				then() {
					assert.fail("the review picker must not await an independent /btw turn");
				},
			};
		},
		addNotice() {},
	};
	app.btwThread = sideThread;
	app.editor = {
		addToHistory() {},
		getText: () => editorText,
		setText: (text) => { editorText = text; },
	};
	app.consumeImagePromptParts = () => undefined;
	app.openSelection = (_title, entries, onSelect) => { selection = { entries, onSelect }; };
	app.closeMenu = () => {};
	app.submitBackendPrompt = async (text) => { mainSubmitted.push(text); };
	app.addNotice = (text) => notices.push(text);
	app.ui = { requestRender() {} };
	app.lastKnownEditorText = "";
	app.pendingPromptDisplay = { prefix: "/stale ", label: "Stale" };
	app.editorTargetThread = undefined;

	await app.handleSubmit("/review");
	await selection.onSelect(selection.entries.find((entry) => entry.value === "uncommitted"));
	assert.deepEqual(sideSubmitted, ["/review"]);
	assert.deepEqual(mainSubmitted, []);
	assert.equal(app.pendingPromptDisplay, undefined);

	app.pendingPromptDisplay = { prefix: "/stale ", label: "Stale" };
	await app.handleSubmit("/review");
	await selection.onSelect(selection.entries.find((entry) => entry.value === "branch"));
	assert.equal(editorText, "/review-branch ");
	assert.equal(app.pendingPromptDisplay, undefined);
	assert.equal(app.editorTargetThread, sideThread);
	app.focusedThread = "main";
	await app.handleSubmit("/review-branch base");
	assert.deepEqual(sideSubmitted, ["/review", "/review-branch base"], "editable review remains bound to its originating fork");
	assert.deepEqual(mainSubmitted, []);

	app.focusedThread = "btw";
	await app.handleSubmit("/review");
	app.btwThread = undefined;
	app.focusedThread = "main";
	await selection.onSelect(selection.entries.find((entry) => entry.value === "uncommitted"));
	assert.deepEqual(sideSubmitted, ["/review", "/review-branch base"]);
	assert.deepEqual(mainSubmitted, []);
	assert.deepEqual(notices, ["The /btw thread closed before the review could start."]);

	app.openCodexReviewDialog();
	await selection.onSelect(selection.entries.find((entry) => entry.value === "uncommitted"));
	assert.deepEqual(mainSubmitted, ["/review"]);
})();

// Closing the exact /btw thread that owns a staged editable command clears that
// draft instead of allowing a later Enter to submit it on the main session.
{
	let editorText = "/review-commit deadbeef";
	const thread = { client: {}, clearCancelGraceTimer() {} };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		btwThread: thread,
		focusedThread: "btw",
		editorTargetThread: thread,
		pendingPromptDisplay: undefined,
		clipboardImages: [],
		lastKnownEditorText: editorText,
		editor: {
			getText: () => editorText,
			setText: (text) => { editorText = text; },
		},
		mainView: { stick: false },
		updateAutocomplete() {},
		cancelInteractiveRequestsForClient() {},
		updateSpinner() {},
		forceFullRepaint() {},
		ui: { terminal: { exitAlternateScreen() {} } },
	});
	app.closeBtw({ stop: false });
	assert.equal(editorText, "");
	assert.equal(app.editorTargetThread, undefined);
	assert.equal(app.btwThread, undefined);
}

// Codex-only archive helpers are absent on other agents and therefore cannot
// shadow an identically named command advertised by that backend, on main or /btw.
await (async () => {
	const nonCodex = {
		activeKey: "claude",
		client: { capabilities: {} },
		config,
		sessionStates: new Map([["claude", {}]]),
		themeName: "system",
		isCodexBackendActive: () => false,
	};
	const nonCodexNames = localSlashCommands(nonCodex).map((command) => command.name);
	assert.equal(nonCodexNames.includes("archive"), false);
	assert.equal(nonCodexNames.includes("unarchive"), false);

	const codex = { ...nonCodex, activeKey: "codex", isCodexBackendActive: () => true };
	const codexNames = localSlashCommands(codex).map((command) => command.name);
	assert.equal(codexNames.includes("archive"), true);
	assert.equal(codexNames.includes("unarchive"), true);

	const submitted = [];
	const localRan = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, nonCodex, {
		focusedThread: "btw",
		availableCommands: new Map([["claude", [{ name: "archive" }, { name: "unarchive" }]]]),
		commandsLoaded: new Set(["claude"]),
		btwThread: { submit: (text) => submitted.push(text) },
		editor: { addToHistory() {}, getText: () => "", setText() {} },
		consumeImagePromptParts: () => undefined,
		runLocalSlashCommand: async (name) => localRan.push(name),
		lastKnownEditorText: "",
	});
	assert.equal(await app.handleSlashCommand("/archive"), "backend");
	await app.handleSubmit("/archive");
	await app.handleSubmit("/unarchive named");
	assert.deepEqual(submitted, ["/archive", "/unarchive named"]);
	assert.deepEqual(localRan, []);
})();

// Live non-Codex commands win over cc's same-named fallbacks. Keep bare
// /config as the unified ACP option picker, but forward Claude's native
// key=value form. Codex retains its existing local integrations.
{
	const advertisedNames = ["config", "fast", "init", "doctor", "feedback", "usage"];
	const routeApp = (activeKey, isCodex) => {
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey,
			client: { capabilities: {} },
			config,
			sessionStates: new Map([[activeKey, {}]]),
			themeName: "system",
			availableCommands: new Map([[activeKey, advertisedNames.map((name) => ({ name }))]]),
			commandsLoaded: new Set([activeKey]),
			sessionSwitchInProgress: false,
			isCodexBackendActive: () => isCodex,
		});
		return app;
	};

	const claude = routeApp("claude", false);
	assert.equal(claude.slashCommandRoute("init"), "backend");
	assert.equal(claude.slashCommandRoute("fast"), "backend");
	assert.equal(claude.slashCommandRoute("config", "theme=dark"), "backend");
	assert.equal(claude.slashCommandRoute("config", "--help"), "backend");
	assert.equal(claude.slashCommandRoute("config"), "local");
	assert.equal(claude.slashCommandRoute("config", "mode plan"), "local");
	assert.equal(claude.slashCommandRoute("doctor"), "backend");
	assert.equal(claude.slashCommandRoute("feedback"), "backend");
	assert.equal(claude.slashCommandRoute("usage"), "backend");

	claude.availableCommands.set("claude", []);
	assert.equal(claude.slashCommandRoute("init"), "local");
	assert.equal(claude.slashCommandRoute("fast"), "local");
	assert.equal(claude.slashCommandRoute("config", "theme=dark"), "local");

	const codex = routeApp("codex", true);
	assert.equal(codex.slashCommandRoute("init"), "local");
	assert.equal(codex.slashCommandRoute("fast"), "local");
	assert.equal(codex.slashCommandRoute("config", "theme=dark"), "local");
}

// A local command (/model, /effort, …) deferred while a /resume load is in
// flight must be flushed when the switch completes, not left stuck in the queue.
await (async () => {
	const ran = [];
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.client = {
		sessionId: "old-session",
		capabilities: { loadSession: true },
		loadSession: async (_sessionId, options) => options.beforeReplay(),
	};
	app.busy = false;
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

// A drain must leave a blocked FIFO untouched. Removing its head and asking the
// normal dispatcher to run it would just append the same command again while a
// config RPC is pending, creating a tight rotation that starves that RPC.
await (async () => {
	const queued = [
		{ name: "model", argument: "gpt-next" },
		{ name: "effort", argument: "high" },
		{ name: "fast", argument: "on" },
	];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		busy: false,
		sessionSwitchInProgress: false,
		menuHandle: undefined,
		asyncPickerLoadCount: 0,
		configUpdateCount: 1,
		deferredLocalSlashCommands: queued.map((entry) => ({ ...entry })),
		updateSpinner() {},
		ui: { requestRender() {} },
	});
	let attempts = 0;
	app.runLocalSlashCommand = async (name, argument) => {
		attempts += 1;
		assert.ok(attempts <= queued.length, "blocked commands must not rotate forever");
		app.deferLocalSlashCommand(name, argument);
	};
	await app.flushDeferredLocalSlashCommands();
	assert.equal(attempts, 0);
	assert.deepEqual(app.deferredLocalSlashCommands, queued);
	assert.equal(app.flushingDeferredLocalSlashCommands, false);

	const ran = [];
	app.configUpdateCount = 0;
	app.runLocalSlashCommand = async (name, argument) => ran.push({ name, argument });
	await app.flushDeferredLocalSlashCommands();
	assert.deepEqual(ran, queued);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
})();

// Config and picker finalizers reached from inside a drain must not start a
// second consumer. The outer owner applies every command once in FIFO order.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		busy: false,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		menuHandle: undefined,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		deferredLocalSlashCommands: [
			{ name: "model", argument: "gpt-next" },
			{ name: "effort", argument: "high" },
			{ name: "fast", argument: "on" },
		],
		updateSpinner() {},
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
	});
	const drain = HarnessApp.prototype.flushDeferredLocalSlashCommands;
	let drainCalls = 0;
	app.flushDeferredLocalSlashCommands = async function (...args) {
		drainCalls += 1;
		// Bound the old reentrant behavior so this regression fails instead of hangs.
		if (drainCalls > 1) return;
		return await drain.apply(this, args);
	};
	const ran = [];
	app.runLocalSlashCommand = async (name, argument) => {
		ran.push({ name, argument });
		if (name === "model") {
			const token = app.beginConfigUpdate();
			app.endConfigUpdate(token);
		} else if (name === "effort") {
			const token = app.beginAsyncPickerLoad();
			app.endAsyncPickerLoad(token);
		}
	};
	await app.flushDeferredLocalSlashCommands();
	await Promise.resolve();
	assert.equal(drainCalls, 1);
	assert.deepEqual(ran, [
		{ name: "model", argument: "gpt-next" },
		{ name: "effort", argument: "high" },
		{ name: "fast", argument: "on" },
	]);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.flushingDeferredLocalSlashCommands, false);
})();

// Closing a non-selection menu schedules the prompt drain before its deferred
// config command starts. If that timer fires while the config drain is awaiting
// the command, completion must schedule a fresh timer instead of stranding the
// queued prompt.
await (async () => {
	let releaseConfig;
	let markConfigStarted;
	const configStarted = new Promise((resolve) => { markConfigStarted = resolve; });
	const configGate = new Promise((resolve) => { releaseConfig = resolve; });
	const order = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		busy: false,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		menuHandle: { cancel() {} },
		menuEditorText: undefined,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		promptQueueDrainScheduled: false,
		promptQueue: [{ text: "queued prompt", timing: "afterTurn" }],
		deferredLocalSlashCommands: [{ name: "model", argument: "gpt-next" }],
		client: { exited: false },
		commandPanel: { clear() {} },
		editor: { setText() {} },
		ui: { setFocus() {}, requestRender() {} },
	});
	app.runLocalSlashCommand = async () => {
		order.push("config-start");
		markConfigStarted();
		await configGate;
		order.push("config-end");
	};
	app.flushPromptQueue = async () => {
		if (app.flushingDeferredLocalSlashCommands) {
			order.push("blocked-prompt-drain");
			return;
		}
		app.promptQueue.shift();
		order.push("prompt");
	};

	app.closeMenu();
	await configStarted;
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.deepEqual(order, ["config-start", "blocked-prompt-drain"]);
	releaseConfig();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.deepEqual(order, ["config-start", "blocked-prompt-drain", "config-end", "prompt"]);
	assert.deepEqual(app.promptQueue, []);
})();

// /resume never overlaps an active session/prompt request.
await (async () => {
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.busy = true;
	app.client = {
		listSessions: async () => assert.fail("busy resume must not list sessions"),
		loadSession: async () => assert.fail("busy resume must not load a session"),
	};
	app.addCommandMessage = (message) => calls.push(["command", message]);
	app.addNotice = (message) => calls.push(["notice", message]);
	await app.openResumeDialog();
	await app.resumeSelectedSession({ sessionId: "other", title: "Other" });
	assert.deepEqual(calls, [
		["command", "/resume"],
		["notice", "A session cannot be resumed while a turn is running"],
		["command", "/resume (Other)"],
		["notice", "A session cannot be resumed while a turn is running"],
	]);
})();

// A late async resume result never replaces a permission modal, and its loader
// gate is released even though the picker is intentionally not opened.
await (async () => {
	let release;
	let pickerOpened = false;
	const notices = [];
	const client = {
		sessionId: "current",
		agentInfo: { name: "fake" },
		capabilities: { sessionList: true },
		listSessions: () => new Promise((resolve) => { release = resolve; }),
	};
	const agent = {};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.activeAgentGeneration = 0;
	app.transport = "acp";
	app.config = { agents: { fake: agent } };
	app.client = client;
	app.ready = true;
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.sessionStates = new Map([["fake", {
		capabilities: { loadSession: true, sessionCapabilities: { list: {} } },
	}]]);
	app.statusState = "";
	app.permissionPromptActive = false;
	app.menuHandle = undefined;
	app.promptQueue = [];
	app.addCommandMessage = () => {};
	app.addNotice = (message) => notices.push(message);
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.openSelection = () => { pickerOpened = true; };
	const loading = app.openResumeDialog();
	await Promise.resolve();
	assert.equal(app.asyncPickerLoadCount, 1);
	app.permissionPromptActive = true;
	app.menuHandle = { permission: true };
	release([{ sessionId: "other", title: "Other" }]);
	await loading;
	assert.equal(pickerOpened, false);
	assert.equal(app.asyncPickerLoadCount, 0);
	assert.ok(notices.some((message) => message.includes("another interaction is active")));
})();

// A caller-owned session transition cannot be redirected to another harness
// while a native delete/archive command is still deciding its final session.
await (async () => {
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = true;
	app.config = { agents: { codex: {}, claude: {} } };
	app.openMenu = () => assert.fail("the harness menu must stay closed during a session transition");
	app.switchAgent = async () => assert.fail("the harness must not switch during a session transition");
	app.addCommandMessage = (message) => calls.push(["command", message]);
	app.addNotice = (message) => calls.push(["notice", message]);
	await app.handleHarnessCommand("/harness");
	await app.handleHarnessCommand("/harness claude");
	assert.deepEqual(calls, [
		["command", "/harness"],
		["notice", "Harness switching is unavailable while a session transition is in progress"],
		["command", "/harness claude"],
		["notice", "Harness switching is unavailable while a session transition is in progress"],
	]);
})();

// User-requested exits cannot tear down cc while a session mutation still owns
// the transition gate (notably while code-only rewind is changing the worktree).
// A repeated exit request shortly after a blocked one force-quits anyway, so a
// hung transition can never make exit permanently unavailable.
await (async () => {
	const calls = [];
	let stops = 0;
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = true;
	app.config = { agents: { codex: {} } };
	app.stop = () => { stops += 1; };
	app.addCommandMessage = (message) => calls.push(["command", message]);
	app.addNotice = (message) => calls.push(["notice", message]);
	app.ui = { requestRender() {} };
	await app.runLocalSlashCommand("exit", "");
	assert.equal(stops, 0, "the first exit request during a transition is blocked");
	assert.deepEqual(calls, [
		["command", "/exit"],
		["notice", "Exit is unavailable while a session transition is in progress"],
	]);
	await app.handleHarnessCommand("/harness exit");
	assert.equal(stops, 1, "a repeated exit request forces the bounded stop");
})();

// Selecting the already-active harness is an explicit replacement, not an
// internal reconnect, and must therefore get a fresh lifecycle generation.
await (async () => {
	let selected;
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = false;
	app.config = { agents: { codex: { label: "Codex" } } };
	app.switchAgent = async (key, transport, options) => { selected = { key, transport, options }; };
	await app.handleHarnessCommand("/harness codex");
	assert.equal(selected.key, "codex");
	assert.equal(selected.transport, "acp");
	assert.equal(selected.options.explicitReplacement, true);
})();

// A failed resume is non-destructive: the old transcript/session remain live,
// and input entered during the attempted switch returns to the composer in order.
await (async () => {
	const errors = [];
	let resetCount = 0;
	let drainCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.statusState = "";
	app.promptQueue = [];
	app.deferredLocalSlashCommands = [];
	app.queuedInputOrder = 0;
	app.pendingPromptDisplay = undefined;
	app.clipboardImages = [];
	app.lastKnownEditorText = "";
	app.editor = {
		text: "existing draft",
		getText() { return this.text; },
		setText(text) { this.text = text; },
	};
	app.client = {
		sessionId: "old-session",
		async loadSession() {
			app.promptQueue.push({
				text: "queued [Image 7]",
				timing: "afterTurn",
				promptParts: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
				queuedInputOrder: app.nextQueuedInputOrder(),
			});
			app.deferredLocalSlashCommands.push({
				name: "model",
				argument: "gpt-test",
				queuedInputOrder: app.nextQueuedInputOrder(),
			});
			throw new Error("session disappeared");
		},
	};
	app.resetConversationView = () => { resetCount += 1; };
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => errors.push(message);
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => { drainCount += 1; };
	app.ui = { requestRender() {} };
	await app.resumeSelectedSession({ sessionId: "missing-session", title: "Missing" });
	assert.equal(app.client.sessionId, "old-session");
	assert.equal(resetCount, 0, "the old transcript must remain visible when load rejects");
	assert.equal(drainCount, 0, "failed-switch input must not drain into the old session");
	assert.equal(app.editor.getText(), "queued [Image 7]\n/model gpt-test\nexisting draft");
	assert.deepEqual(app.clipboardImages, [{ label: "[Image 7]", data: "aW1hZ2U=", mimeType: "image/png" }]);
	assert.deepEqual(app.promptQueue, []);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.sessionSwitchInProgress, false);
	assert.ok(errors.some((message) => message.includes("session disappeared")));
})();

// A resume can commit its target before startup-mode application fails. If the
// backend exits at that point, preserve transition-time commands instead of
// flushing them into the dead target session.
await (async () => {
	const client = {
		sessionId: "old-session",
		exited: false,
		async loadSession(_sessionId, options) {
			this.sessionId = "committed-target";
			await options.beforeReplay();
			this.exited = true;
			throw new Error("startup mode failed after resume");
		},
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		client,
		previousClearedSession: { key: "fake", sessionId: "before-clear" },
		ready: true,
		busy: false,
		btwThread: undefined,
		deferredBtwPrompts: [],
		sessionSwitchInProgress: false,
		promptQueue: [],
		deferredLocalSlashCommands: [
			{ name: "model", argument: "gpt-next", queuedInputOrder: 1 },
			{ name: "effort", argument: "high", queuedInputOrder: 2 },
		],
		pendingPromptDisplay: undefined,
		clipboardImages: [],
		statusState: "",
		lastKnownEditorText: "",
		menuHandle: undefined,
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		},
		resetConversationView() {},
		addCommandMessage() {},
		addError() {},
		updateAutocomplete() {},
		updateSpinner() {},
		runLocalSlashCommand: async () => assert.fail("dead resumed-session config must not flush"),
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
	});
	await app.resumeSelectedSession({ sessionId: "target-session", title: "Target" });
	assert.equal(app.ready, false);
	assert.equal(app.previousClearedSession, undefined, "a committed explicit resume expires the pre-clear shortcut");
	assert.equal(app.sessionSwitchInProgress, false);
	assert.equal(app.editor.getText(), "/model gpt-next\n/effort high");
	assert.deepEqual(app.deferredLocalSlashCommands, []);
})();

// Failed-transition input is restored behind an active modal rather than into
// its filter editor, so closing that modal cannot erase the recovered command.
{
	const app = Object.create(HarnessApp.prototype);
	app.menuHandle = { activeModal: true };
	app.menuEditorText = "underlying draft";
	app.editor = {
		text: "modal filter",
		getText() { return this.text; },
		setText(text) { this.text = text; },
	};
	app.clipboardImages = [];
	app.restoreQueuedTextToComposer([{ text: "/model gpt-next" }]);
	assert.equal(app.menuEditorText, "/model gpt-next\nunderlying draft");
	assert.equal(app.editor.getText(), "modal filter");
}

// Input entered while session/new is pending is restored, not silently erased,
// if creation fails before the new session commits.
await (async () => {
	let resetCount = 0;
	let drainCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = false;
	app.btwThread = undefined;
	app.sessionSwitchInProgress = false;
	app.promptQueue = [{ text: "discarded before /new", timing: "afterTurn" }];
	app.deferredLocalSlashCommands = [];
	app.queuedInputOrder = 0;
	app.pendingPromptDisplay = undefined;
	app.clipboardImages = [];
	app.statusState = "";
	app.lastKnownEditorText = "";
	app.editor = {
		text: "",
		getText() { return this.text; },
		setText(text) { this.text = text; },
	};
	app.client = {
		sessionId: "old-session",
		async newSession() {
			app.promptQueue.push({
				text: "new-session question [Image 8]",
				timing: "afterTurn",
				promptParts: [{ type: "image", data: "bmV3", mimeType: "image/png" }],
				queuedInputOrder: app.nextQueuedInputOrder(),
			});
			app.deferredLocalSlashCommands.push({
				name: "effort",
				argument: "high",
				queuedInputOrder: app.nextQueuedInputOrder(),
			});
			throw new Error("new session failed");
		},
	};
	app.resetConversationView = () => { resetCount += 1; };
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = () => {};
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => { drainCount += 1; };
	app.ui = { requestRender() {} };
	await app.startNewSession();
	assert.equal(resetCount, 0);
	assert.equal(drainCount, 0);
	assert.equal(app.client.sessionId, "old-session");
	assert.equal(app.editor.getText(), "new-session question [Image 8]\n/effort high");
	assert.deepEqual(app.clipboardImages, [{ label: "[Image 8]", data: "bmV3", mimeType: "image/png" }]);
	assert.deepEqual(app.promptQueue, []);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.sessionSwitchInProgress, false);
})();

// A second /new cannot replace a connection/session transition already in
// flight, even while that transition is not ready yet.
await (async () => {
	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = true;
	app.ready = false;
	app.client = { exited: false };
	app.btwThread = undefined;
	app.ensureConnected = async () => assert.fail("a second /new must not replace the in-flight connection");
	app.addNotice = (message) => notices.push(message);
	app.ui = { requestRender() {} };
	await app.startNewSession();
	assert.deepEqual(notices, ["Already starting a new session"]);
})();

// When /new also has to establish the backend connection, input typed while
// initialization is pending belongs to the fresh session and must survive the
// post-connect view reset. Input already queued before /new is intentionally
// discarded.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	app.ready = false;
	app.busy = false;
	app.client = undefined;
	app.btwThread = undefined;
	app.sessionSwitchInProgress = false;
	app.promptQueue = [{ text: "stale before /new", timing: "afterTurn" }];
	app.deferredLocalSlashCommands = [];
	app.queuedInputOrder = 0;
	app.pendingPromptDisplay = undefined;
	app.clipboardImages = [];
	app.statusState = "";
	app.lastKnownEditorText = "";
	app.editor = {
		text: "",
		getText() { return this.text; },
		setText(text) { this.text = text; },
	};
	let resetCount = 0;
	let drainCount = 0;
	app.ensureConnected = async (connectOptions) => {
		assert.equal(app.sessionSwitchInProgress, true);
		assert.deepEqual(connectOptions, {
			statusState: "starting new session",
			continueSessionSwitch: true,
		});
		app.promptQueue.push({
			text: "must survive reconnect",
			timing: "afterTurn",
			queuedInputOrder: app.nextQueuedInputOrder(),
		});
		app.deferredLocalSlashCommands.push({
			name: "model",
			argument: "gpt-test",
			queuedInputOrder: app.nextQueuedInputOrder(),
		});
		app.client = { sessionId: "fresh-session" };
		app.ready = true;
		return true;
	};
	app.resetConversationView = () => { resetCount += 1; };
	app.addCommandMessage = () => {};
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.runLocalSlashCommand = async (name, argument) => {
		assert.deepEqual({ name, argument }, { name: "model", argument: "gpt-test" });
	};
	app.schedulePromptQueueDrain = () => { drainCount += 1; };
	app.ui = { requestRender() {} };
	await app.startNewSession();
	assert.equal(resetCount, 1);
	assert.equal(drainCount, 2, "the deferred-command owner and transition both wake the coalescing prompt scheduler");
	assert.deepEqual(app.promptQueue.map((entry) => entry.text), ["must survive reconnect"]);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.sessionSwitchInProgress, false);
})();

// The after-turn half of a busy `/new` must retain messages entered after the
// command while cancellation was settling; the first half already discarded
// the queue that existed before `/new`.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = false;
	app.btwThread = undefined;
	app.sessionSwitchInProgress = false;
	app.promptQueue = [{
		text: "typed while canceling",
		timing: "afterTurn",
		queuedInputOrder: 1,
	}];
	app.deferredLocalSlashCommands = [];
	app.pendingPromptDisplay = undefined;
	app.statusState = "";
	app.client = {
		sessionId: "old-session",
		async newSession(options) {
			await options.beforeReplay();
			this.sessionId = "new-session";
		},
	};
	let drainCount = 0;
	app.resetConversationView = () => {};
	app.addCommandMessage = () => {};
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => { drainCount += 1; };
	app.ui = { requestRender() {} };
	await app.startNewSession("new", { afterTurn: true });
	assert.deepEqual(app.promptQueue.map((entry) => entry.text), ["typed while canceling"]);
	assert.equal(drainCount, 2, "an empty deferred-command pass still safely wakes the coalescing scheduler");
	assert.equal(app.sessionSwitchInProgress, false);
})();

// If the backend exits while a busy /new is canceling, a failed reconnect must
// return everything typed after /new to the composer instead of dropping it.
await (async () => {
	let reconnects = 0;
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		ready: true,
		busy: false,
		client: { exited: true },
		btwThread: undefined,
		sessionSwitchInProgress: true,
		promptQueue: [{ text: "typed while canceling", timing: "afterTurn", queuedInputOrder: 1 }],
		deferredLocalSlashCommands: [{ name: "model", argument: "gpt-next", queuedInputOrder: 2 }],
		pendingPromptDisplay: undefined,
		clipboardImages: [],
		statusState: "",
		lastKnownEditorText: "",
		menuHandle: undefined,
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		},
		ensureConnected: async () => {
			reconnects += 1;
			return false;
		},
		updateSpinner() {},
		ui: { requestRender() {} },
	});
	await app.startNewSession("new", { afterTurn: true });
	assert.equal(app.editor.getText(), "typed while canceling\n/model gpt-next");
	assert.deepEqual(app.promptQueue, []);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.equal(app.sessionSwitchInProgress, false);
	assert.equal(reconnects, 1);
})();

// A session/new response can commit before startup-mode application fails. If
// the backend also exits, do not flush deferred config into the dead client;
// restore every post-/new input for a safe reconnect/resubmit.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	const client = {
		sessionId: "old-session",
		exited: false,
		async newSession(options) {
			this.sessionId = "committed-new-session";
			await options.beforeReplay();
			this.exited = true;
			throw new Error("startup mode failed after commit");
		},
	};
	Object.assign(app, {
		ready: true,
		busy: false,
		client,
		btwThread: undefined,
		sessionSwitchInProgress: false,
		promptQueue: [{ text: "question for new session", timing: "afterTurn", queuedInputOrder: 1 }],
		deferredLocalSlashCommands: [
			{ name: "model", argument: "gpt-next", queuedInputOrder: 2 },
			{ name: "effort", argument: "high", queuedInputOrder: 3 },
		],
		pendingPromptDisplay: undefined,
		clipboardImages: [],
		statusState: "",
		lastKnownEditorText: "",
		menuHandle: undefined,
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		},
		resetConversationView() {},
		addCommandMessage() {},
		addError() {},
		updateAutocomplete() {},
		updateSpinner() {},
		runLocalSlashCommand: async () => assert.fail("dead-session config must not flush"),
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
	});
	await app.startNewSession("new", { afterTurn: true });
	assert.equal(app.ready, false);
	assert.equal(app.sessionSwitchInProgress, false);
	assert.equal(
		app.editor.getText(),
		"question for new session\n/model gpt-next\n/effort high",
	);
	assert.deepEqual(app.promptQueue, []);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
})();

// Busy /new owns the cancellation window, so config entered before the old turn
// settles is deferred and applied to the fresh session.
await (async () => {
	const applied = [];
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = true;
	app.sessionSwitchInProgress = false;
	app.promptQueue = [{ text: "before new", timing: "afterTurn" }];
	app.deferredLocalSlashCommands = [];
	app.pendingPromptDisplay = undefined;
	app.statusState = "working";
	app.cancelRequested = false;
	app.afterToolCancelPending = false;
	app.activeToolIds = new Set();
	app.client = {
		sessionId: "old-session",
		cancel() { app.cancelRequested = true; },
		async newSession(options) {
			this.sessionId = "new-session";
			await options.beforeReplay();
		},
	};
	app.btwThread = undefined;
	app.openConfigDialog = async (...args) => applied.push(args);
	app.resetConversationView = () => {};
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => assert.fail(message);
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.ui = { requestRender() {} };
	void app.startNewSession("new");
	await Promise.resolve();
	assert.equal(app.sessionSwitchInProgress, true);
	await app.runLocalSlashCommand("model", "gpt-next");
	assert.deepEqual(app.deferredLocalSlashCommands.map(({ name, argument }) => ({ name, argument })), [
		{ name: "model", argument: "gpt-next" },
	]);
	app.busy = false;
	await app.startNewSession("new", { afterTurn: true });
	assert.equal(app.client.sessionId, "new-session");
	assert.equal(app.sessionSwitchInProgress, false);
	assert.deepEqual(applied, [["model", "Model", "gpt-next", "model", { targetThread: undefined }]]);
})();

// /btw snapshots a rollout, so it must wait for the active main turn to settle.
// Its prompt-bearing form reserves staged images before that wait and forwards
// the structured parts to the fork instead of orphaning the attachment.
await (async () => {
	const forwarded = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		busy: true,
		sessionSwitchInProgress: false,
		deferredLocalSlashCommands: [],
		flushingDeferredLocalSlashCommands: false,
		queuedInputOrder: 0,
		clipboardImages: [{ label: "[Image 4]", data: "aW1hZ2U0", mimeType: "image/png" }],
		menuHandle: undefined,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		promptQueue: [],
		addNotice() {},
		updateSpinner() {},
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
		async runBtw(question, options) { forwarded.push({ question, promptParts: options.promptParts }); },
	});
	await app.runLocalSlashCommand("btw", "inspect [Image 4]");
	assert.equal(app.clipboardImages.length, 0);
	assert.equal(app.deferredLocalSlashCommands.length, 1);
	assert.equal(app.deferredLocalSlashCommands[0].promptParts.find((part) => part.type === "image")?.data, "aW1hZ2U0");
	app.busy = false;
	await app.flushDeferredLocalSlashCommands();
	assert.equal(forwarded.length, 1);
	assert.equal(forwarded[0].question, "inspect [Image 4]");
	assert.equal(forwarded[0].promptParts.find((part) => part.type === "image")?.data, "aW1hZ2U0");
})();

// Prompts typed on a focused /btw during a transition wait for its outcome:
// they stay on a surviving fork, or merge into main in original input order.
await (async () => {
	const sidePrompts = [];
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "btw";
	app.sessionSwitchInProgress = true;
	app.activeKey = "codex";
	app.config = config;
	app.availableCommands = new Map([["codex", []]]);
	app.sessionStates = new Map([["codex", {}]]);
	app.deferredBtwPrompts = [];
	app.promptQueue = [];
	app.queuedInputOrder = 0;
	app.editor = { addToHistory() {} };
	app.consumeImagePromptParts = () => undefined;
	app.ui = { requestRender() {} };
	app.updateSpinner = () => {};
	app.btwThread = { async submit(text) { sidePrompts.push(text); } };
	await app.handleSubmit("side question");
	assert.deepEqual(sidePrompts, []);
	await app.settleDeferredBtwPrompts();
	assert.deepEqual(sidePrompts, ["side question"]);

	app.btwThread = undefined;
	app.promptQueue = [{ text: "main second", queuedInputOrder: 2 }];
	app.deferredBtwPrompts = [
		{ text: "side first", queuedInputOrder: 1 },
		{ text: "side third", queuedInputOrder: 3 },
	];
	await app.settleDeferredBtwPrompts();
	assert.deepEqual(app.promptQueue.map((entry) => entry.text), ["side first", "main second", "side third"]);
})();

// A connection/session RPC failure is retryable through ordinary input unless
// the live client can complete an advertised authentication flow in place.
await (async () => {
	const originalInitialize = AcpClient.prototype.initialize;
	const originalStopAndWait = AcpClient.prototype.stopAndWait;
	const makeApp = () => {
		const app = Object.create(HarnessApp.prototype);
		app.startupConnectTimer = undefined;
		app.config = { agents: { fake: { acp: { command: "fake", args: [] } } } };
		app.activeKey = "fake";
		app.transport = "acp";
		app.client = undefined;
		app.btwThread = undefined;
		app.ready = false;
		app.busy = false;
		app.promptQueue = [];
		app.promptQueueDrainScheduled = false;
		app.deferredLocalSlashCommands = [];
		app.queuedInputOrder = 0;
		app.activeToolIds = new Set();
		app.activeAnonymousToolCount = 0;
		app.pendingUserEchoes = [];
		app.statusState = "";
		app.connectionStatusOwner = undefined;
		app.clipboardImages = [];
		app.lastKnownEditorText = "";
		app.editor = {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		};
		app.cancelPermissionPrompts = () => {};
		app.closeMenu = () => {};
		app.clearCancelGraceTimer = () => {};
		app.closeCurrentAssistantText = () => {};
		app.updateSpinner = () => {};
		app.updateAutocomplete = () => {};
		app.schedulePromptQueueDrain = () => {};
		app.addCommandMessage = () => {};
		app.addError = () => {};
		app.addNotice = () => {};
		app.ui = { requestRender() {} };
		return app;
	};
	try {
		AcpClient.prototype.initialize = async function initializeWithFailure() {
			this.authMethods = [];
			throw new Error("temporary session failure");
		};
		const retryable = makeApp();
		await retryable.switchAgent("fake");
		assert.equal(retryable.ready, false);
		assert.equal(retryable.client.exited, true, "non-auth failures must make the failed client reconnectable");
		let reconnects = 0;
		retryable.switchAgent = async () => { reconnects += 1; };
		await retryable.submitBackendPrompt("retry me");
		assert.equal(reconnects, 1);
		assert.equal(retryable.promptQueue[0].text, "retry me");

		const exitedBeforeClose = makeApp();
		exitedBeforeClose.ready = true;
		exitedBeforeClose.client = { exited: true };
		let exitWindowReconnects = 0;
		exitedBeforeClose.switchAgent = async () => { exitWindowReconnects += 1; };
		await exitedBeforeClose.submitBackendPrompt("preserve during exit window");
		assert.equal(exitedBeforeClose.ready, false);
		assert.equal(exitWindowReconnects, 1);
		assert.equal(exitedBeforeClose.promptQueue[0].text, "preserve during exit window");

		AcpClient.prototype.initialize = async function initializeWithUnusableAuthError() {
			this.authMethods = [];
			throw new Error("authentication required");
		};
		const noAuthPath = makeApp();
		await noAuthPath.switchAgent("fake");
		assert.equal(noAuthPath.client.exited, true, "an auth-looking error is not recoverable without an advertised method");

		// Failed startup must not release the serialized harness-switch lifecycle
		// until the failed adapter's complete process tree has been reaped.
		let releaseFailedStartupStop;
		let markFailedStartupStopStarted;
		const failedStartupStopStarted = new Promise((resolve) => { markFailedStartupStopStarted = resolve; });
		const failedStartupStopGate = new Promise((resolve) => { releaseFailedStartupStop = resolve; });
		AcpClient.prototype.stopAndWait = async function delayedFailedStartupStop() {
			markFailedStartupStopStarted();
			await failedStartupStopGate;
			this.exited = true;
		};
		const failedStartup = makeApp();
		let failedStartupSettled = false;
		const failedStartupSwitch = failedStartup.switchAgent("fake").then(() => { failedStartupSettled = true; });
		await failedStartupStopStarted;
		await Promise.resolve();
		assert.equal(failedStartupSettled, false, "failed startup waits for process-tree teardown");
		releaseFailedStartupStop();
		await failedStartupSwitch;
		assert.equal(failedStartup.client.exited, true);
		AcpClient.prototype.stopAndWait = originalStopAndWait;

		AcpClient.prototype.initialize = async function initializeNeedingAuth() {
			this.authMethods = [{ id: "chat-gpt", name: "ChatGPT" }];
			throw new Error("authentication required");
		};
		const authenticating = makeApp();
		await authenticating.switchAgent("fake");
		assert.equal(authenticating.ready, false);
		assert.equal(authenticating.client.exited, false, "auth-required clients must remain live for /login");
		authenticating.client.stop();

		AcpClient.prototype.initialize = async function initializeForOwnedTransition() {
			this.sessionId = "new-session";
		};
		const ownedTransition = makeApp();
		let prematureDrains = 0;
		ownedTransition.schedulePromptQueueDrain = () => { prematureDrains += 1; };
		await ownedTransition.switchAgent("fake", "acp", { continueSessionSwitch: true });
		assert.equal(ownedTransition.ready, true);
		assert.equal(ownedTransition.sessionSwitchInProgress, true);
		assert.equal(prematureDrains, 0, "the transition owner must run deferred commands before prompts");
		ownedTransition.client.stop();

		// Re-authentication and same-agent replacement must not overlap an old
		// credential-bearing process with the replacement connection.
		let releaseStop;
		let markStopStarted;
		const stopStarted = new Promise((resolve) => { markStopStarted = resolve; });
		const stopGate = new Promise((resolve) => { releaseStop = resolve; });
		let replacementInitializations = 0;
		AcpClient.prototype.initialize = async function initializeReplacement() {
			replacementInitializations += 1;
			this.sessionId = "replacement-session";
		};
		const replacing = makeApp();
		replacing.ready = true;
		replacing.client = {
			exited: false,
			async stopAndWait() {
				markStopStarted();
				await stopGate;
				this.exited = true;
			},
		};
		const reconnectContext = replacing.captureActiveAgentContext();
		const replacement = replacing.switchAgent("fake", "acp", { continueSessionSwitch: true });
		await stopStarted;
		assert.equal(replacementInitializations, 0, "replacement must wait for old process-tree reaping");
		releaseStop();
		await replacement;
		assert.equal(replacementInitializations, 1);
		assert.equal(
			replacing.isActiveAgentContext(reconnectContext),
			true,
			"an intentional internal same-harness reconnect retains async context ownership",
		);
		replacing.client.stop();

		const explicitRestart = makeApp();
		await explicitRestart.switchAgent("fake");
		const staleContext = explicitRestart.captureActiveAgentContext();
		const generationBeforeRestart = explicitRestart.activeAgentGeneration ?? 0;
		await explicitRestart.switchAgent("fake", "acp", { explicitReplacement: true });
		assert.equal(explicitRestart.activeAgentGeneration, generationBeforeRestart + 1);
		assert.equal(
			explicitRestart.isActiveAgentContext(staleContext),
			false,
			"an explicit same-key harness replacement invalidates async work from its predecessor",
		);
		explicitRestart.client.stop();
		const replacementInitializationsBeforeFatal = replacementInitializations;

		const fatal = makeApp();
		const fatalErrors = [];
		fatal.client = {
			exited: false,
			async stopAndWait() {
				const error = new Error("old process tree is still live");
				error.code = "PROCESS_TREE_TERMINATION_FAILED";
				throw error;
			},
		};
		fatal.addError = (message) => fatalErrors.push(message);
		await fatal.switchAgent("fake");
		assert.equal(replacementInitializations, replacementInitializationsBeforeFatal, "unconfirmed shutdown must not start a replacement");
		assert.ok(fatalErrors.some((message) => message.includes("old process tree is still live")));
		await fatal.switchAgent("fake");
		assert.equal(replacementInitializations, replacementInitializationsBeforeFatal, "manual retry stays fenced after unconfirmed shutdown");
		await fatal.submitBackendPrompt("must remain queued behind the fatal fence");
		const fencedPromptSwitch = fatal.agentSwitchTail;
		if (fencedPromptSwitch) await fencedPromptSwitch;
		assert.equal(replacementInitializations, replacementInitializationsBeforeFatal, "queued prompts cannot bypass the fatal replacement fence");
		assert.deepEqual(fatal.promptQueue, [], "a fenced reconnect has no deliverable queue");
		assert.equal(fatal.editor.getText(), "must remain queued behind the fatal fence");
		assert.equal(fatal.statusState, "", "a blocked restart must not spin as connecting");
		assert.ok(fatalErrors.some((message) => message.includes("restart cc")));

		// A second switch arriving while the first is reaping must wait for the full
		// lifecycle. It may request a second sequential reconnect, but the first new
		// client must already be stopped before the second one initializes.
		let releaseConcurrentStop;
		let markConcurrentStopStarted;
		const concurrentStopStarted = new Promise((resolve) => { markConcurrentStopStarted = resolve; });
		const concurrentStopGate = new Promise((resolve) => { releaseConcurrentStop = resolve; });
		const initializedClients = [];
		AcpClient.prototype.initialize = async function initializeSerializedReplacement() {
			if (initializedClients.length > 0) {
				assert.equal(initializedClients.at(-1).exited, true, "prior replacement is reaped before another starts");
			}
			initializedClients.push(this);
			this.sessionId = `serialized-${initializedClients.length}`;
		};
		const concurrent = makeApp();
		concurrent.ready = true;
		concurrent.client = {
			exited: false,
			async stopAndWait() {
				markConcurrentStopStarted();
				await concurrentStopGate;
				this.exited = true;
			},
		};
		const firstSwitch = concurrent.switchAgent("fake");
		await concurrentStopStarted;
		const secondSwitch = concurrent.switchAgent("fake");
		await Promise.resolve();
		assert.equal(initializedClients.length, 0, "queued switch cannot launch during predecessor retirement");
		releaseConcurrentStop();
		await Promise.all([firstSwitch, secondSwitch]);
		assert.equal(initializedClients.length, 2);
		assert.equal(initializedClients[0].exited, true);
		assert.equal(concurrent.client.connection, initializedClients[1]);
		concurrent.client.stop();
	} finally {
		AcpClient.prototype.initialize = originalInitialize;
		AcpClient.prototype.stopAndWait = originalStopAndWait;
	}
})();

// Input submitted after a native current-session command stops the ACP client
// queues behind that owned transition instead of starting a blank reconnect.
await (async () => {
	let reconnects = 0;
	const app = Object.create(HarnessApp.prototype);
	app.ready = false;
	app.busy = false;
	app.sessionSwitchInProgress = true;
	app.client = { exited: true };
	app.promptQueue = [];
	app.queuedInputOrder = 0;
	app.statusState = "archiving session";
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.switchAgent = async () => { reconnects += 1; };
	app.ui = { requestRender() {} };
	await app.submitBackendPrompt("send after archive");
	assert.equal(reconnects, 0);
	assert.equal(app.statusState, "archiving session");
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "send after archive");
})();

// Queueing during a session transition must not arm a timer that can race past
// deferred /model or /config work when the owner clears the transition flag.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = true;
	app.promptQueueDrainScheduled = false;
	app.promptQueue = [{ text: "after model", timing: "afterTurn" }];
	let drains = 0;
	app.flushPromptQueue = async () => { drains += 1; };
	app.schedulePromptQueueDrain();
	assert.equal(app.promptQueueDrainScheduled, false);
	app.sessionSwitchInProgress = false;
	app.schedulePromptQueueDrain();
	assert.equal(app.promptQueueDrainScheduled, true);
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(drains, 1);
})();

// /clear follows current Codex semantics: it creates a fresh ACP session rather
// than only erasing the local transcript.
await (async () => {
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.activeKey = "fake";
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.btwThread = undefined;
	app.promptQueue = [{ text: "stale" }];
	app.pendingPromptDisplay = { text: "stale" };
	app.deferredLocalSlashCommands = [];
	app.statusState = "";
	app.client = {
		sessionId: "before-clear",
		async newSession(options) {
			calls.push("session/new");
			this.sessionId = "after-clear";
			await options.beforeReplay();
		},
	};
	app.resetConversationView = () => calls.push("reset-view");
	app.addCommandMessage = (text) => calls.push(text);
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.ui = { requestRender() {} };
	await app.runLocalSlashCommand("clear", "");
	assert.deepEqual(calls, ["session/new", "reset-view", "/clear (New session)"]);
	assert.deepEqual(app.promptQueue, []);
	assert.equal(app.sessionSwitchInProgress, false);
	assert.deepEqual(app.previousClearedSession, { key: "fake", sessionId: "before-clear" });
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
	assert.deepEqual(
		normalizedToolStatusEvents(["in_progress", "completed", "failed"], { nestedFields: true }),
		["running", "complete", "error"],
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

// Completion of a stopped/replaced client's turn cannot write an error into or
// clear state owned by the replacement client.
await (async () => {
	let rejectOldPrompt;
	const errors = [];
	const oldClient = {
		exited: false,
		prompt: () => new Promise((_resolve, reject) => { rejectOldPrompt = reject; }),
	};
	const replacement = { exited: false, sessionId: "replacement-session" };
	const app = Object.create(HarnessApp.prototype);
	app.client = oldClient;
	app.ready = true;
	app.busy = false;
	app.cancelRequested = false;
	app.afterToolCancelPending = false;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.seenToolThisTurn = false;
	app.statusState = "";
	app.promptQueue = [];
	app.closeCurrentAssistantText = () => {};
	app.updateSpinner = () => {};
	app.promptForActiveCapabilities = (text) => text;
	app.addError = (message) => errors.push(message);
	app.ui = { requestRender() {} };
	const pending = app.sendPrompt("old turn");
	await Promise.resolve();
	app.client = replacement;
	app.busy = false;
	app.statusState = "replacement connecting";
	app.activeToolIds.add("replacement-tool");
	rejectOldPrompt(new Error("backend stopped"));
	await pending;
	assert.deepEqual(errors, []);
	assert.equal(app.statusState, "replacement connecting");
	assert.equal(app.busy, false);
	assert.deepEqual([...app.activeToolIds], ["replacement-tool"]);
})();

// The submit wrapper also refuses to flush an old turn's queue after the active
// client changes while sendPrompt is pending.
await (async () => {
	let settleOldSend;
	let flushes = 0;
	const oldClient = { exited: false };
	const replacement = { exited: false };
	const app = Object.create(HarnessApp.prototype);
	app.client = oldClient;
	app.ready = true;
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.trackPendingUserEcho = () => ({});
	app.addUserMessage = () => ({});
	app.armPendingUnsendPrompt = () => {};
	app.sendPrompt = async () => new Promise((resolve) => { settleOldSend = resolve; });
	app.flushPromptQueue = async () => { flushes += 1; };
	const pending = app.submitBackendPrompt("old turn");
	await Promise.resolve();
	app.client = replacement;
	settleOldSend();
	await pending;
	assert.equal(flushes, 0);
})();

// Identity questions use the same local response in the primary conversation
// and preserve the normal transcript/echo/queue lifecycle.
await (async () => {
	const { app, prompts } = unsendHarness();
	app.client.prompt = async (prompt) => {
		prompts.push(prompt);
		return { stopReason: "end_turn" };
	};
	app.promptQueue.push({ text: "after identity", timing: "afterTurn" });
	await app.submitBackendPrompt("who are you?");
	assert.deepEqual(prompts, ["after identity"], "the identity question stays local and the following prompt reaches the backend");
	assert.equal(app.busy, false);
	assert.deepEqual(app.pendingUserEchoes, []);
	assert.equal(app.pendingUnsendPrompt, undefined);
	assert.equal(app.lastAssistantText, "I’m cc, a CLI that helps you switch between agent backends and manage the surrounding TUI/workflow.");
	const transcript = app.chat.children.flatMap((child) => child.render?.(200) ?? []).join("\n");
	assert.equal(transcript.match(/who are you\?/giu)?.length, 1, "the main identity question is rendered once");
	assert.equal(transcript.match(/I’m cc/gu)?.length, 1, "the main identity response is rendered once");

	const structured = unsendHarness();
	const structuredParts = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
	structured.app.promptForActiveCapabilities = (_text, parts) => parts;
	structured.app.client.prompt = async (prompt) => {
		structured.prompts.push(prompt);
		return { stopReason: "end_turn" };
	};
	await structured.app.submitBackendPrompt("who are you?", { promptParts: structuredParts });
	assert.deepEqual(structured.prompts, [structuredParts], "a structured main identity prompt reaches the backend intact");
})();

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
	app.client.capabilities.retractPrompt = false;
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
	assert.equal(events[0].type, "backend_activity");
	assert.equal(events[1].type, "session_info");
	assert.deepEqual(events[1].sessionInfo.sessionInfo.usage, {
		sessionUpdate: "usage_update",
		inputTokens: 1,
	});
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

// Turn-level usage returned by session/prompt augments, rather than erases,
// context-window usage received earlier through usage_update.
await (async () => {
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "codex-session";
	client.sessionInfo = { usage: { sessionUpdate: "usage_update", used: 40, size: 100 } };
	client.onEvent = (event) => events.push(event);
	client.request = async () => ({ usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
	await client.prompt("hello");
	assert.deepEqual(client.sessionInfo.usage, {
		sessionUpdate: "usage_update",
		used: 40,
		size: 100,
		inputTokens: 3,
		outputTokens: 2,
		totalTokens: 5,
	});
	assert.deepEqual(events.at(-1).sessionInfo.sessionInfo.usage, client.sessionInfo.usage);
})();

// A successful session transition must not leak usage/title/config state from
// the previous session when the new response is sparse.
await (async () => {
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "old-session";
	client.sessionInfo = { title: "Old", usage: { used: 90, size: 100 } };
	client.configOptions = [{ id: "old-option" }];
	client.models = { currentModelId: "old-model" };
	client.modes = { currentModeId: "old-mode" };
	client.bufferingSessionUpdates = false;
	client.bufferedSessionUpdates = [];
	client.agent = {};
	client.onEvent = () => {};
	client.request = async () => ({ sessionId: "new-session" });
	await client.switchSession("session/new", {});
	assert.equal(client.sessionId, "new-session");
	assert.deepEqual(client.sessionInfo, {});
	assert.deepEqual(client.configOptions, []);
	assert.equal(client.models, undefined);
	assert.equal(client.modes, undefined);
})();

{
	const events = [];
	const client = Object.create(AcpClient.prototype);
	client.sessionId = "codex-session";
	client.pending = new Map();
	client.bufferingSessionUpdates = false;
	client.stdoutBuffer = "";
	client.onEvent = (event) => events.push(event);
	const message = {
		jsonrpc: "2.0",
		method: "session/update",
		params: {
			sessionId: "codex-session",
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "read-1",
				status: "completed",
				rawOutput: {
					stdout: "before\u2028after",
				},
			},
		},
	};
	client.handleStdoutText(`${JSON.stringify(message)}\n`);
	assert.deepEqual(events, [
		{ type: "backend_activity" },
		{ type: "tool_update", id: "read-1", title: undefined, status: "complete" },
	]);
	assert.equal(client.stdoutBuffer, "");
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

assert.deepEqual(applied.agents.codex.acp.args, []);
assert.deepEqual(codexConfig(applied.agents.codex), {
	model: "gpt-5",
	approval_policy: "never",
	sandbox_mode: "danger-full-access",
});
assert.equal(applied.agents.codex._startupMode, "agent-full-access");
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

// Back-compat: a cursor --force baked into the BASE config acp.args (not settings)
// must still infer auto, or cc desyncs from a force-mode backend.
const bakedForce = applyHarnessSettings(
	{ agents: { cursor: { label: "Cursor", transport: "acp", acp: { command: "cursor-agent", args: ["--force", "acp"] } } } },
	{},
);
assert.equal(bakedForce.agents.cursor._permissionMode, "auto");
assert.equal(bakedForce.agents.cursor._autoPermissionRequests, true);

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
assert.deepEqual(unified.agents.codex.acp.args, []);
assert.deepEqual(codexConfig(unified.agents.codex), {});
assert.equal(unified.agents.codex._startupMode, "agent-full-access");
assert.equal(unified.agents.cursor._autoPermissionRequests, true);
assert.deepEqual(unified.agents.cursor.acp.args, ["--force", "acp"]);
// Generic harnesses with no native knob still auto-approve cc-side.
assert.equal(unified.agents["terminus-2"]._permissionMode, "auto");
assert.equal(unified.agents["terminus-2"]._autoPermissionRequests, true);

// Unified `mode: auto` must remove conflicting legacy Codex permission config and
// select the maintained adapter's full-access ACP mode. Unrelated config remains.
const conflicting = applyHarnessSettings(config, {
	permissions: { mode: "auto" },
	agents: { codex: { config: { approval_policy: "on-request", sandbox_mode: "workspace-write", model: "gpt-5" } } },
});
assert.deepEqual(codexConfig(conflicting.agents.codex), { model: "gpt-5" });
assert.equal(conflicting.agents.codex._startupMode, "agent-full-access");
assert.equal(conflicting.agents.codex._autoPermissionRequests, true);

// Per-agent mode overrides the global default.
const mixed = applyHarnessSettings(config, {
	permissions: { mode: "auto" },
	agents: { codex: { permissions: { mode: "ask" } } },
});
assert.equal(mixed.agents.codex._permissionMode, "ask");
assert.equal(mixed.agents.codex._autoPermissionRequests, undefined);
assert.equal(mixed.agents.codex._startupMode, "agent");
assert.equal(mixed.agents.claude._autoPermissionRequests, true);

// mode "auto" WITH a deny rule must NOT put the backend in a native bypass that
// stops it asking — cc would never get to enforce the denial. Gate it: the backend
// keeps prompting through the successor adapter's normal agent mode, and cc
// auto-approves all but the denied tool.
const autoDeny = applyHarnessSettings(config, {
	permissions: { mode: "auto", rules: [{ tool: "shell", action: "deny" }] },
});
assert.equal(autoDeny.agents.codex._startupMode, "agent");
assert.equal(autoDeny.agents.codex._permissionMode, "auto");
assert.equal(autoDeny.agents.codex._autoPermissionRequests, true);
// claude is gated to default (prompting) mode, not bypass.
assert.equal(autoDeny.agents.claude._startupMode, undefined);
assert.deepEqual(autoDeny.agents.claude._sessionMeta, {
	claudeCode: { options: { settings: { permissions: { defaultMode: "default" } } } },
});
// cursor is gated (no --force) so it prompts.
assert.ok(!autoDeny.agents.cursor.acp.args.includes("--force"));

// cursor force-flag VARIANTS (--force=true) are inferred AND neutralized too.
const cursorVariant = { agents: { cursor: { label: "Cursor", transport: "acp", acp: { command: "cursor-agent", args: ["--force=true", "acp"] } } } };
assert.equal(applyHarnessSettings(cursorVariant, {}).agents.cursor._permissionMode, "auto"); // inferred
const cursorVariantAsk = applyHarnessSettings(cursorVariant, { agents: { cursor: { permissions: { mode: "ask" } } } });
assert.ok(!cursorVariantAsk.agents.cursor.acp.args.some((a) => a.startsWith("--force")), "--force=true neutralized under unified ask");
// (the deny rule actually denying shell is covered by tests/permissions.test.mjs)

// _nativeBypass marks a genuine no-prompt launch (so /yolo knows a runtime tighten
// needs a respawn). Non-gated auto on a bypass-capable harness -> true; gated auto
// and generic harnesses keep prompting -> not set.
const bypassFlags = applyHarnessSettings(config, { permissions: { mode: "auto" } });
assert.equal(bypassFlags.agents.claude._nativeBypass, true);
assert.equal(bypassFlags.agents.codex._nativeBypass, true);
assert.equal(bypassFlags.agents.cursor._nativeBypass, true);
assert.equal(bypassFlags.agents["terminus-2"]._nativeBypass, undefined); // generic: no native bypass
const gatedFlags = applyHarnessSettings(config, { permissions: { mode: "auto", rules: [{ tool: "shell", action: "deny" }] } });
assert.equal(gatedFlags.agents.codex._nativeBypass, undefined); // gated keeps prompting
const askFlags = applyHarnessSettings(config, { permissions: { mode: "ask" } });
assert.equal(askFlags.agents.codex._nativeBypass, undefined);

// A deny rule scoped to ANOTHER agent must NOT gate unrelated harnesses: claude
// keeps its full native bypass when only codex has a deny rule.
const scopedDeny = applyHarnessSettings(config, {
	permissions: { mode: "auto", rules: [{ agent: "codex", tool: "shell", action: "deny" }] },
});
assert.equal(scopedDeny.agents.claude._startupMode, "bypassPermissions"); // claude NOT gated
assert.equal(scopedDeny.agents.codex._startupMode, "agent"); // codex IS gated

// A PERSISTED deny grant (no config rule) also forces gating at spawn.
const autoGrant = applyHarnessSettings(config, { permissions: { mode: "auto" } }, [{ agent: "codex", tool: "shell", action: "deny" }]);
assert.equal(autoGrant.agents.codex._startupMode, "agent", "persisted deny grant gates auto");
// without the grant, pure auto still uses the full bypass.
assert.equal(applyHarnessSettings(config, { permissions: { mode: "auto" } }).agents.codex._startupMode, "agent-full-access");

// Explicit unified "ask"/"deny" must NEUTRALIZE conflicting native auto/bypass on
// the same agent, or cc (asking) and the backend (silently auto-running) disagree.
const neutralized = applyHarnessSettings(config, {
	agents: {
		claude: { settings: { permissions: { defaultMode: "bypassPermissions" }, model: "sonnet" }, permissions: { mode: "ask" } },
		codex: { config: { approval_policy: "never", sandbox_mode: "danger-full-access" }, permissions: { mode: "ask" } },
		cursor: { args: ["--force", "--model", "gpt-5"], permissions: { mode: "deny" } },
	},
});
// claude: bypass startup mode/auto cleared; defaultMode flipped to "default"; model kept.
assert.equal(neutralized.agents.claude._permissionMode, "ask");
assert.equal(neutralized.agents.claude._autoPermissionRequests, undefined);
assert.equal(neutralized.agents.claude._startupMode, undefined);
assert.deepEqual(neutralized.agents.claude._sessionMeta, {
	claudeCode: { options: { settings: { permissions: { defaultMode: "default" }, model: "sonnet" } } },
});
// codex: legacy bypass config removed and normal agent mode selected; auto cleared.
assert.deepEqual(codexConfig(neutralized.agents.codex), {});
assert.equal(neutralized.agents.codex._startupMode, "agent");
assert.equal(neutralized.agents.codex._autoPermissionRequests, undefined);
// cursor: --force removed (deny), unrelated args kept; cc decides deny-side.
assert.ok(!neutralized.agents.cursor.acp.args.includes("--force"), "cursor force flag removed");
assert.ok(neutralized.agents.cursor.acp.args.includes("gpt-5"), "cursor unrelated args kept");
assert.equal(neutralized.agents.cursor._permissionMode, "deny");
assert.equal(neutralized.agents.cursor._autoPermissionRequests, undefined);

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
assert.equal(defaultConfig.agents.claude._requiredAgentName, "@agentclientprotocol/claude-agent-acp");
assert.equal(defaultConfig.agents.claude._minimumAgentVersion, "0.58.1");
assert.equal(defaultConfig.agents.claude._packageLocalAcpVersion, "0.58.1");
assert.match(defaultConfig.agents.claude._packageLocalAcpBridge, /harness[/\\]claude-acp-bridge\.mjs$/u);
assert.equal(defaultConfig.agents.codex._requiredAgentName, "@agentclientprotocol/codex-acp");
assert.equal(defaultConfig.agents.codex._minimumAgentVersion, "1.1.2");
assert.equal(defaultConfig.agents.codex._packageLocalAcpVersion, "1.1.2");
for (const key of ["claude", "codex"]) {
	const launch = resolveAgentAcpExecutable(defaultConfig.agents[key], process.cwd(), { PATH: "" });
	assert.equal(launch.executable, process.execPath, `${key} must use cc's Node runtime for its package-local adapter`);
	if (key === "claude") assert.match(launch.prefixArgs[0], /harness[/\\]claude-acp-bridge\.mjs$/u);
	else assert.match(launch.prefixArgs[0], /node_modules[/\\]@agentclientprotocol[/\\]codex-acp[/\\]dist[/\\]index\.js$/u);
}
assert.match(defaultConfig.agents["terminus-2"].acp.args[0], /terminus_2\/bridge\.py$/);
assert.match(defaultConfig.agents["mini-swe-agent"].acp.args[0], /mini_swe_agent\/bridge\.py$/);

// loadConfig must never hand out the module-level default agent objects: the
// app writes session state (auth env, session defaults) onto
// config.agents.<key> in place, and a shared reference would leak one
// session's credentials and signed-out state into every later load in the
// same process.
{
	const prevConfig = process.env.CC_CONFIG;
	const prevSettings = process.env.CC_SETTINGS;
	process.env.CC_CONFIG = path.join(os.tmpdir(), `cc-clone-config-${process.pid}.json`);
	process.env.CC_SETTINGS = path.join(os.tmpdir(), `cc-clone-settings-${process.pid}.json`);
	try {
		const first = loadConfig();
		first.agents.claude._sessionAuthEnv = { ANTHROPIC_API_KEY: "session-secret" };
		first.agents.claude._signedOutAuthEnvNames = ["ANTHROPIC_API_KEY"];
		first.agents.codex._sessionDefaults = { model: "gpt-session" };
		const second = loadConfig();
		assert.notStrictEqual(second.agents.claude, first.agents.claude, "agent definitions are not shared across loads");
		assert.equal(second.agents.claude._sessionAuthEnv, undefined, "session credentials never leak into a fresh load");
		assert.equal(second.agents.claude._signedOutAuthEnvNames, undefined);
		assert.equal(second.agents.codex._sessionDefaults, undefined);
	} finally {
		if (prevConfig === undefined) delete process.env.CC_CONFIG;
		else process.env.CC_CONFIG = prevConfig;
		if (prevSettings === undefined) delete process.env.CC_SETTINGS;
		else process.env.CC_SETTINGS = prevSettings;
	}
}

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
assert.deepEqual(
	applyHarnessSettings(config, {
		agents: { codex: { sessionDefaults: { model: "gpt-cc", effort: "medium" } } },
	}).agents.codex._sessionDefaults,
	{ model: "gpt-cc", effort: "medium" },
);

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

// Settings persistence never materializes a theme the user did not choose (a
// config.json theme stays authoritative and unknown stored names survive
// unrelated saves verbatim), and a torn settings.json degrades to defaults
// instead of failing every subsequent launch.
{
	const prevSettings = process.env.CC_SETTINGS;
	const prevConfig = process.env.CC_CONFIG;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-settings-durability-"));
	try {
		const settingsFile = path.join(dir, "settings.json");
		const configFile = path.join(dir, "config.json");
		fs.writeFileSync(configFile, `${JSON.stringify({ ...config, theme: "matrix" }, null, 2)}\n`);
		process.env.CC_SETTINGS = settingsFile;
		process.env.CC_CONFIG = configFile;

		const saved = saveSettingsPatch({ defaultAgent: "cursor" });
		assert.equal(Object.prototype.hasOwnProperty.call(saved, "theme"), false);
		assert.equal(
			Object.prototype.hasOwnProperty.call(JSON.parse(fs.readFileSync(settingsFile, "utf8")), "theme"),
			false,
			"a theme-less save does not materialize a theme override",
		);
		assert.equal(loadConfig().theme, "matrix", "the config.json theme stays authoritative");

		// A stored theme from a newer release is not rewritten by unrelated saves.
		fs.writeFileSync(settingsFile, `${JSON.stringify({ theme: "future-theme" }, null, 2)}\n`);
		saveSettingsPatch({ defaultAgent: "cursor" });
		assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).theme, "future-theme");

		// A torn write (crash/ENOSPC mid-save) falls back to defaults on load and
		// self-heals on the next save.
		fs.writeFileSync(settingsFile, "{\"defaultAgent\": \"cu");
		assert.equal(loadConfig().defaultAgent, config.defaultAgent);
		assert.equal(saveSettingsPatch({ defaultAgent: "cursor" }).defaultAgent, "cursor");
		assert.equal(loadConfig().defaultAgent, "cursor");

		// A stale settings lock left by a crashed process never blocks saving.
		fs.mkdirSync(`${settingsFile}.lock`);
		fs.utimesSync(`${settingsFile}.lock`, new Date(0), new Date(0));
		assert.equal(saveSettingsPatch({ copyAlwaysFullResponse: true }).copyAlwaysFullResponse, true);
		assert.equal(fs.existsSync(`${settingsFile}.lock`), false, "the stale lock is reclaimed and released");
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

// Once a session RPC commits, a host beforeReplay failure still releases the
// buffer and replays committed history before surfacing the host error.
{
	const replayed = [];
	const client = new AcpClient({ command: "fake" }, (event) => {
		if (event.type === "text") replayed.push(event.text);
	});
	client.request = async (method) => {
		if (method === "session/new") {
			client.handleSessionUpdate({
				sessionId: "committed-session",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "committed history" },
				},
			});
			return { sessionId: "committed-session" };
		}
		return {};
	};
	await assert.rejects(
		client.newSession({ beforeReplay: () => { throw new Error("view reset failed"); } }),
		/view reset failed/,
	);
	assert.equal(client.sessionId, "committed-session");
	assert.equal(client.bufferingSessionUpdates, false);
	assert.deepEqual(client.bufferedSessionUpdates, []);
	assert.deepEqual(replayed, ["committed history"]);
}

// Codex /btw fork helpers: locate the rollout by id and copy it to a new id.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-"));
	const previousForkRegistry = process.env.CC_FORKS;
	process.env.CC_FORKS = path.join(root, "forks.json");
	const oldId = "11111111-1111-1111-1111-111111111111";
	const newId = "22222222-2222-2222-2222-222222222222";
	const dayDir = path.join(root, "sessions", "2026", "06", "18");
	fs.mkdirSync(dayDir, { recursive: true });
	const rollout = path.join(dayDir, `rollout-2026-06-18T10-00-00-${oldId}.jsonl`);
	fs.writeFileSync(
		rollout,
		`${JSON.stringify({ type: "session_meta", payload: { id: oldId, session_id: oldId, parent_thread_id: "spawn-parent" } })}\n` +
			`${JSON.stringify({ type: "item", thread_id: oldId, text: `preserve literal ${oldId}` })}\n`,
	);
	// Add an older day to confirm newest-first does not matter for a single match.
	const found = findCodexRolloutPath(oldId, path.join(root, "sessions"));
	assert.equal(found, rollout);
	assert.equal(findCodexRolloutPath("does-not-exist", path.join(root, "sessions")), undefined);
	const copy = copyCodexRolloutWithNewId(found, oldId, newId);
	assert.equal(path.basename(copy), `rollout-2026-06-18T10-00-00-${newId}.jsonl`);
	const copied = fs.readFileSync(copy, "utf8");
	const copiedRecords = copied.trimEnd().split("\n").map(JSON.parse);
	assert.equal(copiedRecords[0].payload.id, newId, "metadata id must be rewritten");
	assert.equal(copiedRecords[0].payload.session_id, newId, "metadata session_id must be rewritten");
	assert.equal(copiedRecords[0].payload.forked_from_id, oldId, "copy metadata records native-style fork lineage");
	assert.equal(Object.hasOwn(copiedRecords[0].payload, "parent_thread_id"), false, "a copy fork is not mislabeled as a subagent");
	assert.equal(copiedRecords[1].thread_id, oldId, "non-metadata fields are preserved byte-for-byte");
	assert.equal(copiedRecords[1].text, `preserve literal ${oldId}`, "literal UUIDs in transcript content are never rewritten");
	// A flat legacy label can recover the parent from rollout metadata and persist
	// it before permanent deletion computes the copy subtree.
	recordForkId(newId);
	assert.deepEqual(loadCodexForkDescendantIds(oldId, { env: { CODEX_HOME: root } }), [newId]);
	assert.equal(loadForkParents().get(newId), oldId);
	forgetForkIds(newId, { required: true });

	// Pre-v2 copies had no forked_from_id. Recover direct nested ancestry from the
	// longest inherited JSONL prefix, considering only forks recorded earlier.
	const legacyRoot = "50000000-0000-7000-8000-000000000005";
	const legacyChild = "60000000-0000-7000-8000-000000000006";
	const legacyGrandchild = "70000000-0000-7000-8000-000000000007";
	const legacyName = (id) => path.join(dayDir, `rollout-2026-06-18T09-00-00-${id}.jsonl`);
	const meta = (id) => JSON.stringify({ type: "session_meta", payload: { id, timestamp: "same" } });
	const shared = JSON.stringify({ type: "item", text: "shared history" });
	const childOnly = JSON.stringify({ type: "item", text: "child branch" });
	fs.writeFileSync(legacyName(legacyRoot), `${meta(legacyRoot)}\n${shared}\n${JSON.stringify({ type: "item", text: "root branch" })}\n`);
	fs.writeFileSync(legacyName(legacyChild), `${meta(legacyChild)}\n${shared}\n${childOnly}\n`);
	fs.writeFileSync(legacyName(legacyGrandchild), `${meta(legacyGrandchild)}\n${shared}\n${childOnly}\n${JSON.stringify({ type: "item", text: "nested branch" })}\n`);
	fs.writeFileSync(process.env.CC_FORKS, `${JSON.stringify({ forks: [legacyChild, legacyGrandchild] })}\n`);
	assert.deepEqual(
		loadCodexForkDescendantIds(legacyChild, { env: { CODEX_HOME: root } }),
		[legacyGrandchild],
		"legacy nested copies recover their direct parent rather than flattening to the root",
	);
	assert.equal(loadForkParents().get(legacyChild), legacyRoot);
	assert.equal(loadForkParents().get(legacyGrandchild), legacyChild);
	forgetForkIds([legacyGrandchild, legacyChild], { required: true });

	// An undecodable compressed history cannot prove lineage from a seconds-level
	// filename cohort alone. Leave it unresolved so destructive deletion can fail
	// closed rather than assigning it to a coincidental same-second session.
	const compressedRoot = "80000000-0000-7000-8000-000000000008";
	const compressedChild = "90000000-0000-7000-8000-000000000009";
	const compressedName = (id) => path.join(dayDir, `rollout-2026-06-18T08-00-00-${id}.jsonl.zst`);
	fs.writeFileSync(compressedName(compressedRoot), "not-a-zstd-frame");
	fs.writeFileSync(compressedName(compressedChild), "not-a-zstd-frame");
	fs.writeFileSync(process.env.CC_FORKS, `${JSON.stringify({ forks: [compressedChild] })}\n`);
	assert.deepEqual(
		loadCodexForkDescendantIds(compressedRoot, { env: { CODEX_HOME: root } }),
		[],
		"undecodable compressed cohorts are not assigned to an unverified root",
	);
	assert.equal(loadForkParents().has(compressedChild), false);
	forgetForkIds(compressedChild, { required: true });
	if (typeof zlib.zstdCompressSync === "function") {
		const readableCompressedRoot = "a0000000-0000-7000-8000-00000000000a";
		const readableCompressedChild = "b0000000-0000-7000-8000-00000000000b";
		const compressedContent = (id) => Buffer.from(
			`${meta(id)}\n${shared}\n`,
			"utf8",
		);
		for (const id of [readableCompressedRoot, readableCompressedChild]) {
			fs.writeFileSync(
				path.join(dayDir, `rollout-2026-06-18T07-00-00-${id}.jsonl.zst`),
				zlib.zstdCompressSync(compressedContent(id)),
			);
		}
		fs.writeFileSync(process.env.CC_FORKS, `${JSON.stringify({ forks: [readableCompressedChild] })}\n`);
		assert.deepEqual(
			loadCodexForkDescendantIds(readableCompressedRoot, { env: { CODEX_HOME: root } }),
			[readableCompressedChild],
			"decodable compressed legacy history can be verified and migrated",
		);
		forgetForkIds(readableCompressedChild, { required: true });
	}
	// Original rollout is untouched.
	assert.ok(fs.readFileSync(rollout, "utf8").includes(oldId), "parent rollout must be untouched");
	const incompleteId = "33333333-3333-3333-3333-333333333333";
	const incomplete = path.join(dayDir, `rollout-2026-06-18T11-00-00-${incompleteId}.jsonl`);
	fs.writeFileSync(incomplete, JSON.stringify({ type: "session_meta", payload: { id: incompleteId } }));
	assert.throws(
		() => copyCodexRolloutWithNewId(incomplete, incompleteId, "44444444-4444-4444-4444-444444444444"),
		/complete JSONL record/,
	);
	assert.equal(
		fs.existsSync(path.join(dayDir, "rollout-2026-06-18T11-00-00-44444444-4444-4444-4444-444444444444.jsonl")),
		false,
		"an invalid snapshot is never published",
	);
	let stopped = 0;
	const failedForkApp = Object.create(HarnessApp.prototype);
	failedForkApp.activeKey = "codex";
	failedForkApp.config = { agents: { codex: { env: { CODEX_HOME: root } } } };
	const beforeFailedFork = fs.readdirSync(dayDir).sort();
	await assert.rejects(
		() => failedForkApp.forkCodexSession({
			async loadSession() { throw new Error("load rejected"); },
			async stopAndWait() { stopped += 1; },
		}, oldId),
		/load rejected/,
	);
	assert.equal(stopped, 1, "the failed fork backend is retired before storage cleanup");
	assert.deepEqual(fs.readdirSync(dayDir).sort(), beforeFailedFork, "a failed session/load leaves no copied rollout behind");
	assert.equal(loadForkParents().size, 0, "a failed session/load rolls back its reserved parent edge");
	if (previousForkRegistry === undefined) delete process.env.CC_FORKS;
	else process.env.CC_FORKS = previousForkRegistry;
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
				"id text, rollout_path text, cwd text, source text, thread_source text, updated_at text, updated_at_ms integer, has_user_event integer, archived integer,",
				"tokens_used integer, title text, first_user_message text, preview text, model text, reasoning_effort text, model_provider text",
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
		const cwd = path.join(root, "workspace");
		assert.deepEqual(listLocalCodexSessions(cwd, dbPath, 10), [], "an empty local result must stay authoritative");
		const insert = spawnSync("sqlite3", [
			dbPath,
			[
				"insert into threads",
				"(id, rollout_path, cwd, source, thread_source, updated_at, updated_at_ms, has_user_event, archived, tokens_used, title, first_user_message, preview)",
				`values ('older', '', ${JSON.stringify(cwd)}, 'cli', 'user', 100, 100000, 0, 0, 0, 'Older', '', 'Older');`,
				"insert into threads",
				"(id, rollout_path, cwd, source, thread_source, updated_at, updated_at_ms, has_user_event, archived, tokens_used, title, first_user_message, preview)",
				`values ('newer', '', ${JSON.stringify(cwd)}, 'unknown', '', 200, 200000, 0, 0, 0, 'Newer', '', 'Newer');`,
				"insert into threads",
				"(id, rollout_path, cwd, source, thread_source, updated_at, updated_at_ms, has_user_event, archived, tokens_used, title, first_user_message, preview)",
				`values ('archived', '', ${JSON.stringify(cwd)}, 'cli', 'user', 300, 300000, 0, 1, 0, 'Archived', '', 'Archived');`,
				"insert into threads",
				"(id, rollout_path, cwd, source, thread_source, updated_at, updated_at_ms, has_user_event, archived, tokens_used, title, first_user_message, preview)",
				`values ('exec', '', ${JSON.stringify(cwd)}, 'exec', 'user', 400, 400000, 0, 0, 0, 'Exec', '', 'Exec');`,
				"update threads set model_provider = 'openai' where id in ('older', 'archived');",
				"update threads set model_provider = 'custom-gateway' where id = 'newer';",
			].join(" "),
		], { encoding: "utf8" });
		assert.equal(insert.status, 0, insert.stderr || insert.error?.message);
		assert.deepEqual(listLocalCodexSessions(cwd, dbPath, 10), [
			{ sessionId: "newer", cwd, title: "Newer", updatedAt: new Date(200000).toISOString() },
			{ sessionId: "older", cwd, title: "Older", updatedAt: new Date(100000).toISOString() },
		]);
		assert.deepEqual(listLocalCodexSessions(cwd, dbPath, 10, { modelProvider: "openai" }), [
			{ sessionId: "older", cwd, title: "Older", updatedAt: new Date(100000).toISOString() },
		]);
		assert.deepEqual(listLocalCodexSessions(cwd, dbPath, 10, { modelProvider: "custom-gateway" }), [
			{ sessionId: "newer", cwd, title: "Newer", updatedAt: new Date(200000).toISOString() },
		]);
		assert.deepEqual(listLocalCodexSessions(cwd, dbPath, 10, { archived: true }), [
			{ sessionId: "archived", cwd, title: "Archived", updatedAt: new Date(300000).toISOString() },
		]);
		const differentlyCasedCwd = cwd.toUpperCase();
		const insertCaseVariant = spawnSync("sqlite3", [
			dbPath,
			[
				"insert into threads",
				"(id, rollout_path, cwd, source, thread_source, updated_at, updated_at_ms, has_user_event, archived, tokens_used, title, first_user_message, preview, model_provider)",
				`values ('case-variant', '', ${JSON.stringify(differentlyCasedCwd)}, 'cli', 'user', 500, 500000, 0, 0, 0, 'Case variant', '', '', 'case-test');`,
			].join(" "),
		], { encoding: "utf8" });
		assert.equal(insertCaseVariant.status, 0, insertCaseVariant.stderr || insertCaseVariant.error?.message);
		assert.deepEqual(
			listLocalCodexSessions(cwd, dbPath, 10, { modelProvider: "case-test", caseInsensitiveFilesystem: false }),
			[],
			"case-sensitive platforms keep distinct cwd spellings separate",
		);
		assert.deepEqual(
			listLocalCodexSessions(cwd, dbPath, 10, { modelProvider: "case-test", caseInsensitiveFilesystem: true }),
			[{ sessionId: "case-variant", cwd: differentlyCasedCwd, title: "Case variant", updatedAt: new Date(500000).toISOString() }],
			"case-insensitive platforms find a session saved with different path casing",
		);
		assert.equal(
			listLocalCodexSessions(cwd, dbPath, 10, { modelProvider: "case-test", platform: "win32" }).length,
			1,
			"Windows path comparison is always case-insensitive",
		);
	}
	fs.rmSync(root, { recursive: true, force: true });
}

// Native Codex resolution stays shell-free on Windows: npm's .cmd shims are
// traced back to their package-owned JavaScript entrypoints and run with Node.
{
	const bundled = resolveCodexInvocation({
		_requiredAgentName: "@agentclientprotocol/codex-acp",
		_minimumAgentVersion: "1.1.2",
		_packageLocalAcpCommand: "codex-acp",
		_packageLocalAcpVersion: "1.1.2",
		acp: { command: "codex-acp", args: [] },
		env: { PATH: "" },
	});
	assert.equal(bundled?.command, process.execPath);
	assert.match(bundled?.args?.[0] ?? "", /node_modules[/\\]@openai[/\\]codex/u);
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-invocation-"));
	const writePackage = (packageRoot, name, bin = undefined) => {
		fs.mkdirSync(packageRoot, { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name, ...(bin ? { bin } : {}) }));
	};
	try {
		const prefix = path.join(root, "npm-prefix");
		const adapterShim = path.join(prefix, "codex-acp.cmd");
		const adapterRoot = path.join(prefix, "node_modules", "@agentclientprotocol", "codex-acp");
		const adapterJs = path.join(adapterRoot, "dist", "index.js");
		const bundledRoot = path.join(adapterRoot, "node_modules", "@openai", "codex");
		const bundledJs = path.join(bundledRoot, "bin", "codex.js");
		fs.mkdirSync(adapterRoot, { recursive: true });
		fs.writeFileSync(path.join(adapterRoot, "package.json"), JSON.stringify({
			name: "@agentclientprotocol/codex-acp",
			version: "1.1.2",
		}));
		writePackage(bundledRoot, "@openai/codex", { codex: "bin/codex.js" });
		fs.mkdirSync(path.dirname(adapterJs), { recursive: true });
		fs.writeFileSync(adapterJs, "// adapter entrypoint\n");
		fs.mkdirSync(path.dirname(bundledJs), { recursive: true });
		fs.writeFileSync(
			bundledJs,
			"process.stdout.write(JSON.stringify({ args: process.argv.slice(2), marker: process.env.CC_NATIVE_MARKER }));\n",
		);
		fs.writeFileSync(
			adapterShim,
			'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*\r\n',
		);
		fs.chmodSync(adapterShim, 0o755);

		const pathBin = path.join(root, "path-bin");
		const pathCodex = path.join(pathBin, process.platform === "win32" ? "codex.exe" : "codex");
		fs.mkdirSync(pathBin, { recursive: true });
		fs.writeFileSync(pathCodex, "#!/bin/sh\nexit 99\n");
		fs.chmodSync(pathCodex, 0o755);
		const bundledInvocation = resolveCodexInvocation({ acp: { command: adapterShim }, env: { PATH: pathBin } });
		assert.deepEqual(bundledInvocation, { command: process.execPath, args: [fs.realpathSync(bundledJs)] });
		assert.ok(!/[.](?:cmd|bat)$/i.test(bundledInvocation.command));

		const standalonePrefix = path.join(root, "standalone-prefix");
		const standaloneShim = path.join(standalonePrefix, "codex.cmd");
		const standaloneRoot = path.join(standalonePrefix, "node_modules", "@openai", "codex");
		const standaloneJs = path.join(standaloneRoot, "bin", "codex.js");
		writePackage(standaloneRoot, "@openai/codex", { codex: "bin/codex.js" });
		fs.mkdirSync(path.dirname(standaloneJs), { recursive: true });
		fs.writeFileSync(standaloneJs, "process.exit(0);\n");
		fs.writeFileSync(
			standaloneShim,
			'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
		);
		fs.chmodSync(standaloneShim, 0o755);
		assert.deepEqual(
			resolveCodexInvocation({
				acp: { command: path.join(root, "missing-acp") },
				env: { CODEX_PATH: standaloneShim, PATH: "" },
			}),
			{ command: process.execPath, args: [fs.realpathSync(standaloneJs)] },
		);

		const directExe = path.join(root, "codex-direct.exe");
		fs.writeFileSync(directExe, "native-placeholder");
		fs.chmodSync(directExe, 0o755);
		assert.deepEqual(
			resolveCodexInvocation({ acp: { command: path.join(root, "missing-acp") }, env: { CODEX_PATH: directExe, PATH: "" } }),
			{ command: directExe, args: [] },
		);

		const relativeWorkdir = path.join(root, "relative-workdir");
		const relativeCodex = path.join(relativeWorkdir, "relative-codex");
		fs.mkdirSync(relativeWorkdir);
		fs.writeFileSync(relativeCodex, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(relativeCodex, 0o755);
		const previousCwd = process.cwd();
		try {
			process.chdir(relativeWorkdir);
			assert.deepEqual(
				resolveCodexInvocation({
					acp: { command: path.join(root, "missing-acp") },
					env: { CODEX_PATH: "./relative-codex", PATH: "" },
				}),
				{ command: fs.realpathSync(relativeCodex), args: [] },
			);
		} finally {
			process.chdir(previousCwd);
		}

		const unownedShim = path.join(root, "unowned.cmd");
		fs.writeFileSync(unownedShim, "@echo off\r\n");
		fs.chmodSync(unownedShim, 0o755);
		assert.equal(
			resolveCodexInvocation({ acp: { command: path.join(root, "missing-acp") }, env: { CODEX_PATH: unownedShim, PATH: "" } }),
			undefined,
		);
		await assert.rejects(
			() => runCodexCommand({ command: unownedShim, args: [] }, ["doctor"], {}),
			/refusing to launch a Codex command shim directly/,
		);

		const result = await runCodexCommand(bundledInvocation, ["features", "list"], {
			env: { CC_NATIVE_MARKER: "agent-env" },
		});
		assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), {
			args: ["features", "list"],
			marker: "agent-env",
		});

		// An outdated maintained adapter is not a valid source for native helper
		// commands. Skip its bundled Codex and continue to a standalone CLI rather
		// than coupling app-server features to an adapter the ACP runtime rejects.
		const outdatedPrefix = path.join(root, "outdated-prefix");
		const outdatedBin = path.join(outdatedPrefix, "bin");
		const outdatedRoot = path.join(outdatedPrefix, "lib", "node_modules", "@agentclientprotocol", "codex-acp");
		const outdatedAdapter = path.join(outdatedRoot, "dist", "index.js");
		const outdatedCodexRoot = path.join(outdatedRoot, "node_modules", "@openai", "codex");
		const outdatedCodex = path.join(outdatedCodexRoot, "bin", "codex.js");
		const standaloneBin = path.join(root, "standalone-bin");
		const standaloneCodex = path.join(standaloneBin, "codex");
		fs.mkdirSync(path.dirname(outdatedAdapter), { recursive: true });
		fs.mkdirSync(path.dirname(outdatedCodex), { recursive: true });
		fs.mkdirSync(outdatedBin, { recursive: true });
		fs.mkdirSync(standaloneBin, { recursive: true });
		fs.writeFileSync(path.join(outdatedRoot, "package.json"), JSON.stringify({
			name: "@agentclientprotocol/codex-acp",
			version: "1.0.0",
		}));
		writePackage(outdatedCodexRoot, "@openai/codex", { codex: "bin/codex.js" });
		fs.writeFileSync(outdatedAdapter, "#!/usr/bin/env node\n");
		fs.writeFileSync(outdatedCodex, "// outdated bundled Codex\n");
		fs.writeFileSync(standaloneCodex, "#!/bin/sh\nexit 0\n");
		fs.chmodSync(outdatedAdapter, 0o755);
		fs.chmodSync(standaloneCodex, 0o755);
		fs.symlinkSync(path.relative(outdatedBin, outdatedAdapter), path.join(outdatedBin, "codex-acp"));
		assert.deepEqual(
			resolveCodexInvocation({
				_minimumAgentVersion: "1.1.2",
				acp: { command: "codex-acp" },
				env: { PATH: [outdatedBin, standaloneBin].join(path.delimiter) },
			}),
			{ command: standaloneCodex, args: [] },
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// A stale adapter in an older global prefix must not shadow a compatible
// maintained adapter later on PATH. Explicit path commands remain untouched;
// this search applies only to a bare package command.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-package-local-acp-"));
	try {
		const packageRoot = path.join(root, "node_modules", "@agentclientprotocol", "claude-agent-acp");
		const entrypoint = path.join(packageRoot, "dist", "index.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "@agentclientprotocol/claude-agent-acp",
			version: "0.58.1",
			bin: { "claude-agent-acp": "dist/index.js" },
		}));
		fs.writeFileSync(entrypoint, "// package-local adapter\n");
		const agent = {
			_requiredAgentName: "@agentclientprotocol/claude-agent-acp",
			_minimumAgentVersion: "0.58.1",
			_packageLocalAcpCommand: "claude-agent-acp",
			_packageLocalAcpVersion: "0.58.1",
			acp: { command: "claude-agent-acp", args: [] },
		};
		assert.deepEqual(resolvePackageLocalAcpExecutable(agent, root), {
			executable: process.execPath,
			prefixArgs: [entrypoint],
		});
		assert.equal(
			resolvePackageLocalAcpExecutable({ ...agent, acp: { command: "/custom/claude-acp", args: [] } }, root),
			undefined,
			"a custom acp.command remains an explicit adapter override",
		);
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "@agentclientprotocol/claude-agent-acp",
			version: "0.58.0",
			bin: { "claude-agent-acp": "dist/index.js" },
		}));
		assert.equal(resolvePackageLocalAcpExecutable(agent, root), undefined, "an old local adapter is never selected");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

if (process.platform !== "win32") {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acp-prefix-shadow-"));
	try {
		const makeAdapter = (prefix, packageName, version) => {
			const packageRoot = path.join(prefix, "lib", "node_modules", ...packageName.split("/"));
			const entrypoint = path.join(packageRoot, "dist", "index.js");
			const binDir = path.join(prefix, "bin");
			fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
			fs.mkdirSync(binDir, { recursive: true });
			fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ name: packageName, version }));
			fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
			fs.chmodSync(entrypoint, 0o755);
			const shim = path.join(binDir, "codex-acp");
			fs.symlinkSync(path.relative(binDir, entrypoint), shim);
			return shim;
		};
		const legacy = makeAdapter(path.join(root, "old"), "@zed-industries/codex-acp", "0.8.0");
		const maintained = makeAdapter(path.join(root, "current"), "@agentclientprotocol/codex-acp", "1.1.2");
		const pathValue = [path.dirname(legacy), path.dirname(maintained)].join(path.delimiter);
		const launch = resolveAgentAcpExecutable({
			_requiredAgentName: "@agentclientprotocol/codex-acp",
			_minimumAgentVersion: "1.1.2",
			acp: { command: "codex-acp", args: [] },
		}, process.cwd(), { PATH: pathValue });
		assert.equal(launch.executable, process.execPath);
		assert.deepEqual(launch.prefixArgs, [fs.realpathSync(maintained)]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// On Windows, package verification must not associate a foreign same-name .exe
// with an npm package merely because the package exists under the same prefix.
// Skip the foreign executable and select the package-owned .cmd entrypoint.
{
	const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "cc-acp-windows-owner-"));
	try {
		const packageRoot = path.join(prefix, "node_modules", "@agentclientprotocol", "codex-acp");
		const entrypoint = path.join(packageRoot, "dist", "index.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
			name: "@agentclientprotocol/codex-acp",
			version: "1.1.2",
		}));
		fs.writeFileSync(entrypoint, "// maintained adapter\n");
		fs.writeFileSync(path.join(prefix, "codex-acp.exe"), "foreign executable");
		fs.writeFileSync(
			path.join(prefix, "codex-acp.cmd"),
			'@echo off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@agentclientprotocol\\codex-acp\\dist\\index.js" %*\r\n',
		);
		const launch = resolveAgentAcpExecutable({
			_requiredAgentName: "@agentclientprotocol/codex-acp",
			_minimumAgentVersion: "1.1.2",
			acp: { command: "codex-acp", args: [] },
		}, process.cwd(), { Path: prefix }, "win32");
		assert.equal(launch.executable, process.execPath);
		assert.deepEqual(launch.prefixArgs, [fs.realpathSync(entrypoint)]);
	} finally {
		fs.rmSync(prefix, { recursive: true, force: true });
	}
}

// Codex-only local commands stay scoped to the active backend, and plugin
// marketplace direct forms preserve their tokenized arguments and agent env.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-plugin-cli-"));
	const fakeCli = path.join(root, "fake-codex.mjs");
	const log = path.join(root, "commands.jsonl");
	fs.writeFileSync(fakeCli, [
		'import fs from "node:fs";',
		'const args = process.argv.slice(2);',
		'fs.appendFileSync(process.env.CC_PLUGIN_LOG, JSON.stringify({ args, marker: process.env.CC_PLUGIN_MARKER }) + "\\n");',
		'if (args[0] === "plugin" && args[1] === "list") {',
		'  process.stdout.write(JSON.stringify({ installed: [], available: [{ pluginId: "demo", marketplaceName: "main", installed: false }] }));',
		'} else if (args[0] === "plugin" && args[1] === "marketplace" && args[2] === "list") {',
		'  process.stdout.write(JSON.stringify({ marketplaces: [{ name: "main", source: "owner/repo" }] }));',
		'} else { process.stdout.write("{}"); }',
	].join("\n"));
	if (process.platform !== "win32") fs.chmodSync(fakeCli, 0o755);

	const commandApp = (activeKey, agentName) => {
		const notices = [];
		const errors = [];
		const selections = [];
		const markdown = [];
		const app = Object.create(HarnessApp.prototype);
		app.activeKey = activeKey;
		app.transport = "acp";
		app.config = {
			agents: {
				[activeKey]: {
					label: activeKey,
					env: { CODEX_PATH: fakeCli, CC_PLUGIN_LOG: log, CC_PLUGIN_MARKER: `${activeKey}-env` },
				},
			},
		};
		app.client = { agentInfo: { name: agentName } };
		app.sessionStates = new Map([[activeKey, { agentInfo: { name: agentName } }]]);
		app.availableCommands = new Map([[activeKey, []]]);
		app.statusState = "";
		app.addCommandMessage = () => {};
		app.addNotice = (message) => notices.push(message);
		app.addError = (message) => errors.push(message);
		app.updateSpinner = () => {};
		app.ui = { requestRender() {} };
		app.openSelection = (title) => selections.push(title);
		app.showMarkdownBlock = (text) => markdown.push(text);
		return { app, notices, errors, selections, markdown };
	};

	try {
		const codex = commandApp("codex", "@agentclientprotocol/codex-acp");
		await codex.app.openPluginsDialog("marketplace add C:\\plugins\\market");
		await codex.app.openPluginsDialog("marketplace add owner/repo --ref main --sparse plugins/demo");
		await codex.app.openPluginsDialog("marketplace list");
		await codex.app.openPluginsDialog("marketplace upgrade main");
		await codex.app.openPluginsDialog("marketplace remove main");
		await codex.app.openPluginsDialog("refresh");
		assert.deepEqual(codex.errors, []);
		assert.equal(codex.markdown.length, 1);
		assert.deepEqual(
			fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
			[
				{ args: ["plugin", "marketplace", "add", "C:\\plugins\\market", "--json"], marker: "codex-env" },
				{ args: ["plugin", "marketplace", "add", "owner/repo", "--ref", "main", "--sparse", "plugins/demo", "--json"], marker: "codex-env" },
				{ args: ["plugin", "marketplace", "list", "--json"], marker: "codex-env" },
				{ args: ["plugin", "marketplace", "upgrade", "main", "--json"], marker: "codex-env" },
				{ args: ["plugin", "marketplace", "remove", "main", "--json"], marker: "codex-env" },
				{ args: ["plugin", "marketplace", "upgrade", "--json"], marker: "codex-env" },
				{ args: ["plugin", "list", "--available", "--json"], marker: "codex-env" },
			],
		);
		codex.app.showHelp();
		assert.match(codex.notices.at(-1), /^\/plugins/m);

		const before = fs.statSync(log).size;
		const claude = commandApp("claude", "claude-agent-acp");
		await claude.app.openPluginsDialog("");
		await claude.app.runCodexDoctor();
		await claude.app.openExperimentalFeatures("");
		assert.equal(fs.statSync(log).size, before, "non-Codex commands must not invoke the configured Codex CLI");
		assert.equal(claude.notices.filter((message) => message.includes("only while the Codex backend is active")).length, 3);
		claude.app.showHelp();
		assert.doesNotMatch(claude.notices.at(-1), /^\/(?:plugins|doctor|experimental)\b/m);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Native Codex helpers use the active agent's CODEX_HOME/CODEX_PATH environment,
// and confirmed named deletion resolves within the adapter's active model
// provider before adding --force.
if (process.platform !== "win32" && spawnSync("sqlite3", ["--version"]).status === 0) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-native-"));
	const previousNativeForks = process.env.CC_FORKS;
	process.env.CC_FORKS = path.join(root, "forks.json");
	const codexHome = path.join(root, "codex-home");
	const dbPath = path.join(codexHome, "state_5.sqlite");
	const executable = path.join(root, "fake-codex");
	const log = path.join(root, "native.log");
	const targetId = "11111111-2222-7333-8444-555555555555";
	const otherProviderId = "66666666-7777-7888-8999-aaaaaaaaaaaa";
	fs.mkdirSync(codexHome, { recursive: true });
	fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$CC_TEST_LOG\"\nexit \"${CC_TEST_EXIT:-0}\"\n");
	fs.chmodSync(executable, 0o755);
	const schema = [
		"create table threads (",
		"id text, cwd text, title text, first_user_message text, preview text,",
		"updated_at integer, updated_at_ms integer, archived integer, source text, thread_source text, model_provider text",
		");",
		"insert into threads values (",
		`'${targetId}', ${JSON.stringify(process.cwd())}, 'Named session', '', '',`,
		"100, 100000, 0, 'cli', 'user', 'custom-gateway');",
		"insert into threads values (",
		`'${otherProviderId}', ${JSON.stringify(process.cwd())}, 'Named session', '', '',`,
		"200, 200000, 0, 'cli', 'user', 'openai');",
	].join(" ");
	const created = spawnSync("sqlite3", [dbPath, schema], { encoding: "utf8" });
	assert.equal(created.status, 0, created.stderr || created.error?.message);
	const errors = [];
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.config = {
		agents: {
			codex: {
				env: {
					CODEX_HOME: codexHome,
					CODEX_PATH: executable,
					CC_TEST_LOG: log,
					MODEL_PROVIDER: "custom-gateway",
				},
			},
		},
	};
	app.client = { sessionId: "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee" };
	app.ready = true;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => errors.push(message);
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.runFencedCodexAppServerRequests = async (_invocation, requests) => {
		assert.equal(requests[0].method, "thread/list");
		assert.equal(requests[0].params.ancestorThreadId, targetId);
		return [{ data: [], nextCursor: null }];
	};
	await app.deleteSessionPermanently("Named session", { codex: true, current: false });
	assert.deepEqual(errors, []);
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["delete", targetId, "--force"]);

	const recoveryHarness = () => {
		const calls = [];
		const failures = [];
		let stopCount = 0;
		const recoveryApp = Object.create(HarnessApp.prototype);
		recoveryApp.activeKey = "codex";
		recoveryApp.transport = "acp";
		recoveryApp.busy = false;
		recoveryApp.ready = true;
		recoveryApp.sessionSwitchInProgress = false;
		recoveryApp.promptQueue = [];
		recoveryApp.deferredLocalSlashCommands = [];
		recoveryApp.statusState = "";
		recoveryApp.config = {
			agents: {
				codex: {
					env: {
						CODEX_HOME: codexHome,
						CODEX_PATH: executable,
						CC_TEST_LOG: log,
						CC_TEST_EXIT: "7",
						MODEL_PROVIDER: "custom-gateway",
					},
				},
			},
		};
		recoveryApp.client = {
			sessionId: targetId,
			stop() {
				assert.equal(recoveryApp.sessionSwitchInProgress, true, "native current-session work must own the transition before stopping");
				stopCount += 1;
			},
		};
		recoveryApp.addCommandMessage = () => {};
		recoveryApp.addNotice = () => {};
		recoveryApp.addError = (message) => failures.push(message);
		recoveryApp.resetConversationView = () => calls.push(["reset"]);
		recoveryApp.switchAgent = async (key, transport, options) => {
			calls.push(["switch", key, transport, {
				quiet: options.quiet,
				statusState: options.statusState,
				loadSessionId: options.loadSessionId,
				continueSessionSwitch: options.continueSessionSwitch,
				beforeSessionReplay: typeof options.beforeSessionReplay === "function",
			}]);
			options.beforeSessionReplay?.();
			recoveryApp.ready = true;
		};
		recoveryApp.schedulePromptQueueDrain = () => {};
		recoveryApp.updateSpinner = () => {};
		recoveryApp.ui = { requestRender() {} };
		return { recoveryApp, calls, failures, stopCount: () => stopCount };
	};

	const archiveRecovery = recoveryHarness();
	await archiveRecovery.recoveryApp.runCodexSessionCommand("archive", "Named session");
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["archive", targetId]);
	assert.equal(archiveRecovery.stopCount(), 1, "a current session addressed by name must be detected and stopped");
	assert.deepEqual(archiveRecovery.calls, [
		["switch", "codex", "acp", {
			quiet: true,
			statusState: "reloading session",
			loadSessionId: targetId,
			continueSessionSwitch: true,
			beforeSessionReplay: true,
		}],
		["reset"],
	]);
	assert.equal(archiveRecovery.recoveryApp.sessionSwitchInProgress, false);
	assert.ok(archiveRecovery.failures.some((message) => message.includes("Codex archive failed")));

	const deleteRecovery = recoveryHarness();
	await deleteRecovery.recoveryApp.deleteSessionPermanently(targetId, { codex: true, current: true });
	assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n"), ["delete", targetId, "--force"]);
	assert.equal(deleteRecovery.stopCount(), 1);
	assert.deepEqual(deleteRecovery.calls, [
		["switch", "codex", "acp", {
			quiet: true,
			statusState: "reloading session",
			loadSessionId: targetId,
			continueSessionSwitch: true,
			beforeSessionReplay: true,
		}],
		["reset"],
	]);
	assert.equal(deleteRecovery.recoveryApp.sessionSwitchInProgress, false);
	assert.ok(deleteRecovery.failures.some((message) => message.includes("Could not delete session")));
	if (previousNativeForks === undefined) delete process.env.CC_FORKS;
	else process.env.CC_FORKS = previousNativeForks;
	fs.rmSync(root, { recursive: true, force: true });
}

// A disconnected delete command cannot drift onto a harness selected while its
// reconnect is in flight.
await (async () => {
	let pickerOpened = false;
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "first";
	app.activeAgentGeneration = 0;
	app.transport = "acp";
	app.config = { agents: { first: {}, second: {} } };
	app.client = { exited: true };
	app.busy = false;
	app.switchAgent = async () => {
		app.activeKey = "second";
		app.activeAgentGeneration += 1;
		app.client = { sessionId: "second-session", capabilities: { delete: true } };
	};
	app.openSelection = () => { pickerOpened = true; };
	await app.openDeleteDialog();
	assert.equal(pickerOpened, false);
})();

// Generic ACP deletion accepts the title displayed by /resume, but sends the
// corresponding opaque session id on the wire.
await (async () => {
	const deleted = [];
	const errors = [];
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.client = {
		sessionId: "current-id",
		capabilities: { delete: true, sessionList: true },
		listSessions: async () => [
			{ sessionId: "current-id", title: "Current" },
			{ sessionId: "target-id", title: "Named session" },
		],
		deleteSession: async (sessionId) => deleted.push(sessionId),
	};
	app.ready = true;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => errors.push(message);
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	await app.deleteSessionPermanently("Named session", { codex: false, current: false });
	assert.deepEqual(errors, []);
	assert.deepEqual(deleted, ["target-id"]);
})();

// A backend may tear down the live session before its persistent delete fails.
// Recover the current transcript instead of leaving a stale, "ready" client.
await (async () => {
	const calls = [];
	const errors = [];
	const oldClient = {
		sessionId: "current-id",
		capabilities: { delete: true, resume: true },
		deleteSession: async () => {
			oldClient.tornDown = true;
			throw new Error("persistent delete failed");
		},
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "claude",
		transport: "acp",
		client: oldClient,
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		statusState: "",
		config: { agents: { claude: {} } },
		ui: { requestRender() {} },
		addCommandMessage() {},
		addNotice() {},
		addError(message) { errors.push(message); },
		updateSpinner() {},
		resetConversationView() { calls.push(["reset"]); },
		schedulePromptQueueDrain() {},
		async switchAgent(key, transport, options) {
			calls.push(["switch", key, transport, options.loadSessionId, options.continueSessionSwitch]);
			options.beforeSessionReplay?.();
			this.client = { sessionId: options.loadSessionId };
			this.ready = true;
		},
	});
	await app.deleteSessionPermanently("current-id", { codex: false, current: true });
	assert.equal(oldClient.tornDown, true);
	assert.equal(app.ready, true);
	assert.notEqual(app.client, oldClient);
	assert.equal(app.client.sessionId, "current-id");
	assert.deepEqual(calls, [
		["switch", "claude", "acp", "current-id", true],
		["reset"],
	]);
	assert.ok(errors.some((message) => message.includes("Could not delete session")));
})();

// Delete and resume are independent ACP capabilities. If a delete-only backend
// tears down the current session before failing, recover with a fresh session
// rather than sending an unadvertised session/resume request.
await (async () => {
	const switches = [];
	let resets = 0;
	const oldClient = {
		sessionId: "delete-only-session",
		capabilities: { delete: true, resume: false },
		deleteSession: async () => { throw new Error("delete failed after teardown"); },
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "delete-only",
		transport: "acp",
		client: oldClient,
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		statusState: "",
		config: { agents: { "delete-only": {} } },
		ui: { requestRender() {} },
		addCommandMessage() {},
		addNotice() {},
		addError() {},
		updateSpinner() {},
		resetConversationView() { resets += 1; },
		schedulePromptQueueDrain() {},
		async switchAgent(key, transport, options) {
			switches.push({ key, transport, options });
			this.client = { sessionId: "fresh-session", exited: false };
			this.ready = true;
		},
	});
	await app.deleteSessionPermanently("delete-only-session", { codex: false, current: true });
	assert.equal(switches.length, 1);
	assert.equal(switches[0].options.loadSessionId, undefined);
	assert.equal(switches[0].options.continueSessionSwitch, true);
	assert.equal(app.client.sessionId, "fresh-session");
	assert.equal(app.ready, true);
	assert.equal(resets, 1);
})();

// Fork registry: legacy flat IDs remain readable for resume labels, while v2
// parent edges are durable, cycle-safe, deepest-first deletion ownership.
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-forks-"));
	const prev = process.env.CC_FORKS;
	process.env.CC_FORKS = path.join(dir, "forks.json");
	try {
		fs.writeFileSync(process.env.CC_FORKS, `${JSON.stringify({ forks: ["legacy-fork"] })}\n`);
		assert.ok(loadForkIds().has("legacy-fork"));
		recordForkId("fork-aaa");
		recordForkId("fork-bbb");
		recordForkId("fork-aaa"); // dedup
		recordForkId("fork-child", "fork-aaa");
		recordForkId("fork-grandchild", "fork-child");
		recordForkId(""); // ignored
		recordForkId(undefined); // ignored
		const ids = loadForkIds();
		assert.equal(ids.size, 5);
		assert.ok(ids.has("fork-aaa") && ids.has("fork-bbb"));
		assert.equal(loadForkParents().get("fork-child"), "fork-aaa");
		assert.deepEqual(loadForkDescendantIds("fork-aaa"), ["fork-grandchild", "fork-child"]);
		// Persisted across a fresh load.
		assert.ok(loadForkIds().has("fork-bbb"));
		forgetForkIds(["fork-grandchild", "fork-child"]);
		assert.deepEqual(loadForkDescendantIds("fork-aaa"), []);

		// Relationship records are safety state and are never discarded by the
		// 500-entry cosmetic label cap.
		const relationshipForks = Array.from({ length: 510 }, (_, index) => `owned-${index}`);
		fs.writeFileSync(process.env.CC_FORKS, `${JSON.stringify({
			version: 2,
			forks: relationshipForks,
			parents: Object.fromEntries(relationshipForks.map((id) => [id, "owned-root"])),
		})}\n`);
		recordForkId("cosmetic-label");
		assert.equal(loadForkParents().size, 510);
		assert.equal(loadForkDescendantIds("owned-root").length, 510);

		// A live long-running owner is never stolen as "stale"; contenders time out
		// safely. Once released, the same lock can be acquired again.
		const releaseLive = await acquireForkOperationLock({ operation: "test live owner" });
		await assert.rejects(
			acquireForkOperationLock({ operation: "test contender", timeoutMs: 25 }),
			/another cc process is changing Codex fork storage/,
		);
		releaseLive();
		releaseLive();
		const releaseAgain = await acquireForkOperationLock({ operation: "test reacquire", timeoutMs: 100 });
		releaseAgain();

		// Stable cc and beta cc2 share this lock. Its directory/owner.json shape must
		// remain readable by the previous stable reaper even after the mtime exceeds
		// that version's 30-second stale threshold.
		const releaseCrossVersion = await acquireForkOperationLock({ operation: "test old stable compatibility" });
		const crossVersionLock = `${process.env.CC_FORKS}.operation-lock`;
		fs.utimesSync(crossVersionLock, new Date(0), new Date(0));
		const oldReader = spawnSync(process.execPath, ["-e", `
const fs = require("node:fs");
const lock = process.argv[1];
const hostname = process.argv[2];
const stat = fs.statSync(lock);
let owner;
try { owner = JSON.parse(fs.readFileSync(lock + "/owner.json", "utf8")); } catch {}
let alive;
try { process.kill(Number(owner?.pid), 0); alive = true; }
catch (error) { alive = error?.code === "EPERM" ? true : error?.code === "ESRCH" ? false : undefined; }
const wouldReap = owner?.released === true || !(
  owner?.hostname === hostname && alive === true
) && !(alive === undefined && Date.now() - stat.mtimeMs < 30000);
process.stdout.write(wouldReap ? "reap" : "keep");
`, crossVersionLock, os.hostname()], { encoding: "utf8" });
		assert.equal(oldReader.status, 0, oldReader.stderr);
		assert.equal(oldReader.stdout, "keep", "the previous stable cc recognizes the new live owner PID");
		releaseCrossVersion();

		// A lock whose same-host owner is definitely gone is reclaimed immediately,
		// rather than poisoning fork/delete operations for the rest of the process.
		const abandonedLock = `${process.env.CC_FORKS}.operation-lock`;
		const exitedOwner = spawnSync(process.execPath, ["-e", ""]);
		const writeOperationLockOwner = (owner) => {
			fs.mkdirSync(abandonedLock);
			fs.writeFileSync(path.join(abandonedLock, "owner.json"), `${JSON.stringify(owner)}\n`);
		};
		writeOperationLockOwner({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "abandoned",
		});
		const releaseRecovered = await acquireForkOperationLock({ operation: "test stale recovery", timeoutMs: 100 });
		releaseRecovered();
		assert.equal(fs.existsSync(abandonedLock), false);

		// A holder that could not unlink its lock marks it released. That
		// explicit handoff is reclaimable even if the hostname changed meanwhile.
		writeOperationLockOwner({
			protocolVersion: 3,
			pid: process.pid,
			hostname: "previous-hostname",
			token: "released",
			released: true,
		});
		const releaseMarked = await acquireForkOperationLock({ operation: "test released recovery", timeoutMs: 100 });
		releaseMarked();
		assert.equal(fs.existsSync(abandonedLock), false);

		// The fixed mutation guard is exclusive. A second stale-lock reclaimer
		// started from inside the first one's deterministic pre-rename hook must not
		// enter its own mutation section before the first finishes.
		writeOperationLockOwner({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-for-overlap",
		});
		let overlappingReclaim;
		let overlapEnteredMutation = false;
		const releaseAfterOverlap = await acquireForkOperationLock({
			operation: "test exclusive mutation owner",
			timeoutMs: 100,
			_testBeforeReclaimRename({ lockPath }) {
				assert.equal(fs.existsSync(`${lockPath}.mutation`), true);
				overlappingReclaim ??= acquireForkOperationLock({
					operation: "test overlapping reclaimer",
					timeoutMs: 25,
					_testBeforeReclaimRename() { overlapEnteredMutation = true; },
				});
			},
		});
		await assert.rejects(overlappingReclaim, /another cc process is changing Codex fork storage/);
		assert.equal(overlapEnteredMutation, false);
		releaseAfterOverlap();
		assert.equal(fs.existsSync(`${abandonedLock}.mutation`), false);

		// A process can die after publishing the mutation guard but before removing
		// it. The recorded local PID makes that abandoned marker reclaimable instead
		// of permanently poisoning every later operation.
		const mutationMarker = `${abandonedLock}.mutation`;
		const writeMutationMarker = (owner) => {
			fs.writeFileSync(mutationMarker, `${JSON.stringify(owner)}\n`, { flag: "wx" });
		};
		writeMutationMarker({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "abandoned-mutation",
		});
		const releaseAfterMutationCrash = await acquireForkOperationLock({
			operation: "test abandoned mutation recovery",
			timeoutMs: 100,
		});
		assert.equal(fs.existsSync(mutationMarker), false);
		releaseAfterMutationCrash();

		// Reclamation verifies the marker token after its atomic move. If a live
		// successor replaces the stale marker between observation and rename, that
		// successor is restored and the contender remains blocked.
		writeMutationMarker({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-mutation-before-aba",
		});
		let mutationMarkerReplaced = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test mutation marker ABA",
				timeoutMs: 50,
				_testBeforeMutationReclaimRename({ markerPath }) {
					if (mutationMarkerReplaced) return;
					mutationMarkerReplaced = true;
					fs.rmSync(markerPath, { force: true });
					fs.writeFileSync(markerPath, `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "live-mutation-successor",
					})}\n`, { flag: "wx" });
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(mutationMarkerReplaced, true);
		assert.equal(JSON.parse(fs.readFileSync(mutationMarker, "utf8")).token, "live-mutation-successor");
		fs.rmSync(mutationMarker, { force: true });

		// A mutation claimant also verifies its canonical token after publication.
		// If a stale-marker reclaimer moves/replaces that publication, it never
		// proceeds to rename the operation lock under lost ownership.
		writeOperationLockOwner({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-lock-under-mutation-publication",
		});
		let mutationPublicationReplaced = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test mutation publication ownership",
				timeoutMs: 25,
				_testAfterMutationPublish({ markerPath }) {
					if (mutationPublicationReplaced) return;
					mutationPublicationReplaced = true;
					fs.rmSync(markerPath, { force: true });
					fs.writeFileSync(markerPath, `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "live-after-mutation-publication",
					})}\n`, { flag: "wx" });
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(mutationPublicationReplaced, true);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(abandonedLock, "owner.json"), "utf8")).token,
			"stale-lock-under-mutation-publication",
		);
		assert.equal(JSON.parse(fs.readFileSync(mutationMarker, "utf8")).token, "live-after-mutation-publication");
		fs.rmSync(mutationMarker, { force: true });
		fs.rmSync(abandonedLock, { recursive: true, force: true });

		// Ambiguous mutation owners remain fail-closed: a malformed marker, a
		// foreign-host marker, or a live local owner cannot be stolen.
		for (const marker of [
			"not json\n",
			`${JSON.stringify({ protocolVersion: 3, pid: exitedOwner.pid, hostname: "other-host", token: "foreign" })}\n`,
			`${JSON.stringify({ protocolVersion: 3, pid: process.pid, hostname: os.hostname(), token: "live" })}\n`,
		]) {
			fs.writeFileSync(mutationMarker, marker, { flag: "wx" });
			await assert.rejects(
				acquireForkOperationLock({ operation: "test fail-closed mutation marker", timeoutMs: 25 }),
				/another cc process is changing Codex fork storage/,
			);
			assert.equal(fs.readFileSync(mutationMarker, "utf8"), marker);
			fs.rmSync(mutationMarker, { force: true });
		}

		// Reclamation verifies the token after atomically moving the lock. A
		// successor that appears between the stale read and rename is restored, not
		// deleted by the old owner's reaper (the classic ABA race).
		writeOperationLockOwner({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-before-aba",
		});
		let replacedDuringReclaim = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test ABA contender",
				timeoutMs: 50,
				_testBeforeReclaimRename({ lockPath }) {
					if (replacedDuringReclaim) return;
					replacedDuringReclaim = true;
					fs.rmSync(lockPath, { recursive: true, force: true });
					fs.mkdirSync(lockPath);
					fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "live-successor",
					})}\n`);
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(replacedDuringReclaim, true);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(abandonedLock, "owner.json"), "utf8")).token,
			"live-successor",
		);
		fs.rmSync(abandonedLock, { recursive: true, force: true });

		// Legacy mkdir-then-owner publication can be paused while owner.json is
		// absent. Current reclaimers leave that ambiguous directory fail-closed.
		fs.mkdirSync(abandonedLock);
		await assert.rejects(
			acquireForkOperationLock({ operation: "test ownerless legacy lock", timeoutMs: 25 }),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(fs.existsSync(abandonedLock), true);
		fs.rmSync(abandonedLock, { recursive: true, force: true });

		// Deterministically pause an old stable publisher after its canonical mkdir.
		// The new publisher's atomic mkdir loses with EEXIST and must preserve that
		// ownerless old claim rather than replacing it with a candidate directory.
		let oldOwnerlessInterleaved = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test old ownerless publication interleave",
				timeoutMs: 25,
				_testBeforeOperationPublish({ lockPath }) {
					if (oldOwnerlessInterleaved) return;
					oldOwnerlessInterleaved = true;
					fs.mkdirSync(lockPath);
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(oldOwnerlessInterleaved, true);
		assert.equal(fs.statSync(abandonedLock).isDirectory(), true);
		assert.equal(fs.existsSync(path.join(abandonedLock, "owner.json")), false);
		fs.rmSync(abandonedLock, { recursive: true, force: true });

		// If the just-created directory is externally replaced before owner publish,
		// failed cleanup validates dev/ino and token and leaves the successor intact.
		let publicationClaimReplaced = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test publication cleanup identity",
				timeoutMs: 50,
				_testAfterOperationMkdirBeforeOwner({ lockPath }) {
					if (publicationClaimReplaced) return;
					publicationClaimReplaced = true;
					fs.rmSync(lockPath, { recursive: true, force: true });
					fs.mkdirSync(lockPath);
					fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "publication-successor",
					})}\n`);
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(publicationClaimReplaced, true);
		assert.equal(
			JSON.parse(fs.readFileSync(path.join(abandonedLock, "owner.json"), "utf8")).token,
			"publication-successor",
		);
		fs.rmSync(abandonedLock, { recursive: true, force: true });

		// Registry writes use the same token-verified protocol, rather than the old
		// mtime+rm lock that could delete a live successor after an ABA replacement.
		const registryLock = `${process.env.CC_FORKS}.lock`;
		fs.writeFileSync(registryLock, `${JSON.stringify({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-registry-owner",
		})}\n`);
		recordForkId("registry-lock-recovered", undefined, { required: true, timeoutMs: 100 });
		assert.equal(loadForkIds().has("registry-lock-recovered"), true);
		assert.equal(fs.existsSync(registryLock), false);

		fs.writeFileSync(registryLock, `${JSON.stringify({
			protocolVersion: 3,
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "stale-registry-before-aba",
		})}\n`);
		let registryReplacedDuringReclaim = false;
		assert.throws(
			() => recordForkId("registry-write-must-not-run", undefined, {
				required: true,
				timeoutMs: 50,
				_testBeforeReclaimRename({ lockPath }) {
					if (registryReplacedDuringReclaim) return;
					registryReplacedDuringReclaim = true;
					fs.rmSync(lockPath, { force: true });
					fs.writeFileSync(lockPath, `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "live-registry-successor",
					})}\n`);
				},
			}),
			/could not update the fork registry.*timed out waiting for the fork registry lock/,
		);
		assert.equal(registryReplacedDuringReclaim, true);
		assert.equal(JSON.parse(fs.readFileSync(registryLock, "utf8")).token, "live-registry-successor");
		assert.equal(loadForkIds().has("registry-write-must-not-run"), false);
		fs.rmSync(registryLock, { force: true });

		// A pre-protocol stable cc that crashed while holding the operation lock
		// (owner.json without protocolVersion) is reclaimed with the previous
		// release's dead-PID rule instead of blocking session operations forever.
		writeOperationLockOwner({
			pid: exitedOwner.pid,
			hostname: os.hostname(),
			token: "legacy-owner",
		});
		const releaseLegacyRecovered = await acquireForkOperationLock({ operation: "test legacy stale recovery", timeoutMs: 100 });
		releaseLegacyRecovered();
		assert.equal(fs.existsSync(abandonedLock), false);

		// A leftover legacy mkdir-style registry lock ages out on mtime as before.
		fs.mkdirSync(registryLock);
		fs.utimesSync(registryLock, new Date(0), new Date(0));
		recordForkId("legacy-registry-lock-recovered", undefined, { required: true, timeoutMs: 100 });
		assert.equal(loadForkIds().has("legacy-registry-lock-recovered"), true);
		assert.equal(fs.existsSync(registryLock), false);

		// A mutation marker that becomes stuck after a contender has published its
		// registry lock times out instead of blocking the event loop forever, and
		// the timed-out contender unpublishes its own lock.
		let stuckRegistryMarkerPlanted = false;
		assert.throws(
			() => recordForkId("registry-stuck-mutation", undefined, {
				required: true,
				timeoutMs: 50,
				_testBeforeRegistryPublish({ lockPath }) {
					if (stuckRegistryMarkerPlanted) return;
					stuckRegistryMarkerPlanted = true;
					fs.writeFileSync(`${lockPath}.mutation`, `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "stuck-live-mutation",
					})}\n`, { flag: "wx" });
				},
			}),
			/could not update the fork registry.*timed out waiting for the fork registry lock/,
		);
		assert.equal(stuckRegistryMarkerPlanted, true);
		assert.equal(fs.existsSync(registryLock), false, "the timed-out contender unpublishes its lock");
		fs.rmSync(`${registryLock}.mutation`, { force: true });
		recordForkId("registry-after-stuck-mutation", undefined, { required: true, timeoutMs: 100 });
		assert.equal(loadForkIds().has("registry-after-stuck-mutation"), true);

		// Same deadline for the async operation-lock variant.
		let stuckOperationMarkerPlanted = false;
		await assert.rejects(
			acquireForkOperationLock({
				operation: "test stuck mutation deadline",
				timeoutMs: 50,
				_testBeforeOperationPublish({ lockPath }) {
					if (stuckOperationMarkerPlanted) return;
					stuckOperationMarkerPlanted = true;
					fs.writeFileSync(`${lockPath}.mutation`, `${JSON.stringify({
						protocolVersion: 3,
						pid: process.pid,
						hostname: os.hostname(),
						token: "stuck-live-operation-mutation",
					})}\n`, { flag: "wx" });
				},
			}),
			/another cc process is changing Codex fork storage/,
		);
		assert.equal(stuckOperationMarkerPlanted, true);
		assert.equal(fs.existsSync(abandonedLock), false, "the timed-out contender unpublishes its lock");
		fs.rmSync(`${abandonedLock}.mutation`, { force: true });
	} finally {
		if (prev === undefined) delete process.env.CC_FORKS;
		else process.env.CC_FORKS = prev;
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// The new beta launcher shares Codex fork lineage with stable. Import the old
// isolated cc2 registry, preserve already-authoritative shared relations, and
// consume cumulative deltas from old processes without reviving deleted forks.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-beta-fork-migration-"));
	const target = path.join(root, "shared", "forks.json");
	const source = path.join(root, "channels", "beta", "state", "config", "forks.json");
	const previousForks = process.env.CC_FORKS;
	const previousMigrationSource = process.env.CC_FORKS_MIGRATE_FROM;
	process.env.CC_FORKS = target;
	process.env.CC_FORKS_MIGRATE_FROM = source;
	try {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.mkdirSync(path.dirname(source), { recursive: true });
		fs.writeFileSync(target, `${JSON.stringify({
			version: 2,
			forks: ["shared-only", "conflict-child"],
			parents: { "conflict-child": "shared-parent" },
		})}\n`);
		const legacyContents = `${JSON.stringify({
			version: 2,
			forks: ["beta-only", "conflict-child", "beta-child", "late-lineage-child"],
			parents: {
				"conflict-child": "beta-parent",
				"beta-child": "beta-root",
			},
		})}\n`;
		fs.writeFileSync(source, legacyContents);

		let removalAttempted = false;
		assert.equal(await migrateLegacyForkRegistry({
			_testBeforeLegacySourceRemoval() {
				removalAttempted = true;
				throw Object.assign(new Error("simulated unlink denial"), { code: "EACCES" });
			},
		}), true);
		assert.equal(removalAttempted, true);
		assert.equal(fs.existsSync(source), true, "source cleanup failure does not undo the durable marker");
		assert.equal(fs.existsSync(`${source}.migration-complete`), true);
		assert.equal(await migrateLegacyForkRegistry(), false, "the marked snapshot is not imported twice");
		assert.equal(fs.existsSync(source), false, "the imported legacy registry is consumed");
		assert.deepEqual(
			new Set(loadForkIds()),
			new Set(["shared-only", "conflict-child", "beta-only", "beta-child", "late-lineage-child"]),
		);
		assert.equal(loadForkParents().get("conflict-child"), "shared-parent");
		assert.equal(loadForkParents().get("beta-child"), "beta-root");

		forgetForkIds("beta-only", { required: true });
		fs.writeFileSync(source, `${JSON.stringify({
			version: 2,
			forks: ["beta-only", "conflict-child", "beta-child", "late-lineage-child", "late-a"],
			parents: {
				"conflict-child": "beta-parent",
				"beta-child": "beta-root",
				"late-lineage-child": "late-root",
				"late-a": "beta-child",
			},
		})}\n`);
		fs.writeFileSync(`${source}.lock`, `${JSON.stringify({
			protocolVersion: 3,
			pid: process.pid,
			hostname: os.hostname(),
			token: "live-legacy-writer",
		})}\n`);
		await assert.rejects(
			migrateLegacyForkRegistry({ timeoutMs: 25 }),
			/timed out waiting for the fork registry lock/,
		);
		assert.equal(fs.existsSync(source), true, "migration never consumes a snapshot while an old writer owns it");
		fs.rmSync(`${source}.lock`, { force: true });
		assert.equal(await migrateLegacyForkRegistry(), true, "a late writer contributes new IDs and lineage");
		assert.equal(loadForkIds().has("beta-only"), false, "a deleted fork is not re-added from a stale snapshot");
		assert.equal(loadForkParents().get("late-lineage-child"), "late-root");
		assert.equal(loadForkParents().get("late-a"), "beta-child");

		forgetForkIds(["late-a", "late-lineage-child"], { required: true });
		fs.writeFileSync(source, `${JSON.stringify({
			version: 2,
			forks: ["beta-only", "conflict-child", "beta-child", "late-lineage-child", "late-a", "late-b"],
			parents: {
				"conflict-child": "beta-parent",
				"beta-child": "beta-root",
				"late-lineage-child": "late-root",
				"late-a": "beta-child",
				"late-b": "late-root",
			},
		})}\n`);
		assert.equal(await migrateLegacyForkRegistry(), true, "a second late writer contributes only unseen lineage");
		assert.equal(loadForkIds().has("beta-only"), false);
		assert.equal(loadForkIds().has("late-a"), false);
		assert.equal(loadForkIds().has("late-lineage-child"), false);
		assert.equal(loadForkParents().get("late-b"), "late-root");

		// Replaying an entirely consumed snapshot is harmless and is consumed again.
		fs.writeFileSync(source, legacyContents);
		assert.equal(await migrateLegacyForkRegistry(), false);
		assert.equal(fs.existsSync(source), false);
		const marker = JSON.parse(fs.readFileSync(`${source}.migration-complete`, "utf8"));
		assert.equal(marker.version, 2);
		assert.equal(marker.consumedForks.includes("late-a"), true);
		assert.equal(marker.consumedForks.includes("late-b"), true);
		assert.equal(
			marker.consumedParentRelations.some(([child, parent]) => child === "late-lineage-child" && parent === "late-root"),
			true,
		);

		// Builds that already wrote the one-shot v1 marker still import the first
		// recreated snapshot, then upgrade to cumulative tracking.
		fs.writeFileSync(`${source}.migration-complete`, `${JSON.stringify({
			version: 1,
			target,
			completedAt: new Date().toISOString(),
		})}\n`);
		fs.writeFileSync(source, `${JSON.stringify({
			version: 2,
			forks: ["v1-late-child"],
			parents: { "v1-late-child": "v1-late-parent" },
		})}\n`);
		assert.equal(await migrateLegacyForkRegistry(), true);
		assert.equal(loadForkParents().get("v1-late-child"), "v1-late-parent");
		assert.equal(JSON.parse(fs.readFileSync(`${source}.migration-complete`, "utf8")).version, 2);
	} finally {
		if (previousForks === undefined) delete process.env.CC_FORKS;
		else process.env.CC_FORKS = previousForks;
		if (previousMigrationSource === undefined) delete process.env.CC_FORKS_MIGRATE_FROM;
		else process.env.CC_FORKS_MIGRATE_FROM = previousMigrationSource;
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// ACP feature negotiation: boolean config, URL elicitation, and client-run
// terminal auth must be declared up front or agents omit those features.
await (async () => {
	const requests = [];
	const client = new AcpClient(
		{ command: "fake" },
		() => {},
		{ onElicitationRequest: async () => ({ action: "cancel" }) },
	);
	client.start = () => {};
	client.request = async (method, params) => {
		requests.push({ method, params });
		if (method === "initialize") {
			return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		}
		if (method === "session/new") return { sessionId: "s", configOptions: [] };
		return {};
	};
	await client.initialize();
	assert.equal(requests[0].params.clientCapabilities.auth.terminal, true);
	assert.deepEqual(requests[0].params.clientCapabilities.session.configOptions.boolean, {});
	assert.deepEqual(requests[0].params.clientCapabilities.plan, {});
	assert.deepEqual(requests[0].params.clientCapabilities.elicitation.url, {});

	const unsupportedRequests = [];
	const unsupportedClient = new AcpClient({ command: "fake" }, () => {});
	unsupportedClient.start = () => {};
	unsupportedClient.request = async (method, params) => {
		unsupportedRequests.push({ method, params });
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") return { sessionId: "s", configOptions: [] };
		return {};
	};
	await unsupportedClient.initialize();
	assert.equal(
		Object.prototype.hasOwnProperty.call(unsupportedRequests[0].params.clientCapabilities, "elicitation"),
		false,
		"URL elicitation stays unadvertised when the client has no handler",
	);
})();

// Saved cc model defaults override whatever the native CLI reports for every new
// ACP session, before that session is exposed to the TUI.
await (async () => {
	const requests = [];
	const configOptions = [
		{ id: "model", category: "model", currentValue: "native-model", options: [] },
		{ id: "thought_level", category: "thought_level", currentValue: "low", options: [] },
	];
	const client = new AcpClient({ command: "fake", _sessionDefaults: { model: "cc-model", effort: "high" } }, () => {});
	client.start = () => {};
	client.request = async (method, params) => {
		requests.push({ method, params });
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") return { sessionId: "saved-defaults", configOptions };
		if (method === "session/set_config_option") {
			return {
				configOptions: configOptions.map((option) => option.id === params.configId
					? { ...option, currentValue: params.value }
					: option),
			};
		}
		return {};
	};
	await client.initialize();
	assert.deepEqual(
		requests.filter((entry) => entry.method === "session/set_config_option").map((entry) => [entry.params.configId, entry.params.value]),
		[["model", "cc-model"], ["thought_level", "high"]],
		"cc-owned defaults override native CLI state before the session becomes usable",
	);
	await client.loadSession("existing-session");
	assert.equal(
		requests.filter((entry) => entry.method === "session/set_config_option").length,
		2,
		"loading an existing session preserves its own model and effort",
	);

	const lateRequests = [];
	const lateClient = new AcpClient({ command: "fake", _sessionDefaults: { model: "cc-model", effort: "high" } }, () => {});
	lateClient.start = () => {};
	lateClient.request = async (method, params) => {
		lateRequests.push({ method, params });
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") return { sessionId: "late-defaults" };
		if (method === "session/set_config_option") return { configOptions };
		return {};
	};
	await lateClient.initialize();
	const promptPromise = lateClient.prompt("hello");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(
		lateRequests.some((entry) => entry.method === "session/prompt"),
		false,
		"the first prompt waits while saved defaults may still arrive",
	);
	lateClient.handleSessionUpdate({
		sessionId: "late-defaults",
		update: { sessionUpdate: "config_option_update", configOptions },
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(
		lateRequests.filter((entry) => entry.method === "session/set_config_option").map((entry) => [entry.params.configId, entry.params.value]),
		[["model", "cc-model"], ["thought_level", "high"]],
		"new-session defaults are applied when config options arrive asynchronously",
	);
	await promptPromise;
	assert.equal(lateRequests.at(-1).method, "session/prompt", "the prompt runs after late defaults settle");
})();

// A harness that reports its model only through the ACP models snapshot has no
// settable model option: a saved default the snapshot proves is already current
// must not stall the first prompt behind the startup-defaults deadline or emit
// a session/set_config_option request. (A default the snapshot does NOT prove
// current may still be satisfied by a config option that arrives late, and
// keeps waiting until the deadline — covered by the late-defaults test above.)
await (async () => {
	const requests = [];
	const client = new AcpClient({ command: "fake", _sessionDefaults: { model: "provider/model-id" } }, () => {});
	client.start = () => {};
	client.request = async (method, params) => {
		requests.push({ method, params });
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") {
			return {
				sessionId: "models-only",
				models: {
					currentModelId: "provider/model-id",
					availableModels: [{ modelId: "provider/model-id", name: "Friendly Model" }],
				},
			};
		}
		return {};
	};
	await client.initialize();
	assert.equal(client.pendingStartupConfigDefaults, undefined, "models-snapshot sessions consume saved defaults immediately");
	const started = Date.now();
	await client.prompt("hello");
	assert.ok(Date.now() - started < 1_000, "the first prompt is not gated on unappliable startup defaults");
	assert.equal(requests.some((entry) => entry.method === "session/set_config_option"), false);
	assert.equal(requests.at(-1).method, "session/prompt");
})();

// _ccStartupRequestedModel is published only after the saved model default is
// actually applied, so a rejected startup request cannot feed the legacy-alias
// migration with the agent's own fallback model.
await (async () => {
	const rejecting = new AcpClient({ command: "fake", _sessionDefaults: { model: "sol" } }, () => {});
	rejecting.start = () => {};
	rejecting.request = async (method) => {
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") {
			return {
				sessionId: "reject-model",
				configOptions: [{ id: "model", category: "model", currentValue: "gpt-5.7-sol", options: [] }],
			};
		}
		if (method === "session/set_config_option") throw new Error("model retired");
		return {};
	};
	await rejecting.initialize();
	assert.equal(
		rejecting.getSessionInfo()._ccStartupRequestedModel,
		undefined,
		"a rejected startup model is not advertised as requested",
	);

	const applying = new AcpClient({ command: "fake", _sessionDefaults: { model: "sol" } }, () => {});
	applying.start = () => {};
	applying.request = async (method, params) => {
		if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
		if (method === "session/new") {
			return {
				sessionId: "apply-model",
				configOptions: [{ id: "model", category: "model", currentValue: "gpt-5.7-sol", options: [] }],
			};
		}
		if (method === "session/set_config_option") {
			return { configOptions: [{ id: "model", category: "model", currentValue: params.value, options: [] }] };
		}
		return {};
	};
	await applying.initialize();
	assert.equal(
		applying.getSessionInfo()._ccStartupRequestedModel,
		"sol",
		"an applied startup model is advertised for the alias migration",
	);
})();

// The footer resolves models-snapshot ids to friendly names, applies the
// persisted display, and keeps the persisted effort for harnesses without a
// thought_level option.
{
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "pi";
	app.focusedThread = "main";
	app.config = {
		settings: {
			agents: { pi: { sessionDefaults: { model: "provider/model-id", modelDisplay: "Friendly Model", effort: "high" } } },
		},
	};
	app.sessionStates = new Map();
	app.client = {
		sessionId: "live",
		getSessionInfo: () => ({
			models: {
				currentModelId: "provider/model-id",
				availableModels: [{ modelId: "provider/model-id", name: "Provider Name" }],
			},
		}),
	};
	assert.deepEqual(
		app.modelAndEffortForStatus(),
		{ model: "Friendly Model", effort: "high" },
		"a live models snapshot keeps the persisted display name and effort",
	);
	app.client.getSessionInfo = () => ({
		models: {
			currentModelId: "provider/other-model",
			availableModels: [{ modelId: "provider/other-model", name: "Other Model" }],
		},
	});
	assert.deepEqual(
		app.modelAndEffortForStatus(),
		{ model: "Other Model", effort: "high" },
		"an unrelated live model resolves to its snapshot name instead of the raw id",
	);
}

// A saved model id the agent still advertises through the models snapshot must
// not be rewritten by the legacy-alias migration.
{
	const app = Object.create(HarnessApp.prototype);
	app.config = { settings: { agents: { pi: { sessionDefaults: { model: "sol", modelDisplay: "Sol" } } } } };
	const persisted = [];
	app.persistModelPreference = (...args) => {
		persisted.push(args);
		return true;
	};
	assert.equal(app.alignPersistedModelDisplay("pi", {
		_ccStartupRequestedModel: "sol",
		models: {
			currentModelId: "gpt-5.6-sol",
			availableModels: [
				{ modelId: "sol", name: "Sol" },
				{ modelId: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
			],
		},
	}), false, "a models-snapshot agent's advertised saved id is not mistaken for an alias");
	assert.deepEqual(persisted, []);
}

// Auto-captured backend defaults stabilize the footer but land under captured*
// keys, so they are never replayed as session/new startup requests.
{
	const previousCapturedSettings = process.env.CC_SETTINGS;
	const capturedSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-captured-defaults-"));
	process.env.CC_SETTINGS = path.join(capturedSettingsDir, "settings.json");
	try {
		const app = Object.create(HarnessApp.prototype);
		app.activeKey = "pi";
		app.config = { theme: "system", settings: { agents: {} }, agents: { pi: {} } };
		assert.equal(app.alignPersistedModelDisplay("pi", {
			_ccCreatedSession: true,
			models: {
				currentModelId: "provider/model-id",
				availableModels: [{ modelId: "provider/model-id", name: "Friendly Model" }],
			},
		}), true);
		assert.deepEqual(app.config.settings.agents.pi.sessionDefaults, {
			capturedModel: "provider/model-id",
			capturedModelDisplay: "Friendly Model",
		});
		assert.deepEqual(app.config.agents.pi._sessionDefaults, {}, "captured defaults are not replayed on session/new");
		const reloaded = applyHarnessSettings(
			{ agents: { pi: {} } },
			JSON.parse(fs.readFileSync(process.env.CC_SETTINGS, "utf8")),
		);
		assert.deepEqual(
			reloaded.agents.pi._sessionDefaults ?? {},
			{},
			"captured defaults never materialize startup session defaults",
		);
	} finally {
		if (previousCapturedSettings === undefined) delete process.env.CC_SETTINGS;
		else process.env.CC_SETTINGS = previousCapturedSettings;
		fs.rmSync(capturedSettingsDir, { recursive: true, force: true });
	}
}

// Boolean configuration requires a tagged value; legacy select config must stay
// untagged for compatibility with older ACP agents.
await (async () => {
	const requests = [];
	const client = new AcpClient({ command: "fake" }, () => {});
	client.sessionId = "s";
	client.request = async (method, params) => {
		requests.push({ method, params });
		return { configOptions: [] };
	};
	await client.setConfigOption("fast-mode", true, "boolean");
	await client.setConfigOption("legacy-fast", "on", "select");
	assert.deepEqual(requests[0], {
		method: "session/set_config_option",
		params: { sessionId: "s", configId: "fast-mode", value: true, type: "boolean" },
	});
	assert.deepEqual(requests[1], {
		method: "session/set_config_option",
		params: { sessionId: "s", configId: "legacy-fast", value: "on" },
	});
})();

// Mode/config representations stay synchronized, and a late config response
// from an abandoned same-client session cannot overwrite the replacement.
await (async () => {
	const client = new AcpClient({ command: "fake" }, () => {});
	client.sessionId = "old-session";
	client.configOptions = [{ id: "mode", category: "mode", currentValue: "agent", options: [] }];
	client.modes = {
		currentModeId: "agent",
		availableModes: [{ id: "agent" }, { id: "agent-full-access" }, { id: "plan" }],
	};
	client.request = async () => ({});
	await client.setMode("agent-full-access");
	assert.equal(client.modes.currentModeId, "agent-full-access");
	assert.equal(client.configOptions[0].currentValue, "agent-full-access");
	client.request = async () => ({
		configOptions: [{ id: "mode", category: "mode", currentValue: "plan", options: [] }],
	});
	await client.setConfigOption("mode", "plan");
	assert.equal(client.modes.currentModeId, "plan");

	let release;
	client.request = () => new Promise((resolve) => { release = resolve; });
	const stale = client.setConfigOption("mode", "agent");
	client.sessionId = "new-session";
	client.configOptions = [{ id: "mode", category: "mode", currentValue: "plan", options: [] }];
	release({ configOptions: [{ id: "mode", category: "mode", currentValue: "agent", options: [] }] });
	await stale;
	assert.equal(client.configOptions[0].currentValue, "plan");
})();

// The HarnessApp UI layer must preserve the option type when it delegates the
// selection; otherwise the transport-level boolean support above is unreachable.
await (async () => {
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.client = { setConfigOption: async (...args) => calls.push(args) };
	app.statusState = "";
	app.updateSpinner = () => {};
	app.addCommandMessage = () => {};
	app.addError = (message) => assert.fail(message);
	app.updateAutocomplete = () => {};
	app.ui = { requestRender() {} };
	await app.setConfigValue({ id: "fast-mode", category: "model_config", type: "boolean" }, true, "On");
	assert.deepEqual(calls, [["fast-mode", true, "boolean"]]);
})();

// Config RPCs gate prompts and never fall back onto a replacement same-client
// session after /new or /resume changes its session id.
await (async () => {
	let rejectConfig;
	const queued = [];
	const errors = [];
	const client = {
		sessionId: "old-session",
		setConfigOption: () => new Promise((_resolve, reject) => { rejectConfig = reject; }),
		setMode: async () => assert.fail("stale mode fallback must not run"),
	};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.client = client;
	app.ready = true;
	app.busy = false;
	app.statusState = "";
	app.addCommandMessage = () => assert.fail("stale config success must not render");
	app.addError = (message) => errors.push(message);
	app.updateAutocomplete = () => {};
	app.updateSpinner = () => {};
	app.enqueuePrompt = (text) => queued.push(text);
	app.ui = { requestRender() {} };
	const updating = app.setConfigValue({ id: "mode", category: "mode" }, "plan", "Plan");
	await Promise.resolve();
	assert.equal(app.configUpdateCount, 1);
	await app.submitBackendPrompt("wait for config");
	assert.deepEqual(queued, ["wait for config"]);
	client.sessionId = "new-session";
	rejectConfig(new Error("old session disappeared"));
	await updating;
	assert.deepEqual(errors, []);
	assert.equal(app.configUpdateCount, 0);
})();

// Authentication, logout, and delete use the standard ACP request shapes.
await (async () => {
	const requests = [];
	const client = new AcpClient({ command: "fake" }, () => {});
	client.sessionId = "s";
	client.request = async (method, params) => {
		requests.push({ method, params });
		return {};
	};
	await client.authenticate("chat-gpt");
	await client.authenticate("api-key", { "api-key": { apiKey: "secret" } });
	await client.logout();
	await client.deleteSession("old-session");
	assert.deepEqual(requests, [
		{ method: "authenticate", params: { methodId: "chat-gpt" } },
		{ method: "authenticate", params: { methodId: "api-key", _meta: { "api-key": { apiKey: "secret" } } } },
		{ method: "logout", params: {} },
		{ method: "session/delete", params: { sessionId: "old-session" } },
	]);
})();

// Per-agent MCP servers and extra roots survive settings application and are
// normalized into every ACP session lifecycle request.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-extra-root-"));
	const settings = {
		agents: {
			codex: {
				additionalDirectories: [root, root, process.cwd()],
				mcpServers: [
					{ name: "stdio", command: process.execPath, args: ["server.mjs"], env: { TOKEN: "x" } },
					{ type: "http", name: "remote", url: "https://example.test/mcp", headers: { Authorization: "Bearer x" } },
					{ type: "sse", name: "unsupported", url: "https://example.test/sse" },
				],
			},
		},
	};
	const applied = applyHarnessSettings(config, settings);
	assert.equal(applied.agents.codex.additionalDirectories[0], root);
	assert.equal(applied.agents.codex.mcpServers.length, 3);
	const client = new AcpClient(applied.agents.codex, () => {});
	client.capabilities = {
		sessionCapabilities: { additionalDirectories: {} },
		mcpCapabilities: { http: true, sse: false, acp: false },
	};
	const originalCwd = process.cwd();
	process.chdir(root);
	assert.equal(client.sessionRequestParams().cwd, process.cwd(), "ordinary adapters resolve cwd at each request as before workflows");
	process.chdir(originalCwd);
	assert.equal(client.sessionRequestParams().cwd, originalCwd);
		client.sessionCwd = root;
		client.workflowChild = true;
		assert.equal(client.sessionRequestParams().cwd, ".", "a workflow child sends the backend its inherited pinned cwd reference, not a reopenable pathname");
	const params = client.sessionRequestParams({ sessionId: "s" });
	assert.deepEqual(params.additionalDirectories, [root]);
	assert.deepEqual(params.mcpServers, [
		{ name: "stdio", command: process.execPath, args: ["server.mjs"], env: [{ name: "TOKEN", value: "x" }] },
		{
			type: "http",
			name: "remote",
			url: "https://example.test/mcp",
			headers: [{ name: "Authorization", value: "Bearer x" }],
		},
	]);
	assert.deepEqual(normalizeAdditionalDirectories([root, root, process.cwd()]), [root]);
	assert.deepEqual(normalizeMcpServers(settings.agents.codex.mcpServers, { http: true }), params.mcpServers);
	assert.deepEqual(normalizeMcpServers(settings.agents.codex.mcpServers), [
		{ name: "stdio", command: process.execPath, args: ["server.mjs"], env: [{ name: "TOKEN", value: "x" }] },
	]);
	fs.rmSync(root, { recursive: true, force: true });
}

// Windows cannot execute npm's .cmd shims through CreateProcess. Convert a
// trusted Node shim (not its shell program) into node + JavaScript argv, while
// dropping batch files and unparseable command shims.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-mcp-windows-shim-"));
	try {
		const entrypoint = path.join(root, "node_modules", "npm", "bin", "npx-cli.js");
		fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
		fs.writeFileSync(entrypoint, "// npx entrypoint\n");
		const shim = path.join(root, "npx.cmd");
		fs.writeFileSync(shim, '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*\r\n');
		const unsafe = path.join(root, "unsafe.cmd");
		fs.writeFileSync(unsafe, "@ECHO off\r\necho unsafe %*\r\n");
		const batch = path.join(root, "server.bat");
		fs.writeFileSync(batch, "@ECHO off\r\n");
		assert.deepEqual(
			normalizeMcpServers(
				[
					{ name: "npx", command: shim, args: ["-y", "@example/mcp"] },
					{ name: "unsafe", command: unsafe },
					{ name: "batch", command: batch },
				],
				undefined,
				{ Path: "" },
				"win32",
			),
			[{
				name: "npx",
				command: process.execPath,
				args: [fs.realpathSync(entrypoint), "-y", "@example/mcp"],
				env: [],
			}],
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// @file references become embedded ACP resources without matching email-like
// text, and retain ordering around images and multiple text chunks.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-embedded-"));
	const first = path.join(root, "first.txt");
	const spaced = path.join(root, "file with spaces.md");
	fs.writeFileSync(first, "alpha");
	fs.writeFileSync(spaced, "beta");
	fs.writeFileSync(path.join(root, "reviewer"), "agent collision");
	const built = buildEmbeddedFilePromptParts("email@example.test read @first.txt and @\"file with spaces.md\"", root);
	assert.equal(built.embeddedCount, 2);
	assert.equal(built.parts.filter((part) => part.type === "resource").length, 2);
	assert.ok(built.parts[0].text.includes("email@example.test read "));
	assert.equal(built.parts[1].resource.text, "alpha");
	const punctuated = buildEmbeddedFilePromptParts("read @first.txt.", root);
	assert.equal(punctuated.embeddedCount, 1);
	assert.equal(punctuated.parts.find((part) => part.type === "resource").resource.text, "alpha");
	assert.equal(punctuated.parts.at(-1).text, ".");
	const duplicate = buildEmbeddedFilePromptParts("read @first.txt then compare @first.txt", root);
	assert.equal(duplicate.embeddedCount, 1, "the same resolved file is embedded only once");
	assert.equal(duplicate.parts.filter((part) => part.type === "resource").length, 1);
	assert.match(duplicate.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), /@first\.txt/);

	const boundedNames = Array.from({ length: 40 }, (_, index) => `bounded-${index}.txt`);
	for (const name of boundedNames) fs.writeFileSync(path.join(root, name), String(name));
	const bounded = buildEmbeddedFilePromptParts(boundedNames.map((name) => `@${name}`).join(" "), root);
	assert.equal(bounded.embeddedCount, 32, "aggregate mention count is bounded");
	assert.equal(bounded.parts.filter((part) => ["resource", "resource_link"].includes(part.type)).length, 32);
	assert.match(bounded.parts.filter((part) => part.type === "text").map((part) => part.text).join(""), /@bounded-32\.txt/);

	fs.writeFileSync(path.join(root, "bytes-a.txt"), "12345678");
	fs.writeFileSync(path.join(root, "bytes-b.txt"), "abcdefgh");
	const byteBounded = buildEmbeddedFilePromptParts("@bytes-a.txt @bytes-b.txt", root, { maxTotalBytes: 10 });
	assert.deepEqual(byteBounded.parts.filter((part) => part.type !== "text").map((part) => part.type), ["resource", "resource_link"]);
	assert.equal(
		byteBounded.parts.filter((part) => part.type === "resource").reduce((total, part) => total + Buffer.byteLength(part.resource.text), 0),
		8,
		"aggregate embedded contents stay within the byte cap",
	);
	if (process.platform === "win32") {
		const driveFile = path.join(root, "drive-note.txt");
		fs.writeFileSync(driveFile, "drive");
		if (!/\s/.test(driveFile)) {
			const driveBuilt = buildEmbeddedFilePromptParts(`read @${driveFile}`, root);
			assert.equal(driveBuilt.embeddedCount, 1);
			assert.equal(driveBuilt.parts.find((part) => part.type === "resource").resource.text, "drive");
		}
	} else {
		// ':' and '\\' are legal filename characters on POSIX, which lets this
		// exercise the Windows drive-letter tokenization branch cross-platform.
		const driveName = "C:\\drive-note.txt";
		fs.writeFileSync(path.join(root, driveName), "drive");
		const driveBuilt = buildEmbeddedFilePromptParts(`read @${driveName}`, root);
		assert.equal(driveBuilt.embeddedCount, 1);
		assert.equal(driveBuilt.parts.find((part) => part.type === "resource").resource.text, "drive");
	}
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.config = { agents: { fake: { label: "Fake" } } };
	app.sessionStates = new Map([
		["fake", {
			capabilities: { promptCapabilities: { image: true, embeddedContext: true } },
			configOptions: [{
				id: "agent",
				type: "select",
				options: [{ value: "reviewer", name: "File-name agent" }],
			}],
		}],
	]);
	app.client = {
		capabilities: { promptCapabilities: { image: true, embeddedContext: true } },
		configOptions: app.sessionStates.get("fake").configOptions,
	};
	app.addNotice = () => {};
	app.clipboardImageCounter = 0;
	app.clipboardImages = [];
	app.menuHandle = undefined;
	let editorText = "Discuss the literal [Image 1]";
	app.editor = {
		getText: () => editorText,
		setText: (text) => { editorText = text; },
	};
	const collisionFreeLabel = app.nextClipboardImageLabel();
	assert.equal(collisionFreeLabel, "[Image 2]");
	app.clipboardImages.push({ label: collisionFreeLabel, data: "aW1hZ2Uy", mimeType: "image/png" });
	const previousCwd = process.cwd();
	process.chdir(root);
	try {
		const agentCollision = app.promptForActiveCapabilities("ask @reviewer");
		assert.equal(agentCollision, "ask @reviewer", "advertised @agents remain literal even when a same-named file exists");
		const explicitCollisionFile = app.promptForActiveCapabilities('read @"reviewer"');
		assert.equal(explicitCollisionFile.find((part) => part.type === "resource").resource.text, "agent collision");
		const collisionText = `Discuss the literal [Image 1], inspect @first.txt, then use ${collisionFreeLabel}.`;
		const collisionParts = app.consumeImagePromptParts(collisionText);
		const collisionPayload = app.promptForActiveCapabilities(collisionText, collisionParts);
		assert.deepEqual(collisionPayload.map((part) => part.type), ["text", "resource", "text", "image", "text"]);
		assert.ok(collisionPayload[0].text.includes("literal [Image 1]"));
		assert.equal(collisionPayload[1].resource.text, "alpha");
		assert.equal(collisionPayload[3].data, "aW1hZ2Uy");

		// Queue/unsend/session-switch recovery must retain the exact placeholder
		// associated with an image, not the first literal [Image n] in the text.
		editorText = "";
		app.restoreQueuedTextToComposer([{ text: collisionText, promptParts: collisionParts }]);
		assert.deepEqual(app.clipboardImages.map((image) => image.label), ["[Image 2]"]);
		const recoveredParts = app.consumeImagePromptParts(editorText);
		assert.deepEqual(recoveredParts.map((part) => part.type), ["text", "image", "text"]);
		assert.ok(recoveredParts[0].text.includes("literal [Image 1]"));
		assert.equal(recoveredParts[1].data, "aW1hZ2Uy");

		const mixed = app.promptForActiveCapabilities("ignored", [
			{ type: "text", text: "start @first.txt " },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			{ type: "text", text: " end @\"file with spaces.md\"" },
		]);
		assert.deepEqual(mixed.map((part) => part.type), ["text", "resource", "text", "image", "text", "resource"]);
		assert.equal(mixed[1].resource.text, "alpha");
		assert.equal(mixed.at(-1).resource.text, "beta");
		const duplicateAcrossParts = app.promptForActiveCapabilities("ignored", [
			{ type: "text", text: "first @first.txt" },
			{ type: "text", text: "again @first.txt" },
		]);
		assert.equal(duplicateAcrossParts.filter((part) => part.type === "resource").length, 1);
		assert.match(duplicateAcrossParts.filter((part) => part.type === "text").map((part) => part.text).join(""), /again @first\.txt/);
		const sideThreadPayload = app.promptForActiveCapabilities("side @first.txt", undefined, {
			capabilities: { promptCapabilities: { image: true, embeddedContext: true } },
			onNotice: () => assert.fail("supported side-thread context should not warn"),
		});
		assert.deepEqual(sideThreadPayload.map((part) => part.type), ["text", "resource"]);
		assert.equal(sideThreadPayload[1].resource.text, "alpha");
			const slashText = "/review inspect @first.txt and continue";
			const slashWithResource = app.promptForActiveCapabilities(slashText);
			assert.deepEqual(slashWithResource.map((part) => part.type), ["text", "resource"]);
			assert.equal(slashWithResource[0].text, slashText, "the complete backend command remains block zero");
			assert.equal(slashWithResource[1].resource.text, "alpha", "backend commands retain @file context");
			const slashWithAttachments = app.promptForActiveCapabilities(slashText, [
					{ type: "text", text: "/review inspect @first.txt and use " },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				]);
			assert.deepEqual(slashWithAttachments.map((part) => part.type), ["text", "resource", "image"]);
			assert.equal(slashWithAttachments[0].text, slashText);
			assert.equal(slashWithAttachments[1].resource.text, "alpha");
			assert.equal(slashWithAttachments[2].data, "aW1hZ2U=");
	} finally {
		process.chdir(previousCwd);
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Configured skills are completed using their native $skill syntax rather than
// being forced through the slash-command namespace.
await (async () => {
	const provider = new LazyCombinedAutocompleteProvider(
		[{ name: "$fake-skill", description: "Use the fake skill" }, { name: "status" }],
		process.cwd(),
		null,
	);
	const suggestions = await provider.getSuggestions(["ask $fa"], 0, 7, { force: false });
	assert.deepEqual(suggestions.items.map((item) => item.value), ["$fake-skill"]);
	const applied = provider.applyCompletion(["ask $fa"], 0, 7, suggestions.items[0], suggestions.prefix);
	assert.equal(applied.lines[0], "ask $fake-skill ");
	const slash = await provider.getSuggestions(["/"], 0, 1, {
		force: false,
		signal: new AbortController().signal,
	});
	assert.deepEqual(slash.items.map((item) => item.value), ["status"]);

	const app = new HarnessApp(config, "codex", "acp");
	app.ui.requestRender = () => {};
	const originalOnSubmit = app.editor.onSubmit;
	const submitted = [];
	app.editor.onSubmit = (text) => submitted.push(text);
	for (const sequence of ["\x1b[13;3u", "\x1b[27;3;13~", "\x1b\r"]) {
		app.editor.setText("first line");
		app.editor.handleInput(sequence);
		for (const character of "second line") app.editor.handleInput(character);
		assert.equal(app.editor.getText(), "first line\nsecond line");
		assert.deepEqual(submitted, [], "Option+Return inserts a newline without submitting");
	}
	app.editor.setText("submit normally");
	app.editor.handleInput("\r");
	assert.deepEqual(submitted, ["submit normally"], "plain Return still submits the editor contents");
	app.editor.onSubmit = originalOnSubmit;
	app.availableCommands.set("codex", [{ name: "$fake-skill", description: "Use the fake skill" }]);
	app.updateAutocomplete();
	// Paste handling cancels Pi's popup. The wrapper must reopen it from the
	// resulting token, and a character typed before that request settles must
	// retrigger against the latest prefix rather than leaving completion dead.
	app.editor.handleInput("\x1b[200~ask $fa\x1b[201~");
	app.editor.handleInput("k");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(app.editor.getText(), "ask $fak");
	assert.equal(app.editor.autocompleteState, "regular");
	assert.equal(app.editor.autocompleteList?.getSelectedItem()?.value, "$fake-skill");
	app.editor.setText("");
	app.editor.cancelAutocomplete();
	app.editor.handleInput("$");
	app.editor.handleInput("z");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(app.editor.autocompleteState, null, "a no-match skill prefix closes completion");
	app.editor.handleInput("\x7f");
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(app.editor.getText(), "$");
	assert.equal(app.editor.autocompleteState, "regular", "backspace reopens completion for the now-valid skill prefix");
	assert.equal(app.editor.autocompleteList?.getSelectedItem()?.value, "$fake-skill");
	app.voiceController.dispose();
})();

// @file completion must still work when fd is not installed; the lazy wrapper
// falls back to the provider's local directory scan.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-at-complete-"));
	fs.writeFileSync(path.join(root, "README-local.md"), "x");
	try {
		const provider = new LazyCombinedAutocompleteProvider([], root, null);
		const suggestions = await provider.getSuggestions(["@README"], 0, 7, {
			force: false,
			signal: new AbortController().signal,
		});
		assert.ok(suggestions.items.some((item) => item.label === "README-local.md"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Backend status must remain reachable, while wrapper diagnostics have the
// unambiguous /cc-status name. Cold-start Codex status is forwarded too.
await (async () => {
	const local = [];
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.config = config;
	app.sessionStates = new Map([["codex", {}]]);
	app.availableCommands = new Map([["codex", [{ name: "status", description: "Backend status" }]]]);
	app.commandsLoaded = new Set(["codex"]);
	app.runLocalSlashCommand = async (name) => local.push(name);
	app.shouldOpenCodexReviewDialog = HarnessApp.prototype.shouldOpenCodexReviewDialog;
	app.isKnownCodexReviewCommand = HarnessApp.prototype.isKnownCodexReviewCommand;
	assert.equal(await app.handleSlashCommand("/status"), "backend");
	assert.equal(await app.handleSlashCommand("/cc-status"), true);
	assert.deepEqual(local, ["cc-status"]);
	app.availableCommands.set("codex", []);
	app.commandsLoaded.clear();
	assert.equal(await app.handleSlashCommand("/status"), "backend");
})();

// Windows URL elicitation resolves the inbox Explorer executable directly. A
// checkout-local explorer.exe must never be able to intercept a one-time URL.
await (async () => {
	assert.equal(
		windowsExplorerPath({ systemroot: "D:\\WinRoot" }),
		"D:\\WinRoot\\System32\\explorer.exe",
	);
	assert.equal(
		windowsExplorerPath({ SystemRoot: "relative\\shadow" }),
		"C:\\Windows\\System32\\explorer.exe",
	);
	let launch;
	const tracker = {};
	await openExternalUrl("https://example.test/auth?first=one&second=two", {
		platform: "win32",
		environment: { SYSTEMROOT: "E:\\Windows" },
		processTracker: tracker,
		runCaptureImpl: async (command, args, options) => {
			launch = { command, args, options };
		},
	});
	assert.deepEqual(launch, {
		command: "E:\\Windows\\System32\\explorer.exe",
		args: ["https://example.test/auth?first=one&second=two"],
		options: { timeoutMs: 5_000, processTracker: tracker },
	});
	assert.equal(path.win32.isAbsolute(launch.command), true);
})();

// macOS URL elicitation likewise bypasses PATH and invokes the system launcher
// directly, so a repository-local `open` cannot receive authentication URLs.
await (async () => {
	let launch;
	const tracker = {};
	await openExternalUrl("https://example.test/auth?token=secret", {
		platform: "darwin",
		processTracker: tracker,
		runCaptureImpl: async (command, args, options) => {
			launch = { command, args, options };
		},
	});
	assert.deepEqual(launch, {
		command: "/usr/bin/open",
		args: ["https://example.test/auth?token=secret"],
		options: { timeoutMs: 5_000, processTracker: tracker },
	});
})();

// Linux URL elicitation selects only fixed system locations and fails before
// invoking a runner when none are installed. It never falls back to a bare
// PATH-resolved xdg-open command.
await (async () => {
	assert.equal(
		linuxExternalUrlLauncherPath({ isExecutable: (candidate) => candidate === "/bin/xdg-open" }),
		"/bin/xdg-open",
	);
	assert.throws(
		() => linuxExternalUrlLauncherPath({ isExecutable: () => false }),
		(error) => error.code === "CC_URL_LAUNCHER_UNAVAILABLE" && /trusted system xdg-open/.test(error.message),
	);
	let launch;
	await openExternalUrl("https://example.test/auth?token=secret", {
		platform: "linux",
		isExecutable: (candidate) => candidate === "/usr/bin/xdg-open",
		runCaptureImpl: async (command, args, options) => {
			launch = { command, args, options };
		},
	});
	assert.deepEqual(launch, {
		command: "/usr/bin/xdg-open",
		args: ["https://example.test/auth?token=secret"],
		options: { timeoutMs: 5_000, processTracker: undefined },
	});
	let runnerCalls = 0;
	await assert.rejects(
		openExternalUrl("https://example.test/auth", {
			platform: "linux",
			isExecutable: () => false,
			runCaptureImpl: async () => { runnerCalls += 1; },
		}),
		(error) => error.code === "CC_URL_LAUNCHER_UNAVAILABLE",
	);
	assert.equal(runnerCalls, 0);
})();

// Copying a one-time URL uses only fixed operating-system clipboard binaries.
// Ordinary /copy keeps its existing PATH-based compatibility behavior.
await (async () => {
	const secret = "https://example.test/auth?token=one-time-secret";
	const macCalls = [];
	await writeSecretClipboardText(secret, {
		platform: "darwin",
		pipeToCommandImpl: async (...args) => { macCalls.push(args); },
	});
	assert.deepEqual(macCalls, [["/usr/bin/pbcopy", [], secret]]);

	const windowsCalls = [];
	await writeSecretClipboardText(secret, {
		platform: "win32",
		environment: { systemroot: "D:\\WinRoot" },
		pipeToCommandImpl: async (...args) => { windowsCalls.push(args); },
	});
	assert.deepEqual(windowsCalls, [["D:\\WinRoot\\System32\\clip.exe", [], secret]]);

	const linuxCalls = [];
	await writeSecretClipboardText(secret, {
		platform: "linux",
		pipeToCommandImpl: async (command, args, input) => {
			linuxCalls.push([command, args, input]);
			if (command === "/usr/bin/xclip") return;
			throw new Error("not installed");
		},
	});
	assert.deepEqual(linuxCalls.map(([command]) => command), [
		"/usr/bin/wl-copy",
		"/bin/wl-copy",
		"/run/current-system/sw/bin/wl-copy",
		"/usr/bin/xclip",
	]);
	assert.ok(linuxCalls.every(([command, _args, input]) => path.posix.isAbsolute(command) && input === secret));
	assert.deepEqual(linuxCalls.at(-1)[1], ["-selection", "clipboard"]);
})();

// URL elicitation is routed to the host callback and always receives a response,
// including a safe cancellation when the callback fails.
await (async () => {
	const cases = [
		{ value: { action: "accept" }, expected: { action: "accept" } },
		{ value: undefined, expected: { action: "cancel" } },
		{ value: { action: "unsupported" }, expected: { action: "cancel" } },
		{ error: new Error("nope"), expected: { action: "cancel" } },
	];
	for (const testCase of cases) {
		const writes = [];
		const client = Object.create(AcpClient.prototype);
		client.sessionId = "s";
		client.pending = new Map();
		client.bufferingSessionUpdates = false;
		client.onEvent = () => {};
		client.writeSafe = (message) => writes.push(message);
		client.onElicitationRequest = async () => {
			if (testCase.error) throw testCase.error;
			return testCase.value;
		};
		client.handleLine(JSON.stringify({
			jsonrpc: "2.0",
			id: 99,
			method: "elicitation/create",
			params: { sessionId: "s", mode: "url", message: "Sign in", url: "https://example.test/auth", elicitationId: "e" },
		}));
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(writes[0], {
			jsonrpc: "2.0",
			id: 99,
			result: testCase.expected,
		});
	}
})();

// A TUI selection callback can be delivered again while an async elicitation is
// settling; only the first answer may resolve and advance the shared queue.
await (async () => {
	let select;
	let resolved = 0;
	let drained = 0;
	let closed = 0;
	const app = Object.create(HarnessApp.prototype);
	app.permissionPromptActive = true;
	app.closeMenu = () => { closed += 1; };
	app.drainPermissionQueue = () => { drained += 1; };
	app.openSelection = (_title, _entries, callback) => { select = callback; };
	app.openElicitationRequest({
		params: { mode: "url", message: "Sign in", url: "https://example.test/auth" },
		resolve: () => { resolved += 1; },
	});
	await select({ value: "decline" });
	await select(undefined);
	assert.equal(resolved, 1);
	assert.equal(drained, 1);
	assert.equal(closed, 1);
	assert.equal(app.permissionPromptActive, false);
})();

// Failed authentication URL delivery never prints or acknowledges the secret.
// The same picker stays live so the user can retry or cancel explicitly.
await (async () => {
	const secretUrl = "https://example.test/auth?token=one-time-copy-secret";
	let select;
	let pickerEntries;
	let copyAttempts = 0;
	let copyShouldFail = true;
	let closed = 0;
	let drained = 0;
	const results = [];
	const messages = [];
	const app = Object.create(HarnessApp.prototype);
	app.permissionPromptActive = true;
	app.closeMenu = () => { closed += 1; };
	app.drainPermissionQueue = () => { drained += 1; };
	app.addError = (message) => messages.push(message);
	app.addNotice = (message) => messages.push(message);
	app.copyAuthenticationUrl = async (url) => {
		assert.equal(url, secretUrl);
		copyAttempts += 1;
		if (copyShouldFail) throw new Error(`clipboard rejected ${secretUrl}`);
	};
	app.openSelection = (_title, entries, callback) => {
		pickerEntries = entries;
		select = callback;
	};
	app.openElicitationRequest({
		params: { mode: "url", message: "Sign in", url: secretUrl },
		resolve: (result) => results.push(result),
	});
	assert.doesNotMatch(JSON.stringify(pickerEntries), /one-time-copy-secret/u);
	await select({ value: "copy" });
	assert.equal(copyAttempts, 1);
	assert.deepEqual(results, [], "a failed clipboard write is not acknowledged");
	assert.equal(closed, 0, "the picker remains open after a failed clipboard write");
	assert.equal(drained, 0);
	assert.equal(app.permissionPromptActive, true);
	assert.doesNotMatch(messages.join("\n"), /one-time-copy-secret|https:\/\//u);
	copyShouldFail = false;
	await select({ value: "copy" });
	assert.equal(copyAttempts, 2);
	assert.deepEqual(results, [{ action: "accept" }]);
	assert.equal(closed, 1);
	assert.equal(drained, 1);
	assert.equal(app.permissionPromptActive, false);
})();

await (async () => {
	const secretUrl = "https://example.test/auth?token=one-time-browser-secret";
	let select;
	let openAttempts = 0;
	let openShouldFail = true;
	let closed = 0;
	let drained = 0;
	const results = [];
	const messages = [];
	const app = Object.create(HarnessApp.prototype);
	app.permissionPromptActive = true;
	app.closeMenu = () => { closed += 1; };
	app.drainPermissionQueue = () => { drained += 1; };
	app.addError = (message) => messages.push(message);
	app.addNotice = (message) => messages.push(message);
	app.openAuthenticationUrl = async (url) => {
		assert.equal(url, secretUrl);
		openAttempts += 1;
		if (openShouldFail) throw new Error(`browser rejected ${secretUrl}`);
	};
	app.openSelection = (_title, _entries, callback) => { select = callback; };
	app.openElicitationRequest({
		params: { mode: "url", message: "Sign in", url: secretUrl },
		resolve: (result) => results.push(result),
	});
	await select({ value: "open" });
	assert.equal(openAttempts, 1);
	assert.deepEqual(results, [], "a failed browser launch is not acknowledged");
	assert.equal(closed, 0, "the picker remains open after a failed browser launch");
	assert.equal(drained, 0);
	assert.equal(app.permissionPromptActive, true);
	assert.doesNotMatch(messages.join("\n"), /one-time-browser-secret|https:\/\//u);
	openShouldFail = false;
	await select({ value: "open" });
	assert.equal(openAttempts, 2, "the browser option can be retried after failure");
	assert.deepEqual(results, [{ action: "accept" }]);
	assert.equal(closed, 1);
	assert.equal(drained, 1);
	assert.equal(app.permissionPromptActive, false);
})();

// Esc still settles an elicitation while the browser opener is in flight. An
// unsupported scheme gives this test an async rejection without launching an
// external application.
await (async () => {
	let select;
	const results = [];
	let drained = 0;
	const app = Object.create(HarnessApp.prototype);
	app.permissionPromptActive = true;
	app.closeMenu = () => {};
	app.drainPermissionQueue = () => { drained += 1; };
	app.addError = (message) => assert.fail(message);
	app.openSelection = (_title, _entries, callback) => { select = callback; };
	app.openElicitationRequest({
		params: { mode: "url", message: "Sign in", url: "ftp://example.test/auth" },
		resolve: (result) => results.push(result),
	});
	const opening = select({ value: "open" });
	await select(undefined);
	await opening;
	assert.deepEqual(results, [{ action: "cancel" }]);
	assert.equal(drained, 1);
	assert.equal(app.permissionPromptActive, false);
})();

// A failed automatic session start leaves advertised auth methods on the live
// client, and /login can authenticate and create the first session in place.
await (async () => {
	const calls = [];
	const app = Object.create(HarnessApp.prototype);
	app.client = {
		sessionId: undefined,
		authenticate: async (id) => calls.push(["authenticate", id]),
		newSession: async () => {
			calls.push(["newSession"]);
			app.client.sessionId = "authenticated-session";
		},
	};
	app.ready = false;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.updateAutocomplete = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.ui = { requestRender() {} };
	await app.authenticateWithMethod({ id: "chat-gpt", name: "ChatGPT" });
	assert.deepEqual(calls, [["authenticate", "chat-gpt"], ["newSession"]]);
	assert.equal(app.ready, true);
})();

// A backend that exits during authentication never remains falsely ready merely
// because its old session id is still populated.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.client = {
		sessionId: "stale-session",
		exited: false,
		async authenticate() {
			this.exited = true;
			throw new Error("backend exited");
		},
	};
	app.ready = true;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = () => {};
	app.updateSpinner = () => {};
	app.updateAutocomplete = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.restoreFailedSessionSwitchInput = () => {};
	app.ui = { requestRender() {} };
	await app.authenticateWithMethod({ id: "browser", name: "Browser" });
	assert.equal(app.ready, false);
})();

// API-key auth recognizes credentials configured on the active agent, matching
// the environment used to spawn that agent's ACP process.
await (async () => {
	const calls = [];
	const agent = {
		env: { CODEX_API_KEY: "agent-scoped-key" },
		_signedOutAuthEnvNames: ["CODEX_API_KEY", "OPENAI_API_KEY"],
	};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.transport = "acp";
	app.config = { agents: { codex: agent } };
	app.availableCommands = new Map([["codex", [{ name: "old-account-command" }]]]);
	app.commandsLoaded = new Set(["codex"]);
	let invalidations = 0;
	app.backendCommandCatalog = { invalidate: () => { invalidations += 1; } };
	app.client = {
		sessionId: "s",
		agentInfo: { name: "@agentclientprotocol/codex-acp" },
		authenticate: async (id, meta) => {
			calls.push([id, meta]);
			// Simulate an authenticated command update arriving before the RPC
			// response. The post-auth cleanup must not erase this live authority.
			app.availableCommands.set("codex", [{ name: "new-account-command" }]);
		},
	};
	app.ready = true;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.updateAutocomplete = () => {};
	app.schedulePromptQueueDrain = () => {};
	app.ui = { requestRender() {} };
	await app.authenticateWithMethod({ id: "api-key", name: "API Key" });
	assert.deepEqual(calls, [["api-key", { "api-key": { apiKey: "agent-scoped-key" } }]]);
	assert.equal(invalidations, 1, "successful authentication invalidates last-seen account metadata");
	assert.deepEqual(app.availableCommands.get("codex"), [{ name: "new-account-command" }]);
	assert.equal(app.commandsLoaded.has("codex"), true, "an existing session retains its live command authority");
	assert.equal(Object.hasOwn(agent, "_signedOutAuthEnvNames"), false, "successful explicit login lifts the mask");
	assert.equal(Object.hasOwn(agent, "_sessionAuthEnv"), false, "API-key metadata is not retained on the launch spec");
})();

// /login waiting on cold startup cannot replace a /new transition that takes
// ownership while the original connection attempt is still settling.
await (async () => {
	let release;
	const client = { authMethods: [], exited: false };
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.transport = "acp";
	app.activeAgentGeneration = 0;
	app.config = { agents: { codex: {} } };
	app.client = client;
	app.ready = false;
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.deferredLocalSlashCommands = [];
	app.queuedInputOrder = 0;
	app.connectionAttempt = {
		client,
		promise: new Promise((resolve) => { release = resolve; }),
	};
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.switchAgent = async () => assert.fail("/login must not replace the owned /new connection");
	const login = app.openAuthenticationDialog("chat-gpt");
	app.sessionSwitchInProgress = true;
	release();
	await login;
	assert.deepEqual(app.deferredLocalSlashCommands.map(({ name, argument }) => ({ name, argument })), [
		{ name: "login", argument: "chat-gpt" },
	]);
})();

// An authentication-required startup deliberately leaves its initialized ACP
// client alive with advertised methods. /login must reuse that client instead
// of launching the same unauthenticated backend a second time.
await (async () => {
	let picker;
	const definition = {};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: definition } },
		client: {
			exited: false,
			launchSpec: definition,
			authMethods: [{ id: "browser", name: "Browser login" }],
		},
		ready: false,
		busy: false,
		sessionSwitchInProgress: false,
		addCommandMessage() {},
		addNotice() {},
		ensureConnectedSingleFlight: async () => assert.fail("advertised authentication methods must be reused"),
		openSelection(title, entries) { picker = { title, entries }; },
	});
	await app.openAuthenticationDialog();
	assert.equal(picker?.title, "Authenticate");
	assert.deepEqual(picker?.entries.map((entry) => entry.value.id), ["browser"]);
})();

// A same-harness reconnect replaces the adapter's cloned launch spec. Context
// ownership follows the stable configured definition, so cold local commands
// do not report failure after successfully reconnecting.
await (async () => {
	const definition = { label: "Fake", acp: { command: "fake", args: [] } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: definition } },
		client: { exited: true, launchSpec: structuredClone(definition) },
		ready: false,
		async switchAgent() {
			this.client = { exited: false, launchSpec: structuredClone(definition) };
			this.ready = true;
		},
	});
	assert.equal(await app.ensureConnected(), true);
	assert.notEqual(app.client.launchSpec, definition);
	assert.equal(app.isActiveAgentContext(app.captureActiveAgentContext({ includeClient: true })), true);
})();

// A cold command joins the exact adapter initialization already in flight. It
// promotes a visible status immediately and never turns a failed attempt into a
// second, implicit backend launch.
await (async () => {
	const definition = { label: "Fake", acp: { command: "fake", args: [] } };
	const makeWaitingApp = () => {
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			activeAgentGeneration: 0,
			config: { agents: { fake: definition } },
			client: { exited: false, launchSpec: structuredClone(definition) },
			ready: false,
			statusState: "",
			updateSpinner() {},
			ui: { requestRender() {} },
			switchAgent: async () => assert.fail("ensureConnected must join the live connection attempt"),
		});
		return app;
	};

	let releaseSuccessfulAttempt;
	const successful = makeWaitingApp();
	successful.connectionAttempt = {
		client: successful.client,
		promise: new Promise((resolve) => { releaseSuccessfulAttempt = resolve; }),
	};
	const connected = successful.ensureConnected({ statusState: "starting Fake for Resume" });
	assert.equal(successful.statusState, "starting Fake for Resume", "the wait is visible before startup settles");
	successful.ready = true;
	releaseSuccessfulAttempt();
	assert.equal(await connected, true);
	assert.equal(successful.statusState, "", "a successful joined attempt releases its waiting status");

	let releaseFailedAttempt;
	const failed = makeWaitingApp();
	failed.connectionAttempt = {
		client: failed.client,
		promise: new Promise((resolve) => { releaseFailedAttempt = resolve; }),
	};
	const notConnected = failed.ensureConnected();
	releaseFailedAttempt();
	assert.equal(await notConnected, false, "a settled failed startup is reported without an automatic retry");
	assert.equal(failed.statusState, "", "a failed joined attempt cannot leave the footer spinning forever");
})();

// A command-specific connection must not replace a permission/elicitation menu
// that appeared while session creation was settling.
await (async () => {
	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		config: { agents: { fake: { label: "Fake" } } },
		ready: false,
		client: undefined,
		foregroundOperation: undefined,
		foregroundOperationSequence: 0,
		deferredLocalSlashCommands: [],
		async ensureConnectedSingleFlight() {
			this.client = { exited: false };
			this.ready = true;
			this.menuHandle = { keybindingContext: "Confirmation" };
			this.permissionPromptActive = true;
			return true;
		},
		addNotice(message) { notices.push(message); },
		updateSpinner() {},
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
	});
	assert.equal(await app.ensureConnected({ commandName: "config" }), false);
	assert.equal(app.menuHandle.keybindingContext, "Confirmation");
	assert.ok(notices.some((message) => message.includes("another interaction is active")));
})();

// Shell activity is an independent footer owner. Connection progress may take
// precedence temporarily, but clearing it reveals the still-running shell and
// keeps the spinner alive.
{
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeShellInputCount: 0,
		shellInputsRunning: 0,
		statusState: "",
		connectionStatusOwner: undefined,
		foregroundOperation: undefined,
		btwThread: undefined,
		spinnerTimer: undefined,
		spinnerIndex: 0,
		ui: { requestRender() {} },
	});
	app.setShellInputStatus(undefined, true);
	assert.equal(effectiveActivityStatus(app), "running shell command");
	const attempt = {};
	app.setConnectionStatus(attempt, "connecting");
	assert.equal(effectiveActivityStatus(app), "connecting");
	app.clearConnectionStatus(attempt);
	app.updateSpinner();
	assert.equal(effectiveActivityStatus(app), "running shell command");
	assert.ok(app.spinnerTimer, "the shell owner keeps animation active after connection cleanup");
	app.setShellInputStatus(undefined, false);
	assert.equal(effectiveActivityStatus(app), "");
	assert.equal(app.spinnerTimer, undefined);
}

// switchAgent publishes lifecycle ownership before its first await. That closes
// the pre-client race without allowing a stale generation to claim success.
await (async () => {
	const definition = { label: "Fake", acp: { command: "fake", args: [] } };
	const makeWaitingApp = () => {
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			activeAgentGeneration: 0,
			config: { agents: { fake: definition } },
			client: undefined,
			ready: false,
			statusState: "",
			updateSpinner() {},
			ui: { requestRender() {} },
			switchAgent: async () => assert.fail("ensureConnected must join the queued lifecycle"),
		});
		return app;
	};
	const installAttempt = (app) => {
		let release;
		app.agentSwitchAttempt = {
			key: "fake",
			transport: "acp",
			generation: 0,
			agentDefinition: definition,
			promise: new Promise((resolve) => { release = resolve; }),
		};
		return release;
	};

	const joined = makeWaitingApp();
	const releaseJoined = installAttempt(joined);
	const joinedResult = joined.ensureConnected({ statusState: "connecting for /resume" });
	assert.equal(joined.agentSwitchAttempt.statusState, "connecting for /resume");
	assert.equal(joined.agentSwitchAttempt.connectionStatusState, "connecting for /resume");
	joined.client = { exited: false, launchSpec: structuredClone(definition) };
	joined.ready = true;
	releaseJoined();
	assert.equal(await joinedResult, true);

	const stale = makeWaitingApp();
	const releaseStale = installAttempt(stale);
	const staleResult = stale.ensureConnected();
	stale.activeAgentGeneration += 1;
	stale.client = { exited: false, launchSpec: structuredClone(definition) };
	stale.ready = true;
	releaseStale();
	assert.equal(await staleResult, false, "a lifecycle from an older generation cannot satisfy the caller");
})();

// Quiet background startup remains visually idle even while an old backend is
// retired and its replacement connects. A blocked action promotes the same
// lifecycle through ensureConnected tests above.
await (async () => {
	let releaseStop;
	let markStopStarted;
	let releaseConnect;
	let markConnectStarted;
	const stopStarted = new Promise((resolve) => { markStopStarted = resolve; });
	const stopGate = new Promise((resolve) => { releaseStop = resolve; });
	const connectStarted = new Promise((resolve) => { markConnectStarted = resolve; });
	const connectGate = new Promise((resolve) => { releaseConnect = resolve; });
	const previousClient = {
		exited: false,
		async stopAndWait() {
			markStopStarted();
			await stopGate;
		},
	};
	const replacementClient = {
		exited: false,
		authMethods: [],
		async connect() {
			markConnectStarted();
			await connectGate;
		},
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: { label: "Fake" } } },
		client: previousClient,
		ready: true,
		busy: false,
		btwThread: undefined,
		statusState: "",
		promptQueue: [],
		deferredLocalSlashCommands: [],
		activeToolIds: new Set(),
		activeAnonymousToolCount: 0,
		pendingUserEchoes: [],
		cancelPermissionPrompts() {},
		closeMenu() {},
		clearLiveBackendCommands() {},
		clearCancelGraceTimer() {},
		closeCurrentAssistantText() {},
		updateSpinner() {},
		updateAutocomplete() {},
		schedulePromptQueueDrain() {},
		ui: { requestRender() {} },
		createRuntimeAdapter: () => replacementClient,
	});
	const startup = app.switchAgent("fake", "acp", { quiet: true });
	await stopStarted;
	assert.equal(app.statusState, "", "background retirement does not show an unrequested spinner");
	await app.submitBackendPrompt("hello after startup");
	assert.equal(app.statusState, "connecting", "a prompt blocked on the quiet lifecycle promotes its spinner");
	assert.equal(app.promptQueue.at(-1)?.text, "hello after startup");
	releaseStop();
	await connectStarted;
	assert.equal(app.statusState, "connecting", "the promoted spinner remains visible through connection");
	assert.equal(app.ready, false);
	releaseConnect();
	await startup;
	assert.equal(app.ready, true);
	assert.equal(app.statusState, "");
})();

// Terminal auth can only add args/env to the configured agent executable. It
// never accepts a backend-supplied command and never routes arguments through a
// shell, even when they contain shell metacharacters.
await (async () => {
	let launch;
	const child = new EventEmitter();
	const agent = {
		env: { BASE: "agent" },
		acp: {
			command: process.execPath,
			args: ["server.mjs", "acp"],
			env: { COMMAND_ENV: "configured" },
		},
	};
	const method = {
		type: "terminal",
		id: "terminal-login",
		name: "Terminal Login",
		command: "/tmp/untrusted-command",
		args: ["--cli", "auth", "login", "$(touch should-not-run)"],
		env: { PATH: "/untrusted/path", AUTH_TOKEN: "secret" },
	};
	const completed = runTerminalAuthentication(agent, method, {
		cwd: process.cwd(),
		env: { PATH: process.env.PATH, BASE: "process" },
		spawnImpl(command, args, options) {
			launch = { command, args, options };
			queueMicrotask(() => child.emit("close", 0, null));
			return child;
		},
	});
	await completed;
	assert.equal(launch.command, process.execPath);
	assert.deepEqual(launch.args, ["server.mjs", "acp", "--cli", "auth", "login", "$(touch should-not-run)"]);
	assert.equal(launch.options.shell, false);
	assert.equal(launch.options.stdio, "inherit");
	assert.equal(launch.options.cwd, process.cwd());
	assert.equal(launch.options.env.BASE, "agent");
	assert.equal(launch.options.env.COMMAND_ENV, "configured");
	assert.equal(launch.options.env.AUTH_TOKEN, "secret");
	assert.equal(launch.options.env.PATH, "/untrusted/path");
	await assert.rejects(
		runTerminalAuthentication(agent, { ...method, env: { "BAD=NAME": "value" } }, { spawnImpl: () => assert.fail("invalid env must not spawn") }),
		/invalid terminal authentication environment variable/,
	);

	if (process.platform !== "win32") {
		const shadowRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-terminal-auth-shadow-"));
		try {
			const makeAdapter = (name, version) => {
				const prefix = path.join(shadowRoot, name);
				const packageRoot = path.join(prefix, "lib", "node_modules", "@agentclientprotocol", "codex-acp");
				const entrypoint = path.join(packageRoot, "dist", "index.js");
				const shim = path.join(prefix, "bin", "codex-acp");
				fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
				fs.mkdirSync(path.dirname(shim), { recursive: true });
				fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
					name: "@agentclientprotocol/codex-acp",
					version,
				}));
				fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
				fs.chmodSync(entrypoint, 0o755);
				fs.symlinkSync(path.relative(path.dirname(shim), entrypoint), shim);
				return { prefix, shim, entrypoint };
			};
			const oldAdapter = makeAdapter("old", "1.0.0");
			const currentAdapter = makeAdapter("current", "1.1.2");
			let authLaunch;
			const authChild = new EventEmitter();
			await runTerminalAuthentication(
				{
					_requiredAgentName: "@agentclientprotocol/codex-acp",
					_minimumAgentVersion: "1.1.2",
					acp: { command: "codex-acp", args: [] },
				},
				{ type: "terminal", id: "login", name: "Login", args: ["login"] },
				{
					env: { PATH: `${path.dirname(oldAdapter.shim)}:${path.dirname(currentAdapter.shim)}` },
					spawnImpl(command, args) {
						authLaunch = { command, args };
						queueMicrotask(() => authChild.emit("close", 0, null));
						return authChild;
					},
				},
			);
			assert.equal(authLaunch.command, process.execPath);
			assert.equal(
				authLaunch.args[0],
				fs.realpathSync(currentAdapter.entrypoint),
				"terminal auth must skip the same incompatible shadowing adapter as normal startup",
			);
		} finally {
			fs.rmSync(shadowRoot, { recursive: true, force: true });
		}
	}

	const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-terminal-auth-shim-"));
	try {
		const entrypoint = path.join(shimDir, "agent.js");
		const shim = path.join(shimDir, "agent.cmd");
		fs.writeFileSync(entrypoint, "// trusted installed agent entrypoint\n");
		fs.writeFileSync(shim, '@"%~dp0\\node.exe" "%~dp0\\agent.js" %*\r\n');
		const startupLaunch = resolveAcpExecutable(shim, process.cwd(), { PATH: process.env.PATH }, "win32");
		assert.equal(startupLaunch.executable, process.execPath);
		assert.deepEqual(startupLaunch.prefixArgs, [fs.realpathSync(entrypoint)]);
		const pathCaseLaunch = resolveAcpExecutable("agent", process.cwd(), { Path: shimDir }, "win32");
		assert.equal(pathCaseLaunch.executable, process.execPath);
		assert.deepEqual(pathCaseLaunch.prefixArgs, [fs.realpathSync(entrypoint)]);
		const mergedWindowsEnv = mergeEnvironments(
			[{ Path: "base", Token: "old" }, { PATH: shimDir, TOKEN: "new" }],
			"win32",
		);
		assert.deepEqual(mergedWindowsEnv, { PATH: shimDir, TOKEN: "new" });
		let windowsLaunch;
		const windowsChild = new EventEmitter();
		await runTerminalAuthentication(
			{ acp: { command: shim, args: ["acp"] } },
			{ type: "terminal", id: "login", name: "Login", args: ["--login"] },
			{
				platform: "win32",
				spawnImpl(command, args, options) {
					windowsLaunch = { command, args, options };
					queueMicrotask(() => windowsChild.emit("close", 0, null));
					return windowsChild;
				},
			},
		);
		assert.ok(!/\.(?:cmd|bat)$/i.test(windowsLaunch.command), "terminal auth must not spawn a Windows command shim");
		assert.equal(windowsLaunch.command, process.execPath);
		assert.deepEqual(windowsLaunch.args, [fs.realpathSync(entrypoint), "acp", "--login"]);
		assert.equal(windowsLaunch.options.shell, false);
	} finally {
		fs.rmSync(shimDir, { recursive: true, force: true });
	}
})();

// Selecting a terminal method gives the child process exclusive terminal
// ownership, restores and fully repaints the TUI, then reconnects the ACP agent.
// It must not send that method through the agent-side authenticate RPC.
await (async () => {
	const calls = [];
	const agent = {
		acp: { command: process.execPath, args: ["agent.mjs", "acp"] },
		_sessionAuthEnv: { SERVICE_TOKEN: "stale-session-token" },
	};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.transport = "acp";
	app.config = { agents: { fake: agent } };
	app.availableCommands = new Map([["fake", [{ name: "old-account-command" }]]]);
	app.commandsLoaded = new Set(["fake"]);
	app.client = { authenticate: async () => assert.fail("terminal auth must not call authenticate RPC") };
	app.ready = false;
	app.statusState = "";
	app.addCommandMessage = (message) => calls.push(["command", message]);
	app.addNotice = (message) => calls.push(["notice", message]);
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.updateAutocomplete = () => calls.push(["autocomplete"]);
	app.ui = {
		requestRender(force) { calls.push(["render", force]); },
		stop() { calls.push(["ui", "stop"]); },
		start() { calls.push(["ui", "start"]); },
	};
	app.switchAgent = async () => {
		calls.push(["switch", agent._sessionAuthEnv]);
		app.client = { authMethods: [] };
		app.ready = true;
	};
	const method = { type: "terminal", id: "terminal-login", name: "Terminal Login", args: ["--login"] };
	await app.authenticateWithMethod(method, "login", {
		runTerminalAuthentication: async (receivedAgent, receivedMethod) => {
			assert.equal(receivedAgent, agent);
			assert.equal(receivedMethod, method);
			calls.push(["runner"]);
		},
	});
	assert.deepEqual(
		calls.filter(([kind]) => ["ui", "runner", "switch"].includes(kind)),
		[["ui", "stop"], ["runner"], ["ui", "start"], ["switch", undefined]],
	);
	assert.ok(
		calls.findIndex(([kind]) => kind === "autocomplete") < calls.findIndex(([kind]) => kind === "switch"),
		"invalid account commands are removed before a potentially slow reconnect",
	);
	assert.equal(Object.hasOwn(agent, "_sessionAuthEnv"), false);
	assert.ok(calls.some(([kind, value]) => kind === "render" && value === true), "TUI must force a repaint after terminal auth");
})();

// A lifecycle replacement can already be queued when terminal auth starts. If
// it changes the active harness while the TUI is suspended, clear only the agent
// that actually authenticated and do not reconnect or alter the replacement.
await (async () => {
	const originalAgent = { _sessionAuthEnv: { SERVICE_TOKEN: "stale-original" } };
	const replacementAgent = { _sessionAuthEnv: { SERVICE_TOKEN: "keep-replacement" } };
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "original";
	app.transport = "acp";
	app.config = { agents: { original: originalAgent, replacement: replacementAgent } };
	const invalidatedHarnesses = [];
	app.backendCommandCatalog = { invalidate: (key) => { invalidatedHarnesses.push(key); return true; } };
	app.client = {};
	app.ready = false;
	app.statusState = "";
	app.busy = false;
	app.sessionSwitchInProgress = false;
	app.stopping = false;
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.settleDeferredBtwPrompts = async () => {};
	app.restoreFailedSessionSwitchInput = () => {};
	app.ui = { requestRender() {}, stop() {}, start() {} };
	app.switchAgent = async () => assert.fail("completed auth must not reconnect an unrelated active harness");
	await app.authenticateWithMethod(
		{ type: "terminal", id: "terminal-login", name: "Terminal Login" },
		"login",
		{
			runTerminalAuthentication: async (receivedAgent) => {
				assert.equal(receivedAgent, originalAgent);
				// Simulate the completion of a lifecycle turn that was queued before auth.
				app.activeKey = "replacement";
				app.sessionSwitchInProgress = false;
			},
		},
	);
	assert.equal(Object.hasOwn(originalAgent, "_sessionAuthEnv"), false);
	assert.deepEqual(replacementAgent._sessionAuthEnv, { SERVICE_TOKEN: "keep-replacement" });
	assert.deepEqual(invalidatedHarnesses, ["original"], "persistent terminal auth invalidates the harness that authenticated");
})();

// A failed terminal process still restores the TUI and does not reconnect as if
// authentication had succeeded.
await (async () => {
	const calls = [];
	const agent = {
		acp: { command: process.execPath, args: [] },
		_sessionAuthEnv: { SERVICE_TOKEN: "still-valid" },
	};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.transport = "acp";
	app.config = { agents: { fake: agent } };
	app.ready = false;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => calls.push(["error", message]);
	app.updateSpinner = () => {};
	app.ui = {
		requestRender() {},
		stop() { calls.push(["ui", "stop"]); },
		start() { calls.push(["ui", "start"]); },
	};
	app.switchAgent = async () => assert.fail("failed terminal auth must not reconnect");
	await app.authenticateWithMethod(
		{ type: "terminal", id: "terminal-login", name: "Terminal Login" },
		"login",
		{ runTerminalAuthentication: async () => { throw new Error("login failed"); } },
	);
	assert.deepEqual(calls.slice(0, 2), [["ui", "stop"], ["error", "Authentication failed: login failed"]]);
	assert.deepEqual(calls.at(-1), ["ui", "start"]);
	assert.deepEqual(agent._sessionAuthEnv, { SERVICE_TOKEN: "still-valid" });
})();

// stop() is terminal synchronously. An immediate /login after /logout therefore
// replaces the closing client instead of attempting auth on its stale stdin.
await (async () => {
	const calls = [];
	const oldClient = new AcpClient({ command: "fake" }, () => {});
	oldClient.child = {
		killed: false,
		kill() {
			this.killed = true;
			calls.push("kill-old");
		},
	};
	oldClient.authMethods = [{ id: "chat-gpt", name: "ChatGPT" }];
	oldClient.capabilities = { auth: { logout: {} } };
	oldClient.logout = async () => calls.push("logout-old");
	oldClient.stopAndWait = async () => { oldClient.stop(); };
	const replacement = { exited: false, authMethods: [{ id: "chat-gpt", name: "ChatGPT" }] };
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.transport = "acp";
	app.config = { agents: { codex: {} } };
	app.client = oldClient;
	app.btwThread = {};
	app.ready = true;
	app.addCommandMessage = () => {};
	app.addNotice = () => {};
	app.addError = (message) => assert.fail(message);
	app.ui = { requestRender() {} };
	app.switchAgent = async () => {
		calls.push("switch");
		app.client = replacement;
	};
	app.closeBtw = () => {
		calls.push("close-btw");
		app.btwThread = undefined;
	};
	app.authenticateWithMethod = async () => calls.push(app.client === replacement ? "auth-new" : "auth-old");
	await app.logoutActiveAgent();
	assert.equal(oldClient.exited, true);
	await app.openAuthenticationDialog("chat-gpt");
	assert.deepEqual(calls, ["logout-old", "close-btw", "kill-old", "switch", "auth-new"]);
})();

// Successful logout does not settle while either credential-bearing ACP tree is
// still live, including the independently spawned /btw connection.
await (async () => {
	let releaseMain;
	let releaseSide;
	let markMainStarted;
	let markSideStarted;
	const mainStarted = new Promise((resolve) => { markMainStarted = resolve; });
	const sideStarted = new Promise((resolve) => { markSideStarted = resolve; });
	const mainGate = new Promise((resolve) => { releaseMain = resolve; });
	const sideGate = new Promise((resolve) => { releaseSide = resolve; });
	const calls = [];
	const client = {
		exited: false,
		capabilities: { auth: { logout: {} } },
		async logout() { calls.push("logout"); },
		async stopAndWait() {
			calls.push("main-stop-start");
			this.exited = true;
			markMainStarted();
			await mainGate;
			calls.push("main-stop-end");
		},
	};
	const sideClient = {
		stop() { calls.push("side-stop"); },
		async stopAndWait() {
			calls.push("side-wait-start");
			markSideStarted();
			await sideGate;
			calls.push("side-wait-end");
		},
	};
	const agent = { _sessionAuthEnv: { TOKEN: "secret" } };
	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		transport: "acp",
		config: { agents: { codex: agent } },
		client,
		btwThread: { client: sideClient },
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		statusState: "",
		addCommandMessage() {},
		addNotice(message) { notices.push(message); },
		addError(message) { assert.fail(message); },
		updateSpinner() {},
		settleDeferredBtwPrompts: async () => {},
		restoreFailedSessionSwitchInput() {},
		closeBtw(options = {}) {
			if (options.stop !== false) this.btwThread.client.stop();
			this.btwThread = undefined;
		},
		ui: { requestRender() {} },
	});
	let settled = false;
	const logout = app.logoutActiveAgent().then(() => { settled = true; });
	await Promise.all([mainStarted, sideStarted]);
	assert.equal(Object.hasOwn(agent, "_sessionAuthEnv"), false);
	assert.equal(settled, false);
	releaseMain();
	await Promise.resolve();
	assert.equal(settled, false, "side process still gates logout completion");
	releaseSide();
	await logout;
	assert.equal(settled, true);
	assert.deepEqual(calls, ["logout", "main-stop-start", "side-wait-start", "main-stop-end", "side-wait-end"]);
	assert.deepEqual(notices, ["Signed out. Run /login to authenticate again."]);
})();

// A successful /logout masks every advertised credential variable across the
// process, agent, and command environment layers. Native helpers use the same
// merged environment as ACP startup, so they cannot silently restore the old
// identity either.
await (async () => {
	const processName = "CC_TEST_LOGOUT_PROCESS_TOKEN";
	const agentName = "CC_TEST_LOGOUT_AGENT_TOKEN";
	const commandName = "CC_TEST_LOGOUT_COMMAND_TOKEN";
	const sessionName = "CC_TEST_LOGOUT_SESSION_TOKEN";
	const previousProcessToken = process.env[processName];
	process.env[processName] = "process-secret";
	try {
		const agent = {
			env: { [agentName]: "agent-secret" },
			acp: { command: "fake", env: { [commandName]: "command-secret" } },
			_sessionAuthEnv: { [sessionName]: "session-secret" },
		};
		const client = {
			exited: false,
			authMethods: [{
				type: "env_var",
				id: "token",
				vars: [processName, agentName, commandName, sessionName].map((name) => ({ name })),
			}],
			capabilities: { auth: { logout: {} } },
			async logout() {},
			async stopAndWait() { this.exited = true; },
		};
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			config: { agents: { fake: agent } },
			client,
			btwThread: undefined,
			ready: true,
			busy: false,
			sessionSwitchInProgress: false,
			statusState: "",
			addCommandMessage() {},
			addNotice() {},
			addError(message) { assert.fail(message); },
			updateSpinner() {},
			settleDeferredBtwPrompts: async () => {},
			restoreFailedSessionSwitchInput() {},
			ui: { requestRender() {} },
		});
		await app.logoutActiveAgent();
		assert.deepEqual(new Set(agent._signedOutAuthEnvNames), new Set([processName, agentName, commandName, sessionName]));
		assert.equal(Object.hasOwn(agent, "_sessionAuthEnv"), false);

		const source = `process.stdout.write(JSON.stringify(${JSON.stringify([processName, agentName, commandName, sessionName])}.map((name) => process.env[name] ?? null)));`;
		const result = await runCodexCommand({ command: process.execPath, args: ["-e", source] }, [], agent);
		assert.deepEqual(JSON.parse(result.stdout.toString("utf8")), [null, null, null, null]);
	} finally {
		if (previousProcessToken === undefined) delete process.env[processName];
		else process.env[processName] = previousProcessToken;
	}
})();

// An unconfirmed post-logout process tree permanently fences reconnects in this
// cc process; a second stop call must not be allowed to "forget" the live tree.
await (async () => {
	const originalInitialize = AcpClient.prototype.initialize;
	let replacementStarts = 0;
	AcpClient.prototype.initialize = async function initializeAfterFatalLogout() {
		replacementStarts += 1;
	};
	try {
		const errors = [];
		const client = {
			exited: false,
			capabilities: { auth: { logout: {} } },
			async logout() {},
			async stopAndWait() {
				this.exited = true;
				const error = new Error("credential process tree remains live");
				error.code = "PROCESS_TREE_TERMINATION_FAILED";
				throw error;
			},
		};
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			startupConnectTimer: undefined,
			activeKey: "codex",
			activeAgentGeneration: 0,
			transport: "acp",
			config: { agents: { codex: { acp: { command: "fake", args: [] }, _sessionAuthEnv: { TOKEN: "secret" } } } },
			client,
			btwThread: undefined,
			ready: true,
			busy: false,
			sessionSwitchInProgress: false,
			statusState: "",
			promptQueue: [],
			deferredLocalSlashCommands: [],
			activeToolIds: new Set(),
			activeAnonymousToolCount: 0,
			pendingUserEchoes: [],
			addCommandMessage() {},
			addNotice() {},
			addError(message) { errors.push(message); },
			updateSpinner() {},
			updateAutocomplete() {},
			cancelPermissionPrompts() {},
			closeMenu() {},
			clearCancelGraceTimer() {},
			closeCurrentAssistantText() {},
			schedulePromptQueueDrain() {},
			settleDeferredBtwPrompts: async () => {},
			restoreFailedSessionSwitchInput() {},
			ui: { requestRender() {} },
		});
		await app.logoutActiveAgent();
		assert.ok(app.replacementProcessFence);
		await app.switchAgent("codex");
		assert.equal(replacementStarts, 0);
		assert.ok(errors.some((message) => message.includes("restart cc")));
	} finally {
		AcpClient.prototype.initialize = originalInitialize;
	}
})();

// Logout is a separately negotiated ACP capability: it is hidden from slash
// completion and never invoked when agentCapabilities.auth.logout is absent.
await (async () => {
	assert.equal(agentSupportsLogout({ auth: { logout: {} } }), true);
	assert.equal(agentSupportsLogout({ auth: {} }), false);
	const slashApp = {
		activeKey: "fake",
		client: { capabilities: { auth: {} } },
		config: { agents: { fake: {} } },
		sessionStates: new Map(),
		themeName: "system",
		isCodexBackendActive: () => false,
	};
	assert.equal(localSlashCommands(slashApp).some((command) => command.name === "logout"), false);
	slashApp.client.capabilities.auth.logout = {};
	assert.equal(localSlashCommands(slashApp).some((command) => command.name === "logout"), true);

	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.config = { agents: { fake: {} } };
	app.client = {
		exited: false,
		capabilities: { auth: {} },
		logout: async () => assert.fail("logout RPC must stay gated"),
	};
	app.addCommandMessage = () => {};
	app.addNotice = (message) => notices.push(message);
	app.addError = (message) => assert.fail(message);
	app.ui = { requestRender() {} };
	await app.logoutActiveAgent();
	assert.deepEqual(notices, ["This agent does not advertise logout support"]);
})();

// env_var authentication collects credentials outside the normal editor,
// stores them only on the in-memory agent launch spec, and reconnects without
// sending the method through the authenticate RPC.
await (async () => {
	const prompted = [];
	const collected = await collectEnvironmentAuthenticationVariables(
		{
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [
				{ name: "EXISTING_TOKEN", label: "Existing" },
				{ name: "NEW_TOKEN", label: "New token", secret: true },
				{ name: "OPTIONAL_REGION", optional: true, secret: false },
			],
		},
		{ EXISTING_TOKEN: "already-set" },
		{
			output: false,
			prompt: async (variable) => {
				prompted.push(variable.name);
				return variable.optional ? "" : "new-secret";
			},
		},
	);
	assert.deepEqual(collected, { EXISTING_TOKEN: "already-set", NEW_TOKEN: "new-secret" });
	assert.deepEqual(prompted, ["NEW_TOKEN", "OPTIONAL_REGION"]);

	const calls = [];
	const agent = {
		acp: { command: process.execPath, args: ["fake-agent.mjs"] },
		_signedOutAuthEnvNames: ["SERVICE_TOKEN"],
	};
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "fake";
	app.transport = "acp";
	app.config = { agents: { fake: agent } };
	app.availableCommands = new Map([["fake", [{ name: "old-account-command" }]]]);
	app.commandsLoaded = new Set(["fake"]);
	app.client = { authenticate: async () => assert.fail("env_var auth must not call authenticate RPC") };
	app.ready = false;
	app.statusState = "";
	app.addCommandMessage = () => {};
	app.addNotice = (message) => calls.push(["notice", message]);
	app.addError = (message) => assert.fail(message);
	app.updateSpinner = () => {};
	app.updateAutocomplete = () => calls.push(["autocomplete"]);
	app.ui = {
		requestRender(force) { calls.push(["render", force]); },
		stop() { calls.push(["ui", "stop"]); },
		start() { calls.push(["ui", "start"]); },
	};
	app.switchAgent = async () => {
		calls.push(["switch", agent._sessionAuthEnv]);
		app.ready = true;
	};
	await app.authenticateWithMethod(
		{ type: "env_var", id: "token", name: "Token", vars: [{ name: "SERVICE_TOKEN" }] },
		"login",
		{ collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "session-secret" }) },
	);
	assert.deepEqual(agent._sessionAuthEnv, { SERVICE_TOKEN: "session-secret" });
	assert.equal(Object.hasOwn(agent, "_signedOutAuthEnvNames"), false);
	assert.deepEqual(
		calls.filter(([kind]) => ["ui", "switch"].includes(kind)),
		[["ui", "stop"], ["ui", "start"], ["switch", { SERVICE_TOKEN: "session-secret" }]],
	);
	assert.ok(
		calls.findIndex(([kind]) => kind === "autocomplete") < calls.findIndex(([kind]) => kind === "switch"),
		"invalid account commands are removed before a potentially slow reconnect",
	);
})();

// Environment authentication also spans terminal-owned input. A lifecycle
// replacement that completes while credentials are being collected must not
// install those secrets on, or reconnect, the now-active unrelated harness.
await (async () => {
	const originalAgent = { env: { ORIGINAL_AGENT: "yes" } };
	const replacementAgent = { _sessionAuthEnv: { SERVICE_TOKEN: "keep-replacement" } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "original",
		transport: "acp",
		config: { agents: { original: originalAgent, replacement: replacementAgent } },
		client: {},
		ready: false,
		busy: false,
		sessionSwitchInProgress: false,
		stopping: false,
		statusState: "",
		addCommandMessage() {},
		addNotice() {},
		addError(message) { assert.fail(message); },
		updateSpinner() {},
		settleDeferredBtwPrompts: async () => {},
		restoreFailedSessionSwitchInput() {},
		ui: { requestRender() {}, stop() {}, start() {} },
		switchAgent: async () => assert.fail("stale environment auth must not reconnect an unrelated harness"),
	});
	await app.authenticateWithMethod(
		{ type: "env_var", id: "token", name: "Token", vars: [{ name: "SERVICE_TOKEN" }] },
		"login",
		{
			collectEnvironmentVariables: async (_method, environment) => {
				assert.equal(environment.ORIGINAL_AGENT, "yes");
				app.activeKey = "replacement";
				app.sessionSwitchInProgress = false;
				return { SERVICE_TOKEN: "must-not-leak" };
			},
		},
	);
	assert.equal(Object.hasOwn(originalAgent, "_sessionAuthEnv"), false);
	assert.deepEqual(replacementAgent._sessionAuthEnv, { SERVICE_TOKEN: "keep-replacement" });
})();

// Invalid UTF-8 must be sent as a resource link even when the invalid sequence
// occurs beyond the old 4 KiB binary sniff window.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-invalid-utf8-"));
	try {
		const file = path.join(root, "invalid.txt");
		fs.writeFileSync(file, Buffer.concat([Buffer.alloc(5000, 0x61), Buffer.from([0xc3, 0x28])]));
		const built = buildEmbeddedFilePromptParts("inspect @invalid.txt", root);
		assert.deepEqual(built.parts.map((part) => part.type), ["text", "resource_link"]);
		assert.equal(built.parts[1].name, "invalid.txt");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Doctor output remains visible when the native CLI reports an unhealthy
// installation through a nonzero exit status.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-doctor-nonzero-"));
	try {
		const cli = path.join(root, "codex.mjs");
		fs.writeFileSync(cli, 'process.stdout.write("diagnostic summary\\n"); process.stderr.write("unhealthy\\n"); process.exit(2);\n');
		fs.chmodSync(cli, 0o755);
		const blocks = [];
		const errors = [];
		const app = Object.create(HarnessApp.prototype);
		app.activeKey = "codex";
		app.config = { agents: { codex: { env: { CODEX_PATH: cli, PATH: "" } } } };
		app.statusState = "";
		app.addCommandMessage = () => {};
		app.addNotice = () => {};
		app.addError = (message) => errors.push(message);
		app.showMarkdownBlock = (message) => blocks.push(message);
		app.updateSpinner = () => {};
		app.ui = { requestRender() {} };
		await app.runCodexDoctor();
		assert.ok(blocks.some((block) => block.includes("diagnostic summary")));
		assert.ok(errors.some((message) => message.includes("exited 2") && message.includes("unhealthy")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();
