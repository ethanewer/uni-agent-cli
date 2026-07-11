// Harness-neutral background-task protocol and state normalization.
//
// ACP does not yet define task lifecycle/control messages. cc negotiates this
// small extension with per-harness bridges, then exposes only these normalized,
// bounded records to the unified adapter/TUI. Raw harness messages never cross
// that boundary.

import { sanitizeShellOutput } from "./shell-input.mjs";

export const BACKGROUND_TASKS_META_KEY = "backgroundTasks";
export const BACKGROUND_TASKS_LIST_METHOD = "cc/session/tasks/list";
export const BACKGROUND_TASKS_STOP_METHOD = "cc/session/tasks/stop";
export const BACKGROUND_TASKS_BACKGROUND_METHOD = "cc/session/tasks/background";
export const BACKGROUND_TASKS_CHANGED_NOTIFICATION = "cc/session/tasks/changed";

export const BACKGROUND_TASK_LIMIT = 256;
export const BACKGROUND_TASK_LIST_LIMIT = 200;
export const BACKGROUND_TASK_NOTIFICATION_LIMIT = 50;
export const BACKGROUND_TASK_ID_MAX_CHARS = 512;
export const BACKGROUND_TASK_TEXT_MAX_CHARS = 2_048;
export const BACKGROUND_TASK_PATH_MAX_CHARS = 4_096;
export const BACKGROUND_TASK_DISPLAY_LIMIT = 50;

// The maintained Claude ACP adapter has an explicit, typed raw-message opt-in.
// Request only the lifecycle frames it otherwise intentionally drops.
export const CLAUDE_BACKGROUND_TASK_MESSAGE_FILTERS = Object.freeze([
	{ type: "system", subtype: "task_started" },
	{ type: "system", subtype: "task_progress" },
	{ type: "system", subtype: "task_updated" },
	{ type: "system", subtype: "task_notification" },
	{ type: "system", subtype: "background_tasks_changed" },
]);

const ACTIVE_STATUSES = new Set(["pending", "running", "paused"]);
const TASK_STATUSES = new Set(["pending", "running", "completed", "failed", "stopped", "paused"]);
const TERMINAL_STATUS_MAP = Object.freeze({
	completed: "completed",
	failed: "failed",
	stopped: "stopped",
	killed: "stopped",
});

/** Add cc's lifecycle filters without mutating a caller's ACP request/meta. */
export function withBackgroundTaskSdkEvents(params) {
	const request = isRecord(params) ? params : {};
	const meta = isRecord(request._meta) ? request._meta : {};
	const claudeCode = isRecord(meta.claudeCode) ? meta.claudeCode : {};
	const original = claudeCode.emitRawSDKMessages;
	let emitRawSDKMessages;
	if (original === true) {
		emitRawSDKMessages = true;
	} else {
		const filters = Array.isArray(original) ? original.filter(isSdkMessageFilter) : [];
		emitRawSDKMessages = dedupeFilters([...filters, ...CLAUDE_BACKGROUND_TASK_MESSAGE_FILTERS]);
	}
	return {
		params: {
			...request,
			_meta: {
				...meta,
				claudeCode: { ...claudeCode, emitRawSDKMessages },
			},
		},
		// The bridge uses this to preserve an explicit raw-message subscription
		// while withholding the lifecycle stream it injected for itself.
		forwardRawSdkMessages: original === true || Array.isArray(original) ? original : false,
	};
}

/** Match the adapter's documented SDKMessageFilter semantics. */
export function sdkMessageMatchesFilter(config, message) {
	if (config === true) return true;
	if (!Array.isArray(config) || !isRecord(message)) return false;
	return config.some((filter) =>
		isSdkMessageFilter(filter) &&
		filter.type === message.type &&
		(filter.subtype === undefined || filter.subtype === message.subtype) &&
		(filter.origin === undefined || filter.origin === message.origin?.kind));
}

/** Strict custom-request parsers. */
export function parseBackgroundTaskListParams(value) {
	const params = parseSessionParams(value, "tasks/list");
	if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > BACKGROUND_TASK_LIST_LIMIT)) {
		throw new Error(`tasks/list limit must be an integer from 1 to ${BACKGROUND_TASK_LIST_LIMIT}`);
	}
	return { ...params, ...(value.limit !== undefined ? { limit: value.limit } : {}) };
}

export function parseBackgroundTaskStopParams(value) {
	const params = parseSessionParams(value, "tasks/stop");
	return { ...params, taskId: requireSafeId(value.taskId, "taskId") };
}

