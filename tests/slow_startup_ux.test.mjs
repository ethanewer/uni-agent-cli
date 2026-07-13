import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BtwThread, HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function waitFor(predicate, message) {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	assert.fail(message);
}

function resumeFixture() {
	const notices = [];
	const errors = [];
	const selections = [];
	const definition = { label: "Slow Fake", transport: "acp", acp: { command: "fake", args: [] } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: definition } },
		client: undefined,
		ready: false,
		busy: false,
		foregroundOperation: undefined,
		foregroundOperationSequence: 0,
		asyncPickerLoads: new Set(),
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		selectionActionInProgress: false,
		permissionPromptActive: false,
		menuHandle: undefined,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		flushingDeferredLocalSlashCommands: false,
		sessionSwitchInProgress: false,
		lastKnownEditorText: "",
		lastInputClearSource: undefined,
		suppressNextPairedEmptyInterrupt: false,
		editorTargetThread: undefined,
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		},
		ui: { requestRender() {} },
		updateSpinner() {},
		addCommandMessage() {},
		addNotice(message) { notices.push(message); },
		addError(message) { errors.push(message); },
		schedulePromptQueueDrain() {},
		openSelection(title, entries, onSelect) { selections.push({ title, entries, onSelect }); },
	});
	return { app, definition, notices, errors, selections };
}

function coldCommandFixture() {
	const notices = [];
	const commands = [];
	const definition = { label: "Slow Fake", transport: "acp", acp: { command: "fake", args: [] } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		config: { agents: { fake: definition } },
		client: undefined,
		ready: false,
		busy: false,
		focusedThread: "main",
		btwThread: undefined,
		btwShutdownTail: undefined,
		replacementProcessFence: undefined,
		foregroundOperation: undefined,
		foregroundOperationSequence: 0,
		connectionStatusOwner: undefined,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		permissionPromptActive: false,
		menuHandle: undefined,
		configUpdateTokens: new Set(),
		configUpdateCount: 0,
		asyncPickerLoads: new Set(),
		asyncPickerLoadCount: 0,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		flushingDeferredLocalSlashCommands: false,
		queuedInputOrder: 0,
		statusState: "",
		activeShellInputCount: 0,
		shellInputsRunning: 0,
		clipboardImages: [],
		lastKnownEditorText: "",
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
		},
		sessionStates: new Map([["fake", {}]]),
		availableCommands: new Map(),
		commandsLoaded: new Set(),
		themeName: "system",
		ui: { requestRender() {} },
		updateSpinner() {},
		updateAutocomplete() {},
		clearLiveBackendCommands() {},
		resetConversationView() {},
		clearConfigUpdates() {},
		schedulePromptQueueDrain() {},
		flushDeferredLocalSlashCommands: async () => {},
		addCommandMessage(message) { commands.push(message); },
		addNotice(message) { notices.push(message); },
		addError(message) { notices.push(`error:${message}`); },
	});
	return { app, definition, notices, commands };
}

