import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cc owns this namespace. The method is intentionally narrow: it changes the
// cwd of one already-open ACP session and cannot launch commands or address a
// different session.
export const CHANGE_WORKING_DIRECTORY_METHOD = "cc/session/change_cwd";
export const CHANGE_WORKING_DIRECTORY_META_KEY = "changeWorkingDirectory";
export const WORKING_DIRECTORY_PATH_MAX_CHARS = 32_768;
export const WORKING_DIRECTORY_MESSAGE_MAX_CHARS = 2_048;
export const WORKING_DIRECTORY_COMPLETION_LIMIT = 200;

const REJECTION_REASONS = new Set([
	"not_found",
	"not_a_directory",
	"blocked_by_rule",
	"busy",
	"unsafe_path",
]);

/** Strict parser used at the custom ACP boundary. */
export function parseChangeWorkingDirectoryParams(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("change_cwd params must be an object");
	}
	const sessionId = typeof value.sessionId === "string" ? value.sessionId.trim() : "";
	const target = typeof value.path === "string" ? value.path.trim() : "";
	if (!sessionId || sessionId.length > 512 || containsUnsafeProtocolText(sessionId)) {
		throw new Error("change_cwd requires a valid sessionId");
	}
	if (
		!target ||
		target.length > WORKING_DIRECTORY_PATH_MAX_CHARS ||
		containsUnsafeProtocolText(target) ||
		!path.isAbsolute(target)
	) {
		throw new Error("change_cwd requires an absolute path without control characters");
	}
	if (value.trustAccepted !== undefined && typeof value.trustAccepted !== "boolean") {
		throw new Error("trustAccepted must be boolean");
	}
	if (value.trustedDirectory !== undefined) {
		if (
			typeof value.trustedDirectory !== "string" ||
			!value.trustedDirectory ||
			value.trustedDirectory.length > WORKING_DIRECTORY_PATH_MAX_CHARS ||
			containsUnsafeProtocolText(value.trustedDirectory) ||
			!path.isAbsolute(value.trustedDirectory)
		) {
			throw new Error("trustedDirectory must be a safe absolute path");
		}
	}
	if (value.trustAccepted === true && !value.trustedDirectory) {
		throw new Error("trustAccepted requires trustedDirectory");
	}
	return {
		sessionId,
		path: path.resolve(target),
		...(value.trustAccepted !== undefined ? { trustAccepted: value.trustAccepted } : {}),
		...(value.trustedDirectory ? { trustedDirectory: value.trustedDirectory } : {}),
	};
}

/**
 * Validate and bound the SDK response before it crosses the ACP extension.
 * Claude's set_cwd response is a three-arm discriminated union. Rejecting an
 * unknown arm avoids accidentally treating a future error response as success.
 */
export function normalizeChangeWorkingDirectoryResponse(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("change_cwd returned an invalid response");
	}
	if (value.status === "ok") {
		const cwd = safeAbsoluteResponsePath(value.cwd, "cwd");
		if (typeof value.changed !== "boolean" || typeof value.transcript_relocated !== "boolean") {
			throw new Error("change_cwd returned an invalid success response");
		}
		return {
			status: "ok",
			cwd,
			changed: value.changed,
			transcript_relocated: value.transcript_relocated,
		};
	}
	if (value.status === "needs_trust") {
		return {
			status: "needs_trust",
			directory: safeAbsoluteResponsePath(value.directory, "directory"),
		};
	}
	if (value.status === "rejected") {
		if (!REJECTION_REASONS.has(value.reason)) {
			throw new Error("change_cwd returned an unknown rejection reason");
		}
		if (typeof value.message !== "string" || !value.message || containsUnsafeProtocolText(value.message)) {
			throw new Error("change_cwd returned an invalid rejection message");
		}
		return {
			status: "rejected",
			reason: value.reason,
			message: [...value.message].slice(0, WORKING_DIRECTORY_MESSAGE_MAX_CHARS).join(""),
		};
	}
	throw new Error("change_cwd returned an unknown response status");
}