export function parseBackgroundTasksBackgroundParams(value) {
	const params = parseSessionParams(value, "tasks/background");
	if (value.toolUseId === undefined) return params;
	return { ...params, toolUseId: requireSafeId(value.toolUseId, "toolUseId") };
}

export function normalizeBackgroundTaskListResponse(value) {
	if (!isRecord(value) || !Array.isArray(value.tasks) || !Number.isSafeInteger(value.revision) || value.revision < 0) {
		throw new Error("tasks/list returned an invalid response");
	}
	const total = value.total === undefined ? value.tasks.length : value.total;
	if (!Number.isSafeInteger(total) || total < value.tasks.length || total > BACKGROUND_TASK_LIMIT) {
		throw new Error("tasks/list returned an invalid total");
	}
	return {
		revision: value.revision,
		tasks: value.tasks.slice(0, BACKGROUND_TASK_LIST_LIMIT).map(normalizePublicTask),
		total,
	};
}

export function normalizeBackgroundTaskActionResponse(value, action) {
	if (!isRecord(value) || value.ok !== true) throw new Error(`tasks/${action} returned an invalid response`);
	if (action === "background" && typeof value.backgrounded !== "boolean") {
		throw new Error("tasks/background returned an invalid response");
	}
	return action === "background" ? { ok: true, backgrounded: value.backgrounded } : { ok: true };
}

/** Parse the host-owned `/tasks [stop <id>|background [tool-use-id]]` command. */
export function parseBackgroundTasksCommand(argument) {
	const text = String(argument ?? "").trim();
	if (!text) return { action: "list" };
	const separator = text.search(/\s/u);
	const action = (separator === -1 ? text : text.slice(0, separator)).toLowerCase();
	const operand = separator === -1 ? "" : text.slice(separator).trim();
	if (action === "list") {
		if (operand) throw new Error("usage: /tasks [stop <task-id>|background [tool-use-id]]");
		return { action: "list" };
	}
	if (action === "stop") {
		if (!operand) throw new Error("usage: /tasks stop <task-id>");
		return { action: "stop", taskId: requireSafeId(operand, "task id") };
	}
	if (action === "background") {
		return { action: "background", ...(operand ? { toolUseId: requireSafeId(operand, "tool-use id") } : {}) };
	}
	throw new Error("usage: /tasks [stop <task-id>|background [tool-use-id]]");
}

/** Compact, bounded text view shared by any task-capable harness. */
export function formatBackgroundTaskList(value) {
	const normalized = normalizeBackgroundTaskListResponse(value);
	if (normalized.tasks.length === 0) {
		return "No background tasks. Start one in the harness, or use /tasks background while a foreground task is running.";
	}
	const tasks = normalized.tasks.slice(0, BACKGROUND_TASK_DISPLAY_LIMIT);
	const lines = [`Background tasks (${normalized.total}):`];
	for (const task of tasks) {
		const state = taskStatusGlyph(task.status);
		const flags = [task.isBackgrounded ? "background" : undefined, task.type, task.subagentType]
			.filter(Boolean)
			.map((part) => displayText(part, 48));
		const detail = task.description ?? task.summary ?? task.error ?? "Task";
		const metrics = [];
		if (task.lastToolName) metrics.push(`tool ${displayText(task.lastToolName, 48)}`);
		if (task.usage?.totalTokens !== undefined) metrics.push(`${task.usage.totalTokens.toLocaleString("en-US")} tokens`);
		if (task.usage?.durationMs !== undefined) metrics.push(formatDuration(task.usage.durationMs));
		lines.push(
			`${state} ${displayText(task.id, 80)}${flags.length ? ` [${flags.join(", ")}]` : ""} ${displayText(detail, 240)}` +
			(metrics.length ? ` · ${metrics.join(" · ")}` : ""),
		);
	}
	if (normalized.total > tasks.length) lines.push(`… ${normalized.total - tasks.length} more`);
	lines.push("Use /tasks stop <task-id> to stop one, or /tasks background to move foreground work to the background.");
	return lines.join("\n");
}

/**
 * Per-session task state. `applySdkMessage` accepts only the five official
 * Claude Agent SDK lifecycle frames listed above. It returns true only when the
 * normalized public snapshot changed.
 */
export class BackgroundTaskStore {
	constructor(options = {}) {
		this.limit = clampInteger(options.limit, 1, BACKGROUND_TASK_LIMIT, BACKGROUND_TASK_LIMIT);
		this.tasks = new Map();
		this.backgroundIds = new Set();
		this.revision = 0;
		this.sequence = 0;
	}

