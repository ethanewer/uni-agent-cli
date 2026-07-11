import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	forgetForkIds,
	HarnessApp,
	loadForkParents,
	localSlashCommands,
} from "../src/pi-harness.mjs";

const parentId = "019abcde-1234-7abc-8def-0123456789ab";
const childId = "019abcde-5678-7abc-8def-0123456789ab";
const secondChildId = "019abcde-7777-7abc-8def-0123456789ab";
const turnId = "019abcde-9999-7abc-8def-0123456789ab";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-persistent-fork-"));
const previousForkRegistry = process.env.CC_FORKS;
process.env.CC_FORKS = path.join(root, "forks.json");
const codexPath = path.join(root, "codex.mjs");
fs.writeFileSync(codexPath, "process.exit(0);\n");
fs.chmodSync(codexPath, 0o755);

function forkHarness(options = {}) {
	const commands = [];
	const notices = [];
	const errors = [];
	const events = [];
	const requests = [];
	const appServerOptions = [];
	const agent = { env: { CODEX_PATH: codexPath, PATH: "" } };
	const app = Object.create(HarnessApp.prototype);
	const client = {
		sessionId: parentId,
		exited: false,
		capabilities: {},
		async loadSession(sessionId, loadOptions) {
			events.push("load");
			assert.equal(loadForkParents().get(sessionId), parentId, "the parent relation is durable before ACP loads the child");
			if (options.loadFailure) {
				app.promptQueue.push({ text: "typed while ACP load failed", timing: "afterTurn", queuedInputOrder: 2 });
				throw new Error("ACP load failed");
			}
			this.sessionId = sessionId;
			await loadOptions.beforeReplay();
			events.push("replayed");
		},
	};
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { codex: agent }, settings: {} },
		client,
		ready: true,
		busy: false,
		btwThread: options.sideThread,
		focusedThread: options.focusedThread ?? "main",
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateTokens: new Set(),
		configUpdateCount: 0,
		permissionPromptActive: false,
		menuHandle: undefined,
		flushingPromptQueue: false,
		statusState: "",
		promptQueue: [],
		deferredLocalSlashCommands: [],
		deferredBtwPrompts: [],
		clipboardImages: [],
		queuedInputOrder: 0,
		pendingPromptDisplay: undefined,
		sessionStates: new Map(),
		availableCommands: new Map(),
		commandsLoaded: new Set(["codex"]),
		ui: { requestRender() {} },
		editor: {
			text: "",
			getText() { return this.text; },
			setText(value) { this.text = value; },
		},
		addCommandMessage(value) { commands.push(value); },
		addNotice(value) { notices.push(value); },
		addError(value) { errors.push(value); },
		updateSpinner() {},
		updateAutocomplete() { events.push("autocomplete"); },
		resetConversationView() { events.push("reset"); },
		closeBtw() {
			events.push("close-btw");
			this.btwThread = undefined;
		},
		async settleDeferredBtwPrompts() {
			assert.equal(this.sessionSwitchInProgress, true, "side input settles while the transition still owns the queue");
			events.push("settle-side");
		},
		async flushDeferredLocalSlashCommands() {
			assert.equal(this.sessionSwitchInProgress, false, "deferred commands flush only after the child commits");
			events.push("flush-commands");
		},
		schedulePromptQueueDrain() { events.push("drain-prompts"); },
		async runFencedCodexAppServerRequests(_invocation, rpcRequests, _agent, rpcOptions) {
			assert.equal(this.sessionSwitchInProgress, true, "the transition is owned before the native RPC await");
			assert.equal(fs.existsSync(`${process.env.CC_FORKS}.operation-lock`), true, "thread/fork runs under the storage lock");
			requests.push(...rpcRequests);
			appServerOptions.push(rpcOptions);
			if (options.nativeFailure) {
				this.promptQueue.push({ text: "typed while native fork failed", timing: "afterTurn", queuedInputOrder: 1 });
				throw new Error("native fork failed");
			}
			this.promptQueue.push({ text: "typed while fork succeeded", timing: "afterTurn", queuedInputOrder: 1 });
			return [{
				thread: {
					id: options.childId ?? childId,
					forkedFromId: parentId,
					ephemeral: false,
					name: "Alternative approach",
				},
				cwd: process.cwd(),
			}];
		},
	});
	return { app, client, commands, notices, errors, events, requests, appServerOptions };
}

