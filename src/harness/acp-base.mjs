// BaseAcpAdapter — implements the entire HarnessAdapter interface over an
// AcpConnection (the generic ACP transport). In production the connection is the
// real AcpClient from pi-harness.mjs; tests inject a fake. Most harnesses are a
// ~10-line subclass that overrides only the hooks for their niceties.

import { AcpClient, autoCursorOutcome, autoPermissionOutcome } from "../pi-harness.mjs";
import { capabilitiesFromWire, emptyCapabilities } from "./interface.mjs";
import { inferModeFromNative, nativePermissionConfig, normalizePermissionSettings } from "./permissions.mjs";
import { clonePlain, isPlainObject, stringArray } from "./util.mjs";

/** The transport contract the base adapter depends on (satisfied by AcpClient). */
export function defaultConnectionFactory(agent, onEvent, options) {
	return new AcpClient(agent, onEvent, options);
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
	 * @param {object} [options]      { settings, connectionFactory }
	 */
	constructor(key, agentConfig, host, options = {}) {
		this.key = key;
		this.agentConfig = agentConfig ?? {};
		this.label = this.agentConfig.label ?? key;
		this.host = host ?? {};
		this.settings = options.settings ?? {};
		// Global (cross-harness) permissions block, if the host threads it in.
		this.globalPermissions = options.globalPermissions;
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
		const mode = explicitMode ?? inferModeFromNative(this.key, settings);
		if (mode) applied._permissionMode = mode;
		if (!mode || mode === "ask") return;
		const native = nativePermissionConfig(this.key, mode);
		if (native.autoApprove) applied._autoPermissionRequests = true;
		if (native.startupMode) applied._startupMode = native.startupMode;
		// Generate the native backend config only when the user chose the unified
		// mode directly (back-compat native settings must stay byte-identical).
		if (explicitMode === "auto") this.applyGeneratedNativeConfig(applied, native);
	}

	applyGeneratedNativeConfig(applied, native) {
		const command = applied.acp ?? applied;
		if (native.settings) this.translateNativeSettings(applied, native.settings);
		if (native.config) command.args = this.translateConfig(command.args ?? [], native.config);
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
	 * cursor/create_plan). When auto-accept is on, resolve it with the generic
	 * auto-outcome (mirrors pi-harness using autoCursorOutcome under _autoPermissionRequests);
	 * otherwise route to the host for a real answer.
	 */
	async handleExtensionRequest(method, params) {
		if (this.capabilities.autoApprove) return autoCursorOutcome(method, params);
		if (typeof this.host.requestInteraction === "function") {
			return this.host.requestInteraction(method, params);
		}
		return undefined;
	}

	// ---- internals ------------------------------------------------------------

	#onPermission(params) {
		if (this.capabilities.autoApprove) return autoPermissionOutcome(params);
		if (typeof this.host.requestPermission === "function") return this.host.requestPermission(params);
		return { outcome: "cancelled" };
	}

	#onConnectionEvent(event) {
		// configOptions / modes / models arrive via session_info; keep caps fresh.
		if (event?.type === "session_info") this.#recomputeCapabilities();
		this.host.onEvent?.(event);
	}
}
