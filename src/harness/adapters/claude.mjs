// Claude adapter — folds native settings into the session `_meta`. Permissions
// (including the bypassPermissions startup mode + auto-accept) are handled
// generically by BaseAcpAdapter via the unified engine; this adapter only owns
// the claude-specific `_meta` translation. The pinned cc bridge declares only
// capabilities it can surface immediately; live wire negotiation remains
// authoritative after connect.

import { fileURLToPath } from "node:url";
import { BaseAcpAdapter } from "../acp-base.mjs";
import { BUNDLED_ACP_ADAPTERS } from "../bundled-adapters.mjs";
import { capabilitiesFromWire } from "../interface.mjs";
import { deepMerge, isPlainObject } from "../util.mjs";

export const CLAUDE_ACP_AGENT_NAME = BUNDLED_ACP_ADAPTERS.claude.packageName;
export const CLAUDE_ACP_MIN_VERSION = BUNDLED_ACP_ADAPTERS.claude.minimumVersion;

export class ClaudeAdapter extends BaseAcpAdapter {
	static defaultAgentConfig = {
		label: "Claude Code",
		transport: "acp",
		command: "claude",
		args: [],
		_requiredAgentName: CLAUDE_ACP_AGENT_NAME,
		_minimumAgentVersion: CLAUDE_ACP_MIN_VERSION,
		_packageLocalAcpCommand: BUNDLED_ACP_ADAPTERS.claude.bin,
		_packageLocalAcpBridge: fileURLToPath(new URL("../claude-acp-bridge.mjs", import.meta.url)),
		_packageLocalAcpVersion: BUNDLED_ACP_ADAPTERS.claude.version,
		acp: { command: BUNDLED_ACP_ADAPTERS.claude.bin, args: [] },
	};

	usesBuiltInBridge() {
		const command = this.launchSpec?.acp ?? this.launchSpec;
		return (
			command?.command === BUNDLED_ACP_ADAPTERS.claude.bin &&
			this.launchSpec?._packageLocalAcpCommand === BUNDLED_ACP_ADAPTERS.claude.bin &&
			this.launchSpec?._packageLocalAcpVersion === BUNDLED_ACP_ADAPTERS.claude.version &&
			typeof this.launchSpec?._packageLocalAcpBridge === "string"
		);
	}

	declaredCapabilities() {
		return this.usesBuiltInBridge()
			? {
				fork: "native",
				changeWorkingDirectory: true,
				backgroundTasks: true,
				checkpoints: true,
				checkpointModes: ["both", "conversation", "code"],
				remoteControl: true,
			}
			: {};
	}

	refineCapabilities(capabilities, sessionInfo = {}) {
		if (!this.connection) return capabilities;
		const wire = sessionInfo.capabilities ?? {};
		const negotiated = capabilitiesFromWire(sessionInfo);
		return {
			...capabilities,
			fork: wire.sessionCapabilities?.fork ? "native" : false,
			changeWorkingDirectory: wire._meta?.cc?.changeWorkingDirectory === true,
			backgroundTasks: wire._meta?.cc?.backgroundTasks === true,
			checkpoints: negotiated.checkpoints,
			checkpointModes: negotiated.checkpointModes,
			remoteControl: wire._meta?.cc?.remoteControl === true,
		};
	}

	// settings.settings -> agent._sessionMeta.claudeCode.options.settings (sent as
	// `_meta` on session/new + session/load).
	translateNativeSettings(agent, settings) {
		const options = agent._sessionMeta?.claudeCode?.options ?? {};
		const currentSettings = isPlainObject(options.settings) ? options.settings : {};
		agent._sessionMeta = deepMerge(agent._sessionMeta ?? {}, {
			claudeCode: { options: { settings: deepMerge(currentSettings, settings) } },
		});
	}
}
