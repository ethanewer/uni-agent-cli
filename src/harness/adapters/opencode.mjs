// OpenCode adapter — native ACP for chat plus the official local server API for
// transactional checkpoint branching and workspace reverts.
//
// Known gaps (not cc-side code, just capabilities it doesn't advertise as cc
// expects): reasoning effort + model/mode are exposed via opencode's
// `unstable_*`/configOptions path, which may or may not bind to cc's selectors;
// it does not advertise a shared agent terminal. Those simply stay dark.

import { BaseAcpAdapter } from "../acp-base.mjs";
import { mergeEnvironments } from "../acp-runtime.mjs";
import { adapterVersionAtLeast } from "../bundled-adapters.mjs";
import {
	assertCheckpointModeSupported,
	normalizeCheckpointRewindResponse,
} from "../checkpoints.mjs";
import {
	openCodeCheckpointsFromMessages,
	openCodeForkBoundary,
	openCodeForkCheckpointId,
	openCodeResponseData,
	openCodeRewindStats,
	openCodeServerInvocation,
	requireOpenCodeCheckpoint,
	withOpenCodeClient,
} from "../opencode-checkpoints.mjs";

const OPENCODE_VERSION = "1.18.3";

export class OpenCodeAdapter extends BaseAcpAdapter {
	static defaultAgentConfig = {
		label: "opencode (ACP)",
		transport: "acp",
		command: "opencode",
		args: [],
		_requiredAgentName: "OpenCode",
		_packageLocalAcpPackageName: "opencode-ai",
		_packageLocalAcpCommand: "opencode",
		_packageLocalAcpVersion: OPENCODE_VERSION,
		acp: { command: "opencode", args: ["acp"] },
	};

	declaredCapabilities() {
		return { checkpoints: true, checkpointModes: ["both", "conversation", "code"] };
	}

	refineCapabilities(capabilities) {
		if (!this.connection) return capabilities;
		const compatible =
			this.connection.agentInfo?.name === "OpenCode" &&
			adapterVersionAtLeast(this.connection.agentInfo?.version, OPENCODE_VERSION);
		const service = this.services?.openCode?.withClient ?? this.services?.withOpenCodeClient;
		const serverInvocation = openCodeServerInvocation(this.connection.launchInvocation);
		const checkpointReady = compatible && (typeof service === "function" || Boolean(serverInvocation));
		capabilities.checkpoints = checkpointReady;
		capabilities.checkpointModes = checkpointReady ? ["both", "conversation", "code"] : [];
		return capabilities;
	}

	checkpointDirectory() {
		return this.connectOptions?.cwd ?? process.cwd();
	}

	checkpointEnvironment() {
		const command = this.launchSpec?.acp ?? this.launchSpec;
		return mergeEnvironments([process.env, this.launchSpec?.env, command?.env]);
	}

	async withCheckpointClient(operation) {
		const service = this.services?.openCode?.withClient ?? this.services?.withOpenCodeClient;
		const invocation = openCodeServerInvocation(this.connection?.launchInvocation);
		if (typeof service !== "function" && !invocation) {
			throw new Error("the active OpenCode ACP launch cannot be transformed into a server launch for rollback");
		}
		return await (service ?? withOpenCodeClient)(this.checkpointDirectory(), operation, {
			env: this.checkpointEnvironment(),
			...(invocation
				? { cliCommand: invocation.command, cliPrefixArgs: invocation.prefixArgs }
				: {}),
		});
	}

	async listCheckpoints(options = {}) {
		if (!this.capabilities.checkpoints || !this.sessionId) throw new Error("OpenCode checkpoint history is not available");
		return await this.withCheckpointClient(async (client) => {
			const messages = openCodeResponseData(await client.session.messages({
				sessionID: this.sessionId,
				directory: this.checkpointDirectory(),
				limit: options.limit,
			}), "message listing");
			return openCodeCheckpointsFromMessages(messages, options);
		});
	}

