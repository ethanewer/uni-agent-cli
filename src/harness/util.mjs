// Small pure helpers, copied faithfully from pi-harness.mjs so the adapter layer
// can re-home the per-harness native-settings translation without importing
// non-exported internals. tests/harness_adapter.test.mjs asserts that the
// adapters' buildLaunchSpec output is byte-identical to the production
// applyHarnessSettings, so any drift in these copies is caught.

export function stringArray(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string");
}

export function isPlainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function clonePlain(value) {
	return JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, override) {
	if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
	const merged = { ...base };
	for (const [key, value] of Object.entries(override)) {
		merged[key] = deepMerge(base?.[key], value);
	}
	return merged;
}

export function tomlKey(key) {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function tomlValue(value) {
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
	if (value === null) return "null";
	if (isPlainObject(value)) {
		const entries = Object.entries(value).map(([key, entry]) => `${tomlKey(key)} = ${tomlValue(entry)}`);
		return `{ ${entries.join(", ")} }`;
	}
	return JSON.stringify(value);
}

export function insertArgsBefore(baseArgs, marker, inserted) {
	const index = baseArgs.indexOf(marker);
	if (index === -1) return [...baseArgs, ...inserted];
	return [...baseArgs.slice(0, index), ...inserted, ...baseArgs.slice(index)];
}
