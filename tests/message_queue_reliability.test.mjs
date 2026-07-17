import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const harnessUrl = process.env.CC_HARNESS_MODULE
	? pathToFileURL(path.resolve(process.env.CC_HARNESS_MODULE)).href
	: new URL("../src/pi-harness.mjs", import.meta.url).href;
const { BtwThread, HarnessApp } = await import(harnessUrl);
const selectedCase = process.env.CC_QUEUE_CASE;
const shouldRun = (name) => !selectedCase || selectedCase === name;

async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(message);
}

function queueFixture() {
	const delivered = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		stopping: false,
		ready: true,
		busy: false,
		foregroundOperation: undefined,
		workingTreeMutationOperation: undefined,
		sessionSwitchInProgress: false,
		flushingDeferredLocalSlashCommands: false,
		selectionActionInProgress: false,
		configUpdateCount: 0,
		asyncPickerLoadCount: 0,
		menuHandle: undefined,
		flushingPromptQueue: false,
		promptQueueDrainScheduled: false,
		promptQueueWatchdogTimer: undefined,
		queuedPromptReconnect: undefined,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		deferredBtwPrompts: [],
		queuedInputOrder: 0,
		client: { exited: false },
		pendingUserEchoes: [],
		pendingUnsendPrompt: undefined,
		conversationStarted: false,
		statusState: "",
		updateSpinner() {},
		trackPendingUserEcho: () => ({}),
		addUserMessage: () => ({}),
		armPendingUnsendPrompt() {},
		async sendPrompt(text) {
			delivered.push(text);
			this.busy = false;
		},
		addError(error) {
			assert.fail(error);
		},
		ui: { requestRender() {} },
	});
	return { app, delivered };
}

// Reproduction 1: the immediate drain timer can fire while a turn/operation is
// still busy. If its owner misses the later wake-up, main used to leave the item
// in `after turn` forever. The queue-owned watchdog must recover independently.
if (shouldRun("watchdog")) for (const [gate, blockedValue, releasedValue] of [
	["busy", true, false],
	["foregroundOperation", { status: "loading" }, undefined],
	["workingTreeMutationOperation", { label: "applying" }, undefined],
	["sessionSwitchInProgress", true, false],
	["flushingDeferredLocalSlashCommands", true, false],
	["selectionActionInProgress", true, false],
	["configUpdateCount", 1, 0],
	["asyncPickerLoadCount", 1, 0],
	["menuHandle", {}, undefined],
]) {
	const { app, delivered } = queueFixture();
	app[gate] = blockedValue;
	app.enqueuePrompt(`blocked by ${gate}`, "afterTurn");
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(delivered, [], `${gate} must block delivery`);
	app[gate] = releasedValue;
	await waitFor(() => delivered.length === 1, `queue did not recover after ${gate} cleared`);
	assert.deepEqual(app.promptQueue, [], `${gate} recovery must consume the queue exactly once`);
}

if (shouldRun("watchdog")) {
	const { app, delivered } = queueFixture();
	app.busy = true;
	const expected = Array.from({ length: 100 }, (_, index) => `burst ${index}`);
	for (const text of expected) app.enqueuePrompt(text, "afterTurn");
	await new Promise((resolve) => setTimeout(resolve, 30));
	app.busy = false;
	// Race many ordinary wake-ups against the watchdog. Coalescing must preserve
	// strict FIFO and exactly-once queue consumption.
	for (let index = 0; index < 25; index += 1) app.schedulePromptQueueDrain();
	await waitFor(() => delivered.length === expected.length, "burst queue did not fully drain");
	assert.deepEqual(delivered, expected);
	assert.deepEqual(app.promptQueue, []);
}

