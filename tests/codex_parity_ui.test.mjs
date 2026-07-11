import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

const threadId = "019abcde-1234-7abc-8def-0123456789ab";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-parity-ui-"));
const codexPath = path.join(root, "codex.mjs");
const previousForkRegistry = process.env.CC_FORKS;
process.env.CC_FORKS = path.join(root, "forks.json");
fs.writeFileSync(codexPath, "process.exit(0);\n");
fs.chmodSync(codexPath, 0o755);

function appHarness() {
	const commands = [];
	const notices = [];
	const errors = [];
	const selections = [];
	const rpcCalls = [];
	const events = [];
	const agent = { env: { CODEX_PATH: codexPath, PATH: "" } };
	const client = {
		sessionId: threadId,
		exited: false,
		capabilities: {},
		async stopAndWait() { events.push("stop-acp"); },
	};
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { codex: agent }, settings: {} },
		client,
		ready: true,
		busy: false,
		focusedThread: "main",
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		permissionPromptActive: false,
		menuHandle: undefined,
		statusState: "",
		promptQueue: [],
		deferredLocalSlashCommands: [],
		deferredBtwPrompts: [],
		sessionStates: new Map(),
		availableCommands: new Map(),
		commandsLoaded: new Set(["codex"]),
		ui: { requestRender() {} },
		editor: { getText: () => "", setText() {} },
		addCommandMessage(value) { commands.push(value); },
		addNotice(value) { notices.push(value); },
		addError(value) { errors.push(value); },
		updateSpinner() {},
		openSelection(title, entries, onSelect) { selections.push({ title, entries, onSelect }); },
		closeMenu() {},
		beginAsyncPickerLoad() {
			this.asyncPickerLoadCount += 1;
			return Symbol("operation");
		},
		endAsyncPickerLoad() { this.asyncPickerLoadCount -= 1; },
		resetConversationView() { events.push("reset-view"); },
		async settleDeferredBtwPrompts() { events.push("settle-side"); },
		async flushDeferredLocalSlashCommands() { events.push("flush-commands"); },
		schedulePromptQueueDrain() { events.push("drain-prompts"); },
		restoreFailedSessionSwitchInput() { events.push("restore-input"); },
		async switchAgent(key, transport, options) {
			assert.equal(key, "codex");
			assert.equal(transport, "acp");
			assert.equal(options.loadSessionId, threadId);
			assert.equal(options.continueSessionSwitch, true);
			await options.beforeSessionReplay();
			this.client = { sessionId: threadId, exited: false, capabilities: {} };
			this.ready = true;
			events.push("reload-acp");
		},
		async runFencedCodexAppServerRequests(_invocation, requests, _agent, options) {
			rpcCalls.push({ requests, options });
			const method = requests[0]?.method;
			if (method === "config/read" && requests.length === 1) {
				if (this.installFenceAfterMemoryRead) this.replacementProcessFence = new Error("unconfirmed helper");
				return [this.memoryConfigResponse ?? { config: { features: { memories: true }, memories: { use_memories: true, generate_memories: false } } }];
			}
			if (method === "externalAgentConfig/detect") {
				return [{ items: [{ itemType: "CONFIG", description: "Claude settings", cwd: null, details: null }] }];
			}
			if (method === "externalAgentConfig/import") {
				if (this.importFailure) throw this.importFailure;
				return [
					{ importId: "import-1" },
					{ importId: "import-1", itemTypeResults: [{ itemType: "CONFIG", successes: [{}], failures: [] }] },
				];
			}
			if (method === "config/read" && requests.length === 2) {
				return [{
					layers: [{
						name: { type: "user", file: "/home/test/.codex/config.toml", profile: null },
						config: { api_key: "never-print-this" },
						disabledReason: null,
					}],
				}, { requirements: { allowedSandboxModes: ["workspace-write"] } }];
			}
			events.push("memory-rpc");
			if (method === "config/batchWrite") return [this.memoryWriteResponse ?? { status: "ok" }];
			return requests.map(() => ({}));
		},
	});
	return { app, client, commands, notices, errors, selections, rpcCalls, events };
}

