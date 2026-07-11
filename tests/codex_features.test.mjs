import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
	AcpClient,
	BtwThread,
	codexStoredSessionPresence,
	forgetForkIds,
	HarnessApp,
	loadForkIds,
	loadForkParents,
	localSlashCommands,
	normalizeAdditionalDirectories,
	recordForkId,
	runCodexAppServerRequests,
	runCodexCommand,
} from "../src/pi-harness.mjs";

// Fork ownership is persistent production state. Keep this whole suite isolated
// so deletion/fork regressions never inspect or rewrite the developer's registry.
const previousForkRegistry = process.env.CC_FORKS;
const testForkRegistryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-features-forks-"));
process.env.CC_FORKS = path.join(testForkRegistryRoot, "forks.json");
process.once("exit", () => fs.rmSync(testForkRegistryRoot, { recursive: true, force: true }));

function appHarness(agent = {}) {
	const notices = [];
	const errors = [];
	const commands = [];
	const blocks = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { codex: agent }, settings: {} },
		client: { sessionId: "11111111-2222-7333-8444-555555555555", exited: false },
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		statusState: "",
		promptQueue: [],
		deferredLocalSlashCommands: [],
		clipboardImages: [],
		sessionStates: new Map(),
		availableCommands: new Map(),
		commandsLoaded: new Set(),
		runtimePermissionMode: new Map(),
		runtimePermissionModeSource: new Map(),
		runtimePermissionModeByClient: new WeakMap(),
		runtimePermissionBackendContextByClient: new WeakMap(),
		permissionGrants: [],
		permissionQueue: [],
		permissionPromptActive: false,
		activeInteractiveRequest: undefined,
		activeToolIds: new Set(),
		activeAnonymousToolCount: 0,
		seenToolThisTurn: false,
		pendingUserEchoes: [],
		ui: { requestRender() {} },
		editor: {
			text: "",
			getText() { return this.text; },
			setText(text) { this.text = text; },
			addToHistory() {},
		},
		addCommandMessage(message) { commands.push(message); },
		addNotice(message) { notices.push(message); },
		addError(message) { errors.push(message); },
		showMarkdownBlock(message) { blocks.push(message); },
		updateSpinner() {},
		updateAutocomplete() {},
		schedulePromptQueueDrain() {},
		refreshCodexThreadStateSnapshot() {},
		beginAsyncPickerLoad() { return Symbol("operation"); },
		endAsyncPickerLoad() {},
	});
	return { app, notices, errors, commands, blocks };
}

// Windows-native settings commonly use ~\dir. Expand either separator on every
// host so the behavior is deterministic and testable outside Windows.
assert.deepEqual(normalizeAdditionalDirectories(["~\\shared-repo"]), [path.join(os.homedir(), "shared-repo")]);

// Fork registry UUIDs are case-insensitive just like live Codex session IDs.
// Forgetting a differently cased spelling removes both the label and parent edge.
{
	const childId = "ABCDEF12-3456-7890-ABCD-EF1234567890";
	const parentId = "11111111-2222-7333-8444-555555555555";
	recordForkId(childId, parentId, { required: true });
	assert.equal(forgetForkIds(childId.toLowerCase(), { required: true }), true);
	assert.equal([...loadForkIds()].some((id) => id.toLowerCase() === childId.toLowerCase()), false);
	assert.equal([...loadForkParents().keys()].some((id) => id.toLowerCase() === childId.toLowerCase()), false);
}

