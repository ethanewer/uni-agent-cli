import assert from "node:assert/strict";

import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { ClaudeAdapter } from "../src/harness/adapters/claude.mjs";
import {
	REMOTE_CONTROL_NAME_MAX_BYTES,
	REMOTE_CONTROL_NAME_MAX_CHARS,
	REMOTE_CONTROL_URL_MAX_BYTES,
	formatRemoteControlResult,
	normalizeClaudeRemoteControlResponse,
	normalizeRemoteControlResponse,
	parseRemoteControlCommand,
	parseRemoteControlParams,
} from "../src/harness/remote-control.mjs";
import { performClaudeRemoteControl } from "../src/harness/claude-acp-bridge.mjs";
import { capabilitiesFromWire, checkAdapterConformance } from "../src/harness/interface.mjs";
import { AcpClient, HarnessApp, localSlashCommands, statusLineText } from "../src/pi-harness.mjs";

assert.deepEqual(parseRemoteControlCommand(""), { enabled: true });
assert.deepEqual(parseRemoteControlCommand("  Pairing session  "), {
	enabled: true,
	name: "Pairing session",
});
assert.deepEqual(parseRemoteControlCommand("OFF"), { enabled: false });
assert.throws(() => parseRemoteControlCommand("--verbose"), /flags are not supported/u);
assert.throws(() => parseRemoteControlCommand("bad\nname"), /safe characters/u);
assert.throws(() => parseRemoteControlCommand("x".repeat(REMOTE_CONTROL_NAME_MAX_CHARS + 1)), /safe characters/u);
assert.throws(() => parseRemoteControlCommand("é".repeat(Math.ceil(REMOTE_CONTROL_NAME_MAX_BYTES / 2) + 1)), /bytes/u);
assert.deepEqual(parseRemoteControlParams({ sessionId: "session", enabled: true, name: "Desk" }), {
	sessionId: "session",
	enabled: true,
	name: "Desk",
});
assert.deepEqual(parseRemoteControlParams({ sessionId: "session", enabled: false }), {
	sessionId: "session",
	enabled: false,
});
assert.throws(() => parseRemoteControlParams({ sessionId: "session", enabled: false, name: "Desk" }), /does not accept/u);
assert.throws(() => parseRemoteControlParams({ sessionId: "session", enabled: "yes" }), /boolean/u);

