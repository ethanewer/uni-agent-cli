import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const restorePath = fileURLToPath(new URL("../src/terminal-restore.mjs", import.meta.url));
const managerPath = fileURLToPath(new URL("../src/cc.mjs", import.meta.url));

// PENDIN is transient line-discipline state. Reconstructing it after the
// manager exits can race the parent shell and re-echo its next command.
for (const sourcePath of [restorePath, managerPath]) {
	const source = fs.readFileSync(sourcePath, "utf8");
	assert.doesNotMatch(source, /spawnSync\("stty", \["pendin"\]/u);
}

const restoreSource = fs.readFileSync(restorePath, "utf8");
assert.equal(restoreSource.match(/spawnSync\("stty"/gu)?.length, 1);

console.log("terminal restore tests passed");
