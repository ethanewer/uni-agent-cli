// BaseAcpAdapter — implements the entire HarnessAdapter interface over an
// AcpConnection (the generic ACP transport). In production the connection is the
// real AcpClient from pi-harness.mjs; tests inject a fake. Most harnesses are a
// ~10-line subclass that overrides only the hooks for their niceties.

import { AcpClient, autoCursorOutcome } from "../pi-harness.mjs";
import { capabilitiesFromWire, emptyCapabilities } from "./interface.mjs";
import {
	cancelledOutcome,
	decidePermission,
	inferModeFromNative,
	nativePermissionConfig,
	normalizePermissionSettings,
	outcomeForDecision,
	policyNeedsGating,
	resolvePermissionPolicy,
} from "./permissions.mjs";
import { clonePlain, isPlainObject, stringArray } from "./util.mjs";

/** The transport contract the base adapter depends on (satisfied by AcpClient). */
export function defaultConnectionFactory(agent, onEvent, options) {
	return new AcpClient(agent, onEvent, options);
}

/** Remove every `-c name=...` pair whose name is in `names` (codex `-c` form). */
function stripConfigArgs(args, names) {
	const drop = names.map((name) => `${name}=`);
	const next = [];
	for (let index = 0; index < args.length; index++) {
		const value = args[index + 1];
		if (args[index] === "-c" && typeof value === "string" && drop.some((prefix) => value.startsWith(prefix))) {
			index++;
			continue;
		}
		next.push(args[index]);
	}
	return next;
}

/**
 * The /review preset picker. Generic: any backend advertising review +
 * review-branch + review-commit gets it (matching the current
 * shouldOpenCodexReviewDialog). CodexAdapter additionally fires it by identity.
 */
export const REVIEW_PRESET = {
	kind: "preset-dialog",
	title: "Select a review preset",
	entries: [
		{ value: "branch", label: "Review against a base branch", description: "PR Style", prefix: "/review-branch " },
		{ value: "uncommitted", label: "Review uncommitted changes", prompt: "/review" },
		{ value: "commit", label: "Review a commit", prefix: "/review-commit " },
		{ value: "custom", label: "Custom review instructions", prefix: "/review " },
	],
};

export class BaseAcpAdapter {
	/**
	 * @param {string} key            registry key (e.g. "codex")
	 * @param {object} agentConfig    the registry entry { label, acp:{command,args}, ... }
	 * @param {object} host           { onEvent, requestPermission, requestInteraction }
	 * @param {object} [options]      { settings, globalPermissions, grants, connectionFactory }
	 */
	constructor(key, agentConfig, host, options = {}) {
		this.key = key;
		this.agentConfig = agentConfig ?? {};
		this.label = this.agentConfig.label ?? key;
		this.host = host ?? {};
		this.settings = options.settings ?? {};
		// Global (cross-harness) permissions block, if the host threads it in.
		this.globalPermissions = options.globalPermissions;
		// Persisted permission grants, owned by the host (it owns the store). They
		// participate in BOTH spawn-time gating (buildLaunchSpec, below) and runtime
		// decisions (permissionPolicy), so a remembered deny gates an auto launch.
		// Default [] keeps the adapter deterministic — no implicit fs reads.
		this.permissionGrants = Array.isArray(options.grants) ? options.grants : [];
		this.connectionFactory = options.connectionFactory ?? defaultConnectionFactory;
		this.connection = undefined;

		// The fully-resolved spawn spec, with native settings translated. This is
		// what cc would spawn and what carries _sessionMeta / _startupMode /
		// _autoPermissionRequests into AcpClient.
		this.launchSpec = this.buildLaunchSpec(this.settings);
		this.autoApprove = Boolean(this.launchSpec?._autoPermissionRequests);

		// Capabilities are valid after connect(); pre-connect they hold the declared
		// (static) subset so cc can reason about a harness before spawning it.
		this.capabilities = this.#computeCapabilities();
	}

	// ---- declared (static) capabilities — subclasses override -----------------

	/** Capabilities a harness knows about itself without talking to the wire. */
	declaredCapabilities() {
		return {};
	}