const sdkResponse = { sessionUrl: "https://claude.ai/code/session-123?source=cc" };
assert.deepEqual(normalizeClaudeRemoteControlResponse(sdkResponse, true), {
	enabled: true,
	status: "available",
	url: "https://claude.ai/code/session-123?source=cc",
});
assert.deepEqual(normalizeClaudeRemoteControlResponse(undefined, false), {
	enabled: false,
	status: "disconnected",
});
assert.deepEqual(normalizeRemoteControlResponse({
	enabled: true,
	status: "available",
	url: "https://claude.ai/code/session-123",
}), {
	enabled: true,
	status: "available",
	url: "https://claude.ai/code/session-123",
});
assert.throws(() => normalizeClaudeRemoteControlResponse({ sessionUrl: "http://claude.ai/code/id" }, true), /untrusted/u);
assert.throws(() => normalizeClaudeRemoteControlResponse({ sessionUrl: "https://evil.example/code/id" }, true), /untrusted/u);
assert.throws(() => normalizeClaudeRemoteControlResponse({ sessionUrl: "https://claude.ai/not-code/id" }, true), /untrusted/u);
assert.throws(() => normalizeClaudeRemoteControlResponse({ sessionUrl: `https://claude.ai/code/${"x".repeat(REMOTE_CONTROL_URL_MAX_BYTES)}` }, true), /invalid/u);
assert.throws(() => normalizeRemoteControlResponse({ enabled: true, status: "connected", url: "https://claude.ai/code/id" }), /status/u);
assert.throws(() => normalizeRemoteControlResponse({ enabled: false, status: "disconnected", url: "https://claude.ai/code/id" }), /while disabled/u);
assert.equal(
	formatRemoteControlResult({ enabled: true, status: "available", url: "https://claude.ai/code/id" }),
	"Remote Control enabled\nhttps://claude.ai/code/id",
);
assert.equal(
	statusLineText({
		agent: "claude",
		transport: "acp",
		permissionMode: "ask",
		remoteControl: { enabled: true, url: "https://claude.ai/code/private" },
	}, "/tmp/project"),
	"claude acp · ⏸ permissions ask · remote on · /tmp/project",
);
assert.equal(
	statusLineText({
		agent: "claude",
		transport: "acp",
		permissionMode: "deny",
		remoteControl: { enabled: true, url: "https://claude.ai/code/private", error: "disconnect failed" },
	}, "/tmp/project"),
	"claude acp · permissions deny · remote error · /tmp/project",
	"the persistent footer reports state without exposing the pairing URL",
);
assert.equal(
	statusLineText({
		agent: "codex",
		transport: "acp",
		model: "gpt-5.6-sol",
		effort: "medium",
		permissionMode: "auto",
	}, "/tmp/project"),
	"codex · gpt-5.6-sol medium · permissions auto · /tmp/project",
	"model-aware harnesses replace the transport label with their live model and effort",
);
assert.equal(
	statusLineText({ agent: "cursor", transport: "acp", model: "composer-2" }, "/tmp/project"),
	"cursor · composer-2 · /tmp/project",
	"a harness may expose a model without a reasoning-effort option",
);
{
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.focusedThread = "main";
	app.config = {
		settings: { agents: { codex: { sessionDefaults: { model: "gpt-saved", effort: "high" } } } },
	};
	app.sessionStates = new Map();
	assert.deepEqual(app.modelAndEffortForStatus(), { model: "gpt-saved", effort: "high" });
}
{
	const app = Object.create(HarnessApp.prototype);
	app.activeKey = "codex";
	app.config = {
		settings: {
			agents: {
				codex: { sessionDefaults: { model: "sol", modelDisplay: "GPT-5.6-Sol", effort: "high" } },
			},
		},
	};
	const persisted = [];
	app.persistModelPreference = (...args) => {
		persisted.push(args);
		app.config.settings.agents.codex.sessionDefaults.model = args[2];
		app.config.settings.agents.codex.sessionDefaults.modelDisplay = args[3].modelDisplay;
		return true;
	};
	const sessionInfo = {
		_ccStartupRequestedModel: "sol",
		configOptions: [{
			id: "model",
			category: "model",
			currentValue: "gpt-5.6-sol",
			options: [{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
		}],
	};
	assert.equal(app.alignPersistedModelDisplay("codex", sessionInfo), true);
	assert.deepEqual(persisted, [["codex", "model", "gpt-5.6-sol", { modelDisplay: "GPT-5.6-Sol" }]]);
	assert.equal(app.alignPersistedModelDisplay("codex", sessionInfo), false, "an aligned label is not rewritten");
}
{
	const app = Object.create(HarnessApp.prototype);
	app.config = {
		settings: { agents: { codex: { sessionDefaults: { model: "sol", modelDisplay: "Sol" } } } },
	};
	const persisted = [];
	app.persistModelPreference = (...args) => {
		persisted.push(args);
		return true;
	};
	assert.equal(app.alignPersistedModelDisplay("codex", {
		_ccStartupRequestedModel: "sol",
		configOptions: [{ id: "model", category: "model", currentValue: "gpt-5.6-sol" }],
	}), true);
	assert.deepEqual(
		persisted,
		[["codex", "model", "gpt-5.6-sol", { modelDisplay: "Sol" }]],
		"canonical ID migration preserves a friendly label when choices are sparse",
	);
	assert.equal(app.alignPersistedModelDisplay("codex", {
		configOptions: [{
			id: "model",
			category: "model",
			currentValue: "gpt-5.1-codex-mini",
			options: [{ value: "gpt-5.1-codex-mini", name: "GPT-5.1-Codex-Mini" }],
		}],
	}), false, "a resumed session cannot migrate the saved default by name similarity");
	assert.equal(app.alignPersistedModelDisplay("codex", {
		_ccStartupRequestedModel: "sol",
		configOptions: [{
			id: "model",
			category: "model",
			currentValue: "gpt-5.6-sol",
			options: [
				{ value: "sol", name: "Sol" },
				{ value: "gpt-5.6-sol", name: "GPT-5.6-Sol" },
			],
		}],
	}), false, "a valid short model ID is not mistaken for a canonical alias");
}
{
	const app = Object.create(HarnessApp.prototype);
	app.config = { settings: { agents: { claude: { sessionDefaults: {} } } } };
	const persisted = [];
	app.persistModelPreference = (key, category, value, options = {}) => {
		persisted.push([key, category, value, options]);
		const defaults = app.config.settings.agents[key].sessionDefaults;
		if (category === "model") {
			defaults.model = value;
			defaults.modelDisplay = options.modelDisplay;
		} else if (category === "thought_level") defaults.effort = value;
		return true;
	};
	assert.equal(app.alignPersistedModelDisplay("claude", {
		_ccCreatedSession: true,
		configOptions: [
			{
				id: "model",
				category: "model",
				currentValue: "claude-fable-5[1m]",
				options: [{ value: "claude-fable-5[1m]", name: "Fable" }],
			},
			{ id: "effort", category: "thought_level", currentValue: "high" },
		],
	}), true);
	assert.deepEqual(persisted, [
		["claude", "model", "claude-fable-5[1m]", { modelDisplay: "Fable" }],
		["claude", "thought_level", "high", {}],
	]);
	assert.deepEqual(app.config.settings.agents.claude.sessionDefaults, {
		model: "claude-fable-5[1m]",
		modelDisplay: "Fable",
		effort: "high",
	});
}
{
	const app = Object.create(HarnessApp.prototype);
	app.config = { settings: { agents: { pi: { sessionDefaults: {} } } } };
	const persisted = [];
	app.persistModelPreference = (...args) => {
		persisted.push(args);
		app.config.settings.agents.pi.sessionDefaults.model = args[2];
		app.config.settings.agents.pi.sessionDefaults.modelDisplay = args[3].modelDisplay;
		return true;
	};
	assert.equal(app.alignPersistedModelDisplay("pi", {
		_ccCreatedSession: true,
		models: {
			currentModelId: "provider/model-id",
			availableModels: [{ modelId: "provider/model-id", name: "Friendly Model" }],
		},
	}), true);
	assert.deepEqual(persisted, [["pi", "model", "provider/model-id", { modelDisplay: "Friendly Model" }]]);
}
{
	const app = Object.create(HarnessApp.prototype);
	app.config = { settings: { agents: { claude: { sessionDefaults: {} } } } };
	let attempts = 0;
	const notices = [];
	app.persistModelPreference = () => {
		attempts += 1;
		throw new Error("read only");
	};
	app.addNotice = (message) => notices.push(message);
	const state = {
		_ccCreatedSession: true,
		configOptions: [
			{ id: "model", category: "model", currentValue: "fable", options: [{ value: "fable", name: "Fable" }] },
			{ id: "effort", category: "thought_level", currentValue: "high" },
		],
	};
	app.alignPersistedModelDisplay("claude", state);
	app.alignPersistedModelDisplay("claude", state);
	assert.equal(attempts, 2, "failed model and effort captures are each attempted only once");
	assert.equal(notices.length, 2);
}

const remoteCalls = [];
const liveSession = {
	queryClosed: false,
	query: {
		async enableRemoteControl(enabled, name) {
			remoteCalls.push([enabled, name]);
			return enabled ? sdkResponse : undefined;
		},
	},
};
const bridgeAgent = { sessions: { session: liveSession } };
assert.deepEqual(await performClaudeRemoteControl(bridgeAgent, {
	sessionId: "session",
	enabled: true,
	name: "Desk",
}), {
	enabled: true,
	status: "available",
	url: "https://claude.ai/code/session-123?source=cc",
});
assert.deepEqual(await performClaudeRemoteControl(bridgeAgent, {
	sessionId: "session",
	enabled: false,
}), { enabled: false, status: "disconnected" });
assert.deepEqual(remoteCalls, [[true, "Desk"], [false, undefined]]);
liveSession.queryClosed = true;
await assert.rejects(() => performClaudeRemoteControl(bridgeAgent, {
	sessionId: "session",
	enabled: true,
}), /session has ended/u);
liveSession.queryClosed = false;

const wire = { capabilities: { _meta: { cc: { remoteControl: true } } } };
assert.equal(capabilitiesFromWire(wire).remoteControl, true);
assert.equal(capabilitiesFromWire({ capabilities: {} }).remoteControl, false);

const transport = Object.create(AcpClient.prototype);
Object.assign(transport, {
	sessionId: "transport-session",
	capabilities: wire.capabilities,
	agentInfo: {},
	authMethods: [],
	configOptions: [],
	models: undefined,
	modes: undefined,
	sessionInfo: {},
});
let transportRequest;
transport.request = async (method, params) => {
	transportRequest = [method, params];
	return { enabled: true, status: "available", url: "https://claude.ai/code/transport" };
};
assert.deepEqual(await transport.setRemoteControl({ enabled: true, name: "Desk" }), {
	enabled: true,
	status: "available",
	url: "https://claude.ai/code/transport",
});
assert.deepEqual(transportRequest, [
	"cc/session/remote_control",
	{ sessionId: "transport-session", enabled: true, name: "Desk" },
]);

const adapterCalls = [];
const fakeConnection = {
	sessionId: "adapter-session",
	capabilities: wire.capabilities,
	async initialize() {},
	async prompt() {},
	cancel() {},
	stop() {},
	getSessionInfo() { return wire; },
	async setRemoteControl(options) {
		adapterCalls.push(options);
		return { enabled: false, status: "disconnected" };
	},
};
const adapter = new BaseAcpAdapter("fake", { label: "Fake", acp: { command: "fake" } }, {}, {
	connectionFactory: () => fakeConnection,
});
await adapter.connect({ createSession: false });
assert.equal(adapter.capabilities.remoteControl, true);
assert.equal(checkAdapterConformance(adapter).ok, true);
assert.deepEqual(await adapter.setRemoteControl({ enabled: false }), { enabled: false, status: "disconnected" });
assert.deepEqual(adapterCalls, [{ enabled: false }]);
await adapter.stopAndWait();

const declaredClaude = new ClaudeAdapter("claude", ClaudeAdapter.defaultAgentConfig, {}, {
	connectionFactory: () => fakeConnection,
});
assert.equal(declaredClaude.capabilities.remoteControl, true);
const customClaude = new ClaudeAdapter("claude", {
	...ClaudeAdapter.defaultAgentConfig,
	acp: { command: "/custom/claude-acp", args: [] },
}, {}, { connectionFactory: () => fakeConnection });
assert.equal(customClaude.capabilities.remoteControl, false);

function routeApp(capabilities = {}, backendNames = []) {
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		client: { capabilities },
		config: { agents: { fake: { label: "Fake" } } },
		sessionStates: new Map([["fake", { capabilities }]]),
		availableCommands: new Map([["fake", backendNames.map((name) => ({ name }))]]),
		commandsLoaded: new Set(["fake"]),
		themeName: "system",
		focusedThread: "main",
		isCodexBackendActive: () => false,
	});
	return app;
}
for (const capabilities of [{ remoteControl: true }, {}]) {
	const app = routeApp(capabilities, ["remote-control", "rc"]);
	const names = localSlashCommands(app).map((entry) => entry.name);
	assert.ok(names.includes("remote-control"));
	assert.ok(names.includes("rc"));
	assert.equal(app.slashCommandRoute("remote-control"), "local");
	assert.equal(app.slashCommandRoute("rc"), "local");
}

