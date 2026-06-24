// The unified, harness-agnostic permission engine.
//
// One policy model lives here and applies to EVERY harness. The two hard problems
// the old per-name code had are inverted:
//
//   * Configuring "auto-approve" used to require knowing each backend's native
//     dialect (claude defaultMode, codex approval_policy+sandbox_mode, cursor
//     --force) and was impossible for harnesses with no such knob. Now cc owns a
//     single `permissions.mode` and GENERATES the native dialect from it
//     (`nativePermissionConfig`). Backends with no knob simply get cc-side
//     decisioning — consistently.
//
//   * "Allow always" used to be opaque (forwarded to the backend, never recorded
//     by cc). Now cc persists grants in its own store, so they survive restarts,
//     are harness-agnostic, and are auditable/revocable.
//
// The module is pure except for the grant-store helpers, which take an explicit
// file path (defaulting to ~/.config/cc/permissions.json) so tests stay hermetic.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPlainObject, stringArray } from "./util.mjs";

// ---------------------------------------------------------------------------
// Unified modes
// ---------------------------------------------------------------------------

export const PERMISSION_MODES = ["ask", "auto", "deny"];
export const DEFAULT_PERMISSION_MODE = "ask";

// Friendly aliases so users can write what they mean. Anything unknown is ignored
// (falls through to the next source rather than throwing).
const MODE_ALIASES = {
	ask: "ask",
	prompt: "ask",
	manual: "ask",
	interactive: "ask",
	default: "ask",
	auto: "auto",
	yolo: "auto",
	bypass: "auto",
	bypasspermissions: "auto",
	full: "auto",
	"full-access": "auto",
	allow: "auto",
	"allow-all": "auto",
	// NOTE: claude's "acceptEdits" is deliberately NOT mapped — it is narrower than
	// full auto, so treating it as auto would silently escalate. It falls through to
	// the default (ask); use claude's native settings.permissions.defaultMode for it.
	deny: "deny",
	reject: "deny",
	"deny-all": "deny",
	off: "deny",
};

