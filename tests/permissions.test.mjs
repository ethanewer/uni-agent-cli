import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	classifyOption,
	coercePermissionMode,
	decidePermission,
	forgetGrants,
	inferModeFromNative,
	isAlwaysOption,
	loadGrants,
	matchRule,
	nativePermissionConfig,
	normalizePermissionSettings,
	normalizeRule,
	outcomeForDecision,
	permissionRequestInfo,
	pickAllowOption,
	pickDenyOption,
	recordGrant,
	resolvePermissionPolicy,
	ruleKey,
	saveGrants,
	selectedOutcome,
} from "../src/harness/permissions.mjs";

let passed = 0;
function check(name, fn) {
	fn();
	passed += 1;
}

// Mirrors fake_acp.py /permission-test options.
const FAKE_OPTIONS = [
	{ kind: "reject_once", name: "Reject", optionId: "reject" },
	{ kind: "allow_once", name: "Allow", optionId: "allow" },
];
const ALWAYS_OPTIONS = [
	{ kind: "reject_always", name: "Reject", optionId: "reject" },
	{ kind: "allow_once", name: "Allow once", optionId: "allow-once" },
	{ kind: "allow_always", name: "Allow always", optionId: "allow-always" },
	{ kind: "allow_always", name: "Bypass", optionId: "bypassPermissions" },
];

// ---- mode coercion --------------------------------------------------------

check("coercePermissionMode canonicalizes aliases", () => {
	assert.equal(coercePermissionMode("ask"), "ask");
	assert.equal(coercePermissionMode("YOLO"), "auto");
	assert.equal(coercePermissionMode("bypassPermissions"), "auto");
	assert.equal(coercePermissionMode("Allow All"), "auto");
	assert.equal(coercePermissionMode("deny"), "deny");
	assert.equal(coercePermissionMode("off"), "deny");
	assert.equal(coercePermissionMode("nonsense"), undefined);
	assert.equal(coercePermissionMode(42), undefined);
});

// ---- rules ----------------------------------------------------------------

check("normalizeRule validates shape", () => {
	assert.deepEqual(normalizeRule({ tool: "read", action: "allow" }), { tool: "read", action: "allow" });
	assert.deepEqual(normalizeRule({ tool: "*", action: "deny", agent: "codex" }), { tool: "*", action: "deny", agent: "codex" });
	assert.equal(normalizeRule({ tool: "read" }), undefined);
	assert.equal(normalizeRule({ action: "allow" }), undefined);
	assert.equal(normalizeRule({ tool: "read", action: "maybe" }), undefined);
	assert.equal(normalizeRule("nope"), undefined);
});

check("matchRule honors wildcard, tool/kind, and agent scope", () => {
	const rules = [
		{ tool: "git status", action: "allow" },
		{ tool: "read", action: "allow", agent: "codex" },
		{ tool: "*", action: "deny" },
	];
	const info = (toolName, kind) => ({ toolName, kind, options: [] });
	assert.deepEqual(matchRule(rules, info("git status"), "claude"), { tool: "git status", action: "allow" });
	// agent-scoped rule does not apply to a different agent; falls to wildcard
	assert.deepEqual(matchRule(rules, info("read"), "claude"), { tool: "*", action: "deny" });
	assert.deepEqual(matchRule(rules, info("read"), "codex"), { tool: "read", action: "allow", agent: "codex" });
	// matches on kind too
	assert.deepEqual(matchRule([{ tool: "edit", action: "allow" }], info("Patch file", "edit"), "x"), { tool: "edit", action: "allow" });
});

check("ruleKey is stable and case-insensitive on tool", () => {
	assert.equal(ruleKey({ agent: "codex", tool: "Read", action: "allow" }), ruleKey({ agent: "codex", tool: "read", action: "allow" }));
	assert.notEqual(ruleKey({ tool: "read", action: "allow" }), ruleKey({ tool: "read", action: "deny" }));
});

// ---- settings -> policy ---------------------------------------------------

check("normalizePermissionSettings defaults", () => {
	assert.deepEqual(normalizePermissionSettings(undefined), { mode: undefined, remember: true, rules: [] });
	assert.deepEqual(normalizePermissionSettings({ mode: "yolo", remember: false }), { mode: "auto", remember: false, rules: [] });
});