	applySdkMessage(message) {
		if (!isRecord(message) || message.type !== "system") return false;
		let changed = false;
		switch (message.subtype) {
			case "task_started": {
				const id = optionalSafeId(message.task_id);
				if (!id) return false;
				changed = this.#merge(id, {
					status: "running",
					toolUseId: optionalSafeId(message.tool_use_id),
					description: cleanText(message.description),
					subagentType: cleanText(message.subagent_type),
					type: cleanText(message.task_type),
					workflowName: cleanText(message.workflow_name),
					ambient: message.skip_transcript === true,
				});
				break;
			}
			case "task_progress": {
				const id = optionalSafeId(message.task_id);
				if (!id) return false;
				changed = this.#merge(id, {
					status: this.tasks.get(id)?.status ?? "running",
					toolUseId: optionalSafeId(message.tool_use_id),
					description: cleanText(message.description),
					subagentType: cleanText(message.subagent_type),
					summary: cleanText(message.summary),
					lastToolName: cleanText(message.last_tool_name),
					usage: normalizeUsage(message.usage),
				});
				break;
			}
			case "task_updated": {
				const id = optionalSafeId(message.task_id);
				if (!id || !isRecord(message.patch)) return false;
				const mapped = TERMINAL_STATUS_MAP[message.patch.status] ??
					(TASK_STATUSES.has(message.patch.status) ? message.patch.status : undefined);
				const terminal = mapped !== undefined && !ACTIVE_STATUSES.has(mapped);
				changed = this.#merge(id, {
					status: mapped,
					description: cleanText(message.patch.description),
					error: cleanText(message.patch.error),
					isBackgrounded: terminal
						? false
						: (typeof message.patch.is_backgrounded === "boolean" ? message.patch.is_backgrounded : undefined),
				});
				if (terminal) this.backgroundIds.delete(id);
				else if (message.patch.is_backgrounded === true) this.backgroundIds.add(id);
				else if (message.patch.is_backgrounded === false) this.backgroundIds.delete(id);
				break;
			}
			case "task_notification": {
				const id = optionalSafeId(message.task_id);
				const status = TERMINAL_STATUS_MAP[message.status];
				if (!id || !status) return false;
				this.backgroundIds.delete(id);
				changed = this.#merge(id, {
					status,
					toolUseId: optionalSafeId(message.tool_use_id),
					isBackgrounded: false,
					summary: cleanText(message.summary),
					outputFile: cleanPath(message.output_file),
					usage: normalizeUsage(message.usage),
					ambient: message.skip_transcript === true,
					...(status === "completed" ? { error: null } : {}),
				});
				break;
			}
			case "background_tasks_changed": {
				if (!Array.isArray(message.tasks)) return false;
				const nextIds = new Set();
				for (const item of message.tasks.slice(0, this.limit)) {
					if (!isRecord(item)) continue;
					const id = optionalSafeId(item.task_id);
					if (!id) continue;
					nextIds.add(id);
					changed = this.#merge(id, {
						status: this.tasks.get(id)?.status ?? "running",
						isBackgrounded: true,
						type: cleanText(item.task_type),
						description: cleanText(item.description),
					}) || changed;
				}
				for (const id of this.backgroundIds) {
					if (!nextIds.has(id) && this.tasks.has(id)) {
						changed = this.#merge(id, { isBackgrounded: false }) || changed;
					}
				}
				this.backgroundIds = nextIds;
				break;
			}
			default:
				return false;
		}
		if (changed) {
			this.#trim();
			this.revision += 1;
		}
		return changed;
	}

	list(options = {}) {
		const limit = clampInteger(options.limit, 1, BACKGROUND_TASK_LIST_LIMIT, BACKGROUND_TASK_LIST_LIMIT);
		const tasks = [...this.tasks.values()]
			.sort((left, right) => {
				const activeDelta = Number(ACTIVE_STATUSES.has(right.status)) - Number(ACTIVE_STATUSES.has(left.status));
				return activeDelta || right._sequence - left._sequence;
			})
			.slice(0, limit)
			.map(publicTask);
		return { revision: this.revision, tasks, total: this.tasks.size };
	}

	#merge(id, patch) {
		const previous = this.tasks.get(id);
		const next = {
			...(previous ?? { id, status: "running", isBackgrounded: false, _sequence: ++this.sequence }),
		};
		for (const [key, value] of Object.entries(patch)) {
			if (value === null) delete next[key];
			else if (value !== undefined) next[key] = value;
		}
		if (deepEqualPublic(previous, next)) return false;
		this.tasks.set(id, next);
		return true;
	}

	#trim() {
		while (this.tasks.size > this.limit) {
			const ordered = [...this.tasks.values()].sort((left, right) => left._sequence - right._sequence);
			const victim = ordered.find((task) => !ACTIVE_STATUSES.has(task.status)) ?? ordered[0];
			if (!victim) break;
			this.tasks.delete(victim.id);
			this.backgroundIds.delete(victim.id);
		}
	}
}