/** Coerce any value to a canonical mode, or undefined if not recognized. */
export function coercePermissionMode(value) {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase().replace(/\s+/g, "-");
	return MODE_ALIASES[key] ?? MODE_ALIASES[key.replace(/[-_]/g, "")];
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Normalize one rule. A rule is `{ tool, action, agent? }` where `tool` is a tool
 * name or `*`, `action` is allow|deny, and `agent` (optional) scopes it to one
 * harness. Returns undefined for anything malformed.
 */
export function normalizeRule(raw) {
	if (!isPlainObject(raw)) return undefined;
	const tool = typeof raw.tool === "string" && raw.tool.trim() ? raw.tool.trim() : raw.tool === "*" ? "*" : undefined;
	const action = raw.action === "allow" || raw.action === "deny" ? raw.action : undefined;
	if (!tool || !action) return undefined;
	const rule = { tool, action };
	if (typeof raw.agent === "string" && raw.agent.trim()) rule.agent = raw.agent.trim();
	return rule;
}

function normalizeRules(value) {
	if (!Array.isArray(value)) return [];
	return value.map(normalizeRule).filter(Boolean);
}

/** Full identity of a rule (agent + tool + action). */
export function ruleKey(rule = {}) {
	return `${rule.agent ?? "*"}\t${String(rule.tool ?? "").toLowerCase()}\t${rule.action ?? ""}`;
}

/**
 * Identity of a grant's SCOPE (agent + tool), ignoring action. A tool has at most
 * one persisted grant: choosing deny-always for a tool replaces an earlier
 * allow-always (and vice versa) rather than leaving a stale, higher-priority rule.
 */
export function grantScopeKey(rule = {}) {
	return `${rule.agent ?? "*"}\t${String(rule.tool ?? "").toLowerCase()}`;
}

function toolMatches(pattern, name, kind) {
	if (pattern === "*") return true;
	const target = pattern.toLowerCase();
	return String(name ?? "").toLowerCase() === target || String(kind ?? "").toLowerCase() === target;
}

/** First rule (in priority order) that applies to this request, or undefined. */
export function matchRule(rules, info, agentKey) {
	for (const rule of rules) {
		if (rule.agent && rule.agent !== agentKey) continue;
		if (toolMatches(rule.tool, info.toolName, info.kind)) return rule;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Settings -> policy
// ---------------------------------------------------------------------------

/**
 * Normalize a `permissions` block (global or per-agent). `mode` stays undefined
 * when not explicitly set so callers can fall through global -> per-agent.
 */
export function normalizePermissionSettings(raw) {
	const block = isPlainObject(raw) ? raw : {};
	return {
		mode: coercePermissionMode(block.mode),
		// undefined when absent so per-agent/global can fall through independently
		// of `mode` (resolvePermissionPolicy applies the default).
		remember: block.remember === undefined ? undefined : Boolean(block.remember),
		rules: normalizeRules(block.rules),
	};
}

/**
 * Resolve the effective policy for one harness. Per-agent mode wins over global.
 * Rules are matched first-match-wins (see matchRule), so order is precedence:
 * explicit config rules (most-specific first: per-agent, then global) come BEFORE
 * persisted grants, so a user can override a remembered "always" decision in
 * config (e.g. a deny rule beats a stored allow). `grants` are persisted
 * "always" decisions, the least authoritative layer.
 */
export function resolvePermissionPolicy(settings = {}, agentKey, grants = []) {
	const global = normalizePermissionSettings(settings.permissions);
	const perAgent = normalizePermissionSettings(settings.agents?.[agentKey]?.permissions);
	const mode = perAgent.mode ?? global.mode ?? DEFAULT_PERMISSION_MODE;
	// `remember` resolves independently of `mode`: a per-agent `remember:false`
	// disables persistence even when only the global block sets `mode`.
	const remember = perAgent.remember ?? global.remember ?? true;
	const grantRules = normalizeRules(grants).filter((rule) => !rule.agent || rule.agent === agentKey);
	return {
		mode,
		remember,
		rules: [...perAgent.rules, ...global.rules, ...grantRules],
	};
}

// ---------------------------------------------------------------------------
// Request inspection + option classification
// ---------------------------------------------------------------------------

/** Pull the tool name / kind / options out of an ACP request_permission params. */
export function permissionRequestInfo(params = {}) {
	const toolCall = params.toolCall ?? params.tool_call ?? {};
	const toolName = toolCall.title ?? toolCall.name ?? params.title ?? toolCall.kind;
	const kind = toolCall.kind ?? params.kind;
	const options = Array.isArray(params.options) ? params.options : [];
	return { toolName, kind, options };
}

function optionText(option = {}) {
	return `${option.optionId ?? ""} ${option.name ?? ""} ${option.label ?? ""} ${option.kind ?? ""}`.toLowerCase();
}

/** allow | deny | unknown — classify a single permission option. */
export function classifyOption(option = {}) {
	const kind = String(option.kind ?? "").toLowerCase();
	if (kind.includes("reject") || kind.includes("deny") || kind.includes("cancel")) return "deny";
	if (kind.includes("allow") || kind.includes("approve") || kind.includes("accept")) return "allow";
	const text = optionText(option);
	if (/\b(reject|deny|cancel|no)\b/.test(text)) return "deny";
	if (/\b(allow|approve|yes|accept|bypass)\b/.test(text)) return "allow";
	return "unknown";
}

/**
 * Breadth of an option: "once" (this call) < "session" (this backend session) <
 * "always" (persistent / bypass). Distinguishing session from always matters for
 * persistence: a session-scoped choice must NOT be saved as a forever grant.
 */
export function optionScope(option = {}) {
	const text = `${String(option.kind ?? "")} ${String(option.optionId ?? "")}`.toLowerCase();
	if (text.includes("always") || text.includes("bypass")) return "always";
	if (text.includes("session")) return "session";
	return "once";
}

/**
 * Whether picking this option should be PERSISTED by cc as a forever grant. Only
 * genuinely persistent ("always"/bypass) options qualify — a session-scoped option
 * is remembered by the backend for its session, not saved across cc restarts.
 */
export function isAlwaysOption(option = {}) {
	return optionScope(option) === "always";
}

/**
 * Choose an allow option. Default prefers the NARROWEST grant (allow-once, then
 * session, then always) so turning on auto does not silently escalate every
 * decision to "always, for everything" — cc owns persistence via its own grants.
 * `broad: true` flips to the most permissive option, in the reverse order.
 */
export function pickAllowOption(options = [], { broad = false } = {}) {
	const allow = options.filter((option) => classifyOption(option) === "allow");
	if (allow.length === 0) return undefined;
	const byScope = (scope) => allow.find((option) => optionScope(option) === scope);
	if (broad) {
		return (
			allow.find((option) => option.optionId === "bypassPermissions") ??
			byScope("always") ??
			byScope("session") ??
			allow[0]
		);
	}
	return byScope("once") ?? byScope("session") ?? byScope("always") ?? allow[0];
}

/** Choose a deny option (narrowest reject preferred). */
export function pickDenyOption(options = []) {
	const deny = options.filter((option) => classifyOption(option) === "deny");
	if (deny.length === 0) return undefined;
	return deny.find((option) => optionScope(option) === "once") ?? deny[0];
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide what to do with a permission request given a resolved policy.
 * Returns `{ action, optionId?, rule?, broad? }`:
 *   - action "allow"/"deny": cc resolves it without asking (optionId names the
 *     backend option to reply with; may be undefined if the backend offered none).
 *   - action "ask": cc must show the dialog.
 * Explicit rules always win over mode.
 */
export function decidePermission(policy = {}, params = {}, ctx = {}) {
	const info = permissionRequestInfo(params);
	const rule = matchRule(policy.rules ?? [], info, ctx.agentKey);
	if (rule) {
		if (rule.action === "deny") return { action: "deny", optionId: pickDenyOption(info.options)?.optionId, rule };
		// A scoped allow rule/grant authorizes only THIS tool: answer with the
		// narrowest allow option so the backend keeps asking about everything else.
		// cc itself enforces the "always" via the persisted rule. (The user can
		// still pick a broad option directly in an interactive prompt.)
		return { action: "allow", optionId: pickAllowOption(info.options)?.optionId, rule };
	}
	if (policy.mode === "auto") return { action: "allow", optionId: pickAllowOption(info.options)?.optionId };
	if (policy.mode === "deny") return { action: "deny", optionId: pickDenyOption(info.options)?.optionId };
	return { action: "ask" };
}

// ---------------------------------------------------------------------------
// Wire outcomes (one place; hides the inner/full shape split)
// ---------------------------------------------------------------------------

export function selectedOutcome(optionId) {
	return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
}

export function cancelledOutcome() {
	return { outcome: "cancelled" };
}

/** The inner outcome for a non-interactive (auto/deny/rule) decision. */
export function outcomeForDecision(decision = {}) {
	if (decision.action === "allow" || decision.action === "deny") return selectedOutcome(decision.optionId);
	return cancelledOutcome();
}

// ---------------------------------------------------------------------------
// Native config generation (replaces per-name inference)
// ---------------------------------------------------------------------------

/**
 * Map a unified mode to a harness's native settings. `autoApprove` tells cc to
 * auto-accept; `startupMode`/`settings`/`config`/`args`/`removeArgs` are the spawn
 * inputs that configure (or neutralize) the backend itself so the two never
 * disagree. A harness with no native knob just gets `autoApprove` for auto (and cc
 * decides for ask/deny). The ask/deny shapes are NEUTRALIZERS: they undo any native
 * auto/bypass on the agent so the backend prompts and cc's decision is honored
 * (ask and deny share the same native shape; the difference is cc-side only).
 */
export function nativePermissionConfig(agentKey, mode) {
	if (mode === "auto") {
		switch (agentKey) {
			case "claude":
				return {
					autoApprove: true,
					startupMode: "bypassPermissions",
					settings: { permissions: { defaultMode: "bypassPermissions" } },
				};
			case "codex":
				return { autoApprove: true, config: { approval_policy: "never", sandbox_mode: "danger-full-access" } };
			case "cursor":
				return { autoApprove: true, args: ["--force"] };
			default:
				return { autoApprove: true };
		}
	}
	if (mode === "ask" || mode === "deny") {
		// ask and deny share the SAME native shape: both make the backend prompt
		// (neutralizing any native auto/bypass); the ask-vs-deny difference is purely
		// cc-side (mode drives decidePermission), so there is no native auto-deny.
		// Flip the prompting switch back on; leave orthogonal settings (the codex
		// sandbox, claude's other options) to the user.
		switch (agentKey) {
			case "claude":
				return { settings: { permissions: { defaultMode: "default" } } };
			case "codex":
				return { config: { approval_policy: "on-request" } };
			case "cursor":
				return { removeArgs: ["--force", "-f", "--yolo"] };
			default:
				return {};
		}
	}
	return {};
}

/**
 * Back-compat: derive a unified mode from native settings a user already wrote,
 * so existing settings.json files keep working. Mirrors the old
 * applyNativePermissionSetting exactly.
 */
export function inferModeFromNative(agentKey, agentSettings = {}) {
	if (!isPlainObject(agentSettings)) return undefined;
	if (agentKey === "claude") {
		const mode = agentSettings.settings?.permissions?.defaultMode;
		return coercePermissionMode(mode) === "auto" ? "auto" : undefined;
	}
	if (agentKey === "codex") {
		const config = agentSettings.config;
		if (config?.approval_policy === "never" && config?.sandbox_mode === "danger-full-access") return "auto";
		return undefined;
	}
	if (agentKey === "cursor") {
		// Match the old check, which inspected the final command args — including
		// acpArgs appended after the native args.
		const args = [...stringArray(agentSettings.args ?? agentSettings.nativeArgs), ...stringArray(agentSettings.acpArgs)];
		if (args.includes("--force") || args.includes("-f") || args.includes("--yolo")) return "auto";
		return undefined;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Grant store (persistence of "allow always")
// ---------------------------------------------------------------------------

export function permissionsStorePath() {
	if (process.env.CC_PERMISSIONS) return process.env.CC_PERMISSIONS;
	const settings = process.env.CC_SETTINGS;
	const dir = settings ? path.dirname(settings) : path.join(os.homedir(), ".config", "cc");
	return path.join(dir, "permissions.json");
}

export function loadGrants(file = permissionsStorePath()) {
	try {
		if (!fs.existsSync(file)) return [];
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		return normalizeRules(parsed?.grants ?? parsed);
	} catch {
		return [];
	}
}

export function saveGrants(grants, file = permissionsStorePath()) {
	const normalized = normalizeRules(grants);
	// One grant per scope (agent+tool); a later entry replaces an earlier one, so a
	// fresh deny-always overrides a stale allow-always for the same tool.
	const byScope = new Map();
	for (const rule of normalized) byScope.set(grantScopeKey(rule), rule);
	const deduped = [...byScope.values()];
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify({ grants: deduped }, null, 2)}\n`);
	return deduped;
}

/** Add (or replace) a remembered grant for its scope. Returns the full grant list. */
export function recordGrant(rule, file = permissionsStorePath()) {
	const normalized = normalizeRule(rule);
	if (!normalized) return loadGrants(file);
	const grants = loadGrants(file).filter((existing) => grantScopeKey(existing) !== grantScopeKey(normalized));
	grants.push(normalized);
	return saveGrants(grants, file);
}

/** Remove grants matching `predicate(rule)`. Returns the remaining grants. */
export function forgetGrants(predicate, file = permissionsStorePath()) {
	const grants = loadGrants(file).filter((rule) => !predicate(rule));
	return saveGrants(grants, file);
}
