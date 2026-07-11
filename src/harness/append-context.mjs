// Narrow ACP extension for appending a user-context message without starting a
// model turn. Claude's bridge pushes shouldQuery:false onto the maintained
// adapter's long-lived input queue so the Query transport remains open.

export const APPEND_CONTEXT_METHOD = "cc/session/append_context";
export const APPEND_CONTEXT_META_KEY = "appendContext";
export const APPEND_CONTEXT_MAX_BYTES = 1024 * 1024;

export function parseAppendContextParams(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("append_context params must be an object");
	}
	const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
	if (!sessionId || sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(sessionId)) {
		throw new Error("append_context requires a valid sessionId");
	}
	if (typeof value.text !== "string" || !value.text || value.text.includes("\0")) {
		throw new Error("append_context requires non-empty text without NUL bytes");
	}
	if (Buffer.byteLength(value.text, "utf8") > APPEND_CONTEXT_MAX_BYTES) {
		throw new Error(`append_context text exceeds ${APPEND_CONTEXT_MAX_BYTES} bytes`);
	}
	return { sessionId, text: value.text };
}

export function normalizeAppendContextResponse(value) {
	if (!value || typeof value !== "object" || value.appended !== true) {
		throw new Error("append_context returned an invalid response");
	}
	return { appended: true };
}

export function claudeContextMessage(text, sessionId = undefined) {
	return {
		type: "user",
		message: { role: "user", content: text },
		parent_tool_use_id: null,
		shouldQuery: false,
		...(sessionId ? { session_id: sessionId } : {}),
	};
}