	async rewindCheckpoint(checkpointId, mode, options = {}) {
		assertCheckpointModeSupported(this.capabilities, mode);
		const sourceSessionId = this.sessionId;
		if (!sourceSessionId) throw new Error("OpenCode session is not ready");
		let childSessionId;
		let fileRollbackSessionId;
		let filesRewound = false;
		let stats = {};
		try {
			await this.withCheckpointClient(async (client) => {
				const messages = openCodeResponseData(await client.session.messages({
					sessionID: sourceSessionId,
					directory: this.checkpointDirectory(),
				}), "message listing");
				const messageID = requireOpenCodeCheckpoint(messages, checkpointId);
				if (mode !== "code") {
					const boundaryID = openCodeForkBoundary(messages, messageID);
					const child = openCodeResponseData(await client.session.fork({
						sessionID: sourceSessionId,
						directory: this.checkpointDirectory(),
						...(boundaryID ? { messageID: boundaryID } : {}),
					}), "session fork");
					childSessionId = child?.id;
					if (typeof childSessionId !== "string" || !childSessionId || childSessionId === sourceSessionId) {
						throw new Error("OpenCode did not create a distinct checkpoint branch");
					}
				}
				if (mode !== "conversation") {
					const fileBranch = openCodeResponseData(await client.session.fork({
						sessionID: sourceSessionId,
						directory: this.checkpointDirectory(),
					}), "file rollback branch creation");
					fileRollbackSessionId = fileBranch?.id;
					if (
						typeof fileRollbackSessionId !== "string" ||
						!fileRollbackSessionId ||
						fileRollbackSessionId === sourceSessionId ||
						fileRollbackSessionId === childSessionId
					) throw new Error("OpenCode did not create a distinct file rollback branch");
					const fileMessages = openCodeResponseData(await client.session.messages({
						sessionID: fileRollbackSessionId,
						directory: this.checkpointDirectory(),
					}), "file rollback message listing");
					const fileMessageID = openCodeForkCheckpointId(messages, fileMessages, messageID);
					const reverted = openCodeResponseData(await client.session.revert({
						sessionID: fileRollbackSessionId,
						directory: this.checkpointDirectory(),
						messageID: fileMessageID,
					}), "file revert");
					filesRewound = true;
					stats = openCodeRewindStats(reverted);
				}
			});
			if (mode !== "code") await super.loadSession(childSessionId, options);
			if (fileRollbackSessionId) {
				try {
					await this.withCheckpointClient(async (client) => {
						openCodeResponseData(await client.session.delete({
							sessionID: fileRollbackSessionId,
							directory: this.checkpointDirectory(),
						}), "file rollback branch cleanup");
					});
					fileRollbackSessionId = undefined;
				} catch {
					// The rollback is already committed. Retaining a disposable session is
					// safer than undoing the requested workspace change after the switch.
				}
			}
			return normalizeCheckpointRewindResponse({
				ok: true,
				mode,
				...(childSessionId ? { sessionId: childSessionId } : {}),
				...stats,
			});
		} catch (error) {
			const committed = childSessionId && this.sessionId === childSessionId;
			if (committed && fileRollbackSessionId) {
				try {
					await this.withCheckpointClient(async (client) => {
						openCodeResponseData(await client.session.delete({
							sessionID: fileRollbackSessionId,
							directory: this.checkpointDirectory(),
						}), "file rollback branch cleanup");
					});
				} catch (cleanupError) { error.checkpointForkCleanupError = cleanupError; }
			} else if (!committed && (childSessionId || fileRollbackSessionId || filesRewound)) {
				try {
					await this.withCheckpointClient(async (client) => {
						if (filesRewound && fileRollbackSessionId) {
							openCodeResponseData(await client.session.unrevert({
								sessionID: fileRollbackSessionId,
								directory: this.checkpointDirectory(),
							}), "file rewind compensation");
						}
						if (fileRollbackSessionId) {
							openCodeResponseData(await client.session.delete({
								sessionID: fileRollbackSessionId,
								directory: this.checkpointDirectory(),
							}), "file rollback branch cleanup");
						}
						if (childSessionId) {
							openCodeResponseData(await client.session.delete({
								sessionID: childSessionId,
								directory: this.checkpointDirectory(),
							}), "unused branch cleanup");
						}
					});
				} catch (cleanupError) {
					error.checkpointForkCleanupError = cleanupError;
					if (filesRewound) error.checkpointRewind = normalizeCheckpointRewindResponse({ ok: true, mode: "code", ...stats });
				}
			}
			throw error;
		}
	}
}
