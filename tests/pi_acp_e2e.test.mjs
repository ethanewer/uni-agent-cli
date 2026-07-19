import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AcpClient } from "../src/pi-harness.mjs";
import { PiAdapter } from "../src/harness/adapters/pi.mjs";
import { registerPiAcpSession } from "../src/harness/pi-checkpoints.mjs";
import { createAdapter } from "../src/harness/registry.mjs";

const events = [];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-pi-acp-e2e-"));
const cwd = path.join(root, "project");
const home = path.join(root, "home");
const sessionDir = path.join(root, "project-sessions");
fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ sessionDir }));

// Seed a real Pi transcript in the project-only store, then publish the source
// exactly as pi-acp does for an active session. The rollback branch itself is
// intentionally not pre-registered: rewindCheckpoint must make it loadable.
const source = SessionManager.create(cwd, sessionDir);
const checkpointId = source.appendMessage({ role: "user", content: "Rollback from custom storage", timestamp: Date.now() });
source.appendMessage({ role: "assistant", content: [{ type: "text", text: "Later response" }], timestamp: Date.now() });
const sourceBranch = {
	sessionId: source.getSessionId(),
	sessionFile: source.getSessionFile(),
	cwd,
};
registerPiAcpSession(sourceBranch, { env: { HOME: home } });

const agentConfig = {
	...PiAdapter.defaultAgentConfig,
	env: { HOME: home },
	acp: { ...PiAdapter.defaultAgentConfig.acp },
};
const adapter = createAdapter("pi", agentConfig, {
	onEvent: (event) => events.push(event),
	requestInteraction: async () => undefined,
	requestPermission: async () => ({ outcome: "cancelled" }),
}, {
	connectionFactory: (agent, onEvent, options) => new AcpClient(agent, onEvent, options),
});

try {
	await adapter.connect({ cwd, createSession: false });
	assert.equal(adapter.connection.agentInfo.name, "pi-acp");
	assert.equal(adapter.connection.agentInfo.version, "0.0.31");
	assert.deepEqual(adapter.capabilities.checkpointModes, ["conversation"]);
	await adapter.loadSession(sourceBranch.sessionId);
	assert.deepEqual(await adapter.listCheckpoints(), {
		checkpoints: [{ id: checkpointId, summary: "Rollback from custom storage" }],
	});
	const rollback = await adapter.rewindCheckpoint(checkpointId, "conversation");
	assert.equal(adapter.sessionId, rollback.sessionId);
	const map = JSON.parse(fs.readFileSync(path.join(home, ".pi", "pi-acp", "session-map.json"), "utf8"));
	assert.equal(map.sessions[rollback.sessionId].sessionFile.startsWith(`${sessionDir}${path.sep}`), true);
	assert.equal(fs.existsSync(map.sessions[rollback.sessionId].sessionFile), true);
	assert.equal(events.some((event) => event.type === "error"), false);
} finally {
	await adapter.stopAndWait();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("Pi ACP E2E: pinned adapter loaded rollback from a project-specific session directory");
