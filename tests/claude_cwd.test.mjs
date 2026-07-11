import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { ClaudeAdapter } from "../src/harness/adapters/claude.mjs";
import { applyClaudeWorkingDirectory } from "../src/harness/claude-acp-bridge.mjs";
import { capabilitiesFromWire } from "../src/harness/interface.mjs";
import {
	directoryCompletionMatches,
	normalizeChangeWorkingDirectoryResponse,
	parseChangeWorkingDirectoryParams,
	resolveWorkingDirectoryTarget,
} from "../src/harness/working-directory.mjs";
import {
	AcpClient,
	HarnessApp,
	localSlashCommands,
	resolvePackageLocalAcpExecutable,
} from "../src/pi-harness.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-claude-cwd-"));
const first = path.join(root, "first");
const second = path.join(root, "second directory");
fs.mkdirSync(first);
fs.mkdirSync(second);

try {
	assert.deepEqual(parseChangeWorkingDirectoryParams({ sessionId: "s1", path: first }), {
		sessionId: "s1",
		path: first,
	});
	assert.throws(() => parseChangeWorkingDirectoryParams({ sessionId: "s1", path: "relative" }), /absolute path/u);
	assert.throws(() => parseChangeWorkingDirectoryParams({
		sessionId: "s1",
		path: first,
		trustAccepted: true,
	}), /requires trustedDirectory/u);
	assert.deepEqual(normalizeChangeWorkingDirectoryResponse({
		status: "ok",
		cwd: second,
		changed: true,
		transcript_relocated: true,
	}), { status: "ok", cwd: second, changed: true, transcript_relocated: true });
	assert.deepEqual(normalizeChangeWorkingDirectoryResponse({
		status: "needs_trust",
		directory: second,
	}), { status: "needs_trust", directory: second });
	assert.throws(
		() => normalizeChangeWorkingDirectoryResponse({ status: "future_success", cwd: second }),
		/unknown response status/u,
	);

	// The bridge updates both the live Query and the maintained adapter's project
	// settings watcher before publishing command/config refreshes. A transcript
	// relocation failure is still a successful cwd change and must not prevent the
	// SDK's project-independent checkpoint lookup from remaining usable.
	const bridgeEvents = [];
	const bridgeSession = {
		queryClosed: false,
		cwd: first,
		sessionFingerprint: JSON.stringify({ cwd: first, marker: true }),
		query: {
			async setCwd(target) {
				bridgeEvents.push(`query:${target}`);
				return { status: "ok", cwd: target, changed: true, transcript_relocated: false };
			},
		},
		settingsManager: {
			async setCwd(target) {
				bridgeEvents.push(`settings:start:${target}`);
				await Promise.resolve();
				bridgeEvents.push(`settings:end:${target}`);
			},
		},
	};
	const bridgeAgent = {
		sessions: { bridge: bridgeSession },
		async sendAvailableCommandsUpdate(sessionId) { bridgeEvents.push(`commands:${sessionId}`); },
	};
	assert.deepEqual(await applyClaudeWorkingDirectory(bridgeAgent, {
		sessionId: "bridge",
		path: second,
	}), {
		status: "ok",
		cwd: second,
		changed: true,
		transcript_relocated: false,
	});
	assert.equal(bridgeSession.cwd, second);
	assert.deepEqual(JSON.parse(bridgeSession.sessionFingerprint), { cwd: second, marker: true });
	assert.deepEqual(bridgeEvents, [
		`query:${second}`,
		`settings:start:${second}`,
		`settings:end:${second}`,
		"commands:bridge",
	]);

	let movedWithoutSettingsManager = false;
	await assert.rejects(() => applyClaudeWorkingDirectory({
		sessions: {
			unsafe: {
				queryClosed: false,
				query: { async setCwd() { movedWithoutSettingsManager = true; } },
			},
		},
	}, { sessionId: "unsafe", path: second }), /cannot refresh settings/u);
	assert.equal(movedWithoutSettingsManager, false, "bridge validates both cwd movers before changing either one");

	// The SDK Query moves first because it is the authority that can return a
	// trust challenge. If the adapter's settings watcher then rejects, compensate
	// both halves before reporting failure so the host can safely retain its cwd.
	const rollbackEvents = [];
	const rollbackSession = {
		queryClosed: false,
		cwd: first,
		sessionFingerprint: JSON.stringify({ cwd: first, stable: true }),
		query: {
			async setCwd(target, options) {
				rollbackEvents.push(["query", target, options]);
				return { status: "ok", cwd: target, changed: true, transcript_relocated: true };
			},
		},
		settingsManager: {
			async setCwd(target) {
				rollbackEvents.push(["settings", target]);
				if (target === second) throw new Error("settings watcher failed");
			},
		},
	};
	await assert.rejects(
		() => applyClaudeWorkingDirectory({ sessions: { rollback: rollbackSession } }, {
			sessionId: "rollback",
			path: second,
		}),
		/settings watcher failed/u,
	);
	assert.deepEqual(rollbackEvents, [
		["query", second, {}],
		["settings", second],
		["query", first, { trustAccepted: true, trustedDirectory: first }],
		["settings", first],
	]);
	assert.equal(rollbackSession.cwd, first);
	assert.deepEqual(JSON.parse(rollbackSession.sessionFingerprint), { cwd: first, stable: true });

	// If either compensating move fails, keeping the live Query would let tools
	// run in a directory the host rejected. Tear down that session and require a
	// reconnect instead of publishing a falsely restored in-memory cwd.
	let invalidatedSession;
	const unsafeRollbackSession = {
		queryClosed: false,
		cwd: first,
		sessionFingerprint: JSON.stringify({ cwd: first }),
		query: {
			async setCwd(target) {
				if (target === first) throw new Error("query rollback failed");
				return { status: "ok", cwd: target, changed: true, transcript_relocated: true };
			},
		},
		settingsManager: {
			async setCwd(target) {
				if (target === second) throw new Error("settings destination failed");
			},
		},
	};
	const unsafeRollbackAgent = {
		sessions: { unsafeRollback: unsafeRollbackSession },
		async closeSession({ sessionId }) {
			invalidatedSession = sessionId;
			unsafeRollbackSession.queryClosed = true;
			delete this.sessions[sessionId];
		},
	};
	await assert.rejects(
		() => applyClaudeWorkingDirectory(unsafeRollbackAgent, {
			sessionId: "unsafeRollback",
			path: second,
		}),
		/could not be rolled back safely/u,
	);
	assert.equal(invalidatedSession, "unsafeRollback");
	assert.equal(unsafeRollbackSession.queryClosed, true);
	assert.equal(unsafeRollbackAgent.sessions.unsafeRollback, undefined);

	// Project-derived model, agent, fast-mode, config and command state refreshes
	// from the SDK only after SettingsManager has adopted the destination.
	const refreshEvents = [];
	const initializedModels = [
		{ value: "default", displayName: "Default", description: "", supportsAutoMode: true },
		{ value: "sonnet", displayName: "Sonnet", description: "", supportsAutoMode: true, supportsFastMode: true },
		{ value: "opus", displayName: "Opus", description: "", supportsAutoMode: true },
	];
	let projectSettings = { availableModels: ["opus"] };
	const refreshedSession = {
		queryClosed: false,
		cwd: first,
		sessionFingerprint: JSON.stringify({ cwd: first }),
		query: {
			async setCwd(target) {
				refreshEvents.push("query:set-cwd");
				return { status: "ok", cwd: target, changed: true, transcript_relocated: true };
			},
			async reinitialize() {
				refreshEvents.push(`query:reinitialize:${projectSettings.availableModels.join(",")}`);
				return {
					models: initializedModels,
					agents: [{ name: "reviewer", description: "Project reviewer" }],
					fast_mode_state: "off",
				};
			},
			async getContextUsage() { return { model: "sonnet" }; },
			async applyFlagSettings(value) { refreshEvents.push(["flags", value]); },
		},
		settingsManager: {
			async setCwd() {
				refreshEvents.push("settings:set-cwd");
				projectSettings = { availableModels: ["sonnet"] };
			},
			getSettings() { return projectSettings; },
		},
		models: { currentModelId: "opus", availableModels: [] },
		modelInfos: [],
		modes: { currentModeId: "default", availableModes: [] },
		configOptions: [{ id: "model", type: "select", currentValue: "opus", options: [] }],
		agents: [{ name: "old-project-agent" }],
		currentAgent: "old-project-agent",
		fastModeEnabled: true,
	};
	const refreshedAgent = {
		sessions: { refreshed: refreshedSession },
		client: {
			async sessionUpdate(value) { refreshEvents.push(["config-update", value]); },
		},
		async applyConfigOptionValue(_sessionId, _session, configId, value) {
			refreshEvents.push(["apply-config", configId, value]);
		},
		async sendAvailableCommandsUpdate(sessionId) { refreshEvents.push(["commands", sessionId]); },
	};
	await applyClaudeWorkingDirectory(refreshedAgent, { sessionId: "refreshed", path: second });
	assert.equal(refreshedSession.models.currentModelId, "sonnet");
	assert.deepEqual(refreshedSession.models.availableModels.map((model) => model.modelId), ["default", "sonnet"]);
	assert.deepEqual(refreshedSession.agents.map((agent) => agent.name), ["reviewer"]);
	assert.equal(refreshedSession.currentAgent, "default");
	assert.equal(refreshedSession.fastModeEnabled, false);
	assert.ok(refreshEvents.indexOf("settings:set-cwd") < refreshEvents.findIndex((event) =>
		typeof event === "string" && event.startsWith("query:reinitialize:")));
	assert.ok(refreshEvents.some((event) => Array.isArray(event) && event[0] === "apply-config" && event[2] === "sonnet"));
	assert.deepEqual(refreshEvents.at(-1), ["commands", "refreshed"]);

	assert.equal(resolveWorkingDirectoryTarget("../second directory", first), fs.realpathSync(second));
	const completions = directoryCompletionMatches("sec", root);
	assert.equal(completions.length, 1);
	assert.equal(completions[0].label, `second directory${path.sep}`);
	assert.equal(completions[0].value, `"second directory${path.sep}"`);

	// A bare home shorthand is expanded only for reading the directory. Its
	// completion must retain `~/` so accepting it does not produce a cwd-relative
	// path such as `.config/`. Existing separators and partial names are retained.
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;
	const completionHome = path.join(root, "completion-home");
	const hiddenHomeDirectory = ".cc-home-completion-fixture";
	fs.mkdirSync(path.join(completionHome, hiddenHomeDirectory), { recursive: true });
	process.env.HOME = completionHome;
	process.env.USERPROFILE = completionHome;
	try {
		const bareHomeMatch = directoryCompletionMatches("~", root)
			.find((match) => match.label === `${hiddenHomeDirectory}${path.sep}`);
		assert.equal(bareHomeMatch?.value, `~${path.sep}${hiddenHomeDirectory}${path.sep}`);

		const separatedHomeMatch = directoryCompletionMatches(`~${path.sep}`, root)
			.find((match) => match.label === `${hiddenHomeDirectory}${path.sep}`);
		assert.equal(separatedHomeMatch?.value, `~${path.sep}${hiddenHomeDirectory}${path.sep}`);

		const partialHomeMatch = directoryCompletionMatches(`~${path.sep}.cc-home`, root)
			.find((match) => match.label === `${hiddenHomeDirectory}${path.sep}`);
		assert.equal(partialHomeMatch?.value, `~${path.sep}${hiddenHomeDirectory}${path.sep}`);
	} finally {
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = originalUserProfile;
	}

	const advertised = { capabilities: { _meta: { cc: { changeWorkingDirectory: true } } } };
	assert.equal(capabilitiesFromWire(advertised).changeWorkingDirectory, true);
	assert.equal(capabilitiesFromWire({ capabilities: {} }).changeWorkingDirectory, false);

	// AcpClient sends the bounded extension request only after negotiation.
	const extensionClient = Object.create(AcpClient.prototype);
	Object.assign(extensionClient, {
		sessionId: "session-cwd",
		capabilities: advertised.capabilities,
		agentInfo: {},
		authMethods: [],
		configOptions: [],
		models: undefined,
		modes: undefined,
		sessionInfo: {},
	});
	let extensionRequest;
	extensionClient.request = async (method, params) => {
		extensionRequest = { method, params };
		return { status: "ok", cwd: second, changed: true, transcript_relocated: true };
	};
	assert.deepEqual(await extensionClient.changeWorkingDirectory(second), {
		status: "ok",
		cwd: second,
		changed: true,
		transcript_relocated: true,
	});
	assert.equal(extensionRequest.method, "cc/session/change_cwd");
	assert.deepEqual(extensionRequest.params, { sessionId: "session-cwd", path: second });

	let fallbackCalled = false;
	const noCapabilityClient = Object.create(AcpClient.prototype);
	Object.assign(noCapabilityClient, {
		sessionId: "session-no-cwd",
		capabilities: {},
		agentInfo: {},
		authMethods: [],
		configOptions: [],
		sessionInfo: {},
		request: async () => { fallbackCalled = true; },
	});
	await assert.rejects(noCapabilityClient.changeWorkingDirectory(second), /does not advertise/u);
	assert.equal(fallbackCalled, false, "no unnegotiated extension fallback is attempted");

	// The real bridge preserves the maintained adapter's identity/capabilities
	// while adding only cc's negotiated extension (no Claude session is started).
	const bridgeClient = new AcpClient({
		label: "Claude Code",
		_requiredAgentName: "@agentclientprotocol/claude-agent-acp",
		_minimumAgentVersion: "0.58.1",
		acp: {
			command: process.execPath,
			args: [path.join(process.cwd(), "src", "harness", "claude-acp-bridge.mjs")],
		},
	}, () => {});
	try {
		await bridgeClient.initialize({ createSession: false });
		assert.equal(bridgeClient.agentInfo.name, "@agentclientprotocol/claude-agent-acp");
		assert.equal(bridgeClient.capabilities._meta.cc.changeWorkingDirectory, true);
		assert.equal(bridgeClient.capabilities._meta.cc.backgroundTasks, true);
		assert.equal(bridgeClient.capabilities._meta.cc.remoteControl, true);
		assert.equal(Boolean(bridgeClient.capabilities.sessionCapabilities.fork), true);
	} finally {
		await bridgeClient.stopAndWait().catch(() => {});
	}

	// The extension is also available through the unified HarnessAdapter.
	const fakeConnection = {
		capabilities: advertised.capabilities,
		sessionId: "adapter-session",
		async initialize() { return {}; },
		async newSession() {},
		async prompt() {},
		cancel() {},
		stop() {},
		getSessionInfo() { return { capabilities: this.capabilities }; },
		async changeWorkingDirectory(target, options) { return { target, options }; },
	};
	const adapter = new BaseAcpAdapter("fake", { label: "Fake", acp: { command: "fake", args: [] } }, {}, {
		connectionFactory: () => fakeConnection,
	});
	await adapter.connect({ createSession: false });
	assert.equal(adapter.capabilities.changeWorkingDirectory, true);
	assert.deepEqual(await adapter.changeWorkingDirectory(second, { trustAccepted: false }), {
		target: second,
		options: { trustAccepted: false },
	});
	const declaredClaude = new ClaudeAdapter("claude", ClaudeAdapter.defaultAgentConfig, {}, {
		connectionFactory: () => fakeConnection,
	});
	assert.equal(declaredClaude.capabilities.changeWorkingDirectory, true);
	assert.equal(declaredClaude.capabilities.fork, "native");
	const explicitCustom = new ClaudeAdapter("claude", {
		...ClaudeAdapter.defaultAgentConfig,
		acp: { command: "/custom/claude-acp", args: [] },
	}, {}, { connectionFactory: () => fakeConnection });
	assert.equal(explicitCustom.capabilities.changeWorkingDirectory, false);
	assert.equal(explicitCustom.capabilities.fork, false);

	// Local ownership follows the unified capability. Without it, a native /cd
	// remains a backend command rather than being shadowed by a broken fallback.
	const routeApp = (hasCapability, backendCommands = []) => {
		const app = Object.create(HarnessApp.prototype);
		const capabilities = { changeWorkingDirectory: hasCapability };
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			activeAgentGeneration: 0,
			client: { capabilities },
			config: { agents: { fake: { label: "Fake" } } },
			sessionStates: new Map([["fake", { capabilities }]]),
			themeName: "system",
			availableCommands: new Map([["fake", backendCommands.map((name) => ({ name }))]]),
			commandsLoaded: new Set(["fake"]),
			sessionSwitchInProgress: false,
			focusedThread: "main",
			isCodexBackendActive: () => false,
		});
		return app;
	};
	const local = routeApp(true, ["cd"]);
	assert.equal(localSlashCommands(local).some((entry) => entry.name === "cd"), true);
	assert.equal(local.slashCommandRoute("cd", second), "local");
	const nativeFallback = routeApp(false, ["cd"]);
	assert.equal(localSlashCommands(nativeFallback).some((entry) => entry.name === "cd"), false);
	assert.equal(nativeFallback.slashCommandRoute("cd", second), "backend");
	const unsupported = routeApp(false, []);
	assert.equal(unsupported.slashCommandRoute("cd", second), "unknown");
	nativeFallback.focusedThread = "btw";
	assert.equal(nativeFallback.slashCommandRoute("cd", second), "local", "side threads reject /cd locally");

	// Host cwd, cache scope, and autocomplete change only after the backend
	// succeeds. Trust attestation echoes the exact canonical directory.
	const originalCwd = process.cwd();
	try {
		process.chdir(first);
		const canonicalFirst = fs.realpathSync(first);
		const canonicalSecond = fs.realpathSync(second);
		const events = [];
		let catalogCwd = canonicalFirst;
		let call = 0;
		let trustOptions;
		const client = {
			exited: false,
			sessionId: "live",
			capabilities: { changeWorkingDirectory: true },
			async changeWorkingDirectory(_target, options) {
				call += 1;
				events.push(`backend:${call}`);
				if (call === 1) return { status: "needs_trust", directory: canonicalSecond };
				trustOptions = options;
				app.handleBackendEvent({ type: "commands", commands: [{ name: "destination-command" }] });
				return { status: "ok", cwd: canonicalSecond, changed: true, transcript_relocated: true };
			},
		};
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			activeAgentGeneration: 0,
			config: { agents: { fake: {} } },
			client,
			ready: true,
			busy: false,
			focusedThread: "main",
			btwThread: undefined,
			sessionSwitchInProgress: false,
			selectionActionInProgress: false,
			configUpdateTokens: new Set(),
			configUpdateCount: 0,
			asyncPickerLoadCount: 0,
			deferredLocalSlashCommands: [{ name: "clear", argument: "", queuedInputOrder: 1 }],
			backendCommandCacheTimers: new Map(),
			availableCommands: new Map([["fake", [{ name: "old" }]]]),
			commandsLoaded: new Set(["fake"]),
			backendCommandCatalog: {
				persist: () => events.push("cache:persist"),
				setCwd: (cwd) => { catalogCwd = cwd; events.push(`cache:cwd:${cwd}`); },
				remember: (_key, commands) => {
					events.push(`cache:remember:${catalogCwd}:${commands.map((command) => command.name).join(",")}`);
					return false;
				},
			},
			editor: { autocompleteProvider: { setBasePath: (cwd) => events.push(`autocomplete:${cwd}`) } },
			ui: { requestRender() {} },
			updateSpinner() {},
			updateAutocomplete: () => events.push("autocomplete:refresh"),
			addCommandMessage: (message) => events.push(`command:${message}`),
			addNotice: (message) => events.push(`notice:${app.configUpdateCount}:${message}`),
			addError: (message) => assert.fail(message),
			closeMenu() { app.menuHandle = undefined; },
			schedulePromptQueueDrain() {},
			async flushDeferredLocalSlashCommands() {
				events.push(`deferred:${process.cwd()}`);
				app.deferredLocalSlashCommands = [];
			},
		});
		let trustDialog;
		app.openSelection = (title, entries, onSelect) => {
			events.push(`dialog:${app.configUpdateCount}`);
			app.menuHandle = {};
			trustDialog = { title, entries, onSelect };
		};
		await app.runChangeWorkingDirectory(second);
		assert.equal(process.cwd(), canonicalFirst, "trust challenge cannot mutate host cwd");
		assert.equal(trustDialog.title, `Move this session to ${canonicalSecond}?`);
		assert.ok(events.includes("dialog:1"), "the config gate remains held until the trust dialog is installed");
		assert.equal(events.some((entry) => entry.startsWith("deferred:")), false);
		await trustDialog.onSelect({ value: "trust" });
		assert.equal(process.cwd(), fs.realpathSync(second));
		assert.deepEqual(trustOptions, { trustAccepted: true, trustedDirectory: canonicalSecond });
		assert.ok(events.indexOf("backend:2") < events.indexOf(`cache:cwd:${canonicalSecond}`));
		assert.deepEqual(app.availableCommands.get("fake"), [{ name: "destination-command" }]);
		assert.ok(events.includes(`cache:remember:${canonicalSecond}:destination-command`));
		assert.equal(events.some((entry) => entry === `cache:remember:${canonicalFirst}:destination-command`), false);
		assert.ok(events.includes(`deferred:${canonicalSecond}`), "deferred session commands flush only after cwd commit");
	} finally {
		process.chdir(originalCwd);
	}

	// If the destination disappears after the backend has committed its move,
	// process.chdir() can fail even though Claude is already using the new cwd.
	// Fence that exact session immediately and keep replacements isolated from its
	// asynchronous teardown.
	const missingAfterBackendMove = path.join(root, "removed-after-backend-move");
	const makeDivergedCwdApp = (client) => {
		const errors = [];
		const agentDefinition = {};
		const app = Object.create(HarnessApp.prototype);
		Object.assign(app, {
			activeKey: "fake",
			transport: "acp",
			activeAgentGeneration: 0,
			config: { agents: { fake: agentDefinition } },
			client,
			ready: true,
			busy: false,
			sessionSwitchInProgress: false,
			statusState: "",
			promptQueue: [],
			replacementProcessFence: undefined,
			workingDirectoryShutdownTail: undefined,
			ui: { requestRender() {} },
			updateSpinner() {},
			cancelPermissionPrompts() {},
			clearCancelGraceTimer() {},
			clearLiveBackendCommands() { return true; },
			addError(message) { errors.push(message); },
			reportReplacementProcessFence() {},
		});
		const context = app.captureActiveAgentContext({ includeClient: true });
		app.workingDirectoryCommandTransition = { context, commands: [{ name: "unsafe-destination-command" }] };
		return { app, context, errors };
	};

	let releaseUnsafeBackend;
	let unsafeBackendStopCalls = 0;
	const unsafeBackend = {
		exited: false,
		stopAndWait() {
			unsafeBackendStopCalls += 1;
			return new Promise((resolve) => { releaseUnsafeBackend = resolve; });
		},
	};
	const fenced = makeDivergedCwdApp(unsafeBackend);
	assert.equal(fenced.app.commitWorkingDirectoryChange({
		status: "ok",
		cwd: missingAfterBackendMove,
		changed: true,
		transcript_relocated: true,
	}, fenced.context), false);
	assert.equal(unsafeBackendStopCalls, 1, "the mismatched backend is signalled before commit returns");
	assert.equal(fenced.app.ready, false);
	assert.equal(fenced.app.sessionSwitchInProgress, true, "prompts and local shell stay gated during teardown");
	assert.equal(fenced.app.client, unsafeBackend);
	assert.match(fenced.errors.at(-1), /mismatched session was disconnected/u);
	const fencedShutdown = fenced.app.workingDirectoryShutdownTail;
	let replacementStarted = false;
	fenced.app.switchAgentUnlocked = async () => { replacementStarted = true; };
	const replacementAttempt = fenced.app.switchAgent("fake", "acp");
	await Promise.resolve();
	assert.equal(replacementStarted, false, "a replacement waits for the mismatched process tree");
	releaseUnsafeBackend();
	await Promise.all([fencedShutdown, replacementAttempt]);
	assert.equal(replacementStarted, true);
	assert.equal(fenced.app.client, undefined);
	assert.equal(fenced.app.ready, false);
	assert.equal(fenced.app.sessionSwitchInProgress, false);

	let releaseSupersededBackend;
	const supersededBackend = {
		exited: false,
		stopAndWait() { return new Promise((resolve) => { releaseSupersededBackend = resolve; }); },
	};
	const replacement = { exited: false, name: "replacement" };
	const superseded = makeDivergedCwdApp(supersededBackend);
	assert.equal(superseded.app.commitWorkingDirectoryChange({
		status: "ok",
		cwd: missingAfterBackendMove,
		changed: true,
		transcript_relocated: true,
	}, superseded.context), false);
	const supersededShutdown = superseded.app.workingDirectoryShutdownTail;
	// Simulate a lifecycle owner installing a newer client before the old bounded
	// stop settles. The old finalizer must not detach or disable that replacement.
	Object.assign(superseded.app, {
		client: replacement,
		ready: true,
		sessionSwitchInProgress: false,
		statusState: "ready",
	});
	releaseSupersededBackend();
	await supersededShutdown;
	assert.equal(superseded.app.client, replacement);
	assert.equal(superseded.app.ready, true);
	assert.equal(superseded.app.sessionSwitchInProgress, false);
	assert.equal(superseded.app.statusState, "ready");

	const unconfirmedStop = Object.assign(new Error("process tree still running"), {
		code: "PROCESS_TREE_TERMINATION_FAILED",
	});
	const unfencedBackend = {
		exited: false,
		stopAndWait() { return Promise.reject(unconfirmedStop); },
	};
	const unconfirmed = makeDivergedCwdApp(unfencedBackend);
	assert.equal(unconfirmed.app.commitWorkingDirectoryChange({
		status: "ok",
		cwd: missingAfterBackendMove,
		changed: true,
		transcript_relocated: true,
	}, unconfirmed.context), false);
	await unconfirmed.app.workingDirectoryShutdownTail;
	assert.equal(unconfirmed.app.replacementProcessFence, unconfirmedStop);
	assert.equal(unconfirmed.app.client, undefined);
	assert.equal(unconfirmed.app.ready, false);

	// The bridge wins only when its pinned package-local adapter exists. An
	// explicit acp.command remains untouched.
	const installRoot = path.join(root, "install");
	const packageRoot = path.join(installRoot, "node_modules", "@agentclientprotocol", "claude-agent-acp");
	const entrypoint = path.join(packageRoot, "dist", "index.js");
	const bridge = path.join(installRoot, "src", "harness", "claude-acp-bridge.mjs");
	fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
	fs.mkdirSync(path.dirname(bridge), { recursive: true });
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@agentclientprotocol/claude-agent-acp",
		version: "0.58.1",
		bin: { "claude-agent-acp": "dist/index.js" },
	}));
	fs.writeFileSync(entrypoint, "// adapter\n");
	fs.writeFileSync(bridge, "// bridge\n");
	const packageAgent = {
		_requiredAgentName: "@agentclientprotocol/claude-agent-acp",
		_minimumAgentVersion: "0.58.1",
		_packageLocalAcpVersion: "0.58.1",
		_packageLocalAcpCommand: "claude-agent-acp",
		_packageLocalAcpBridge: bridge,
		acp: { command: "claude-agent-acp", args: [] },
	};
	assert.deepEqual(resolvePackageLocalAcpExecutable(packageAgent, installRoot), {
		executable: process.execPath,
		prefixArgs: [fs.realpathSync(bridge)],
	});
	assert.equal(resolvePackageLocalAcpExecutable({
		...packageAgent,
		acp: { command: "/custom/claude-acp", args: [] },
	}, installRoot), undefined);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("claude cwd tests passed");