if (shouldRun("watchdog")) {
	const { app } = queueFixture();
	const commands = [];
	app.runLocalSlashCommand = async (name, argument) => commands.push(`${name} ${argument}`);
	app.deferLocalSlashCommand("model", "fast", { announce: false });
	await waitFor(() => commands.length === 1, "deferred local command queue did not self-drain");
	assert.deepEqual(commands, ["model fast"]);
	assert.deepEqual(app.deferredLocalSlashCommands, []);

	const sidePrompts = [];
	app.sessionSwitchInProgress = true;
	app.btwThread = {
		client: { exited: false },
		async submit(text, _parts, options) { sidePrompts.push({ text, order: options?.queuedInputOrder }); },
	};
	app.deferredBtwPrompts.push({ text: "held side prompt", queuedInputOrder: 1 });
	app.armPromptQueueWatchdog();
	await new Promise((resolve) => setTimeout(resolve, 30));
	app.sessionSwitchInProgress = false;
	await waitFor(() => sidePrompts.length === 1, "transition-held /btw input did not self-drain");
	assert.deepEqual(sidePrompts, [{ text: "held side prompt", order: 1 }]);
	assert.deepEqual(app.deferredBtwPrompts, []);
}

function crashFixture() {
	const fixture = queueFixture();
	const { app } = fixture;
	Object.assign(app, {
		busy: true,
		cancelRequested: false,
		afterToolCancelPending: false,
		permissionQueue: [],
		activeInteractiveRequest: undefined,
		activeKey: "fake",
		availableCommands: new Map(),
		commandsLoaded: new Set(),
		clearCancelGraceTimer() {},
		updateAutocomplete() {},
	});
	return fixture;
}

// Reproduction 2: main preserved queued prompts on backend_exit but never
// reconnected until some unrelated later submit. Recovery must reconnect and
// deliver the existing FIFO without requiring new user input.
if (shouldRun("crash")) {
	const { app, delivered } = crashFixture();
	const crashedClient = app.client;
	crashedClient.exited = true;
	app.promptQueue.push(
		{ text: "first committed message", timing: "afterTurn", queuedInputOrder: 1 },
		{ text: "second committed message", timing: "afterTurn", queuedInputOrder: 2 },
	);
	app.queuedInputOrder = 2;
	let reconnects = 0;
	let releaseReconnect;
	const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
	app.ensureConnected = async (options) => {
		assert.deepEqual(options, { statusState: "connecting", preserveDeferredCommands: true });
		reconnects += 1;
		await reconnectGate;
		app.client = { exited: false };
		app.ready = true;
		return true;
	};
	app.handleBackendEvent({ type: "backend_exit" });
	await waitFor(() => reconnects === 1, "queued crash recovery did not start reconnecting");
	app.enqueuePrompt("message typed during reconnect", "afterTurn");
	releaseReconnect();
	await waitFor(() => delivered.length === 3, "queued crash recovery did not deliver every message");
	assert.equal(reconnects, 1);
	assert.deepEqual(delivered, ["first committed message", "second committed message", "message typed during reconnect"]);
	assert.deepEqual(app.promptQueue, []);
}

// Crash recovery is owned by every committed-input queue, not just ordinary
// prompts. A transition can leave only a deferred command and /btw message at
// the instant backend_exit fires; both must still cause one reconnect and drain.
if (shouldRun("crash")) {
	const { app, delivered } = crashFixture();
	app.client.exited = true;
	app.deferredLocalSlashCommands.push({ name: "model", argument: "fast", queuedInputOrder: 1 });
	app.deferredBtwPrompts.push({ text: "side input after dead transition", queuedInputOrder: 2 });
	const commands = [];
	app.runLocalSlashCommand = async (name, argument) => commands.push(`${name} ${argument}`);
	let reconnects = 0;
	app.ensureConnected = async () => {
		reconnects += 1;
		app.client = { exited: false };
		app.ready = true;
		return true;
	};
	app.handleBackendEvent({ type: "backend_exit" });
	await waitFor(
		() => commands.length === 1 && delivered.length === 1,
		"deferred-only crash recovery did not drain all committed input",
	);
	assert.equal(reconnects, 1);
	assert.deepEqual(commands, ["model fast"]);
	assert.deepEqual(delivered, ["side input after dead transition"]);
	assert.deepEqual(app.deferredLocalSlashCommands, []);
	assert.deepEqual(app.deferredBtwPrompts, []);
	assert.deepEqual(app.promptQueue, []);
}

