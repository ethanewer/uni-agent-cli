import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessApp } from "../src/pi-harness.mjs";

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
	for (let attempt = 0; attempt < 100; attempt += 1) {
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

console.log("slow startup UX tests passed");
