#!/usr/bin/env node
// Claude's maintained ACP adapter intentionally exposes the portable Agent SDK
// surface. cc adds a few narrowly-scoped controls that are real Agent SDK
// operations but are not part of ACP v1: live cwd/context changes, branch names,
// and bounded background-task lifecycle/control. Keeping them in this
// per-harness bridge means the shared TUI sees only negotiated generic
// capabilities rather than Claude-specific messages.

import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agent as acpAgent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import {
	deleteSession,
	forkSession,
	getSessionMessages,
	renameSession,
	resolveSettings,
} from "@anthropic-ai/claude-agent-sdk";
import adapterPackage from "@agentclientprotocol/claude-agent-acp/package.json" with { type: "json" };
import {
	applyAvailableModelsAllowlist,
	BUILTIN_AGENT_NAMES,
	ClaudeAcpAgent,
	claudeCliPath,
	DEFAULT_AGENT_ID,
	fastModeStateEnabled,
	MODEL_CONFIG_ID,
	resolveModelPreference,
	runPromptWithCancellation,
} from "@agentclientprotocol/claude-agent-acp/dist/acp-agent.js";
import {
	nodeToWebReadable,
	nodeToWebWritable,
} from "@agentclientprotocol/claude-agent-acp/dist/utils.js";

import {
	CHANGE_WORKING_DIRECTORY_META_KEY,
	CHANGE_WORKING_DIRECTORY_METHOD,
	normalizeChangeWorkingDirectoryResponse,
	parseChangeWorkingDirectoryParams,
} from "./working-directory.mjs";
import {
	APPEND_CONTEXT_META_KEY,
	APPEND_CONTEXT_METHOD,
	claudeContextMessage,
	normalizeAppendContextResponse,
	parseAppendContextParams,
} from "./append-context.mjs";
import {
	BACKGROUND_TASKS_BACKGROUND_METHOD,
	BACKGROUND_TASKS_CHANGED_NOTIFICATION,
	BACKGROUND_TASKS_LIST_METHOD,
	BACKGROUND_TASKS_META_KEY,
	BACKGROUND_TASKS_STOP_METHOD,
	parseBackgroundTaskListParams,
	parseBackgroundTasksBackgroundParams,
	parseBackgroundTaskStopParams,
} from "./background-tasks.mjs";
import {
	CLAUDE_RAW_SDK_MESSAGE_NOTIFICATION,
	ClaudeBackgroundTaskBridge,
} from "./claude-background-tasks.mjs";
import {
	CHECKPOINTS_LIST_METHOD,
	CHECKPOINTS_META_KEY,
	CHECKPOINT_REWIND_METHOD,
	checkpointsFromSessionMessages,
	normalizeCheckpointRewindResponse,
	parseCheckpointListParams,
	parseCheckpointRewindParams,
} from "./checkpoints.mjs";
import {
	REMOTE_CONTROL_META_KEY,
	REMOTE_CONTROL_METHOD,
	normalizeClaudeRemoteControlResponse,
	parseRemoteControlParams,
} from "./remote-control.mjs";

async function main() {
	if (process.argv.includes("--cli")) return await runCli();
	if (process.argv.includes("--version") || process.argv.includes("-v")) {
		console.log(adapterPackage.version);
		return;
	}
	return await runBridge();
}

async function runCli() {
	const child = spawn(
		await claudeCliPath(),
		process.argv.slice(2).filter((argument) => argument !== "--cli"),
		{ stdio: "inherit" },
	);
	const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) {
		process.on(signal, () => {
			if (!child.killed) child.kill(signal);
		});
	}
	child.once("error", (error) => {
		console.error(error);
		process.exit(1);
	});
	child.once("exit", (code, signal) => {
		if (signal && process.platform !== "win32") {
			process.removeAllListeners(signal);
			process.kill(process.pid, signal);
			return;
		}
		process.exit(code ?? 1);
	});
}