// Concurrent crash notifications/recovery checks share one reconnect attempt.
if (shouldRun("single-flight")) {
	const { app } = crashFixture();
	app.client.exited = true;
	app.promptQueue.push({ text: "single flight", timing: "afterTurn" });
	let reconnects = 0;
	let releaseReconnect;
	const reconnectGate = new Promise((resolve) => { releaseReconnect = resolve; });
	app.ensureConnected = async () => {
		reconnects += 1;
		await reconnectGate;
		app.client = { exited: false };
		app.ready = true;
		return true;
	};
	const first = app.reconnectForQueuedPrompts(app.client);
	const second = app.reconnectForQueuedPrompts(app.client);
	await Promise.resolve();
	assert.equal(reconnects, 1);
	releaseReconnect();
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
}

// A failed reconnect never discards input and never creates an automatic
// restart loop. The queue remains visible/retryable for explicit user action.
if (shouldRun("failure")) {
	const { app } = crashFixture();
	app.client.exited = true;
	app.promptQueue.push({ text: "survive failed reconnect", timing: "afterTurn" });
	app.deferredLocalSlashCommands.push({ name: "model", argument: "fast", queuedInputOrder: 2 });
	app.deferredBtwPrompts.push({ text: "survive deferred side input", queuedInputOrder: 3 });
	let reconnects = 0;
	app.ensureConnected = async () => {
		reconnects += 1;
		return false;
	};
	app.handleBackendEvent({ type: "backend_exit" });
	await new Promise((resolve) => setTimeout(resolve, 700));
	assert.equal(reconnects, 1);
	assert.deepEqual(app.promptQueue.map((entry) => entry.text), ["survive failed reconnect"]);
	assert.deepEqual(app.deferredLocalSlashCommands.map((entry) => entry.name), ["model"]);
	assert.deepEqual(app.deferredBtwPrompts.map((entry) => entry.text), ["survive deferred side input"]);
}

