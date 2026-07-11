const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function threadError(message, code) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function canonicalUuid(value, label) {
	if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
		throw threadError(`${label} must be a canonical UUID`, "CODEX_INVALID_THREAD_ID");
	}
	return value.toLowerCase();
}

export function codexPersistentForkParams(threadId, lastTurnId = undefined) {
	const params = { threadId: canonicalUuid(threadId, "Codex thread ID"), ephemeral: false };
	if (lastTurnId !== undefined && lastTurnId !== null && String(lastTurnId).trim()) {
		params.lastTurnId = canonicalUuid(String(lastTurnId).trim(), "Codex turn ID");
	}
	return params;
}

export function codexPersistentForkSession(response, parentThreadId) {
	const parent = canonicalUuid(parentThreadId, "Parent Codex thread ID");
	const thread = response?.thread;
	if (!thread || typeof thread !== "object") {
		throw threadError("Codex thread/fork returned an invalid response", "CODEX_INVALID_FORK_RESPONSE");
	}
	const sessionId = canonicalUuid(thread.id, "Forked Codex thread ID");
	if (sessionId === parent) {
		throw threadError("Codex thread/fork reused the parent thread ID", "CODEX_INVALID_FORK_RESPONSE");
	}
	if (thread.ephemeral !== false) {
		throw threadError("Codex thread/fork did not confirm a persistent thread", "CODEX_INVALID_FORK_RESPONSE");
	}
	if (thread.forkedFromId !== undefined && thread.forkedFromId !== null) {
		const recordedParent = canonicalUuid(thread.forkedFromId, "Fork parent Codex thread ID");
		if (recordedParent !== parent) {
			throw threadError("Codex thread/fork returned mismatched parent metadata", "CODEX_INVALID_FORK_RESPONSE");
		}
	}
	return {
		sessionId,
		title: typeof thread.name === "string" && thread.name.trim()
			? thread.name
			: typeof thread.preview === "string"
				? thread.preview
				: "Forked session",
		cwd: typeof response.cwd === "string" ? response.cwd : thread.cwd,
		thread,
	};
}
