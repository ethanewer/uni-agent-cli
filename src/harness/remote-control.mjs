// Harness-neutral Remote Control extension. ACP has no equivalent yet, so a
// capable per-harness bridge negotiates this narrow existing-session toggle.
// It never starts Claude's separate server mode.

export const REMOTE_CONTROL_META_KEY = "remoteControl";
export const REMOTE_CONTROL_METHOD = "cc/session/remote_control";
export const REMOTE_CONTROL_NAME_MAX_CHARS = 200;
export const REMOTE_CONTROL_NAME_MAX_BYTES = 512;
export const REMOTE_CONTROL_URL_MAX_BYTES = 4_096;
export const REMOTE_CONTROL_STATUS_MAX_CHARS = 120;

export function parseRemoteControlCommand(argument = "") {
	const value = String(argument ?? "").trim();
	if (!value) return { enabled: true };
	if (value.toLowerCase() === "off") return { enabled: false };
	return { enabled: true, name: safeName(value) };
}

export function parseRemoteControlParams(value) {
	if (!isRecord(value)) throw new Error("remote_control params must be an object");
	const sessionId = safeId(value.sessionId, "sessionId");
	if (typeof value.enabled !== "boolean") throw new Error("remote_control enabled must be boolean");
	if (!value.enabled && value.name !== undefined) throw new Error("remote_control off does not accept a name");
	if (value.enabled && value.name !== undefined) {
		return { sessionId, enabled: true, name: safeName(value.name) };
	}
	return { sessionId, enabled: value.enabled };
}

/** Validate the public SDK response before it crosses the bridge. */
export function normalizeClaudeRemoteControlResponse(value, enabled) {
	if (!enabled) return { enabled: false, status: "disconnected" };
	if (!isRecord(value)) throw new Error("Remote Control returned an invalid response");
	// SDK 0.3.205 returns `sessionUrl`; retain `url` as a forward-compatible
	// spelling while keeping the normalized interface stable.
	const url = safeRemoteUrl(value.sessionUrl ?? value.url);
	return { enabled: true, status: "available", url };
}

export function normalizeRemoteControlResponse(value) {
	if (!isRecord(value) || typeof value.enabled !== "boolean") {
		throw new Error("remote_control returned an invalid response");
	}
	const expectedStatus = value.enabled ? "available" : "disconnected";
	if (value.status !== expectedStatus || value.status.length > REMOTE_CONTROL_STATUS_MAX_CHARS) {
		throw new Error("remote_control returned an invalid status");
	}
	if (value.enabled) return { enabled: true, status: expectedStatus, url: safeRemoteUrl(value.url) };
	if (value.url !== undefined) throw new Error("remote_control returned a URL while disabled");
	return { enabled: false, status: expectedStatus };
}

export function formatRemoteControlResult(value) {
	const result = normalizeRemoteControlResponse(value);
	return result.enabled
		? `Remote Control enabled\n${result.url}`
		: "Remote Control disconnected for this session";
}

function safeName(value) {
	if (typeof value !== "string") throw new Error("Remote Control name must be text");
	const name = value.trim();
	if (name.startsWith("-")) {
		throw new Error("Remote Control flags are not supported; use /remote-control [name|off]");
	}
	if (
		!name ||
		[...name].length > REMOTE_CONTROL_NAME_MAX_CHARS ||
		Buffer.byteLength(name, "utf8") > REMOTE_CONTROL_NAME_MAX_BYTES ||
		hasUnsafeText(name)
	) {
		throw new Error(
			`Remote Control name must be 1-${REMOTE_CONTROL_NAME_MAX_CHARS} safe characters ` +
			`and at most ${REMOTE_CONTROL_NAME_MAX_BYTES} bytes`,
		);
	}
	return name;
}

function safeRemoteUrl(value) {
	if (
		typeof value !== "string" ||
		!value ||
		Buffer.byteLength(value, "utf8") > REMOTE_CONTROL_URL_MAX_BYTES ||
		hasUnsafeText(value)
	) throw new Error("Remote Control returned an invalid session URL");
	let parsed;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error("Remote Control returned an invalid session URL");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.hostname !== "claude.ai" ||
		!/^\/code(?:\/|$)/u.test(parsed.pathname) ||
		parsed.username ||
		parsed.password
	) throw new Error("Remote Control returned an untrusted session URL");
	return parsed.href;
}

function safeId(value, field) {
	if (typeof value !== "string") throw new Error(`${field} must be a non-empty safe string`);
	const id = value.trim();
	if (!id || [...id].length > 512 || hasUnsafeText(id)) {
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
