// Pi adapter — the pinned pi-acp bridge provides ACP chat/session transport.
// Rollback uses Pi's public session tree API to persist a source-preserving
// branch through the selected user entry before atomically loading it over ACP.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseAcpAdapter } from "../acp-base.mjs";
import { mergeEnvironments } from "../acp-runtime.mjs";
import { adapterVersionAtLeast, BUNDLED_ACP_ADAPTERS } from "../bundled-adapters.mjs";
import {
	assertCheckpointModeSupported,
	normalizeCheckpointRewindResponse,
} from "../checkpoints.mjs";
import {
	createPiCheckpointBranch,
	openPiSession,
	piCheckpointsFromSessionManager,
	registerPiAcpSession,
	removeUnusedPiBranch,
	unregisterPiAcpSession,
} from "../pi-checkpoints.mjs";

const PI_PACKAGE_BIN = dependencyBinDirectory();

export class PiAdapter extends BaseAcpAdapter {
	static defaultAgentConfig = {
		label: "Pi",
		transport: "acp",
		command: "pi",
		args: [],
		_requiredAgentName: BUNDLED_ACP_ADAPTERS.pi.packageName,
		_minimumAgentVersion: BUNDLED_ACP_ADAPTERS.pi.minimumVersion,
		_packageLocalAcpCommand: BUNDLED_ACP_ADAPTERS.pi.bin,
		_packageLocalAcpVersion: BUNDLED_ACP_ADAPTERS.pi.version,
		acp: { command: BUNDLED_ACP_ADAPTERS.pi.bin, args: [] },
	};

	declaredCapabilities() {
		return { checkpoints: true, checkpointModes: ["conversation"] };
	}

	refineCapabilities(capabilities) {
		if (!this.connection) return capabilities;
		const compatible =
			this.connection.agentInfo?.name === "pi-acp" &&
			adapterVersionAtLeast(this.connection.agentInfo?.version, BUNDLED_ACP_ADAPTERS.pi.minimumVersion);
		capabilities.checkpoints = compatible;
		capabilities.checkpointModes = compatible ? ["conversation"] : [];
		return capabilities;
	}

	buildLaunchSpec(settings) {
		const launch = super.buildLaunchSpec(settings);
		if (PI_PACKAGE_BIN) {
			const command = launch.acp ?? launch;
			const currentPath = command.env?.PATH ?? launch.env?.PATH ?? process.env.PATH ?? "";
			command.env = { ...(command.env ?? {}), PATH: `${PI_PACKAGE_BIN}${path.delimiter}${currentPath}` };
		}
		return launch;
	}

	async openCheckpointSession(sessionId) {
		const service = this.services?.pi?.openSession ?? this.services?.openPiSession;
		return await (service ?? openPiSession)(sessionId, this.checkpointContext());
	}

	checkpointContext() {
		const command = this.launchSpec?.acp ?? this.launchSpec;
		return {
			cwd: this.connectOptions?.cwd ?? process.cwd(),
			env: mergeEnvironments([process.env, this.launchSpec?.env, command?.env]),
		};
	}

	async listCheckpoints(options = {}) {
		if (!this.capabilities.checkpoints || !this.sessionId) throw new Error("Pi checkpoint history is not available");
		const { manager } = await this.openCheckpointSession(this.sessionId);
		return piCheckpointsFromSessionManager(manager, options);
	}

	async rewindCheckpoint(checkpointId, mode, options = {}) {
		assertCheckpointModeSupported(this.capabilities, mode);
		const sourceSessionId = this.sessionId;
		if (!sourceSessionId) throw new Error("Pi session is not ready");
		const { manager } = await this.openCheckpointSession(sourceSessionId);
		const branch = createPiCheckpointBranch(manager, checkpointId);
		const context = this.checkpointContext();
		const register = this.services?.pi?.registerSession ?? registerPiAcpSession;
		const unregister = this.services?.pi?.unregisterSession ?? unregisterPiAcpSession;
		let registration;
		try {
			registration = await register(branch, context);
			await super.loadSession(branch.sessionId, options);
			return normalizeCheckpointRewindResponse({ ok: true, mode, sessionId: branch.sessionId });
		} catch (error) {
			if (this.sessionId === sourceSessionId) {
				if (registration) {
					try { await unregister(registration, context); }
					catch (cleanupError) { error.checkpointRegistrationCleanupError = cleanupError; }
				}
				try { removeUnusedPiBranch(branch); }
				catch (cleanupError) { error.checkpointForkCleanupError = cleanupError; }
			}
			throw error;
		}
	}
}

function dependencyBinDirectory() {
	try {
		let directory = path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
		while (!fs.existsSync(path.join(directory, "package.json"))) {
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
		while (path.basename(directory) !== "node_modules") {
			const parent = path.dirname(directory);
			if (parent === directory) return undefined;
			directory = parent;
		}
		const bin = path.join(directory, ".bin");
		return fs.existsSync(bin) ? bin : undefined;
	} catch {
		return undefined;
	}
}
