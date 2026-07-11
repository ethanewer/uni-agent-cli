// Response-selection helpers for the shared `/copy` UI. Parsing is deliberately
// independent of any harness: the TUI owns rendered assistant responses and can
// offer the same full-response/code-block picker everywhere.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeShellOutput } from "./shell-input.mjs";

export const COPY_RESPONSE_MAX_CHOICES = 101;
export const COPY_WRITE_MAX_BYTES = 16 * 1024 * 1024;

export function copyResponseChoices(response) {
	const text = String(response ?? "").trim();
	if (!text) return [];
	const choices = [{
		kind: "full",
		label: "Full response",
		description: previewText(text),
		text,
	}];
	for (const [index, block] of fencedCodeBlocks(text).slice(0, COPY_RESPONSE_MAX_CHOICES - 1).entries()) {
		choices.push({
			kind: "code",
			label: `Code block ${index + 1}${block.language ? ` (${block.language})` : ""}`,
			description: previewText(block.text),
			text: block.text,
			language: block.language,
		});
	}
	return choices;
}

export function fencedCodeBlocks(value) {
	const lines = String(value ?? "").replace(/\r\n?/gu, "\n").split("\n");
	const blocks = [];
	let open;
	for (const line of lines) {
		if (!open) {
			const match = /^\s{0,3}(`{3,}|~{3,})([^`]*)$/u.exec(line);
			if (!match) continue;
			open = {
				character: match[1][0],
				length: match[1].length,
				language: normalizeLanguage(match[2]),
				lines: [],
			};
			continue;
		}
		const closePattern = open.character === "`" ? /^\s{0,3}(`{3,})\s*$/u : /^\s{0,3}(~{3,})\s*$/u;
		const close = closePattern.exec(line);
		if (close && close[1].length >= open.length) {
			blocks.push({ language: open.language, text: open.lines.join("\n") });
			open = undefined;
			continue;
		}
		open.lines.push(line);
	}
	return blocks;
}

export function resolveCopyWritePath(value, options = {}) {
	if (typeof value !== "string" || value.includes("\0")) throw new Error("A valid file path is required");
	const source = value.trim();
	if (!source) throw new Error("A file path is required");
	const homeDirectory = options.homeDirectory ?? os.homedir();
	const expanded = source === "~"
		? homeDirectory
		: source.startsWith(`~${path.sep}`) || source.startsWith("~/")
			? path.join(homeDirectory, source.slice(2))
			: source;
	return path.resolve(options.cwd ?? process.cwd(), expanded);
}

export function writeCopySelection(file, text, options = {}) {
	const content = String(text ?? "");
	if (Buffer.byteLength(content, "utf8") > COPY_WRITE_MAX_BYTES) {
		throw new Error(`Selection exceeds the ${COPY_WRITE_MAX_BYTES}-byte write limit`);
	}
	const destination = resolveCopyWritePath(file, options);
	fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
	if (options.overwrite === true) {
		writeAtomicReplacement(destination, content);
	} else {
		writeExclusive(destination, content);
	}
	return destination;
}

function writeExclusive(destination, content) {
	let descriptor;
	let created = false;
	let failure;
	try {
		descriptor = fs.openSync(destination, "wx", 0o600);
		created = true;
		fs.writeFileSync(descriptor, content, "utf8");
		fs.fsyncSync(descriptor);
	} catch (error) {
		failure = error;
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch (error) {
				failure ??= error;
			}
		}
	}
	if (failure) {
		if (created) {
			try {
				fs.rmSync(destination, { force: true });
			} catch {
				// Preserve the original write error. A best-effort cleanup is all that
				// is possible after a filesystem failure.
			}
		}
		throw failure;
	}
}

function writeAtomicReplacement(destination, content) {
	try {
		const metadata = fs.lstatSync(destination);
		if (!metadata.isFile() && !metadata.isSymbolicLink()) {
			throw new Error("Destination exists but is not a regular file");
		}
	} catch (error) {
		if (error?.code !== "ENOENT") throw error;
	}
	const temporary = path.join(
		path.dirname(destination),
		`.cc-copy-${process.pid}-${randomUUID()}.tmp`,
	);
	try {
		writeExclusive(temporary, content);
		try {
			// POSIX rename replaces the directory entry atomically, which also avoids
			// following a destination symlink after the user confirms overwrite.
			fs.renameSync(temporary, destination);
		} catch (error) {
			// Windows does not consistently replace an existing destination. Move the
			// old file aside first so a failed installation can restore it rather than
			// leaving the destination truncated or missing.
			if (process.platform !== "win32" || !["EEXIST", "EPERM"].includes(error?.code)) throw error;
			const backup = path.join(path.dirname(destination), `.cc-copy-backup-${process.pid}-${randomUUID()}.tmp`);
			fs.renameSync(destination, backup);
			try {
				fs.renameSync(temporary, destination);
			} catch (replacementError) {
				try {
					fs.renameSync(backup, destination);
				} catch (restoreError) {
					replacementError.restoreError = restoreError;
				}
				throw replacementError;
			}
			fs.rmSync(backup, { force: true });
		}
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function normalizeLanguage(value) {
	const language = sanitizeShellOutput(value).trim().split(/\s+/u)[0] ?? "";
	return /^[A-Za-z0-9_+.-]{1,64}$/u.test(language) ? language : "";
}

function previewText(value) {
	const clean = sanitizeShellOutput(value).replace(/\s+/gu, " ").trim();
	const characters = [...clean];
	return characters.length > 100 ? `${characters.slice(0, 99).join("")}…` : clean;
}