// A dead /btw backend cannot drain its independent FIFO. Return every queued
// prompt/command (and image) to the live composer instead of leaving invisible
// input attached to a dead pane.
if (shouldRun("side")) {
	const sidePrompts = [];
	const sideApp = {
		btwThread: undefined,
		foregroundOperation: undefined,
		workingTreeMutationOperation: undefined,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		menuHandle: undefined,
		selectionActionInProgress: false,
		ui: { terminal: { rows: 24 } },
		promptForActiveCapabilities: (text) => text,
		onThreadActivity() {},
	};
	const sideClient = {
		exited: false,
		capabilities: {},
		async prompt(prompt) {
			sidePrompts.push(prompt);
			return { stopReason: "end_turn" };
		},
	};
	const watchedThread = new BtwThread(sideApp, sideClient, "");
	sideApp.btwThread = watchedThread;
	watchedThread.ready = true;
	watchedThread.state = "ready";
	watchedThread.busy = true;
	await watchedThread.submit("side watchdog message");
	watchedThread.busy = false;
	await waitFor(() => sidePrompts.length === 1, "side queue did not recover after its blocker cleared");
	assert.deepEqual(sidePrompts, ["side watchdog message"]);
	assert.deepEqual(watchedThread.queue, []);
	watchedThread.clearQueueWatchdog();

	const closeFixture = () => {
		const notices = [];
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			btwThread: undefined,
			focusedThread: "btw",
			menuHandle: undefined,
			menuEditorText: undefined,
			pendingPromptDisplay: undefined,
			clipboardImages: [],
			lastKnownEditorText: "",
			mainView: { stick: false },
			editor: {
				text: "",
				getText() { return this.text; },
				setText(text) { this.text = text; },
			},
			ui: {
				terminal: { rows: 24, exitAlternateScreen() {} },
				requestRender() {},
			},
			updateAutocomplete() {},
			updateSpinner() {},
			forceFullRepaint() {},
			cancelInteractiveRequestsForClient() {},
			onThreadActivity() {},
			addNotice(message) { notices.push(message); },
		});
		return { app, notices };
	};

	// Closing an otherwise live side pane while a root blocker owns the drain must
	// return its mixed FIFO to the composer. Previously closeBtw discarded both
	// arrays, so this reproduces the teardown-specific loss independently of crash.
	const closed = closeFixture();
	closed.app.configUpdateCount = 1;
	const closeClient = { exited: false };
	const closingThread = new BtwThread(closed.app, closeClient, "");
	closed.app.btwThread = closingThread;
	closingThread.ready = true;
	await closingThread.submit("queued before close");
	const closingCommand = closingThread.deferLocalCommand("model", "fast", { announce: false });
	closed.app.closeBtw({ stop: false });
	assert.equal(await closingCommand, false);
	assert.equal(closed.app.editor.getText(), "queued before close\n/model fast");
	assert.deepEqual(closingThread.queue, []);
	assert.deepEqual(closingThread.localCommandQueue, []);
	assert.ok(closed.notices.some((message) => message.includes("queued input was returned")));

	const notices = [];
	const commandOutcomes = [];
	const { app } = closeFixture();
	app.addNotice = (message) => notices.push(message);
	const client = { exited: true, cancel() {}, async stopAndWait() {} };
	const thread = new BtwThread(app, client, "");
	app.btwThread = thread;
	thread.queue.push({
		text: "side [Image 1]",
		promptParts: [
			{ type: "text", text: "side " },
			{ type: "image", data: "aW1hZ2U=", mimeType: "image/png", label: "[Image 1]" },
		],
		queuedInputOrder: 2,
	});
	thread.localCommandQueue.push({
		name: "model",
		argument: "fast",
		queuedInputOrder: 1,
		resolve: (outcome) => commandOutcomes.push(outcome),
	});
	thread.handleEvent({ type: "backend_exit" });
	await Promise.resolve();
	assert.equal(app.btwThread, undefined);
	assert.equal(app.focusedThread, "main");
	assert.equal(app.editor.getText(), "/model fast\nside [Image 1]");
	assert.deepEqual(commandOutcomes, [false]);
	assert.equal(app.clipboardImages[0]?.data, "aW1hZ2U=");
	assert.deepEqual(thread.queue, []);
	assert.deepEqual(thread.localCommandQueue, []);
	assert.ok(notices.some((message) => message.includes("returned to the composer")));

	// Reproduce the operation-finalizer race directly: the client is already dead,
	// but backend_exit has not yet run and a stale owner calls drainQueue(). The
	// dequeue guard must recover the untouched head rather than shift and drop it.
	const raced = closeFixture();
	const racedClient = { exited: true, cancel() {}, async stopAndWait() {} };
	const racedThread = new BtwThread(raced.app, racedClient, "");
	raced.app.btwThread = racedThread;
	racedThread.ready = true;
	racedThread.queue.push({ text: "exit race head", queuedInputOrder: 1 });
	racedThread.drainQueue();
	assert.equal(raced.app.btwThread, undefined);
	assert.equal(raced.app.editor.getText(), "exit race head");
	assert.deepEqual(racedThread.queue, []);

	// A backend can exit in the event-loop gap before Enter reaches submit(). That
	// freshly consumed input was never in either FIFO, so recovery accepts it as an
	// additional ordered entry and closes the dead pane visibly.
	const late = closeFixture();
	const lateClient = { exited: true, cancel() {}, async stopAndWait() {} };
	const lateThread = new BtwThread(late.app, lateClient, "");
	late.app.btwThread = lateThread;
	await lateThread.submit("typed after side exit");
	assert.equal(late.app.btwThread, undefined);
	assert.equal(late.app.editor.getText(), "typed after side exit");
	assert.ok(late.notices.some((message) => message.includes("backend exited")));

	const lateCommand = closeFixture();
	const lateCommandClient = { exited: true, cancel() {}, async stopAndWait() {} };
	const lateCommandThread = new BtwThread(lateCommand.app, lateCommandClient, "");
	lateCommand.app.btwThread = lateCommandThread;
	assert.equal(await lateCommandThread.deferLocalCommand("model", "fast"), false);
	assert.equal(lateCommand.app.btwThread, undefined);
	assert.equal(lateCommand.app.editor.getText(), "/model fast");
	assert.ok(lateCommand.notices.some((message) => message.includes("backend exited")));
}

console.log(
	selectedCase
		? `message queue reliability: ${selectedCase} passed`
		: "message queue reliability: stranded-drain recovery, crash replay, single-flight, failure preservation, and side teardown recovery passed",
);
