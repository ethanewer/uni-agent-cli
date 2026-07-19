#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { safeJson, WORKFLOW_LIMITS } from "./types.mjs";

const endpoint = process.env.CC_WORKFLOW_BROKER_ENDPOINT;
const token = process.env.CC_WORKFLOW_BROKER_TOKEN;
const workflowMode = process.env.CC_WORKFLOW_MODE ?? "flexible";
if (!endpoint || !token) throw new Error("cc workflow broker configuration is missing");

function call(method, params, signal) {
	return new Promise((resolve, reject) => {
		let request;
		try {
			if (method === "Workflow") safeJson(params?.args ?? null, "Workflow args", WORKFLOW_LIMITS.maxArgsBytes);
			request = safeJson({ id: randomUUID(), token, method, params }, "workflow broker request", WORKFLOW_LIMITS.maxRpcBytes);
		} catch (error) {
			reject(error);
			return;
		}
		const socket = net.createConnection(endpoint);
		let input = "";
		let settled = false;
		let acceptedResponse;
		let confirmationAcknowledged = false;
		let reconciling = false;
		// Workflow launch can remain in a human source-review dialog indefinitely.
		// Adapter cancellation, token revocation, broker shutdown, and socket errors
		// are the lifecycle bounds; a short wall timer would reject a valid approval
		// while the user is still reading it.
		const cleanup = () => { signal?.removeEventListener("abort", onAbort); };
		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			cleanup();
			// Each broker call owns one socket. Close it on every terminal path,
			// including broker-declared/protocol errors, so a long-lived MCP helper
			// cannot exhaust the broker's connection bound with settled calls.
			socket.destroy();
			if (error) reject(error); else resolve(value);
		};
		const onAbort = () => {
			const error = signal.reason ?? new Error("workflow tool call cancelled");
			socket.destroy();
			finish(error);
		};
		const reconcileCommittedLaunch = (transportError) => {
			if (reconciling || method !== "Workflow" || !confirmationAcknowledged || typeof acceptedResponse?.value?.taskId !== "string") return false;
			reconciling = true;
			socket.destroy();
			void call("WorkflowStatus", { taskId: acceptedResponse.value.taskId, action: "status", requireCommitted: true }, signal).then(
				() => finish(undefined, acceptedResponse.value),
				() => finish(transportError),
			);
			return true;
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) return onAbort();
		socket.setEncoding("utf8");
		socket.once("connect", () => socket.write(`${request}\n`));
		socket.on("data", (chunk) => {
			input += chunk;
			let newline;
			while (!settled && (newline = input.indexOf("\n")) >= 0) {
				const frame = input.slice(0, newline);
				input = input.slice(newline + 1);
				if (!frame) continue;
				try {
					const response = JSON.parse(frame);
					if (!response.ok) throw Object.assign(new Error(response.error?.message ?? "workflow broker failed"), { code: response.error?.code });
					if (!acceptedResponse) {
						if (typeof response.ack !== "string" || !response.ack) throw new Error("workflow broker response acknowledgement is missing");
						acceptedResponse = { token: response.ack, value: response.value };
						socket.write(`${JSON.stringify({ ack: response.ack })}\n`, (error) => {
							if (error) finish(error);
						});
						continue;
					}
					if (!confirmationAcknowledged) {
						if (response.ackConfirmed !== acceptedResponse.token) throw new Error("workflow broker response acknowledgement was not confirmed");
						confirmationAcknowledged = true;
						socket.write(`${JSON.stringify({ confirmAck: acceptedResponse.token })}\n`, (error) => {
							if (error && !reconcileCommittedLaunch(error)) finish(error);
						});
						continue;
					}
					if (response.committed !== acceptedResponse.token) throw new Error("workflow broker launch commit was not confirmed");
					socket.end();
					finish(undefined, acceptedResponse.value);
				} catch (error) { if (!reconcileCommittedLaunch(error)) finish(error); }
			}
		});
		socket.once("error", (error) => { if (!reconcileCommittedLaunch(error)) finish(error); });
		socket.once("close", () => {
			if (reconciling) return;
			const error = new Error("cc workflow broker disconnected before responding");
			if (!reconcileCommittedLaunch(error)) finish(error);
		});
	});
}

const server = new McpServer({ name: "cc-dynamic-workflows", version: "1.0.0" });
server.registerTool("Workflow", {
	description: `Write and start an approved dynamic JavaScript workflow in cc. Pass exactly one of script or name. Inline scripts export const meta={name,description,phases?}, then use top-level await/return with these globals: agent(prompt,{harness?,model?,effort?,label?,phase?,schema?,isolation?,readOnly?,agentType?}), parallel([thunks]), pipeline(items,...stages), workflow(name,args?), phase(title), log(message), args, and budget. The run continues in the background. Current policy: ${workflowMode}${workflowMode === "clone-only" ? "; every agent is forced to the parent harness, model, and reasoning effort" : "; agents may select configured harness/model/effort combinations"}.`,
	inputSchema: {
		script: z.string().max(256 * 1024).optional(),
		name: z.string().max(128).optional(),
		args: z.unknown().optional(),
		tokenBudget: z.number().int().min(1000).max(1_000_000_000).nullable().optional(),
		maxConcurrency: z.number().int().min(1).max(16).optional(),
	},
}, async (input, extra) => {
	const result = await call("Workflow", input, extra?.signal);
	return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});
server.registerTool("WorkflowStatus", {
	description: "Inspect, pause, resume, or stop a cc dynamic workflow.",
	inputSchema: {
		taskId: z.string().uuid(),
		action: z.enum(["status", "pause", "resume", "stop"]).optional(),
	},
}, async (input, extra) => {
	const result = await call("WorkflowStatus", input, extra?.signal);
	return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
});

await server.connect(new StdioServerTransport());
