import assert from "node:assert/strict";

import {
	codexMemoryConfigBatchParams,
	codexMemorySettingsFromConfigRead,
	codexThreadMemoryModeParams,
	codexMemoryWriteStatus,
	parseCodexMemoryCommand,
} from "../src/harness/codex-memory.mjs";

assert.deepEqual(parseCodexMemoryCommand(), { action: "menu" });
assert.deepEqual(parseCodexMemoryCommand("status"), { action: "status" });
assert.deepEqual(parseCodexMemoryCommand("show"), { action: "status" });
assert.deepEqual(parseCodexMemoryCommand("reset"), { action: "reset" });
assert.deepEqual(parseCodexMemoryCommand("enable"), { action: "settings", enableFeature: true });
assert.deepEqual(parseCodexMemoryCommand("on"), {
	action: "settings",
	enableFeature: true,
	useMemories: true,
	generateMemories: true,
});
assert.deepEqual(parseCodexMemoryCommand("off"), {
	action: "settings",
	enableFeature: undefined,
	useMemories: false,
	generateMemories: false,
});
assert.deepEqual(parseCodexMemoryCommand("use off"), {
	action: "settings",
	enableFeature: undefined,
	useMemories: false,
});
assert.deepEqual(parseCodexMemoryCommand("generate enabled"), {
	action: "settings",
	enableFeature: true,
	generateMemories: true,
});
for (const invalid of ["unknown", "use", "use maybe", "reset now", "a\0b", null]) {
	assert.throws(() => parseCodexMemoryCommand(invalid), /usage|text without NUL/);
}

assert.deepEqual(codexMemorySettingsFromConfigRead({
	config: {
		features: { memories: true },
		memories: { use_memories: true, generate_memories: false },
	},
}), { featureEnabled: true, useMemories: true, generateMemories: false });
assert.deepEqual(codexMemorySettingsFromConfigRead({ config: { features: { memories: false }, memories: null } }), {
	featureEnabled: false,
	useMemories: false,
	generateMemories: false,
});
assert.throws(() => codexMemorySettingsFromConfigRead({}), /invalid response/);
assert.deepEqual(codexMemorySettingsFromConfigRead({ config: { features: {}, memories: {} } }, {
	featureEnabled: true,
	useMemories: true,
	generateMemories: true,
}), { featureEnabled: true, useMemories: true, generateMemories: true });
assert.deepEqual(codexMemoryWriteStatus({ status: "ok" }), { status: "ok", overridden: false, message: undefined });
assert.deepEqual(codexMemoryWriteStatus({
	status: "okOverridden",
	overriddenMetadata: { message: "managed policy" },
}), { status: "okOverridden", overridden: true, message: "managed policy" });
assert.throws(() => codexMemoryWriteStatus({ status: "unknown" }), /invalid response/);

assert.deepEqual(codexMemoryConfigBatchParams(
	{ featureEnabled: false, useMemories: false, generateMemories: false },
	{ enableFeature: true, useMemories: true, generateMemories: true },
), {
	edits: [
		{ keyPath: "features.memories", value: true, mergeStrategy: "replace" },
		{ keyPath: "memories.use_memories", value: true, mergeStrategy: "replace" },
		{ keyPath: "memories.generate_memories", value: true, mergeStrategy: "replace" },
	],
	reloadUserConfig: true,
});
assert.deepEqual(codexMemoryConfigBatchParams(
	{ featureEnabled: true, useMemories: true, generateMemories: false },
	{ useMemories: true, generateMemories: false },
), { edits: [], reloadUserConfig: true });

const threadId = "019abcde-1234-7abc-8def-0123456789ab";
assert.deepEqual(codexThreadMemoryModeParams(threadId.toUpperCase(), true), { threadId, mode: "enabled" });
assert.deepEqual(codexThreadMemoryModeParams(threadId, false), { threadId, mode: "disabled" });
assert.throws(() => codexThreadMemoryModeParams("bad", true), /canonical UUID/);
assert.throws(() => codexThreadMemoryModeParams(threadId, "yes"), /must be a boolean/);

console.log("codex memories: parsing, config edits, and thread modes");
