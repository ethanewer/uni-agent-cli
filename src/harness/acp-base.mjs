// BaseAcpAdapter — implements the entire HarnessAdapter interface over an
// AcpConnection (the generic ACP transport). The embedding host injects the
// connection factory; tests inject a fake. Most harnesses are a
// ~10-line subclass that overrides only the hooks for their niceties.

import {
	autoCursorOutcome,
	cursorActionName,
	cursorCancelResult,
	mergeEnvironments,
	stopConnectionsForReplacement,
} from "./acp-runtime.mjs";
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
	stripFlags,
} from "./permissions.mjs";
import { clonePlain, isPlainObject, stringArray } from "./util.mjs";

/** Fail clearly when an embedding host forgets to supply its ACP transport. */
export function defaultConnectionFactory() {
	throw new Error("Harness adapter requires an ACP connectionFactory");
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
	 * @param {object} host           UI callbacks (events, permissions, auth, elicitation)
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
		this.services = options.services ?? {};
		this.connectionFactory = options.connectionFactory ?? this.services.connectionFactory ?? defaultConnectionFactory;
		this.stopConnections = options.stopConnections ?? this.services.stopConnections ?? stopConnectionsForReplacement;
		this.runtimePermissionMode = undefined;
		this.connection = undefined;
		this.connectOptions = {};
		this.replacementProcessFence = undefined;
		this.lifecycleTail = undefined;
		this.lifecycleState = "open";
		this.stopPromise = undefined;
		this.clientAuthenticationOperations = new Set();

		// The fully-resolved spawn spec, with native settings translated. This is
		// what cc would spawn and what carries _sessionMeta / _startupMode /
		// _autoPermissionRequests into AcpClient.
		this.launchSpec = options.launchSpec
			? clonePlain(options.launchSpec)
			: this.buildLaunchSpec(this.settings);
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
		if (Array.isArray(settings.mcpServers)) applied.mcpServers = clonePlain(settings.mcpServers);
		if (Array.isArray(settings.additionalDirectories)) applied.additionalDirectories = [...settings.additionalDirectories];
		if (isPlainObject(settings.sessionDefaults)) {
			applied._sessionDefaults = {
				...(typeof settings.sessionDefaults.model === "string" && settings.sessionDefaults.model
					? { model: settings.sessionDefaults.model }
					: {}),
				...(typeof settings.sessionDefaults.effort === "string" && settings.sessionDefaults.effort
					? { effort: settings.sessionDefaults.effort }
					: {}),
			};
		}

		const command = applied.acp ?? applied;
		const nativeArgs = stringArray(settings.args ?? settings.nativeArgs);
		if (nativeArgs.length > 0) command.args = this.applyNativeArgs(command.args ?? [], nativeArgs);

		const acpArgs = stringArray(settings.acpArgs);
		if (acpArgs.length > 0) command.args = [...(command.args ?? []), ...acpArgs];

		if (isPlainObject(settings.config)) this.translateConfig(applied, settings.config);
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
		// Mark a genuine native-bypass launch (non-gated auto on a harness that has a
		// bypass dialect) so the host can tell when a runtime tighten needs a respawn.
		if (mode === "auto" && !gated && (native.startupMode || native.config || native.args)) {
			applied._nativeBypass = true;
		}
		// Generate the native dialect when the user chose the unified mode directly
		// (also neutralizing any conflicting native auto/bypass), OR when we must gate
		// an inferred auto so a deny rule is enforceable. Pure back-compat (inferred,
		// no gating) stays byte-identical — flags only.
		if (explicitMode || gated) this.applyGeneratedNativeConfig(applied, native);
	}

	applyGeneratedNativeConfig(applied, native) {
		const command = applied.acp ?? applied;
		if (native.settings) this.translateNativeSettings(applied, native.settings);
		if (Array.isArray(native.removeConfig) && native.removeConfig.length > 0) this.removeConfig(applied, native.removeConfig);
		if (native.config) {
			// Drop any legacy `-c key=...` values before applying the harness's
			// current config transport. Generated values must win.
			command.args = stripConfigArgs(command.args ?? [], Object.keys(native.config));
			this.translateConfig(applied, native.config);
		}
		if (Array.isArray(native.removeArgs) && native.removeArgs.length > 0) {
			command.args = stripFlags(command.args ?? [], native.removeArgs);
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

	/** Hook: translate a `config` block into the launch spec. Base ignores it. */
	translateConfig() {}

	/** Hook: remove native config keys superseded by unified settings. */
	removeConfig() {}

	/** Hook: fold a `settings` block into native session meta. Base ignores it. */
	translateNativeSettings() {}

	// ---- lifecycle (required) -------------------------------------------------

	async #runLifecycleOperation(operation) {
		this.#assertLifecycleOpen();
		const previous = this.lifecycleTail ?? Promise.resolve();
		let release;
		const turn = new Promise((resolve) => { release = resolve; });
		const tail = previous.then(() => turn);
		this.lifecycleTail = tail;
		await previous;
		try {
			// stop() marks the adapter closing before it waits for an operation that
			// already owns the lifecycle turn. Re-check here so work queued before that
			// mark cannot start a backend after shutdown.
			this.#assertLifecycleOpen();
			if (this.replacementProcessFence) throw this.#replacementProcessFenceError();
			return await operation();
		} finally {
			release();
			if (this.lifecycleTail === tail) this.lifecycleTail = undefined;
		}
	}

	async connect(options = {}) {
		return await this.#runLifecycleOperation(() => this.#connectUnlocked(options));
	}

	async #connectUnlocked(options = {}) {
		this.#assertLifecycleOpen();
		if (this.replacementProcessFence) throw this.#replacementProcessFenceError();
		this.connectOptions = { ...options };
		let connection;
		const isCurrentConnection = () => this.connection === connection;
		connection = this.connectionFactory(this.launchSpec, (event) => {
			if (isCurrentConnection()) this.#onConnectionEvent(event);
		}, {
			onPermissionRequest: (params) =>
				isCurrentConnection() ? this.#onPermission(params) : cancelledOutcome(),
			onCursorRequest: (method, params) =>
				isCurrentConnection() ? this.handleExtensionRequest(method, params) : cursorCancelResult(method),
			onElicitationRequest:
				typeof this.host.onElicitationRequest === "function"
					? (params) =>
						isCurrentConnection()
							? this.host.onElicitationRequest(params)
							: { action: "cancel" }
					: undefined,
			elicitationCapabilities:
				typeof this.host.onElicitationRequest === "function"
					? this.host.elicitationCapabilities
					: undefined,
		});
		this.connection = connection;
		try {
			const initialized = await connection.initialize(options);
			// If stop() ran while initialize was pending it already retired this
			// connection. Do not let the interrupted connect appear successful.
			this.#assertLifecycleOpen();
			await this.afterConnectionInitialized(connection, initialized, options);
			return initialized;
		} finally {
			// Authentication methods arrive in the initialize response before a first
			// session can fail for lack of credentials. Keep them visible to the host
			// even when initialize() rejects while creating that session.
			this.#recomputeCapabilities();
		}
	}

	async newSession(options = {}) {
		return this.connection.newSession(options);
	}

	// Harnesses with process-external session ownership can bind the session that
	// initialize/session-new created without leaking storage details into the TUI.
	async afterConnectionInitialized() {}

	// Authentication reconnects retire a backend outside stop(). Give adapters a
	// matching post-quiescence hook before a replacement process can be launched.
	async afterConnectionsRetired() {}

	async prompt(parts) {
		return this.connection.prompt(parts);
	}

	cancel() {
		this.connection?.cancel?.();
	}

	stop() {
		if (this.stopPromise) return this.stopPromise;
		// Closing is observable synchronously. Authentication may currently be
		// waiting on terminal/UI credential collection outside the lifecycle queue;
		// it must see this state when it resumes and never reconnect.
		this.lifecycleState = "closing";
		// Session credentials have no useful lifetime once this adapter is terminally
		// closed. Drop an already-installed environment before awaiting child teardown.
		delete this.launchSpec._sessionAuthEnv;
		let resolveStop;
		let rejectStop;
		this.stopPromise = new Promise((resolve, reject) => {
			resolveStop = resolve;
			rejectStop = reject;
		});
		const connection = this.connection;
		this.connection = undefined;
		const lifecycleTail = this.lifecycleTail ?? Promise.resolve();
		// Client-side authentication runs before the serialized reconnect turn. Abort
		// it now and retain an awaitable for both the credential collector and any
		// terminal process tree it registered.
		const authenticationShutdowns = [...this.clientAuthenticationOperations]
			.map((operation) => operation.stopAndWait());
		let connectionShutdown;
		try {
			// Production AcpClient instances need their complete process tree reaped,
			// not merely signalled. The helper retains the synchronous stop fallback for
			// lightweight injected connections used by other adapters and tests.
			connectionShutdown = this.stopConnections([connection]);
		} catch (error) {
			connectionShutdown = Promise.reject(error);
		}
		void (async () => {
			const results = await Promise.allSettled([
				Promise.resolve(connectionShutdown),
				lifecycleTail,
				...authenticationShutdowns,
			]);
			this.lifecycleState = "stopped";
			const failure = results.find((result) => result.status === "rejected");
			if (failure) throw failure.reason;
			return results[0].value;
		})().then(resolveStop, rejectStop);
		return this.stopPromise;
	}

	getSessionInfo() {
		return this.connection?.getSessionInfo?.() ?? {};
	}

	get sessionId() {
		return this.connection?.sessionId;
	}

	get exited() {
		return this.lifecycleState !== "open" || this.connection?.exited === true;
	}

	get stopping() {
		return this.lifecycleState !== "open" || this.connection?.stopping === true;
	}

	get agentInfo() {
		return this.getSessionInfo().agentInfo ?? {};
	}

	get authMethods() {
		return this.getSessionInfo().authMethods ?? [];
	}

	get configOptions() {
		return this.getSessionInfo().configOptions ?? [];
	}

	get models() {
		return this.getSessionInfo().models;
	}

	get modes() {
		return this.getSessionInfo().modes;
	}

	// The host's process-tree fence uses this name to distinguish production
	// clients from lightweight synchronous test doubles.
	stopAndWait() {
		return this.stop();
	}

	// Settle a backend that acknowledged cancel but omitted the prompt response.
	forceResolvePrompt() {
		return this.connection?.forceResolvePrompt?.() ?? false;
	}

	// ---- sessions (capability-gated) ------------------------------------------

	async listSessions() {
		return this.connection.listSessions();
	}

	async loadSession(sessionId, options = {}) {
		return this.connection.loadSession(sessionId, options);
	}

	// Adapters with process-external session ownership can hold a guard across a
	// load. The base is deliberately a no-op so the host keeps one interface and
	// does not need harness-specific storage knowledge.
	async acquireSessionLoadGuard() {
		return () => true;
	}

	async deleteSession(sessionId) {
		return this.connection.deleteSession(sessionId);
	}

	/** Native fork. Codex overrides this with a copy-fork. */
	async fork(parentSessionId, options = {}) {
		if (this.connection?.supportsFork?.()) return this.connection.forkSession(parentSessionId, options);
		throw new Error("this harness does not support session forking");
	}

	// ---- config / modes (capability-gated) ------------------------------------

	async setConfigOption(configId, value, type = undefined) {
		return this.connection.setConfigOption(configId, value, type);
	}

	setSessionDefaults(defaults = {}) {
		const normalized = {
			...(typeof defaults.model === "string" && defaults.model ? { model: defaults.model } : {}),
			...(typeof defaults.effort === "string" && defaults.effort ? { effort: defaults.effort } : {}),
		};
		this.launchSpec._sessionDefaults = normalized;
		if (this.connection?.agent) this.connection.agent._sessionDefaults = normalized;
	}

	async setMode(modeId) {
		return this.connection.setMode(modeId);
	}

	// ---- working directory (capability-gated) ---------------------------------

	supportsChangeWorkingDirectory() {
		return this.capabilities.changeWorkingDirectory === true;
	}

	async changeWorkingDirectory(targetPath, options = {}) {
		if (!this.capabilities.changeWorkingDirectory) {
			throw new Error("this harness does not advertise live working-directory changes");
		}
		return this.connection.changeWorkingDirectory(targetPath, options);
	}

	// ---- transcript context (capability-gated) --------------------------------

	async appendContext(text) {
		if (!this.capabilities.appendContext) {
			throw new Error("this harness does not advertise context-only transcript input");
		}
		return this.connection.appendContext(text);
	}

	// ---- background tasks (capability-gated) ---------------------------------

	async listBackgroundTasks(options = {}) {
		if (!this.capabilities.backgroundTasks) {
			throw new Error("this harness does not advertise background-task lifecycle support");
		}
		return this.connection.listBackgroundTasks(options);
	}

	async stopBackgroundTask(taskId) {
		if (!this.capabilities.backgroundTasks) {
			throw new Error("this harness does not advertise background-task lifecycle support");
		}
		return this.connection.stopBackgroundTask(taskId);
	}

	async backgroundTasks(toolUseId = undefined) {
		if (!this.capabilities.backgroundTasks) {
			throw new Error("this harness does not advertise background-task lifecycle support");
		}
		return this.connection.backgroundTasks(toolUseId);
	}

	// ---- checkpoints / rewind (capability-gated) -----------------------------

	async listCheckpoints(options = {}) {
		if (!this.capabilities.checkpoints) {
			throw new Error("this harness does not advertise checkpoint support");
		}
		return this.connection.listCheckpoints(options);
	}

	async rewindCheckpoint(checkpointId, mode, options = {}) {
		if (!this.capabilities.checkpoints) {
			throw new Error("this harness does not advertise checkpoint support");
		}
		return this.connection.rewindCheckpoint(checkpointId, mode, options);
	}

	// ---- Remote Control (capability-gated) ------------------------------------

	async setRemoteControl(options = {}) {
		if (!this.capabilities.remoteControl) {
			throw new Error("this harness does not advertise Remote Control support");
		}
		return this.connection.setRemoteControl(options);
	}

	// ---- authentication (capability-gated) ------------------------------------

	async authenticate(methodId, meta = undefined) {
		this.#assertLifecycleOpen();
		const method = (this.connection?.getSessionInfo?.().authMethods ?? []).find((entry) => entry?.id === methodId);
		if (method?.type === "terminal") {
			await this.#runClientAuthentication(async ({ signal, processTracker }) => {
				const context = { adapter: this, meta, signal, processTracker };
				const runner = this.host.runTerminalAuthentication ?? this.services.runTerminalAuthentication;
				if (typeof runner !== "function") {
					throw new Error("This ACP authentication method requires a terminal-authentication host callback");
				}
				await runner(this.launchSpec, method, context);
			});
			this.#assertLifecycleOpen();
			delete this.launchSpec._signedOutAuthEnvNames;
			return await this.#reconnectAfterClientAuthentication();
		}
		if (method?.type === "env_var") {
			const command = this.launchSpec?.acp ?? this.launchSpec;
			const configuredEnvironment = mergeEnvironments([process.env, this.launchSpec?.env, command?.env]);
			const credentials = await this.#runClientAuthentication(async ({ signal }) => {
				const context = { adapter: this, meta, signal };
				const collect = this.host.collectEnvironmentVariables ?? this.services.collectEnvironmentVariables;
				if (typeof collect !== "function") {
					throw new Error("This ACP authentication method requires an environment-credential host callback");
				}
				return await collect(method, configuredEnvironment, context);
			});
			this.#assertLifecycleOpen();
			const authenticationEnvironment = this.#validatedAuthenticationEnvironment(method, credentials);
			return await this.#reconnectAfterClientAuthentication(this.connection, {}, authenticationEnvironment);
		}
		const connection = this.connection;
		let authenticationMeta = meta;
		if (
			authenticationMeta === undefined &&
			normalizedAuthenticationMethodId(methodId) === "apikey" &&
			connection.agentInfo?.name === "@agentclientprotocol/codex-acp"
		) {
			const command = this.launchSpec?.acp ?? this.launchSpec;
			const environment = mergeEnvironments([process.env, this.launchSpec?.env, command?.env]);
			const apiKey = authenticationEnvironmentValue(environment, "CODEX_API_KEY") ||
				authenticationEnvironmentValue(environment, "OPENAI_API_KEY");
			if (apiKey) authenticationMeta = { "api-key": { apiKey } };
		}
		const result = await connection.authenticate(methodId, authenticationMeta);
		this.#assertLifecycleOpen();
		// A concurrent logout can retire this connection while its authentication
		// RPC is still pending. Treat that completion as stale: it authenticated the
		// retired process, not the replacement that will receive future prompts.
		if (this.connection !== connection) {
			const error = new Error("Authentication completed after the backend connection was replaced; try signing in again");
			error.code = "ACP_CONNECTION_REPLACED";
			throw error;
		}
		// Only a successful explicit authentication lifts the post-logout launch
		// mask. Failed attempts remain signed out.
		delete this.launchSpec._signedOutAuthEnvNames;
		// Some agents advertise their authentication methods during initialize, but
		// reject the initial session/new until authenticate succeeds. Complete that
		// interrupted startup here so a successful /login leaves the adapter ready to
		// accept prompts instead of retaining an authenticated, sessionless connection.
		if (this.connection === connection && !connection.sessionId) await this.newSession();
		return result;
	}

	async #runClientAuthentication(operation) {
		this.#assertLifecycleOpen();
		const controller = new AbortController();
		const stoppers = new Set();
		const entry = {
			controller,
			stoppers,
			rawPromise: undefined,
			stopPromise: undefined,
			stopAndWait: () => {
				if (entry.stopPromise) return entry.stopPromise;
				controller.abort(this.#lifecycleStoppedError());
				// Invoke every registered tree stop in this synchronous shutdown phase.
				// A helper that registers after the abort observes it in register() below.
				for (const stopper of stoppers) void stopper.start().catch(() => {});
				entry.stopPromise = (async () => {
					const operationResult = await Promise.allSettled([entry.rawPromise]);
					const stopResults = await Promise.allSettled([...stoppers].map((stopper) => stopper.start()));
					const stopFailure = stopResults.find((result) => result.status === "rejected");
					if (stopFailure) throw stopFailure.reason;
					const operationFailure = operationResult.find(
						(result) => result.status === "rejected" && result.reason?.code === "PROCESS_TREE_TERMINATION_FAILED",
					);
					if (operationFailure) throw operationFailure.reason;
				})();
				return entry.stopPromise;
			},
		};
		const processTracker = {
			assertOpen: () => {
				if (controller.signal.aborted || this.lifecycleState !== "open") throw this.#lifecycleStoppedError();
			},
			register: (stopAndWait) => {
				const stopper = {
					promise: undefined,
					start: () => {
						if (stopper.promise) return stopper.promise;
						try {
							stopper.promise = Promise.resolve(stopAndWait());
						} catch (error) {
							stopper.promise = Promise.reject(error);
						}
						return stopper.promise;
					},
				};
				stoppers.add(stopper);
				if (controller.signal.aborted) void stopper.start().catch(() => {});
				return () => {
					// Retain the registration until this authentication operation settles so
					// shutdown can await a stop that raced natural process completion.
				};
			},
		};
		entry.rawPromise = Promise.resolve().then(() => operation({ signal: controller.signal, processTracker }));
		this.clientAuthenticationOperations.add(entry);
		try {
			return await entry.rawPromise;
		} catch (error) {
			if (this.lifecycleState !== "open" && error?.code !== "PROCESS_TREE_TERMINATION_FAILED") {
				throw this.#lifecycleStoppedError(error);
			}
			throw error;
		} finally {
			this.clientAuthenticationOperations.delete(entry);
		}
	}

	async logout() {
		this.#assertLifecycleOpen();
		const connection = this.connection;
		const authenticationEnvironmentNames = signedOutAuthenticationEnvironmentNames(
			connection?.getSessionInfo?.().authMethods,
			this.launchSpec,
		);
		const beganWithSessionAuthEnvironment = Object.hasOwn(this.launchSpec, "_sessionAuthEnv");
		const result = await connection.logout();
		this.#assertLifecycleOpen();
		// Authentication can reconnect this adapter while the logout RPC is in
		// flight. Re-read the launch spec after the await so a credential-bearing
		// replacement created by that race is retired as well.
		const endedWithSessionAuthEnvironment = Object.hasOwn(this.launchSpec, "_sessionAuthEnv");
		if (
			beganWithSessionAuthEnvironment ||
			endedWithSessionAuthEnvironment ||
			authenticationEnvironmentNames.length > 0
		) {
			maskSignedOutAuthenticationEnvironment(this.launchSpec, authenticationEnvironmentNames);
		}
		delete this.launchSpec._sessionAuthEnv;
		// An ACP logout response does not guarantee that an existing session is safe
		// to continue using. Always retire the process that handled logout, including
		// non-environment authentication, and initialize a signed-out replacement
		// without creating a session. Passing the original connection also lets the
		// reconnect helper retire a replacement created by a racing lifecycle action.
		await this.#reconnectAfterClientAuthentication(connection, { createSession: false });
		return result;
	}

	async #reconnectAfterClientAuthentication(
		connectionToRetire = this.connection,
		optionOverrides = {},
		authenticationEnvironment = undefined,
	) {
		return await this.#runLifecycleOperation(async () => {
			this.#assertLifecycleOpen();
			// Terminal authentication persists credentials outside the ACP process. Drop
			// a stale session-only environment as soon as this serialized turn starts, so
			// even a recoverable failure while retiring the old connection cannot make a
			// later connect override the newly persisted login. Environment-variable auth
			// still installs its new secret only after the old tree is confirmed gone.
			if (authenticationEnvironment === undefined) delete this.launchSpec._sessionAuthEnv;
			const savedConnectOptions = { ...this.connectOptions };
			const connectOptions = { ...savedConnectOptions, ...optionOverrides };
			const currentConnection = this.connection;
			// Detach first so synchronous stop/exit callbacks from either retired
			// connection are treated as stale and cannot reach the host.
			this.connection = undefined;
			try {
				// Environment credentials are inherited at spawn time. Do not launch the
				// replacement until every old connection has either exited gracefully or
				// been force-killed with its complete process tree confirmed gone.
					try {
						await this.stopConnections([connectionToRetire, currentConnection]);
				} catch (error) {
					if (error?.code === "PROCESS_TREE_TERMINATION_FAILED") {
						this.replacementProcessFence ??= error;
						throw this.#replacementProcessFenceError();
					}
						throw error;
					}
					await this.afterConnectionsRetired([connectionToRetire, currentConnection]);
					// stop() may have run while the retired process tree was settling. It
				// owns shutdown from that point onward, so neither credentials nor a new
				// connection may be installed by this lifecycle turn.
				this.#assertLifecycleOpen();
				// Bind credentials to this serialized lifecycle turn. Authentication
				// collection happens before entering the lifecycle mutex, so writing the
				// shared launch spec any earlier lets a concurrent /login overwrite the
				// credentials before this turn launches its replacement.
				if (authenticationEnvironment !== undefined) this.launchSpec._sessionAuthEnv = authenticationEnvironment;
				const initialized = await this.#connectUnlocked(connectOptions);
				if (authenticationEnvironment !== undefined) delete this.launchSpec._signedOutAuthEnvNames;
				return initialized;
			} finally {
				// Internal lifecycle reconnects must not redefine how callers requested a
				// normal connection. In particular, the logout-only createSession:false
				// must not suppress session creation after the next successful /login.
				this.connectOptions = savedConnectOptions;
			}
		});
	}

	#assertLifecycleOpen() {
		if (this.lifecycleState === "open") return;
		throw this.#lifecycleStoppedError();
	}

	#lifecycleStoppedError(cause = undefined) {
		const error = new Error(`Harness adapter "${this.key}" is stopping or has been stopped`);
		error.code = "ADAPTER_STOPPED";
		if (cause !== undefined) error.cause = cause;
		return error;
	}

	#replacementProcessFenceError() {
		const detail = this.replacementProcessFence?.message;
		const error = new Error(
			"Backend restart is blocked because a previous process tree could not be confirmed stopped. " +
				"Manually terminate the old backend process tree, then restart cc" +
				(detail ? ` (${detail})` : ""),
		);
		error.code = "PROCESS_TREE_TERMINATION_FAILED";
		error.cause = this.replacementProcessFence;
		return error;
	}

	#validatedAuthenticationEnvironment(method, value) {
		if (!isPlainObject(value)) throw new Error("environment authentication was cancelled or returned invalid credentials");
		const advertised = new Map(
			(method.vars ?? [])
				.filter((variable) => typeof variable?.name === "string")
				.map((variable) => [variable.name, variable]),
		);
		const credentials = {};
		for (const [name, entry] of Object.entries(value)) {
			if (!advertised.has(name)) throw new Error(`environment authentication returned an unadvertised variable: ${name}`);
			if (typeof entry !== "string" || entry.includes("\0")) {
				throw new Error(`environment authentication variable ${name} must be text without NUL bytes`);
			}
			if (entry) credentials[name] = entry;
		}
		for (const [name, variable] of advertised) {
			if (variable.optional !== true && !credentials[name]) {
				throw new Error(`environment authentication variable ${name} is required`);
			}
		}
		return credentials;
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
	 * cursor/create_plan) through the SAME policy engine as tool permissions: a
	 * matching deny rule/grant or deny mode rejects; allow/auto accepts; otherwise
	 * route to the host. (Mode alone is not enough — a deny rule under auto must
	 * still reject.)
	 */
	async handleExtensionRequest(method, params) {
		const policy = this.permissionPolicy();
		const synthetic = { toolCall: { title: cursorActionName(params), kind: method }, options: [] };
		const decision = decidePermission(policy, synthetic, { agentKey: this.key });
		if (decision.action === "deny") return cursorCancelResult(method);
		if (decision.action === "allow") return autoCursorOutcome(method, params);
		if (typeof this.host.requestInteraction === "function") {
			return this.host.requestInteraction(method, params, { adapter: this });
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
		policy.mode = this.runtimePermissionMode ?? this.launchSpec?._permissionMode ?? policy.mode;
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

	/** Host-owned, in-memory /yolo override for this exact adapter. */
	setRuntimePermissionMode(mode = undefined) {
		if (mode !== undefined && !["ask", "auto", "deny"].includes(mode)) {
			throw new Error(`Unsupported runtime permission mode: ${mode}`);
		}
		this.runtimePermissionMode = mode;
	}

	// Decide allow/deny/ask uniformly via the shared engine; only "ask" reaches the
	// host. This mirrors pi-harness HarnessApp.resolvePermissionOutcome exactly, so
	// moving cc onto adapters keeps identical behavior.
	#onPermission(params) {
		const policy = this.permissionPolicy();
		const decision = decidePermission(policy, params, { agentKey: this.key });
		if (decision.action !== "ask") return outcomeForDecision(decision);
		if (typeof this.host.requestPermission === "function") {
			return this.host.requestPermission(params, {
				agentKey: this.key,
				adapter: this,
				sourceClient: this,
				policy,
			});
		}
		return cancelledOutcome();
	}

	#onConnectionEvent(event) {
		// configOptions / modes / models arrive via session_info; keep caps fresh.
		if (event?.type === "session_info") this.#recomputeCapabilities();
		this.host.onEvent?.(event);
	}
}