function parseSessionParams(value, operation) {
	if (!isRecord(value)) throw new Error(`${operation} params must be an object`);
	return { sessionId: requireSafeId(value.sessionId, "sessionId") };
}

function normalizePublicTask(value) {
	if (!isRecord(value)) throw new Error("tasks/list returned an invalid task");
	const id = requireSafeId(value.id, "task id");
	if (!TASK_STATUSES.has(value.status) || typeof value.isBackgrounded !== "boolean") {
		throw new Error("tasks/list returned an invalid task");
	}
	return publicTask({
		id,
		status: value.status,
		isBackgrounded: value.isBackgrounded,
		toolUseId: optionalSafeId(value.toolUseId),
		type: cleanText(value.type),
		subagentType: cleanText(value.subagentType),
		workflowName: cleanText(value.workflowName),
		description: cleanText(value.description),
		summary: cleanText(value.summary),
		error: cleanText(value.error),
		lastToolName: cleanText(value.lastToolName),
		outputFile: cleanPath(value.outputFile),
		usage: normalizeUsage(value.usage),
		ambient: typeof value.ambient === "boolean" ? value.ambient : undefined,
	});
}

function publicTask(task) {
	const result = {};
	for (const key of [
		"id", "status", "isBackgrounded", "toolUseId", "type", "subagentType", "workflowName",
		"description", "summary", "error", "lastToolName", "outputFile", "usage", "ambient",
	]) {
		if (task[key] !== undefined) result[key] = task[key];
	}
	return result;
}

function normalizeUsage(value) {
	if (!isRecord(value)) return undefined;
	const totalTokens = nonNegativeInteger(value.total_tokens ?? value.totalTokens);
	const toolUses = nonNegativeInteger(value.tool_uses ?? value.toolUses);
	const durationMs = nonNegativeInteger(value.duration_ms ?? value.durationMs);
	if (totalTokens === undefined && toolUses === undefined && durationMs === undefined) return undefined;
	return {
		...(totalTokens !== undefined ? { totalTokens } : {}),
		...(toolUses !== undefined ? { toolUses } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
	};
}

function cleanText(value) {
	if (typeof value !== "string") return undefined;
	const clean = sanitizeShellOutput(value)
		.replace(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.trim();
	return clean ? [...clean].slice(0, BACKGROUND_TASK_TEXT_MAX_CHARS).join("") : undefined;
}

function cleanPath(value) {
	if (typeof value !== "string" || hasUnsafeProtocolText(value)) return undefined;
	return [...value].slice(0, BACKGROUND_TASK_PATH_MAX_CHARS).join("");
}

function requireSafeId(value, field) {
	const id = optionalSafeId(value);
	if (!id) throw new Error(`${field} must be a non-empty string without control characters`);
	return id;
}

function optionalSafeId(value) {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	if (!id || [...id].length > BACKGROUND_TASK_ID_MAX_CHARS || hasUnsafeProtocolText(id)) return undefined;
	return id;
}

function hasUnsafeProtocolText(value) {
	return /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || /\p{Default_Ignorable_Code_Point}/u.test(value);
}

function isSdkMessageFilter(value) {
	return isRecord(value) && typeof value.type === "string" &&
		(value.subtype === undefined || typeof value.subtype === "string") &&
		(value.origin === undefined || typeof value.origin === "string");
}

function dedupeFilters(filters) {
	const seen = new Set();
	return filters.filter((filter) => {
		const key = `${filter.type}\0${filter.subtype ?? ""}\0${filter.origin ?? ""}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function deepEqualPublic(left, right) {
	if (!left) return false;
	return JSON.stringify(publicTask(left)) === JSON.stringify(publicTask(right));
}

function nonNegativeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function clampInteger(value, min, max, fallback) {
	return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function taskStatusGlyph(status) {
	if (status === "completed") return "✓";
	if (status === "failed" || status === "stopped") return "×";
	if (status === "paused") return "Ⅱ";
	return "●";
}

function displayText(value, limit) {
	const clean = sanitizeShellOutput(value)
		.replace(/[\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, " ")
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...clean];
	return characters.length > limit ? `${characters.slice(0, Math.max(1, limit - 1)).join("")}…` : clean;
}

function formatDuration(durationMs) {
	if (durationMs < 1_000) return `${durationMs}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
	return `${Math.floor(durationMs / 60_000)}m ${Math.floor((durationMs % 60_000) / 1_000)}s`;
}