try {
	{
		const harness = appHarness();
		const names = new Set(localSlashCommands(harness.app).map((entry) => entry.name));
		for (const name of ["fork", "import", "memories", "debug-config"]) assert.ok(names.has(name), name);
		for (const name of ["import", "memories", "debug-config"]) assert.equal(harness.app.slashCommandRoute(name), "local");

		harness.app.focusedThread = "btw";
		harness.app.btwThread = {
			busy: false,
			sessionId: threadId,
			client: { sessionId: threadId, exited: false, capabilities: {}, getSessionInfo: () => ({}) },
		};
		const sideNames = new Set(localSlashCommands(harness.app).map((entry) => entry.name));
		assert.equal(sideNames.has("fork"), false);
		assert.equal(sideNames.has("import"), false);
		assert.equal(sideNames.has("memories"), false);
		assert.equal(sideNames.has("debug-config"), true);
		assert.equal(harness.app.slashCommandRoute("memories"), "local", "an explicit side command is rejected locally");
	}

	// A generation change updates cold thread metadata first, persists the global
	// config second, and resumes the exact same task only after the ACP owner exits.
	{
		const harness = appHarness();
		await harness.app.openCodexMemories("generate on");
		assert.deepEqual(harness.events.slice(0, 5), ["stop-acp", "memory-rpc", "memory-rpc", "reset-view", "reload-acp"]);
		assert.deepEqual(harness.rpcCalls[1].requests, [
			{
				method: "config/batchWrite",
				params: {
					edits: [{ keyPath: "memories.generate_memories", value: true, mergeStrategy: "replace" }],
					reloadUserConfig: true,
				},
			},
		]);
		assert.deepEqual(harness.rpcCalls[2].requests, [
			{ method: "thread/memoryMode/set", params: { threadId, mode: "enabled" } },
		]);
		assert.equal(harness.rpcCalls[2].options.capabilities.experimentalApi, true);
		assert.equal(harness.app.client.sessionId, threadId);
		assert.equal(harness.app.sessionSwitchInProgress, false);
		assert.match(harness.notices.join("\n"), /generate memories: on/);
		assert.deepEqual(harness.errors, []);
	}

	// Managed configuration can accept the write while keeping a different
	// effective value. Re-read that value before applying task metadata and report
	// what actually won, not what the user requested.
	{
		const harness = appHarness();
		harness.app.memoryWriteResponse = {
			status: "okOverridden",
			overriddenMetadata: { message: "managed policy kept generation disabled" },
		};
		await harness.app.openCodexMemories("generate on");
		assert.equal(harness.rpcCalls[2].requests[0].method, "config/read");
		assert.deepEqual(harness.rpcCalls[3].requests, [
			{ method: "thread/memoryMode/set", params: { threadId, mode: "disabled" } },
		]);
		assert.match(harness.notices.join("\n"), /generate memories: off/);
		assert.match(harness.notices.join("\n"), /saved but overridden/);
		assert.deepEqual(harness.errors, []);
	}

	// Status is read-only and remains available with an idle side thread; mutations
	// are blocked so the side ACP process cannot retain stale global memory config.
	{
		const status = appHarness();
		status.app.btwThread = { busy: false };
		await status.app.openCodexMemories("status");
		assert.match(status.notices.join("\n"), /generate memories: off/);
		assert.equal(status.rpcCalls.length, 1);

		const blocked = appHarness();
		blocked.app.btwThread = { busy: false };
		await blocked.app.openCodexMemories("use off");
		assert.match(blocked.notices.join("\n"), /Close the \/btw thread/);
		assert.equal(blocked.rpcCalls.length, 0);
	}

	// A helper teardown can install the shared fence after the menu's config read.
	// Recheck it at mutation execution so the live ACP owner is never stopped when
	// replacement is already forbidden.
	{
		const harness = appHarness();
		harness.app.installFenceAfterMemoryRead = true;
		await harness.app.openCodexMemories("generate on");
		assert.equal(harness.events.includes("stop-acp"), false);
		assert.equal(harness.rpcCalls.length, 1);
		assert.match(harness.errors.join("\n"), /restart cc/i);
	}

	// Import detection is read-only; a separate confirmation owns the mutation and
	// waits for the correlated completion notification before claiming success.
	{
		const harness = appHarness();
		await harness.app.openCodexImport();
		assert.equal(harness.selections.length, 1);
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		assert.equal(harness.selections.length, 2);
		await harness.selections[1].onSelect(harness.selections[1].entries[0]);
		assert.equal(harness.rpcCalls[1].requests[0].method, "externalAgentConfig/import");
		assert.equal(harness.rpcCalls[1].options.waitForNotification.method, "externalAgentConfig/import/completed");
		assert.equal(harness.rpcCalls[1].options.acceptForcedTeardownAfterResponse, true);
		assert.match(harness.notices.join("\n"), /1 succeeded, 0 failed/);
	}

	{
		const harness = appHarness();
		const failure = new Error('api_key = "must-not-print"');
		failure.code = "CODEX_COMPLETION_UNCONFIRMED";
		harness.app.importFailure = failure;
		await harness.app.openCodexImport();
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		await harness.selections[1].onSelect(harness.selections[1].entries[0]);
		assert.match(harness.errors.join("\n"), /accepted.*completion could not be confirmed/i);
		assert.doesNotMatch(harness.errors.join("\n"), /must-not-print|api_key/);
	}

	// Debug config renders only layer metadata and allow-listed requirements.
	{
		const harness = appHarness();
		await harness.app.openCodexDebugConfig();
		const output = harness.notices.join("\n");
		assert.match(output, /Config layer stack/);
		assert.match(output, /allowedSandboxModes: workspace-write/);
		assert.doesNotMatch(output, /never-print-this/);
	}

	for (const command of ["debug", "import"]) {
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async () => {
			throw new Error('invalid config near api_key = "must-not-print"');
		};
		if (command === "debug") await harness.app.openCodexDebugConfig();
		else await harness.app.openCodexImport();
		assert.doesNotMatch(harness.errors.join("\n"), /must-not-print|api_key/);
	}
} finally {
	if (previousForkRegistry === undefined) delete process.env.CC_FORKS;
	else process.env.CC_FORKS = previousForkRegistry;
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("codex parity UI: memories, import, and debug config");
