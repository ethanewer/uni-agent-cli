// The single unified interface between cc and every harness.
//
// cc interacts with a harness ONLY through a HarnessAdapter instance and the
// declared `capabilities` descriptor. Every feature is optional: a capability a
// harness does not advertise simply stays dark, and cc degrades gracefully.
//
// This module defines the contract (method names + capability shape), a runtime
// conformance checker, and the wire -> capability derivation. It has no
// dependency on any specific harness.

/** Capability keys. Every one is optional; defaults are "off". */
export const CAPABILITY_KEYS = [
	"fork", // false | "native" | "copy"
	"resume", // bool — session/load or session/resume
	"sessionList", // bool — session/list
	"delete", // bool — session/delete
	"models", // bool — a "model" config option is advertised
	"modes", // bool — modes or a "mode" config option is advertised
	"reasoningEffort", // bool — a "thought_level" config option is advertised
	"image", // bool — promptCapabilities.image
	"retractPrompt", // bool — supports unsend (retract the just-sent prompt)
	"commandPresets", // string[] — local preset dialogs the adapter provides
	"interactiveRequests", // bool — backend-initiated prompts (ask_question, …)
	"autoApprove", // bool — auto-accept permission requests (from native settings)
	"terminal", // bool — shared terminal execution (cc is the executor)
	"mcp", // bool — MCP servers
	"audio", // bool — audio prompt parts (future)
	"embeddedContext", // bool — @file embedded context
	"auth", // bool — one or more ACP authentication methods advertised
	"logout", // bool — agentCapabilities.auth.logout advertised
];

/** A fresh, all-off capability descriptor. */
export function emptyCapabilities() {
	return {
		fork: false,
		resume: false,
		sessionList: false,
		delete: false,
		models: false,
		modes: false,
		reasoningEffort: false,
		image: false,
		retractPrompt: false,
		commandPresets: [],
		interactiveRequests: false,
		autoApprove: false,
		terminal: true, // cc always advertises terminal:true and executes terminal/*
		mcp: false,
		audio: false,
		embeddedContext: false,
		auth: false,
		logout: false,
	};
}

/** Methods every adapter must implement. */
export const REQUIRED_METHODS = [
	"buildLaunchSpec",
	"connect",
	"newSession",
	"prompt",
	"cancel",
	"stop",
	"getSessionInfo",
];

/** Methods an adapter implements only if it advertises the matching capability. */
export const OPTIONAL_METHODS = [
	"listSessions", // resume / sessionList
	"loadSession", // resume
	"deleteSession", // delete
	"fork", // fork
	"setConfigOption", // models / modes / reasoningEffort
	"setMode", // modes
	"snapshotRetractionState", // retractPrompt
	"canRetract", // retractPrompt
	"interceptCommand", // commandPresets
	"handleExtensionRequest", // interactiveRequests
	"authenticate", // auth
	"logout", // logout
];

/** The set of normalized UI event types an adapter may emit to host.onEvent. */
export const EVENT_TYPES = [
	"text",
	"user_text",
	"commands",
	"tool",
	"tool_update",
	"line",
	"session_info",
	"backend_activity",
	"backend_exit",
	"error",
	"cursor_todos",
];

/**
 * Validate that an object conforms to the HarnessAdapter contract. Returns
 * { ok, problems } rather than throwing so callers can report all problems.
 * The capability-gating invariant is enforced: if a capability is set, the
 * methods that implement it must exist.
 */
