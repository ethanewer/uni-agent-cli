const ITEM_TYPES = new Set([
	"AGENTS_MD",
	"CONFIG",
	"SKILLS",
	"PLUGINS",
	"MCP_SERVER_CONFIG",
	"SUBAGENTS",
	"HOOKS",
	"COMMANDS",
	"SESSIONS",
]);
const MAX_ITEMS = 128;
const MAX_DETAILS_PER_KIND = 512;
const MAX_TEXT = 4096;

function importError(message) {
	const error = new Error(message);
	error.code = "CODEX_INVALID_IMPORT_RESPONSE";
	return error;
}

function checkedText(value, field, options = {}) {
	if (typeof value !== "string" || value.includes("\0") || value.length > (options.max ?? MAX_TEXT)) {
		throw importError(`Codex import returned an invalid ${field}`);
	}
	if (options.nonempty && !value.trim()) throw importError(`Codex import returned an empty ${field}`);
	return value;
}

function displayText(value) {
	return String(value ?? "")
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function checkedNamedEntries(value, field) {
	if (!Array.isArray(value) || value.length > MAX_DETAILS_PER_KIND) {
		throw importError(`Codex import returned invalid ${field} details`);
	}
	return value.map((entry) => ({ name: checkedText(entry?.name, `${field} name`, { nonempty: true }) }));
}

function normalizeDetails(value) {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) throw importError("Codex import returned invalid migration details");
	const plugins = value.plugins;
	if (!Array.isArray(plugins) || plugins.length > MAX_DETAILS_PER_KIND) {
		throw importError("Codex import returned invalid plugin details");
	}
	const sessions = value.sessions;
	if (!Array.isArray(sessions) || sessions.length > MAX_DETAILS_PER_KIND) {
		throw importError("Codex import returned invalid session details");
	}
	return {
		plugins: plugins.map((entry) => {
			if (!Array.isArray(entry?.pluginNames) || entry.pluginNames.length > MAX_DETAILS_PER_KIND) {
				throw importError("Codex import returned invalid plugin names");
			}
			return {
				marketplaceName: checkedText(entry.marketplaceName, "marketplace name", { nonempty: true }),
				pluginNames: entry.pluginNames.map((name) => checkedText(name, "plugin name", { nonempty: true })),
			};
		}),
		skills: checkedNamedEntries(value.skills, "skill"),
		sessions: sessions.map((entry) => ({
			path: checkedText(entry?.path, "session path", { nonempty: true }),
			cwd: checkedText(entry?.cwd, "session working directory", { nonempty: true }),
			...(entry?.title === null || entry?.title === undefined
				? { title: null }
				: { title: checkedText(entry.title, "session title") }),
		})),
		mcpServers: checkedNamedEntries(value.mcpServers, "MCP server"),
		hooks: checkedNamedEntries(value.hooks, "hook"),
		subagents: checkedNamedEntries(value.subagents, "subagent"),
		commands: checkedNamedEntries(value.commands, "command"),
	};
}

export function normalizeCodexImportDetection(response) {
	if (!response || typeof response !== "object" || !Array.isArray(response.items) || response.items.length > MAX_ITEMS) {
		throw importError("Codex externalAgentConfig/detect returned an invalid response");
	}
	return response.items.map((item) => {
		if (!item || typeof item !== "object" || !ITEM_TYPES.has(item.itemType)) {
			throw importError("Codex import returned an unknown migration item type");
		}
		return {
			itemType: item.itemType,
			description: checkedText(item.description, "migration description", { nonempty: true }),
			cwd: item.cwd === null || item.cwd === undefined || item.cwd === ""
				? null
				: checkedText(item.cwd, "migration working directory", { nonempty: true }),
			details: normalizeDetails(item.details),
		};
	});
}

export function codexImportItemCount(item) {
	const details = item?.details;
	if (!details) return 1;
	const counts = [
		details.plugins?.reduce((sum, plugin) => sum + (plugin.pluginNames?.length ?? 0), 0),
		details.skills?.length,
		details.sessions?.length,
		details.mcpServers?.length,
		details.hooks?.length,
		details.subagents?.length,
		details.commands?.length,
	].filter((value) => Number.isFinite(value));
	return Math.max(1, counts.reduce((sum, value) => sum + value, 0));
}

export function codexImportItemLabel(item) {
	const names = {
		AGENTS_MD: "AGENTS.md",
		CONFIG: "configuration",
		SKILLS: "skills",
		PLUGINS: "plugins",
		MCP_SERVER_CONFIG: "MCP servers",
		SUBAGENTS: "subagents",
		HOOKS: "hooks",
		COMMANDS: "commands",
		SESSIONS: "sessions",
	};
	const scope = item?.cwd ? item.cwd : "home";
	return `${names[item?.itemType] ?? item?.itemType ?? "item"} · ${scope} · ${codexImportItemCount(item)} item${codexImportItemCount(item) === 1 ? "" : "s"}`;
}

export function codexImportCompletionMatches(params, responses) {
	const importId = responses?.at?.(-1)?.importId;
	return typeof importId === "string" && importId.length > 0 && params?.importId === importId;
}

export function formatCodexImportCompletion(notification) {
	if (!notification || typeof notification !== "object" || !Array.isArray(notification.itemTypeResults)) {
		return "Claude Code import completed, but result details were unavailable.";
	}
	let successes = 0;
	let failures = 0;
	const failureLines = [];
	let detailsOmitted = false;
	for (const result of notification.itemTypeResults.slice(0, MAX_ITEMS)) {
		if (!ITEM_TYPES.has(result?.itemType) || !Array.isArray(result.successes) || !Array.isArray(result.failures)) {
			detailsOmitted = true;
			continue;
		}
		successes += result.successes.length;
		failures += result.failures.length;
		for (const failure of result.failures.slice(0, 10)) {
			// Importer failures can embed TOML source snippets containing API keys,
			// tokens, or authenticated URLs. Report the bounded stage/type only; the
			// raw server message must never enter the transcript.
			const stage = displayText(failure?.failureStage ?? failure?.errorType).slice(0, 160);
			failureLines.push(`  - ${result.itemType}: failed${stage ? ` during ${stage}` : ""}`);
		}
	}
	const lines = [`Claude Code import finished: ${successes} succeeded, ${failures} failed.`];
	if (failureLines.length > 0) lines.push(...failureLines);
	if (failures > failureLines.length) lines.push(`  … ${failures - failureLines.length} more failures omitted`);
	if (detailsOmitted || notification.itemTypeResults.length > MAX_ITEMS) lines.push("  Some result details were omitted.");
	return lines.join("\n");
}
