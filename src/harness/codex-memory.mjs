const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function memoryError(message, code = "CODEX_INVALID_MEMORY_COMMAND") {
	const error = new Error(message);
	error.code = code;
	return error;
}

function booleanWord(value) {
	if (["on", "true", "yes", "enable", "enabled"].includes(value)) return true;
	if (["off", "false", "no", "disable", "disabled"].includes(value)) return false;
	return undefined;
}

export function parseCodexMemoryCommand(argument = "") {
	if (typeof argument !== "string" || argument.includes("\0")) {
		throw memoryError("Memory arguments must be text without NUL bytes");
	}
	const tokens = argument.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { action: "menu" };
	if (tokens.length === 1) {
		if (["status", "show"].includes(tokens[0])) return { action: "status" };
		if (tokens[0] === "reset") return { action: "reset" };
		if (tokens[0] === "enable") return { action: "settings", enableFeature: true };
		const both = booleanWord(tokens[0]);
		if (both !== undefined) {
			return {
				action: "settings",
				enableFeature: both ? true : undefined,
				useMemories: both,
				generateMemories: both,
			};
		}
	}
	if (tokens.length === 2 && ["use", "generate"].includes(tokens[0])) {
		const enabled = booleanWord(tokens[1]);
		if (enabled !== undefined) {
			return {
				action: "settings",
				enableFeature: enabled ? true : undefined,
				...(tokens[0] === "use" ? { useMemories: enabled } : { generateMemories: enabled }),
			};
		}
	}
	throw memoryError("usage: /memories [status|enable|on|off|use on|off|generate on|off|reset]");
}

export function codexMemorySettingsFromConfigRead(response, fallback = {}) {
	if (!response || typeof response !== "object" || !response.config || typeof response.config !== "object") {
		throw memoryError("Codex config/read returned an invalid response", "CODEX_INVALID_MEMORY_CONFIG");
	}
	const features = response.config.features;
	const memories = response.config.memories;
	return {
		featureEnabled: typeof features?.memories === "boolean" ? features.memories : Boolean(fallback.featureEnabled),
		useMemories: typeof memories?.use_memories === "boolean" ? memories.use_memories : Boolean(fallback.useMemories),
		generateMemories: typeof memories?.generate_memories === "boolean" ? memories.generate_memories : Boolean(fallback.generateMemories),
	};
}

export function codexMemoryWriteStatus(response) {
	if (!response || typeof response !== "object" || !["ok", "okOverridden"].includes(response.status)) {
		throw memoryError("Codex config/batchWrite returned an invalid response", "CODEX_INVALID_MEMORY_WRITE");
	}
	return {
		status: response.status,
		overridden: response.status === "okOverridden",
		message: typeof response.overriddenMetadata?.message === "string"
			? response.overriddenMetadata.message
			: undefined,
	};
}

export function codexMemoryConfigBatchParams(current, update = {}) {
	if (!current || typeof current !== "object") {
		throw memoryError("Current memory settings are required", "CODEX_INVALID_MEMORY_CONFIG");
	}
	const edits = [];
	const replace = (keyPath, value) => edits.push({ keyPath, value, mergeStrategy: "replace" });
	if (update.enableFeature === true && current.featureEnabled !== true) replace("features.memories", true);
	if (typeof update.useMemories === "boolean" && update.useMemories !== current.useMemories) {
		replace("memories.use_memories", update.useMemories);
	}
	if (typeof update.generateMemories === "boolean" && update.generateMemories !== current.generateMemories) {
		replace("memories.generate_memories", update.generateMemories);
	}
	return { edits, reloadUserConfig: true };
}

export function codexThreadMemoryModeParams(threadId, generateMemories) {
	if (typeof threadId !== "string" || !UUID_PATTERN.test(threadId)) {
		throw memoryError("Codex thread ID must be a canonical UUID", "CODEX_INVALID_THREAD_ID");
	}
	if (typeof generateMemories !== "boolean") {
		throw memoryError("Memory generation state must be a boolean", "CODEX_INVALID_MEMORY_MODE");
	}
	return {
		threadId: threadId.toLowerCase(),
		mode: generateMemories ? "enabled" : "disabled",
	};
}