try {
	// Main-pane autocomplete exposes the persistent fork, while /btw hides it.
	// Routing remains local in the side pane so an explicit command is rejected by
	// cc instead of being forwarded to an ACP command with different semantics.
	{
		const main = forkHarness();
		assert.ok(localSlashCommands(main.app).some((entry) => entry.name === "fork"));
		const side = {
			busy: false,
			sessionId: childId,
			client: { sessionId: childId, exited: false, capabilities: {}, getSessionInfo: () => ({}) },
			addCommandMessage(value) { main.commands.push(value); },
			addNotice(value) { main.notices.push(value); },
		};
		main.app.focusedThread = "btw";
		main.app.btwThread = side;
		assert.equal(localSlashCommands(main.app).some((entry) => entry.name === "fork"), false);
		assert.equal(main.app.slashCommandRoute("fork"), "local");
		await main.app.forkCodexPersistentSession("", "fork", { targetThread: side });
		assert.match(main.notices.join("\n"), /unavailable from \/btw/);
		assert.deepEqual(main.requests, []);
	}

	// A successful native fork is persistent, records lineage before ACP load,
	// replays the child into the main pane, and retains input queued mid-transition.
	{
		const side = { busy: false };
		const harness = forkHarness({ sideThread: side });
		await harness.app.forkCodexPersistentSession(turnId);
		assert.deepEqual(harness.requests, [{
			method: "thread/fork",
			params: { threadId: parentId, lastTurnId: turnId, ephemeral: false },
		}]);
		assert.equal(harness.appServerOptions[0].acceptForcedTeardownAfterResponse, true);
		assert.equal(harness.client.sessionId, childId);
		assert.equal(loadForkParents().get(childId), parentId);
		assert.deepEqual(
			harness.events,
			["load", "close-btw", "reset", "autocomplete", "replayed", "settle-side", "flush-commands", "drain-prompts"],
		);
		assert.equal(harness.app.promptQueue[0]?.text, "typed while fork succeeded");
		assert.equal(harness.app.sessionSwitchInProgress, false);
		assert.equal(harness.app.statusState, "");
		assert.equal(fs.existsSync(`${process.env.CC_FORKS}.operation-lock`), false);
		assert.ok(harness.commands.some((entry) => /Alternative approach/.test(entry)));
	}

	// Failure before a confirmed response leaves the old session and side page in
	// place, releases the operation lock, and restores every queued input for edit.
	{
		const side = { busy: false };
		const harness = forkHarness({ nativeFailure: true, sideThread: side });
		await harness.app.forkCodexPersistentSession();
		assert.equal(harness.client.sessionId, parentId);
		assert.equal(harness.app.btwThread, side);
		assert.equal(harness.app.editor.text, "typed while native fork failed");
		assert.deepEqual(harness.app.promptQueue, []);
		assert.equal(harness.app.sessionSwitchInProgress, false);
		assert.equal(fs.existsSync(`${process.env.CC_FORKS}.operation-lock`), false);
		assert.match(harness.errors.join("\n"), /Could not fork session: native fork failed/);
	}

	// If Codex durably creates the child but ACP cannot load it, retain the
	// recorded fork for /resume and parent-safe deletion while restoring queued
	// input to the composer instead of accidentally sending it to the parent.
	{
		const harness = forkHarness({ childId: secondChildId, loadFailure: true });
		await harness.app.forkCodexPersistentSession();
		assert.equal(harness.client.sessionId, parentId);
		assert.equal(loadForkParents().get(secondChildId), parentId);
		assert.equal(
			harness.app.editor.text,
			"typed while fork succeeded\ntyped while ACP load failed",
		);
		assert.deepEqual(harness.app.promptQueue, []);
		assert.match(harness.errors.join("\n"), new RegExp(`Fork ${secondChildId} was created but could not be loaded`));
	}

	// Both live panes and every other local-operation gate prevent native storage
	// mutation. An invalid last-turn id is rejected before transition ownership.
	{
		const sideBusy = forkHarness({ sideThread: { busy: true } });
		await sideBusy.app.forkCodexPersistentSession();
		assert.deepEqual(sideBusy.requests, []);
		assert.match(sideBusy.notices.join("\n"), /while a turn is running/);

		const sideSetup = forkHarness({ sideThread: { busy: false, ready: false } });
		await sideSetup.app.forkCodexPersistentSession();
		assert.deepEqual(sideSetup.requests, []);
		assert.match(sideSetup.notices.join("\n"), /local or session operation/);

		const localBusy = forkHarness();
		localBusy.app.asyncPickerLoadCount = 1;
		await localBusy.app.forkCodexPersistentSession();
		assert.deepEqual(localBusy.requests, []);
		assert.match(localBusy.notices.join("\n"), /local or session operation/);

		const invalid = forkHarness();
		await invalid.app.forkCodexPersistentSession("not-a-turn-id");
		assert.deepEqual(invalid.requests, []);
		assert.equal(invalid.app.sessionSwitchInProgress, false);
		assert.match(invalid.errors.join("\n"), /turn ID must be a canonical UUID/);
	}
} finally {
	forgetForkIds([childId, secondChildId]);
	if (previousForkRegistry === undefined) delete process.env.CC_FORKS;
	else process.env.CC_FORKS = previousForkRegistry;
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("codex persistent fork: guarded app-server transition and input recovery");
