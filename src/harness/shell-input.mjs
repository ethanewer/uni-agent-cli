// Host-owned shell input support. A leading `!` is a TUI gesture, not an ACP
// command, so every harness gets the same execution, output-safety, and prompt
// semantics. Harnesses only receive the normalized result when the user has not
// disabled the follow-up response.

import path from "node:path";

export const SHELL_INPUT_MAX_STDOUT_BYTES = 512 * 1024;
export const SHELL_INPUT_MAX_STDERR_BYTES = 256 * 1024;
export const SHELL_INPUT_TIMEOUT_MS = 10 * 60 * 1_000;

export function parseShellInput(value) {
	const text = String(value ?? "");
	if (!text.startsWith("!")) return undefined;
	return text.slice(1).trim();
}

export function shellInvocation(command, options = {}) {
	if (typeof command !== "string" || !command || command.includes("\0")) {
		throw new Error("shell input requires a command without NUL bytes");
	}
	const platform = options.platform ?? process.platform;
	const environment = options.environment ?? process.env;
	if (platform === "win32") {
		const executable = environment.ComSpec || environment.COMSPEC || "C:\\Windows\\System32\\cmd.exe";
		return { command: executable, args: ["/d", "/s", "/c", command] };
	}
	const configured = String(environment.SHELL ?? "").trim();
	const executable = configured && path.isAbsolute(configured) ? configured : "/bin/sh";
	return { command: executable, args: ["-lc", command] };
}

export function sanitizeShellOutput(value) {
	return String(value ?? "")
		// OSC strings (including hyperlinks and clipboard writes).
		.replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, "")
		// CSI, DCS/SOS/PM/APC, and ordinary two-byte escape sequences.
		.replace(/\u001bP[\s\S]*?\u001b\\/gu, "")
		.replace(/\u001b[\[\()][0-?]*[ -/]*[@-~]/gu, "")
		.replace(/\u001b[@-_]/gu, "")
		// Preserve newlines and tabs, but never let command output inject terminal
		// controls into the transcript renderer.
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
		.replace(/\r\n?/gu, "\n");
}

function decoded(buffer) {
	if (buffer === undefined || buffer === null) return "";
	return sanitizeShellOutput(Buffer.isBuffer(buffer) ? buffer.toString("utf8") : buffer);
}

export function normalizeShellResult(command, result = {}) {
	return {
		command,
		code: Number.isInteger(result.code) ? result.code : null,
		signal: result.signal ? String(result.signal) : undefined,
		stdout: decoded(result.stdout).trimEnd(),
		stderr: decoded(result.stderr).trimEnd(),
		stdoutTruncated: result.stdoutTruncated === true,
		stderrTruncated: result.stderrTruncated === true,
	};
}

function longestBacktickRun(value) {
	let longest = 0;
	for (const match of String(value).matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
	return longest;
}

function fencedText(value) {
	const text = String(value ?? "") || "(no output)";
	const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
	return `${fence}text\n${text}\n${fence}`;
}

function statusLine(result) {
	const status = result.signal ? `signal ${result.signal}` : `exit ${result.code ?? "unknown"}`;
	const omitted = [
		result.stdoutTruncated ? "stdout truncated" : undefined,
		result.stderrTruncated ? "stderr truncated" : undefined,
	].filter(Boolean);
	return omitted.length > 0 ? `${status} · ${omitted.join(" · ")}` : status;
}

export function formatShellTranscript(result) {
	const sections = [`!${result.command}`, "", statusLine(result)];
	if (result.stdout) sections.push("", "stdout", fencedText(result.stdout));
	if (result.stderr) sections.push("", "stderr", fencedText(result.stderr));
	if (!result.stdout && !result.stderr) sections.push("", fencedText("(no output)"));
	return sections.join("\n");
}

export function formatShellFollowup(result) {
	const sections = formatShellContextSections(result);
	sections.push("Respond to the command result. Be concise unless the output calls for explanation or action.");
	return sections.join("\n\n");
}

function formatShellContextSections(result) {
	const sections = [
		"The user directly ran a local shell command from the cc composer.",
		`Command: ${JSON.stringify(result.command)}`,
		`Result: ${statusLine(result)}`,
	];
	if (result.stdout) sections.push(`stdout:\n${result.stdout}`);
	if (result.stderr) sections.push(`stderr:\n${result.stderr}`);
	if (!result.stdout && !result.stderr) sections.push("The command produced no output.");
	return sections;
}

export function formatShellContext(result) {
	return formatShellContextSections(result).join("\n\n");
}