// /resume owns one visible operation continuously across a cold connection and
// session listing. A second submission remains editable and never executes.
await (async () => {
	const { app, definition, notices, errors, selections } = resumeFixture();
	const connect = deferred();
	const list = deferred();
	let connectOptions;
	let listCalls = 0;
	const client = {
		sessionId: "current",
		exited: false,
		launchSpec: definition,
		agentInfo: { name: "fake-acp" },
		capabilities: { sessionList: true },
		listSessions() {
			listCalls += 1;
			return list.promise;
		},
	};
	app.ensureConnected = async (options) => {
		connectOptions = options;
		await connect.promise;
		app.client = client;
		app.ready = true;
		return true;
	};

	const resume = app.openResumeDialog();
	assert.equal(app.foregroundOperation?.commandName, "resume");
	assert.equal(app.foregroundOperation?.status, "starting Slow Fake for /resume");
	assert.equal(connectOptions.statusState, "connecting");
	assert.equal(connectOptions.foregroundOperation, app.foregroundOperation);
	assert.equal(listCalls, 0);

	await app.handleSubmit("/new");
	assert.equal(app.editor.getText(), "/new");
	assert.equal(app.foregroundOperation?.commandName, "resume");
	assert.ok(notices.some((message) => message.includes("input remains in the composer")));

	connect.resolve();
	await waitFor(() => listCalls === 1, "resume should list sessions after the single connection settles");
	assert.equal(app.foregroundOperation?.status, "loading sessions");
	assert.equal(app.asyncPickerLoadCount, 1);
	assert.equal(selections.length, 0);

	list.resolve([
		{ sessionId: "current", title: "Current" },
		{ sessionId: "other", title: "Other" },
	]);
	await resume;
	assert.equal(errors.length, 0);
	assert.equal(selections.length, 1);
	assert.equal(selections[0].title, "Resume session");
	assert.equal(app.foregroundOperation, undefined);
	assert.equal(app.asyncPickerLoadCount, 0);
	assert.equal(app.editor.getText(), "/new");
})();

// Ctrl+C cancels only the pending UI intent and preserves a newer draft. The
// backend may finish warming in the background, but its late completion cannot
// open a surprise picker.
await (async () => {
	const { app, definition, notices, errors, selections } = resumeFixture();
	const connect = deferred();
	let listCalls = 0;
	const client = {
		sessionId: "current",
		exited: false,
		launchSpec: definition,
		agentInfo: { name: "fake-acp" },
		capabilities: { sessionList: true },
		async listSessions() { listCalls += 1; return []; },
	};
	app.ensureConnected = async () => {
		await connect.promise;
		app.client = client;
		app.ready = true;
		return true;
	};

	const resume = app.openResumeDialog();
	assert.equal(app.foregroundOperation?.commandName, "resume");
	app.editor.setText("keep this draft");
	app.lastKnownEditorText = "keep this draft";
	app.handleInterrupt("input");
	assert.equal(app.foregroundOperation, undefined);
	assert.equal(app.editor.getText(), "keep this draft");
	assert.ok(notices.some((message) => message.startsWith("Cancelled /resume")));
	connect.resolve();
	await resume;
	assert.equal(listCalls, 0);
	assert.equal(selections.length, 0);
	assert.equal(errors.length, 0);
})();

