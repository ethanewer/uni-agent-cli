// Authoritative runtime contract for ACP adapters shipped with cc. Keep these
// values independent of the TUI and adapter classes so startup, per-harness
// adapters, command hints, and postinstall verification share one definition.

export const BUNDLED_ACP_ADAPTERS = Object.freeze({
	claude: Object.freeze({
		bin: "claude-agent-acp",
		packageName: "@agentclientprotocol/claude-agent-acp",
		version: "0.58.1",
		minimumVersion: "0.58.1",
	}),
	codex: Object.freeze({
		bin: "codex-acp",
		packageName: "@agentclientprotocol/codex-acp",
		version: "1.1.2",
		minimumVersion: "1.1.2",
	}),
});