function operationalApp(client) {
	const events = [];
	const agent = { label: "Fake" };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "fake",
		transport: "acp",
		activeAgentGeneration: 0,
		client,
		config: { agents: { fake: agent } },
		sessionStates: new Map(),
		remoteControlStatesByClient: new WeakMap(),
		runtimePermissionMode: new Map(),
		runtimePermissionModeSource: new Map(),
		runtimePermissionModeByClient: new WeakMap(),
		ready: true,
		busy: false,
		focusedThread: "main",
		btwThread: undefined,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		configUpdateTokens: new Set(),
		deferredLocalSlashCommands: [],
		selectionActions: new Set(),
		menuHandle: undefined,
		statusState: "",
		ui: { requestRender() {} },
		updateSpinner() {},
		schedulePromptQueueDrain() {},
		addCommandMessage(text) { events.push(["command", text]); },
		addNotice(text) { events.push(["notice", text]); },
		addError(text) { events.push(["error", text]); },
	});
	return { app, events };
}

const workingClient = {
	sessionId: "main-session",
	exited: false,
	capabilities: { remoteControl: true },
	async setRemoteControl(options) {
		assert.deepEqual(options, { enabled: true, name: "Desk" });
		return { enabled: true, status: "available", url: "https://claude.ai/code/main" };
	},
};
const working = operationalApp(workingClient);
assert.equal(working.app.permissionModeForStatus(), "ask");
working.app.runtimePermissionMode.set("fake", "auto");
assert.equal(working.app.permissionModeForStatus(), "auto", "footer mode uses the unified resolved policy");
working.app.runtimePermissionMode.delete("fake");
assert.equal(await working.app.runRemoteControlCommand("Desk"), true);
assert.ok(working.events.some(([kind, text]) => kind === "notice" && text.includes("https://claude.ai/code/main")));
assert.equal(working.app.configUpdateCount, 0);
assert.deepEqual(working.app.remoteControlStateForActiveSession(), {
	enabled: true,
	url: "https://claude.ai/code/main",
});
working.app.showStatus();
assert.ok(working.events.some(([kind, text]) =>
	kind === "notice" && text.includes("permissions ask") && text.includes("remote https://claude.ai/code/main")));