	#mergeCapabilities(wire = {}) {
		const declared = this.declaredCapabilities() ?? {};
		const base = emptyCapabilities();
		const merged = { ...base, ...wire, ...declared };
		// fork: prefer a native wire fork; otherwise honor a declared copy-fork.
		merged.fork = wire.fork || declared.fork || false;
		merged.autoApprove = this.autoApprove;
		merged.commandPresets = declared.commandPresets ?? base.commandPresets;
		return merged;
	}

	#computeCapabilities() {
		const sessionInfo = this.connection?.getSessionInfo?.() ?? {};
		const wire = this.connection ? capabilitiesFromWire(sessionInfo) : {};
		return this.refineCapabilities(this.#mergeCapabilities(wire), sessionInfo);
	}

	#recomputeCapabilities() {
		this.capabilities = this.#computeCapabilities();
	}

	/**
	 * Hook: narrow declared capabilities using live wire info after connect (e.g.
	 * codex only enables unsend when the backend is genuinely codex-acp). Base: none.
	 */
	refineCapabilities(caps) {
		return caps;
	}

	// ---- native-settings translation (replaces applyAgentSettings switches) ---

	/**
	 * Translate native settings into a spawn spec. The generic shape is identical
	 * to pi-harness.mjs applyAgentSettings; per-harness behavior is dispatched
	 * through the hooks below instead of a key switch.
	 */
	buildLaunchSpec(settings) {
		const applied = clonePlain(this.agentConfig);
		if (!isPlainObject(settings)) {
			this.applyPermissionMode(applied, {});
			return applied;
		}
		applied.env = { ...(applied.env ?? {}), ...(settings.env ?? {}) };
		if (applied.acp) applied.acp = clonePlain(applied.acp);

		const command = applied.acp ?? applied;
		const nativeArgs = stringArray(settings.args ?? settings.nativeArgs);
		if (nativeArgs.length > 0) command.args = this.applyNativeArgs(command.args ?? [], nativeArgs);

		const acpArgs = stringArray(settings.acpArgs);
		if (acpArgs.length > 0) command.args = [...(command.args ?? []), ...acpArgs];

		if (isPlainObject(settings.config)) command.args = this.translateConfig(command.args ?? [], settings.config);
		if (isPlainObject(settings.settings)) this.translateNativeSettings(applied, settings.settings);
		this.applyPermissionMode(applied, settings);
		return applied;
	}

	/**
	 * Resolve and apply the harness-agnostic permission mode. Replaces every
	 * per-harness `inferNativePermission` override: the unified engine knows each
	 * harness's native dialect, so the subclasses no longer branch on permissions.
	 * Explicit `permissions.mode` (per-agent then global) wins; otherwise it is
	 * inferred from native settings for back-compat.
	 */
	applyPermissionMode(applied, settings = {}) {
		const explicitMode =
			normalizePermissionSettings(settings.permissions).mode ?? normalizePermissionSettings(this.globalPermissions).mode;
		// Pass the FINAL applied command args so a cursor --force baked into the base
		// acp.args (not just settings) is still inferred as auto.
		const appliedArgs = (applied.acp ?? applied).args ?? [];
		const mode = explicitMode ?? inferModeFromNative(this.key, settings, appliedArgs);
		if (mode) applied._permissionMode = mode;
		if (!mode) return;
		// auto with a deny rule/grant must keep the backend prompting so cc can
		// enforce the denial — full native bypass would silence it. Persisted grants
		// (host-provided via options.grants) gate the launch spec, same as the live
		// pi-harness path threading them through applyHarnessSettings.
		const fullSettings = { permissions: this.globalPermissions, agents: { [this.key]: { permissions: settings.permissions } } };
		const gated = mode === "auto" && policyNeedsGating(resolvePermissionPolicy(fullSettings, this.key, this.permissionGrants));
		const native = nativePermissionConfig(this.key, mode, { gated });
		if (native.autoApprove) applied._autoPermissionRequests = true;
		if (native.startupMode) applied._startupMode = native.startupMode;
		// Generate the native dialect when the user chose the unified mode directly
		// (also neutralizing any conflicting native auto/bypass), OR when we must gate
		// an inferred auto so a deny rule is enforceable. Pure back-compat (inferred,
		// no gating) stays byte-identical — flags only.
		if (explicitMode || gated) this.applyGeneratedNativeConfig(applied, native);
	}

	applyGeneratedNativeConfig(applied, native) {
		const command = applied.acp ?? applied;
		if (native.settings) this.translateNativeSettings(applied, native.settings);
		if (native.config) {
			// Drop any existing `-c key=...` the user set so the generated values
			// win, then let the harness's own translateConfig append them.
			command.args = stripConfigArgs(command.args ?? [], Object.keys(native.config));
			command.args = this.translateConfig(command.args, native.config);
		}
		if (Array.isArray(native.removeArgs) && native.removeArgs.length > 0) {
			command.args = (command.args ?? []).filter((arg) => !native.removeArgs.includes(arg));
		}
		if (Array.isArray(native.args) && native.args.length > 0) {
			const existing = command.args ?? [];
			const missing = native.args.filter((arg) => !existing.includes(arg));
			if (missing.length > 0) command.args = this.applyNativeArgs(existing, missing);
		}
	}

	/** Hook: how native CLI args are merged. Base appends. */
	applyNativeArgs(baseArgs, nativeArgs) {
		return [...baseArgs, ...nativeArgs];
	}

	/** Hook: translate a `config` block into spawn args. Base ignores it. */
	translateConfig(baseArgs) {
		return baseArgs;
	}

	/** Hook: fold a `settings` block into native session meta. Base ignores it. */
	translateNativeSettings() {}

	// ---- lifecycle (required) -------------------------------------------------

	async connect(options = {}) {
		this.connection = this.connectionFactory(this.launchSpec, (event) => this.#onConnectionEvent(event), {
			onPermissionRequest: (params) => this.#onPermission(params),
			onCursorRequest: (method, params) => this.handleExtensionRequest(method, params),
		});
		const initialized = await this.connection.initialize(options);
		this.#recomputeCapabilities();
		return initialized;
	}

	async newSession(options = {}) {
		return this.connection.newSession(options);
	}

	async prompt(parts) {
		return this.connection.prompt(parts);
	}

	cancel() {
		this.connection?.cancel?.();
	}

	stop() {
		this.connection?.stop?.();
	}

	getSessionInfo() {
		return this.connection?.getSessionInfo?.() ?? {};
	}

	get sessionId() {
		return this.connection?.sessionId;
	}

	// ---- sessions (capability-gated) ------------------------------------------

	async listSessions() {
		return this.connection.listSessions();
	}

	async loadSession(sessionId) {
		return this.connection.loadSession(sessionId);
	}

	/** Native fork. Codex overrides this with a copy-fork. */
	async fork(parentSessionId, options = {}) {
		if (this.connection?.supportsFork?.()) return this.connection.forkSession(parentSessionId, options);
		throw new Error("this harness does not support session forking");
	}

	// ---- config / modes (capability-gated) ------------------------------------

	async setConfigOption(configId, value) {
		return this.connection.setConfigOption(configId, value);
	}

	async setMode(modeId) {
		return this.connection.setMode(modeId);
	}

	// ---- prompt retraction / unsend (capability-gated) ------------------------

	/** Opaque snapshot of "has the just-sent prompt been committed?" Base: none. */
	snapshotRetractionState() {
		return undefined;
	}

	/** Whether the last prompt is still retractable given a prior snapshot. */
	canRetract() {
		return false;
	}

	// ---- command presets (capability-gated) -----------------------------------

	/**
	 * Intercept a slash command before it reaches the backend. Return a
	 * PresetDialog descriptor for cc to render, or null to pass through. The
	 * generic rule: a bare `/review` is intercepted when the backend advertises
	 * the review / review-branch / review-commit command trio.
	 */
	interceptCommand(name, argument, backendNames = new Set()) {
		if (name === "review" && !argument && backendNames.has("review") && backendNames.has("review-branch") && backendNames.has("review-commit")) {
			return REVIEW_PRESET;
		}
		return null;
	}

	// ---- backend-initiated extension requests ---------------------------------

	/**
	 * Handle a backend-initiated interactive request (e.g. cursor/ask_question,
	 * cursor/create_plan). When the mode auto-approves, resolve it with the generic
	 * auto-outcome; otherwise route to the host for a real answer. (Interactive
	 * questions have no meaningful "deny" outcome, so only auto is short-circuited.)
	 */
	async handleExtensionRequest(method, params) {
		if (this.permissionPolicy().mode === "auto") return autoCursorOutcome(method, params);
		if (typeof this.host.requestInteraction === "function") {
			return this.host.requestInteraction(method, params);
		}
		return undefined;
	}

	// ---- internals ------------------------------------------------------------

	/**
	 * The effective, harness-agnostic policy for this adapter: settings.permissions
	 * (per-agent + global) + persisted grants (host-provided via options.grants /
	 * setPermissionGrants), with the mode resolved by applyPermissionMode (explicit
	 * > native-inferred). The host owns persistence; the adapter never reads fs.
	 */
	permissionPolicy() {
		const settings = {
			permissions: this.globalPermissions,
			agents: { [this.key]: { permissions: this.settings?.permissions } },
		};
		const policy = resolvePermissionPolicy(settings, this.key, this.permissionGrants);
		policy.mode = this.launchSpec?._permissionMode ?? policy.mode;
		return policy;
	}

	/**
	 * Refresh the persisted grants for runtime decisions (the host owns the store).
	 * Note: the launch spec was already gated from the grants passed at construction;
	 * changing grants here does not re-gate an already-spawned backend.
	 */
	setPermissionGrants(grants) {
		this.permissionGrants = Array.isArray(grants) ? grants : [];
	}

	// Decide allow/deny/ask uniformly via the shared engine; only "ask" reaches the
	// host. This mirrors pi-harness HarnessApp.resolvePermissionOutcome exactly, so
	// moving cc onto adapters keeps identical behavior.
	#onPermission(params) {
		const policy = this.permissionPolicy();
		const decision = decidePermission(policy, params, { agentKey: this.key });
		if (decision.action !== "ask") return outcomeForDecision(decision);
		if (typeof this.host.requestPermission === "function") {
			return this.host.requestPermission(params, { agentKey: this.key, policy });
		}
		return cancelledOutcome();
	}

	#onConnectionEvent(event) {
		// configOptions / modes / models arrive via session_info; keep caps fresh.
		if (event?.type === "session_info") this.#recomputeCapabilities();
		this.host.onEvent?.(event);
	}
}
