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
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyHarnessSettings } from "../src/pi-harness.mjs";
import { BaseAcpAdapter } from "../src/harness/acp-base.mjs";
import { assertAdapterConformance, checkAdapterConformance, emptyCapabilities, REQUIRED_METHODS } from "../src/harness/interface.mjs";
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
		this.capabilities = this.profile.capabilities ?? {};
		this.agentInfo = this.profile.agentInfo ?? {};
		this.authMethods = this.profile.authMethods ?? [];
		if (options.createSession !== false) await this.newSession();
		return { agentCapabilities: this.capabilities, agentInfo: this.agentInfo, authMethods: this.authMethods };
	}
	async newSession() {
		this.sessionId = this.profile.sessionId ?? "fake-session";
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
	async loadSession(id) {
		this.calls.push(["loadSession", id]);
		this.sessionId = id;
		this.onEvent?.({ type: "session_info", sessionInfo: this.getSessionInfo() });
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
}

function factoryFor(profile) {
	return (agent, onEvent, options) => new FakeConnection(agent, onEvent, options, profile);
}

// Simulated wire capabilities per harness (mirrors the audit's findings).
const PROFILES = {
	codex: {
		agentInfo: { name: "codex-acp" },
		capabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} }, promptCapabilities: { image: false } },
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
		agentInfo: { name: "opencode" },
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
		agentInfo: { name: "pi-acp" },
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

const noopHost = () => ({ onEvent() {}, requestPermission: () => ({ outcome: "cancelled" }), requestInteraction: () => undefined });

async function main() {
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

	// =====================================================================
	// (2a) NO FEATURES LOST — capability gating matches the audit.
	// =====================================================================
	const EXPECTED = {
		codex: { fork: "copy", resume: true, sessionList: true, models: true, modes: true, reasoningEffort: true, image: false, retractPrompt: true, interactiveRequests: false },
		claude: { fork: "native", resume: true, sessionList: true, models: false, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false },
		cursor: { fork: false, resume: false, sessionList: false, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: true },
		"terminus-2": { fork: false, resume: false, sessionList: false, models: false, modes: true, reasoningEffort: false, image: false, retractPrompt: false, interactiveRequests: false },
		"mini-swe-agent": { fork: false, resume: false, sessionList: false, models: false, modes: false, reasoningEffort: false, image: false, retractPrompt: false, interactiveRequests: false },
		opencode: { fork: "native", resume: true, sessionList: true, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false, mcp: true },
		pi: { fork: false, resume: true, sessionList: true, models: true, modes: true, reasoningEffort: false, image: true, retractPrompt: false, interactiveRequests: false },
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
			codex: { config: { model: "gpt-5", approval_policy: "never", sandbox_mode: "danger-full-access" } },
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
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-fork-"));
		try {
			process.env.CODEX_HOME = dir;
			const parentId = "11111111-1111-1111-1111-111111111111";
			const day = path.join(dir, "sessions", "2026", "06", "23");
			fs.mkdirSync(day, { recursive: true });
			const rollout = path.join(day, `rollout-2026-06-23T12-00-00-${parentId}.jsonl`);
			fs.writeFileSync(rollout, `${JSON.stringify({ thread_id: parentId, type: "meta" })}\n${JSON.stringify({ thread_id: parentId, type: "msg" })}\n`);

			const codex = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) });
			await codex.connect({ createSession: false });
			assert.equal(codex.capabilities.fork, "copy");
			await codex.fork(parentId);
			// loadSession set the session id to the new (copied) uuid.
			assert.notEqual(codex.sessionId, parentId);
			assert.match(codex.sessionId, /^[0-9a-f-]{36}$/);
			// the copy exists, named with the new id, with the id rewritten inside.
			const copied = path.join(day, `rollout-2026-06-23T12-00-00-${codex.sessionId}.jsonl`);
			assert.ok(fs.existsSync(copied), "copied rollout exists");
			const copiedText = fs.readFileSync(copied, "utf8");
			assert.ok(copiedText.includes(codex.sessionId) && !copiedText.includes(parentId), "ids rewritten in copy");
			ok("fork:codex-copy-e2e");
		} finally {
			if (prevHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = prevHome;
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
		try {
			process.env.CODEX_HOME = dir;
			const codex = createAdapter("codex", CONFIGS.codex, noopHost(), { connectionFactory: factoryFor(PROFILES.codex) });
			await codex.connect();
			// retractPrompt is gated on the live wire identity (agentInfo.name === "codex-acp").
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

	// =====================================================================
	// (3) ADDABILITY — opencode + pi + a brand-new harness, no core changes.
	// =====================================================================
	{
		// opencode/pi resolve from their own defaultAgentConfig (no DEFAULT_CONFIG edit).
		const oc = createAdapter("opencode", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.opencode) });
		assertAdapterConformance(oc);
		assert.deepEqual(oc.launchSpec.acp, { command: "opencode", args: ["acp"] });
		await oc.connect();
		assert.equal(oc.capabilities.fork, "native");
		assert.equal(oc.capabilities.mcp, true);
		ok("addability:opencode");

		const pi = createAdapter("pi", undefined, noopHost(), { connectionFactory: factoryFor(PROFILES.pi) });
		assertAdapterConformance(pi);
		await pi.connect();
		assert.equal(pi.capabilities.fork, false); // pi-acp advertises no fork -> /btw dark
		assert.equal(pi.capabilities.models, true);
		ok("addability:pi");

		// opencode/pi are *thin*: zero overridden prototype methods beyond constructor.
		for (const adapter of [oc, pi]) {
			const overrides = Object.getOwnPropertyNames(Object.getPrototypeOf(adapter).constructor.prototype).filter((n) => n !== "constructor");
			assert.deepEqual(overrides, [], `${adapter.key} adapter should override nothing`);
		}
		ok("addability:thin-adapters");

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
		const adapter = createAdapter("__fake__", fakeConfig, host); // default factory = real AcpClient
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
			const fork = createAdapter("__fake__", fakeConfig, host);
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