// State is owned by both the adapter object and session id. A new/resumed
// session cannot display the previous pairing URL, and a replacement adapter
// cannot inherit it even if a backend happens to reuse the same id.
workingClient.sessionId = "other-session";
assert.equal(working.app.remoteControlStateForActiveSession(), undefined);
workingClient.sessionId = "main-session";
assert.equal(working.app.remoteControlStateForActiveSession()?.url, "https://claude.ai/code/main");
workingClient.exited = true;
assert.equal(working.app.remoteControlStateForActiveSession(), undefined, "a dead adapter cannot advertise an old pairing URL");
workingClient.exited = false;
assert.equal(working.app.remoteControlStateForActiveSession(), undefined, "dead-adapter state is discarded, not resurrected");
// Restore one enabled state for the remaining failure-path assertions.
working.app.recordRemoteControlState(working.app.captureSessionCommandTarget(), {
	enabled: true,
	url: "https://claude.ai/code/main",
});
working.app.client = { ...workingClient };
assert.equal(working.app.remoteControlStateForActiveSession(), undefined);
working.app.client = workingClient;

working.app.focusedThread = "btw";
assert.equal(working.app.remoteControlStateForActiveSession(), undefined, "the /btw footer cannot inherit main pairing state");
working.app.focusedThread = "main";

