import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	classifyOption,
	coercePermissionMode,
	decidePermission,
	flagMatches,
	forgetGrants,
	inferModeFromNative,
	isAlwaysOption,
	loadGrants,
	matchRule,
	nativePermissionConfig,
	getPermissionDialect,
	normalizePermissionSettings,
	normalizeRule,
	optionScope,
	outcomeForDecision,
	permissionRequestInfo,
	nonPersistentSameDirection,
	pickAllowOption,
	pickNonPersistentAllowOption,
	policyNeedsGating,
	pickDenyOption,
	recordGrant,
	registerPermissionDialect,
	resolvePermissionPolicy,
	ruleKey,
	saveGrants,
	selectedOutcome,
	stripFlags,
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
	// claude's edits-only mode must NOT be silently escalated to full auto.
	assert.equal(coercePermissionMode("acceptEdits"), undefined);
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
	// remember is undefined when absent so it can fall through independently of mode
	assert.deepEqual(normalizePermissionSettings(undefined), { mode: undefined, remember: undefined, rules: [] });
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
	assert.equal(resolvePermissionPolicy({}, "claude").remember, true);
});

check("resolvePermissionPolicy: per-agent remember:false honored without a mode", () => {
	const policy = resolvePermissionPolicy({ agents: { codex: { permissions: { remember: false } } } }, "codex");
	assert.equal(policy.remember, false);
	assert.equal(policy.mode, "ask"); // mode still falls back to default
	// global remember:false also applies to agents that set no permissions block
	assert.equal(resolvePermissionPolicy({ permissions: { remember: false } }, "claude").remember, false);
});

check("resolvePermissionPolicy: grants scoped to other agents are dropped", () => {
	const policy = resolvePermissionPolicy({}, "claude", [{ tool: "read", action: "allow", agent: "codex" }]);
	assert.equal(policy.rules.length, 0);
});

