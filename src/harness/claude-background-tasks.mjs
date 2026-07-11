// Claude bridge glue for the harness-neutral background-task protocol.
//
// The maintained ACP adapter can selectively mirror official Agent SDK frames
// through `_claude/sdkMessage`. This registry injects only the five task filters,
// keeps the caller's explicit raw subscription separate, and converts mirrored
// frames into bounded generic snapshots for the shared adapter/TUI.

import {
	CLAUDE_BACKGROUND_TASK_MESSAGE_FILTERS,
	BACKGROUND_TASK_LIST_LIMIT,
	BACKGROUND_TASK_NOTIFICATION_LIMIT,
	BackgroundTaskStore,
	parseBackgroundTaskListParams,
	sdkMessageMatchesFilter,
	withBackgroundTaskSdkEvents,
} from "./background-tasks.mjs";

export const CLAUDE_RAW_SDK_MESSAGE_NOTIFICATION = "_claude/sdkMessage";
export const CLAUDE_BACKGROUND_TASK_SESSION_LIMIT = 64;

export class ClaudeBackgroundTaskBridge {
	constructor(options = {}) {
		this.storeLimit = options.storeLimit;
		this.sessionLimit = Number.isInteger(options.sessionLimit)
			? Math.max(1, Math.min(CLAUDE_BACKGROUND_TASK_SESSION_LIMIT, options.sessionLimit))
			: CLAUDE_BACKGROUND_TASK_SESSION_LIMIT;
		this.sessions = new Map();
	}

	/** Prepare a session request while retaining what the caller asked to see raw. */
	prepareSessionRequest(params) {
		return withBackgroundTaskSdkEvents(params);
	}

	registerSession(sessionId, forwardRawSdkMessages = false, options = {}) {
		const { sessionId: safeSessionId } = parseBackgroundTaskListParams({ sessionId });
		const previous = this.sessions.get(safeSessionId);
		// Refresh insertion order on reuse so the bounded registry evicts the
		// least-recently registered historical session. Explicit close/delete still
		// removes state immediately.
		this.sessions.delete(safeSessionId);
		this.sessions.set(safeSessionId, {
			store: options.reset === true
				? new BackgroundTaskStore({ limit: this.storeLimit })
				: (previous?.store ?? new BackgroundTaskStore({ limit: this.storeLimit })),
			forwardRawSdkMessages,
		});
		while (this.sessions.size > this.sessionLimit) {
			this.sessions.delete(this.sessions.keys().next().value);
		}
	}

	removeSession(sessionId) {
		if (typeof sessionId === "string") this.sessions.delete(sessionId);
	}

	clear() {
		this.sessions.clear();
	}

	list(sessionId, options = {}) {
		const parsed = parseBackgroundTaskListParams({
			sessionId,
			...(options.limit !== undefined ? { limit: options.limit } : {}),
		});
		const record = this.sessions.get(parsed.sessionId);
		return record?.store.list({ limit: parsed.limit ?? BACKGROUND_TASK_LIST_LIMIT }) ?? { revision: 0, tasks: [], total: 0 };
	}

	/**
	 * Consume one maintained-adapter raw notification. The caller sends
	 * `notification` over cc's extension when changed, and forwards the original
	 * frame only when the ACP caller explicitly subscribed to it.
	 */
	consumeRawNotification(params) {
		if (!isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.message)) {
			return { recognized: false, forwardRaw: false, changed: false };
		}
		let sessionId;
		try {
			({ sessionId } = parseBackgroundTaskListParams({ sessionId: params.sessionId }));
		} catch {
			return { recognized: false, forwardRaw: false, changed: false };
		}
		const record = this.sessions.get(sessionId);
		if (!record) return { recognized: true, forwardRaw: false, changed: false };
		const message = params.message;
		const forwardRaw = sdkMessageMatchesFilter(record.forwardRawSdkMessages, message);
		// Every official lifecycle frame carries its SDK session id. Refuse to let a
		// malformed/mismatched wrapper update another session's task state.
		const isTaskLifecycle = sdkMessageMatchesFilter(CLAUDE_BACKGROUND_TASK_MESSAGE_FILTERS, message);
		if (isTaskLifecycle && message.session_id !== sessionId) {
			return { recognized: true, forwardRaw, changed: false };
		}
		const changed = record.store.applySdkMessage(message);
		return {
			recognized: true,
			forwardRaw,
			changed,
			...(changed ? {
				notification: {
					sessionId,
					...record.store.list({ limit: BACKGROUND_TASK_NOTIFICATION_LIMIT }),
				},
			} : {}),
		};
	}
}

function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