check("resolvePermissionPolicy: per-agent overrides global, rules stack", () => {
	const settings = {
		permissions: { mode: "ask", rules: [{ tool: "read", action: "allow" }] },
		agents: { codex: { permissions: { mode: "auto", rules: [{ tool: "write", action: "deny" }] } } },
	};
	const codex = resolvePermissionPolicy(settings, "codex", [{ tool: "ls", action: "allow" }]);
	assert.equal(codex.mode, "auto");
	// precedence (first-match-wins): per-agent, then global, then persisted grants
	assert.deepEqual(codex.rules.map((r) => r.tool), ["write", "read", "ls"]);

	const other = resolvePermissionPolicy(settings, "claude");
	assert.equal(other.mode, "ask"); // falls back to global
});

check("resolvePermissionPolicy: default mode is ask", () => {
	assert.equal(resolvePermissionPolicy({}, "claude").mode, "ask");
});

check("resolvePermissionPolicy: grants scoped to other agents are dropped", () => {
	const policy = resolvePermissionPolicy({}, "claude", [{ tool: "read", action: "allow", agent: "codex" }]);
	assert.equal(policy.rules.length, 0);
});

// ---- request inspection + classification ----------------------------------

check("permissionRequestInfo extracts tool name/kind/options", () => {
	const info = permissionRequestInfo({ toolCall: { title: "Run tests", kind: "execute" }, options: FAKE_OPTIONS });
	assert.equal(info.toolName, "Run tests");
	assert.equal(info.kind, "execute");
	assert.equal(info.options.length, 2);
});

check("classifyOption uses kind then text", () => {
	assert.equal(classifyOption({ kind: "allow_once" }), "allow");
	assert.equal(classifyOption({ kind: "reject_once" }), "deny");
	assert.equal(classifyOption({ name: "Yes, allow" }), "allow");
	assert.equal(classifyOption({ name: "No" }), "deny");
	assert.equal(classifyOption({ name: "Hmm" }), "unknown");
});

check("isAlwaysOption detects persistent grants", () => {
	assert.equal(isAlwaysOption({ kind: "allow_always" }), true);
	assert.equal(isAlwaysOption({ optionId: "bypassPermissions" }), true);
	assert.equal(isAlwaysOption({ kind: "allow_once" }), false);
});

check("pickAllowOption prefers narrowest by default, broadest when asked", () => {
	assert.equal(pickAllowOption(FAKE_OPTIONS)?.optionId, "allow");
	assert.equal(pickAllowOption(ALWAYS_OPTIONS)?.optionId, "allow-once");
	assert.equal(pickAllowOption(ALWAYS_OPTIONS, { broad: true })?.optionId, "bypassPermissions");
	assert.equal(pickAllowOption([{ kind: "reject_once", optionId: "r" }]), undefined);
});

check("pickDenyOption finds the reject", () => {
	assert.equal(pickDenyOption(FAKE_OPTIONS)?.optionId, "reject");
	assert.equal(pickDenyOption([{ kind: "allow_once", optionId: "a" }]), undefined);
});

// ---- decisions ------------------------------------------------------------

const params = (options) => ({ toolCall: { title: "Run tests" }, options });

check("decidePermission ask mode asks", () => {
	const decision = decidePermission({ mode: "ask", rules: [] }, params(FAKE_OPTIONS), { agentKey: "claude" });
	assert.equal(decision.action, "ask");
});

check("decidePermission auto allows narrowest", () => {
	const decision = decidePermission({ mode: "auto", rules: [] }, params(ALWAYS_OPTIONS), { agentKey: "claude" });
	assert.equal(decision.action, "allow");
	assert.equal(decision.optionId, "allow-once");
});

check("decidePermission deny mode denies", () => {
	const decision = decidePermission({ mode: "deny", rules: [] }, params(FAKE_OPTIONS), { agentKey: "claude" });
	assert.equal(decision.action, "deny");
	assert.equal(decision.optionId, "reject");
});

check("decidePermission allow rule overrides mode but stays narrow (no bypass escalation)", () => {
	const policy = { mode: "ask", rules: [{ tool: "run tests", action: "allow" }] };
	const decision = decidePermission(policy, params(ALWAYS_OPTIONS), { agentKey: "claude" });
	assert.equal(decision.action, "allow");
	// A scoped allow rule must NOT answer with the backend-wide bypass option.
	assert.equal(decision.optionId, "allow-once");
	assert.notEqual(decision.optionId, "bypassPermissions");
});

