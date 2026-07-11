const MAX_LAYERS = 64;
const MAX_ENTRIES = 128;
const MAX_TEXT = 512;

const SAFE_REQUIREMENT_KEYS = new Set([
	"allowedApprovalPolicies",
	"allowedApprovalsReviewers",
	"allowedSandboxModes",
	"allowedWindowsSandboxImplementations",
	"allowedPermissionProfiles",
	"defaultPermissions",
	"allowedWebSearchModes",
	"allowManagedHooksOnly",
	"allowAppshots",
	"allowRemoteControl",
	"computerUse",
	"featureRequirements",
	"enforceResidency",
	"models",
	"hooks",
	"network",
]);

function cleanText(value, fallback = "<unknown>") {
	const cleaned = String(value ?? "")
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return fallback;
	return cleaned.length > MAX_TEXT ? `${cleaned.slice(0, MAX_TEXT - 1)}…` : cleaned;
}

function layerSource(source) {
	if (!source || typeof source !== "object") return "unknown layer";
	const type = cleanText(source.type, "unknown");
	if (type === "system") return `system (${cleanText(source.file)})`;
	if (type === "user") {
		const profile = typeof source.profile === "string" && source.profile
			? `, profile ${cleanText(source.profile)}`
			: "";
		return `user (${cleanText(source.file)}${profile})`;
	}
	if (type === "project") return `project (${cleanText(source.dotCodexFolder)})`;
	if (type === "mdm") return `MDM (${cleanText(source.domain)} / ${cleanText(source.key)})`;
	if (type === "enterpriseManaged") return `enterprise managed (${cleanText(source.name ?? source.id)})`;
	if (type === "sessionFlags") return "session flags";
	if (type === "legacyManagedConfigTomlFromFile") return `legacy managed file (${cleanText(source.file)})`;
	if (type === "legacyManagedConfigTomlFromMdm") return "legacy managed MDM";
	return type;
}

function safeRequirementValue(value, depth = 0) {
	if (value === null || value === undefined) return undefined;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") return cleanText(value);
	if (depth >= 3) return "<configured>";
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ENTRIES).map((entry) => safeRequirementValue(entry, depth + 1) ?? "null").join(", ") || "<empty>";
	}
	if (typeof value === "object") {
		const entries = Object.entries(value).slice(0, MAX_ENTRIES);
		if (entries.length === 0) return "<empty>";
		return entries.map(([key, entry]) => `${cleanText(key)}=${safeRequirementValue(entry, depth + 1) ?? "null"}`).join(", ");
	}
	return "<configured>";
}

function managedHookCount(value) {
	const handlers = value?.handlers;
	if (Array.isArray(handlers)) return handlers.length;
	if (!handlers || typeof handlers !== "object") return undefined;
	let count = 0;
	for (const entry of Object.values(handlers).slice(0, MAX_ENTRIES)) {
		if (Array.isArray(entry)) count += entry.length;
		else if (entry && typeof entry === "object") count += Object.keys(entry).length;
		else if (entry !== null && entry !== undefined) count += 1;
	}
	return count;
}

function safeManagedHooks(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "<configured>";
	const parts = [];
	if (typeof value.managedDir === "string") parts.push(`managedDir=${cleanText(value.managedDir)}`);
	if (typeof value.windowsManagedDir === "string") parts.push(`windowsManagedDir=${cleanText(value.windowsManagedDir)}`);
	const count = managedHookCount(value);
	if (Number.isFinite(count)) parts.push(`handlers=${count}`);
	return parts.join(", ") || "<configured>";
}

function safePermissionEntries(value) {
	const entries = value?.entries && typeof value.entries === "object" ? value.entries : value;
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return undefined;
	const parts = [];
	for (const [name, permission] of Object.entries(entries).slice(0, MAX_ENTRIES)) {
		if (!["allow", "deny"].includes(permission)) continue;
		parts.push(`${cleanText(name)}=${permission}`);
	}
	return parts.length > 0 ? `{${parts.join(", ")}}` : undefined;
}

function safeNetworkRequirements(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return "<configured>";
	const scalarKeys = [
		"enabled",
		"httpPort",
		"socksPort",
		"allowUpstreamProxy",
		"dangerouslyAllowNonLoopbackProxy",
		"dangerouslyAllowAllUnixSockets",
		"managedAllowedDomainsOnly",
		"allowLocalBinding",
		"dangerFullAccessDenylistOnly",
	];
	const parts = [];
	for (const key of scalarKeys) {
		if (typeof value[key] === "boolean" || typeof value[key] === "number") parts.push(`${key}=${value[key]}`);
	}
	const domains = safePermissionEntries(value.domains);
	if (domains) parts.push(`domains=${domains}`);
	const sockets = safePermissionEntries(value.unixSockets);
	if (sockets) parts.push(`unixSockets=${sockets}`);
	return parts.join(", ") || "<configured>";
}

function requirementValue(key, value) {
	if (key === "hooks") return safeManagedHooks(value);
	if (key === "network") return safeNetworkRequirements(value);
	return safeRequirementValue(value);
}

export function formatCodexDebugConfig(configRead, requirementsRead) {
	if (!configRead || typeof configRead !== "object") {
		throw new Error("Codex config/read returned an invalid response");
	}
	const layers = Array.isArray(configRead.layers) ? configRead.layers.slice(0, MAX_LAYERS) : [];
	const lines = ["Codex configuration", "", "Config layer stack (lowest precedence first):"];
	if (layers.length === 0) {
		lines.push("  <none reported>");
	} else {
		layers.forEach((layer, index) => {
			const disabled = typeof layer?.disabledReason === "string" && layer.disabledReason.trim();
			lines.push(`  ${index + 1}. ${layerSource(layer?.name)} (${disabled ? "disabled" : "enabled"})`);
			if (disabled) lines.push("     reason: reported by Codex (details omitted)");
		});
		if (Array.isArray(configRead.layers) && configRead.layers.length > layers.length) {
			lines.push(`  … ${configRead.layers.length - layers.length} more layers omitted`);
		}
	}

	lines.push("", "Managed requirements:");
	const requirements = requirementsRead?.requirements;
	const entries = requirements && typeof requirements === "object"
		? Object.entries(requirements).filter(([key, value]) => SAFE_REQUIREMENT_KEYS.has(key) && value !== null && value !== undefined)
		: [];
	if (entries.length === 0) {
		lines.push("  <none>");
	} else {
		for (const [key, value] of entries.slice(0, MAX_ENTRIES)) {
			lines.push(`  - ${key}: ${requirementValue(key, value)}`);
		}
	}
	lines.push("", "Layer contents and effective config values are intentionally omitted so credentials are never printed.");
	return lines.join("\n");
}
