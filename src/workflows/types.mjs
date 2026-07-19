// cc Dynamic Workflows runtime contract. The hook/event vocabulary is adapted
// from imsai-sh/open-dynamic-workflows (MIT); cc-specific routing and safety
// fields are intentionally kept here rather than in the harness/TUI layers.

export const WORKFLOW_LIMITS = Object.freeze({
	maxSourceBytes: 256 * 1024,
	maxArgsBytes: 64 * 1024,
	maxRpcBytes: 1024 * 1024,
	maxResultBytes: 512 * 1024,
	maxEventText: 64 * 1024,
	maxTraceBytes: 1024 * 1024,
	maxAgents: 1000,
	maxAttemptsPerAgent: 20,
	maxDepth: 4,
	maxSandboxes: 64,
	maxLiveSandboxes: 8,
	maxSandboxRequests: 10_000,
	maxPendingSandboxRequests: 2048,
	maxBrokerSockets: 32,
	maxBrokerRequests: 64,
	maxBrokerRequestsPerSocket: 16,
	globalConcurrency: 16,
	defaultRunConcurrency: 8,
	maxRunConcurrency: 16,
	maxPending: 2048,
	maxStartsPerMinute: 60,
	maxLiveRuns: 128,
	maxHistoryRuns: 100,
	// Archived runs with unapplied managed worktrees remain actionable and are
	// indexed separately from ordinary bounded history. Hitting this cap leaves
	// the next run live/recoverable instead of silently hiding it.
	// Live and actionable history share this recovery capacity. It includes the
	// ordinary 100 retained-worktree allowance plus a full 128-run live crash,
	// so archiving a valid crash cohort can never overflow solely by state shift.
	maxActionableHistoryRuns: 228,
	sandboxHeapMb: 128,
	sandboxRssMb: 256,
	defaultAgentTimeoutMs: 30 * 60 * 1000,
	maxAgentTimeoutMs: 2 * 60 * 60 * 1000,
	defaultScriptTimeoutMs: 2 * 60 * 60 * 1000,
	maxScriptTimeoutMs: 24 * 60 * 60 * 1000,
	heartbeatTimeoutMs: 5000,
	maxProjectedEvents: 10_000,
	maxRetainedTools: 100,
	maxHostEventBytes: 8 * 1024 * 1024,
	maxJournalBytes: 32 * 1024 * 1024,
	maxJournalMetaBytes: 64 * 1024 * 1024,
	maxRememberedApprovals: 1000,
	maxApprovalFileBytes: 128 * 1024,
	gitTimeoutMs: 2 * 60 * 1000,
	// Fresh workflow sessions can still contain backend-owned system/tool text
	// that cc cannot observe. Unknown-usage accounting charges this allowance on
	// every request in addition to a one-token-per-UTF-8-byte upper bound for all
	// visible request text and serialized response events.
	unknownUsageOverheadPerRequest: 64 * 1024,
});

export const RUN_STATES = Object.freeze([
	"pending", "running", "paused", "stopping", "stopped", "completed", "failed", "interrupted",
]);

export const AGENT_STATES = Object.freeze([
	"queued", "running", "restarting", "stopping", "stopped", "completed", "failed", "cached",
]);

export const WORKFLOW_MODES = Object.freeze(["disabled", "clone-only", "flexible"]);

export function normalizeWorkflowMode(value) {
	return WORKFLOW_MODES.includes(value) ? value : "disabled";
}

function jsonBytes(value, label, maximum) {
	let serialized;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new Error(`${label} must be JSON-serializable: ${error.message ?? error}`);
	}
	if (serialized === undefined) throw new Error(`${label} must be JSON-serializable`);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes > maximum) throw new Error(`${label} exceeds ${maximum} bytes`);
	return { serialized, bytes };
}