/** Resolve a user-facing /cd argument and validate it before contacting ACP. */
export function resolveWorkingDirectoryTarget(argument, cwd = process.cwd()) {
	let value = String(argument ?? "").trim();
	if (!value) throw new Error("usage: /cd <path>");
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) value = value.slice(1, -1);
	if (!value || value.length > WORKING_DIRECTORY_PATH_MAX_CHARS || containsUnsafeProtocolText(value)) {
		throw new Error("The directory path is empty, too long, or contains control characters");
	}
	if (value === "~") value = os.homedir();
	else if (/^~[\\/]/u.test(value)) value = path.join(os.homedir(), value.slice(2));
	else if (value.startsWith("~")) throw new Error("Named home directories such as ~user are not supported");
	const absolute = path.resolve(cwd, value);
	let canonical;
	try {
		canonical = fs.realpathSync(absolute);
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error(`Directory not found: ${absolute}`);
		throw new Error(`Could not resolve directory ${absolute}: ${error.message ?? error}`);
	}
	let stat;
	try {
		stat = fs.statSync(canonical);
	} catch (error) {
		throw new Error(`Could not inspect directory ${canonical}: ${error.message ?? error}`);
	}
	if (!stat.isDirectory()) throw new Error(`Not a directory: ${canonical}`);
	return canonical;
}

/** Bounded, directory-only completions for `/cd <path>`. */
export function directoryCompletionMatches(prefix, cwd = process.cwd(), options = {}) {
	const limit = Math.max(1, Math.min(
		Number.isInteger(options.limit) ? options.limit : WORKING_DIRECTORY_COMPLETION_LIMIT,
		WORKING_DIRECTORY_COMPLETION_LIMIT,
	));
	let typed = String(prefix ?? "");
	const quoted = typed.startsWith('"');
	if (quoted) typed = typed.slice(1);
	if (typed.endsWith('"')) typed = typed.slice(0, -1);
	if (typed.length > WORKING_DIRECTORY_PATH_MAX_CHARS || containsUnsafeProtocolText(typed)) return [];

	const homePrefix = typed === "~" || /^~[\\/]/u.test(typed);
	if (typed.startsWith("~") && !homePrefix) return [];
	const expanded = typed === "~"
		? `${os.homedir()}${path.sep}`
		: homePrefix
			? `${path.join(os.homedir(), typed.slice(2))}${/[\\/]$/u.test(typed) ? path.sep : ""}`
			: typed;
	const separatorIndex = Math.max(expanded.lastIndexOf("/"), expanded.lastIndexOf("\\"));
	const expandedParent = separatorIndex >= 0 ? expanded.slice(0, separatorIndex + 1) : "";
	const leafPrefix = separatorIndex >= 0 ? expanded.slice(separatorIndex + 1) : expanded;
	const searchDirectory = path.resolve(cwd, expandedParent || ".");
	let entries;
	try {
		entries = fs.readdirSync(searchDirectory, { withFileTypes: true });
	} catch {
		return [];
	}
	const typedSeparatorIndex = Math.max(typed.lastIndexOf("/"), typed.lastIndexOf("\\"));
	// Expanding a bare `~` adds a separator solely for the filesystem lookup.
	// Keep that home shorthand in the inserted value instead of returning a
	// path that is accidentally relative to the current working directory.
	const typedParent = typed === "~"
		? `~${path.sep}`
		: typedSeparatorIndex >= 0
			? typed.slice(0, typedSeparatorIndex + 1)
			: "";
	const results = [];
	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.name.toLowerCase().startsWith(leafPrefix.toLowerCase())) continue;
		const candidate = path.join(searchDirectory, entry.name);
		let isDirectory = entry.isDirectory();
		if (!isDirectory && entry.isSymbolicLink()) {
			try { isDirectory = fs.statSync(candidate).isDirectory(); } catch {}
		}
		if (!isDirectory || containsUnsafeProtocolText(entry.name)) continue;
		const rawValue = `${typedParent}${entry.name}${path.sep}`;
		const needsQuote = quoted || /\s/u.test(rawValue);
		results.push({
			value: needsQuote ? `"${rawValue}"` : rawValue,
			label: `${entry.name}${path.sep}`,
			description: candidate,
		});
		if (results.length >= limit) break;
	}
	return results;
}

function safeAbsoluteResponsePath(value, field) {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > WORKING_DIRECTORY_PATH_MAX_CHARS ||
		containsUnsafeProtocolText(value) ||
		!path.isAbsolute(value)
	) throw new Error(`change_cwd returned an invalid ${field}`);
	return value;
}

function containsUnsafeProtocolText(value) {
	const text = String(value);
	return (
		/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u2800]/u.test(text) ||
		/\p{Default_Ignorable_Code_Point}/u.test(text) ||
		[...text].some((character) => character !== " " && /\p{Zs}/u.test(character))
	);
}
