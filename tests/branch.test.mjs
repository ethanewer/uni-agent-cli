import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessApp, loadForkParents } from "../src/pi-harness.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-branch-"));
const previousForks = process.env.CC_FORKS;
process.env.CC_FORKS = path.join(root, "forks.json");

function appWith(client) {
	const events = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		focusedThread: "main",
		client,
		ready: true,
		busy: false,
		btwThread: undefined,
		sessionSwitchInProgress: false,
		statusState: "",
		configUpdateTokens: new Set(),
		configUpdateCount: 0,
		promptQueue: [],
		deferredLocalSlashCommands: [],
		ui: { requestRender() {} },
		clearConfigUpdates() {},
		updateSpinner() {},
		updateAutocomplete() { events.push("autocomplete"); },
		clearLiveBackendCommands() { events.push("commands:clear"); },
		resetConversationView() { events.push("view:reset"); },
		addCommandMessage(text) { events.push(`command:${text}`); },
		addNotice(text) { events.push(`notice:${text}`); },
		addError(text) { events.push(`error:${text}`); },
		restoreFailedSessionSwitchInput() { events.push("input:restore"); },
		flushDeferredLocalSlashCommands: async () => {},
		schedulePromptQueueDrain() { events.push("queue:drain"); },
	});
	return { app, events };
}

try {
	let forkCalls = 0;
	const client = {
		exited: false,
		sessionId: "parent",
		capabilities: { fork: "native" },
		async fork(parent, options) {
			forkCalls += 1;
			assert.equal(parent, "parent");
			this.sessionId = "child";
			options.beforeReplay();
		},
	};
	const success = appWith(client);
	assert.equal(await success.app.branchCurrentSession(), true);
	assert.equal(forkCalls, 1);
	assert.equal(client.sessionId, "child");
	assert.ok(success.events.indexOf("view:reset") < success.events.indexOf("queue:drain"));
	assert.equal(loadForkParents().get("child"), "parent");

	const named = appWith({ ...client, sessionId: "named-parent" });
	named.app.client.fork = async () => assert.fail("a rejected name must not mutate the session");
	assert.equal(await named.app.branchCurrentSession("feature-name"), false);
	assert.ok(named.events.some((event) => event.includes("does not advertise named branches")));

	let requestedName;
	const namedClient = {
		exited: false,
		sessionId: "named-parent",
		capabilities: { fork: "native", namedFork: true },
		async fork(_parent, options) {
			requestedName = options.name;
			this.sessionId = "named-child";
			options.beforeReplay();
			return { _meta: { cc: { branchNameApplied: true } } };
		},
	};
	const namedSuccess = appWith(namedClient);
	assert.equal(await namedSuccess.app.branchCurrentSession("feature-name"), true);
	assert.equal(requestedName, "feature-name");

	// A lineage-label write happens after the backend has committed the new
	// session. If that metadata store is unavailable, keep the live branch and
	// report a warning instead of claiming the branch failed.
	const validForkRegistry = process.env.CC_FORKS;
	const unreadableForkRegistry = path.join(root, "fork-registry-is-a-directory");
	fs.mkdirSync(unreadableForkRegistry);
	process.env.CC_FORKS = unreadableForkRegistry;
	try {
		const lineageClient = {
			exited: false,
			sessionId: "lineage-parent",
			capabilities: { fork: "native" },
			async fork(_parent, options) {
				this.sessionId = "lineage-child";
				options.beforeReplay();
			},
		};
		const lineage = appWith(lineageClient);
		assert.equal(await lineage.app.branchCurrentSession(), true);
		assert.equal(lineageClient.sessionId, "lineage-child");
		assert.ok(lineage.events.some((event) => event.includes("branch is active")));
		assert.equal(lineage.events.some((event) => event.startsWith("error:")), false);
	} finally {
		process.env.CC_FORKS = validForkRegistry;
	}

	const unsupported = appWith({ exited: false, sessionId: "parent", capabilities: { fork: false } });
	assert.equal(await unsupported.app.branchCurrentSession(), false);
	assert.ok(unsupported.events.some((event) => event.includes("does not advertise session forking")));

	const side = appWith(client);
	const sideEvents = [];
	const sideClient = { sessionId: "side-session", exited: false };
	const sideThread = {
		client: sideClient,
		sessionId: "side-session",
		addCommandMessage: (message) => sideEvents.push(`command:${message}`),
		addNotice: (message) => sideEvents.push(`notice:${message}`),
	};
	side.app.activeAgentGeneration = 0;
	side.app.transport = "acp";
	side.app.config = { agents: { fake: {} } };
	side.app.btwThread = sideThread;
	side.app.onThreadActivity = () => {};
	side.app.focusedThread = "btw";
	assert.equal(await side.app.branchCurrentSession("", { targetThread: sideThread }), false);
	assert.ok(sideEvents.some((event) => event.includes("only from the main session")));
	assert.equal(side.events.some((event) => event.includes("only from the main session")), false);
} finally {
	if (previousForks === undefined) delete process.env.CC_FORKS;
	else process.env.CC_FORKS = previousForks;
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("branch tests passed");
