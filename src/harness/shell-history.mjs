// Bounded, read-only shell history used by the shared `!` composer mode.
// History never leaves the host and is never copied into cc's settings/cache.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeShellOutput } from "./shell-input.mjs";

export const SHELL_HISTORY_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SHELL_HISTORY_MAX_ENTRIES = 5_000;
export const SHELL_HISTORY_MAX_COMMAND_CHARS = 8_192;
export const SHELL_HISTORY_SUGGESTION_LIMIT = 100;

export class ShellCommandHistory {
	constructor(options = {}) {
		this.environment = options.environment ?? process.env;
		this.homeDirectory = options.homeDirectory ?? os.homedir();
		this.readTail = options.readTail ?? readFileTail;
		this.files = options.files ?? shellHistoryFiles(this.environment, this.homeDirectory);
		this.entries = [];
		this.loaded = false;
	}

	remember(command) {
		const normalized = normalizeHistoryCommand(command);
		if (!normalized) return false;
		this.#ensureLoaded();
		this.entries = this.entries.filter((entry) => entry !== normalized);
		this.entries.push(normalized);
		if (this.entries.length > SHELL_HISTORY_MAX_ENTRIES) {
			this.entries.splice(0, this.entries.length - SHELL_HISTORY_MAX_ENTRIES);
		}
		return true;
	}

	suggestions(prefix, options = {}) {
		this.#ensureLoaded();
		const needle = String(prefix ?? "");
		const limit = clampLimit(options.limit);
		const result = [];
		const seen = new Set();
		for (let index = this.entries.length - 1; index >= 0 && result.length < limit; index -= 1) {
			const command = this.entries[index];
			if (!command.startsWith(needle) || seen.has(command)) continue;
			seen.add(command);
			result.push(command);
		}
		return result;
	}

	#ensureLoaded() {
		if (this.loaded) return;
		this.loaded = true;
		const entries = [];
		for (const file of this.files) {
			let text;
			try {
				text = this.readTail(file, SHELL_HISTORY_MAX_FILE_BYTES);
			} catch {
				continue;
			}
			entries.push(...parseShellHistory(text, file));
		}
		this.entries = entries.slice(-SHELL_HISTORY_MAX_ENTRIES);
	}
}

export function shellHistoryFiles(environment = process.env, homeDirectory = os.homedir()) {
	const files = [];
	const add = (candidate) => {
		if (typeof candidate !== "string" || !candidate.trim()) return;
		const expanded = candidate.trim().startsWith("~/")
			? path.join(homeDirectory, candidate.trim().slice(2))
			: path.resolve(candidate.trim());
		if (!files.includes(expanded)) files.push(expanded);
	};
	add(environment.HISTFILE);
	const shell = path.basename(String(environment.SHELL ?? "")).toLowerCase();
	if (shell === "fish") add(path.join(environment.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share"), "fish", "fish_history"));
	if (shell === "bash") add(path.join(homeDirectory, ".bash_history"));
	if (shell === "zsh") add(path.join(homeDirectory, ".zsh_history"));
	// Shell can be unset in GUI-launched terminals. These fallbacks are cheap and
	// preserve recency within each file without scanning arbitrary directories.
	if (!shell) {
		add(path.join(homeDirectory, ".zsh_history"));
		add(path.join(homeDirectory, ".bash_history"));
	}
	return files;
}

export function parseShellHistory(value, file = "") {
	const fish = path.basename(file) === "fish_history";
	const entries = [];
	for (const rawLine of String(value ?? "").split(/\r?\n/u)) {
		let line = rawLine;
		if (fish) {
			const match = /^\s*- cmd:\s?(.*)$/u.exec(line);
			if (!match) continue;
			// Single pass so an escaped backslash never merges with a following `n`.
			line = match[1].replace(/\\(n|\\)/gu, (_, escaped) => (escaped === "n" ? "\n" : "\\"));
		} else {
			// zsh EXTENDED_HISTORY: `: <epoch>:<duration>;<command>`.
			line = line.replace(/^:\s+\d+:\d+;/u, "");
		}
		const command = normalizeHistoryCommand(line);
		if (command) entries.push(command);
	}
	return entries;
}

export function normalizeHistoryCommand(value) {
	if (typeof value !== "string" || value.includes("\0")) return undefined;
	const normalized = sanitizeShellOutput(value)
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
	if (!normalized) return undefined;
	return [...normalized].slice(0, SHELL_HISTORY_MAX_COMMAND_CHARS).join("");
}

function readFileTail(file, maxBytes) {
	const descriptor = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) return "";
		const length = Math.min(stat.size, maxBytes);
		const buffer = Buffer.alloc(length);
		fs.readSync(descriptor, buffer, 0, length, Math.max(0, stat.size - length));
		let text = buffer.toString("utf8");
		// A tail may begin in the middle of a command or UTF-8 sequence. Discard the
		// partial first record; later records remain useful and well-bounded.
		if (stat.size > length) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
		return text;
	} finally {
		fs.closeSync(descriptor);
	}
}

function clampLimit(value) {
	return Number.isInteger(value)
		? Math.max(1, Math.min(SHELL_HISTORY_SUGGESTION_LIMIT, value))
		: SHELL_HISTORY_SUGGESTION_LIMIT;
}
