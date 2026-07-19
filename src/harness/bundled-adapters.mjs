// Authoritative runtime contract for ACP adapters shipped with cc. Keep these
// values independent of the TUI and adapter classes so startup, per-harness
// adapters, command hints, and postinstall verification share one definition.

export const BUNDLED_ACP_ADAPTERS = Object.freeze({
	claude: Object.freeze({
		bin: "claude-agent-acp",
		packageName: "@agentclientprotocol/claude-agent-acp",
		version: "0.59.0",
		minimumVersion: "0.59.0",
	}),
	codex: Object.freeze({
		bin: "codex-acp",
		packageName: "@agentclientprotocol/codex-acp",
		version: "1.1.4",
		minimumVersion: "1.1.4",
	}),
	pi: Object.freeze({
		bin: "pi-acp",
		packageName: "pi-acp",
		version: "0.0.31",
		minimumVersion: "0.0.31",
	}),
});

export function adapterVersionAtLeast(actual, minimum) {
	const parse = (value) => {
		const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/u);
		return match
			? { parts: match.slice(1, 4).map(Number), prerelease: match[4] }
			: undefined;
	};
	const current = parse(actual);
	const required = parse(minimum);
	if (!current || !required) return false;
	for (let index = 0; index < 3; index += 1) {
		if (current.parts[index] !== required.parts[index]) return current.parts[index] > required.parts[index];
	}
	if (required.prerelease) return true;
	return !current.prerelease;
}
