import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listLocalCodexSessionsAsync } from "../src/pi-harness.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-session-index-"));
const dbPath = path.join(root, "state_5.sqlite");
const helperPath = path.join(root, "fake-sqlite.mjs");
fs.writeFileSync(dbPath, "test fixture");
fs.writeFileSync(helperPath, `
const mode = process.argv[2];
const rows = [{
  id: "session-1",
  cwd: ${JSON.stringify(root)},
  title: "Indexed session",
  updated_at: 123,
  updated_at_ms: 456000,
}];
if (mode === "success") {
  setTimeout(() => process.stdout.write(JSON.stringify(rows)), 80);
} else if (mode === "empty") {
  process.stdout.write("[]");
} else if (mode === "invalid") {
  process.stdout.write("{not-json");
} else if (mode === "failure") {
  process.stderr.write("query failed");
  process.exitCode = 7;
} else if (mode === "oversized") {
  process.stdout.write(JSON.stringify(rows));
} else if (mode === "hang") {
  setTimeout(() => process.stdout.write(JSON.stringify(rows)), 10_000);
}
`);

const queryOptions = (mode, extra = {}) => ({
	sqliteCommand: process.execPath,
	sqliteCommandArgs: [helperPath, mode],
	caseInsensitiveFilesystem: false,
	...extra,
});

try {
	let timerFired = false;
	const responsivenessTimer = setTimeout(() => { timerFired = true; }, 10);
	const sessions = await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("success"));
	clearTimeout(responsivenessTimer);
	assert.equal(timerFired, true, "the event loop must remain responsive while sqlite is running");
	assert.deepEqual(sessions, [{
		sessionId: "session-1",
		cwd: root,
		title: "Indexed session",
		updatedAt: new Date(456000).toISOString(),
	}]);

	assert.deepEqual(
		await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("empty")),
		[],
		"an empty result remains authoritative rather than becoming unavailable",
	);
	assert.equal(
		await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("invalid")),
		undefined,
		"invalid JSON remains an unavailable index",
	);
	assert.equal(
		await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("failure")),
		undefined,
		"a nonzero sqlite exit remains an unavailable index",
	);
	assert.equal(
		await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("oversized", { maxStdoutBytes: 16 })),
		undefined,
		"truncated output must not be mistaken for an authoritative query result",
	);
	assert.equal(
		await listLocalCodexSessionsAsync(root, dbPath, 10, {
			...queryOptions("success"),
			sqliteCommand: path.join(root, "missing-sqlite"),
		}),
		undefined,
		"an unavailable sqlite executable preserves ACP fallback semantics",
	);

	const timeoutStartedAt = Date.now();
	assert.equal(
		await listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("hang", { timeoutMs: 40 })),
		undefined,
		"a timed-out query remains an unavailable index",
	);
	assert.ok(Date.now() - timeoutStartedAt < 1_500, "the timeout must retire the child without waiting for its work");

	let shutdown;
	let registrations = 0;
	let unregistrations = 0;
	const processTracker = {
		assertOpen() {},
		register(stopAndWait) {
			registrations += 1;
			shutdown = stopAndWait;
			return () => { unregistrations += 1; };
		},
	};
	const pending = listLocalCodexSessionsAsync(root, dbPath, 10, queryOptions("hang", { processTracker }));
	assert.equal(typeof shutdown, "function", "the query registers its process tree before yielding");
	await shutdown();
	await assert.rejects(
		pending,
		(error) => error?.code === "CC_NATIVE_PROCESS_SHUTDOWN",
		"app shutdown must not be downgraded into an ACP fallback request",
	);
	assert.equal(registrations, 1);
	assert.equal(unregistrations, 1, "the stopped query releases its process tracker entry");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("codex async session-index tests passed");
