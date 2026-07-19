// Verification suite for the unified HarnessAdapter prototype (src/harness/).
//
// Proves the three guarantees the prototype must satisfy:
//   (1) SINGLE INTERFACE — every harness, current and new, conforms to one
//       interface; cc can drive them all uniformly.
//   (2) NO FEATURES LOST — every per-harness behavior in pi-harness.mjs is
//       reachable through the interface, the capability gating matches the
//       audited reality, the native-settings translation is byte-identical to
//       the production applyHarnessSettings, and the base adapter works over the
//       real ACP transport (spawning tests/fake_acp.py).
//   (3) ADDABILITY — opencode and pi (and a brand-new harness) are added with a
//       thin adapter + one registry line, no interface/base/cc changes.
//
// Run: node tests/harness_adapter.test.mjs

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AcpClient,
	acquireCodexLiveSessionLease,
	acquireForkOperationLock,
	applyHarnessSettings,
	codexHome,
	collectEnvironmentAuthenticationVariables,
	codexLiveSessionLeaseIsActive,
	copyCodexRolloutWithNewId,
	findCodexRolloutPath,
	forgetForkIds,
	loadForkParents,
	readCodexThreadState,
	recordForkId,
} from "../src/pi-harness.mjs";
import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import {
	assertAdapterConformance,
	capabilitiesFromWire,
	checkAdapterConformance,
	emptyCapabilities,
	REQUIRED_METHODS,
} from "../src/harness/interface.mjs";
import { ADAPTER_REGISTRY, createAdapter, registerAdapter } from "../src/harness/registry.mjs";
import { armUnsend, canUnsend, dispatchSlashCommand, openSideThread } from "../src/harness/host-example.mjs";

let passed = 0;
function ok(label) {
	passed += 1;
	void label;
}

// ---- a fake in-process ACP connection (no child process) ------------------

class FakeConnection {
	constructor(agent, onEvent, options, profile) {
		this.agent = agent;
		this.onEvent = onEvent;
		this.options = options ?? {};
		this.profile = profile ?? {};
		this.capabilities = {};
		this.agentInfo = {};
		this.authMethods = [];
		this.sessionId = undefined;
		this.configOptions = [];
		this.models = undefined;
		this.modes = undefined;
		this.calls = [];
	}
	async initialize(options = {}) {
		const command = this.agent.acp ?? this.agent;
		this.launchInvocation = {
			executable: command.command,
			prefixArgs: [],
			commandArgs: [...(command.args ?? [])],
		};
		this.capabilities = this.profile.capabilities ?? {};
		this.agentInfo = this.profile.agentInfo ?? {};
		this.authMethods = this.profile.authMethods ?? [];
		if (options.createSession !== false) await this.newSession();
		return { agentCapabilities: this.capabilities, agentInfo: this.agentInfo, authMethods: this.authMethods };
	}
	async newSession() {
		this.sessionId = typeof this.profile.sessionId === "function"
			? this.profile.sessionId()
			: this.profile.sessionId ?? "fake-session";
		this.configOptions = this.profile.configOptions ?? [];
		this.models = this.profile.models;
		this.modes = this.profile.modes;
		this.onEvent?.({ type: "session_info", sessionInfo: this.getSessionInfo() });
		return { sessionId: this.sessionId, configOptions: this.configOptions, modes: this.modes };
	}
	async prompt(parts) {
		this.calls.push(["prompt", parts]);
		this.onEvent?.({ type: "text", text: "ok" });
		return { stopReason: "end_turn" };
	}
	cancel() {
		this.calls.push(["cancel"]);
	}
	stop() {
		this.calls.push(["stop"]);
	}
	async listSessions() {
		this.calls.push(["listSessions"]);
		return this.profile.sessions ?? [];
	}
	async loadSession(id, options = {}) {
		this.calls.push(["loadSession", id]);
		this.lastLoadOptions = options;
		this.sessionId = id;
		this.onEvent?.({ type: "session_info", sessionInfo: this.getSessionInfo() });
		return {};
	}
	async deleteSession(id) {
		this.calls.push(["deleteSession", id]);
		return {};
	}
	async forkSession(parentId) {
		this.calls.push(["forkSession", parentId]);
		this.sessionId = "native-fork";
		return { sessionId: this.sessionId };
	}
	supportsFork() {
		return Boolean(this.capabilities?.sessionCapabilities?.fork);
	}
	async setConfigOption(id, value) {
		this.calls.push(["setConfigOption", id, value]);
		return {};
	}
	async setMode(id) {
		this.calls.push(["setMode", id]);
		return {};
	}
	async authenticate(methodId, meta = undefined) {
		this.calls.push(["authenticate", methodId, meta]);
		return {};
	}
	async logout() {
		this.calls.push(["logout"]);
		return {};
	}
	getSessionInfo() {
		return {
			sessionId: this.sessionId,
			capabilities: this.capabilities,
			agentInfo: this.agentInfo,
			authMethods: this.authMethods,
			configOptions: this.configOptions,
			models: this.models,
			modes: this.modes,
		};
	}
	// test helpers: simulate backend-initiated requests
	emitPermission(params) {
		return this.options.onPermissionRequest?.(params);
	}
	emitCursor(method, params) {
		return this.options.onCursorRequest?.(method, params);
	}
	emitElicitation(params) {
		return this.options.onElicitationRequest?.(params);
	}
}

function factoryFor(profile) {
	return (agent, onEvent, options) => new FakeConnection(agent, onEvent, options, profile);
}

// Simulated wire capabilities per harness (mirrors the audit's findings).
const PROFILES = {
	codex: {
		agentInfo: { name: "@agentclientprotocol/codex-acp", version: "1.1.4" },
		sessionId: () => randomUUID(),
		capabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {}, delete: {} }, promptCapabilities: { image: false } },
		configOptions: [{ id: "model", category: "model" }, { id: "mode", category: "mode" }, { id: "thought_level", category: "thought_level" }],
		modes: { currentModeId: "agent", availableModes: [{ id: "agent" }] },
	},
	claude: {
		agentInfo: { name: "claude-agent-acp" },
		capabilities: { loadSession: true, sessionCapabilities: { list: {}, fork: {} }, promptCapabilities: { image: true } },
		configOptions: [],
		modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] },
	},
	cursor: {
		agentInfo: { name: "cursor-agent" },
		capabilities: { sessionCapabilities: {}, promptCapabilities: { image: true } },
		configOptions: [{ id: "model", category: "model" }, { id: "mode", category: "mode" }],
		modes: { currentModeId: "agent", availableModes: [{ id: "agent" }, { id: "plan" }, { id: "ask" }] },
	},
	"terminus-2": {
		agentInfo: { name: "terminus-2" },
		capabilities: { promptCapabilities: { image: false } },
		configOptions: [],
		modes: { availableModes: [{ id: "agent" }] },
	},
	"mini-swe-agent": {
		agentInfo: { name: "mini" },
		capabilities: {},
		configOptions: [],
	},
	opencode: {
		agentInfo: { name: "OpenCode", version: "1.18.3" },
		capabilities: {
			loadSession: true,
			sessionCapabilities: { list: {}, resume: {}, fork: {} },
			promptCapabilities: { image: true },
			mcpCapabilities: { http: true },
		},
		configOptions: [{ id: "model", category: "model" }, { id: "mode", category: "mode" }],
		modes: { availableModes: [{ id: "build" }, { id: "plan" }] },
	},
	pi: {
		// pi-acp exposes thinking levels (off/minimal/.../xhigh) as session modes per
		// research, so /mode binds and /effort stays dark. The PiAdapter is fully
		// wire-derived: if pi-acp instead advertised a `thought_level` configOption,
		// reasoningEffort would light up automatically with no adapter change.
		agentInfo: { name: "pi-acp", version: "0.0.31" },
		capabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, promptCapabilities: { image: true } },
		configOptions: [{ id: "model", category: "model" }, { id: "mode", category: "mode" }],
		modes: { availableModes: [{ id: "off" }, { id: "high" }] },
	},
};

const CONFIGS = {
	claude: { label: "Claude Code", transport: "acp", acp: { command: "claude-agent-acp", args: [] } },
	codex: { label: "Codex", transport: "acp", acp: { command: "codex-acp", args: [] } },
	cursor: { label: "Cursor Agent", transport: "acp", acp: { command: "cursor-agent", args: ["acp"] } },
	"terminus-2": { label: "Terminus-2", transport: "acp", acp: { command: "python3", args: ["bridge.py"] } },
	"mini-swe-agent": { label: "mini-swe-agent", transport: "acp", acp: { command: "python3", args: ["bridge.py"] } },
};

function codexConfig(agent) {
	return JSON.parse(agent.env?.CODEX_CONFIG ?? "{}");
}

const noopHost = () => ({ onEvent() {}, requestPermission: () => ({ outcome: "cancelled" }), requestInteraction: () => undefined });

const codexServices = {
	acquireLiveSessionLease: acquireCodexLiveSessionLease,
	acquireForkOperationLock,
	codexHome,
	copyCodexRolloutWithNewId,
	findCodexRolloutPath,
	forgetForkIds,
	liveSessionLeaseIsActive: codexLiveSessionLeaseIsActive,
	readCodexThreadState,
	recordForkId,
};