async function runBridge() {
	const policy = await resolveSettings({ settingSources: [] });
	for (const [name, value] of Object.entries(policy.effective.env ?? {})) process.env[name] = value;

	// stdout is the ACP wire. All diagnostics must stay on stderr.
	console.log = console.error;
	console.info = console.error;
	console.warn = console.error;
	console.debug = console.error;
	process.on("unhandledRejection", (reason, promise) => {
		console.error("Unhandled rejection:", promise, reason);
	});

	const input = nodeToWebWritable(process.stdout);
	const output = nodeToWebReadable(process.stdin);
	const stream = ndJsonStream(input, output);
	const backgroundTaskBridge = new ClaudeBackgroundTaskBridge();
	let agent;
	const connection = acpAgent({ name: "claude-code-acp" })
		.onRequest(methods.agent.initialize, async (context) => {
			const response = await agent.initialize(context.params);
			return {
				...response,
				agentCapabilities: {
					...(response.agentCapabilities ?? {}),
					_meta: {
						...(response.agentCapabilities?._meta ?? {}),
						cc: {
							...(response.agentCapabilities?._meta?.cc ?? {}),
							[CHANGE_WORKING_DIRECTORY_META_KEY]: true,
							[APPEND_CONTEXT_META_KEY]: true,
							[BACKGROUND_TASKS_META_KEY]: true,
							[CHECKPOINTS_META_KEY]: true,
							[REMOTE_CONTROL_META_KEY]: true,
							namedFork: true,
						},
					},
				},
			};
		})
		.onRequest(methods.agent.session.new, async (context) => {
			const prepared = prepareClaudeSessionRequest(backgroundTaskBridge, context.params);
			const response = await agent.newSession(prepared.params);
			backgroundTaskBridge.registerSession(response.sessionId, prepared.forwardRawSdkMessages);
			return response;
		})
		.onRequest(methods.agent.session.load, async (context) => {
			const previousQuery = agent.sessions?.[context.params.sessionId]?.query;
			const prepared = prepareClaudeSessionRequest(backgroundTaskBridge, context.params);
			const response = await agent.loadSession(prepared.params);
			const currentQuery = agent.sessions?.[context.params.sessionId]?.query;
			backgroundTaskBridge.registerSession(context.params.sessionId, prepared.forwardRawSdkMessages, {
				reset: Boolean(previousQuery && currentQuery && previousQuery !== currentQuery),
			});
			return response;
		})
		.onRequest(methods.agent.session.fork, async (context) => {
			const requestedName = parseBranchName(context.params?._meta?.cc?.branchName);
			const prepared = prepareClaudeSessionRequest(backgroundTaskBridge, context.params);
			const response = await agent.unstable_forkSession(prepared.params);
			backgroundTaskBridge.registerSession(response.sessionId, prepared.forwardRawSdkMessages);
			if (!requestedName) return response;
			let renameError;
			try {
				await renameSession(response.sessionId, requestedName);
			} catch (error) {
				renameError = String(error?.message ?? error).slice(0, 1_000);
			}
			return {
				...response,
				_meta: {
					...(response?._meta ?? {}),
					cc: {
						...(response?._meta?.cc ?? {}),
						branchName: requestedName,
						branchNameApplied: !renameError,
						...(renameError ? { branchNameError: renameError } : {}),
					},
				},
			};
		})
		.onRequest(methods.agent.session.list, (context) => agent.listSessions(context.params))
		.onRequest(methods.agent.session.delete, async (context) => {
			const response = await agent.deleteSession(context.params);
			backgroundTaskBridge.removeSession(context.params.sessionId);
			return response;
		})
		.onRequest(methods.agent.session.resume, async (context) => {
			const previousQuery = agent.sessions?.[context.params.sessionId]?.query;
			const prepared = prepareClaudeSessionRequest(backgroundTaskBridge, context.params);
			const response = await agent.resumeSession(prepared.params);
			const currentQuery = agent.sessions?.[context.params.sessionId]?.query;
			backgroundTaskBridge.registerSession(context.params.sessionId, prepared.forwardRawSdkMessages, {
				reset: Boolean(previousQuery && currentQuery && previousQuery !== currentQuery),
			});
			return response;
		})
		.onRequest(methods.agent.session.close, async (context) => {
			const response = await agent.closeSession(context.params);
			backgroundTaskBridge.removeSession(context.params.sessionId);
			return response;
		})
		.onRequest(methods.agent.session.setMode, (context) => agent.setSessionMode(context.params))
		.onRequest(methods.agent.session.setConfigOption, (context) => agent.setSessionConfigOption(context.params))
		.onRequest(methods.agent.authenticate, (context) => agent.authenticate(context.params))
		.onRequest(methods.agent.logout, (context) => agent.logout(context.params))
		.onRequest(methods.agent.session.prompt, (context) => runPromptWithCancellation(agent, context.params, context.signal))
		.onRequest(CHANGE_WORKING_DIRECTORY_METHOD, parseChangeWorkingDirectoryParams, async (context) =>
			await applyClaudeWorkingDirectory(agent, context.params))
		.onRequest(APPEND_CONTEXT_METHOD, parseAppendContextParams, async (context) => {
			return appendClaudeContext(agent, context.params);
		})
		.onRequest(BACKGROUND_TASKS_LIST_METHOD, parseBackgroundTaskListParams, async (context) => {
			requireLiveSession(agent, context.params.sessionId);
			return backgroundTaskBridge.list(context.params.sessionId, { limit: context.params.limit });
		})
		.onRequest(BACKGROUND_TASKS_STOP_METHOD, parseBackgroundTaskStopParams, async (context) => {
			const session = requireLiveSession(agent, context.params.sessionId);
			if (typeof session.query?.stopTask !== "function") {
				throw new Error("the installed Claude Agent SDK does not support stopping tasks");
			}
			await session.query.stopTask(context.params.taskId);
			return { ok: true };
		})
		.onRequest(BACKGROUND_TASKS_BACKGROUND_METHOD, parseBackgroundTasksBackgroundParams, async (context) => {
			const session = requireLiveSession(agent, context.params.sessionId);
			if (typeof session.query?.backgroundTasks !== "function") {
				throw new Error("the installed Claude Agent SDK does not support backgrounding tasks");
			}
			const backgrounded = await session.query.backgroundTasks(context.params.toolUseId);
			return { ok: true, backgrounded };
		})
		.onRequest(CHECKPOINTS_LIST_METHOD, parseCheckpointListParams, async (context) => {
			requireLiveSession(agent, context.params.sessionId);
			const messages = await getSessionMessages(context.params.sessionId);
			return checkpointsFromSessionMessages(messages, { limit: context.params.limit });
		})
		.onRequest(CHECKPOINT_REWIND_METHOD, parseCheckpointRewindParams, async (context) => {
			const session = requireLiveSession(agent, context.params.sessionId);
			return await performClaudeCheckpointRewind(context.params, session);
		})
		.onRequest(REMOTE_CONTROL_METHOD, parseRemoteControlParams, async (context) =>
			await performClaudeRemoteControl(agent, context.params))
		.onNotification(methods.agent.session.cancel, (context) => agent.cancel(context.params))
		.connect(stream);

	agent = new ClaudeAcpAgent(new ClientConnection(connection.client, backgroundTaskBridge));
	const shutdown = async () => {
		await agent.dispose().catch((error) => console.error("Claude ACP cleanup failed:", error));
		backgroundTaskBridge.clear();
		process.exit(0);
	};
	connection.closed.then(shutdown);
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	process.stdin.resume();
}