export function normalizeWorkflowLaunch(input = {}, limits = WORKFLOW_LIMITS) {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Workflow input must be an object");
	const hasScript = typeof input.script === "string";
	const hasName = typeof input.name === "string" && input.name.trim();
	if (Number(hasScript) + Number(Boolean(hasName)) !== 1) throw new Error("Workflow requires exactly one of script or name");
	if (hasScript && Buffer.byteLength(input.script, "utf8") > limits.maxSourceBytes) {
		throw new Error(`Workflow source exceeds ${limits.maxSourceBytes} bytes`);
	}
	jsonBytes(input.args ?? null, "Workflow args", limits.maxArgsBytes);
	const tokenBudget = normalizeTokenBudget(input.tokenBudget);
	const requestedConcurrency = normalizeConcurrency(input.maxConcurrency, limits);
	return Object.freeze({
		...(hasScript ? { script: input.script } : { name: input.name.trim() }),
		args: input.args ?? null,
		tokenBudget,
		maxConcurrency: requestedConcurrency,
	});
}

export function normalizeTokenBudget(value) {
	if (value === undefined || value === null) return null;
	if (!Number.isSafeInteger(value) || value < 1000 || value > 1_000_000_000) {
		throw new Error("tokenBudget must be null or a safe integer from 1000 to 1000000000");
	}
	return value;
}

export function normalizeConcurrency(value, limits = WORKFLOW_LIMITS) {
	if (value === undefined) return limits.defaultRunConcurrency;
	if (!Number.isSafeInteger(value) || value < 1 || value > limits.maxRunConcurrency) {
		throw new Error(`maxConcurrency must be a safe integer from 1 to ${limits.maxRunConcurrency}`);
	}
	return value;
}

export function boundedWorkflowText(value, maximum = WORKFLOW_LIMITS.maxEventText) {
	const text = String(value ?? "");
	if (Buffer.byteLength(text, "utf8") <= maximum) return text;
	let bytes = 0;
	let result = "";
	for (const char of text) {
		const size = Buffer.byteLength(char, "utf8");
		if (bytes + size > maximum - 24) break;
		bytes += size;
		result += char;
	}
	return `${result}\n[… truncated …]`;
}

export function normalizeAgentOptions(value = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("agent options must be an object");
	const string = (name, maximum = 256) => {
		if (value[name] === undefined) return undefined;
		if (typeof value[name] !== "string" || !value[name].trim()) throw new Error(`agent.${name} must be a non-empty string`);
		const normalized = value[name].trim();
		if ([...normalized].length > maximum) throw new Error(`agent.${name} exceeds ${maximum} characters`);
		return normalized;
	};
	const isolation = value.isolation ?? "shared";
	if (!["shared", "worktree"].includes(isolation)) throw new Error('agent.isolation must be "shared" or "worktree"');
	const cache = value.cache ?? "never";
	if (cache !== "never") throw new Error('agent.cache currently supports only "never"; recovery reruns calls after explicit approval');
	if (value.readOnly !== undefined && typeof value.readOnly !== "boolean") throw new Error("agent.readOnly must be boolean");
	if (value.schema !== undefined) jsonBytes(value.schema, "agent.schema", 64 * 1024);
	return Object.freeze({
		...(string("harness", 128) ? { harness: string("harness", 128) } : {}),
		...(string("model", 256) ? { model: string("model", 256) } : {}),
		...(string("effort", 128) ? { effort: string("effort", 128) } : {}),
		...(string("label", 256) ? { label: string("label", 256) } : {}),
		...(string("phase", 256) ? { phase: string("phase", 256) } : {}),
		...(string("agentType", 256) ? { agentType: string("agentType", 256) } : {}),
		...(value.schema !== undefined ? { schema: value.schema } : {}),
		isolation,
		readOnly: value.readOnly === true,
		cache,
	});
}

export function safeJson(value, label = "value", maximum = WORKFLOW_LIMITS.maxRpcBytes) {
	return jsonBytes(value, label, maximum).serialized;
}