export function checkAdapterConformance(adapter) {
	const problems = [];
	if (!adapter || typeof adapter !== "object") {
		return { ok: false, problems: ["adapter is not an object"] };
	}
	if (typeof adapter.key !== "string" || !adapter.key) problems.push("missing string `key`");
	if (typeof adapter.label !== "string" || !adapter.label) problems.push("missing string `label`");

	for (const method of REQUIRED_METHODS) {
		if (typeof adapter[method] !== "function") problems.push(`missing required method ${method}()`);
	}

	const caps = adapter.capabilities;
	if (!caps || typeof caps !== "object") {
		problems.push("missing `capabilities` descriptor");
	} else {
		for (const key of Object.keys(caps)) {
			if (!CAPABILITY_KEYS.includes(key)) problems.push(`unknown capability key: ${key}`);
		}
		if (caps.fork !== false && caps.fork !== "native" && caps.fork !== "copy") {
			problems.push("`fork` must be false | 'native' | 'copy'");
		}
		if (!Array.isArray(caps.commandPresets)) problems.push("`commandPresets` must be an array");

		// Capability -> required method invariants.
		if (caps.fork && typeof adapter.fork !== "function") problems.push("capability fork set but fork() missing");
		if (caps.resume && typeof adapter.loadSession !== "function") problems.push("capability resume set but loadSession() missing");
		if (caps.sessionList && typeof adapter.listSessions !== "function") problems.push("capability sessionList set but listSessions() missing");
		if (caps.delete && typeof adapter.deleteSession !== "function") problems.push("capability delete set but deleteSession() missing");
		if ((caps.models || caps.modes || caps.reasoningEffort) && typeof adapter.setConfigOption !== "function") {
			problems.push("config capability set but setConfigOption() missing");
		}
		if (caps.retractPrompt && (typeof adapter.snapshotRetractionState !== "function" || typeof adapter.canRetract !== "function")) {
			problems.push("capability retractPrompt set but snapshot/canRetract missing");
		}
		if (Array.isArray(caps.commandPresets) && caps.commandPresets.length > 0 && typeof adapter.interceptCommand !== "function") {
			problems.push("commandPresets declared but interceptCommand() missing");
		}
		if (caps.interactiveRequests && typeof adapter.handleExtensionRequest !== "function") {
			problems.push("capability interactiveRequests set but handleExtensionRequest() missing");
		}
		if (caps.auth && typeof adapter.authenticate !== "function") {
			problems.push("capability auth set but authenticate() missing");
		}
		if (caps.logout && typeof adapter.logout !== "function") {
			problems.push("capability logout set but logout() missing");
		}
	}

	return { ok: problems.length === 0, problems };
}

/** Throwing variant of checkAdapterConformance. */
export function assertAdapterConformance(adapter) {
	const { ok, problems } = checkAdapterConformance(adapter);
	if (!ok) throw new Error(`adapter "${adapter?.key ?? "?"}" does not conform: ${problems.join("; ")}`);
	return true;
}

/**
 * Derive the wire-sourced capabilities from an ACP initialize response +
 * session state. The adapter merges these over its declared (static) caps.
 * `sessionInfo` is the object returned by AcpConnection.getSessionInfo().
 */
export function capabilitiesFromWire(sessionInfo = {}) {
	const acp = sessionInfo.capabilities ?? {};
	const sessionCaps = acp.sessionCapabilities ?? {};
	const configOptions = Array.isArray(sessionInfo.configOptions) ? sessionInfo.configOptions : [];
	const categories = new Set(configOptions.map((option) => option?.category ?? option?.id).filter(Boolean));
	const modeCount =
		(sessionInfo.modes?.availableModes?.length ?? 0) || (categories.has("mode") ? 1 : 0);

	const resume = Boolean(acp.loadSession || sessionCaps.resume);
	return {
		fork: sessionCaps.fork ? "native" : false,
		resume,
		// Matches pi-harness supportsSessionList: list AND a way to load/resume.
		sessionList: Boolean(sessionCaps.list) && resume,
		delete: Boolean(sessionCaps.delete),
		models: categories.has("model") || Boolean(sessionInfo.models),
		modes: modeCount > 0,
		reasoningEffort: categories.has("thought_level"),
		image: acp.promptCapabilities?.image === true,
		// Stdio MCP is the ACP v1 baseline; mcpCapabilities only negotiates optional
		// transports such as HTTP/SSE. It may be omitted entirely by a compliant
		// agent, and an all-false descriptor still supports stdio.
		mcp: true,
		audio: acp.promptCapabilities?.audio === true,
		embeddedContext: acp.promptCapabilities?.embeddedContext === true,
		auth: Array.isArray(sessionInfo.authMethods) && sessionInfo.authMethods.length > 0,
		logout: Boolean(acp.auth?.logout),
	};
}
