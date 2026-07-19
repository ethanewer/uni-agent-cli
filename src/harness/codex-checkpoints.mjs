import {
	CHECKPOINT_LIMIT,
	checkpointSummary,
	normalizeCheckpointListResponse,
} from "./checkpoints.mjs";
import { codexPersistentForkParams } from "./codex-thread.mjs";

const IMAGE_MIME_TYPES = new Map([
	["png", "image/png"],
	["jpg", "image/jpeg"],
	["jpeg", "image/jpeg"],
	["gif", "image/gif"],
	["webp", "image/webp"],
	["bmp", "image/bmp"],
	["svg", "image/svg+xml"],
]);

export function codexCheckpointReadParams(threadId) {
	return { threadId: canonicalUuid(threadId, "Codex thread ID"), includeTurns: true };
}

export function codexCheckpointsFromThreadRead(response, options = {}) {
	const thread = response?.thread;
	if (!thread || typeof thread !== "object" || !Array.isArray(thread.turns)) {
		throw new Error("Codex thread/read returned an invalid thread history");
	}
	const limit = Number.isInteger(options.limit)
		? Math.max(1, Math.min(CHECKPOINT_LIMIT, options.limit))
		: CHECKPOINT_LIMIT;
	const checkpoints = [];
	for (const turn of thread.turns) {
		if (!turn || typeof turn !== "object" || turn.status === "inProgress") continue;
		const user = Array.isArray(turn.items)
			? turn.items.find((item) => item?.type === "userMessage" && Array.isArray(item.content))
			: undefined;
		if (!user) continue;
		const text = user.content
			.filter((item) => item?.type === "text" && typeof item.text === "string")
			.map((item) => item.text)
			.join("\n");
		checkpoints.push({
			id: canonicalUuid(turn.id, "Codex turn ID"),
			summary: checkpointSummary(text) || "User message",
		});
	}
	return normalizeCheckpointListResponse({ checkpoints: checkpoints.slice(-limit) });
}

export function requireCodexCheckpoint(response, checkpointId) {
	const id = canonicalUuid(checkpointId, "Codex turn ID");
	const checkpoints = codexCheckpointsFromThreadRead(response, { limit: CHECKPOINT_LIMIT }).checkpoints;
	if (!checkpoints.some((checkpoint) => checkpoint.id === id)) {
		throw new Error("checkpoint is not a completed user turn in this Codex thread");
	}
	return id;
}

// Codex forks only at whole-turn boundaries. A portable checkpoint instead
// keeps the selected user prompt and drops that turn's answer. Build the data
// needed to fork through the selected turn, roll that complete turn back, then
// inject only its user input into the child model history. The replay text lets
// the adapter restore the same prompt in cc's transcript because injected raw
// response items are model-visible but are not represented as app-server turns.
export function codexCheckpointRollbackPlan(response, checkpointId, options = {}) {
	const id = requireCodexCheckpoint(response, checkpointId);
	const turns = response.thread.turns;
	const index = turns.findIndex((turn) => canonicalUuid(turn?.id, "Codex turn ID") === id);
	const turn = turns[index];
	const user = turn.items.find((item) => item?.type === "userMessage" && Array.isArray(item.content));
	const responseContent = [];
	const replayText = [];
	for (const input of user.content) {
		const converted = codexUserInputForInjection(input, options);
		if (converted.responseContent) responseContent.push(converted.responseContent);
		if (converted.replayText) replayText.push(converted.replayText);
	}
	if (responseContent.length === 0) {
		throw new Error("the selected Codex checkpoint has no restorable user input");
	}
	return {
		turnId: id,
		retainedTurnIds: turns.slice(0, index).map((entry) => canonicalUuid(entry?.id, "Codex turn ID")),
		injectionItems: [{ type: "message", role: "user", content: responseContent }],
		replayText,
	};
}

export function assertCodexCheckpointTurnRemoved(response, plan) {
	const turns = response?.thread?.turns;
	if (!Array.isArray(turns)) throw new Error("Codex thread/rollback returned an invalid thread history");
	const actual = turns.map((turn) => canonicalUuid(turn?.id, "Codex turn ID"));
	if (
		actual.length !== plan.retainedTurnIds.length ||
		actual.some((id, index) => id !== plan.retainedTurnIds[index])
	) {
		throw new Error("Codex did not remove exactly the selected checkpoint turn from the fork");
	}
	return response;
}

export function codexCheckpointForkParams(threadId, checkpointId) {
	return codexPersistentForkParams(threadId, checkpointId);
}

function codexUserInputForInjection(input, options) {
	if (!input || typeof input !== "object") return {};
	if (input.type === "text" && typeof input.text === "string" && input.text) {
		return { responseContent: { type: "input_text", text: input.text }, replayText: input.text };
	}
	if (input.type === "image" && typeof input.url === "string" && input.url) {
		return {
			responseContent: {
				type: "input_image",
				image_url: input.url,
				...(typeof input.detail === "string" ? { detail: input.detail } : {}),
			},
			replayText: `[@image](${input.url})`,
		};
	}
	if (input.type === "localImage" && typeof input.path === "string" && input.path) {
		if (typeof options.readLocalImage !== "function") {
			throw new Error("Codex checkpoint rollback requires a local-image reader");
		}
		const data = options.readLocalImage(input.path);
		if (!Buffer.isBuffer(data) || data.length === 0) {
			throw new Error(`Codex checkpoint image is empty: ${input.path}`);
		}
		const mime = localImageMimeType(input.path, data);
		return {
			responseContent: {
				type: "input_image",
				image_url: `data:${mime};base64,${data.toString("base64")}`,
				...(typeof input.detail === "string" ? { detail: input.detail } : {}),
			},
			replayText: `[@${input.path.split(/[\\/]/u).at(-1) || "image"}](file://${input.path})`,
		};
	}
	if (
		(input.type === "skill" || input.type === "mention") &&
		typeof input.name === "string" && input.name
	) {
		const reference = `${input.type}:${input.name}${typeof input.path === "string" && input.path ? ` (${input.path})` : ""}`;
		return { responseContent: { type: "input_text", text: reference }, replayText: reference };
	}
	return {};
}

function localImageMimeType(filePath, data) {
	const extension = String(filePath).split(".").at(-1)?.toLowerCase();
	const byExtension = IMAGE_MIME_TYPES.get(extension);
	if (byExtension) return byExtension;
	if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
	if (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
	if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	throw new Error(`Codex checkpoint image has an unsupported format: ${filePath}`);
}

function canonicalUuid(value, label) {
	const id = String(value ?? "").trim().toLowerCase();
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
		throw new Error(`${label} must be a canonical UUID`);
	}
	return id;
}
