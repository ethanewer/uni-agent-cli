import assert from "node:assert/strict";

import { codexPersistentForkParams, codexPersistentForkSession } from "../src/harness/codex-thread.mjs";

const parent = "019abcde-1234-7abc-8def-0123456789ab";
const child = "019abcde-5678-7abc-8def-0123456789ab";
const turn = "019abcde-9999-7abc-8def-0123456789ab";

assert.deepEqual(codexPersistentForkParams(parent.toUpperCase()), { threadId: parent, ephemeral: false });
assert.deepEqual(codexPersistentForkParams(parent, ` ${turn.toUpperCase()} `), {
	threadId: parent,
	lastTurnId: turn,
	ephemeral: false,
});
assert.throws(() => codexPersistentForkParams("bad"), /canonical UUID/);
assert.throws(() => codexPersistentForkParams(parent, "bad"), /canonical UUID/);

assert.deepEqual(codexPersistentForkSession({
	thread: {
		id: child.toUpperCase(),
		forkedFromId: parent.toUpperCase(),
		ephemeral: false,
		name: "Alternative approach",
		preview: "preview",
		cwd: "/thread/cwd",
	},
	cwd: "/response/cwd",
}, parent), {
	sessionId: child,
	title: "Alternative approach",
	cwd: "/response/cwd",
	thread: {
		id: child.toUpperCase(),
		forkedFromId: parent.toUpperCase(),
		ephemeral: false,
		name: "Alternative approach",
		preview: "preview",
		cwd: "/thread/cwd",
	},
});

assert.equal(codexPersistentForkSession({
	thread: { id: child, forkedFromId: parent, ephemeral: false, name: null, preview: "First prompt", cwd: "/cwd" },
}, parent).title, "First prompt");
assert.throws(() => codexPersistentForkSession({}, parent), /invalid response/);
assert.throws(() => codexPersistentForkSession({ thread: { id: parent, ephemeral: false } }, parent), /reused/);
assert.throws(() => codexPersistentForkSession({ thread: { id: child, ephemeral: true } }, parent), /persistent/);
assert.throws(() => codexPersistentForkSession({ thread: { id: child } }, parent), /persistent/);
assert.throws(
	() => codexPersistentForkSession({ thread: { id: child, forkedFromId: turn, ephemeral: false } }, parent),
	/mismatched parent/,
);

console.log("codex persistent fork: request and response validation");
