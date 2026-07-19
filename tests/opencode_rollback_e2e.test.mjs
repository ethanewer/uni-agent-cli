import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { AcpClient } from "../src/pi-harness.mjs";
import { OpenCodeAdapter } from "../src/harness/adapters/opencode.mjs";
import { createAdapter } from "../src/harness/registry.mjs";
import {
	openCodeCheckpointsFromMessages,
	openCodeCliInvocation,
	openCodeForkBoundary,
	openCodeForkCheckpointId,
	openCodeResponseData,
	withOpenCodeClient,
} from "../src/harness/opencode-checkpoints.mjs";

try {
	openCodeCliInvocation();
} catch (error) {
	if (error?.code !== "MODULE_NOT_FOUND" && error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
	console.log("OpenCode rollback E2E skipped: optional OpenCode CLI is unavailable on this platform");
	process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-opencode-rollback-e2e-"));
const project = path.join(root, "project");
const stateFile = path.join(project, "state.txt");
fs.mkdirSync(project);
fs.writeFileSync(stateFile, "before\n");
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["add", "state.txt"], { cwd: project });
execFileSync("git", ["-c", "user.name=cc test", "-c", "user.email=cc@example.invalid", "commit", "-qm", "baseline"], { cwd: project });
const env = {
	...process.env,
	XDG_CONFIG_HOME: path.join(root, "config"),
	XDG_DATA_HOME: path.join(root, "data"),
	XDG_STATE_HOME: path.join(root, "state"),
	XDG_CACHE_HOME: path.join(root, "cache"),
};
let sourceId;
let conversationChildId;
const mockProvider = await startMockProvider();
env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
	enabled_providers: ["ccmock"],
	model: "ccmock/mock-model",
	permission: "allow",
	provider: {
		ccmock: {
			npm: "@ai-sdk/openai-compatible",
			name: "cc rollback E2E mock",
			options: {
				apiKey: "cc-e2e",
				baseURL: `${mockProvider.url}/v1`,
			},
			models: {
				"mock-model": {
					name: "cc rollback E2E model",
					tool_call: true,
					limit: { context: 16_384, output: 2_048 },
				},
			},
		},
	},
});