// Codex UUIDs are case-insensitive. A mixed-case current target must stop the
// active client and start a replacement after a successful native deletion.
{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-delete-case-"));
	try {
		const cli = path.join(root, "codex.mjs");
		fs.writeFileSync(cli, "process.exit(0);\n");
		fs.chmodSync(cli, 0o755);
		const { app, errors } = appHarness({ env: { CODEX_PATH: cli, PATH: "" } });
		let stops = 0;
		let switches = 0;
		app.client.stop = () => { stops += 1; };
		app.resetConversationView = () => {};
		app.switchAgent = async () => {
			switches += 1;
			app.client = { sessionId: "fresh", exited: false };
			app.ready = true;
		};
		await app.deleteSessionPermanently(app.client.sessionId.toUpperCase(), { codex: true, current: false });
		assert.equal(stops, 1);
		assert.equal(switches, 1);
		assert.deepEqual(errors, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Any live /btw turn blocks deletion, even when the command was submitted from
// the main pane. Recheck after confirmation so a side turn that starts while the
// dialog is open cannot be terminated underneath its prompt.
await (async () => {
	const { app, notices, errors } = appHarness();
	const sideThread = { busy: true };
	app.btwThread = sideThread;
	app.openSelection = () => assert.fail("a busy side thread must block the delete confirmation");
	await app.openDeleteDialog();
	assert.match(notices.at(-1), /cannot be deleted while a turn is running/);

	sideThread.busy = false;
	let confirm;
	app.openSelection = (_title, _entries, callback) => { confirm = callback; };
	app.closeMenu = () => {};
	await app.openDeleteDialog();
	assert.equal(typeof confirm, "function");
	sideThread.busy = true;
	await confirm({ value: "delete" });
	assert.match(notices.at(-1), /cannot be deleted while a turn is running/);
	assert.deepEqual(errors, []);
	assert.equal(app.sessionSwitchInProgress, false);
})();

// Archive/unarchive are the same native storage-mutation class as delete: a
// main-pane command must not stop a busy side owner or one of its ancestors.
for (const commandName of ["archive", "unarchive"]) {
	const { app, notices } = appHarness();
	app.btwThread = { busy: true };
	await app.runCodexSessionCommand(commandName, "side-session");
	assert.match(notices.at(-1), /unavailable while a turn is running/);
	assert.equal(app.sessionSwitchInProgress, false);
}

// Failure before a delete attempt (no compatible CLI) leaves the healthy live
// session alone instead of stopping/reloading it.
{
	const { app, errors } = appHarness({ env: { PATH: "", CODEX_PATH: "/missing/codex" } });
	let stops = 0;
	let switches = 0;
	app.client.stop = () => { stops += 1; };
	app.switchAgent = async () => { switches += 1; };
	await app.deleteSessionPermanently(app.client.sessionId, { codex: true, current: true });
	assert.equal(stops, 0);
	assert.equal(switches, 0);
	assert.equal(app.ready, true);
	assert.ok(errors.some((message) => message.includes("no compatible Codex CLI")));
}

// If SIGKILL cannot confirm that the old process tree is gone, current-session
// native mutations must not start either the Codex command or a replacement
// backend. Queued input is restored to the composer for an explicit retry.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-fatal-tree-stop-"));
	try {
		const cli = path.join(root, "codex.mjs");
		const launchMarker = path.join(root, "launched");
		fs.writeFileSync(cli, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(launchMarker)}, "launched");\n`);
		fs.chmodSync(cli, 0o755);
		for (const operation of ["archive", "delete"]) {
			const { app, errors } = appHarness({ env: { CODEX_PATH: cli, PATH: "" } });
			const sessionId = app.client.sessionId;
			const restored = [];
			let switches = 0;
			app.client.stopAndWait = async function stopAndWait() {
				this.exited = true;
				const error = new Error("backend process tree did not exit after SIGKILL");
				error.code = "PROCESS_TREE_TERMINATION_FAILED";
				throw error;
			};
			app.promptQueue.push({ text: `${operation} queued prompt`, queuedInputOrder: 1 });
			app.restoreQueuedTextToComposer = (entries) => restored.push(...entries.map((entry) => entry.text));
			app.switchAgent = async () => { switches += 1; };
			if (operation === "archive") await app.runCodexSessionCommand("archive", sessionId);
			else await app.deleteSessionPermanently(sessionId, { codex: true, current: true });
			assert.equal(switches, 0, `${operation} must not reconnect after unconfirmed termination`);
			assert.equal(fs.existsSync(launchMarker), false, `${operation} native command must not start`);
			assert.deepEqual(restored, [`${operation} queued prompt`]);
			assert.equal(app.ready, false);
			assert.equal(app.sessionSwitchInProgress, false);
			assert.ok(errors.some((message) => message.includes("did not exit after SIGKILL")));
			assert.ok(app.replacementProcessFence, `${operation} records a sticky process-tree fence`);
			if (operation === "archive") await app.runCodexSessionCommand("archive", sessionId);
			else await app.deleteSessionPermanently(sessionId, { codex: true, current: true });
			assert.equal(fs.existsSync(launchMarker), false, `${operation} retry stays fenced`);
			assert.ok(errors.some((message) => message.includes("restart cc")));
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Native session mutations must quiesce every live ACP owner of the target
// before Codex touches its rollout. A /btw fork is a separate process, and
// deleting the main session recursively deletes that fork as a descendant.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-side-owner-"));
	const cli = path.join(root, "fake-codex.mjs");
	const log = path.join(root, "commands.jsonl");
	const mainId = "11111111-2222-7333-8444-555555555555";
	const sideId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
	const deferred = () => {
		let resolve;
		const promise = new Promise((done) => { resolve = done; });
		return { promise, resolve };
	};
	// Native callers can detach the side pane without pre-signalling its client;
	// stopAndWait must be the code that installs close tracking and sends SIGTERM.
	{
		let cancels = 0;
		let stops = 0;
		let timerClears = 0;
		const app = Object.create(HarnessApp.prototype);
		app.btwThread = {
			client: { cancel() { cancels += 1; } },
			clearCancelGraceTimer() { timerClears += 1; },
			stop() { stops += 1; },
		};
		app.focusedThread = "btw";
		app.mainView = {};
		app.cancelInteractiveRequestsForClient = () => {};
		app.updateAutocomplete = () => {};
		app.updateSpinner = () => {};
		app.ui = { terminal: { exitAlternateScreen() {} } };
		app.forceFullRepaint = () => {};
		app.closeBtw({ stop: false });
		assert.equal(app.btwThread, undefined);
		assert.equal(app.focusedThread, "main");
		assert.equal(cancels, 0);
		assert.equal(stops, 0);
		assert.equal(timerClears, 1);
	}
	fs.writeFileSync(cli, `import fs from "node:fs"; fs.appendFileSync(process.env.CC_TEST_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
	fs.chmodSync(cli, 0o755);
	const makeOwnedApp = () => {
		const harness = appHarness({ env: {
			CODEX_PATH: cli,
			CODEX_HOME: path.join(root, "isolated-codex-home"),
			PATH: "",
			CC_TEST_LOG: log,
		} });
		harness.app.client.sessionId = mainId;
		const sideClient = { sessionId: sideId, exited: false };
		const sideThread = { sessionId: sideId, client: sideClient, busy: false };
		harness.app.btwThread = sideThread;
		harness.app.focusedThread = "btw";
		harness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		harness.app.closeBtw = (options = {}) => {
			assert.equal(options.stop, false, "native mutation must install stopAndWait before signaling the side process");
			assert.equal(harness.app.btwThread, sideThread);
			harness.app.btwThread = undefined;
			harness.app.focusedThread = "main";
		};
		harness.app.settleDeferredBtwPrompts = async () => {};
		return { ...harness, sideClient, sideThread };
	};
	try {
		// A bare side-focused /archive targets the side session and waits for its
		// process tree before launching the native command.
		{
			const { app, sideClient, sideThread, errors } = makeOwnedApp();
			const stopStarted = deferred();
			const releaseStop = deferred();
			sideClient.stopAndWait = async () => {
				stopStarted.resolve();
				await releaseStop.promise;
			};
			app.client.stopAndWait = async () => assert.fail("archiving the side session must not stop main");
			const operation = app.runLocalSlashCommand("archive", "", { targetThread: sideThread });
			await stopStarted.promise;
			assert.equal(fs.existsSync(log), false, "archive CLI cannot start while the side process is live");
			releaseStop.resolve();
			await operation;
			assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8").trim()), ["archive", sideId]);
			assert.deepEqual(errors, []);
			fs.rmSync(log, { force: true });
		}

		// An explicit side UUID passed to /delete has the same ownership rule.
		{
			const { app, sideClient, sideThread, errors } = makeOwnedApp();
			const stopStarted = deferred();
			const releaseStop = deferred();
			sideClient.stopAndWait = async () => {
				stopStarted.resolve();
				await releaseStop.promise;
			};
			app.client.stopAndWait = async () => assert.fail("deleting the side session must not stop main");
			const operation = app.deleteSessionPermanently(sideId, { codex: true, targetThread: sideThread });
			await stopStarted.promise;
			assert.equal(fs.existsSync(log), false, "delete CLI cannot start while the side process is live");
			releaseStop.resolve();
			await operation;
			assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8").trim()), ["delete", sideId, "--force"]);
			assert.deepEqual(errors, []);
			fs.rmSync(log, { force: true });
		}

		// Deleting main must stop the descendant side first, then main, and launch
		// only after both waiters have confirmed process-tree exit.
		{
			recordForkId(sideId, mainId);
			const { app, sideClient, errors } = makeOwnedApp();
			const sideStarted = deferred();
			const releaseSide = deferred();
			const mainStarted = deferred();
			const releaseMain = deferred();
			sideClient.stopAndWait = async () => {
				sideStarted.resolve();
				await releaseSide.promise;
			};
			app.client.stopAndWait = async () => {
				mainStarted.resolve();
				await releaseMain.promise;
			};
			app.resetConversationView = () => {};
			app.switchAgent = async () => {
				app.client = { sessionId: "fresh", exited: false };
				app.ready = true;
			};
			const operation = app.deleteSessionPermanently(mainId, { codex: true, current: true });
			await sideStarted.promise;
			assert.equal(fs.existsSync(log), false);
			releaseSide.resolve();
			await mainStarted.promise;
			assert.equal(fs.existsSync(log), false);
			releaseMain.resolve();
			await operation;
			assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8").trim()), ["delete", mainId, "--force"]);
			assert.deepEqual(errors, []);
			fs.rmSync(log, { force: true });
		}

		// Deleting an ancestor discovered through Codex thread/list has the same
		// ownership requirements as deleting the live main UUID directly.
		{
			recordForkId(sideId, mainId);
			const { app, sideClient, errors } = makeOwnedApp();
			const ancestorId = "99999999-8888-7777-8666-555555555555";
			const events = [];
			let descendantRequest;
			app.runFencedCodexAppServerRequests = async (_invocation, requests, _agent, requestOptions) => {
				descendantRequest = requests[0];
				assert.equal(requestOptions.capabilities.experimentalApi, true);
				return [{ data: [{ id: mainId }], nextCursor: null }];
			};
			sideClient.stopAndWait = async () => { events.push("stop side"); };
			app.client.stopAndWait = async () => { events.push("stop main"); };
			app.resetConversationView = () => {};
			app.switchAgent = async () => {
				events.push("restart main");
				app.client = { sessionId: "fresh", exited: false };
				app.ready = true;
			};
			await app.deleteSessionPermanently(ancestorId, { codex: true });
			assert.equal(descendantRequest.method, "thread/list");
			assert.equal(descendantRequest.params.ancestorThreadId, ancestorId);
			assert.ok(descendantRequest.params.sourceKinds.includes("subAgentThreadSpawn"));
			assert.deepEqual(events, ["stop side", "stop main", "restart main"]);
			assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8").trim()), ["delete", ancestorId, "--force"]);
			assert.deepEqual(errors, []);
			fs.rmSync(log, { force: true });
		}

		// If side-tree liveness cannot be confirmed, abort before mutation while
		// keeping the untouched main session usable.
		{
			const { app, sideClient, sideThread, errors } = makeOwnedApp();
			sideClient.stopAndWait = async () => {
				const error = new Error("side process tree did not exit after SIGKILL");
				error.code = "PROCESS_TREE_TERMINATION_FAILED";
				throw error;
			};
			await app.deleteSessionPermanently(sideId, { codex: true, targetThread: sideThread });
			assert.equal(fs.existsSync(log), false);
			assert.equal(app.ready, true);
			assert.ok(app.replacementProcessFence);
			await app.runCodexSessionCommand("archive", mainId);
			assert.equal(fs.existsSync(log), false, "side-only fatal fence blocks a later native helper");
			assert.equal(app.ready, true, "healthy main remains usable after a side-only fatal stop");
			assert.ok(errors.some((message) => message.includes("side process tree did not exit")));
			assert.ok(errors.some((message) => message.includes("restart cc")));
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Permanent Codex deletion owns cc's copy-fork graph, including closed and
// nested copies. Children are deleted deepest-first; a child failure leaves the
// parent untouched and its edge available for a retry.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-copy-fork-delete-"));
	const codexHome = path.join(root, "codex-home");
	const day = path.join(codexHome, "sessions", "2026", "07", "10");
	const cli = path.join(root, "fake-codex.mjs");
	const log = path.join(root, "commands.jsonl");
	const rootId = "10000000-0000-7000-8000-000000000001";
	const liveChildId = "20000000-0000-7000-8000-000000000002";
	const grandchildId = "30000000-0000-7000-8000-000000000003";
	const closedSiblingId = "40000000-0000-7000-8000-000000000004";
	const writeRollout = (id) => {
		fs.mkdirSync(day, { recursive: true });
		fs.writeFileSync(
			path.join(day, `rollout-2026-07-10T12-00-00-${id}.jsonl`),
			`${JSON.stringify({ type: "session_meta", payload: { id } })}\n`,
		);
	};
	try {
		fs.writeFileSync(cli, `
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CC_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[1] === process.env.CC_FAIL_ID) process.exit(1);
`);
		fs.chmodSync(cli, 0o755);
		for (const id of [rootId, liveChildId, grandchildId, closedSiblingId]) writeRollout(id);
		recordForkId(liveChildId, rootId);
		recordForkId(grandchildId, liveChildId);
		recordForkId(closedSiblingId, rootId);

		const harness = appHarness({
			env: { CODEX_PATH: cli, CODEX_HOME: codexHome, PATH: "", CC_TEST_LOG: log },
		});
		harness.app.client.sessionId = rootId;
		const events = [];
		harness.app.client.stopAndWait = async () => { events.push("stop main"); };
		const sideClient = { sessionId: liveChildId, exited: false, stopAndWait: async () => { events.push("stop side"); } };
		const sideThread = { sessionId: liveChildId, client: sideClient, busy: false };
		harness.app.btwThread = sideThread;
		harness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		harness.app.closeBtw = (options = {}) => {
			assert.equal(options.stop, false);
			harness.app.btwThread = undefined;
		};
		harness.app.settleDeferredBtwPrompts = async () => {};
		harness.app.resetConversationView = () => {};
		harness.app.switchAgent = async () => {
			events.push("restart main");
			harness.app.client = { sessionId: "fresh", exited: false };
			harness.app.ready = true;
		};
		await harness.app.deleteSessionPermanently(rootId, { codex: true, current: true });
		assert.deepEqual(events, ["stop side", "stop main", "restart main"]);
		assert.deepEqual(
			fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
			[
				["delete", grandchildId, "--force"],
				["delete", liveChildId, "--force"],
				["delete", closedSiblingId, "--force"],
				["delete", rootId, "--force"],
			],
		);
		assert.equal(loadForkParents().has(liveChildId), false);
		assert.equal(loadForkParents().has(grandchildId), false);
		assert.equal(loadForkParents().has(closedSiblingId), false);

		fs.rmSync(log, { force: true });
		const retryRootId = "50000000-0000-7000-8000-000000000005";
		const failingChildId = "60000000-0000-7000-8000-000000000006";
		writeRollout(retryRootId);
		writeRollout(failingChildId);
		recordForkId(failingChildId, retryRootId);
		const retryHarness = appHarness({
			env: {
				CODEX_PATH: cli,
				CODEX_HOME: codexHome,
				PATH: "",
				CC_TEST_LOG: log,
				CC_FAIL_ID: failingChildId,
			},
		});
		retryHarness.app.client.sessionId = "unrelated-live-session";
		retryHarness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		retryHarness.app.settleDeferredBtwPrompts = async () => {};
		await retryHarness.app.deleteSessionPermanently(retryRootId, { codex: true });
		assert.deepEqual(
			fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
			[["delete", failingChildId, "--force"]],
			"a child failure prevents native deletion of the parent",
		);
		assert.equal(loadForkParents().get(failingChildId), retryRootId, "failed child edge remains retryable");
		assert.ok(retryHarness.errors.some((message) => message.includes("Could not delete session")));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Unknown storage state must fail closed. A corrupt/unreadable state DB cannot
// be treated as proof that a registered child is stale.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-copy-fork-unknown-"));
	const codexHome = path.join(root, "codex-home");
	const day = path.join(codexHome, "sessions", "2026", "07", "10");
	const cli = path.join(root, "fake-codex.mjs");
	const log = path.join(root, "commands.jsonl");
	const rootId = "a0000000-0000-7000-8000-00000000000a";
	const childId = "b0000000-0000-7000-8000-00000000000b";
	try {
		fs.mkdirSync(day, { recursive: true });
		fs.writeFileSync(path.join(day, `rollout-2026-07-10T13-00-00-${rootId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: rootId } })}\n`);
		fs.writeFileSync(cli, `import fs from "node:fs"; fs.appendFileSync(process.env.CC_TEST_LOG, "launched\\n");\n`);
		fs.chmodSync(cli, 0o755);
		const unknownLink = path.join(codexHome, "sessions", "unscanned-link");
		fs.symlinkSync(path.join(root, "missing-session-tree"), unknownLink);
		assert.equal(
			codexStoredSessionPresence(childId, { env: { CODEX_HOME: codexHome } }).status,
			"unknown",
			"an unscanned filesystem branch cannot prove that a child is absent",
		);
		recordForkId(childId);
		const legacyHarness = appHarness({ env: { CODEX_PATH: cli, CODEX_HOME: codexHome, PATH: "", CC_TEST_LOG: log } });
		legacyHarness.app.client.sessionId = "unrelated-live-session";
		legacyHarness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		legacyHarness.app.settleDeferredBtwPrompts = async () => {};
		await legacyHarness.app.deleteSessionPermanently(rootId, { codex: true });
		assert.equal(fs.existsSync(log), false, "unknown storage for a flat legacy fork blocks possible-parent deletion");
		assert.equal(loadForkParents().has(childId), false);
		assert.ok(legacyHarness.errors.some((message) => message.includes("cannot safely determine the parent")));
		forgetForkIds(childId);

		fs.rmSync(unknownLink, { force: true });
		fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "not a sqlite database");
		recordForkId(childId, rootId);
		const harness = appHarness({ env: { CODEX_PATH: cli, CODEX_HOME: codexHome, PATH: "", CC_TEST_LOG: log } });
		harness.app.client.sessionId = "unrelated-live-session";
		harness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		harness.app.settleDeferredBtwPrompts = async () => {};
		await harness.app.deleteSessionPermanently(rootId, { codex: true });
		assert.equal(fs.existsSync(log), false, "unknown child storage blocks deletion before the CLI starts");
		assert.equal(loadForkParents().get(childId), rootId, "uncertain ownership remains retryable");
		assert.ok(harness.errors.some((message) => message.includes("could not safely verify copy-fork")));
	} finally {
		forgetForkIds(childId);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A compressed pre-v2 fork whose history cannot be decoded is not assigned to a
// same-second sibling by filename alone. Deleting that possible parent fails
// closed and leaves both transcripts untouched.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compressed-legacy-fork-"));
	const codexHome = path.join(root, "codex-home");
	const day = path.join(codexHome, "sessions", "2026", "07", "10");
	const cli = path.join(root, "fake-codex.mjs");
	const log = path.join(root, "commands.jsonl");
	const parentId = "d0000000-0000-7000-8000-00000000000d";
	const childId = "e0000000-0000-7000-8000-00000000000e";
	try {
		fs.mkdirSync(day, { recursive: true });
		for (const id of [parentId, childId]) {
			fs.writeFileSync(path.join(day, `rollout-2026-07-10T15-00-00-${id}.jsonl.zst`), "not-a-zstd-frame");
		}
		fs.writeFileSync(cli, `import fs from "node:fs"; fs.appendFileSync(process.env.CC_TEST_LOG, "launched\\n");\n`);
		fs.chmodSync(cli, 0o755);
		recordForkId(childId);
		const harness = appHarness({ env: { CODEX_PATH: cli, CODEX_HOME: codexHome, PATH: "", CC_TEST_LOG: log } });
		harness.app.client.sessionId = "unrelated-live-session";
		harness.app.runFencedCodexAppServerRequests = async () => [{ data: [], nextCursor: null }];
		harness.app.settleDeferredBtwPrompts = async () => {};
		await harness.app.deleteSessionPermanently(parentId, { codex: true });
		assert.equal(fs.existsSync(log), false);
		assert.equal(loadForkParents().has(childId), false);
		assert.ok(harness.errors.some((message) => message.includes("cannot safely determine the parent")));
		assert.ok(fs.existsSync(path.join(day, `rollout-2026-07-10T15-00-00-${parentId}.jsonl.zst`)));
		assert.ok(fs.existsSync(path.join(day, `rollout-2026-07-10T15-00-00-${childId}.jsonl.zst`)));
	} finally {
		forgetForkIds(childId);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// The long-lived fork operation lock spans deletion's graph snapshot through
// native mutation. A concurrent fork waits, then observes that its parent is gone
// instead of publishing an orphan from a pre-delete snapshot.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-copy-fork-lock-"));
	const codexHome = path.join(root, "codex-home");
	const day = path.join(codexHome, "sessions", "2026", "07", "10");
	const cli = path.join(root, "fake-codex.mjs");
	const parentId = "c0000000-0000-7000-8000-00000000000c";
	let releaseScan;
	let markScanStarted;
	const scanStarted = new Promise((resolve) => { markScanStarted = resolve; });
	const scanGate = new Promise((resolve) => { releaseScan = resolve; });
	try {
		fs.mkdirSync(day, { recursive: true });
		fs.writeFileSync(path.join(day, `rollout-2026-07-10T14-00-00-${parentId}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: parentId } })}\n`);
		fs.writeFileSync(cli, `
import fs from "node:fs";
import path from "node:path";
const id = process.argv[3];
const walk = (dir) => {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const candidate = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(candidate);
		else if (entry.name.endsWith("-" + id + ".jsonl")) fs.rmSync(candidate, { force: true });
	}
};
walk(path.join(process.env.CODEX_HOME, "sessions"));
`);
		fs.chmodSync(cli, 0o755);
		const deleting = appHarness({ env: { CODEX_PATH: cli, CODEX_HOME: codexHome, PATH: "" } });
		deleting.app.client.sessionId = "unrelated-live-session";
		deleting.app.runFencedCodexAppServerRequests = async () => {
			markScanStarted();
			await scanGate;
			return [{ data: [], nextCursor: null }];
		};
		deleting.app.settleDeferredBtwPrompts = async () => {};
		const deletion = deleting.app.deleteSessionPermanently(parentId, { codex: true });
		await scanStarted;

		const forking = Object.create(HarnessApp.prototype);
		forking.activeKey = "codex";
		forking.config = { agents: { codex: { env: { CODEX_HOME: codexHome } } } };
		let loads = 0;
		const concurrentFork = forking.forkCodexSession({ async loadSession() { loads += 1; } }, parentId);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(loads, 0, "fork publication waits while deletion owns the operation lock");
		releaseScan();
		await deletion;
		await assert.rejects(concurrentFork, /could not locate the Codex session rollout to fork/);
		assert.equal(loads, 0);
		assert.deepEqual(deleting.errors, []);
	} finally {
		releaseScan?.();
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// ACP deletion ownership follows the resolved target ID, not whichever pane
// submitted the command. Invoke deletion on the matching live owner and retire
// or replace that owner after success.
await (async () => {
	const mainId = "11111111-2222-7333-8444-555555555555";
	const sideId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
	const makeOwnedAcpApp = () => {
		const harness = appHarness();
		const events = [];
		const mainClient = harness.app.client;
		mainClient.sessionId = mainId;
		mainClient.capabilities = { sessionCapabilities: { delete: {}, list: {} } };
		const sideClient = {
			sessionId: sideId,
			exited: false,
			capabilities: { sessionCapabilities: { delete: {}, list: {} } },
		};
		const sessions = [
			{ sessionId: mainId, title: "Main session" },
			{ sessionId: sideId, title: "Side session" },
		];
		mainClient.listSessions = async () => sessions;
		sideClient.listSessions = async () => sessions;
		const sideThread = { sessionId: sideId, client: sideClient, busy: false };
		harness.app.btwThread = sideThread;
		harness.app.settleDeferredBtwPrompts = async () => {};
		harness.app.closeBtw = () => {
			events.push("close side");
			harness.app.btwThread = undefined;
		};
		return { ...harness, events, mainClient, sideClient, sideThread };
	};

	{
		const { app, events, mainClient, sideClient, errors } = makeOwnedAcpApp();
		mainClient.deleteSession = async () => assert.fail("main caller must route the resolved side ID to its live owner");
		sideClient.deleteSession = async (sessionId) => events.push(`delete side ${sessionId}`);
		await app.deleteSessionPermanently("Side session", { codex: false });
		assert.deepEqual(events, [`delete side ${sideId}`, "close side"]);
		assert.equal(app.client, mainClient);
		assert.equal(app.ready, true);
		assert.deepEqual(errors, []);
	}

	{
		const { app, events, mainClient, sideClient, sideThread, errors } = makeOwnedAcpApp();
		mainClient.deleteSession = async (sessionId) => events.push(`delete main ${sessionId}`);
		sideClient.deleteSession = async () => assert.fail("side caller must route the resolved main ID to its live owner");
		app.resetConversationView = () => {};
		app.switchAgent = async () => {
			events.push("restart main");
			app.client = { sessionId: "fresh", exited: false };
			app.ready = true;
		};
		await app.deleteSessionPermanently("Main session", { codex: false, targetThread: sideThread });
		assert.deepEqual(events, [`delete main ${mainId}`, "restart main"]);
		assert.equal(app.client.sessionId, "fresh");
		assert.equal(app.ready, true);
		assert.deepEqual(errors, []);
	}
})();

const permissionOption = {
	id: "mode",
	category: "mode",
	type: "select",
	currentValue: "agent",
	options: [
		{ value: "read-only", name: "Read-only" },
		{ value: "agent", name: "Agent" },
		{ value: "agent-full-access", name: "Agent (full access)" },
	],
};

// Successful backend mode changes synchronize cc's host gate; failed changes do
// not. Initial wire state preserves configured host policy, while a later
// current_mode_update in the same session becomes authoritative unless /yolo
// explicitly selected a host-only override.
await (async () => {
	const { app } = appHarness();
	app.sessionStates.set("codex", { configOptions: [permissionOption] });
	app.configUpdateTokens = new Set();
	app.client.setConfigOption = async () => {};
	app.client.setMode = async () => {};
	assert.equal(await app.setConfigValue(permissionOption, "agent-full-access", "Full"), true);
	assert.equal(app.runtimePermissionMode.get("codex"), "auto");
	assert.equal(await app.setConfigValue(permissionOption, "read-only", "Read-only"), true);
	assert.equal(app.runtimePermissionMode.get("codex"), "ask");

	app.runtimePermissionMode.set("codex", "deny");
	app.client.setConfigOption = async () => { throw new Error("config failed"); };
	app.client.setMode = async () => { throw new Error("mode failed"); };
	assert.equal(await app.setConfigValue(permissionOption, "agent-full-access", "Full"), false);
	assert.equal(app.runtimePermissionMode.get("codex"), "deny");

	const { app: wireApp } = appHarness({ _permissionMode: "deny" });
	const wireClient = Object.create(AcpClient.prototype);
	Object.assign(wireClient, {
		sessionId: "session-one",
		configOptions: [{ ...permissionOption }],
		modes: { currentModeId: "agent" },
		sessionInfo: {},
		capabilities: {},
		agentInfo: {},
		authMethods: [],
		bufferingSessionUpdates: false,
		bufferedSessionUpdates: [],
	});
	wireClient.onEvent = (event) => {
		if (event.type === "session_info") wireApp.syncRuntimePermissionModeFromSessionInfo(event.sessionInfo);
	};
	wireApp.client = wireClient;
	wireApp.syncRuntimePermissionModeFromSessionInfo(wireClient.getSessionInfo());
	assert.equal(wireApp.runtimePermissionMode.has("codex"), false, "initial wire mode cannot override configured host policy");
	wireClient.handleSessionUpdate({
		sessionId: "session-one",
		update: { sessionUpdate: "current_mode_update", currentModeId: "agent-full-access" },
	});
	assert.equal(wireApp.runtimePermissionMode.get("codex"), "auto", "later same-session mode updates synchronize the host gate");
	wireApp.toggleAutoApprove("yolo", "deny");
	wireClient.handleSessionUpdate({
		sessionId: "session-one",
		update: { sessionUpdate: "current_mode_update", currentModeId: "agent" },
	});
	assert.equal(wireApp.runtimePermissionMode.get("codex"), "deny", "an explicit /yolo override wins over later backend updates");
	assert.equal(wireApp.runtimePermissionModeSource.get("codex"), "host");

	const baseline = appHarness({ _permissionMode: "deny" }).app;
	baseline.client = { sessionId: "initial", exited: false };
	baseline.syncRuntimePermissionModeFromSessionInfo({ sessionId: "initial", configOptions: [{ ...permissionOption, currentValue: "agent" }] });
	assert.equal(baseline.runtimePermissionMode.has("codex"), false, "initial wire mode cannot override configured host policy");
	baseline.client.sessionId = "second";
	baseline.syncRuntimePermissionModeFromSessionInfo({ sessionId: "second", configOptions: [{ ...permissionOption, currentValue: "agent-full-access" }] });
	assert.equal(baseline.runtimePermissionMode.has("codex"), false, "new sessions cannot override configured deny");
	baseline.syncRuntimePermissionModeFromSessionInfo({ sessionId: "second", configOptions: [{ ...permissionOption, currentValue: "agent" }] });
	assert.equal(baseline.runtimePermissionMode.get("codex"), "ask", "a subsequent change within the new session is authoritative");

	const gatedAuto = appHarness({ _permissionMode: "auto" }).app;
	gatedAuto.client = { sessionId: "initial", exited: false };
	gatedAuto.syncRuntimePermissionModeFromSessionInfo({ sessionId: "initial", configOptions: [{ ...permissionOption, currentValue: "agent" }] });
	gatedAuto.client.sessionId = "second";
	gatedAuto.syncRuntimePermissionModeFromSessionInfo({ sessionId: "second", configOptions: [{ ...permissionOption, currentValue: "agent" }] });
	assert.equal(gatedAuto.runtimePermissionMode.has("codex"), false, "new sessions preserve configured gated auto");
	assert.equal(gatedAuto.permissionPolicyFor("codex", gatedAuto.config.agents.codex).mode, "auto");

	const staleBackendMapping = appHarness({ _permissionMode: "deny" }).app;
	staleBackendMapping.client = { sessionId: "first", exited: false };
	staleBackendMapping.syncRuntimePermissionModeFromSessionInfo({ sessionId: "first", configOptions: [{ ...permissionOption, currentValue: "agent" }] });
	staleBackendMapping.syncRuntimePermissionModeFromSessionInfo({ sessionId: "first", configOptions: [{ ...permissionOption, currentValue: "agent-full-access" }] });
	assert.equal(staleBackendMapping.runtimePermissionMode.get("codex"), "auto");
	staleBackendMapping.client.sessionId = "replacement";
	staleBackendMapping.syncRuntimePermissionModeFromSessionInfo({ sessionId: "replacement", configOptions: [{ ...permissionOption, currentValue: "agent-full-access" }] });
	assert.equal(staleBackendMapping.runtimePermissionMode.has("codex"), false, "a replacement session drops the prior backend-derived host mapping");
	assert.equal(staleBackendMapping.permissionPolicyFor("codex", staleBackendMapping.config.agents.codex).mode, "deny");
})();

// A host-only tightening after live full-access cannot be enforced until the
// backend returns to a prompting mode; surface that fact instead of claiming the
// new gate is effective.
{
	const { app, notices } = appHarness();
	app.runtimePermissionBackendContext = new Map([[
		"codex",
		{ client: app.client, sessionId: app.client.sessionId, mode: "agent-full-access" },
	]]);
	app.toggleAutoApprove("yolo", "deny");
	assert.ok(notices.some((message) => message.includes("full-access mode") && message.includes("/permissions auto")));
}

// A live prompting mode supersedes a launch-time native-bypass flag, so cc does
// not claim a restart is needed after `/permissions auto` has already made the
// host gate enforceable.
{
	const { app, notices } = appHarness({ _nativeBypass: true });
	app.runtimePermissionBackendContext = new Map([[
		"codex",
		{ client: app.client, sessionId: app.client.sessionId, mode: "agent" },
	]]);
	app.toggleAutoApprove("yolo", "deny");
	assert.ok(!notices.some((message) => message.includes("restart cc") || message.includes("won't emit requests")));
}

// /permissions aliases map onto the three modes exported by codex-acp, and bare
// invocation opens a picker instead of silently showing unrelated grant text.
await (async () => {
	const { app, notices } = appHarness();
	app.sessionStates.set("codex", { configOptions: [permissionOption] });
	const selected = [];
	app.setConfigValue = async (_option, value) => { selected.push(value); return true; };
	for (const [argument, expected] of [
		["read", "read-only"],
		["auto", "agent"],
		["danger-full-access", "agent-full-access"],
	]) await app.runPermissions("permissions", argument).then(() => assert.equal(selected.at(-1), expected));
	let pickerEntries;
	app.openSelection = (_title, entries) => { pickerEntries = entries; };
	await app.runPermissions("permissions", "");
	assert.deepEqual(pickerEntries.map((entry) => entry.value.value), ["read-only", "agent", "agent-full-access"]);
	await app.runPermissions("permissions", "unknown");
	assert.ok(notices.some((message) => message.includes("Unknown Codex permission mode")));
})();

// Permission presets submitted from /btw are session-scoped: they update only
// the captured fork, clear only its plan fallback after success, and never fall
// through to main if the picker outlives that fork.
await (async () => {
	const { app, notices, commands } = appHarness();
	app.onThreadActivity = () => {};
	app.ui.terminal = { rows: 24 };
	let mainConfigCalls = 0;
	let mainModeCalls = 0;
	app.client.setConfigOption = async () => { mainConfigCalls += 1; };
	app.client.setMode = async () => { mainModeCalls += 1; };
	app.planPromptFallback = { client: app.client, sessionId: app.client.sessionId };
	app.runtimePermissionMode.set("codex", "deny");
	const mainFallback = app.planPromptFallback;
	const sideCalls = [];
	const sideClient = {
		sessionId: "cccccccc-dddd-7eee-8fff-111111111111",
		exited: false,
		configOptions: [{ ...permissionOption, options: permissionOption.options.map((entry) => ({ ...entry })) }],
		modes: undefined,
		getSessionInfo() {
			return { sessionId: this.sessionId, configOptions: this.configOptions, modes: this.modes };
		},
		async setConfigOption(...args) { sideCalls.push(["config", ...args]); },
		async setMode(...args) { sideCalls.push(["mode", ...args]); },
	};
	const sideThread = new BtwThread(app, sideClient, "");
	sideThread.sessionId = sideClient.sessionId;
	sideThread.ready = true;
	sideThread.planPromptFallback = { client: sideClient, sessionId: sideClient.sessionId };
	app.btwThread = sideThread;
	app.focusedThread = "btw";

	await app.runLocalSlashCommand("permissions", "full-access", { targetThread: sideThread });
	assert.deepEqual(sideCalls, [["config", "mode", "agent-full-access", "select"]]);
	assert.equal(mainConfigCalls, 0);
	assert.equal(mainModeCalls, 0);
	assert.equal(sideThread.planPromptFallback, undefined);
	assert.equal(app.planPromptFallback, mainFallback);
	assert.equal(app.runtimePermissionMode.get("codex"), "deny");

	sideThread.planPromptFallback = { client: sideClient, sessionId: sideClient.sessionId };
	sideClient.setConfigOption = async () => { throw new Error("side config failed"); };
	sideClient.setMode = async () => { throw new Error("side mode failed"); };
	await app.runPermissions("permissions", "auto", { targetThread: sideThread });
	assert.ok(sideThread.planPromptFallback, "failed side mode change preserves its plan fallback");
	assert.equal(mainConfigCalls, 0);
	assert.equal(mainModeCalls, 0);

	const sideErrors = [];
	sideThread.addError = (message) => sideErrors.push(message);
	const originalConfigError = new Error("original side model failure");
	sideClient.setConfigOption = async () => { throw originalConfigError; };
	assert.equal(await app.setSideThreadConfigValue(
		app.captureSessionCommandTarget(sideThread),
		{ id: "model", category: "model", type: "select" },
		"gpt-test",
	), false);
	assert.deepEqual(sideErrors, [originalConfigError.message], "non-mode /btw config reports the backend's original error");

	const sideUi = { commands: [], notices: [] };
	sideThread.addCommandMessage = (message) => sideUi.commands.push(message);
	sideThread.addNotice = (message) => sideUi.notices.push(message);
	const mainCommandCount = commands.length;
	const mainNoticeCount = notices.length;
	await app.runPermissions("permissions", "show", { targetThread: sideThread });
	assert.match(sideUi.commands.at(-1), /^\/permissions show/);
	assert.match(sideUi.notices.at(-1), /^Permissions/);
	assert.equal(commands.length, mainCommandCount, "side host-policy output does not leak into main");
	assert.equal(notices.length, mainNoticeCount, "side host-policy notices do not leak into main");

	const previousPermissions = process.env.CC_PERMISSIONS;
	const grantsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-side-permission-clear-"));
	try {
		process.env.CC_PERMISSIONS = path.join(grantsRoot, "permissions.json");
		await app.runPermissions("permissions", "clear", { targetThread: sideThread });
		assert.match(sideUi.commands.at(-1), /^\/permissions clear/);
		assert.match(sideUi.notices.at(-1), /Cleared all remembered/);
		assert.equal(commands.length, mainCommandCount);
		assert.equal(notices.length, mainNoticeCount);
	} finally {
		if (previousPermissions === undefined) delete process.env.CC_PERMISSIONS;
		else process.env.CC_PERMISSIONS = previousPermissions;
		fs.rmSync(grantsRoot, { recursive: true, force: true });
	}

	let picker;
	sideClient.setConfigOption = async (...args) => { sideCalls.push(["late config", ...args]); };
	app.openSelection = (_title, entries, callback) => { picker = { entries, callback }; };
	app.closeMenu = () => {};
	await app.runPermissions("permissions", "", { targetThread: sideThread });
	assert.equal(picker.entries.find((entry) => entry.value.value === "agent").active, true);
	const staleTarget = app.captureSessionCommandTarget(sideThread);
	app.btwThread = undefined;
	await picker.callback(picker.entries.find((entry) => entry.value.value === "read-only"));
	assert.equal(sideCalls.some((call) => call[0] === "late config"), false);
	assert.equal(mainConfigCalls, 0);
	assert.equal(mainModeCalls, 0);
	assert.ok(notices.some((message) => message.includes("targeted /btw thread is no longer open")));
	const commandCountAfterCancellation = commands.length;
	const noticeCountAfterCancellation = notices.length;
	assert.equal(app.addSessionTargetCommand(staleTarget, "stale side command"), false);
	assert.equal(app.addSessionTargetNotice(staleTarget, "stale side notice"), false);
	assert.equal(commands.length, commandCountAfterCancellation, "stale side command output never falls back to main");
	assert.equal(notices.length, noticeCountAfterCancellation, "stale side notices never fall back to main");
})();

// Shutdown starts every registered native-process stopper synchronously, even
// when one throws before returning a promise, and preserves that original
// failure for the caller.
await (async () => {
	const app = Object.create(HarnessApp.prototype);
	const tracker = app.trackedNativeProcessOptions().processTracker;
	const calls = [];
	const originalStopError = new Error("original synchronous stopper failure");
	let unregisterFirst;
	let unregisterSecond;
	unregisterFirst = tracker.register(() => {
		calls.push("first");
		unregisterFirst();
		throw originalStopError;
	});
	unregisterSecond = tracker.register(() => {
		calls.push("second");
		unregisterSecond();
	});
	await assert.rejects(tracker.stopAndWait(), (error) => error === originalStopError);
	assert.deepEqual(calls, ["first", "second"]);
})();

// Backend-derived permission modes are scoped to the ACP connection that
// reported them. The source client must survive both the initial decision and
// the queued re-evaluation, while an explicit /yolo override remains global.
{
	const { app } = appHarness();
	const sideClient = { sessionId: "dddddddd-eeee-7fff-8111-222222222222" };
	// Interactive requests are now rejected once their source client is no longer
	// live. Keep this synthetic source attached as the active side owner so this
	// test continues to exercise client-scoped policy re-evaluation, not stale
	// request cancellation.
	app.btwThread = { client: sideClient };
	app.runtimePermissionMode.set("codex", "auto");
	app.runtimePermissionModeSource.set("codex", "backend");
	app.runtimePermissionModeByClient.set(sideClient, { sessionId: sideClient.sessionId, mode: "ask" });
	assert.equal(app.permissionPolicyFor("codex", app.config.agents.codex, { sourceClient: app.client }).mode, "auto");
	assert.equal(app.permissionPolicyFor("codex", app.config.agents.codex, { sourceClient: sideClient }).mode, "ask");

	const request = {
		toolCall: { title: "Run command", kind: "execute" },
		options: [
			{ kind: "reject_once", name: "Reject", optionId: "reject" },
			{ kind: "allow_once", name: "Allow", optionId: "allow" },
		],
	};
	let initialContext;
	app.requestPermission = (_params, context) => { initialContext = context; return "prompted"; };
	assert.equal(app.resolvePermissionOutcome("codex", app.config.agents.codex, request, { sourceClient: sideClient }), "prompted");
	assert.equal(initialContext.sourceClient, sideClient);
	assert.equal(initialContext.policy.mode, "ask");

	let queuedRequest;
	app.openPermissionRequest = (entry) => { queuedRequest = entry; };
	app.permissionQueue.push({
		kind: "permission",
		params: request,
		context: { agentKey: "codex", sourceClient: sideClient },
		resolve() {},
	});
	app.drainPermissionQueue();
	assert.equal(queuedRequest.context.sourceClient, sideClient);
	assert.equal(queuedRequest.context.policy.mode, "ask");

	app.runtimePermissionMode.set("codex", "deny");
	app.runtimePermissionModeSource.set("codex", "host");
	assert.equal(app.permissionPolicyFor("codex", app.config.agents.codex, { sourceClient: sideClient }).mode, "deny");
}

// All session-config commands typed in a focused fork wait for fork readiness,
// read that fork's advertised state, and mutate only its ACP client.
await (async () => {
	const { app } = appHarness();
	app.onThreadActivity = () => {};
	app.ui.terminal = { rows: 24 };
	let mainConfigCalls = 0;
	let mainModeCalls = 0;
	app.client.setConfigOption = async () => { mainConfigCalls += 1; };
	app.client.setMode = async () => { mainModeCalls += 1; };
	const modelOption = {
		id: "model",
		category: "model",
		type: "select",
		currentValue: "base",
		options: [{ value: "base", name: "Base" }, { value: "sol", name: "Sol" }],
	};
	const effortOption = {
		id: "reasoning-effort",
		category: "thought_level",
		type: "select",
		currentValue: "medium",
		options: [{ value: "medium", name: "Medium" }, { value: "high", name: "High" }],
	};
	const fastOption = { id: "fast-mode", type: "boolean", currentValue: false, description: "Faster" };
	const calls = [];
	const sideClient = {
		sessionId: "eeeeeeee-ffff-7111-8222-333333333333",
		exited: false,
		configOptions: [
			{ ...permissionOption, options: permissionOption.options.map((entry) => ({ ...entry })) },
			modelOption,
			effortOption,
			fastOption,
		],
		modes: undefined,
		getSessionInfo() {
			return { sessionId: this.sessionId, configOptions: this.configOptions, modes: this.modes };
		},
		async setConfigOption(id, value, type) {
			calls.push(["config", id, value, type]);
			const option = this.configOptions.find((entry) => entry.id === id);
			if (option) option.currentValue = value;
		},
		async setMode(value) { calls.push(["mode", value]); },
	};
	const sideThread = new BtwThread(app, sideClient, "");
	app.btwThread = sideThread;
	app.focusedThread = "btw";

	const waiting = app.runLocalSlashCommand("permissions", "auto", { targetThread: sideThread });
	await Promise.resolve();
	assert.deepEqual(calls, [], "side config does not race fork establishment");
	sideThread.sessionId = sideClient.sessionId;
	sideThread.markReady();
	await waiting;
	assert.deepEqual(calls, [["config", "mode", "agent", "select"]]);

	await app.runLocalSlashCommand("config", "model sol", { targetThread: sideThread });
	await app.runLocalSlashCommand("fast", "", { targetThread: sideThread });
	await app.runLocalSlashCommand("model", "base", { targetThread: sideThread });
	await app.runLocalSlashCommand("mode", "read-only", { targetThread: sideThread });
	await app.runLocalSlashCommand("effort", "high", { targetThread: sideThread });
	assert.deepEqual(calls.slice(1), [
		["config", "model", "sol", "select"],
		["config", "fast-mode", true, "boolean"],
		["config", "model", "base", "select"],
		["config", "mode", "read-only", "select"],
		["config", "reasoning-effort", "high", "select"],
	]);

	sideClient.configOptions = sideClient.configOptions.filter((option) => option.id !== "mode");
	sideClient.modes = {
		currentModeId: "agent",
		availableModes: [
			{ id: "agent", name: "Agent" },
			{ id: "agent-full-access", name: "Agent (full access)" },
		],
	};
	await app.runLocalSlashCommand("mode", "agent-full-access", { targetThread: sideThread });
	assert.deepEqual(calls.at(-1), ["mode", "agent-full-access"]);

	let releaseConfig;
	const configBlocked = new Promise((resolve) => { releaseConfig = resolve; });
	let promptStatus;
	sideClient.setConfigOption = async () => { await configBlocked; };
	sideClient.prompt = async () => {
		promptStatus = sideThread.statusState;
		return {};
	};
	const updating = app.runLocalSlashCommand("model", "sol", { targetThread: sideThread });
	await Promise.resolve();
	await sideThread.submit("after config");
	assert.equal(promptStatus, undefined, "a side prompt queues behind its config update");
	releaseConfig();
	await updating;
	await Promise.resolve();
	assert.equal(promptStatus, "working", "the queued prompt starts after config without losing its working state");

	const fifoEvents = [];
	sideClient.setConfigOption = async () => { fifoEvents.push("config"); };
	sideClient.prompt = async () => { fifoEvents.push("prompt"); return {}; };
	sideThread.busy = true;
	const deferredConfig = app.runLocalSlashCommand("model", "sol", { targetThread: sideThread });
	await Promise.resolve();
	assert.equal(sideThread.localCommandQueue.length, 1);
	assert.equal(app.deferredLocalSlashCommands.length, 0, "side-busy config never enters main's deferred queue");
	await sideThread.submit("prompt after config");
	assert.deepEqual(fifoEvents, [], "a side-busy config command cannot race the active turn");
	sideThread.busy = false;
	sideThread.drainQueue();
	await deferredConfig;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(fifoEvents, ["config", "prompt"], "later side prompts stay behind the deferred config command");

	let finishEarlierPrompt;
	const earlierPrompt = new Promise((resolve) => { finishEarlierPrompt = resolve; });
	fifoEvents.length = 0;
	sideClient.prompt = async () => { fifoEvents.push("prompt"); await earlierPrompt; return {}; };
	sideThread.busy = true;
	await sideThread.submit("prompt before config");
	const laterConfig = app.runLocalSlashCommand("model", "sol", { targetThread: sideThread });
	await Promise.resolve();
	sideThread.busy = false;
	sideThread.drainQueue();
	await Promise.resolve();
	assert.deepEqual(fifoEvents, ["prompt"], "an earlier queued prompt runs before the later config command");
	finishEarlierPrompt();
	await laterConfig;
	assert.deepEqual(fifoEvents, ["prompt", "config"]);

	const planOrder = [];
	sideClient.configOptions.unshift({
		...permissionOption,
		options: permissionOption.options.map((entry) => ({ ...entry })),
	});
	sideClient.modes = undefined;
	sideClient.setConfigOption = async () => { planOrder.push("mode"); };
	sideClient.prompt = async (payload) => {
		planOrder.push(payload.map((part) => part.text ?? "").join("\n"));
		return {};
	};
	sideThread.busy = true;
	const planned = app.runLocalSlashCommand("plan", "planned first", { targetThread: sideThread });
	await Promise.resolve();
	await sideThread.submit("normal second");
	sideThread.busy = false;
	sideThread.drainQueue();
	await planned;
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(planOrder[0], "mode");
	assert.match(planOrder[1], /planned first/);
	assert.match(planOrder[2], /normal second/);
	assert.equal(mainConfigCalls, 0);
	assert.equal(mainModeCalls, 0);
})();

// Inline /plan changes mode before submitting the prompt, preserves structured
// attachments, and never submits when the mode transition fails.
await (async () => {
	const { app } = appHarness();
	const planOption = { ...permissionOption, options: [...permissionOption.options, { value: "plan", name: "Plan" }] };
	app.sessionStates.set("codex", { configOptions: [planOption] });
	const calls = [];
	app.setConfigValue = async (_option, value) => { calls.push(["mode", value]); return true; };
	app.submitBackendPrompt = async (text, options) => { calls.push(["prompt", text, options.promptParts]); };
	const parts = [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }];
	assert.equal(await app.setPlanMode("plan", "inspect [Image 1]", { promptParts: parts }), true);
	assert.deepEqual(calls, [["mode", "plan"], ["prompt", "inspect [Image 1]", parts]]);

	calls.length = 0;
	app.setConfigValue = async () => false;
	app.restoreQueuedTextToComposer = () => { calls.push(["restore"]); };
	assert.equal(await app.setPlanMode("plan", "do not lose this", { promptParts: parts }), false);
	assert.deepEqual(calls, [["restore"]]);
})();

// A local /plan fallback entered from the focused side composer changes and
// prompts only that captured fork. It must not borrow main's config/session just
// because the backend did not advertise a native /plan slash command.
await (async () => {
	const { app } = appHarness();
	const mainClient = app.client;
	let mainConfigCalls = 0;
	let mainPromptCalls = 0;
	mainClient.setConfigOption = async () => { mainConfigCalls += 1; };
	mainClient.prompt = async () => { mainPromptCalls += 1; return {}; };
	app.onThreadActivity = () => {};
	app.ui.terminal = { rows: 24 };

	const sideModeCalls = [];
	const sidePayloads = [];
	const sideClient = {
		sessionId: "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
		exited: false,
		capabilities: { promptCapabilities: { image: true } },
		configOptions: [{ ...permissionOption, options: permissionOption.options.map((entry) => ({ ...entry })) }],
		modes: undefined,
		getSessionInfo() {
			return { sessionId: this.sessionId, configOptions: this.configOptions, modes: this.modes };
		},
		async setConfigOption(id, value) { sideModeCalls.push([id, value]); },
		async prompt(payload) { sidePayloads.push(payload); return {}; },
	};
	const sideThread = new BtwThread(app, sideClient, "");
	sideThread.sessionId = sideClient.sessionId;
	sideThread.ready = true;
	app.btwThread = sideThread;
	app.focusedThread = "btw";
	const parts = [
		{ type: "text", text: "design " },
		{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
	];

	await app.runLocalSlashCommand("plan", "design [Image 1]", { targetThread: sideThread, promptParts: parts });
	assert.deepEqual(sideModeCalls, [["mode", "read-only"]]);
	assert.equal(mainConfigCalls, 0);
	assert.equal(mainPromptCalls, 0);
	assert.equal(app.planPromptFallback, undefined, "side fallback does not arm main's plan instruction");
	assert.equal(sideThread.planPromptFallback.client, sideClient);
	assert.match(sidePayloads[0][0].text, /planning mode/i);
	assert.equal(sidePayloads[0][2].type, "image");
})();

// If the captured fork exposes neither native Plan nor a safe read-only
// fallback, leave the inline command in that fork's composer for retry.
await (async () => {
	const { app } = appHarness();
	app.onThreadActivity = () => {};
	app.ui.terminal = { rows: 24 };
	let sidePrompts = 0;
	let mainPrompts = 0;
	app.client.prompt = async () => { mainPrompts += 1; return {}; };
	const sideClient = {
		sessionId: "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff",
		exited: false,
		capabilities: {},
		configOptions: [],
		getSessionInfo() { return { sessionId: this.sessionId, configOptions: [], modes: undefined }; },
		async prompt() { sidePrompts += 1; return {}; },
	};
	const sideThread = new BtwThread(app, sideClient, "");
	sideThread.sessionId = sideClient.sessionId;
	sideThread.ready = true;
	app.btwThread = sideThread;
	app.focusedThread = "btw";

	assert.equal(await app.runLocalSlashCommand("plan", "keep this request", { targetThread: sideThread }), undefined);
	assert.equal(app.editor.getText(), "/plan keep this request");
	assert.equal(app.editorTargetThread, sideThread);
	assert.equal(sidePrompts, 0);
	assert.equal(mainPrompts, 0);
})();

// The maintained adapter's current mode list has no native Plan. cc selects
// read-only, marks the display as a fallback, and prepends a planning instruction
// without losing image parts.
await (async () => {
	const { app } = appHarness();
	app.sessionStates.set("codex", { configOptions: [permissionOption] });
	const calls = [];
	app.setConfigValue = async (_option, value) => { calls.push(["mode", value]); return true; };
	app.submitBackendPrompt = async (text, options) => { calls.push(["prompt", text, options.displayText]); };
	await app.setPlanMode("plan", "design it");
	assert.equal(calls[0][1], "read-only");
	assert.match(calls[1][2], /read-only fallback/i);
	assert.equal(app.planPromptFallback.client, app.client);

	const sent = [];
	app.client.prompt = async (parts) => { sent.push(parts); return {}; };
	app.planPromptFallback = { client: app.client, sessionId: app.client.sessionId };
	app.promptForActiveCapabilities = (_text, parts) => parts;
	app.closeCurrentAssistantText = () => {};
	app.refreshCodexThreadStateSnapshot = () => {};
	app.flushPromptQueue = async () => {};
	await app.sendPrompt("design it", { promptParts: [{ type: "image", data: "img", mimeType: "image/png" }] });
	assert.match(sent[0][0].text, /planning mode/i);
	assert.equal(sent[0][1].type, "image");
})();

// Busy plan commands reserve their images in the deferred entry.
await (async () => {
	const { app } = appHarness();
	app.busy = true;
	app.clipboardImages = [{ label: "[Image 9]", data: "img", mimeType: "image/png" }];
	await app.runLocalSlashCommand("plan", "inspect [Image 9]");
	assert.equal(app.clipboardImages.length, 0);
	assert.equal(app.deferredLocalSlashCommands.length, 1);
	assert.equal(app.deferredLocalSlashCommands[0].promptParts.some((part) => part.type === "image"), true);
})();

// Bare /fast toggles a binary advertised option immediately.
await (async () => {
	const { app } = appHarness();
	const fast = { id: "fast-mode", type: "boolean", currentValue: false, description: "Faster" };
	app.sessionStates.set("codex", { configOptions: [fast] });
	let selected;
	app.setConfigValue = async (_option, value) => { selected = value; return true; };
	await app.openFastModeDialog("");
	assert.equal(selected, true);
})();

// Help renders skills with their real $ prefix, never as invalid /$ commands.
{
	const { app, notices } = appHarness();
	app.availableCommands.set("codex", [{ name: "$demo", description: "Demo skill" }]);
	app.showHelp();
	assert.match(notices.at(-1), /^\$demo\s+Demo skill$/m);
	assert.doesNotMatch(notices.at(-1), /^\/\$demo/m);
}

// Default /diff includes an untracked-only working tree.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-untracked-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		spawnSync("git", ["-C", root, "config", "user.email", "cc@example.test"]);
		spawnSync("git", ["-C", root, "config", "user.name", "cc test"]);
		fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
		spawnSync("git", ["-C", root, "add", "tracked.txt"]);
		assert.equal(spawnSync("git", ["-C", root, "commit", "-qm", "base"]).status, 0);
		fs.writeFileSync(path.join(root, "staged.txt"), "staged content\n");
		assert.equal(spawnSync("git", ["-C", root, "add", "staged.txt"]).status, 0);
		fs.writeFileSync(path.join(root, "new file.txt"), "untracked content\n");
		process.chdir(root);
		const { app, blocks } = appHarness();
		await app.runDiff("");
		assert.match(blocks.join("\n"), /diff --git a\/staged\.txt b\/staged\.txt/);
		assert.match(blocks.join("\n"), /\+staged content/);
		assert.match(blocks.join("\n"), /new file\.txt/);
		assert.match(blocks.join("\n"), /untracked content/);
		assert.match(
			spawnSync("git", ["-C", root, "diff", "--cached", "--name-only"], { encoding: "utf8" }).stdout,
			/^staged\.txt$/m,
			"the real index remains untouched",
		);
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// An embedded repository is returned by `git ls-files --others` as a directory.
// The temporary-index path must render it as a gitlink instead of silently
// discarding it by trying to compare a null device with a directory.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-nested-repo-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		spawnSync("git", ["-C", root, "config", "user.email", "cc@example.test"]);
		spawnSync("git", ["-C", root, "config", "user.name", "cc test"]);
		fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
		spawnSync("git", ["-C", root, "add", "tracked.txt"]);
		assert.equal(spawnSync("git", ["-C", root, "commit", "-qm", "base"]).status, 0);
		const nested = path.join(root, "nested");
		assert.equal(spawnSync("git", ["init", "-q", nested]).status, 0);
		spawnSync("git", ["-C", nested, "config", "user.email", "cc@example.test"]);
		spawnSync("git", ["-C", nested, "config", "user.name", "cc test"]);
		fs.writeFileSync(path.join(nested, "inner.txt"), "nested content\n");
		spawnSync("git", ["-C", nested, "add", "inner.txt"]);
		assert.equal(spawnSync("git", ["-C", nested, "commit", "-qm", "nested"]).status, 0);
		process.chdir(root);
		const { app, blocks, notices } = appHarness();
		await app.runDiff("");
		assert.match(blocks.join("\n"), /diff --git a\/nested b\/nested/);
		assert.match(blocks.join("\n"), /new file mode 160000/);
		assert.match(blocks.join("\n"), /Subproject commit [0-9a-f]+/);
		assert.doesNotMatch(notices.join("\n"), /No changes in the working tree/);
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A copied split index must be expanded inside the temporary index. Otherwise
// `git add -N` publishes an orphaned sharedindex.* in the real repository even
// though /diff is intended to be read-only.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-split-index-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		spawnSync("git", ["-C", root, "config", "user.email", "cc@example.test"]);
		spawnSync("git", ["-C", root, "config", "user.name", "cc test"]);
		fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
		spawnSync("git", ["-C", root, "add", "tracked.txt"]);
		assert.equal(spawnSync("git", ["-C", root, "commit", "-qm", "base"]).status, 0);
		assert.equal(spawnSync("git", ["-C", root, "update-index", "--split-index"]).status, 0);
		fs.writeFileSync(path.join(root, "new.txt"), "new content\n");
		const sharedIndexes = () => fs.readdirSync(path.join(root, ".git"))
			.filter((name) => name.startsWith("sharedindex."))
			.sort();
		const before = sharedIndexes();
		assert.ok(before.length > 0, "the fixture uses a split index");
		process.chdir(root);
		const { app, blocks } = appHarness();
		await app.runDiff("");
		assert.match(blocks.join("\n"), /new\.txt/);
		assert.match(blocks.join("\n"), /new content/);
		assert.deepEqual(sharedIndexes(), before, "/diff does not publish temporary shared indexes");
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A repository with no commits has no HEAD, and may not have an index at all.
// The default view still renders the net working content of staged-only,
// staged-then-modified, and ordinary untracked paths against Git's empty tree.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-unborn-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		fs.writeFileSync(path.join(root, "staged-only.txt"), "staged content\n");
		fs.writeFileSync(path.join(root, "modified.txt"), "index version\n");
		assert.equal(spawnSync("git", ["-C", root, "add", "staged-only.txt", "modified.txt"]).status, 0);
		fs.writeFileSync(path.join(root, "modified.txt"), "working version\n");
		fs.writeFileSync(path.join(root, "untracked.txt"), "untracked content\n");
		process.chdir(root);
		const { app, blocks, errors } = appHarness();
		await app.runDiff("");
		const rendered = blocks.join("\n");
		assert.match(rendered, /staged-only\.txt/);
		assert.match(rendered, /\+staged content/);
		assert.match(rendered, /modified\.txt/);
		assert.match(rendered, /\+working version/);
		assert.doesNotMatch(rendered, /\+index version/);
		assert.match(rendered, /untracked\.txt/);
		assert.match(rendered, /\+untracked content/);
		assert.deepEqual(errors, []);
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// The even fresher case has no index file to copy. Build an empty private index
// without creating a real one, then include the untracked working file.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-unborn-no-index-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		fs.writeFileSync(path.join(root, "first.txt"), "first content\n");
		assert.equal(fs.existsSync(path.join(root, ".git", "index")), false);
		process.chdir(root);
		const { app, blocks, errors } = appHarness();
		await app.runDiff("");
		assert.match(blocks.join("\n"), /first\.txt/);
		assert.match(blocks.join("\n"), /\+first content/);
		assert.equal(fs.existsSync(path.join(root, ".git", "index")), false, "/diff does not create the real index");
		assert.deepEqual(errors, []);
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// The untracked path list is capped before it becomes command arguments, and a
// single temporary-index diff replaces the old one-process-per-file loop.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-index-source-"));
	try {
		const sourceIndex = path.join(root, "active index");
		fs.writeFileSync(sourceIndex, "fake index snapshot");
		const { app, blocks, notices } = appHarness();
		const calls = [];
		const magicLookingPath = ":(exclude)still-a-literal-file.txt";
		const paths = [
			magicLookingPath,
			...Array.from({ length: 400 }, (_, index) => `untracked-${String(index).padStart(4, "0")}.txt`),
		];
		app.runTrackedCapture = async (command, args, options) => {
			calls.push({ command, args, options });
			const empty = { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
			if (args[0] === "ls-files") {
				return { ...empty, stdout: Buffer.from(`${paths.join("\0")}\0`) };
			}
			if (args[0] === "rev-parse" && args.includes("--verify")) {
				return { ...empty, stdout: Buffer.from("0123456789012345678901234567890123456789\n") };
			}
			if (args[0] === "rev-parse" && args.includes("--git-path")) {
				return { ...empty, stdout: Buffer.from(`${sourceIndex}\r\n`) };
			}
			if (args.includes("diff")) {
				return { ...empty, stdout: Buffer.from("diff --git a/untracked-0000.txt b/untracked-0000.txt\n") };
			}
			return empty;
		};
		await app.runDiff("");
		const addCall = calls.find((call) => call.args.includes("add"));
		const diffCall = calls.find((call) => call.args.includes("diff"));
		assert.ok(addCall);
		const addedPaths = addCall.args.slice(addCall.args.indexOf("--") + 1);
		assert.ok(addedPaths.length < paths.length, "untracked paths are capped before git add");
		assert.ok(addedPaths.length <= 128);
		assert.ok(addedPaths.includes(magicLookingPath));
		assert.equal(calls.filter((call) => call.args.includes("diff")).length, 1, "all selected paths share one diff process");
		assert.equal(calls.length, 5, "work uses a constant number of Git processes");
		assert.equal(calls.some((call) => call.args.includes("read-tree")), false);
		assert.deepEqual(addCall.args.slice(0, 4), ["--literal-pathspecs", "-c", "core.splitIndex=false", "add"]);
		assert.notEqual(addCall.options.env.GIT_INDEX_FILE, sourceIndex);
		assert.equal(diffCall.options.env.GIT_INDEX_FILE, addCall.options.env.GIT_INDEX_FILE);
		assert.ok(calls.every((call) => Number.isFinite(call.options.maxStdoutBytes)), "every capture has an output bound");
		assert.match(notices.join("\n"), /additional untracked paths? omitted from \/diff/i);
		assert.match(blocks.join("\n"), /untracked-0000\.txt/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// If the active index cannot be snapshotted, /diff falls back to the real index
// so staged changes remain visible instead of retrying with a HEAD-only index.
await (async () => {
	const { app, blocks, notices } = appHarness();
	const calls = [];
	app.runTrackedCapture = async (command, args, options) => {
		calls.push({ command, args, options });
		const empty = { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		if (args[0] === "ls-files") return { ...empty, stdout: Buffer.from("loose.txt\0") };
		if (args[0] === "rev-parse" && args.includes("--verify")) {
			return { ...empty, stdout: Buffer.from("0123456789012345678901234567890123456789\n") };
		}
		if (args[0] === "rev-parse" && args.includes("--git-path")) {
			return { ...empty, code: 1, stderr: Buffer.from("no index") };
		}
		if (args.includes("diff")) {
			return { ...empty, stdout: Buffer.from("diff --git a/staged.txt b/staged.txt\n+staged content\n") };
		}
		return empty;
	};
	await app.runDiff("");
	assert.equal(calls.some((call) => call.args[0] === "add" || call.args[0] === "read-tree"), false);
	const diffCall = calls.find((call) => call.args.includes("diff"));
	assert.equal(Object.hasOwn(diffCall.options, "env"), false, "fallback reads the user's real index");
	assert.match(blocks.join("\n"), /staged content/);
	assert.match(notices.join("\n"), /Untracked paths could not be included/);
})();

// A capture failure means Git did not produce a trustworthy snapshot (and its
// process tree may still be alive). Both fatal lifecycle errors and ordinary
// capture errors reach the outer error path without launching a fallback diff.
for (const [code, message] of [
	["PROCESS_TREE_TERMINATION_FAILED", "git process tree is still alive"],
	[undefined, "git capture failed"],
]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-capture-error-"));
	let privateIndex;
	try {
		const sourceIndex = path.join(root, "source-index");
		fs.writeFileSync(sourceIndex, "fake index snapshot");
		const { app, errors } = appHarness();
		const calls = [];
		app.runTrackedCapture = async (command, args, options) => {
			calls.push({ command, args, options });
			const empty = { code: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
			if (args[0] === "ls-files") return { ...empty, stdout: Buffer.from("loose.txt\0") };
			if (args[0] === "rev-parse" && args.includes("--verify")) {
				return { ...empty, stdout: Buffer.from("0123456789012345678901234567890123456789\n") };
			}
			if (args[0] === "rev-parse" && args.includes("--git-path")) {
				return { ...empty, stdout: Buffer.from(`${sourceIndex}\n`) };
			}
			if (args.includes("add")) {
				privateIndex = options.env.GIT_INDEX_FILE;
				const error = new Error(message);
				if (code) error.code = code;
				throw error;
			}
			return empty;
		};
		await app.runDiff("");
		assert.equal(calls.some((call) => call.args.includes("diff")), false, "no fallback starts after a capture failure");
		assert.match(errors.join("\n"), new RegExp(message));
	} finally {
		if (privateIndex) fs.rmSync(path.dirname(privateIndex), { recursive: true, force: true });
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Capture limits apply while Git is streaming, before the 500-line renderer.
// This bounds a huge one-line untracked file as well as ordinary multi-line diffs.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-output-bound-"));
	const previous = process.cwd();
	try {
		assert.equal(spawnSync("git", ["init", "-q", root]).status, 0);
		spawnSync("git", ["-C", root, "config", "user.email", "cc@example.test"]);
		spawnSync("git", ["-C", root, "config", "user.name", "cc test"]);
		fs.writeFileSync(path.join(root, "tracked.txt"), "base\n");
		spawnSync("git", ["-C", root, "add", "tracked.txt"]);
		assert.equal(spawnSync("git", ["-C", root, "commit", "-qm", "base"]).status, 0);
		fs.writeFileSync(path.join(root, "huge.txt"), "x".repeat(768 * 1024));
		process.chdir(root);
		const { app, blocks, notices } = appHarness();
		await app.runDiff("");
		assert.equal(blocks.length, 1);
		assert.ok(Buffer.byteLength(blocks[0], "utf8") < 525_000, "rendered diff stays within the byte safety limit");
		assert.match(blocks[0], /huge\.txt/);
		assert.match(notices.join("\n"), /Additional diff output was omitted/);
	} finally {
		process.chdir(previous);
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A reconnect owned by a deferred-command flush preserves remaining commands;
// an explicit harness switch does not inherit them just because a flush was live.
await (async () => {
	const originalInitialize = AcpClient.prototype.initialize;
	const makeSwitchApp = () => {
		const { app } = appHarness({ acp: { command: "fake", args: [] } });
		Object.assign(app, {
			startupConnectTimer: undefined,
			client: undefined,
			btwThread: undefined,
			cancelPermissionPrompts() {},
			closeMenu() {},
			clearCancelGraceTimer() {},
			closeCurrentAssistantText() {},
			selectionActions: new Set(),
			configUpdateTokens: new Set(),
			asyncPickerLoads: new Set(),
		});
		return app;
	};
	try {
		AcpClient.prototype.initialize = async function initialize() { this.sessionId = "fresh"; };
		const reconnect = makeSwitchApp();
		reconnect.flushingDeferredLocalSlashCommands = true;
		reconnect.deferredLocalSlashCommands = [{ name: "model" }, { name: "effort" }];
		await reconnect.switchAgent("codex", "acp", { quiet: true, preserveDeferredCommands: true });
		assert.equal(reconnect.deferredLocalSlashCommands.length, 2);
		reconnect.client.stop();

		const explicit = makeSwitchApp();
		explicit.flushingDeferredLocalSlashCommands = true;
		explicit.deferredLocalSlashCommands = [{ name: "effort" }];
		await explicit.switchAgent("codex", "acp", { quiet: true });
		assert.deepEqual(explicit.deferredLocalSlashCommands, []);
		explicit.client.stop();

		// A backend replacement may start while a native helper is winding down,
		// but queued prompts on that replacement must remain behind the helper's
		// operation token. The helper's own finally block is the sole gate owner.
		const nativeOperation = makeSwitchApp();
		nativeOperation.promptQueue = [{ text: "wait for old native mutation" }];
		let replacementPromptDrains = 0;
		nativeOperation.schedulePromptQueueDrain = function schedulePromptQueueDrain() {
			if ((this.asyncPickerLoadCount ?? 0) > 0 || this.promptQueue.length === 0) return;
			replacementPromptDrains += 1;
			this.promptQueue.shift();
		};
		const operationToken = HarnessApp.prototype.beginAsyncPickerLoad.call(nativeOperation);
		await nativeOperation.switchAgent("codex", "acp", { quiet: true });
		assert.equal(nativeOperation.asyncPickerLoads.has(operationToken), true, "switch preserves the old native operation gate");
		assert.equal(nativeOperation.asyncPickerLoadCount, 1);
		assert.equal(replacementPromptDrains, 0, "replacement prompts cannot overlap the old native mutation");
		HarnessApp.prototype.endAsyncPickerLoad.call(nativeOperation, operationToken);
		assert.equal(replacementPromptDrains, 1, "the replacement queue drains when the old native mutation settles");
		nativeOperation.client.stop();
	} finally {
		AcpClient.prototype.initialize = originalInitialize;
	}
})();

// Native Codex command timeouts terminate the whole process group, escalate
// when SIGTERM is ignored, and reject only after the direct child is reaped.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-timeout-"));
	const cli = path.join(root, "fake-native-codex.mjs");
	const pidFile = path.join(root, "pids.json");
	let pids = [];
	try {
		fs.writeFileSync(cli, `
import { spawn } from "node:child_process";
import fs from "node:fs";
const descendant = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.send?.('ready'); setInterval(() => {}, 1000)"], {
  detached: false,
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
descendant.once("message", () => {
  descendant.disconnect();
  fs.writeFileSync(process.env.CC_PID_FILE, JSON.stringify([process.pid, descendant.pid]));
});
setInterval(() => {}, 1000);
`);
		await assert.rejects(
			() => runCodexCommand(
				{ command: process.execPath, args: [cli] },
				["doctor"],
				{ env: { CC_PID_FILE: pidFile } },
				{ timeoutMs: 500, terminationGraceMs: 50 },
			),
			/timed out after 500ms.*process tree was (?:terminated|force-killed)/,
		);
		pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
		for (const pid of pids) {
			assert.throws(
				() => process.kill(pid, 0),
				(error) => error?.code === "ESRCH",
				`timed-out process ${pid} is gone before runCodexCommand rejects`,
			);
		}
	} finally {
		for (const pid of pids) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Native command byte limits are forwarded to the streaming capture layer, so
// large Cloud output is discarded while it arrives rather than buffered first.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-output-limit-"));
	try {
		const cli = path.join(root, "fake-output-codex.mjs");
		fs.writeFileSync(cli, `process.stdout.write("o".repeat(4096)); process.stderr.write("e".repeat(4096));\n`);
		const result = await runCodexCommand(
			{ command: process.execPath, args: [cli] },
			["cloud", "list"],
			{},
			{ maxStdoutBytes: 37, maxStderrBytes: 29 },
		);
		assert.equal(result.stdout.length, 37);
		assert.equal(result.stderr.length, 29);
		assert.equal(result.stdoutTruncated, true);
		assert.equal(result.stderrTruncated, true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A native command whose tree cannot be confirmed stopped installs the same
// sticky app-lifetime fence as a failed ACP replacement. The invocation getter
// is a deterministic failure seam here: retries must be rejected before the
// native command is evaluated a second time.
await (async () => {
	const { app } = appHarness();
	let invocationReads = 0;
	const fatal = new Error("native Codex process tree remains live");
	fatal.code = "PROCESS_TREE_TERMINATION_FAILED";
	const invocation = {};
	Object.defineProperty(invocation, "command", {
		get() {
			invocationReads += 1;
			throw fatal;
		},
	});
	await assert.rejects(
		app.runTrackedCodexCommand(invocation, ["cloud", "apply", "task-id"]),
		(error) => error?.code === "PROCESS_TREE_TERMINATION_FAILED" && error.cause === fatal,
	);
	assert.equal(app.replacementProcessFence, fatal);
	assert.equal(app.ready, true, "a native helper fence does not misreport the live ACP session as disconnected");
	await assert.rejects(
		app.runTrackedCodexCommand(invocation, ["cloud", "apply", "task-id"]),
		(error) => error?.code === "PROCESS_TREE_TERMINATION_FAILED",
	);
	assert.equal(invocationReads, 1, "the sticky fence blocks the retry before spawning another native mutation");
})();

// Ctrl-D/SIGTERM shutdown owns every detached native helper, not only the ACP
// clients. A state-changing Codex command and a short-lived app-server request
// are signalled together, their complete process trees are reaped, and only then
// may stopAndExit return control to the shell.
if (process.platform !== "win32") await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-native-app-shutdown-"));
	const commandScript = path.join(root, "command.mjs");
	const descendantScript = path.join(root, "descendant.mjs");
	const appServerScript = path.join(root, "app-server.mjs");
	const commandPidsFile = path.join(root, "command-pids.json");
	const descendantReadyFile = path.join(root, "descendant-ready");
	const appServerPidFile = path.join(root, "app-server.pid");
	let pids = [];
	try {
		fs.writeFileSync(descendantScript, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.CC_DESCENDANT_READY, String(process.pid));
setInterval(() => {}, 1_000);
`);
		fs.writeFileSync(commandScript, `
import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
  env: { ...process.env, CC_DESCENDANT_READY: process.env.CC_DESCENDANT_READY },
});
const ready = setInterval(() => {
  if (!fs.existsSync(process.env.CC_DESCENDANT_READY)) return;
  clearInterval(ready);
  fs.writeFileSync(process.env.CC_COMMAND_PIDS, JSON.stringify([process.pid, descendant.pid]));
}, 5);
setInterval(() => {}, 1_000);
`);
		fs.writeFileSync(appServerScript, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.CC_APP_SERVER_PID, String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1_000);
`);

		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			replacementProcessFence: undefined,
			ready: true,
			client: undefined,
			btwThread: undefined,
			btwShutdownTail: undefined,
			spinnerTimer: undefined,
			markdownPreloadTimer: undefined,
			startupConnectTimer: undefined,
			voiceController: undefined,
			clearCancelGraceTimer() {},
			cancelPermissionPrompts() {},
			ui: { stop() {} },
		});
		const command = app.runTrackedCodexCommand(
			{ command: process.execPath, args: [commandScript] },
			["cloud", "apply", "task-id"],
			{ env: { CC_COMMAND_PIDS: commandPidsFile, CC_DESCENDANT_READY: descendantReadyFile } },
			{ timeoutMs: 30_000, terminationGraceMs: 50 },
		).then(
			() => ({ ok: true }),
			(error) => ({ ok: false, error }),
		);
		const appServer = app.runFencedCodexAppServerRequests(
			{ command: process.execPath, args: [appServerScript] },
			[{ method: "thread/name/set", params: { threadId: "thread", name: "name" } }],
			{ env: { CC_APP_SERVER_PID: appServerPidFile } },
			{ timeoutMs: 30_000, terminationGraceMs: 50 },
		).then(
			() => ({ ok: true }),
			(error) => ({ ok: false, error }),
		);

		for (
			let attempt = 0;
			attempt < 400 && (!fs.existsSync(commandPidsFile) || !fs.existsSync(appServerPidFile));
			attempt += 1
		) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(fs.existsSync(commandPidsFile), true, "native command tree started");
		assert.equal(fs.existsSync(appServerPidFile), true, "native app-server started");
		pids = [
			...JSON.parse(fs.readFileSync(commandPidsFile, "utf8")),
			Number(fs.readFileSync(appServerPidFile, "utf8")),
		];
		let exited = false;
		await app.stopAndExit({
			exit(code) {
				assert.equal(code, 0);
				for (const pid of pids) {
					assert.throws(
						() => process.kill(pid, 0),
						(error) => error?.code === "ESRCH",
						`native process ${pid} is gone before shell control returns`,
					);
				}
				exited = true;
			},
		});
		assert.equal(exited, true);
		for (const outcome of await Promise.all([command, appServer])) {
			assert.equal(outcome.ok, false);
			assert.match(outcome.error.message, /stopped because cc is exiting/);
		}
		assert.equal(app.nativeProcessTracker.entries.size, 0);
	} finally {
		for (const pid of pids) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Terminal authentication is another app-owned native operation. If cc exits
// while login has inherited the terminal, shutdown terminates and reaps the
// complete detached tree before returning control, and the suspended TUI is not
// restarted by the authentication finally block.
if (process.platform !== "win32") await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-terminal-auth-shutdown-"));
	const authScript = path.join(root, "auth.mjs");
	const descendantScript = path.join(root, "descendant.mjs");
	const descendantReadyFile = path.join(root, "descendant-ready");
	const pidsFile = path.join(root, "pids.json");
	let pids = [];
	try {
		fs.writeFileSync(descendantScript, `
import fs from "node:fs";
process.on("SIGTERM", () => {});
fs.writeFileSync(process.env.CC_DESCENDANT_READY, String(process.pid));
setInterval(() => {}, 1_000);
`);
		fs.writeFileSync(authScript, `
import { spawn } from "node:child_process";
import fs from "node:fs";
process.on("SIGTERM", () => {});
const descendant = spawn(process.execPath, [${JSON.stringify(descendantScript)}], {
  stdio: "ignore",
  env: process.env,
});
const ready = setInterval(() => {
  if (!fs.existsSync(process.env.CC_DESCENDANT_READY)) return;
  clearInterval(ready);
  fs.writeFileSync(process.env.CC_AUTH_PIDS, JSON.stringify([process.pid, descendant.pid]));
}, 5);
setInterval(() => {}, 1_000);
`);
		const errors = [];
		let uiStarts = 0;
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "codex",
			transport: "acp",
			config: {
				agents: {
					codex: {
						acp: { command: process.execPath, args: [authScript] },
						env: { CC_DESCENDANT_READY: descendantReadyFile, CC_AUTH_PIDS: pidsFile },
					},
				},
			},
			client: undefined,
			ready: false,
			stopping: false,
			btwThread: undefined,
			btwShutdownTail: undefined,
			spinnerTimer: undefined,
			markdownPreloadTimer: undefined,
			startupConnectTimer: undefined,
			voiceController: undefined,
			statusState: "",
			addCommandMessage() {},
			addNotice() {},
			addError(message) { errors.push(message); },
			updateSpinner() {},
			clearCancelGraceTimer() {},
			cancelPermissionPrompts() {},
			ui: {
				stop() {},
				start() { uiStarts += 1; },
				requestRender() {},
			},
		});
		const authentication = app.authenticateWithTerminalMethod(
			{ type: "terminal", id: "login", name: "Login" },
			"login",
			{ terminationGraceMs: 50 },
		);
		for (let attempt = 0; attempt < 400 && !fs.existsSync(pidsFile); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(fs.existsSync(pidsFile), true, "terminal authentication tree started");
		pids = JSON.parse(fs.readFileSync(pidsFile, "utf8"));
		let exited = false;
		await app.stopAndExit({
			exit(code) {
				assert.equal(code, 0);
				for (const pid of pids) {
					assert.throws(
						() => process.kill(pid, 0),
						(error) => error?.code === "ESRCH",
						`terminal authentication process ${pid} is gone before shell control returns`,
					);
				}
				exited = true;
			},
		});
		await authentication;
		assert.equal(exited, true);
		assert.equal(uiStarts, 0, "shutdown must not restart the TUI suspended for terminal authentication");
		assert.ok(errors.some((message) => message.includes("stopped because cc is exiting")));
		assert.equal(app.nativeProcessTracker.entries.size, 0);
	} finally {
		for (const pid of pids) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// A reconnect superseded by an explicit harness switch cannot report the newly
// selected agent as the old caller's successful connection.
await (async () => {
	const { app } = appHarness();
	app.ready = false;
	app.client = undefined;
	app.switchAgent = async () => {
		app.activeKey = "other";
		app.activeAgentGeneration += 1;
		app.config.agents.other = {};
		app.client = { sessionId: "other-session", exited: false };
		app.ready = true;
	};
	assert.equal(await app.ensureConnected(), false);
})();

// The one-shot app-server helper waits for delayed initialization, tolerates an
// interleaved notification, sends `initialized`, omits params on account reads,
// and waits for the child to close cleanly.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-app-server-"));
	try {
		const cli = path.join(root, "fake-codex.mjs");
		const log = path.join(root, "requests.jsonl");
		fs.writeFileSync(cli, `
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
if (process.argv[2] === "cloud") {
  fs.appendFileSync(process.env.CC_TEST_LOG, JSON.stringify({ cloud: process.argv.slice(2) }) + "\\n");
  process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n");
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\r\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.CC_TEST_LOG, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    if (process.env.CC_TEST_MODE === "exit") { process.stderr.write("app-server boom\\n"); process.exit(7); }
    if (process.env.CC_TEST_MODE === "timeout") {
      if (process.env.CC_PID_FILE) fs.writeFileSync(process.env.CC_PID_FILE, String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1_000);
      return;
    }
    if (process.env.CC_TEST_MODE === "timeout-descendant") {
      const descendantSource = 'const fs = require("node:fs"); fs.writeFileSync(process.env.CC_DESCENDANT_PID_FILE, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);';
      const descendant = spawn(process.execPath, ["-e", descendantSource], {
        env: process.env,
        stdio: "ignore",
      });
      descendant.unref();
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1_000);
      return;
    }
    setTimeout(() => {
      send({ method: "remoteControl/status/changed", params: { status: "disabled" } });
      send({ id: message.id, result: { ready: true } });
    }, 25);
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method === "thread/name/set") {
    setTimeout(() => send({ id: message.id, result: {} }), Number(process.env.CC_RENAME_DELAY || 0));
    return;
  }
  if (message.method === "thread/goal/get") {
    setTimeout(() => send({ id: message.id, result: { goal: { objective: "Ship parity", status: "active", tokensUsed: 12, timeUsedSeconds: 5 } } }), Number(process.env.CC_GOAL_DELAY || 0));
    return;
  }
  if (message.method === "account/usage/read") {
    if (!initialized) { send({ id: message.id, error: { code: -1, message: "not initialized" } }); return; }
    if (process.env.CC_TEST_MODE === "rpc-error") { send({ id: message.id, error: { code: -32000, message: "usage unavailable" } }); return; }
    if (process.env.CC_TEST_MODE === "secret-error") { send({ id: message.id, error: { code: -32000, message: 'invalid api_key = "must-not-print"' } }); return; }
    if (process.env.CC_TEST_MODE === "collision") send({ id: message.id, method: "client/unexpected", params: {} });
    send({ id: message.id, result: { summary: { lifetimeTokens: 1234 }, dailyUsageBuckets: [{ startDate: "2026-07-10", tokens: 42 }] } });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 25 } }, rateLimitResetCredits: { availableCount: 1 } } });
    return;
  }
  if (message.method === "account/rateLimitResetCredit/consume") { send({ id: message.id, result: { outcome: "reset" } }); return; }
});
`);
		fs.chmodSync(cli, 0o755);
		const invocation = { command: process.execPath, args: [cli] };
		const agent = { env: { CC_TEST_LOG: log } };
		const [usage, limits] = await runCodexAppServerRequests(invocation, [
			{ method: "account/usage/read" },
			{ method: "account/rateLimits/read" },
		], agent, { timeoutMs: 5_000 });
		assert.equal(usage.summary.lifetimeTokens, 1234);
		assert.equal(limits.rateLimits.primary.usedPercent, 25);
		const messages = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
		assert.deepEqual(messages.map((message) => message.method), ["initialize", "initialized", "account/usage/read", "account/rateLimits/read"]);
		assert.equal(Object.hasOwn(messages[2], "params"), false);

		await assert.rejects(
			() => runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
				env: { CC_TEST_LOG: log, CC_TEST_MODE: "rpc-error" },
			}),
			/usage\/read failed \(-32000\): usage unavailable/,
		);
		await assert.rejects(
			() => runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
				env: { CC_TEST_LOG: log, CC_TEST_MODE: "secret-error" },
			}, {
				sanitizeError: (error) => {
					const safe = new Error("Codex config request failed");
					safe.code = error?.code;
					return safe;
				},
			}),
			(error) => /config request failed/.test(error.message) && !/must-not-print|api_key/.test(error.message),
		);
		await assert.rejects(
			() => runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
				env: { CC_TEST_LOG: log, CC_TEST_MODE: "exit" },
			}),
			/exited 7.*app-server boom/,
		);
		const pidFile = path.join(root, "wedged.pid");
		await assert.rejects(
			() => runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
				env: { CC_TEST_LOG: log, CC_TEST_MODE: "timeout", CC_PID_FILE: pidFile },
			}, { timeoutMs: 75 }),
			/timed out/,
		);
		const wedgedPid = Number(fs.readFileSync(pidFile, "utf8"));
		await new Promise((resolve) => setTimeout(resolve, 1_300));
		assert.throws(() => process.kill(wedgedPid, 0), /ESRCH/, "timed-out app-server is force-killed after its grace period");
		if (process.platform !== "win32") {
			const descendantPidFile = path.join(root, "wedged-descendant.pid");
			await assert.rejects(
				() => runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
					env: {
						CC_TEST_LOG: log,
						CC_TEST_MODE: "timeout-descendant",
						CC_DESCENDANT_PID_FILE: descendantPidFile,
					},
				}, { timeoutMs: 500 }),
				/timed out/,
			);
			const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
			assert.throws(
				() => process.kill(descendantPid, 0),
				/ESRCH/,
				"app-server timeout does not reject until a wrapper descendant is gone",
			);
		}
		const [collision] = await runCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], {
			env: { CC_TEST_LOG: log, CC_TEST_MODE: "collision" },
		});
		assert.equal(collision.summary.lifetimeTokens, 1234, "an id-colliding server request is not mistaken for the response");
		const fencedHelper = appHarness({ env: { CC_TEST_LOG: log } }).app;
		const fatalHelperError = new Error("prior app-server tree remains live");
		fatalHelperError.code = "PROCESS_TREE_TERMINATION_FAILED";
		fencedHelper.recordReplacementProcessFence(fatalHelperError, { preserveReady: true });
		assert.equal(fencedHelper.ready, true, "short-lived helper failure preserves the healthy main ACP session");
		const helperLogBeforeRetry = fs.readFileSync(log, "utf8");
		await assert.rejects(
			() => fencedHelper.runFencedCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], fencedHelper.config.agents.codex),
			/restart cc.*prior app-server tree remains live/,
		);
		assert.equal(fs.readFileSync(log, "utf8"), helperLogBeforeRetry, "fatal helper fence prevents another app-server spawn");

		const featureAgent = { env: { CODEX_PATH: cli, PATH: "", CC_TEST_LOG: log } };
		const renamed = appHarness(featureAgent);
		renamed.app.sessionStates.set("codex", {});
		await renamed.app.renameCodexSession("\u001b[31mUseful\u001b[0m\nname");
		assert.equal(renamed.app.sessionStates.get("codex").sessionInfo.title, "Useful name");
		assert.ok(renamed.notices.some((message) => message.includes("Useful name")));

		const raced = appHarness({
			env: { CODEX_PATH: cli, PATH: "", CC_TEST_LOG: log, CC_RENAME_DELAY: "50" },
		});
		raced.app.sessionStates.set("codex", {});
		const renamePromise = raced.app.renameCodexSession("stale name");
		setTimeout(() => { raced.app.client = { sessionId: "replacement", exited: false }; }, 10);
		await renamePromise;
		assert.equal(raced.app.sessionStates.get("codex").sessionInfo, undefined, "a stale rename result cannot update another session");

		// Session-scoped commands typed in the focused /btw pane must use that
		// exact fork id. In particular, /goal edit must not copy main's objective
		// into the side composer and then overwrite the side goal on submit.
			const sideScoped = appHarness(featureAgent);
			sideScoped.app.sessionStates.set("codex", {});
			const sideClient = { sessionId: "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", exited: false };
			const sideOutput = { commands: [], notices: [], errors: [] };
			const sideThread = {
				sessionId: sideClient.sessionId,
				client: sideClient,
				busy: false,
				commandsLoaded: true,
				availableCommands: [],
				addCommandMessage(message) { sideOutput.commands.push(message); },
				addNotice(message) { sideOutput.notices.push(message); },
				addError(message) { sideOutput.errors.push(message); },
			};
			sideScoped.app.btwThread = sideThread;
			sideScoped.app.focusedThread = "btw";
			const mainCommandsBeforeSideCommands = sideScoped.commands.length;
			const mainNoticesBeforeSideCommands = sideScoped.notices.length;
			await sideScoped.app.handleSubmit("/rename Side session");
			let sideRequests = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			assert.equal(sideRequests.findLast((message) => message.method === "thread/name/set")?.params?.threadId, sideClient.sessionId);
			assert.equal(sideClient.sessionInfo.title, "Side session");
			assert.equal(sideScoped.app.sessionStates.get("codex").sessionInfo, undefined, "side rename cannot rewrite main session state");
			assert.match(sideOutput.commands.at(-1), /^\/rename Side session/);
			assert.match(sideOutput.notices.at(-1), /Renamed this \/btw session to Side session/);
			assert.equal(sideScoped.commands.length, mainCommandsBeforeSideCommands, "side rename command does not leak into main");
			assert.equal(sideScoped.notices.length, mainNoticesBeforeSideCommands, "side rename result does not leak into main");
			await sideScoped.app.handleSubmit("/goal edit");
			sideRequests = fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
			assert.equal(sideRequests.findLast((message) => message.method === "thread/goal/get")?.params?.threadId, sideClient.sessionId);
			assert.equal(sideScoped.app.editor.getText(), "/goal Ship parity");
			assert.equal(sideScoped.app.editorTargetThread, sideThread, "editable goal remains bound to its originating fork");
			assert.match(sideOutput.commands.at(-1), /^\/goal edit/);
			await sideScoped.app.handleSubmit("/goal");
			assert.match(sideOutput.notices.at(-1), /Ship parity/);
			assert.equal(sideScoped.commands.length, mainCommandsBeforeSideCommands, "side goal commands do not leak into main");
			assert.equal(sideScoped.notices.length, mainNoticesBeforeSideCommands, "side goal output does not leak into main");

		// A captured side target is identity-bound. If it closes before a deferred
		// command runs, cancel locally rather than falling back to main's session id.
		const staleSide = appHarness(featureAgent);
		const staleClient = { sessionId: "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff", exited: false };
		const staleThread = { sessionId: staleClient.sessionId, client: staleClient, busy: false };
		staleSide.app.btwThread = staleThread;
		staleSide.app.focusedThread = "btw";
		staleSide.app.btwThread = undefined;
		const requestsBeforeStale = fs.readFileSync(log, "utf8").trim().split("\n").length;
		await staleSide.app.runLocalSlashCommand("rename", "must not target main", { targetThread: staleThread });
		assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, requestsBeforeStale);
		assert.ok(staleSide.notices.some((message) => message.includes("targeted /btw thread is no longer open")));

		const account = appHarness(featureAgent);
		await account.app.runCodexUsage();
		assert.match(account.blocks.join("\n"), /Lifetime tokens: 1,234/);
		assert.match(account.blocks.join("\n"), /Earned reset credits: 1/);

		const reset = appHarness(featureAgent);
		let resetSelection;
		reset.app.openSelection = (_title, _entries, callback) => { resetSelection = callback; };
		reset.app.closeMenu = () => {};
		const beforeReset = fs.readFileSync(log, "utf8").split("\n").length;
		await reset.app.runCodexUsage("reset");
		assert.equal(fs.readFileSync(log, "utf8").split("\n").length, beforeReset, "reset does not run before confirmation");
			await resetSelection({ value: "reset" });
			assert.ok(reset.notices.some((message) => message.includes("were reset")));

			const confirmedReset = appHarness(featureAgent);
			let confirmedResetOptions;
			confirmedReset.app.runFencedCodexAppServerRequests = async (_invocation, requests, _agent, options) => {
				assert.equal(requests[0].method, "account/rateLimitResetCredit/consume");
				confirmedResetOptions = options;
				return [{ outcome: "reset" }];
			};
			await confirmedReset.app.consumeCodexUsageReset(confirmedReset.app.captureActiveAgentContext());
			assert.equal(
				confirmedResetOptions.acceptForcedTeardownAfterResponse,
				true,
				"a confirmed credit consumption remains successful after confirmed forceful teardown",
			);

			const goal = appHarness(featureAgent);
		await goal.app.runCodexGoalView("edit");
		assert.equal(goal.app.editor.getText(), "/goal Ship parity");

		const goalRace = appHarness({
			env: { CODEX_PATH: cli, PATH: "", CC_TEST_LOG: log, CC_GOAL_DELAY: "50" },
		});
		const goalPromise = goalRace.app.runCodexGoalView("edit");
		setTimeout(() => goalRace.app.editor.setText("newer draft"), 10);
		await goalPromise;
		assert.equal(goalRace.app.editor.getText(), "newer draft");
		assert.ok(goalRace.notices.some((message) => message.includes("without replacing newer input")));

		const busyGoal = appHarness(featureAgent);
		busyGoal.app.busy = true;
		await busyGoal.app.runLocalSlashCommand("goal", "edit");
		assert.deepEqual(busyGoal.app.deferredLocalSlashCommands.map(({ name, argument }) => ({ name, argument })), [
			{ name: "goal", argument: "edit" },
		]);

		const cloud = appHarness(featureAgent);
		await cloud.app.runCodexCloud("list --json");
		assert.match(cloud.blocks.join("\n"), /cloud.*list.*--json/);

		const boundedCloud = appHarness(featureAgent);
		let cloudCaptureOptions;
		boundedCloud.app.runTrackedCodexCommand = async (_invocation, _args, _agent, options) => {
			cloudCaptureOptions = options;
			return {
				code: 0,
				signal: null,
				stdout: Buffer.from("partial cloud output"),
				stderr: Buffer.from("partial warning"),
				stdoutTruncated: true,
				stderrTruncated: true,
			};
		};
		await boundedCloud.app.runCodexCloud("list");
		assert.ok(Number.isFinite(cloudCaptureOptions.maxStdoutBytes));
		assert.ok(Number.isFinite(cloudCaptureOptions.maxStderrBytes));
		assert.match(boundedCloud.notices.join("\n"), /stdout and stderr.*omitted.*safety limit/i);

		const apply = appHarness(featureAgent);
		let applySelection;
		apply.app.openSelection = (_title, _entries, callback) => { applySelection = callback; };
		apply.app.closeMenu = () => {};
		const beforeApply = fs.readFileSync(log, "utf8").split("\n").length;
		await apply.app.runCodexCloud("apply task-123");
		assert.equal(fs.readFileSync(log, "utf8").split("\n").length, beforeApply, "cloud apply does not run before confirmation");
		apply.app.btwThread = { busy: true };
		await applySelection({ value: "apply" });
		assert.equal(fs.readFileSync(log, "utf8").split("\n").length, beforeApply, "a side turn that starts during confirmation blocks cloud apply");
		assert.match(apply.notices.join("\n"), /cannot be applied while a turn is running/);
		apply.app.btwThread.busy = false;
		await apply.app.runCodexCloud("apply task-123");
		await applySelection({ value: "apply" });
		assert.match(apply.blocks.join("\n"), /cloud.*apply.*task-123/);

		for (const busyOwner of ["main", "side"]) {
			const blocked = appHarness(featureAgent);
			blocked.app.busy = busyOwner === "main";
			blocked.app.btwThread = busyOwner === "side" ? { busy: true } : undefined;
			blocked.app.openSelection = () => assert.fail(`${busyOwner} busy state must block confirmation`);
			await blocked.app.runCodexCloud("apply task-456");
			assert.match(blocked.notices.join("\n"), /cannot be applied while a turn is running/);
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Closing an ordinary side pane starts an awaitable tree retirement immediately,
// and a new /btw fork cannot overtake it.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-btw-retirement-gate-"));
	const previousForkRegistry = process.env.CC_FORKS;
	process.env.CC_FORKS = path.join(root, "forks.json");
	const originalInitialize = AcpClient.prototype.initialize;
	const originalForkSession = AcpClient.prototype.forkSession;
	let releaseSideStop;
	const sideStopGate = new Promise((resolve) => { releaseSideStop = resolve; });
	let newSideInitializations = 0;
	try {
		const { app } = appHarness();
		app.focusedThread = "btw";
		app.mainView = {};
		app.closeMenu = () => {};
		app.cancelInteractiveRequestsForClient = () => {};
		app.clearEditorSideThreadBinding = () => {};
		app.forceFullRepaint = () => {};
		app.onThreadActivity = () => {};
		app.ui.terminal = { enterAlternateScreen() {}, exitAlternateScreen() {} };
		app.btwShutdownClients = new WeakMap();
		const oldSideClient = {
			cancel() {},
			async stopAndWait() { await sideStopGate; },
		};
		app.btwThread = { client: oldSideClient, clearCancelGraceTimer() {} };
		const retiring = app.closeBtw();
		AcpClient.prototype.initialize = async function initializeSide() {
			newSideInitializations += 1;
			this.capabilities = { sessionCapabilities: { fork: true } };
			this.sessionId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
		};
		AcpClient.prototype.forkSession = async function forkSide() {
			this.sessionId = "bbbbbbbb-cccc-7ddd-8eee-ffffffffffff";
			return { sessionId: this.sessionId };
		};
		const opening = app.runBtw("");
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(newSideInitializations, 0, "new side ACP process waits for the prior side tree");
		assert.equal(app.btwThread, undefined);
		releaseSideStop();
		await retiring;
		await opening;
		assert.equal(newSideInitializations, 1);
		assert.ok(app.btwThread);
		await app.closeBtw();
	} finally {
		AcpClient.prototype.initialize = originalInitialize;
		AcpClient.prototype.forkSession = originalForkSession;
		if (previousForkRegistry === undefined) delete process.env.CC_FORKS;
		else process.env.CC_FORKS = previousForkRegistry;
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Successful app-server RPC completion is also a process-tree lifecycle boundary.
// The wrapper deliberately exits after replying while a same-group descendant
// ignores SIGTERM; the helper must not resolve until that descendant is gone.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-app-server-success-tree-"));
	const cli = path.join(root, "codex.mjs");
	const descendantPidFile = path.join(root, "descendant.pid");
	let descendantPid;
	try {
		fs.writeFileSync(cli, `
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") { send({ id: message.id, result: {} }); return; }
  if (message.method === "initialized") return;
  const source = 'const fs=require("node:fs"); fs.writeFileSync(process.env.CC_DESCENDANT_PID_FILE,String(process.pid)); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);';
  spawn(process.execPath, ["-e", source], { stdio: "ignore", env: process.env });
  const ready = setInterval(() => {
    if (!fs.existsSync(process.env.CC_DESCENDANT_PID_FILE)) return;
    clearInterval(ready);
    send({ id: message.id, result: { ok: true } });
    setImmediate(() => process.exit(0));
  }, 5);
});
`);
		fs.chmodSync(cli, 0o755);
		const [result] = await runCodexAppServerRequests(
			{ command: process.execPath, args: [cli] },
			[{ method: "account/usage/read" }],
			{ env: { CC_DESCENDANT_PID_FILE: descendantPidFile } },
			{ timeoutMs: 5_000 },
		);
		assert.deepEqual(result, { ok: true });
		descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
		assert.throws(
			() => process.kill(descendantPid, 0),
			(error) => error?.code === "ESRCH",
			"successful app-server completion awaits descendant teardown",
		);
		fs.rmSync(descendantPidFile, { force: true });
		await assert.rejects(
			() => runCodexAppServerRequests(
				{ command: process.execPath, args: [cli] },
				[{ method: "thread/name/set", params: { threadId: "thread", name: "name" } }],
				{ env: { CC_DESCENDANT_PID_FILE: descendantPidFile } },
				{ timeoutMs: 5_000 },
			),
			(error) => error?.code === "PROCESS_TREE_FORCE_KILLED",
			"a state-changing RPC reports when successful teardown required SIGKILL",
		);
		descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
		assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === "ESRCH");
		fs.rmSync(descendantPidFile, { force: true });
		const [uploaded] = await runCodexAppServerRequests(
			{ command: process.execPath, args: [cli] },
			[{ method: "feedback/upload", params: { classification: "bug", includeLogs: false } }],
			{ env: { CC_DESCENDANT_PID_FILE: descendantPidFile } },
			{ timeoutMs: 5_000, acceptForcedTeardownAfterResponse: true },
		);
		assert.deepEqual(uploaded, { ok: true });
		descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
		assert.throws(
			() => process.kill(descendantPid, 0),
			(error) => error?.code === "ESRCH",
			"a confirmed feedback response remains authoritative after forced teardown",
		);
		fs.rmSync(descendantPidFile, { force: true });
		const [detected] = await runCodexAppServerRequests(
			{ command: process.execPath, args: [cli] },
			[{ method: "externalAgentConfig/detect", params: { includeHome: true } }],
			{ env: { CC_DESCENDANT_PID_FILE: descendantPidFile } },
			{ timeoutMs: 5_000 },
		);
		assert.deepEqual(detected, { ok: true });
		descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
		assert.throws(
			() => process.kill(descendantPid, 0),
			(error) => error?.code === "ESRCH",
			"read-only import detection tolerates confirmed forced teardown without a mutation fence",
		);
	} finally {
		if (Number.isInteger(descendantPid)) {
			try { process.kill(descendantPid, "SIGKILL"); } catch {}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// Some app-server mutations acknowledge the request before their background
// work is durable. Keep the helper alive until the correlated completion
// notification arrives, including when a fast notification races the response.
await (async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-app-server-notification-"));
	const cli = path.join(root, "codex.mjs");
	try {
		fs.writeFileSync(cli, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") { send({ id: message.id, result: {} }); return; }
  if (message.method === "initialized") return;
  if (message.method === "externalAgentConfig/import") {
    send({ method: "externalAgentConfig/import/completed", params: { importId: "fast", itemTypeResults: [] } });
    send({ id: message.id, result: { importId: "fast" } });
  }
});
`);
		fs.chmodSync(cli, 0o755);
		const results = await runCodexAppServerRequests(
			{ command: process.execPath, args: [cli] },
			[{ method: "externalAgentConfig/import", params: { migrationItems: [] } }],
			{},
			{
				timeoutMs: 5_000,
				acceptForcedTeardownAfterResponse: true,
				waitForNotification: {
					method: "externalAgentConfig/import/completed",
					matches: (params, responses) => params.importId === responses.at(-1)?.importId,
				},
			},
		);
		assert.deepEqual(results, [
			{ importId: "fast" },
			{ importId: "fast", itemTypeResults: [] },
		]);
		await assert.rejects(
			() => runCodexAppServerRequests(
				{ command: process.execPath, args: [cli] },
				[{ method: "externalAgentConfig/import", params: { migrationItems: [] } }],
				{},
				{
					timeoutMs: 75,
					waitForNotification: {
						method: "externalAgentConfig/import/completed",
						matches: () => false,
					},
				},
			),
			(error) => error?.code === "CODEX_COMPLETION_UNCONFIRMED" && /accepted.*completion/i.test(error.message),
		);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
})();

// The local command catalog exposes the newly reachable Codex surfaces.
{
	const { app } = appHarness();
	const names = new Set(localSlashCommands(app).map((command) => command.name));
	for (const name of ["rename", "usage", "cloud", "permissions", "plan", "btw", "side"]) assert.ok(names.has(name), name);
	assert.equal(app.slashCommandRoute("side"), "local");
}

if (previousForkRegistry === undefined) delete process.env.CC_FORKS;
else process.env.CC_FORKS = previousForkRegistry;
fs.rmSync(testForkRegistryRoot, { recursive: true, force: true });

console.log("codex features: permission, plan, app-server, diff, and lifecycle parity");
