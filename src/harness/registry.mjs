// The single place cc resolves a harness key to an adapter. Adding a harness is a
// one-line edit here (plus its adapter file). Harnesses that need no niceties —
// terminus-2, mini-swe-agent — map straight to BaseAcpAdapter with zero custom code.

import { BaseAcpAdapter } from "./acp-base.mjs";
import { ClaudeAdapter } from "./adapters/claude.mjs";
import { CodexAdapter } from "./adapters/codex.mjs";
import { CursorAdapter } from "./adapters/cursor.mjs";

/** key -> adapter class. Anything absent falls back to BaseAcpAdapter. */
export const ADAPTER_REGISTRY = {
	claude: ClaudeAdapter,
	codex: CodexAdapter,
	cursor: CursorAdapter,
	"terminus-2": BaseAcpAdapter, // pure generic-ACP — no custom adapter needed
	"mini-swe-agent": BaseAcpAdapter, // pure generic-ACP — no custom adapter needed
};

/** Register (or override) an adapter at runtime — used to prove addability. */
export function registerAdapter(key, adapterClass) {
	ADAPTER_REGISTRY[key] = adapterClass;
}

export function adapterClassFor(key) {
	return ADAPTER_REGISTRY[key] ?? BaseAcpAdapter;
}

/**
 * Construct the adapter for a harness. cc calls this and then uses only the
 * HarnessAdapter interface + adapter.capabilities — it never names a harness.
 *
 * @param {string} key
 * @param {object} [agentConfig]  registry entry; falls back to the adapter's
 *                                static defaultAgentConfig when omitted.
 * @param {object} host           { onEvent, requestPermission, requestInteraction }
 * @param {object} [options]      { settings, connectionFactory }
 */
export function createAdapter(key, agentConfig, host, options = {}) {
	const AdapterClass = adapterClassFor(key);
	const config = agentConfig ?? AdapterClass.defaultAgentConfig;
	if (!config) throw new Error(`no agent config for harness "${key}" (and no defaultAgentConfig)`);
	return new AdapterClass(key, config, host, options);
}