function signedOutAuthenticationEnvironmentNames(authMethods = [], launchSpec = {}) {
	const names = new Set();
	for (const method of Array.isArray(authMethods) ? authMethods : []) {
		for (const variable of Array.isArray(method?.vars) ? method.vars : []) {
			if (isEnvironmentVariableName(variable?.name)) names.add(variable.name);
		}
		if (normalizedAuthenticationMethodId(method?.id) === "apikey") {
			names.add("CODEX_API_KEY");
			names.add("OPENAI_API_KEY");
		}
	}
	for (const name of Object.keys(launchSpec?._sessionAuthEnv ?? {})) {
		if (isEnvironmentVariableName(name)) names.add(name);
	}
	return [...names];
}

function maskSignedOutAuthenticationEnvironment(launchSpec, names) {
	const merged = new Set([
		...(Array.isArray(launchSpec?._signedOutAuthEnvNames) ? launchSpec._signedOutAuthEnvNames : []),
		...(Array.isArray(names) ? names : []),
	].filter(isEnvironmentVariableName));
	if (merged.size > 0) launchSpec._signedOutAuthEnvNames = [...merged];
}

function isEnvironmentVariableName(name) {
	return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

function normalizedAuthenticationMethodId(value) {
	return String(value ?? "").toLowerCase().replace(/[-_]/g, "");
}

function authenticationEnvironmentValue(environment, name, platform = process.platform) {
	if (!environment || typeof environment !== "object") return undefined;
	if (platform !== "win32") return environment[name];
	const canonical = name.toLowerCase();
	const key = Object.keys(environment).findLast((entry) => entry.toLowerCase() === canonical);
	return key === undefined ? undefined : environment[key];
}
