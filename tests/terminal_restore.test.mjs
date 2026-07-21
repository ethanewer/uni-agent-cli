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

// Attaching a data listener starts the stream and may issue a terminal read.
// Raw mode must clear macOS PENDIN before that first read can re-echo the
// command which launched cc.
const managerSource = fs.readFileSync(managerPath, "utf8");
const guardStart = managerSource.indexOf("function beginStartupInputGuard");
const guardEnd = managerSource.indexOf("\nconst nodeVersionParts", guardStart);
assert.notEqual(guardStart, -1);
assert.notEqual(guardEnd, -1);
const guardSource = managerSource.slice(guardStart, guardEnd);
const rawModeIndex = guardSource.indexOf("process.stdin.setRawMode(true)");
const listenerIndex = guardSource.indexOf('process.stdin.on("data", onData)');
assert.notEqual(rawModeIndex, -1);
assert.notEqual(listenerIndex, -1);
assert.ok(
	rawModeIndex < listenerIndex,
	"startup must enter raw mode before attaching the flowing stdin listener",
);

console.log("terminal restore tests passed");
