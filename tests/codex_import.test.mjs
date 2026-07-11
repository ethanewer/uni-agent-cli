import assert from "node:assert/strict";

import {
	codexImportCompletionMatches,
	codexImportItemCount,
	codexImportItemLabel,
	formatCodexImportCompletion,
	normalizeCodexImportDetection,
} from "../src/harness/codex-import.mjs";

const [item] = normalizeCodexImportDetection({
	items: [{
		itemType: "SKILLS",
		description: "Import Claude skills",
		cwd: "/repo",
		details: {
			plugins: [],
			skills: [{ name: "review" }, { name: "ship" }],
			sessions: [],
			mcpServers: [],
			hooks: [],
			subagents: [],
			commands: [],
		},
	}],
});
assert.equal(codexImportItemCount(item), 2);
assert.equal(codexImportItemLabel(item), "skills · /repo · 2 items");
assert.equal(codexImportCompletionMatches({ importId: "abc" }, [{ importId: "abc" }]), true);
assert.equal(codexImportCompletionMatches({ importId: "other" }, [{ importId: "abc" }]), false);
assert.equal(formatCodexImportCompletion({
	importId: "abc",
	itemTypeResults: [{
		itemType: "SKILLS",
		successes: [{ itemType: "SKILLS", target: "review" }],
		failures: [{ itemType: "SKILLS", failureStage: "write", message: `api_key = \"${"s".repeat(5_000)}\"` }],
	}],
}), "Claude Code import finished: 1 succeeded, 1 failed.\n  - SKILLS: failed during write");
assert.doesNotMatch(formatCodexImportCompletion({
	itemTypeResults: [{ itemType: "CONFIG", successes: [], failures: [{ message: "token=secret" }] }],
}), /secret|token=/);
assert.match(formatCodexImportCompletion({ itemTypeResults: [{ broken: true }] }), /completed|finished/);

for (const invalid of [
	{},
	{ items: [{ itemType: "SECRET", description: "x", cwd: null, details: null }] },
	{ items: [{ itemType: "CONFIG", description: "x\0y", cwd: null, details: null }] },
	{ items: [{ itemType: "SKILLS", description: "x", cwd: null, details: { plugins: [], skills: null, sessions: [], mcpServers: [], hooks: [], subagents: [], commands: [] } }] },
]) {
	assert.throws(() => normalizeCodexImportDetection(invalid), /invalid|unknown/);
}

assert.deepEqual(normalizeCodexImportDetection({
	items: [{ itemType: "CONFIG", description: "home", cwd: "", details: null }],
})[0].cwd, null);

console.log("codex import: bounded detection and completion reporting");