// Cancellation while the local Codex index is still loading must not launch a
// late ACP fallback after SQLite finishes.
await (async () => {
	const fixture = resumeFixture();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-resume-cancel-"));
	const binDir = path.join(root, "bin");
	const started = path.join(root, "started");
	const gate = path.join(root, "gate");
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(root, "state_5.sqlite"), "");
	const sqlite = path.join(binDir, "sqlite3");
	fs.writeFileSync(sqlite, `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.CC_TEST_SQLITE_STARTED, "started");
const timer = setInterval(() => {
	if (!fs.existsSync(process.env.CC_TEST_SQLITE_GATE)) return;
	clearInterval(timer);
	process.stdout.write("not-json");
}, 5);
`);
	fs.chmodSync(sqlite, 0o755);
	fixture.definition.env = { CODEX_HOME: root };
	fixture.app.activeKey = "codex";
	fixture.app.config.agents = { codex: fixture.definition };
	let acpListCalls = 0;
	fixture.app.client = {
		sessionId: "current",
		exited: false,
		launchSpec: fixture.definition,
		agentInfo: { name: "codex-acp" },
		capabilities: { sessionList: true },
		async listSessions() { acpListCalls += 1; return []; },
	};
	fixture.app.ready = true;
	const previous = {
		path: process.env.PATH,
		started: process.env.CC_TEST_SQLITE_STARTED,
		gate: process.env.CC_TEST_SQLITE_GATE,
	};
	try {
		process.env.PATH = `${binDir}${path.delimiter}${previous.path ?? ""}`;
		process.env.CC_TEST_SQLITE_STARTED = started;
		process.env.CC_TEST_SQLITE_GATE = gate;
		const resume = fixture.app.openResumeDialog();
		await waitFor(() => fs.existsSync(started), "local Codex lookup should start");
		fixture.app.handleInterrupt("input");
		fs.writeFileSync(gate, "continue");
		await resume;
		assert.equal(acpListCalls, 0);
		assert.equal(fixture.selections.length, 0);
		assert.equal(fixture.app.foregroundOperation, undefined);
	} finally {
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.started === undefined) delete process.env.CC_TEST_SQLITE_STARTED;
		else process.env.CC_TEST_SQLITE_STARTED = previous.started;
		if (previous.gate === undefined) delete process.env.CC_TEST_SQLITE_GATE;
		else process.env.CC_TEST_SQLITE_GATE = previous.gate;
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Cancellation and failure while session/list itself is pending both release
// the exclusive lease. Neither can open a stale picker later.
await (async () => {
	const cancelled = resumeFixture();
	const list = deferred();
	cancelled.app.client = {
		sessionId: "current",
		exited: false,
		launchSpec: cancelled.definition,
		agentInfo: { name: "fake-acp" },
		capabilities: { sessionList: true },
		listSessions: () => list.promise,
	};
	cancelled.app.ready = true;
	const resume = cancelled.app.openResumeDialog();
	await waitFor(() => cancelled.app.asyncPickerLoadCount === 1, "session listing should own its loader gate");
	assert.equal(cancelled.app.foregroundOperation?.status, "loading sessions");
	cancelled.app.handleInterrupt("input");
	assert.equal(cancelled.app.foregroundOperation, undefined);
	assert.equal(cancelled.app.asyncPickerLoadCount, 0);
	list.resolve([{ sessionId: "other", title: "Other" }]);
	await resume;
	assert.equal(cancelled.selections.length, 0);

	const failed = resumeFixture();
	failed.app.client = {
		sessionId: "current",
		exited: false,
		launchSpec: failed.definition,
		agentInfo: { name: "fake-acp" },
		capabilities: { sessionList: true },
		async listSessions() { throw new Error("session index unavailable"); },
	};
	failed.app.ready = true;
	await failed.app.openResumeDialog();
	assert.deepEqual(failed.errors, ["session index unavailable"]);
	assert.equal(failed.app.foregroundOperation, undefined);
	assert.equal(failed.app.asyncPickerLoadCount, 0);
	assert.equal(failed.selections.length, 0);
})();

// Cancellation releases the same deferred-local FIFO as normal completion.
await (async () => {
	const { app } = resumeFixture();
	let flushes = 0;
	app.deferredLocalSlashCommands = [{ name: "model", argument: "" }];
	app.flushDeferredLocalSlashCommands = async () => { flushes += 1; };
	const operation = app.beginForegroundOperation({ commandName: "resume", status: "loading sessions" });
	assert.equal(app.cancelForegroundOperation(), true);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(flushes, 1);
	assert.equal(operation.cancelled, true);
})();

// Completion from an obsolete owner cannot clear a newer foreground status.
await (async () => {
	const { app } = resumeFixture();
	const old = app.beginForegroundOperation({ commandName: "resume", status: "loading sessions" });
	const newer = { commandName: "model", status: "loading models", cancelled: false };
	app.foregroundOperation = newer;
	assert.equal(app.endForegroundOperation(old), false);
	assert.equal(app.foregroundOperation, newer);
})();

// Host capability commands remain local before ACP advertisements arrive. Each
// handler joins the cold connection and validates the live capability instead
// of forwarding a same-named slash prompt to an uninitialized backend.
await (async () => {
	const routed = coldCommandFixture();
	const coldNames = new Set(localSlashCommands(routed.app).map((command) => command.name));
	for (const name of ["cd", "branch", "tasks"]) {
		assert.equal(coldNames.has(name), true, `/${name} should autocomplete before ACP startup`);
		assert.equal(routed.app.slashCommandRoute(name), "local", `/${name} should retain host routing while cold`);
	}

	const cd = coldCommandFixture();
	const cdConnections = [];
	cd.app.ensureConnected = async (options) => {
		cdConnections.push(options.commandName);
		cd.app.client = {
			exited: false,
			sessionId: "cwd-session",
			capabilities: { changeWorkingDirectory: true },
		};
		cd.app.ready = true;
		return true;
	};
	cd.app.requestWorkingDirectoryChange = async () => ({ status: "rejected", message: "move rejected" });
	await cd.app.runChangeWorkingDirectory(".");
	assert.deepEqual(cdConnections, ["cd"]);
	assert.ok(cd.notices.includes("move rejected"));

	const tasks = coldCommandFixture();
	const taskConnections = [];
	tasks.app.ensureConnected = async (options) => {
		taskConnections.push(options.commandName);
		tasks.app.client = {
			exited: false,
			sessionId: "task-session",
			capabilities: { backgroundTasks: true },
			async listBackgroundTasks() { return { revision: 0, tasks: [], total: 0 }; },
		};
		tasks.app.ready = true;
		return true;
	};
	await tasks.app.runBackgroundTasksCommand("");
	assert.deepEqual(taskConnections, ["tasks"]);
	assert.ok(tasks.notices.some((message) => message.includes("No background tasks")));

	const branch = coldCommandFixture();
	const branchConnections = [];
	branch.app.ensureConnected = async (options) => {
		branchConnections.push(options.commandName);
		branch.app.client = {
			exited: false,
			sessionId: "branch-session",
			capabilities: { fork: false },
		};
		branch.app.ready = true;
		return true;
	};
	assert.equal(await branch.app.branchCurrentSession(), false);
	assert.deepEqual(branchConnections, ["branch"]);
	assert.ok(branch.notices.some((message) => message.includes("does not advertise session forking")));
})();

// A cold /btw owns the same visible startup lease as other capability commands.
// Cancellation restores its original intent immediately and late connection
// completion cannot open a side thread.
await (async () => {
	const fixture = coldCommandFixture();
	const connect = deferred();
	let connectOptions;
	fixture.app.ensureConnected = async (options) => {
		connectOptions = options;
		await connect.promise;
		fixture.app.client = {
			exited: false,
			sessionId: "main-session",
			capabilities: { fork: true },
		};
		fixture.app.ready = true;
		return true;
	};
	fixture.app.createRuntimeAdapter = () => assert.fail("cancelled /btw must not create a side adapter");
	const opening = fixture.app.runBtw("inspect startup");
	assert.equal(fixture.app.foregroundOperation?.commandName, "btw");
	assert.equal(connectOptions.foregroundOperation, fixture.app.foregroundOperation);
	fixture.app.editor.setText("newer draft");
	fixture.app.lastKnownEditorText = "newer draft";
	fixture.app.handleInterrupt("input");
	assert.equal(fixture.app.editor.getText(), "/btw inspect startup\nnewer draft");
	connect.resolve();
	await opening;
	assert.equal(fixture.app.btwThread, undefined);
	assert.equal(fixture.commands.length, 0);
})();

// The main process must never load the exact session currently owned by the
// live /btw ACP process.
await (async () => {
	const fixture = coldCommandFixture();
	let loads = 0;
	fixture.app.client = {
		exited: false,
		sessionId: "main-session",
		async loadSession() { loads += 1; },
	};
	fixture.app.ready = true;
	fixture.app.btwThread = { sessionId: "live-side-session", client: { sessionId: "live-side-session" } };
	await fixture.app.resumeSelectedSession({ sessionId: "live-side-session", title: "Side" });
	assert.equal(loads, 0);
	assert.ok(fixture.notices.some((message) => message.includes("currently open in /btw")));
})();

// Adapter-owned cross-process guards reject a live Codex side rollout before
// session/load, while still unwinding the host's transition gate cleanly.
await (async () => {
	const fixture = coldCommandFixture();
	let loads = 0;
	const leaseError = new Error(
		"That Codex session is open in another cc process. Close its /btw side thread before resuming it here.",
	);
	leaseError.code = "CC_SESSION_LEASE_ACTIVE";
	fixture.app.client = {
		exited: false,
		sessionId: "main-session",
		async acquireSessionLoadGuard() { throw leaseError; },
		async loadSession() { loads += 1; },
	};
	fixture.app.ready = true;
	fixture.app.settleDeferredBtwPrompts = async () => {};
	fixture.app.restoreFailedSessionSwitchInput = () => {};
	await fixture.app.resumeSelectedSession({ sessionId: "cross-process-side", title: "Side elsewhere" });
	assert.equal(loads, 0);
	assert.equal(fixture.app.sessionSwitchInProgress, false);
	assert.ok(fixture.notices.some((message) => message.includes("another cc process")));
})();

// Deferral is explicit in the transcript, so a picker that opens after a slow
// session transition cannot look like an unrelated surprise.
await (async () => {
	const fixture = coldCommandFixture();
	fixture.app.sessionSwitchInProgress = true;
	await fixture.app.runLocalSlashCommand("resume", "");
	assert.deepEqual(fixture.app.deferredLocalSlashCommands.map((entry) => entry.name), ["resume"]);
	assert.ok(fixture.notices.some((message) => message === "Queued /resume until the current session transition finishes."));

	const sideNotices = [];
	const side = { addNotice(message) { sideNotices.push(message); } };
	fixture.app.btwThread = side;
	fixture.app.onThreadActivity = () => {};
	fixture.app.deferLocalSlashCommand("model", "fast", {
		targetThread: side,
		reason: "the main transition finishes",
	});
	assert.deepEqual(sideNotices, ["Queued /model fast until the main transition finishes."]);
	assert.equal(
		fixture.notices.includes("Queued /model fast until the main transition finishes."),
		false,
		"a focused side deferral is explained in the visible side transcript",
	);
})();

// A terminal replacement fence is checked even after a prior /btw shutdown
// promise has settled and cleared. Neither listing nor direct loading may revive
// a session that an unconfirmed side process could still own.
await (async () => {
	const fixture = coldCommandFixture();
	const fence = new Error("old side process is still live");
	fence.code = "PROCESS_TREE_TERMINATION_FAILED";
	fixture.app.replacementProcessFence = fence;
	let loads = 0;
	fixture.app.client = {
		exited: false,
		sessionId: "main-session",
		capabilities: { sessionList: true },
		async listSessions() { assert.fail("a fenced /resume must not list sessions"); },
		async loadSession() { loads += 1; },
	};
	fixture.app.ready = true;
	await fixture.app.openResumeDialog();
	await fixture.app.resumeSelectedSession({ sessionId: "orphaned-side", title: "Side" });
	assert.equal(loads, 0);
	assert.equal(fixture.app.foregroundOperation, undefined);
	assert.ok(fixture.commands.includes("/resume"));
	assert.ok(fixture.notices.some((message) => /restart cc/u.test(message)));
})();

// Side-local commands are visibly queued, and a target that closed between the
// app FIFO and side FIFO resolves immediately instead of hanging a /resume
// selection action forever.
await (async () => {
	const fixture = coldCommandFixture();
	fixture.app.onThreadActivity = () => {};
	const client = { exited: false, sessionId: "side-session", capabilities: {} };
	const side = new BtwThread(fixture.app, client, "");
	side.ready = true;
	side.state = "ready";
	side.busy = true;
	const sideNotices = [];
	side.addNotice = (message) => sideNotices.push(message);
	fixture.app.btwThread = side;
	const queued = side.deferLocalCommand("model", "fast", {
		reason: "the current /btw turn finishes",
	});
	assert.deepEqual(sideNotices, ["Queued /model fast until the current /btw turn finishes."]);
	side.cancelDeferredLocalCommands();
	assert.equal(await queued, false);

	fixture.app.btwThread = undefined;
	assert.equal(await side.deferLocalCommand("model", "high"), false);
	assert.ok(fixture.notices.some((message) => /targeted \/btw thread is no longer open/u.test(message)));

	let deferralOptions;
	fixture.app.btwThread = side;
	side.busy = true;
	side.deferLocalCommand = async (_name, _argument, options) => {
		deferralOptions = options;
		return false;
	};
	await fixture.app.runLocalSlashCommand("model", "fast", { targetThread: side });
	assert.equal(deferralOptions.reason, "the current /btw turn finishes");
})();

// A foreground main-pane operation is one continuous submission lease for both
// panes. Side input queues with an explanation and drains when that exact owner
// releases, rather than starting behind a slow /resume.
await (async () => {
	const fixture = coldCommandFixture();
	fixture.app.onThreadActivity = () => {};
	const client = { exited: false, sessionId: "side-session", capabilities: {} };
	const side = new BtwThread(fixture.app, client, "");
	side.ready = true;
	side.state = "ready";
	const notices = [];
	side.addNotice = (message) => notices.push(message);
	let prompts = 0;
	side.sendPrompt = async () => { prompts += 1; };
	fixture.app.btwThread = side;
	const operation = fixture.app.beginForegroundOperation({ commandName: "resume", status: "loading sessions" });
	await side.submit("wait for resume");
	assert.equal(prompts, 0);
	assert.equal(side.queue.length, 1);
	assert.deepEqual(notices, ["Queued while loading sessions. It will send automatically afterward."]);
	fixture.app.endForegroundOperation(operation);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(prompts, 1);
})();

// Prompt-expanding local commands retain their side target when the shared FIFO
// drains after a root operation instead of leaking the expanded prompt to main.
await (async () => {
	const fixture = coldCommandFixture();
	let submitted;
	const side = {
		client: { exited: false },
		async submit(text, _parts, options) { submitted = { text, displayText: options.displayText }; },
	};
	fixture.app.btwThread = side;
	await fixture.app.runInitCommand("init", { targetThread: side });
	assert.match(submitted.text, /Create or improve an AGENTS\.md/u);
	assert.equal(submitted.displayText, "/init");
})();

// A diverged-cwd teardown that reconnects solely to deliver queued prompts must
// promote a "connecting" status: the quiet lifecycle then owns the label and
// clears it on success or failure instead of leaving a silent (or stuck) wait.
await (async () => {
	const fixture = coldCommandFixture();
	const client = {
		exited: false,
		sessionId: "old",
		async stopAndWait() {},
	};
	Object.assign(fixture.app, {
		client,
		ready: true,
		promptQueue: [{ text: "queued while cwd diverged", timing: "afterTurn" }],
		agentSwitchTail: undefined,
		workingDirectoryShutdownTail: undefined,
		stopping: false,
		cancelPermissionPrompts() {},
		clearCancelGraceTimer() {},
	});
	const context = fixture.app.captureActiveAgentContext({ includeClient: true });
	let reconnectOptions;
	fixture.app.switchAgent = async (_key, _transport, options) => { reconnectOptions = options; };
	assert.equal(fixture.app.disconnectDivergedWorkingDirectorySession(context, { quiet: true }), true);
	await waitFor(() => reconnectOptions !== undefined, "the teardown finalizer should reconnect for queued prompts");
	assert.equal(reconnectOptions.quiet, true);
	assert.equal(reconnectOptions.statusState, "connecting", "the reconnect lifecycle must own a visible connecting status");
})();

console.log("slow startup UX tests passed");
