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
import { clonePlain, isPlainObject, stringArray } from "./util.mjs";

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
	// Keep ONLY rules that can apply to this agent (no agent scope, or scoped to it).
	// This must hold for config rules too, not just grants: otherwise a global rule
	// scoped to another agent (e.g. {agent:"codex",...}) would still count toward
	// gating/decisions for unrelated harnesses even though it can never match.
	const applies = (rule) => !rule.agent || rule.agent === agentKey;
	const tag = (source) => (rule) => ({ ...rule, source });
	return {
		mode,
		remember,
		// `source` distinguishes deliberate config rules from remembered grants:
		// deny mode honors a config allow rule (deny-by-default allowlist) but
		// suppresses a persisted allow grant (a convenience must not silently punch
		// through a safety tightening). See decidePermission.
		rules: [
			...perAgent.rules.filter(applies).map(tag("config")),
			...global.rules.filter(applies).map(tag("config")),
			...normalizeRules(grants).filter(applies).map(tag("grant")),
		],
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
	// kind/optionId are authoritative when they carry a scope signal.
	const strong = `${String(option.kind ?? "")} ${String(option.optionId ?? "")}`.toLowerCase();
	if (strong.includes("always") || strong.includes("bypass")) return "always";
	if (strong.includes("session")) return "session";
	// Otherwise fall back to the user-facing label/name, so a backend that only
	// encodes permanence there (e.g. name "Allow always") is still detected and cc
	// won't silently treat it as a one-time option.
	const weak = `${String(option.name ?? "")} ${String(option.label ?? "")}`.toLowerCase();
	if (/\balways\b/.test(weak) || /\bbypass\b/.test(weak)) return "always";
	if (/\bsession\b/.test(weak)) return "session";
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

/**
 * Narrowest NON-persistent allow (once, then session) — never an always/bypass
 * option. cc's AUTOMATIC decisions (mode/rule/grant) use this so cc never silently
 * makes the backend persist a broad grant; cc owns "always" via its own store.
 * Returns undefined when the backend offers no non-persistent allow.
 */
export function pickNonPersistentAllowOption(options = []) {
	const allow = options.filter((option) => classifyOption(option) === "allow");
	const byScope = (scope) => allow.find((option) => optionScope(option) === scope);
	return byScope("once") ?? byScope("session");
}

/** Narrowest NON-persistent deny (once, then session) — never a deny-always. */
export function pickNonPersistentDenyOption(options = []) {
	const deny = options.filter((option) => classifyOption(option) === "deny");
	const byScope = (scope) => deny.find((option) => optionScope(option) === scope);
	return byScope("once") ?? byScope("session");
}

/** The narrowest non-persistent option in the SAME direction as `option`. */
export function nonPersistentSameDirection(option, options = []) {
	return classifyOption(option) === "deny" ? pickNonPersistentDenyOption(options) : pickNonPersistentAllowOption(options);
}

/** Whether the request offers any allow option at all (of any scope). */
function hasAllowOption(options = []) {
	return options.some((option) => classifyOption(option) === "allow");
}

// An automatic "allow" decision: prefer a non-persistent option; if the backend
// offers ONLY always/bypass allows, surface the prompt (action "ask") rather than
// silently causing backend-side persistence; if it offers no allow at all, resolve
// to a cancel (nothing to approve).
function autoAllowDecision(info, extra = {}) {
	const option = pickNonPersistentAllowOption(info.options);
	if (option) return { action: "allow", optionId: option.optionId, ...extra };
	if (hasAllowOption(info.options)) return { action: "ask", ...extra };
	return { action: "allow", optionId: undefined, ...extra };
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
	// Under deny mode, a remembered ALLOW grant must not punch through (a stale
	// convenience can't override a safety tightening). Deliberate config allow rules
	// still apply (deny-by-default allowlist). Deny grants always apply.
	const candidates =
		policy.mode === "deny"
			? (policy.rules ?? []).filter((rule) => !(rule.source === "grant" && rule.action === "allow"))
			: policy.rules ?? [];
	const rule = matchRule(candidates, info, ctx.agentKey);
	if (rule) {
		// Automatic denials, like automatic allows, must not select a persistent
		// (reject_always) option — that would create backend-owned state cc can't
		// revoke. Use a one-time reject; if none exists, cancel (also a denial, but
		// nothing persists). cancel happens via outcomeForDecision when optionId is
		// undefined.
		if (rule.action === "deny") return { action: "deny", optionId: pickNonPersistentDenyOption(info.options)?.optionId, rule };
		// A scoped allow rule/grant authorizes only THIS tool with a NON-persistent
		// option, so the backend keeps asking about everything else and does not
		// persist a broad grant (cc owns "always" via its store). If the backend
		// offers only always/bypass allows, surface the prompt instead of silently
		// escalating.
		return autoAllowDecision(info, { rule });
	}
	if (policy.mode === "auto") return autoAllowDecision(info);
	if (policy.mode === "deny") return { action: "deny", optionId: pickNonPersistentDenyOption(info.options)?.optionId };
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
 * Whether a resolved policy carries any deny rule/grant cc must enforce per
 * request. A `mode: "auto"` backend therefore cannot be put in a native bypass
 * that silences it — cc would never be asked, so the denial could never fire.
 */
export function policyNeedsGating(policy = {}) {
	return (policy.rules ?? []).some((rule) => rule.action === "deny");
}

// ---------------------------------------------------------------------------
// Per-harness native dialects (the ONE place harness-specific permission
// knowledge lives — DATA, not branching logic). The engine below is generic over
// these descriptors and names no harness. Register a new harness's dialect with
// registerPermissionDialect() — no engine edit needed (parity with registerAdapter).
// A dialect declares spawn-config shapes for each intent + a back-compat inferer:
//   auto      -> full no-prompt native bypass
//   gatedAuto -> auto that keeps the backend PROMPTING (so a deny rule is
//                enforceable) while keeping full capability where that is a
//                separate knob (e.g. the codex sandbox)
//   prompt    -> NEUTRALIZER for ask/deny: undo any native auto/bypass so the
//                backend prompts (orthogonal settings are left to the user)
//   infer(agentSettings, appliedArgs) -> "auto" | undefined  (recognize a
//                pre-existing native bypass a user already wrote, for back-compat)
// Each shape may set startupMode/settings/config/args/removeArgs; the engine adds
// autoApprove for auto. A harness with no dialect is decided entirely cc-side.
// `removeArgs` entries match a CLI flag in both its bare (`--force`) and valued
// (`--force=true`) forms, so neutralization and inference stay consistent.
// ---------------------------------------------------------------------------

const CURSOR_FORCE_FLAGS = ["--force", "-f", "--yolo"];

/** Whether `arg` is `flag` or its `flag=value` form (e.g. `--force` / `--force=true`). */
export function flagMatches(arg, flag) {
	return typeof arg === "string" && (arg === flag || arg.startsWith(`${flag}=`));
}

const FALSY_FLAG_VALUES = new Set(["false", "0", "no", "off", ""]);

/**
 * Whether `arg` ENABLES `flag`: the bare flag, or `flag=<truthy>`. A valued-false
 * form (`--force=false`/`=0`/`=no`/`=off`) is NOT enabled — used for inference so a
 * config that explicitly disables bypass isn't mistaken for auto.
 */
export function flagEnabled(arg, flag) {
	if (arg === flag) return true;
	if (typeof arg === "string" && arg.startsWith(`${flag}=`)) {
		return !FALSY_FLAG_VALUES.has(arg.slice(flag.length + 1).trim().toLowerCase());
	}
	return false;
}

/** Remove every arg that matches any flag in `flags` (bare or `flag=value` form). */
export function stripFlags(args, flags = []) {
	return (args ?? []).filter((arg) => !flags.some((flag) => flagMatches(arg, flag)));
}

const PERMISSION_DIALECTS = {
	claude: {
		auto: { startupMode: "bypassPermissions", settings: { permissions: { defaultMode: "bypassPermissions" } } },
		gatedAuto: { settings: { permissions: { defaultMode: "default" } } },
		prompt: { settings: { permissions: { defaultMode: "default" } } },
		infer(agentSettings) {
			// Only the genuine bypass values mean auto. The broad aliases
			// coercePermissionMode accepts (allow/full/yolo) are NOT valid Claude
			// defaultMode values, so inferring auto from them would auto-approve cc
			// while Claude still enforces. Those belong to unified `permissions.mode`.
			const mode = String(agentSettings.settings?.permissions?.defaultMode ?? "").trim().toLowerCase();
			return mode === "bypasspermissions" || mode === "bypass" ? "auto" : undefined;
		},
	},
	codex: {
		auto: { config: { approval_policy: "never", sandbox_mode: "danger-full-access" } },
		gatedAuto: { config: { approval_policy: "on-request", sandbox_mode: "danger-full-access" } },
		prompt: { config: { approval_policy: "on-request" } },
		infer(agentSettings) {
			const config = agentSettings.config;
			return config?.approval_policy === "never" && config?.sandbox_mode === "danger-full-access" ? "auto" : undefined;
		},
	},
	cursor: {
		auto: { args: ["--force"] },
		gatedAuto: { removeArgs: CURSOR_FORCE_FLAGS },
		prompt: { removeArgs: CURSOR_FORCE_FLAGS },
		infer(agentSettings, appliedArgs) {
			// The FINAL applied args (base config + settings + acpArgs) so a --force
			// baked into the base acp.args (not just settings) is still detected. Match
			// both bare (`--force`) and valued (`--force=true`) forms.
			const args = [
				...stringArray(agentSettings.args ?? agentSettings.nativeArgs),
				...stringArray(agentSettings.acpArgs),
				...stringArray(appliedArgs),
			];
			return args.some((arg) => CURSOR_FORCE_FLAGS.some((flag) => flagEnabled(arg, flag))) ? "auto" : undefined;
		},
	},
};

/** Register (or override) a harness's native permission dialect at runtime. */
export function registerPermissionDialect(key, dialect) {
	PERMISSION_DIALECTS[key] = dialect;
}

/** The native dialect for a harness, or undefined (cc-side decisioning only). */
export function getPermissionDialect(key) {
	return PERMISSION_DIALECTS[key];
}

/**
 * Map a unified mode to a harness's native settings — generic over the harness's
 * registered dialect. `autoApprove` tells cc to auto-accept; the spawn-config keys
 * (startupMode/settings/config/args/removeArgs) configure or neutralize the backend
 * so cc and it never disagree. A harness with no dialect just gets `autoApprove`
 * for auto and {} for ask/deny (cc decides). `gated: true` (auto + deny rule) uses
 * the dialect's prompting variant so cc can still enforce the denial.
 */
export function nativePermissionConfig(agentKey, mode, { gated = false } = {}) {
	const dialect = getPermissionDialect(agentKey);
	if (mode === "auto") {
		const shape = gated ? dialect?.gatedAuto : dialect?.auto;
		return { autoApprove: true, ...clonePlain(shape ?? {}) };
	}
	if (mode === "ask" || mode === "deny") {
		// ask and deny share the SAME native shape (both make the backend prompt);
		// the difference is purely cc-side (mode drives decidePermission).
		return clonePlain(dialect?.prompt ?? {});
	}
	return {};
}

/**
 * Back-compat: derive a unified mode from native settings a user already wrote,
 * so existing settings.json files keep working — generic over the dialect's infer().
 */
export function inferModeFromNative(agentKey, agentSettings = {}, appliedArgs = []) {
	if (!isPlainObject(agentSettings)) return undefined;
	return getPermissionDialect(agentKey)?.infer?.(agentSettings, appliedArgs) ?? undefined;
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