check("config deny rule overrides a persisted allow grant", () => {
	const settings = { agents: { codex: { permissions: { rules: [{ tool: "Read", action: "deny" }] } } } };
	const grants = [{ agent: "codex", tool: "read", action: "allow" }];
	const policy = resolvePermissionPolicy(settings, "codex", grants);
	const decision = decidePermission(policy, { toolCall: { title: "Read" }, options: FAKE_OPTIONS }, { agentKey: "codex" });
	assert.equal(decision.action, "deny");
});

check("decidePermission deny rule overrides auto mode", () => {
	const policy = { mode: "auto", rules: [{ tool: "run tests", action: "deny" }] };
	const decision = decidePermission(policy, params(FAKE_OPTIONS), { agentKey: "claude" });
	assert.equal(decision.action, "deny");
});

check("outcomeForDecision builds wire shapes", () => {
	assert.deepEqual(outcomeForDecision({ action: "allow", optionId: "allow" }), { outcome: "selected", optionId: "allow" });
	assert.deepEqual(outcomeForDecision({ action: "allow" }), { outcome: "cancelled" });
	assert.deepEqual(outcomeForDecision({ action: "ask" }), { outcome: "cancelled" });
	assert.deepEqual(selectedOutcome("x"), { outcome: "selected", optionId: "x" });
});

// ---- native config generation + back-compat inference ---------------------

check("nativePermissionConfig generates per-harness native dialect for auto", () => {
	assert.deepEqual(nativePermissionConfig("claude", "auto"), {
		autoApprove: true,
		startupMode: "bypassPermissions",
		settings: { permissions: { defaultMode: "bypassPermissions" } },
	});
	assert.deepEqual(nativePermissionConfig("codex", "auto"), {
		autoApprove: true,
		config: { approval_policy: "never", sandbox_mode: "danger-full-access" },
	});
	assert.deepEqual(nativePermissionConfig("cursor", "auto"), { autoApprove: true, args: ["--force"] });
	assert.deepEqual(nativePermissionConfig("opencode", "auto"), { autoApprove: true });
	assert.deepEqual(nativePermissionConfig("pi", "auto"), { autoApprove: true });
	assert.deepEqual(nativePermissionConfig("claude", "deny"), { autoDeny: true });
	assert.deepEqual(nativePermissionConfig("claude", "ask"), {});
});

check("inferModeFromNative mirrors the old per-name triggers", () => {
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "bypassPermissions" } } }), "auto");
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "default" } } }), undefined);
	assert.equal(inferModeFromNative("codex", { config: { approval_policy: "never", sandbox_mode: "danger-full-access" } }), "auto");
	assert.equal(inferModeFromNative("codex", { config: { approval_policy: "never" } }), undefined);
	assert.equal(inferModeFromNative("cursor", { args: ["--force"] }), "auto");
	assert.equal(inferModeFromNative("cursor", { args: ["--yolo"] }), "auto");
	assert.equal(inferModeFromNative("cursor", { args: ["--no-yolo"] }), undefined);
	assert.equal(inferModeFromNative("opencode", { args: ["--whatever"] }), undefined);
});

// ---- grant store (persistence) --------------------------------------------

check("grant store round-trips, de-dupes, and forgets", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-perms-"));
	const file = path.join(dir, "permissions.json");
	try {
		assert.deepEqual(loadGrants(file), []);
		recordGrant({ agent: "codex", tool: "Read", action: "allow" }, file);
		recordGrant({ agent: "codex", tool: "read", action: "allow" }, file); // dup (case-insensitive)
		recordGrant({ agent: "claude", tool: "*", action: "allow" }, file);
		const grants = loadGrants(file);
		assert.equal(grants.length, 2);
		// persisted grants drive decisions after reload (rule tool "read" matches the request)
		const policy = resolvePermissionPolicy({}, "codex", grants);
		const readReq = { toolCall: { title: "Read" }, options: FAKE_OPTIONS };
		assert.equal(decidePermission(policy, readReq, { agentKey: "codex" }).action, "allow");
		// a different tool still asks
		assert.equal(decidePermission(policy, params(FAKE_OPTIONS), { agentKey: "codex" }).action, "ask");

		forgetGrants((rule) => rule.agent === "codex", file);
		assert.equal(loadGrants(file).length, 1);

		saveGrants([{ tool: "x", action: "allow" }, { tool: "x", action: "allow" }], file);
		assert.equal(loadGrants(file).length, 1);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("loadGrants tolerates a missing/garbage file", () => {
	assert.deepEqual(loadGrants(path.join(os.tmpdir(), `cc-missing-${process.pid}.json`)), []);
});

console.log(`permissions: ${passed} checks passed`);
