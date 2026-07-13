// Harness-layer runtime primitives shared by adapters and the ACP transport.
// This module deliberately has no dependency on the TUI.

export function cursorCancelResult(method) {
	if (method === "cursor/create_plan") return { outcome: { outcome: "rejected", reason: "Cancelled" } };
	if (method === "cursor/ask_question") return { outcome: { outcome: "cancelled" } };
	return {};
}

export function cursorActionName(params = {}) {
	return params.name ?? params.title ?? params.overview ?? params.prompt;
}

export function autoCursorOutcome(method, params = {}) {
	if (method === "cursor/create_plan") return { outcome: { outcome: "accepted" } };
	if (method === "cursor/ask_question") {
		const answers = (Array.isArray(params.questions) ? params.questions : []).map((question) => ({
			questionId: question.id,
			selectedOptionIds: question.options?.[0]?.id ? [question.options[0].id] : [],
		}));
		return { outcome: { outcome: "answered", answers } };
	}
	return {};
}

export function mergeEnvironments(sources, platform = process.platform) {
	const result = {};
	const canonicalNames = new Map();
	for (const source of Array.isArray(sources) ? sources : [sources]) {
		if (!source || typeof source !== "object") continue;
		for (const [name, value] of Object.entries(source)) {
			if (platform === "win32") {
				const canonical = name.toLowerCase();
				const previous = canonicalNames.get(canonical);
				if (previous && previous !== name) delete result[previous];
				canonicalNames.set(canonical, name);
			}
			result[name] = value;
		}
	}
	return result;
}

// A replacement may continue after a confirmed force-kill, but never after an
// unconfirmed process-tree shutdown. Injected test connections may retain the
// original synchronous stop() contract.
export async function stopConnectionsForReplacement(connections, options = {}) {
	const unique = [...new Set((Array.isArray(connections) ? connections : [connections]).filter(Boolean))];
	const results = await Promise.allSettled(unique.map(async (connection) => {
		if (typeof connection.stopAndWait !== "function") {
			connection.stop?.();
			return;
		}
		try {
			await connection.stopAndWait(options.timeoutMs);
		} catch (error) {
			if (error?.code === "PROCESS_TREE_FORCE_KILLED") return;
			throw error;
		}
	}));
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw failure.reason;
}