check("resolvePermissionPolicy: CONFIG rules scoped to other agents are dropped too", () => {
	// a global rule scoped to codex must not appear (or gate) for claude
	const settings = { permissions: { mode: "auto", rules: [{ agent: "codex", tool: "shell", action: "deny" }] } };
	const claude = resolvePermissionPolicy(settings, "claude");
	assert.equal(claude.rules.length, 0);
	assert.equal(policyNeedsGating(claude), false);
	const codex = resolvePermissionPolicy(settings, "codex");
	assert.deepEqual(codex.rules, [{ agent: "codex", tool: "shell", action: "deny", source: "config" }]);
	assert.equal(policyNeedsGating(codex), true);
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

check("isAlwaysOption persists only genuine always grants, not session", () => {
	assert.equal(isAlwaysOption({ kind: "allow_always" }), true);
	assert.equal(isAlwaysOption({ optionId: "bypassPermissions" }), true);
	assert.equal(isAlwaysOption({ kind: "allow_once" }), false);
	// session-scoped is NOT persisted as a forever grant
	assert.equal(isAlwaysOption({ kind: "allow_session" }), false);
	assert.equal(isAlwaysOption({ optionId: "allow-for-session" }), false);
});

check("optionScope orders once < session < always", () => {
	assert.equal(optionScope({ kind: "allow_once" }), "once");
	assert.equal(optionScope({ kind: "allow_session" }), "session");
	assert.equal(optionScope({ kind: "allow_always" }), "always");
	assert.equal(optionScope({ optionId: "bypassPermissions" }), "always");
});

check("optionScope falls back to name/label when kind/optionId carry no scope signal", () => {
	// permanence only in the label -> still detected (not misclassified as once)
	assert.equal(optionScope({ kind: "allow", optionId: "allow", name: "Allow always" }), "always");
	assert.equal(isAlwaysOption({ kind: "allow", optionId: "ok", name: "Approve always" }), true);
	assert.equal(optionScope({ label: "Allow for this session" }), "session");
	// authoritative kind/optionId still win (no regression for the common case)
	assert.equal(optionScope({ kind: "allow_once", optionId: "allow", name: "Allow" }), "once");
	assert.equal(pickNonPersistentAllowOption([{ kind: "allow", optionId: "a", name: "Allow always" }]), undefined);
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

check("deny mode suppresses a persisted allow GRANT but honors a config allow RULE", () => {
	const req = { toolCall: { title: "Read" }, options: FAKE_OPTIONS };
	// persisted allow grant + deny mode -> deny (stale convenience must not punch through)
	const grantPolicy = resolvePermissionPolicy({ permissions: { mode: "deny" } }, "codex", [{ agent: "codex", tool: "Read", action: "allow" }]);
	assert.equal(decidePermission(grantPolicy, req, { agentKey: "codex" }).action, "deny");
	// same grant under ask mode still allows (the grant is honored when not tightening)
	const askPolicy = resolvePermissionPolicy({ permissions: { mode: "ask" } }, "codex", [{ agent: "codex", tool: "Read", action: "allow" }]);
	assert.equal(decidePermission(askPolicy, req, { agentKey: "codex" }).action, "allow");
	// a deliberate config allow rule under deny mode IS honored (deny-by-default allowlist)
	const rulePolicy = resolvePermissionPolicy({ agents: { codex: { permissions: { mode: "deny", rules: [{ tool: "Read", action: "allow" }] } } } }, "codex");
	assert.equal(decidePermission(rulePolicy, req, { agentKey: "codex" }).action, "allow");
	// a persisted deny grant under auto mode still denies (round-3 behavior preserved)
	const denyGrantPolicy = resolvePermissionPolicy({ permissions: { mode: "auto" } }, "codex", [{ agent: "codex", tool: "Read", action: "deny" }]);
	assert.equal(decidePermission(denyGrantPolicy, req, { agentKey: "codex" }).action, "deny");
});

// Backend offers ONLY persistent allow options (no allow-once/session).
const ONLY_ALWAYS_ALLOW = [
	{ kind: "reject_once", name: "Reject", optionId: "r" },
	{ kind: "allow_always", name: "Allow always", optionId: "aa" },
	{ kind: "allow_always", name: "Bypass", optionId: "bypassPermissions" },
];

check("pickNonPersistentAllowOption refuses always/bypass", () => {
	assert.equal(pickNonPersistentAllowOption(FAKE_OPTIONS)?.optionId, "allow");
	assert.equal(pickNonPersistentAllowOption(ONLY_ALWAYS_ALLOW), undefined);
	assert.equal(pickNonPersistentAllowOption([{ kind: "allow_session", optionId: "s" }])?.optionId, "s");
});

check("nonPersistentSameDirection mirrors the option's direction and refuses always", () => {
	const allowOpt = { kind: "allow_always", optionId: "aa" };
	const denyOpt = { kind: "reject_always", optionId: "ra" };
	const opts = [
		{ kind: "reject_once", optionId: "r1" },
		{ kind: "allow_once", optionId: "a1" },
		allowOpt,
		denyOpt,
	];
	assert.equal(nonPersistentSameDirection(allowOpt, opts)?.optionId, "a1");
	assert.equal(nonPersistentSameDirection(denyOpt, opts)?.optionId, "r1");
	// only-always in that direction -> undefined (caller must not record+forward persistently)
	assert.equal(nonPersistentSameDirection(allowOpt, [allowOpt, { kind: "reject_once", optionId: "r1" }]), undefined);
	assert.equal(nonPersistentSameDirection(denyOpt, [denyOpt, { kind: "allow_once", optionId: "a1" }]), undefined);
});

check("scoped allow rule with only-always options ASKS (no silent backend persistence)", () => {
	const policy = { mode: "ask", rules: [{ tool: "run tests", action: "allow" }] };
	const decision = decidePermission(policy, params(ONLY_ALWAYS_ALLOW), { agentKey: "claude" });
	assert.equal(decision.action, "ask");
});

check("mode auto with only-always options ASKS rather than sending a bypass", () => {
	const decision = decidePermission({ mode: "auto", rules: [] }, params(ONLY_ALWAYS_ALLOW), { agentKey: "claude" });
	assert.equal(decision.action, "ask");
});

check("mode auto with no allow option resolves to cancel (nothing to approve)", () => {
	const decision = decidePermission({ mode: "auto", rules: [] }, params([{ kind: "reject_once", optionId: "r" }]), { agentKey: "claude" });
	assert.deepEqual(outcomeForDecision(decision), { outcome: "cancelled" });
});

check("auto-deny never sends a persistent reject_always (cancels instead)", () => {
	const onlyAlwaysReject = [{ kind: "reject_always", optionId: "ra" }, { kind: "allow_once", optionId: "a" }];
	// mode deny: a one-time reject is unavailable -> cancel (a denial that persists nothing)
	const modeDecision = decidePermission({ mode: "deny", rules: [] }, params(onlyAlwaysReject), { agentKey: "claude" });
	assert.equal(modeDecision.action, "deny");
	assert.deepEqual(outcomeForDecision(modeDecision), { outcome: "cancelled" });
	// deny rule, same: never forwards reject_always
	const rulePolicy = { mode: "ask", rules: [{ tool: "run tests", action: "deny" }] };
	const ruleDecision = decidePermission(rulePolicy, params(onlyAlwaysReject), { agentKey: "claude" });
	assert.notEqual(ruleDecision.optionId, "ra");
	assert.deepEqual(outcomeForDecision(ruleDecision), { outcome: "cancelled" });
	// when a one-time reject IS offered, it is used
	const withOnce = decidePermission({ mode: "deny", rules: [] }, params(FAKE_OPTIONS), { agentKey: "claude" });
	assert.equal(withOnce.optionId, "reject");
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
});

check("gated auto keeps the backend prompting (no full bypass) so deny rules fire", () => {
	// claude: prompt via default mode, no bypass startup.
	assert.deepEqual(nativePermissionConfig("claude", "auto", { gated: true }), {
		autoApprove: true,
		settings: { permissions: { defaultMode: "default" } },
	});
	// codex: prompt (on-request) but keep full capability (danger sandbox).
	assert.deepEqual(nativePermissionConfig("codex", "auto", { gated: true }), {
		autoApprove: true,
		config: { approval_policy: "on-request", sandbox_mode: "danger-full-access" },
	});
	assert.deepEqual(nativePermissionConfig("cursor", "auto", { gated: true }), {
		autoApprove: true,
		removeArgs: ["--force", "-f", "--yolo"],
	});
	assert.deepEqual(nativePermissionConfig("opencode", "auto", { gated: true }), { autoApprove: true });
});

check("policyNeedsGating is true iff a deny rule/grant is present", () => {
	assert.equal(policyNeedsGating({ rules: [{ tool: "*", action: "allow" }] }), false);
	assert.equal(policyNeedsGating({ rules: [{ tool: "shell", action: "deny" }] }), true);
	assert.equal(policyNeedsGating({ rules: [] }), false);
	assert.equal(policyNeedsGating({}), false);
	// a deny grant surfaced through resolvePermissionPolicy triggers gating
	const policy = resolvePermissionPolicy({ permissions: { mode: "auto" } }, "codex", [{ agent: "codex", tool: "shell", action: "deny" }]);
	assert.equal(policyNeedsGating(policy), true);
});

check("nativePermissionConfig emits NEUTRALIZERS for ask/deny", () => {
	// ask: flip the prompting switch back on, leaving orthogonal settings alone.
	assert.deepEqual(nativePermissionConfig("claude", "ask"), { settings: { permissions: { defaultMode: "default" } } });
	assert.deepEqual(nativePermissionConfig("codex", "ask"), { config: { approval_policy: "on-request" } });
	assert.deepEqual(nativePermissionConfig("cursor", "ask"), { removeArgs: ["--force", "-f", "--yolo"] });
	assert.deepEqual(nativePermissionConfig("opencode", "ask"), {});
	// deny neutralizes identically to ask (the ask/deny difference is cc-side only).
	assert.deepEqual(nativePermissionConfig("claude", "deny"), nativePermissionConfig("claude", "ask"));
	assert.deepEqual(nativePermissionConfig("codex", "deny"), nativePermissionConfig("codex", "ask"));
	assert.deepEqual(nativePermissionConfig("cursor", "deny"), nativePermissionConfig("cursor", "ask"));
	assert.deepEqual(nativePermissionConfig("opencode", "deny"), {});
});

check("a new harness dialect can be registered without editing the engine", () => {
	// A harness with no dialect is decided entirely cc-side (no native bypass).
	assert.deepEqual(nativePermissionConfig("brand-new", "auto"), { autoApprove: true });
	assert.deepEqual(nativePermissionConfig("brand-new", "ask"), {});
	assert.equal(inferModeFromNative("brand-new", { args: ["--whatever"] }), undefined);
	assert.equal(getPermissionDialect("brand-new"), undefined);

	// Registering a dialect makes the generic engine generate/infer its native form.
	registerPermissionDialect("brand-new", {
		auto: { args: ["--bypass"] },
		gatedAuto: { removeArgs: ["--bypass"] },
		prompt: { removeArgs: ["--bypass"] },
		infer: (settings) => (stringArrayIncludes(settings.args, "--bypass") ? "auto" : undefined),
	});
	assert.deepEqual(nativePermissionConfig("brand-new", "auto"), { autoApprove: true, args: ["--bypass"] });
	assert.deepEqual(nativePermissionConfig("brand-new", "auto", { gated: true }), { autoApprove: true, removeArgs: ["--bypass"] });
	assert.deepEqual(nativePermissionConfig("brand-new", "deny"), { removeArgs: ["--bypass"] });
	assert.equal(inferModeFromNative("brand-new", { args: ["--bypass"] }), "auto");
	assert.equal(inferModeFromNative("brand-new", { args: [] }), undefined);

	// The returned shape is a copy — mutating it must not corrupt the registered dialect.
	const got = nativePermissionConfig("brand-new", "auto");
	got.args.push("mutated");
	assert.deepEqual(nativePermissionConfig("brand-new", "auto").args, ["--bypass"]);
});

function stringArrayIncludes(value, needle) {
	return Array.isArray(value) && value.includes(needle);
}

check("stripFlags / flagMatches handle bare and valued flag forms", () => {
	assert.equal(flagMatches("--force", "--force"), true);
	assert.equal(flagMatches("--force=true", "--force"), true);
	assert.equal(flagMatches("--forceful", "--force"), false);
	assert.deepEqual(stripFlags(["--model", "x", "--force=true", "--yolo", "acp"], ["--force", "-f", "--yolo"]), ["--model", "x", "acp"]);
});

check("inferModeFromNative mirrors the old per-name triggers", () => {
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "bypassPermissions" } } }), "auto");
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "bypass" } } }), "auto");
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "default" } } }), undefined);
	// broad unified aliases are NOT valid Claude bypass values: inferring auto from
	// them would auto-approve cc while Claude still enforces (no real bypass).
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "allow" } } }), undefined);
	assert.equal(inferModeFromNative("claude", { settings: { permissions: { defaultMode: "acceptEdits" } } }), undefined);
	assert.equal(inferModeFromNative("codex", { config: { approval_policy: "never", sandbox_mode: "danger-full-access" } }), "auto");
	assert.equal(inferModeFromNative("codex", { config: { approval_policy: "never" } }), undefined);
	assert.equal(inferModeFromNative("cursor", { args: ["--force"] }), "auto");
	assert.equal(inferModeFromNative("cursor", { args: ["--yolo"] }), "auto");
	assert.equal(inferModeFromNative("cursor", { args: ["--no-yolo"] }), undefined);
	// --force in acpArgs is also detected (parity with the old final-args check)
	assert.equal(inferModeFromNative("cursor", { acpArgs: ["--force"] }), "auto");
	// valued flag forms (--force=true / --yolo=true) are detected too
	assert.equal(inferModeFromNative("cursor", { args: ["--force=true"] }), "auto");
	assert.equal(inferModeFromNative("cursor", {}, ["--yolo=1", "acp"]), "auto");
	assert.equal(inferModeFromNative("cursor", { args: ["--forceful"] }), undefined); // not a force flag
	// --force baked into the FINAL applied args (e.g. base config acp.args) is detected
	assert.equal(inferModeFromNative("cursor", {}, ["--force", "acp"]), "auto");
	assert.equal(inferModeFromNative("cursor", {}, ["acp"]), undefined);
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

check("a fresh grant replaces the opposite action for the same tool", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-perms-flip-"));
	const file = path.join(dir, "permissions.json");
	try {
		recordGrant({ agent: "codex", tool: "Read", action: "allow" }, file);
		recordGrant({ agent: "codex", tool: "Read", action: "deny" }, file); // user changes their mind
		const grants = loadGrants(file);
		assert.equal(grants.length, 1, "only one grant per (agent, tool) scope");
		assert.equal(grants[0].action, "deny");
		// the decision reflects the latest choice, not the stale allow
		const policy = resolvePermissionPolicy({}, "codex", grants);
		const decision = decidePermission(policy, { toolCall: { title: "Read" }, options: FAKE_OPTIONS }, { agentKey: "codex" });
		assert.equal(decision.action, "deny");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

check("loadGrants tolerates a missing/garbage file", () => {
	assert.deepEqual(loadGrants(path.join(os.tmpdir(), `cc-missing-${process.pid}.json`)), []);
});

console.log(`permissions: ${passed} checks passed`);