async function main() {
	{
		const original = process.env.CODEX_CONFIG;
		process.env.CODEX_CONFIG = JSON.stringify({ model: "ambient-model", approval_policy: "never" });
		try {
			const codex = createAdapter("codex", CONFIGS.codex, noopHost(), {
				settings: { config: { reasoning_effort: "high" }, permissions: { mode: "ask" } },
				connectionFactory: factoryFor(PROFILES.codex),
			});
			assert.deepEqual(codexConfig(codex.launchSpec), { model: "ambient-model", reasoning_effort: "high" });
		} finally {
			if (original === undefined) delete process.env.CODEX_CONFIG;
			else process.env.CODEX_CONFIG = original;
		}
		ok("codex-config:ambient-merge-and-permission-neutralization");
	}
	{
		const safeDefault = applyHarnessSettings({
			agents: { codex: { command: "codex", acp: { command: "codex-acp", args: [] } } },
		}, {});
		assert.equal(
			Object.prototype.hasOwnProperty.call(safeDefault.agents.codex.env ?? {}, "CODEX_PATH"),
			false,
			"a PATH codex is never selected without an explicit override",
		);
		const explicit = applyHarnessSettings({
			agents: { codex: { command: "codex", acp: { command: "codex-acp", args: [] } } },
		}, { agents: { codex: { env: { CODEX_PATH: "/known-compatible/codex" } } } });
		assert.equal(explicit.agents.codex.env.CODEX_PATH, "/known-compatible/codex");
		ok("codex-path:bundled-default-explicit-override");
	}
	// =====================================================================
	// (1) SINGLE INTERFACE — every adapter conforms to the one contract.
	// =====================================================================
	for (const key of Object.keys(ADAPTER_REGISTRY)) {
		const adapter = createAdapter(key, CONFIGS[key], noopHost(), { connectionFactory: factoryFor(PROFILES[key]) });
		assertAdapterConformance(adapter);
		for (const method of REQUIRED_METHODS) {
			assert.equal(typeof adapter[method], "function", `${key}.${method} must exist`);
		}
		assert.equal(adapter.key, key);
		ok(`conformance:${key}`);
	}
	// cc can treat any adapter uniformly: identical required surface.
	{
		const surfaces = Object.keys(ADAPTER_REGISTRY).map((key) => {
			const adapter = createAdapter(key, CONFIGS[key], noopHost(), { connectionFactory: factoryFor(PROFILES[key]) });
			return REQUIRED_METHODS.filter((m) => typeof adapter[m] === "function").sort().join(",");
		});
		assert.equal(new Set(surfaces).size, 1, "all adapters expose the identical required interface");
		ok("single-interface:uniform-surface");
	}
	// conformance must reject an invalid fork value (true is not false|native|copy).
	{
		const required = {};
		for (const m of REQUIRED_METHODS) required[m] = () => {};
		const bogus = { key: "bogus", label: "Bogus", capabilities: { ...emptyCapabilities(), fork: true }, fork: () => {}, ...required };
		const report = checkAdapterConformance(bogus);
		assert.equal(report.ok, false);
		assert.ok(report.problems.some((p) => p.toLowerCase().includes("fork")), "fork:true must be rejected");
		const good = { key: "good", label: "Good", capabilities: { ...emptyCapabilities(), fork: "native" }, fork: () => {}, ...required };
		assert.equal(checkAdapterConformance(good).ok, true);
		ok("conformance:fork-value-validated");
	}
	// A deletion capability must have a matching optional method.
	{
		const required = {};
		for (const m of REQUIRED_METHODS) required[m] = () => {};
		const missing = { key: "missing-delete", label: "Missing delete", capabilities: { ...emptyCapabilities(), delete: true }, ...required };
		const report = checkAdapterConformance(missing);
		assert.equal(report.ok, false);
		assert.ok(report.problems.some((problem) => problem.includes("deleteSession")));
		const complete = { ...missing, deleteSession: () => {} };
		assert.equal(checkAdapterConformance(complete).ok, true);
		ok("conformance:delete-method-required");
	}
	// Config-option and legacy-mode capabilities use distinct adapter methods.
	// The TUI calls setConfigOption() for model/reasoning selectors and setMode()
	// for the legacy ACP modes surface, so one method cannot stand in for both.
	{
		const required = {};
		for (const method of REQUIRED_METHODS) required[method] = () => {};
		const configOnly = {
			key: "config-only",
			label: "Config only",
			capabilities: { ...emptyCapabilities(), models: true, reasoningEffort: true },
			setConfigOption: () => {},
			...required,
		};
		assert.equal(checkAdapterConformance(configOnly).ok, true);
		const missingConfig = { ...configOnly, setConfigOption: undefined };
		assert.ok(
			checkAdapterConformance(missingConfig).problems.some((problem) => problem.includes("setConfigOption")),
		);

		const modeWithWrongMethod = {
			key: "mode-with-wrong-method",
			label: "Mode with wrong method",
			capabilities: { ...emptyCapabilities(), modes: true },
			setConfigOption: () => {},
			...required,
		};
		const modeReport = checkAdapterConformance(modeWithWrongMethod);
		assert.equal(modeReport.ok, false);
		assert.ok(modeReport.problems.some((problem) => problem.includes("setMode")));
		assert.equal(checkAdapterConformance({ ...modeWithWrongMethod, setMode: () => {} }).ok, true);
		ok("conformance:config-and-mode-methods-required-separately");
	}
	// Authentication methods and logout are independently capability-gated.
	{
		const required = {};
		for (const method of REQUIRED_METHODS) required[method] = () => {};
		const authMissing = { key: "missing-auth", label: "Missing auth", capabilities: { ...emptyCapabilities(), auth: true }, ...required };
		assert.ok(checkAdapterConformance(authMissing).problems.some((problem) => problem.includes("authenticate")));
		const logoutMissing = { key: "missing-logout", label: "Missing logout", capabilities: { ...emptyCapabilities(), logout: true }, ...required };
		assert.ok(checkAdapterConformance(logoutMissing).problems.some((problem) => problem.includes("logout")));
		assert.equal(checkAdapterConformance({ ...authMissing, authenticate: () => {} }).ok, true);
		assert.equal(checkAdapterConformance({ ...logoutMissing, logout: () => {} }).ok, true);
		ok("conformance:authentication-methods-required");
	}
	// The runtime-facing lifecycle/state surface remains adapter-owned. Session
	// transition callbacks must cross the adapter rather than leaking AcpClient.
	{
		const profile = {
			...PROFILES.claude,
			authMethods: [{ id: "browser", name: "Browser" }],
		};
		const adapter = createAdapter("claude", CONFIGS.claude, noopHost(), {
			settings: { permissions: { mode: "ask" } },
			connectionFactory: factoryFor(profile),
		});
		await adapter.connect();
		assert.equal(adapter.exited, false);
		assert.equal(adapter.stopping, false);
		assert.deepEqual(adapter.agentInfo, profile.agentInfo);
		assert.deepEqual(adapter.authMethods, profile.authMethods);
		assert.deepEqual(adapter.configOptions, profile.configOptions);
		assert.deepEqual(adapter.models, profile.models);
		assert.deepEqual(adapter.modes, profile.modes);
		const beforeReplay = () => {};
		await adapter.loadSession("resumed", { beforeReplay });
		assert.equal(adapter.connection.lastLoadOptions.beforeReplay, beforeReplay);
		adapter.connection.forceResolvePrompt = () => "settled";
		assert.equal(adapter.forceResolvePrompt(), "settled");
		adapter.setRuntimePermissionMode("deny");
		assert.equal(adapter.permissionPolicy().mode, "deny");
		adapter.setRuntimePermissionMode();
		assert.equal(adapter.permissionPolicy().mode, "ask");
		await adapter.stopAndWait();
		assert.equal(adapter.exited, true);
		assert.equal(adapter.stopping, true);
		ok("adapter-runtime:lifecycle-state-and-session-options");
	}
	{
		const adapter = createAdapter("claude", CONFIGS.claude, noopHost());
		await assert.rejects(() => adapter.connect(), /requires an ACP connectionFactory/u);
		await adapter.stopAndWait();
		ok("adapter-runtime:transport-injection-required");
	}

	// =====================================================================
	// (2a) NO FEATURES LOST — capability gating matches the audit.
	// =====================================================================
	assert.equal(
		capabilitiesFromWire({ capabilities: { mcpCapabilities: { http: false, sse: false, acp: false } } }).mcp,
		true,
		"an all-false optional-transport descriptor still supports baseline stdio MCP",
	);
	assert.equal(
		capabilitiesFromWire({ capabilities: {} }).mcp,
		true,
		"omitting the optional-transport descriptor still supports baseline stdio MCP",
	);
	ok("capabilities:mcp-stdio-baseline");
	{
		const wire = capabilitiesFromWire({
			capabilities: { auth: { logout: {} } },
			authMethods: [{ id: "browser", name: "Browser" }],
		});
		assert.equal(wire.auth, true);
		assert.equal(wire.logout, true);
		assert.equal(capabilitiesFromWire({ capabilities: { auth: {} }, authMethods: [] }).logout, false);
		ok("capabilities:auth-and-logout-negotiated-separately");
	}
	{
		const adapter = new BaseAcpAdapter("auth", { label: "Auth", acp: { command: "auth-agent" } }, noopHost(), {
			connectionFactory: factoryFor({
				capabilities: { auth: { logout: {} } },
				authMethods: [{ id: "browser", name: "Browser" }],
			}),
		});
		await adapter.connect();
		assert.equal(adapter.capabilities.auth, true);
		assert.equal(adapter.capabilities.logout, true);
		await adapter.authenticate("browser", { test: true });
		const authenticatedConnection = adapter.connection;
		await adapter.logout();
		assert.deepEqual(authenticatedConnection.calls, [
			["authenticate", "browser", { test: true }],
			["logout"],
			["stop"],
		]);
		assert.notEqual(adapter.connection, authenticatedConnection, "logout retires the ACP process even without environment credentials");
		assert.equal(adapter.connection.sessionId, undefined, "the signed-out replacement starts without a session");
		ok("base-adapter:authentication-forwarding");
	}
	{
		const connections = [];
		const apiKeyMethod = { id: "api-key", name: "API Key" };
		const adapter = new BaseAcpAdapter(
			"codex",
			{
				label: "Codex API auth",
				env: { CODEX_API_KEY: "configured-key" },
				acp: { command: "auth-agent" },
			},
			noopHost(),
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, {
						capabilities: { auth: { logout: {} } },
						agentInfo: { name: "@agentclientprotocol/codex-acp" },
						authMethods: [apiKeyMethod],
					});
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await adapter.logout();
		assert.equal(connections.length, 2, "configured API credentials force a credential-free replacement");
		assert.deepEqual(
			new Set(adapter.launchSpec._signedOutAuthEnvNames),
			new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]),
		);
		await adapter.authenticate("api-key");
		assert.deepEqual(connections[1].calls[0], [
			"authenticate",
			"api-key",
			{ "api-key": { apiKey: "configured-key" } },
		]);
		assert.equal(Object.hasOwn(adapter.launchSpec, "_signedOutAuthEnvNames"), false);
		ok("base-adapter:logout-mask-allows-explicit-api-key-login");
	}
	{
		const connections = [];
		const apiKeyMethod = { id: "api-key", name: "API Key" };
		let markAuthenticationStarted;
		let releaseAuthentication;
		const authenticationStarted = new Promise((resolve) => { markAuthenticationStarted = resolve; });
		const authenticationGate = new Promise((resolve) => { releaseAuthentication = resolve; });
		const adapter = new BaseAcpAdapter(
			"codex",
			{
				label: "Stale API auth",
				env: { CODEX_API_KEY: "configured-key" },
				acp: { command: "auth-agent" },
			},
			noopHost(),
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, {
						capabilities: { auth: { logout: {} } },
						agentInfo: { name: "@agentclientprotocol/codex-acp" },
						authMethods: [apiKeyMethod],
					});
					if (connections.length === 1) {
						connection.authenticate = async function authenticate(methodId, meta = undefined) {
							this.calls.push(["authenticate", methodId, meta]);
							markAuthenticationStarted();
							await authenticationGate;
							return { authenticated: true };
						};
					}
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await adapter.logout();
		assert.equal(connections.length, 2);
		const staleConnection = connections[1];
		const authentication = adapter.authenticate("api-key");
		await authenticationStarted;
		await adapter.logout();
		assert.equal(connections.length, 3, "the racing logout installs a signed-out replacement");
		const signedOutReplacement = connections[2];
		assert.equal(adapter.connection, signedOutReplacement);
		assert.deepEqual(
			new Set(adapter.launchSpec._signedOutAuthEnvNames),
			new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]),
		);
		releaseAuthentication();
		await assert.rejects(authentication, (error) => error?.code === "ACP_CONNECTION_REPLACED");
		assert.equal(adapter.connection, signedOutReplacement, "stale authentication cannot replace the live connection");
		assert.deepEqual(
			new Set(adapter.launchSpec._signedOutAuthEnvNames),
			new Set(["CODEX_API_KEY", "OPENAI_API_KEY"]),
			"stale authentication cannot lift the replacement's logout mask",
		);
		assert.equal(staleConnection.calls.some(([name]) => name === "newSession"), false);
		ok("base-adapter:stale-agent-authentication-cannot-undo-racing-logout");
	}
	{
		const adapter = new BaseAcpAdapter(
			"other",
			{ env: { OPENAI_API_KEY: "must-not-leak" }, acp: { command: "other-agent" } },
			noopHost(),
			{ connectionFactory: factoryFor({ authMethods: [{ id: "api-key", name: "Unrelated API key" }] }) },
		);
		await adapter.connect();
		await adapter.authenticate("api-key");
		assert.deepEqual(adapter.connection.calls[0], ["authenticate", "api-key", undefined]);
		ok("base-adapter:api-key-meta-is-codex-only");
	}
	{
		const authMethod = { id: "browser", name: "Browser" };
		let authenticated = false;
		let connection;
		const adapter = new BaseAcpAdapter(
			"auth-session-recovery",
			{ label: "Auth session recovery", acp: { command: "auth-agent" } },
			noopHost(),
			{
				connectionFactory(agent, onEvent, options) {
					connection = new FakeConnection(agent, onEvent, options, { authMethods: [authMethod] });
					connection.newSession = async function newSession() {
						this.calls.push(["newSession"]);
						if (!authenticated) throw new Error("authentication required");
						this.sessionId = "authenticated-session";
						return { sessionId: this.sessionId };
					};
					connection.authenticate = async function authenticate(methodId, meta = undefined) {
						this.calls.push(["authenticate", methodId, meta]);
						authenticated = true;
						return { authenticated: true };
					};
					return connection;
				},
			},
		);
		await assert.rejects(() => adapter.connect(), /authentication required/);
		assert.equal(adapter.sessionId, undefined);
		assert.equal(adapter.capabilities.auth, true, "failed initial session creation still exposes authentication");
		assert.deepEqual(await adapter.authenticate("browser", { source: "test" }), { authenticated: true });
		assert.equal(adapter.sessionId, "authenticated-session", "successful authentication creates the missing session");
		await adapter.prompt([{ type: "text", text: "ready" }]);
		assert.deepEqual(connection.calls, [
			["newSession"],
			["authenticate", "browser", { source: "test" }],
			["newSession"],
			["prompt", [{ type: "text", text: "ready" }]],
		]);
		ok("base-adapter:agent-authentication-recovers-missing-initial-session");
	}
	{
		let markTreeStopStarted;
		let releaseTreeStop;
		const treeStopStarted = new Promise((resolve) => { markTreeStopStarted = resolve; });
		const treeStopGate = new Promise((resolve) => { releaseTreeStop = resolve; });
		let connection;
		const adapter = new BaseAcpAdapter(
			"awaitable-stop",
			{ label: "Awaitable stop", acp: { command: "agent" } },
			noopHost(),
			{
				connectionFactory(agent, onEvent, options) {
					connection = new FakeConnection(agent, onEvent, options, {});
					connection.stopAndWait = async function stopAndWait() {
						this.calls.push(["stopAndWait:start"]);
						markTreeStopStarted();
						await treeStopGate;
						this.calls.push(["stopAndWait:end"]);
					};
					return connection;
				},
			},
		);
		await adapter.connect();
		let stopSettled = false;
		const stopped = adapter.stop().then(() => { stopSettled = true; });
		await treeStopStarted;
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(stopSettled, false, "adapter stop waits for the complete ACP process tree");
		assert.deepEqual(connection.calls, [["stopAndWait:start"]]);
		releaseTreeStop();
		await stopped;
		assert.deepEqual(connection.calls, [["stopAndWait:start"], ["stopAndWait:end"]]);
		ok("base-adapter:stop-awaits-production-process-tree");
	}
	{
		const terminalMethod = {
			type: "terminal",
			id: "terminal-login",
			name: "Terminal login",
			args: ["--login"],
		};
		const connections = [];
		const terminalCalls = [];
		const spawnedAuthenticationEnvironments = [];
		const events = [];
		let staleHostCalls = 0;
		const adapter = new BaseAcpAdapter(
			"auth",
			{
				label: "Auth",
				acp: { command: "auth-agent", args: ["acp"] },
				_sessionAuthEnv: { SERVICE_TOKEN: "stale-session-token" },
			},
			{
				...noopHost(),
				onEvent: (event) => events.push(event),
				requestPermission: () => {
					staleHostCalls += 1;
					return { outcome: "cancelled" };
				},
				requestInteraction: () => {
					staleHostCalls += 1;
					return undefined;
				},
				onElicitationRequest: () => {
					staleHostCalls += 1;
					return { action: "accept" };
				},
				runTerminalAuthentication: async (launchSpec, method, context) => {
					terminalCalls.push({ launchSpec, method, context });
				},
			},
			{
				connectionFactory(agent, onEvent, options) {
					spawnedAuthenticationEnvironments.push(
						Object.hasOwn(agent, "_sessionAuthEnv") ? { ...agent._sessionAuthEnv } : undefined,
					);
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [terminalMethod] });
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect({ createSession: false });
		await adapter.authenticate("terminal-login", { source: "test" });
		assert.equal(terminalCalls.length, 1);
		assert.equal(terminalCalls[0].launchSpec, adapter.launchSpec);
		assert.equal(terminalCalls[0].method, terminalMethod);
		assert.equal(terminalCalls[0].context.adapter, adapter);
		assert.deepEqual(terminalCalls[0].context.meta, { source: "test" });
		assert.equal(connections.length, 2, "terminal authentication reconnects the ACP process");
		assert.deepEqual(
			spawnedAuthenticationEnvironments,
			[{ SERVICE_TOKEN: "stale-session-token" }, undefined],
			"terminal authentication replaces any prior session-only environment",
		);
		assert.equal(Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"), false);
		assert.deepEqual(connections[0].calls, [["stop"]]);
		assert.equal(connections[1].calls.some(([name]) => name === "authenticate"), false);
		connections[1].onEvent({ type: "text", text: "live" });
		connections[0].onEvent({ type: "text", text: "stale" });
		assert.deepEqual(events, [{ type: "text", text: "live" }]);
		assert.deepEqual(await connections[0].emitPermission({}), { outcome: "cancelled" });
		await connections[0].emitCursor("cursor/create_plan", {});
		assert.deepEqual(await connections[0].emitElicitation({ mode: "url" }), { action: "cancel" });
		assert.equal(staleHostCalls, 0, "stopped adapter connections cannot reach host callbacks");
		ok("base-adapter:terminal-authentication-is-client-run");
	}
	{
		const terminalMethod = {
			type: "terminal",
			id: "terminal-login",
			name: "Terminal login",
		};
		const connections = [];
		const spawnedAuthenticationEnvironments = [];
		const adapter = new BaseAcpAdapter(
			"terminal-auth-retirement-failure",
			{
				label: "Terminal auth retirement failure",
				acp: { command: "auth-agent" },
				_sessionAuthEnv: { SERVICE_TOKEN: "stale-session-token" },
			},
			{
				...noopHost(),
				runTerminalAuthentication: async () => {},
			},
			{
				connectionFactory(agent, onEvent, options) {
					spawnedAuthenticationEnvironments.push(
						Object.hasOwn(agent, "_sessionAuthEnv") ? { ...agent._sessionAuthEnv } : undefined,
					);
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [terminalMethod] });
					if (connections.length === 0) {
						connection.stop = function stop() {
							this.calls.push(["stop"]);
							throw new Error("recoverable retirement failure");
						};
					}
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await assert.rejects(() => adapter.authenticate("terminal-login"), /recoverable retirement failure/);
		assert.equal(
			Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"),
			false,
			"a failed old-process retirement cannot restore the stale terminal-auth environment",
		);
		await adapter.connect({ createSession: false });
		assert.deepEqual(spawnedAuthenticationEnvironments, [{ SERVICE_TOKEN: "stale-session-token" }, undefined]);
		assert.equal(adapter.connection, connections[1]);
		ok("base-adapter:terminal-auth-clears-stale-env-before-recoverable-retirement");
	}
	{
		const terminalMethod = {
			type: "terminal",
			id: "terminal-login",
			name: "Terminal login",
			args: ["--login"],
		};
		const connections = [];
		let markAuthenticationStarted;
		let markAuthenticationStopStarted;
		let releaseAuthenticationStop;
		const authenticationStarted = new Promise((resolve) => { markAuthenticationStarted = resolve; });
		const authenticationStopStarted = new Promise((resolve) => { markAuthenticationStopStarted = resolve; });
		const authenticationStopGate = new Promise((resolve) => { releaseAuthenticationStop = resolve; });
		let terminalContext;
		const adapter = new BaseAcpAdapter(
			"terminal-auth-stop-race",
			{ label: "Terminal auth stop race", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				runTerminalAuthentication: async (_launchSpec, _method, context) => {
					terminalContext = context;
					context.processTracker.assertOpen();
					context.processTracker.register(async () => {
						markAuthenticationStopStarted();
						await authenticationStopGate;
					});
					markAuthenticationStarted();
					await new Promise((resolve, reject) => {
						context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
					});
				},
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [terminalMethod] });
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		const authentication = adapter.authenticate("terminal-login");
		await authenticationStarted;
		const stopped = adapter.stop();
		assert.equal(adapter.stop(), stopped, "stop is idempotent and exposes one awaitable shutdown");
		await authenticationStopStarted;
		const rejected = assert.rejects(authentication, (error) => {
			assert.equal(error?.code, "ADAPTER_STOPPED");
			return true;
		});
		let stopSettled = false;
		void stopped.then(() => { stopSettled = true; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(terminalContext.signal.aborted, true, "stop aborts active terminal authentication");
		assert.equal(stopSettled, false, "stop waits for the terminal authentication process tree");
		releaseAuthenticationStop();
		await Promise.all([stopped, rejected]);
		assert.equal(connections.length, 1, "terminal authentication cannot reconnect after stop starts");
		assert.equal(adapter.connection, undefined);
		assert.deepEqual(connections[0].calls, [["stop"]]);
		await assert.rejects(() => adapter.connect(), (error) => error?.code === "ADAPTER_STOPPED");
		assert.equal(connections.length, 1, "a stopped adapter cannot be connected again");
		ok("base-adapter:stop-blocks-delayed-terminal-authentication-reconnect");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }, { name: "OPTIONAL_REGION", optional: true }],
		};
		const connections = [];
		const spawnedAuthenticationEnvironments = [];
		const textEvents = [];
		let collected;
		const adapter = new BaseAcpAdapter(
			"auth",
			{
				label: "Auth",
				env: { AUTH_ROOT: "root" },
				acp: { command: "auth-agent", env: { AUTH_CHILD: "child" } },
			},
			{
				...noopHost(),
				onEvent: (event) => {
					if (event?.type === "text") textEvents.push(event.text);
				},
				collectEnvironmentVariables: async (method, environment, context) => {
					collected = { method, environment, context };
					return { SERVICE_TOKEN: "session-secret" };
				},
			},
			{
				connectionFactory(agent, onEvent, options) {
					spawnedAuthenticationEnvironments.push(
						Object.hasOwn(agent, "_sessionAuthEnv") ? { ...agent._sessionAuthEnv } : undefined,
					);
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await adapter.authenticate("token");
		assert.equal(collected.method, envMethod);
		assert.equal(collected.environment.AUTH_ROOT, "root");
		assert.equal(collected.environment.AUTH_CHILD, "child");
		assert.equal(collected.context.adapter, adapter);
		assert.deepEqual(adapter.launchSpec._sessionAuthEnv, { SERVICE_TOKEN: "session-secret" });
		assert.equal(connections.length, 2, "environment authentication reconnects with the session credential");
		assert.deepEqual(connections[0].calls, [["stop"]]);
		assert.deepEqual(spawnedAuthenticationEnvironments, [undefined, { SERVICE_TOKEN: "session-secret" }]);
		assert.equal(connections[1].calls.some(([name]) => name === "authenticate"), false);
		const credentialConnection = connections[1];
		assert.deepEqual(await adapter.logout(), {});
		assert.equal(Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"), false);
		assert.equal(connections.length, 3, "logout replaces the credential-bearing ACP process");
		assert.deepEqual(credentialConnection.calls, [["logout"], ["stop"]]);
		assert.equal(adapter.connection, connections[2]);
		assert.equal(adapter.connection.sessionId, undefined, "the signed-out replacement does not create a session");
		assert.deepEqual(adapter.connectOptions, {}, "logout preserves the normal connection preference for a later login");
		assert.deepEqual(spawnedAuthenticationEnvironments, [undefined, { SERVICE_TOKEN: "session-secret" }, undefined]);
		connections[2].onEvent({ type: "text", text: "credential-free" });
		credentialConnection.onEvent({ type: "text", text: "stale-authenticated" });
		assert.deepEqual(textEvents, ["credential-free"], "retired authenticated callbacks stay detached");
		ok("base-adapter:environment-authentication-is-client-run");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		let markCollectionStarted;
		let releaseCollection;
		const collectionStarted = new Promise((resolve) => { markCollectionStarted = resolve; });
		const collectionGate = new Promise((resolve) => { releaseCollection = resolve; });
		let collectionContext;
		const adapter = new BaseAcpAdapter(
			"env-auth-stop-race",
			{ label: "Environment auth stop race", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async (_method, _environment, context) => {
					collectionContext = context;
					markCollectionStarted();
					await collectionGate;
					return { SERVICE_TOKEN: "too-late" };
				},
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		const authentication = adapter.authenticate("token");
		await collectionStarted;
		const stopped = adapter.stop();
		const rejected = assert.rejects(authentication, (error) => {
			assert.equal(error?.code, "ADAPTER_STOPPED");
			return true;
		});
		let stopSettled = false;
		void stopped.then(() => { stopSettled = true; });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(collectionContext.signal.aborted, true, "stop aborts active environment collection");
		assert.equal(stopSettled, false, "stop waits until the environment collector has settled");
		releaseCollection();
		await Promise.all([stopped, rejected]);
		assert.equal(connections.length, 1, "collected credentials cannot spawn a backend after stop starts");
		assert.equal(Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"), false);
		assert.equal(adapter.connection, undefined);
		assert.deepEqual(connections[0].calls, [["stop"]]);
		ok("base-adapter:stop-blocks-delayed-environment-authentication-reconnect");
	}
	{
		const listeners = new Map();
		const rawModes = [];
		let pauseCalls = 0;
		const input = {
			isTTY: true,
			isRaw: false,
			isPaused: () => true,
			on(name, listener) {
				listeners.set(name, listener);
			},
			off(name, listener) {
				if (listeners.get(name) === listener) listeners.delete(name);
			},
			setRawMode(value) {
				rawModes.push(value);
			},
			resume() {},
			pause() {
				pauseCalls += 1;
			},
		};
		const output = { isTTY: true, write() {} };
		const controller = new AbortController();
		const stoppedError = new Error("adapter stopped");
		stoppedError.code = "ADAPTER_STOPPED";
		const collection = collectEnvironmentAuthenticationVariables(
			{ type: "env_var", vars: [{ name: "SERVICE_TOKEN", secret: true }] },
			{},
			{ input, output, signal: controller.signal },
		);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(listeners.has("data"), true, "the built-in collector is waiting on terminal input");
		controller.abort(stoppedError);
		await assert.rejects(collection, (error) => error === stoppedError);
		assert.equal(listeners.has("data"), false, "abort removes the built-in collector's input listener");
		assert.deepEqual(rawModes, [true, false]);
		assert.equal(pauseCalls, 1, "abort restores the input's prior paused state");
		ok("base-adapter:built-in-environment-collector-is-abortable");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		let markRetirementStarted;
		let releaseRetirement;
		const retirementStarted = new Promise((resolve) => { markRetirementStarted = resolve; });
		const retirementGate = new Promise((resolve) => { releaseRetirement = resolve; });
		const adapter = new BaseAcpAdapter(
			"auth-reconnect-stop-race",
			{ label: "Auth reconnect stop race", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "session-secret" }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					connection.stopAndWait = async function stopAndWait() {
						this.calls.push(["stopAndWait:start"]);
						markRetirementStarted();
						await retirementGate;
						this.calls.push(["stopAndWait:end"]);
					};
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		const authentication = adapter.authenticate("token");
		await retirementStarted;
		const stopped = adapter.stop();
		const rejected = assert.rejects(authentication, (error) => error?.code === "ADAPTER_STOPPED");
		releaseRetirement();
		await Promise.all([stopped, rejected]);
		assert.equal(connections.length, 1, "stop during old-tree retirement prevents the replacement spawn");
		assert.equal(Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"), false);
		assert.equal(adapter.connection, undefined);
		assert.deepEqual(connections[0].calls, [["stopAndWait:start"], ["stopAndWait:end"]]);
		ok("base-adapter:stop-blocks-in-progress-authentication-reconnect");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		let releaseCredentialStop;
		let markCredentialStopStarted;
		const credentialStopStarted = new Promise((resolve) => { markCredentialStopStarted = resolve; });
		const credentialStopGate = new Promise((resolve) => { releaseCredentialStop = resolve; });
		const adapter = new BaseAcpAdapter(
			"auth-stop-gate",
			{ label: "Auth stop gate", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "session-secret" }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					if (Object.hasOwn(agent, "_sessionAuthEnv")) {
						connection.stopAndWait = async function stopAndWait() {
							this.calls.push(["stopAndWait:start"]);
							markCredentialStopStarted();
							await credentialStopGate;
							this.calls.push(["stopAndWait:end"]);
						};
					}
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await adapter.authenticate("token");
		assert.equal(connections.length, 2);
		const credentialConnection = connections[1];
		const logout = adapter.logout();
		await credentialStopStarted;
		assert.equal(connections.length, 2, "credential-free replacement waits for old process reaping");
		assert.equal(adapter.connection, undefined, "credential callbacks are detached while shutdown is pending");
		releaseCredentialStop();
		await logout;
		assert.equal(connections.length, 3);
		assert.deepEqual(credentialConnection.calls.slice(-3), [
			["logout"],
			["stopAndWait:start"],
			["stopAndWait:end"],
		]);
		ok("base-adapter:credential-process-reaped-before-logout-reconnect");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		const adapter = new BaseAcpAdapter(
			"auth-fatal-fence",
			{ label: "Auth fatal fence", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "session-secret" }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					if (Object.hasOwn(agent, "_sessionAuthEnv")) {
						connection.stopAndWait = async function stopAndWait() {
							const error = new Error("credential process tree remains live");
							error.code = "PROCESS_TREE_TERMINATION_FAILED";
							throw error;
						};
					}
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		await adapter.authenticate("token");
		assert.equal(connections.length, 2);
		await assert.rejects(() => adapter.logout(), /restart cc.*credential process tree remains live/);
		assert.equal(connections.length, 2, "fatal logout stop must not create a replacement");
		await assert.rejects(() => adapter.connect(), /restart cc.*credential process tree remains live/);
		assert.equal(connections.length, 2, "later connect remains fenced for the adapter lifetime");
		ok("base-adapter:fatal-process-tree-fences-future-connects");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		const spawnedAuthenticationEnvironments = [];
		const adapter = new BaseAcpAdapter(
			"auth-race",
			{ label: "Auth race", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "racing-secret" }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					spawnedAuthenticationEnvironments.push(
						Object.hasOwn(agent, "_sessionAuthEnv") ? { ...agent._sessionAuthEnv } : undefined,
					);
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		let releaseLogout;
		let markLogoutStarted;
		const logoutStarted = new Promise((resolve) => { markLogoutStarted = resolve; });
		const logoutGate = new Promise((resolve) => { releaseLogout = resolve; });
		connections[0].logout = async function () {
			this.calls.push(["logout"]);
			markLogoutStarted();
			await logoutGate;
			return {};
		};

		const logout = adapter.logout();
		await logoutStarted;
		await adapter.authenticate("token");
		const credentialConnection = connections[1];
		assert.equal(adapter.connection, credentialConnection);
		assert.deepEqual(spawnedAuthenticationEnvironments, [undefined, { SERVICE_TOKEN: "racing-secret" }]);
		releaseLogout();
		await logout;

		assert.equal(Object.hasOwn(adapter.launchSpec, "_sessionAuthEnv"), false);
		assert.equal(connections.length, 3, "racing logout reconnects after the credential-bearing replacement");
		assert.equal(credentialConnection.calls.some(([name]) => name === "stop"), true);
		assert.equal(adapter.connection, connections[2]);
		assert.equal(adapter.connection.sessionId, undefined);
		assert.deepEqual(spawnedAuthenticationEnvironments, [undefined, { SERVICE_TOKEN: "racing-secret" }, undefined]);
		ok("base-adapter:logout-retires-racing-environment-authentication");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		const spawnedAuthenticationEnvironments = [];
		let credentialSequence = 0;
		let releaseInitialStop;
		let markInitialStopStarted;
		const initialStopStarted = new Promise((resolve) => { markInitialStopStarted = resolve; });
		const initialStopGate = new Promise((resolve) => { releaseInitialStop = resolve; });
		const adapter = new BaseAcpAdapter(
			"auth-reconnect-mutex",
			{ label: "Auth reconnect mutex", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: `serialized-secret-${++credentialSequence}` }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					spawnedAuthenticationEnvironments.push(
						Object.hasOwn(agent, "_sessionAuthEnv") ? { ...agent._sessionAuthEnv } : undefined,
					);
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					if (connections.length === 0) {
						connection.stopAndWait = async function stopAndWait() {
							this.calls.push(["stopAndWait:start"]);
							markInitialStopStarted();
							await initialStopGate;
							this.calls.push(["stopAndWait:end"]);
						};
					}
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		const first = adapter.authenticate("token");
		const second = adapter.authenticate("token");
		await initialStopStarted;
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(connections.length, 1, "a queued reconnect cannot launch while the prior tree is still stopping");
		releaseInitialStop();
		await Promise.all([first, second]);
		assert.equal(connections.length, 3, "both authentication requests complete in serialized lifecycle turns");
		assert.equal(adapter.connection, connections[2]);
		assert.deepEqual(
			spawnedAuthenticationEnvironments,
			[
				undefined,
				{ SERVICE_TOKEN: "serialized-secret-1" },
				{ SERVICE_TOKEN: "serialized-secret-2" },
			],
			"each queued reconnect launches with the credentials collected for that authentication request",
		);
		assert.equal(
			connections[1].calls.some(([name]) => name === "stop"),
			true,
			"the second reconnect retires the first replacement instead of orphaning it",
		);
		ok("base-adapter:authentication-reconnects-are-serialized");
	}
	{
		const envMethod = {
			type: "env_var",
			id: "token",
			name: "Token",
			vars: [{ name: "SERVICE_TOKEN" }],
		};
		const connections = [];
		let releaseFatalStop;
		let markFatalStopStarted;
		const fatalStopStarted = new Promise((resolve) => { markFatalStopStarted = resolve; });
		const fatalStopGate = new Promise((resolve) => { releaseFatalStop = resolve; });
		const adapter = new BaseAcpAdapter(
			"auth-reconnect-fence",
			{ label: "Auth reconnect fence", acp: { command: "auth-agent" } },
			{
				...noopHost(),
				collectEnvironmentVariables: async () => ({ SERVICE_TOKEN: "fenced-secret" }),
			},
			{
				connectionFactory(agent, onEvent, options) {
					const connection = new FakeConnection(agent, onEvent, options, { authMethods: [envMethod] });
					connection.stopAndWait = async function stopAndWait() {
						markFatalStopStarted();
						await fatalStopGate;
						const error = new Error("old authentication process tree remains live");
						error.code = "PROCESS_TREE_TERMINATION_FAILED";
						throw error;
					};
					connections.push(connection);
					return connection;
				},
			},
		);
		await adapter.connect();
		const first = adapter.authenticate("token");
		const second = adapter.authenticate("token");
		await fatalStopStarted;
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(connections.length, 1);
		releaseFatalStop();
		const outcomes = await Promise.allSettled([first, second]);
		assert.deepEqual(outcomes.map((outcome) => outcome.status), ["rejected", "rejected"]);
		assert.equal(connections.length, 1, "a queued reconnect cannot bypass a fatal lifecycle fence");
		assert.equal(adapter.connection, undefined);
		assert.ok(adapter.replacementProcessFence);
		ok("base-adapter:fatal-reconnect-fence-blocks-concurrent-authentication");
	}
	{
		const requests = [];
		const params = { mode: "url", url: "https://example.test/sign-in" };
		const adapter = new BaseAcpAdapter(
			"elicitation",
			{ label: "Elicitation", acp: { command: "agent" } },
			{
				...noopHost(),
				elicitationCapabilities: { url: true, form: true },
				onElicitationRequest: async (request) => {
					requests.push(request);
					return { action: "accept" };
				},
			},
			{ connectionFactory: factoryFor({}) },
		);
		await adapter.connect();
		assert.deepEqual(await adapter.connection.emitElicitation(params), { action: "accept" });
		assert.deepEqual(requests, [params]);
		assert.deepEqual(adapter.connection.options.elicitationCapabilities, { url: true, form: true });

		const withoutHandler = new BaseAcpAdapter(
			"elicitation",
			{ label: "Elicitation", acp: { command: "agent" } },
			noopHost(),
			{ connectionFactory: factoryFor({}) },
		);
		await withoutHandler.connect();
		assert.equal(withoutHandler.connection.options.onElicitationRequest, undefined);
		ok("base-adapter:elicitation-handler-wired-only-when-supported");
	}
	const EXPECTED = {
		codex: { fork: "copy", resume: true, sessionList: true, delete: true, models: true, modes: true, reasoningEffort: true, image: false, retractPrompt: true, interactiveRequests: false },
		claude: { fork: "native", resume: true, sessionList: true, delete: false, models: false, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false },
		cursor: { fork: false, resume: false, sessionList: false, delete: false, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: true },
		"terminus-2": { fork: false, resume: false, sessionList: false, delete: false, models: false, modes: true, reasoningEffort: false, image: false, retractPrompt: false, interactiveRequests: false },
		"mini-swe-agent": { fork: false, resume: false, sessionList: false, delete: false, models: false, modes: false, reasoningEffort: false, image: false, retractPrompt: false, interactiveRequests: false },
		opencode: { fork: "native", resume: true, sessionList: true, delete: false, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false, mcp: true },
		pi: { fork: false, resume: true, sessionList: true, delete: false, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false },
	};
	for (const [key, expected] of Object.entries(EXPECTED)) {
		const adapter = createAdapter(key, CONFIGS[key], noopHost(), { connectionFactory: factoryFor(PROFILES[key]) });
		await adapter.connect();
		for (const [cap, value] of Object.entries(expected)) {
			assert.deepEqual(adapter.capabilities[cap], value, `${key}.capabilities.${cap} expected ${JSON.stringify(value)} got ${JSON.stringify(adapter.capabilities[cap])}`);
		}
		ok(`capabilities:${key}`);
	}
	// codex declares the review preset; pure-base harnesses don't.
	assert.deepEqual(createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) }).capabilities.commandPresets, ["review"]);
	assert.deepEqual(createAdapter("terminus-2", CONFIGS["terminus-2"], noopHost(), { connectionFactory: factoryFor(PROFILES["terminus-2"]) }).capabilities.commandPresets, []);
	ok("capabilities:commandPresets");
	// session/delete is wire-derived and forwarded without backend-specific code.
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) });
		await codex.connect();
		assert.equal(codex.capabilities.delete, true);
		await codex.deleteSession("doomed-session");
		assert.deepEqual(codex.connection.calls.at(-1), ["deleteSession", "doomed-session"]);
		const cursor = createAdapter("cursor", CONFIGS.cursor, noopHost(), { connectionFactory: factoryFor(PROFILES.cursor) });
		await cursor.connect();
		assert.equal(cursor.capabilities.delete, false);
		ok("sessions:delete-wire-derived-and-forwarded");
	}
	// pre-connect capabilities expose the DECLARED subset (contract): codex unsend is
	// declared true before connect, then narrowed to the live wire identity after.
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) });
		assert.equal(codex.capabilities.retractPrompt, true); // declared, pre-connect
		const impostorProfile = { agentInfo: { name: "not-codex-acp" }, capabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }, configOptions: [] };
		const impostor = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(impostorProfile) });
		assert.equal(impostor.capabilities.retractPrompt, true); // still declared pre-connect
		await impostor.connect();
		assert.equal(impostor.capabilities.retractPrompt, false); // narrowed by live wire identity
		ok("capabilities:codex-retract-preconnect-then-wire-gated");
	}

	// =====================================================================
	// (2b) NO FEATURES LOST — native-settings translation is byte-identical
	//      to the production applyHarnessSettings.
	// =====================================================================
	const settingsConfig = {
		defaultAgent: "codex",
		agents: {
			claude: CONFIGS.claude,
			codex: CONFIGS.codex,
			cursor: CONFIGS.cursor,
			"terminus-2": { label: "Terminus-2", transport: "acp", acp: { command: "python3", args: ["src/harnesses/terminus_2/bridge.py"] } },
			"mini-swe-agent": { label: "mini-swe-agent", transport: "acp", acp: { command: "python3", args: ["src/harnesses/mini_swe_agent/bridge.py"] } },
		},
	};
	const nativeSettings = {
		agents: {
			claude: { settings: { model: "sonnet", permissions: { defaultMode: "bypassPermissions" } } },
			codex: {
				config: { model: "gpt-5", approval_policy: "never", sandbox_mode: "danger-full-access" },
				sessionDefaults: { model: "gpt-cc", effort: "medium" },
			},
			cursor: { args: ["--model", "gpt-5", "--force", "--sandbox", "disabled", "--approve-mcps"] },
			"terminus-2": { args: ["--model", "openai/gpt-5", "--max-episodes", "2"] },
			"mini-swe-agent": { args: ["--model", "openai/gpt-5", "--no-yolo"] },
		},
	};
	const applied = applyHarnessSettings(settingsConfig, nativeSettings);
	for (const key of Object.keys(nativeSettings.agents)) {
		const adapter = createAdapter(key, settingsConfig.agents[key], noopHost(), {
			settings: nativeSettings.agents[key],
			connectionFactory: factoryFor(PROFILES[key]),
		});
		assert.deepEqual(adapter.launchSpec, applied.agents[key], `launchSpec for ${key} must equal applyHarnessSettings output`);
		assert.equal(adapter.capabilities.autoApprove, Boolean(applied.agents[key]._autoPermissionRequests), `${key} autoApprove`);
		ok(`settings-equivalence:${key}`);
	}
	// config is not mutated by the adapter path (matches applyHarnessSettings).
	assert.deepEqual(settingsConfig.agents.cursor.acp.args, ["acp"]);
	ok("settings-equivalence:no-mutation");

	// Unified `mode: auto` removes stale permission config and selects the new
	// adapter's full-access mode (parity with applyHarnessSettings).
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), {
			settings: { permissions: { mode: "auto" }, config: { approval_policy: "on-request", model: "gpt-5" } },
			connectionFactory: factoryFor(PROFILES.codex),
		});
		assert.deepEqual(codexConfig(codex.launchSpec), { model: "gpt-5" });
		assert.equal(codex.launchSpec._startupMode, "agent-full-access");
		assert.equal(codex.capabilities.autoApprove, true);
		ok("settings-equivalence:unified-auto-overrides-codex");
	}

	// Explicit unified "ask" neutralizes a native auto/bypass already on the agent
	// (adapter parity with applyHarnessSettings): backend prompts, cc stays in sync.
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), {
			settings: { permissions: { mode: "ask" }, config: { approval_policy: "never", sandbox_mode: "danger-full-access" } },
			connectionFactory: factoryFor(PROFILES.codex),
		});
		assert.deepEqual(codexConfig(codex.launchSpec), {});
		assert.equal(codex.launchSpec._startupMode, "agent");
		assert.equal(codex.launchSpec._autoPermissionRequests, undefined);
		assert.equal(codex.capabilities.autoApprove, false);

		const cursor = createAdapter("cursor", CONFIGS.cursor, noopHost(), {
			settings: { permissions: { mode: "ask" }, args: ["--force", "--model", "gpt-5"] },
			connectionFactory: factoryFor(PROFILES.cursor),
		});
		assert.ok(!cursor.launchSpec.acp.args.includes("--force"), "cursor force flag removed (adapter)");
		assert.ok(cursor.launchSpec.acp.args.includes("gpt-5"), "cursor unrelated args kept (adapter)");
		assert.equal(cursor.capabilities.autoApprove, false);
		ok("settings-equivalence:unified-ask-neutralizes");
	}

	// mode auto WITH a deny rule gates the backend (prompts) instead of full bypass,
	// so cc can enforce the denial — adapter parity with applyHarnessSettings.
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), {
			settings: { permissions: { mode: "auto", rules: [{ tool: "shell", action: "deny" }] } },
			connectionFactory: factoryFor(PROFILES.codex),
		});
		assert.equal(codex.launchSpec._startupMode, "agent");
		assert.equal(codex.capabilities.autoApprove, true);
		ok("settings-equivalence:auto-with-deny-gates");
	}

	// A PERSISTED deny grant (host-provided via options.grants) must gate the launch
	// spec too — not just config rules. Without grants the same setup full-bypasses.
	{
		const grants = [{ agent: "codex", tool: "shell", action: "deny" }];
		const gated = createAdapter("codex", CONFIGS.codex, noopHost(), {
			settings: { permissions: { mode: "auto" } },
			grants,
			connectionFactory: factoryFor(PROFILES.codex),
		});
		assert.equal(gated.launchSpec._startupMode, "agent", "persisted deny grant gates auto (adapter)");

		const ungated = createAdapter("codex", CONFIGS.codex, noopHost(), {
			settings: { permissions: { mode: "auto" } },
			connectionFactory: factoryFor(PROFILES.codex),
		});
		assert.equal(ungated.launchSpec._startupMode, "agent-full-access", "no grant -> full bypass (adapter)");
		ok("settings-equivalence:persisted-deny-grant-gates");
	}

	// A cursor --force baked into the BASE config acp.args (no settings) must still
	// infer auto on the adapter path, or capabilities/policy desync from the backend.
	{
		const cfg = { label: "Cursor", transport: "acp", acp: { command: "cursor-agent", args: ["--force", "acp"] } };
		const cursor = createAdapter("cursor", cfg, noopHost(), { connectionFactory: factoryFor(PROFILES.cursor) });
		assert.equal(cursor.launchSpec._permissionMode, "auto");
		assert.equal(cursor.capabilities.autoApprove, true);
		ok("settings-equivalence:cursor-baked-force-detected");
	}

	// =====================================================================
	// (2c) NO FEATURES LOST — the per-harness branches collapse into uniform
	//      adapter calls (cc connects to the interface, names no harness).
	// =====================================================================

	// /btw fork ladder -> capability + fork(); no `activeKey === "codex"`.
	// openSideThread is cc's real generic helper (src/harness/host-example.mjs).
	{
		const claude = createAdapter("claude", CONFIGS.claude, noopHost(), { connectionFactory: factoryFor(PROFILES.claude) });
		assert.equal(await openSideThread(claude, "parent"), "native-fork");
		ok("fork:claude-native");

		const cursor = createAdapter("cursor", CONFIGS.cursor, noopHost(), { connectionFactory: factoryFor(PROFILES.cursor) });
		await assert.rejects(() => openSideThread(cursor, "parent"), /forking/);
		ok("fork:cursor-refused-by-capability");
	}

	// codex copy-fork end-to-end against a temp $CODEX_HOME (no real codex).
	{
		const prevHome = process.env.CODEX_HOME;
		const prevForks = process.env.CC_FORKS;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-fork-"));
		try {
			delete process.env.CODEX_HOME;
			process.env.CC_FORKS = path.join(dir, "forks.json");
			const parentId = "11111111-1111-1111-1111-111111111111";
			const day = path.join(dir, "sessions", "2026", "06", "23");
			fs.mkdirSync(day, { recursive: true });
			const rollout = path.join(day, `rollout-2026-06-23T12-00-00-${parentId}.jsonl`);
			fs.writeFileSync(
				rollout,
				`${JSON.stringify({ type: "session_meta", payload: { id: parentId, session_id: parentId } })}\n` +
					`${JSON.stringify({ type: "msg", text: `literal ${parentId}` })}\n`,
			);

			const codexConfig = {
				...CONFIGS.codex,
				env: { ...(CONFIGS.codex.env ?? {}), CODEX_HOME: dir },
			};
			let confirmTreeStopped;
			const treeStopped = new Promise((resolve) => { confirmTreeStopped = resolve; });
			const codex = createAdapter("codex", codexConfig, noopHost(), {
				connectionFactory: factoryFor(PROFILES.codex),
				services: { codex: codexServices },
				stopConnections: async (connections) => {
					for (const connection of connections) connection?.stop?.();
					await treeStopped;
				},
			});
			assert.equal(codex.codexEnvironment().CODEX_HOME, dir, "adapter storage helpers honor configured CODEX_HOME");
			await codex.connect({ createSession: false });
			assert.equal(codex.capabilities.fork, "copy");
			let leaseVisibleAtLoad = false;
			let copiedLoadCount = 0;
			const loadCopiedSession = codex.connection.loadSession.bind(codex.connection);
			codex.connection.loadSession = async (sessionId, options) => {
				copiedLoadCount += 1;
				leaseVisibleAtLoad = codexLiveSessionLeaseIsActive(sessionId);
				return await loadCopiedSession(sessionId, options);
			};
			// Both calls pass the pre-lock check in this turn. The post-lock check must
			// make the serialized contender fail without overwriting the first lease.
			const primaryFork = codex.fork(parentId, { retainSessionLease: true });
			const competingForkOutcome = codex.fork(parentId, { retainSessionLease: true })
				.then(() => undefined, (error) => error);
			await primaryFork;
			const competingForkError = await competingForkOutcome;
			assert.match(competingForkError?.message ?? "", /source session changed before the fork could start/);
			assert.equal(copiedLoadCount, 1, "a serialized contender never loads or replaces the live fork");
			assert.equal(
				leaseVisibleAtLoad,
				true,
				"copy-fork ownership is durable before the ACP backend can open the rollout",
			);
			// loadSession set the session id to the new (copied) uuid.
			assert.notEqual(codex.sessionId, parentId);
			assert.match(codex.sessionId, /^[0-9a-f-]{36}$/);
			// The copy exists, named with the new id, with metadata rewritten while
			// transcript content remains byte-for-byte faithful.
			const copied = path.join(day, `rollout-2026-06-23T12-00-00-${codex.sessionId}.jsonl`);
			assert.ok(fs.existsSync(copied), "copied rollout exists");
			const copiedRecords = fs.readFileSync(copied, "utf8").trimEnd().split("\n").map(JSON.parse);
			assert.equal(copiedRecords[0].payload.id, codex.sessionId);
			assert.equal(copiedRecords[0].payload.session_id, codex.sessionId);
			assert.equal(copiedRecords[0].payload.forked_from_id, parentId);
			assert.equal(copiedRecords[1].text, `literal ${parentId}`);
			assert.equal(loadForkParents().get(codex.sessionId), parentId);
			const dbPath = path.join(dir, "state_5.sqlite");
			const sqlPath = copied.replaceAll("'", "''");
			const sqlite = spawnSync("sqlite3", [dbPath, [
				"create table threads (id text, rollout_path text, updated_at integer, updated_at_ms integer,",
				"has_user_event integer, archived integer, tokens_used integer, title text,",
				"first_user_message text, preview text, model text, reasoning_effort text);",
				`insert into threads values ('${codex.sessionId}', '${sqlPath}', 1, 1000, 1, 0, 0, 'fork', '', '', 'gpt', 'high');`,
			].join(" ")], { encoding: "utf8" });
			if (!sqlite.error && sqlite.status === 0) {
				const snapshot = codex.snapshotRetractionState();
				assert.equal(snapshot?.sessionId, codex.sessionId, "unsend snapshots use configured CODEX_HOME");
				assert.equal(codex.canRetract(snapshot), true);
			}
			const leasedSessionId = codex.sessionId;
			assert.equal(codexLiveSessionLeaseIsActive(leasedSessionId), true);
			const contender = createAdapter("codex", codexConfig, noopHost(), {
				connectionFactory: factoryFor(PROFILES.codex),
				services: { codex: codexServices },
			});
			await assert.rejects(
				() => contender.loadSession(leasedSessionId),
				(error) => error?.code === "CC_SESSION_LEASE_ACTIVE",
				"another adapter cannot resume a rollout owned by the live side process",
			);
			const stopping = codex.stop();
			assert.equal(
				codexLiveSessionLeaseIsActive(leasedSessionId),
				true,
				"session ownership remains while ACP process-tree shutdown is unconfirmed",
			);
			confirmTreeStopped();
			await stopping;
			assert.equal(codexLiveSessionLeaseIsActive(leasedSessionId), false);
			ok("fork:codex-copy-e2e");
		} finally {
			if (prevHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = prevHome;
			if (prevForks === undefined) delete process.env.CC_FORKS;
			else process.env.CC_FORKS = prevForks;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// A failed copy-fork load must keep its lease until backend shutdown is
	// confirmed, then release ownership before removing the unpublished branch.
	{
		const previousForks = process.env.CC_FORKS;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-fork-load-failure-"));
		let codex;
		try {
			process.env.CC_FORKS = path.join(dir, "forks.json");
			const parentId = "22222222-2222-2222-2222-222222222222";
			const day = path.join(dir, "sessions", "2026", "06", "24");
			fs.mkdirSync(day, { recursive: true });
			const rollout = path.join(day, `rollout-2026-06-24T12-00-00-${parentId}.jsonl`);
			fs.writeFileSync(
				rollout,
				`${JSON.stringify({ type: "session_meta", payload: { id: parentId, session_id: parentId } })}\n`,
			);
			const codexConfig = {
				...CONFIGS.codex,
				env: { ...(CONFIGS.codex.env ?? {}), CODEX_HOME: dir },
			};
			let shutdownObservedLease = false;
			let failedSessionId;
			let announceShutdownStarted;
			const shutdownStarted = new Promise((resolve) => { announceShutdownStarted = resolve; });
			let confirmShutdown;
			const shutdownConfirmed = new Promise((resolve) => { confirmShutdown = resolve; });
			codex = createAdapter("codex", codexConfig, noopHost(), {
				connectionFactory: factoryFor(PROFILES.codex),
				services: { codex: codexServices },
				stopConnections: async (connections) => {
					shutdownObservedLease = Boolean(
						failedSessionId && codexLiveSessionLeaseIsActive(failedSessionId),
					);
					announceShutdownStarted();
					await shutdownConfirmed;
					for (const connection of connections) connection?.stop?.();
				},
			});
			await codex.connect({ createSession: false });
			codex.connection.loadSession = async (sessionId) => {
				failedSessionId = sessionId;
				assert.equal(
					codexLiveSessionLeaseIsActive(sessionId),
					true,
					"the lease exists before a failing ACP session/load begins",
				);
				throw new Error("injected session/load failure");
				};
			const failedFork = codex.fork(parentId, { retainSessionLease: true });
			await shutdownStarted;
			assert.equal(codexLiveSessionLeaseIsActive(failedSessionId), true, "ownership remains while shutdown is unconfirmed");
			assert.equal(
				fs.existsSync(path.join(day, `rollout-2026-06-24T12-00-00-${failedSessionId}.jsonl`)),
				true,
				"the rollout remains while its ACP process may still be using it",
			);
			assert.equal(loadForkParents().get(failedSessionId), parentId, "lineage remains durable during shutdown");
			confirmShutdown();
			await assert.rejects(
				failedFork,
				/injected session\/load failure/,
			);
			assert.equal(shutdownObservedLease, true, "backend cleanup runs while ownership remains fail-closed");
			assert.equal(codexLiveSessionLeaseIsActive(failedSessionId), false, "confirmed cleanup releases ownership");
			assert.equal(
				fs.existsSync(path.join(day, `rollout-2026-06-24T12-00-00-${failedSessionId}.jsonl`)),
				false,
				"the failed copied rollout is removed",
			);
			assert.equal(loadForkParents().has(failedSessionId), false, "failed fork lineage is removed");
			ok("fork:codex-copy-load-failure-releases-lease");
		} finally {
			if (codex?.lifecycleState === "open") await codex.stop();
			if (previousForks === undefined) delete process.env.CC_FORKS;
			else process.env.CC_FORKS = previousForks;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// Main-pane Codex sessions use the same process-external ownership protocol as
	// /btw: load acquires before ACP touches the target, swaps only after commit,
	// and connect/new/stop publish and release the active session consistently.
	{
		const previousForks = process.env.CC_FORKS;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-main-lease-"));
		const firstId = "30000000-0000-7000-8000-000000000001";
		const secondId = "30000000-0000-7000-8000-000000000002";
		const profile = { ...PROFILES.codex, sessionId: firstId };
		let main;
		let contender;
		try {
			process.env.CC_FORKS = path.join(dir, "forks.json");
			main = createAdapter("codex", CONFIGS.codex, noopHost(), {
				connectionFactory: factoryFor(profile),
				services: { codex: codexServices },
			});
			await main.connect();
			assert.equal(codexLiveSessionLeaseIsActive(firstId), true, "initial main session is leased");

			contender = createAdapter("codex", CONFIGS.codex, noopHost(), {
				connectionFactory: factoryFor(profile),
				services: { codex: codexServices },
			});
			await assert.rejects(
				() => contender.connect(),
				(error) => error?.code === "CC_SESSION_LEASE_ACTIVE",
				"another main adapter cannot attach to the same rollout",
			);
			await contender.stop();
			contender = undefined;

			const loadMainSession = main.connection.loadSession.bind(main.connection);
			let targetOwnedAtLoad = false;
			main.connection.loadSession = async (sessionId, options) => {
				targetOwnedAtLoad = codexLiveSessionLeaseIsActive(sessionId);
				assert.equal(codexLiveSessionLeaseIsActive(firstId), true, "source ownership remains during load");
				return await loadMainSession(sessionId, options);
			};
			await main.loadSession(secondId);
			assert.equal(targetOwnedAtLoad, true, "target ownership exists before session/load");
			assert.equal(codexLiveSessionLeaseIsActive(firstId), false, "committed load releases the source");
			assert.equal(codexLiveSessionLeaseIsActive(secondId), true, "committed target remains owned");

			await main.newSession();
			assert.equal(codexLiveSessionLeaseIsActive(secondId), false, "new session releases the prior rollout");
			assert.equal(codexLiveSessionLeaseIsActive(firstId), true, "newly active session is retained");
			await main.stop();
			main = undefined;
			assert.equal(codexLiveSessionLeaseIsActive(firstId), false, "confirmed main shutdown releases ownership");
			ok("sessions:codex-main-live-ownership");
		} finally {
			if (contender?.lifecycleState === "open") await contender.stop();
			if (main?.lifecycleState === "open") await main.stop();
			if (previousForks === undefined) delete process.env.CC_FORKS;
			else process.env.CC_FORKS = previousForks;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// /review interception -> interceptCommand(); no `activeKey === "codex"`.
	// dispatchSlashCommand is cc's real generic helper (src/harness/host-example.mjs).
	{
		const codex = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) });
		const result = dispatchSlashCommand(codex, "review", "", new Set());
		assert.equal(result.handledLocally, true);
		assert.equal(result.preset.kind, "preset-dialog");
		assert.equal(result.preset.entries.length, 4);
		ok("review:codex-by-identity");

		// any backend advertising the trio gets it (generic, faithful to today).
		const terminus = createAdapter("terminus-2", CONFIGS["terminus-2"], noopHost(), { connectionFactory: factoryFor(PROFILES["terminus-2"]) });
		assert.equal(dispatchSlashCommand(terminus, "review", "", new Set()).handledLocally, false);
		assert.equal(dispatchSlashCommand(terminus, "review", "", new Set(["review", "review-branch", "review-commit"])).handledLocally, true);
		ok("review:generic-by-advertisement");

		// claude does not offer it.
		const claude = createAdapter("claude", CONFIGS.claude, noopHost(), { connectionFactory: factoryFor(PROFILES.claude) });
		assert.equal(dispatchSlashCommand(claude, "review", "", new Set()).handledLocally, false);
		ok("review:claude-none");
	}

	// unsend -> snapshotRetractionState()/canRetract(); no codex sqlite in cc.
	// Use an empty temp $CODEX_HOME so the result is deterministic regardless of any
	// real ~/.codex on the machine (no state db -> snapshot undefined -> not retractable).
	{
		const prevHome = process.env.CODEX_HOME;
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-empty-"));
		let codex;
		try {
			process.env.CODEX_HOME = dir;
			codex = createAdapter("codex", CONFIGS.codex, noopHost(), {
				connectionFactory: factoryFor(PROFILES.codex),
				services: { codex: codexServices },
			});
			await codex.connect();
			// retractPrompt is gated on the maintained Codex ACP identity.
			assert.equal(codex.capabilities.retractPrompt, true);
			assert.equal(typeof codex.snapshotRetractionState, "function");
			// armUnsend/canUnsend are cc's generic helpers; with no codex state db the
			// snapshot is empty so canUnsend is false — but the capability + wiring are live.
			assert.equal(armUnsend(codex), undefined);
			assert.equal(canUnsend(codex, armUnsend(codex)), false);
			// a base harness simply has the capability off and a safe default.
			const claude = createAdapter("claude", CONFIGS.claude, noopHost(), { connectionFactory: factoryFor(PROFILES.claude) });
			assert.equal(claude.capabilities.retractPrompt, false);
			assert.equal(armUnsend(claude), undefined);
			assert.equal(canUnsend(claude, undefined), false);
			ok("unsend:codex-wired-others-off");
		} finally {
			if (codex?.lifecycleState === "open") await codex.stop();
			if (prevHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = prevHome;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}

	// cursor/* extensions -> handleExtensionRequest() -> host.requestInteraction.
	{
		const interactions = [];
		const host = { onEvent() {}, requestPermission: () => ({ outcome: "cancelled" }), requestInteraction: (m, p) => { interactions.push([m, p]); return { picked: true }; } };
		const cursor = createAdapter("cursor", CONFIGS.cursor, host, { connectionFactory: factoryFor(PROFILES.cursor) });
		await cursor.connect();
		assert.equal(cursor.capabilities.interactiveRequests, true);
		const result = await cursor.connection.emitCursor("cursor/ask_question", { question: "?" });
		assert.deepEqual(interactions, [["cursor/ask_question", { question: "?" }]]);
		assert.deepEqual(result, { picked: true });
		ok("extension:cursor-routed-to-host");
	}

	// permission auto-accept -> capability + generic autoPermissionOutcome.
	{
		const cursor = createAdapter("cursor", CONFIGS.cursor, noopHost(), { settings: { args: ["--force"] }, connectionFactory: factoryFor(PROFILES.cursor) });
		await cursor.connect();
		assert.equal(cursor.capabilities.autoApprove, true);
		const outcome = await cursor.connection.emitPermission({ options: [{ kind: "reject_once", optionId: "r" }, { kind: "allow_once", optionId: "a" }] });
		assert.deepEqual(outcome, { outcome: "selected", optionId: "a" });
		ok("permission:auto-accept");

		let asked = false;
		const host = { onEvent() {}, requestPermission: () => { asked = true; return { outcome: "selected", optionId: "manual" }; }, requestInteraction: () => undefined };
		const terminus = createAdapter("terminus-2", CONFIGS["terminus-2"], host, { connectionFactory: factoryFor(PROFILES["terminus-2"]) });
		await terminus.connect();
		assert.equal(terminus.capabilities.autoApprove, false);
		const manual = await terminus.connection.emitPermission({ options: [{ kind: "allow_once", optionId: "x" }] });
		assert.equal(asked, true);
		assert.equal(manual.optionId, "manual");
		ok("permission:manual-routed-to-host");
	}

	// The adapter decides allow/deny/ask UNIFORMLY via the engine — not just
	// autoApprove. Locks in that deny mode and explicit rules work over the adapter
	// path (regression guard for "moving cc onto adapters keeps behavior").
	{
		const options = [{ kind: "reject_once", optionId: "r" }, { kind: "allow_once", optionId: "a" }];
		const denyHost = () => { let asked = false; return { host: { onEvent() {}, requestPermission: () => { asked = true; return { outcome: "cancelled" }; }, requestInteraction: () => undefined }, asked: () => asked }; };

		// mode: deny -> actively reject without asking the host.
		const d = denyHost();
		const denyAdapter = createAdapter("terminus-2", CONFIGS["terminus-2"], d.host, {
			settings: { permissions: { mode: "deny" } },
			connectionFactory: factoryFor(PROFILES["terminus-2"]),
		});
		denyAdapter.setPermissionGrants([]);
		await denyAdapter.connect();
		const denied = await denyAdapter.connection.emitPermission({ options });
		assert.deepEqual(denied, { outcome: "selected", optionId: "r" });
		assert.equal(d.asked(), false);
		ok("permission:adapter-deny-mode");

		// An explicit allow rule resolves a matching tool to the NARROW allow option
		// (no bypass escalation); a non-matching tool still asks the host.
		const r = denyHost();
		const ruleAdapter = createAdapter("terminus-2", CONFIGS["terminus-2"], r.host, {
			settings: { permissions: { mode: "ask", rules: [{ tool: "Run tests", action: "allow" }] } },
			connectionFactory: factoryFor(PROFILES["terminus-2"]),
		});
		ruleAdapter.setPermissionGrants([]);
		await ruleAdapter.connect();
		const ruled = await ruleAdapter.connection.emitPermission({ toolCall: { title: "Run tests" }, options });
		assert.deepEqual(ruled, { outcome: "selected", optionId: "a" });
		assert.equal(r.asked(), false);
		const other = await ruleAdapter.connection.emitPermission({ toolCall: { title: "Delete repo" }, options });
		assert.equal(r.asked(), true);
		assert.deepEqual(other, { outcome: "cancelled" });
		ok("permission:adapter-rule-narrow-and-ask");
	}

	// auto-accept must ALSO cover interactive cursor prompts (ask_question /
	// create_plan) — the YOLO-mode behavior, not just tool permissions.
	{
		const cursor = createAdapter("cursor", CONFIGS.cursor, noopHost(), { settings: { args: ["--yolo"] }, connectionFactory: factoryFor(PROFILES.cursor) });
		await cursor.connect();
		assert.equal(cursor.capabilities.autoApprove, true);
		const plan = await cursor.connection.emitCursor("cursor/create_plan", { name: "P" });
		assert.deepEqual(plan, { outcome: { outcome: "accepted" } });
		const answered = await cursor.connection.emitCursor("cursor/ask_question", { questions: [{ id: "q1", options: [{ id: "o1" }, { id: "o2" }] }] });
		assert.deepEqual(answered, { outcome: { outcome: "answered", answers: [{ questionId: "q1", selectedOptionIds: ["o1"] }] } });
		ok("extension:auto-accept-interactive");
	}

	// deny mode must AUTO-REJECT cursor extension prompts, not fall through to the host.
	{
		let asked = false;
		const host = { onEvent() {}, requestPermission: () => ({ outcome: "cancelled" }), requestInteraction: () => { asked = true; return { picked: true }; } };
		const cursor = createAdapter("cursor", CONFIGS.cursor, host, { settings: { permissions: { mode: "deny" } }, connectionFactory: factoryFor(PROFILES.cursor) });
		await cursor.connect();
		const plan = await cursor.connection.emitCursor("cursor/create_plan", { name: "P" });
		assert.deepEqual(plan, { outcome: { outcome: "rejected", reason: "Cancelled" } });
		const q = await cursor.connection.emitCursor("cursor/ask_question", { questions: [{ id: "q1", options: [{ id: "o1" }] }] });
		assert.deepEqual(q, { outcome: { outcome: "cancelled" } });
		assert.equal(asked, false, "deny mode must not prompt the host for cursor extensions");
		ok("extension:deny-auto-rejects");
	}

	// A deny RULE under auto mode must also reject cursor extension prompts (mode
	// alone is not enough — cursor prompts run through the policy engine).
	{
		let asked = false;
		const host = { onEvent() {}, requestPermission: () => ({ outcome: "cancelled" }), requestInteraction: () => { asked = true; return { picked: true }; } };
		const cursor = createAdapter("cursor", CONFIGS.cursor, host, {
			settings: { permissions: { mode: "auto", rules: [{ tool: "*", action: "deny" }] } },
			connectionFactory: factoryFor(PROFILES.cursor),
		});
		await cursor.connect();
		const plan = await cursor.connection.emitCursor("cursor/create_plan", { name: "P" });
		assert.deepEqual(plan, { outcome: { outcome: "rejected", reason: "Cancelled" } });
		assert.equal(asked, false);
		ok("extension:deny-rule-rejects-under-auto");
	}

	// =====================================================================
	// (3) ADDABILITY — opencode + pi + a brand-new harness, no core changes.
	// =====================================================================
	{
		// Claude declares the adapter protocol identity/version at its adapter
		// boundary as well as in the production registry defaults.
		const claude = createAdapter("claude", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.claude) });
		assert.equal(claude.launchSpec._requiredAgentName, "@agentclientprotocol/claude-agent-acp");
		assert.equal(claude.launchSpec._minimumAgentVersion, "0.59.0");
		assert.equal(claude.launchSpec._packageLocalAcpCommand, "claude-agent-acp");
		assert.equal(claude.launchSpec._packageLocalAcpVersion, "0.59.0");
		ok("adapter-default:claude-identity-version");

		// opencode/pi resolve from their own defaultAgentConfig (no DEFAULT_CONFIG edit).
		const oc = createAdapter("opencode", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.opencode) });
		assertAdapterConformance(oc);
		assert.deepEqual(oc.launchSpec.acp, { command: "opencode", args: ["acp"] });
		assert.equal(oc.launchSpec._requiredAgentName, "OpenCode");
		assert.equal(oc.launchSpec._packageLocalAcpPackageName, "opencode-ai");
		assert.equal(oc.launchSpec._packageLocalAcpVersion, "1.18.3");
		await oc.connect();
		assert.equal(oc.capabilities.fork, "native");
		assert.equal(oc.capabilities.mcp, true);
		assert.deepEqual(oc.capabilities.checkpointModes, ["both", "conversation", "code"]);
		ok("addability:opencode");

		const pi = createAdapter("pi", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.pi) });
		assertAdapterConformance(pi);
		await pi.connect();
		assert.equal(pi.capabilities.fork, false); // pi-acp advertises no fork -> /btw dark
		assert.equal(pi.capabilities.models, true);
		assert.deepEqual(pi.capabilities.checkpointModes, ["conversation"]);
		ok("addability:pi");

		// a brand-new harness registered at runtime — no interface/base/cc edit.
		class AcmeAdapter extends BaseAcpAdapter {
			static defaultAgentConfig = { label: "Acme", transport: "acp", acp: { command: "acme", args: ["acp"] } };
		}
		registerAdapter("acme", AcmeAdapter);
		const acme = createAdapter("acme", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.opencode) });
		assertAdapterConformance(acme);
		await acme.connect();
		assert.equal(acme.capabilities.fork, "native");
		ok("addability:runtime-registration");
	}

	// =====================================================================
	// (2d) NO FEATURES LOST — base adapter works over the REAL ACP transport
	//      (spawns tests/fake_acp.py via the real AcpClient).
	// =====================================================================
	{
		const fakeConfig = { label: "Fake", transport: "acp", acp: { command: "python3", args: ["tests/fake_acp.py"] } };
		const events = [];
		const host = { onEvent: (e) => events.push(e), requestPermission: () => ({ outcome: "selected", optionId: "allow" }), requestInteraction: () => undefined };
		const connectionFactory = (agent, onEvent, options) => new AcpClient(agent, onEvent, options);
		const adapter = createAdapter("__fake__", fakeConfig, host, { connectionFactory });
		try {
			await adapter.connect();
			assert.equal(adapter.capabilities.fork, "native", "fake advertises fork");
			assert.equal(adapter.capabilities.resume, true);
			assert.equal(adapter.capabilities.sessionList, true);
			assert.equal(adapter.capabilities.image, true);
			assert.equal(adapter.capabilities.reasoningEffort, true, "fake advertises thought_level");
			assert.equal(adapter.capabilities.models, true);
			assert.equal(adapter.capabilities.modes, true);

			const result = await adapter.prompt("hello over the wire");
			assert.equal(result.stopReason, "end_turn");
			assert.ok(events.some((e) => e.type === "text"), "received streamed text");

			await adapter.setConfigOption("model", "deep");
			const sessions = await adapter.listSessions();
			assert.equal(sessions.length, 2, "fake lists 2 sessions");
			ok("real-transport:base-adapter");

			// native fork over the real transport on a fresh, sessionless adapter.
			const fork = createAdapter("__fake__", fakeConfig, host, { connectionFactory });
			await fork.connect({ createSession: false });
			assert.equal(fork.capabilities.fork, "native");
			await fork.fork("fake-session");
			fork.stop();
			ok("real-transport:native-fork");
		} finally {
			adapter.stop();
		}
	}

	console.log(`harness_adapter: ${passed} checks passed`);
}

main().catch((error) => {
	console.error("harness_adapter FAILED:", error?.stack ?? error);
	process.exit(1);
});
