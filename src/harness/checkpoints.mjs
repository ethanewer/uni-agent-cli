// Harness-neutral checkpoint/rewind extension. ACP has no checkpoint methods
// yet, so capable per-harness bridges negotiate this small surface and expose
// only bounded summaries and three portable rewind modes to the shared TUI.

import { sanitizeShellOutput } from "./shell-input.mjs";

export const CHECKPOINTS_META_KEY = "checkpoints";
export const CHECKPOINTS_LIST_METHOD = "cc/session/checkpoints/list";
export const CHECKPOINT_REWIND_METHOD = "cc/session/checkpoints/rewind";
export const CHECKPOINT_LIMIT = 200;
export const CHECKPOINT_ID_MAX_CHARS = 512;
export const CHECKPOINT_SUMMARY_MAX_CHARS = 240;
export const CHECKPOINT_PATH_MAX_BYTES = 4_096;
export const CHECKPOINT_FILE_CHANGE_LIMIT = 1_000;
export const CHECKPOINT_REWIND_MODES = Object.freeze(["code", "conversation", "both"]);

export function normalizeCheckpointModes(value, fallback = []) {
	const source = Array.isArray(value) ? value : fallback;
	const modes = [];
	for (const mode of source) {
		if (CHECKPOINT_REWIND_MODES.includes(mode) && !modes.includes(mode)) modes.push(mode);
	}
	return modes;
}

export function checkpointModesForCapabilities(capabilities) {
	if (capabilities?.checkpoints !== true) return [];
	return normalizeCheckpointModes(capabilities.checkpointModes, CHECKPOINT_REWIND_MODES);
}

export function assertCheckpointModeSupported(capabilities, mode) {
	if (!checkpointModesForCapabilities(capabilities).includes(mode)) {
		throw new Error(`this harness does not support ${mode} checkpoint rewind`);
	}
	return mode;
}

export function parseCheckpointListParams(value) {
	const sessionId = safeId(value?.sessionId, "sessionId");
	const limit = value?.limit === undefined ? CHECKPOINT_LIMIT : value.limit;
	if (!Number.isInteger(limit) || limit < 1 || limit > CHECKPOINT_LIMIT) {
		throw new Error(`checkpoint limit must be an integer from 1 to ${CHECKPOINT_LIMIT}`);
	}
	return { sessionId, limit };
}

export function parseCheckpointRewindParams(value) {
	const sessionId = safeId(value?.sessionId, "sessionId");
	const checkpointId = safeId(value?.checkpointId, "checkpointId");
	const mode = String(value?.mode ?? "");
	if (!CHECKPOINT_REWIND_MODES.includes(mode)) {
		throw new Error(`rewind mode must be one of ${CHECKPOINT_REWIND_MODES.join(", ")}`);
	}
	return { sessionId, checkpointId, mode };
}

export function normalizeCheckpointListResponse(value) {
	if (!isRecord(value) || !Array.isArray(value.checkpoints)) throw new Error("checkpoint list returned an invalid response");
	return {
		checkpoints: value.checkpoints.slice(-CHECKPOINT_LIMIT).map((entry) => {
			if (!isRecord(entry)) throw new Error("checkpoint list returned an invalid checkpoint");
			return {
				id: safeId(entry.id, "checkpoint id"),
				summary: checkpointSummary(entry.summary) || "User message",
			};
		}),
	};
}

export function normalizeCheckpointRewindResponse(value) {
	if (!isRecord(value) || value.ok !== true || !CHECKPOINT_REWIND_MODES.includes(value.mode)) {
		throw new Error("checkpoint rewind returned an invalid response");
	}
	const result = { ok: true, mode: value.mode };
	if (value.sessionId !== undefined) result.sessionId = safeId(value.sessionId, "sessionId");
	if ((value.mode === "conversation" || value.mode === "both") && !result.sessionId) {
		throw new Error("conversation rewind did not return a new sessionId");
	}
	if (Array.isArray(value.filesChanged)) {
		result.filesChanged = [];
		for (let index = 0; index < Math.min(value.filesChanged.length, CHECKPOINT_FILE_CHANGE_LIMIT); index += 1) {
			const entry = value.filesChanged[index];
			if (
				typeof entry === "string" &&
				entry.length > 0 &&
				Buffer.byteLength(entry, "utf8") <= CHECKPOINT_PATH_MAX_BYTES &&
				!hasUnsafeText(entry)
			) result.filesChanged.push(entry);
		}
	}
	if (Number.isSafeInteger(value.insertions) && value.insertions >= 0) result.insertions = value.insertions;
	if (Number.isSafeInteger(value.deletions) && value.deletions >= 0) result.deletions = value.deletions;
	return result;
}

/** Compact result text for the shared TUI; no harness-specific values leak in. */
export function formatCheckpointRewindResult(value) {
	const result = normalizeCheckpointRewindResponse(value);
	const conversation = result.mode === "conversation" || result.mode === "both";
	const code = result.mode === "code" || result.mode === "both";
	const parts = [];
	if (conversation) parts.push("Conversation rewound on a new branch; the original session is still resumable");
	if (code) {
		const count = result.filesChanged?.length;
		parts.push(count === undefined
			? "Files rewound to the checkpoint"
			: `${count} ${count === 1 ? "file" : "files"} rewound to the checkpoint`);
		const changes = [];
		if (result.insertions !== undefined) changes.push(`${result.insertions} insertions`);
		if (result.deletions !== undefined) changes.push(`${result.deletions} deletions`);
		if (changes.length > 0) parts.push(changes.join(" · "));
	}
	return parts.join("\n");
}

/** Convert SDK session messages to newest-last checkpoint choices. */
export function checkpointsFromSessionMessages(messages, options = {}) {
	const limit = Number.isInteger(options.limit)
		? Math.max(1, Math.min(CHECKPOINT_LIMIT, options.limit))
		: CHECKPOINT_LIMIT;
	const checkpoints = [];
	for (const message of Array.isArray(messages) ? messages : []) {
		if (message?.type !== "user" || message.parent_tool_use_id !== null) continue;
		let id;
		try {
			id = safeId(message.uuid, "checkpoint id");
		} catch {
			continue;
		}
		const raw = sessionMessageText(message.message);
		const summary = checkpointSummary(raw);
		if (!summary && isLocalCommandTranscript(raw)) continue;
		checkpoints.push({ id, summary: summary || "User message" });
	}
	return { checkpoints: checkpoints.slice(-limit) };
}

export function sessionMessageText(message) {
	if (typeof message === "string") return message;
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

export function checkpointSummary(value) {
	const clean = sanitizeShellOutput(value)
		.replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-(?:name|message|args)>/gu, " ")
		.replace(/<local-command-(?:stdout|stderr)>[\s\S]*?<\/local-command-(?:stdout|stderr)>/gu, " ")
		.replace(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...clean];
	return characters.length > CHECKPOINT_SUMMARY_MAX_CHARS
		? `${characters.slice(0, CHECKPOINT_SUMMARY_MAX_CHARS - 1).join("")}…`
		: clean;
}

function isLocalCommandTranscript(value) {
	return /^\s*<(?:command-name|local-command-stdout)>/u.test(value);
}

function safeId(value, field) {
	if (typeof value !== "string") throw new Error(`${field} must be a non-empty safe string`);
	const id = value.trim();
	if (!id || [...id].length > CHECKPOINT_ID_MAX_CHARS || hasUnsafeText(id)) {
		throw new Error(`${field} must be a non-empty safe string`);
	}
	return id;
}

function hasUnsafeText(value) {
	return /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || /\p{Default_Ignorable_Code_Point}/u.test(value);
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