workingClient.setRemoteControl = async () => {
	throw new Error("disconnect failed");
};
assert.equal(await working.app.runRemoteControlCommand("off"), false);
assert.deepEqual(working.app.remoteControlStateForActiveSession(), {
	enabled: true,
	url: "https://claude.ai/code/main",
	error: "disconnect failed",
});
workingClient.setRemoteControl = async (options) => {
	assert.deepEqual(options, { enabled: false });
	return { enabled: false, status: "disconnected" };
};
assert.equal(await working.app.runRemoteControlCommand("off"), true);
assert.deepEqual(
	working.app.remoteControlStateForActiveSession(),
	{ enabled: false },
	"a confirmed disconnect removes both the old URL and error",
);

let busyCalled = false;
const busy = operationalApp({
	...workingClient,
	async setRemoteControl() { busyCalled = true; },
});
busy.app.busy = true;
assert.equal(await busy.app.runRemoteControlCommand(""), false);
assert.equal(busyCalled, false);
assert.ok(busy.events.some(([kind, text]) => kind === "notice" && /idle/u.test(text)));

const racingClient = {
	...workingClient,
	async setRemoteControl() {
		this.sessionId = "replacement-session";
		return { enabled: true, status: "available", url: "https://claude.ai/code/stale" };
	},
};
const racing = operationalApp(racingClient);
assert.equal(await racing.app.runRemoteControlCommand(""), false);
assert.equal(racing.events.some(([, text]) => text.includes("https://claude.ai/code/stale")), false);
assert.equal(racing.app.remoteControlStateForActiveSession(), undefined);
assert.equal(racing.app.configUpdateCount, 0);
assert.equal(racing.app.statusState, "");

console.log("remote control tests passed");