class ClientConnection {
	constructor(context, backgroundTaskBridge) {
		this.context = context;
		this.backgroundTaskBridge = backgroundTaskBridge;
	}

	sessionUpdate(params) {
		return this.context.notify(methods.client.session.update, params);
	}

	requestPermission(params, signal) {
		return this.context.request(methods.client.session.requestPermission, params, { cancellationSignal: signal });
	}

	readTextFile(params) {
		return this.context.request(methods.client.fs.readTextFile, params);
	}

	writeTextFile(params) {
		return this.context.request(methods.client.fs.writeTextFile, params);
	}

	unstable_createElicitation(params, signal) {
		return this.context.request(methods.client.elicitation.create, params, { cancellationSignal: signal });
	}

	unstable_completeElicitation(params) {
		return this.context.notify(methods.client.elicitation.complete, params);
	}

	async extNotification(method, params) {
		if (method === CLAUDE_RAW_SDK_MESSAGE_NOTIFICATION) {
			const result = this.backgroundTaskBridge.consumeRawNotification(params);
			if (result.changed) {
				await this.context.notify(BACKGROUND_TASKS_CHANGED_NOTIFICATION, result.notification);
			}
			if (!result.forwardRaw) return;
		}
		return await this.context.notify(method, params);
	}
}

function requireLiveSession(agent, sessionId) {
	const session = agent.sessions?.[sessionId];
	if (!session) throw new Error(`session not found: ${sessionId}`);
	if (session.queryClosed) throw new Error(`session has ended: ${sessionId}`);
	return session;
}