try {
	await withOpenCodeClient(project, async (client) => {
		let fileBranchId;
		try {
			const source = openCodeResponseData(await client.session.create({
				directory: project,
				title: "cc rollback e2e",
			}), "session creation");
			sourceId = source.id;
			assert.match(sourceId, /^ses_/u);

			const prompt = openCodeResponseData(await client.session.prompt({
				sessionID: sourceId,
				directory: project,
				noReply: true,
				parts: [{ type: "text", text: "retain this checkpoint prompt" }],
			}), "prompt creation");
			assert.equal(prompt.info.role, "user");

			const mutation = openCodeResponseData(await client.session.prompt({
				sessionID: sourceId,
				directory: project,
				model: { providerID: "ccmock", modelID: "mock-model" },
				agent: "build",
				parts: [{ type: "text", text: "Change state.txt from before to after." }],
			}), "workspace mutation");
			assert.equal(mutation.info.role, "assistant");
			assert.equal(fs.readFileSync(stateFile, "utf8"), "after\n");

			const sourceMessages = openCodeResponseData(await client.session.messages({
				sessionID: sourceId,
				directory: project,
			}), "message listing");
			const checkpoints = openCodeCheckpointsFromMessages(sourceMessages).checkpoints;
			assert.equal(checkpoints[0].summary, "retain this checkpoint prompt");
			const boundaryID = openCodeForkBoundary(sourceMessages, checkpoints[0].id);
			assert.equal(typeof boundaryID, "string");

			const conversationChild = openCodeResponseData(await client.session.fork({
				sessionID: sourceId,
				directory: project,
				messageID: boundaryID,
			}), "conversation fork");
			conversationChildId = conversationChild.id;
			assert.notEqual(conversationChildId, sourceId);

			const fileBranch = openCodeResponseData(await client.session.fork({
				sessionID: sourceId,
				directory: project,
			}), "file rollback branch creation");
			fileBranchId = fileBranch.id;
			assert.notEqual(fileBranchId, sourceId);
			const fileMessages = openCodeResponseData(await client.session.messages({
				sessionID: fileBranchId,
				directory: project,
			}), "file rollback message listing");
			const fileMessageID = openCodeForkCheckpointId(sourceMessages, fileMessages, checkpoints[0].id);

			const reverted = openCodeResponseData(await client.session.revert({
				sessionID: fileBranchId,
				directory: project,
				messageID: fileMessageID,
			}), "file revert");
			assert.equal(reverted.revert?.messageID, fileMessageID);
			assert.equal(fs.readFileSync(stateFile, "utf8"), "before\n", "revert restores real workspace contents");
			const untouchedSource = openCodeResponseData(await client.session.get({
				sessionID: sourceId,
				directory: project,
			}), "source session read");
			assert.equal(untouchedSource.revert, undefined, "file rollback must not mark the source conversation reverted");
			const restored = openCodeResponseData(await client.session.unrevert({
				sessionID: fileBranchId,
				directory: project,
			}), "file rewind compensation");
			assert.equal(restored.revert, undefined);
			assert.equal(fs.readFileSync(stateFile, "utf8"), "after\n", "unrevert restores the compensated workspace state");
		} finally {
			if (fileBranchId) {
				openCodeResponseData(await client.session.delete({ sessionID: fileBranchId, directory: project }), "file branch cleanup");
			}
		}
	}, { env });

	const agentConfig = {
		...OpenCodeAdapter.defaultAgentConfig,
		env,
		acp: { ...OpenCodeAdapter.defaultAgentConfig.acp },
	};
	const adapter = createAdapter("opencode", agentConfig, {
		onEvent: () => {},
		requestInteraction: async () => undefined,
		requestPermission: async () => ({ outcome: "cancelled" }),
	}, {
		connectionFactory: (agent, onEvent, options) => new AcpClient(agent, onEvent, options),
	});
	try {
		await adapter.connect({ cwd: project, createSession: false });
		assert.deepEqual(adapter.connection.agentInfo, { name: "OpenCode", version: "1.18.3" });
		assert.deepEqual(adapter.capabilities.checkpointModes, ["both", "conversation", "code"]);
		await adapter.loadSession(conversationChildId);
		assert.equal(adapter.sessionId, conversationChildId, "live OpenCode ACP loads a sibling-server fork");
		assert.equal((await adapter.listCheckpoints()).checkpoints[0].summary, "retain this checkpoint prompt");
	} finally {
		await adapter.stopAndWait();
	}

	await withOpenCodeClient(project, async (client) => {
		if (conversationChildId) {
			openCodeResponseData(await client.session.delete({ sessionID: conversationChildId, directory: project }), "child cleanup");
		}
		if (sourceId) openCodeResponseData(await client.session.delete({ sessionID: sourceId, directory: project }), "source cleanup");
	}, { env });
} finally {
	await mockProvider.close();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("OpenCode rollback E2E: real file restore plus sibling-server fork loaded over live ACP passed");

async function startMockProvider() {
	const server = http.createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/v1/models") {
			writeJson(response, {
				object: "list",
				data: [{ id: "mock-model", object: "model", created: 0, owned_by: "cc" }],
			});
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let raw = "";
		for await (const chunk of request) raw += chunk;
		const body = JSON.parse(raw);
		const messages = Array.isArray(body.messages) ? body.messages : [];
		const afterTool = messages.at(-1)?.role === "tool";
		const chunks = afterTool
			? [
				completionChunk({ role: "assistant" }),
				completionChunk({ content: "Updated state.txt." }),
				completionChunk({}, "stop"),
			]
			: [
				completionChunk({ role: "assistant" }),
				completionChunk({
					tool_calls: [{
						index: 0,
						id: "call_cc_rollback",
						type: "function",
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command: "printf 'after\\n' > state.txt",
								description: "Update the rollback test fixture",
							}),
						},
					}],
				}),
				completionChunk({}, "tool_calls"),
			];
		response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
		response.end("data: [DONE]\n\n");
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert.equal(typeof address, "object");
	return {
		url: `http://127.0.0.1:${address.port}`,
		close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
	};
}

function completionChunk(delta, finishReason = null) {
	return {
		id: "chatcmpl-cc-rollback",
		object: "chat.completion.chunk",
		created: 0,
		model: "mock-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function writeJson(response, value) {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}