export function appendClaudeContext(agent, params) {
	const parsed = parseAppendContextParams(params);
	const session = requireLiveSession(agent, parsed.sessionId);
	if (typeof session.input?.push !== "function" || typeof agent.ensureConsumer !== "function") {
		throw new Error("the installed Claude adapter does not support context-only input");
	}
	// Query.streamInput consumes a finite iterable by calling endInput() when it
	// finishes. The adapter owns one long-lived Pushable for the session, so append
	// directly to it and ensure its existing consumer is draining the Query.
	session.input.push(claudeContextMessage(parsed.text, parsed.sessionId));
	agent.ensureConsumer(session, parsed.sessionId);
	return normalizeAppendContextResponse({ appended: true });
}

export async function applyClaudeWorkingDirectory(agent, params) {
	const parsed = parseChangeWorkingDirectoryParams(params);
	const session = requireLiveSession(agent, parsed.sessionId);
	if (typeof session.query?.setCwd !== "function") {
		throw new Error("the installed Claude Agent SDK does not support changing directories");
	}
	// Validate both halves before moving either one. Otherwise an unexpected
	// adapter/SDK mismatch could move Query.cwd and only then discover that cc
	// cannot move the project-settings watcher, leaving the session split across
	// two directories while the host still reports the old one.
	if (typeof session.settingsManager?.setCwd !== "function") {
		throw new Error("the installed Claude adapter cannot refresh settings after changing directories");
	}
	const previousCwd = session.cwd;
	const previousFingerprint = session.sessionFingerprint;
	if (typeof previousCwd !== "string" || !path.isAbsolute(previousCwd)) {
		throw new Error("the installed Claude adapter did not report the session's current directory");
	}
	const response = normalizeChangeWorkingDirectoryResponse(await session.query.setCwd(parsed.path, {
		...(parsed.trustAccepted !== undefined ? { trustAccepted: parsed.trustAccepted } : {}),
		...(parsed.trustedDirectory ? { trustedDirectory: parsed.trustedDirectory } : {}),
	}));
	if (response.status !== "ok") return response;

	// SettingsManager owns project/local settings watchers independently of the
	// SDK Query. Moving only Query.cwd leaves the adapter's models, agent picker,
	// effort and policy cache tied to the old project. If that second half fails,
	// compensate both movers before reporting failure so the host's unchanged cwd
	// cannot disagree with the live Query.
	try {
		await session.settingsManager.setCwd(response.cwd);
	} catch (error) {
		const rollbackErrors = [];
		try {
			const rollback = normalizeChangeWorkingDirectoryResponse(await session.query.setCwd(previousCwd, {
				trustAccepted: true,
				trustedDirectory: previousCwd,
			}));
			if (rollback.status !== "ok" || path.resolve(rollback.cwd) !== path.resolve(previousCwd)) {
				throw new Error("Claude Query rejected the previous working directory");
			}
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		try {
			await session.settingsManager.setCwd(previousCwd);
		} catch (rollbackError) {
			rollbackErrors.push(rollbackError);
		}
		if (rollbackErrors.length > 0) {
			await invalidateClaudeSessionAfterFailedCwdRollback(
				agent,
				parsed.sessionId,
				session,
				rollbackErrors,
			);
			throw new AggregateError(
				[error, ...rollbackErrors],
				"Claude changed directories, settings refresh failed, and the session could not be rolled back safely; reconnect the session",
			);
		}
		// Neither in-memory field is updated until both external movers are back in
		// the original directory. Keeping these assignments explicit makes that
		// commit point robust if the maintained adapter later mutates either field as
		// part of Query/SettingsManager.setCwd().
		session.cwd = previousCwd;
		session.sessionFingerprint = previousFingerprint;
		throw error;
	}

	session.cwd = response.cwd;
	// load/resume fingerprints include cwd. Keep the maintained adapter's
	// in-memory identity aligned so a later load does not tear down this Query.
	try {
		const fingerprint = JSON.parse(session.sessionFingerprint);
		session.sessionFingerprint = JSON.stringify({ ...fingerprint, cwd: response.cwd });
	} catch {}

	await refreshClaudeProjectState(agent, parsed.sessionId, session).catch((error) => {
		console.error("Failed to refresh Claude project state after changing directories:", error);
	});
	if (typeof agent.sendAvailableCommandsUpdate === "function") {
		await agent.sendAvailableCommandsUpdate(parsed.sessionId).catch((error) => {
			console.error("Failed to refresh Claude commands after changing directories:", error);
		});
	}
	return response;
}

async function invalidateClaudeSessionAfterFailedCwdRollback(agent, sessionId, session, errors) {
	try {
		if (typeof agent.closeSession === "function") {
			await agent.closeSession({ sessionId });
			return;
		}
	} catch (error) {
		errors.push(error);
	}
	// The pinned maintained adapter exposes closeQueryStream(), but retain a
	// defensive fallback for a partially upgraded bridge. Its helper sets the
	// dead marker before cleanup; our fallback does the same. Reassert it after a
	// throw so every subsequent operation still refuses the split session.
	if (typeof agent.closeQueryStream === "function") {
		try {
			agent.closeQueryStream(session);
			return;
		} catch (error) {
			errors.push(error);
		}
	}
	session.queryClosed = true;
	for (const cleanup of [
		() => session.settingsManager?.dispose?.(),
		() => session.input?.end?.(),
		() => session.query?.close?.(),
	]) {
		try { cleanup(); } catch (error) { errors.push(error); }
	}
}

async function refreshClaudeProjectState(agent, sessionId, session) {
	if (typeof session.query?.reinitialize !== "function") return;
	const initialized = await session.query.reinitialize();
	const sdkModels = Array.isArray(initialized?.models) ? initialized.models : [];
	if (sdkModels.length > 0) {
		const settings = session.settingsManager.getSettings?.() ?? {};
		const allowedModels = Array.isArray(settings.availableModels)
			? applyAvailableModelsAllowlist(sdkModels, settings.availableModels, settings.modelOverrides)
			: sdkModels;
		let currentModelId = session.models?.currentModelId ?? allowedModels[0]?.value ?? sdkModels[0]?.value;
		if (typeof session.query.getContextUsage === "function") {
			try {
				const liveModel = (await session.query.getContextUsage())?.model;
				if (typeof liveModel === "string" && liveModel) {
					currentModelId = resolveModelPreference(sdkModels, liveModel)?.value ?? liveModel;
				}
			} catch {}
		}
		const currentAllowed = allowedModels.find((model) => model.value === currentModelId);
		const fallback = currentAllowed ? undefined : resolveModelPreference(sdkModels, currentModelId);
		session.modelInfos = fallback
			? [...allowedModels, { ...fallback, value: currentModelId, displayName: currentModelId, description: "", resolvedModel: undefined }]
			: allowedModels;
		session.models = {
			availableModels: allowedModels.map((model) => ({
				modelId: model.value,
				name: model.displayName,
				description: model.description,
			})),
			currentModelId,
		};
	}

	if (Array.isArray(initialized?.agents)) {
		session.agents = initialized.agents.filter((entry) =>
			entry?.name && !BUILTIN_AGENT_NAMES.has(entry.name) && entry.name !== DEFAULT_AGENT_ID);
		if (session.currentAgent !== DEFAULT_AGENT_ID && !session.agents.some((entry) => entry.name === session.currentAgent)) {
			session.currentAgent = DEFAULT_AGENT_ID;
			await session.query.applyFlagSettings?.({ agent: null });
		}
	}
	if (initialized?.fast_mode_state !== undefined) {
		session.fastModeEnabled = fastModeStateEnabled(initialized.fast_mode_state);
	}
	if (session.models?.currentModelId && typeof agent.applyConfigOptionValue === "function") {
		await agent.applyConfigOptionValue(sessionId, session, MODEL_CONFIG_ID, session.models.currentModelId);
	}
	if (Array.isArray(session.configOptions) && typeof agent.client?.sessionUpdate === "function") {
		await agent.client.sessionUpdate({
			sessionId,
			update: { sessionUpdate: "config_option_update", configOptions: session.configOptions },
		});
	}
}

export async function performClaudeRemoteControl(agent, params) {
	const parsed = parseRemoteControlParams(params);
	const session = requireLiveSession(agent, parsed.sessionId);
	if (typeof session.query?.enableRemoteControl !== "function") {
		throw new Error("the installed Claude Agent SDK does not support Remote Control");
	}
	const result = await session.query.enableRemoteControl(parsed.enabled, parsed.name);
	return normalizeClaudeRemoteControlResponse(result, parsed.enabled);
}

/** Force checkpoint collection for every session owned by cc's built-in bridge. */
export function prepareClaudeSessionRequest(backgroundTaskBridge, params) {
	const prepared = backgroundTaskBridge.prepareSessionRequest(params);
	const meta = prepared.params?._meta ?? {};
	const claudeCode = meta.claudeCode ?? {};
	const options = isRecord(claudeCode.options) ? claudeCode.options : {};
	return {
		...prepared,
		params: {
			...prepared.params,
			_meta: {
				...meta,
				claudeCode: {
					...claudeCode,
					options: { ...options, enableFileCheckpointing: true },
				},
			},
		},
	};
}

export async function performClaudeCheckpointRewind(params, session, sdk = {}) {
	const { sessionId, checkpointId, mode } = parseCheckpointRewindParams(params);
	const readMessages = sdk.getSessionMessages ?? getSessionMessages;
	const createFork = sdk.forkSession ?? forkSession;
	const removeSession = sdk.deleteSession ?? deleteSession;
	await requireUserCheckpoint(sessionId, checkpointId, readMessages);

	if (mode === "code") {
		const rewind = await rewindFilesToCheckpoint(session, checkpointId);
		return normalizeCheckpointRewindResponse({ ok: true, mode, ...rewind });
	}

	// Validate the code half before creating a durable transcript fork. The
	// actual rewind happens only after the fork succeeds, and a failed rewind
	// removes that temporary fork best-effort.
	if (mode === "both") await rewindFilesToCheckpoint(session, checkpointId, { dryRun: true });
	const forked = await createFork(sessionId, { upToMessageId: checkpointId });
	if (!forked?.sessionId || forked.sessionId === sessionId) {
		throw new Error("Claude Agent SDK did not create a distinct checkpoint fork");
	}
	try {
		const rewind = mode === "both"
			? await rewindFilesToCheckpoint(session, checkpointId)
			: {};
		return normalizeCheckpointRewindResponse({
			ok: true,
			mode,
			sessionId: forked.sessionId,
			...rewind,
		});
	} catch (error) {
		const cleanupError = await deleteTemporaryCheckpointFork(forked.sessionId, removeSession);
		if (cleanupError) {
			throw new Error(
				`${error?.message ?? error}; temporary checkpoint fork ${forked.sessionId} could not be removed: ` +
				`${cleanupError?.message ?? cleanupError}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

async function requireUserCheckpoint(sessionId, checkpointId, readMessages = getSessionMessages) {
	// Omitting dir lets the SDK search its project index. This remains correct when
	// setCwd succeeded but transcript relocation was unavailable/failed.
	const messages = await readMessages(sessionId);
	const checkpoint = messages.some((message) =>
		message?.type === "user" &&
		message.parent_tool_use_id === null &&
		message.uuid === checkpointId,
	);
	if (!checkpoint) throw new Error("checkpoint is not a user message in this session");
}

async function rewindFilesToCheckpoint(session, checkpointId, options = {}) {
	if (typeof session.query?.rewindFiles !== "function") {
		throw new Error("the installed Claude Agent SDK does not support file checkpoints");
	}
	const result = await session.query.rewindFiles(checkpointId, options);
	if (!result?.canRewind) {
		throw new Error(result?.error || "Claude could not rewind files to this checkpoint");
	}
	return {
		...(Array.isArray(result.filesChanged) ? { filesChanged: result.filesChanged } : {}),
		...(Number.isSafeInteger(result.insertions) ? { insertions: result.insertions } : {}),
		...(Number.isSafeInteger(result.deletions) ? { deletions: result.deletions } : {}),
	};
}

async function deleteTemporaryCheckpointFork(sessionId, removeSession = deleteSession) {
	try {
		await removeSession(sessionId);
		return undefined;
	} catch (error) {
		return error;
	}
}

function parseBranchName(value) {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new Error("branch name must be text");
	const name = value.trim();
	if (!name || name.length > 1_000 || /[\u0000-\u001f\u007f]/u.test(name)) {
		throw new Error("branch name must be 1-1000 characters without control characters");
	}
	return name;
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
