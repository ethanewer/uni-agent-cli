#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { Editor } from "@mariozechner/pi-tui/dist/components/editor.js";
import { Spacer } from "@mariozechner/pi-tui/dist/components/spacer.js";
import { Text } from "@mariozechner/pi-tui/dist/components/text.js";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui/dist/keys.js";
import { ProcessTerminal } from "@mariozechner/pi-tui/dist/terminal.js";
import { Container, TUI } from "@mariozechner/pi-tui/dist/tui.js";
import { applyBackgroundToLine, normalizeTerminalOutput, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui/dist/utils.js";

const HARNESS = "/harness";
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const chalk = createAnsiStyles();

const MARKDOWN_THEME = {
	heading: (text) => chalk.bold(text),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.yellow(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.blue(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	underline: (text) => chalk.underline(text),
	strikethrough: (text) => chalk.strikethrough(text),
	highlightCode: (code) => code.split("\n").map((line) => chalk.yellow(line)),
};

const SELECT_LIST_THEME = {
	selectedPrefix: (text) => chalk.blue(text),
	selectedText: (text) => chalk.black.bgBlue(text),
	description: (text) => chalk.dim(text),
	scrollInfo: (text) => chalk.dim(text),
	noMatch: (text) => chalk.dim(text),
};

const EDITOR_THEME = {
	borderColor: (text) => chalk.blue(text),
	selectList: SELECT_LIST_THEME,
};

const UI_COLORS = {
	userMessageBg: "#343541",
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const BACKGROUND_CONNECT_DELAY_MS = parseDelay(process.env.CC_BACKGROUND_CONNECT_DELAY_MS, 250);
const MARKDOWN_PRELOAD_DELAY_MS = parseDelay(process.env.CC_MARKDOWN_PRELOAD_DELAY_MS, 750);
const RESIZE_SETTLE_DELAY_MS = parseDelay(process.env.CC_RESIZE_SETTLE_DELAY_MS, 90);
let MarkdownComponent;
let markdownLoadPromise;
let CombinedAutocompleteProviderClass;
let autocompleteLoadPromise;

const DEFAULT_CONFIG = {
	defaultAgent: "codex",
	agents: {
		claude: {
			label: "Claude Code",
			transport: "acp",
			command: "claude",
			args: [],
			acp: { command: "claude-agent-acp", args: [] },
		},
		codex: {
			label: "Codex",
			transport: "acp",
			command: "codex",
			args: [],
			acp: { command: "codex-acp", args: [] },
		},
		cursor: {
			label: "Cursor Agent",
			transport: "acp",
			command: "cursor-agent",
			args: [],
			acp: { command: "cursor-agent", args: ["acp"] },
		},
	},
};

class StatusLine extends Text {
	constructor(getStatus) {
		super("", 0, 0);
		this.getStatus = getStatus;
	}

	render(width) {
		const status = this.getStatus();
		const state = status.state ? `${status.spinner ? `${status.spinner} ` : ""}${status.state} · ` : "";
		const line = `${state}${status.agent} ${status.transport} · ${compactCwd(process.cwd())}`;
		return [chalk.dim(truncateVisual(line, width))];
	}
}

class VoiceEditor extends Editor {
	placeholderLine = undefined;

	render(width) {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const placeholder = this.placeholderLine?.();
		if (placeholder !== undefined && this.getText().length === 0 && lines.length >= 2) {
			lines[1] = this.renderPlaceholderLine(placeholder, width);
		}
		return lines;
	}

	renderPlaceholderLine(text, width) {
		const paddingX = this.getPaddingX();
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const effectivePad = Math.min(paddingX, maxPadding);
		const left = " ".repeat(effectivePad);
		const right = " ".repeat(effectivePad);
		const contentWidth = Math.max(1, width - effectivePad * 2);
		const truncated = visibleWidth(text) > contentWidth ? truncateToWidth(text, contentWidth) : text;
		const fill = " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		return `${left}${truncated}${fill}${right}`;
	}

	prependText(text) {
		if (!text) return;
		const normalized = this.normalizeText ? this.normalizeText(text) : text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
		if (normalized.includes("\n")) {
			this.setText(normalized + this.getText());
			return;
		}
		this.cancelAutocomplete?.();
		this.pushUndoSnapshot?.();
		this.lastAction = null;
		this.historyIndex = -1;
		this.state.lines[0] = normalized + (this.state.lines[0] || "");
		if (this.state.cursorLine === 0) this.state.cursorCol += normalized.length;
		this.onChange?.(this.getText());
	}
}

class AgentMenu {
	constructor(app) {
		this.app = app;
		this.selected = Math.max(0, Object.keys(app.config.agents).indexOf(app.activeKey));
	}

	invalidate() {}

	render(width) {
		const entries = Object.entries(this.app.config.agents);
		const lines = [chalk.bold("Switch agent"), ""];
		entries.forEach(([key, agent], index) => {
			const cursor = index === this.selected ? "›" : " ";
			const active = key === this.app.activeKey ? "●" : " ";
			const label = `${cursor} ${index + 1}. ${active} ${agent.label ?? key} (${key})`;
			lines.push(index === this.selected ? chalk.blue(label) : label);
		});
		lines.push("", chalk.dim("enter select · q cancel"));
		return lines.map((line) => truncateVisual(line, width));
	}

	handleInput(data) {
		const keys = Object.keys(this.app.config.agents);
		if (matchesKey(data, "escape") || data === "q" || data === "\x03") {
			this.app.closeMenu();
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(keys.length - 1, this.selected + 1);
			return;
		}
		if (data >= "1" && data <= "9") {
			const key = keys[Number(data) - 1];
			if (key) void this.app.switchAgent(key);
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			const key = keys[this.selected];
			if (key) void this.app.switchAgent(key);
		}
	}
}

class SelectionPanel {
	constructor(title, entries, onSelect, options = {}) {
		this.title = title;
		this.entries = entries;
		this.onSelect = onSelect;
		this.selected = Math.max(0, options.selected ?? 0);
		this.emptyText = options.emptyText ?? "No items";
		this.onQueryChange = options.onQueryChange ?? (() => {});
		this.query = "";
	}

	invalidate() {}

	render(width) {
		const entries = this.filteredEntries();
		const maxVisible = 12;
		const rowCount = Math.min(maxVisible, Math.max(this.entries.length, 1));
		const half = Math.floor(maxVisible / 2);
		this.selected = entries.length > 0 ? Math.min(this.selected, entries.length - 1) : 0;
		const start = Math.max(0, Math.min(this.selected - half, entries.length - maxVisible));
		const visible = entries.slice(start, start + maxVisible);
		const lines = [chalk.bold(this.title), ""];

		for (let offset = 0; offset < rowCount; offset += 1) {
			const entry = visible[offset];
			if (!entry) {
				lines.push(offset === 0 && entries.length === 0 ? chalk.dim(this.query ? "No matches" : this.emptyText) : "");
				continue;
			}
			const index = start + offset;
			const cursor = index === this.selected ? "›" : " ";
			const marker = entry.active ? "●" : " ";
			const description = entry.description ? chalk.dim(`  ${entry.description}`) : "";
			const label = `${cursor} ${marker} ${entry.label}${description}`;
			lines.push(index === this.selected ? chalk.blue(label) : label);
		}

		const position = entries.length > 0 ? `${this.selected + 1}/${entries.length}` : "0/0";
		lines.push("", chalk.dim(position), chalk.dim("type to filter · enter select · esc cancel"));
		return lines.map((line) => truncateVisual(line, width));
	}

	handleInput(data) {
		if (matchesKey(data, "escape") || data === "\x03") {
			this.onSelect(undefined);
			return;
		}
		if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.onQueryChange(this.query);
			return;
		}
		if (data === "\x15") {
			this.query = "";
			this.selected = 0;
			this.onQueryChange(this.query);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			const entries = this.filteredEntries();
			this.selected = entries.length > 0 ? Math.min(entries.length - 1, this.selected + 1) : 0;
			return;
		}
		const entries = this.filteredEntries();
		if ((matchesKey(data, "enter") || data === "\r" || data === "\n") && entries[this.selected]) {
			this.onSelect(entries[this.selected]);
			return;
		}
		if (isPrintableInput(data)) {
			this.query += data;
			this.selected = 0;
			this.onQueryChange(this.query);
		}
	}

	clearInput() {
		if (!this.query) return false;
		this.query = "";
		this.selected = 0;
		this.onQueryChange(this.query);
		return true;
	}

	filteredEntries() {
		if (!this.query) return this.entries;
		const query = this.query.toLowerCase();
		return this.entries.filter((entry) =>
			[entry.label, entry.description, entry.value].filter(Boolean).some((value) => String(value).toLowerCase().includes(query)),
		);
	}
}

class ManagedTerminal {
	constructor(id, params) {
		this.id = id;
		this.outputByteLimit = params.outputByteLimit ?? 128 * 1024;
		this.output = "";
		this.truncated = false;
		this.exitStatus = undefined;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});

		const env = { ...process.env };
		for (const entry of params.env ?? []) {
			if (entry?.name) env[entry.name] = entry.value ?? "";
		}
		this.child = spawn(params.command, params.args ?? [], {
			cwd: params.cwd || process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child.stdout.on("data", (chunk) => this.appendOutput(chunk));
		this.child.stderr.on("data", (chunk) => this.appendOutput(chunk));
		this.child.once("error", (error) => {
			this.appendOutput(`${error.message}\n`);
			this.exitStatus = { exitCode: null, signal: "ERROR" };
			this.resolveExit(this.exitStatus);
		});
		this.child.once("exit", (code, signal) => {
			this.exitStatus = { exitCode: code, signal };
			this.resolveExit(this.exitStatus);
		});
	}

	appendOutput(chunk) {
		this.output += String(chunk);
		const limit = Math.max(0, this.outputByteLimit);
		if (limit > 0 && Buffer.byteLength(this.output, "utf8") > limit) {
			let bytes = 0;
			const chars = [];
			for (const char of [...this.output].reverse()) {
				bytes += Buffer.byteLength(char, "utf8");
				if (bytes > limit) break;
				chars.push(char);
			}
			this.output = chars.reverse().join("");
			this.truncated = true;
		}
	}

	outputResponse() {
		return {
			output: this.output,
			truncated: this.truncated,
			...(this.exitStatus ? { exitStatus: this.exitStatus } : {}),
		};
	}

	async waitForExit() {
		return this.exitStatus ?? (await this.exitPromise);
	}

	kill() {
		if (this.child.exitCode === null && !this.child.killed) this.child.kill();
	}
}

class AcpClient {
	constructor(agent, onEvent) {
		this.agent = agent;
		this.onEvent = onEvent;
		this.nextId = 1;
		this.pending = new Map();
		this.sessionId = undefined;
		this.child = undefined;
		this.capabilities = {};
		this.agentInfo = {};
		this.authMethods = [];
		this.sessionInfo = {};
		this.configOptions = [];
		this.models = undefined;
		this.modes = undefined;
		this.terminals = new Map();
		this.nextTerminalId = 1;
		this.exited = false;
		this.stopping = false;
		this.lastStderr = "";
	}

	start() {
		const command = this.agent.acp ?? this.agent;
		this.child = spawn(command.command, command.args ?? [], {
			cwd: process.cwd(),
			env: process.env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.once("error", (error) => {
			this.rejectPending(error);
			this.onEvent({ type: "error", message: error.message });
		});
		this.child.once("exit", (code, signal) => {
			this.exited = true;
			const reason = signal ?? code ?? "unknown";
			const stderr = this.lastStderr ? `: ${this.lastStderr}` : "";
			const hadPending = this.pending.size > 0;
			this.rejectPending(new Error(`backend exited (${reason})${stderr}`));
			if (!this.stopping && !hadPending) this.onEvent({ type: "line", text: `• backend exited (${reason})${stderr}` });
		});
		this.child.stderr.on("data", (chunk) => {
			const text = String(chunk).trim();
			if (text) {
				this.lastStderr = oneLine(text);
			}
		});
		this.child.stdin.on("error", (error) => this.rejectPending(error));
		const rl = readline.createInterface({ input: this.child.stdout });
		rl.on("line", (line) => this.handleLine(line));
	}

	async initialize() {
		this.start();
		const initialized = await this.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: true,
			},
			clientInfo: { name: "cc", title: "cc", version: "0.1.0" },
		});
		this.capabilities = initialized?.agentCapabilities ?? {};
		this.agentInfo = initialized?.agentInfo ?? {};
		this.authMethods = initialized?.authMethods ?? [];
		const session = await this.request("session/new", {
			cwd: process.cwd(),
			mcpServers: [],
		});
		this.sessionId = session?.sessionId ?? session?.id;
		if (!this.sessionId) throw new Error("ACP session/new did not return a session id");
		this.applySessionState(session);
	}

	async prompt(text) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		await this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: [{ type: "text", text }],
		});
	}

	async listSessions() {
		const sessions = [];
		let cursor = undefined;
		do {
			const result = await this.request("session/list", {
				cwd: process.cwd(),
				...(cursor ? { cursor } : {}),
			});
			sessions.push(...(result?.sessions ?? []));
			cursor = result?.nextCursor;
		} while (cursor);
		return sessions;
	}

	async loadSession(sessionId) {
		const params = { sessionId, cwd: process.cwd(), mcpServers: [] };
		const result = this.capabilities?.loadSession
			? await this.request("session/load", params)
			: await this.request("session/resume", params);
		this.sessionId = sessionId;
		this.applySessionState(result);
		return result;
	}

	async resumeSession(sessionId) {
		const result = await this.request("session/resume", {
			sessionId,
			cwd: process.cwd(),
			mcpServers: [],
		});
		this.sessionId = sessionId;
		this.applySessionState(result);
		return result;
	}

	async setConfigOption(configId, value) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		const result = await this.request("session/set_config_option", {
			sessionId: this.sessionId,
			configId,
			value,
		});
		this.applySessionState(result);
		return result;
	}

	async setMode(modeId) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		const result = await this.request("session/set_mode", {
			sessionId: this.sessionId,
			modeId,
		});
		this.applySessionState({ modes: { ...this.modes, currentModeId: modeId } });
		return result;
	}

	applySessionState(state = {}) {
		if (Array.isArray(state.configOptions)) this.configOptions = state.configOptions;
		if (state.models) this.models = state.models;
		if (state.modes) this.modes = state.modes;
		this.sessionInfo = {
			...this.sessionInfo,
			...(state.sessionInfo ?? {}),
			...(state.title || state.updatedAt ? { title: state.title, updatedAt: state.updatedAt } : {}),
		};
		this.onEvent({ type: "session_info", sessionInfo: this.getSessionInfo() });
	}

	getSessionInfo() {
		return {
			sessionId: this.sessionId,
			capabilities: this.capabilities,
			agentInfo: this.agentInfo,
			authMethods: this.authMethods,
			configOptions: this.configOptions,
			models: this.models,
			modes: this.modes,
			sessionInfo: this.sessionInfo,
		};
	}

	cancel() {
		if (!this.sessionId) return;
		this.notify("session/cancel", { sessionId: this.sessionId });
	}

	stop() {
		this.stopping = true;
		for (const terminal of this.terminals.values()) terminal.kill();
		this.terminals.clear();
		this.rejectPending(new Error("backend stopped"));
		terminateChild(this.child);
	}

	request(method, params) {
		if (!this.child || this.exited) return Promise.reject(new Error("ACP backend is not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { method, resolve, reject });
			try {
				this.write({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				reject(error);
			}
		});
	}

	notify(method, params) {
		if (!this.child || this.exited) return;
		this.write({ jsonrpc: "2.0", method, params });
	}

	write(message) {
		if (!this.child || this.exited) throw new Error("ACP backend is not running");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	rejectPending(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
	}

	handleLine(line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			if (line.trim()) this.onEvent({ type: "line", text: line });
			return;
		}
		if (message.id !== undefined && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(formatRpcError(pending.method, message.error)));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === "session/update") {
			this.handleSessionUpdate(message.params);
			return;
		}
		if (message.id !== undefined && message.method?.startsWith("terminal/")) {
			void this.handleTerminalRequest(message);
			return;
		}
		if (message.id !== undefined && message.method === "session/request_permission") {
			this.write({ jsonrpc: "2.0", id: message.id, result: { outcome: selectedPermissionOutcome(message.params) } });
			return;
		}
	}

	async handleTerminalRequest(message) {
		try {
			let result;
			const params = message.params ?? {};
			if (message.method === "terminal/create") {
				const terminalId = `terminal-${this.nextTerminalId++}`;
				this.terminals.set(terminalId, new ManagedTerminal(terminalId, params));
				result = { terminalId };
			} else if (message.method === "terminal/output") {
				result = this.getTerminal(params.terminalId).outputResponse();
			} else if (message.method === "terminal/wait_for_exit") {
				result = await this.getTerminal(params.terminalId).waitForExit();
			} else if (message.method === "terminal/kill") {
				this.getTerminal(params.terminalId).kill();
				result = {};
			} else if (message.method === "terminal/release") {
				const terminal = this.getTerminal(params.terminalId);
				terminal.kill();
				this.terminals.delete(params.terminalId);
				result = {};
			} else {
				throw new Error(`Unsupported terminal method: ${message.method}`);
			}
			this.write({ jsonrpc: "2.0", id: message.id, result });
		} catch (error) {
			this.write({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: -32603, message: error.message ?? String(error) },
			});
		}
	}

	getTerminal(terminalId) {
		const terminal = this.terminals.get(terminalId);
		if (!terminal) throw new Error(`Unknown terminal: ${terminalId}`);
		return terminal;
	}

	handleSessionUpdate(params) {
		const update = params?.update;
		if (!update) return;
		const kind = update.sessionUpdate;
		if (kind === "agent_message_chunk" || kind === "thought_chunk" || kind === "user_message_chunk") {
			const text = update.content?.text;
			if (text) this.onEvent({ type: kind === "user_message_chunk" ? "user_text" : "text", text });
			return;
		}
		if (kind === "available_commands_update" && Array.isArray(update.availableCommands)) {
			this.onEvent({
				type: "commands",
				commands: update.availableCommands
					.filter((command) => command?.name)
					.map((command) => ({
						name: command.name.replace(/^\//, ""),
						description: command.description,
						argumentHint: command.input?.hint,
					})),
			});
			return;
		}
		if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
			this.applySessionState({ configOptions: update.configOptions });
			return;
		}
		if (kind === "current_mode_update") {
			const currentModeId = update.currentModeId ?? update.modeId ?? update.mode?.id;
			if (currentModeId) this.applySessionState({ modes: { ...this.modes, currentModeId } });
			return;
		}
		if (kind === "session_info_update") {
			this.sessionInfo = { ...this.sessionInfo, ...update };
			this.onEvent({ type: "session_info", sessionInfo: this.getSessionInfo() });
			return;
		}
		if (kind === "tool_call") {
			this.onEvent({
				type: "tool",
				id: toolId(update),
				title: toolTitle(update),
				status: normalizedToolStatus(update.status ?? "running"),
			});
			return;
		}
		if (kind === "tool_call_update" && update.status) {
			this.onEvent({
				type: "tool_update",
				id: toolId(update),
				title: update.title ? toolTitle(update) : undefined,
				status: normalizedToolStatus(update.status),
			});
			return;
		}
		if (kind === "plan" && Array.isArray(update.entries)) {
			this.onEvent({
				type: "line",
				text: ["• plan", ...update.entries.map((entry) => `  - [${entry.status ?? "pending"}] ${entry.content}`)].join("\n"),
			});
		}
	}
}

class VoiceController {
	constructor(options) {
		this.options = options;
		this.state = "idle";
		this.recording = undefined;
		this.recordingStartMs = 0;
		this.tickTimer = undefined;
		this.tick = 0;
		this.abortController = undefined;
		this.disposed = false;
	}

	isRecording() {
		return this.state === "recording";
	}

	isTranscribing() {
		return this.state === "transcribing";
	}

	getElapsedSeconds() {
		if (this.state !== "recording" || !this.recordingStartMs) return 0;
		return Math.floor((Date.now() - this.recordingStartMs) / 1000);
	}

	getTick() {
		return this.tick;
	}

	toggle() {
		if (this.state === "transcribing") return;
		if (this.state === "recording") {
			this.stopAndTranscribe({ intent: "send" });
			return;
		}
		this.startRecording();
	}

	finish() {
		if (this.state !== "recording") return;
		this.stopAndTranscribe({ intent: "edit" });
	}

	cancel() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = undefined;
		}
		if (this.recording) {
			void this.recording.stop().catch(() => {});
			this.recording = undefined;
		}
		this.stopTickTimer();
		this.setState("idle");
	}

	dispose() {
		this.disposed = true;
		this.cancel();
	}

	startRecording() {
		try {
			this.recording = recordAudio();
		} catch (error) {
			this.emitError(error instanceof Error ? error.message : "Failed to start recording");
			return;
		}
		this.recordingStartMs = Date.now();
		this.tick = 0;
		this.startTickTimer();
		this.setState("recording");
	}

	stopAndTranscribe({ intent }) {
		const recording = this.recording;
		if (!recording) return;
		this.recording = undefined;
		this.stopTickTimer();
		this.setState("transcribing");

		const abort = new AbortController();
		this.abortController = abort;
		const timer = setTimeout(() => abort.abort(), 120_000);
		let outcome = "empty";

		(async () => {
			const audio = await recording.stop();
			if (abort.signal.aborted) throw new Error("Transcription cancelled");
			if (audio.length === 0) return "";
			const apiKey = await this.options.getApiKey();
			if (!apiKey) throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY.");
			const baseUrl = this.options.getBaseUrl ? await this.options.getBaseUrl() : undefined;
			return await transcribeAudio({
				apiKey,
				audio,
				model: this.options.model ?? DEFAULT_TRANSCRIPTION_MODEL,
				baseUrl: baseUrl || undefined,
				abortSignal: abort.signal,
			});
		})()
			.then((text) => {
				if (this.disposed || abort.signal.aborted) {
					outcome = "cancelled";
					return;
				}
				if (intent === "edit") {
					outcome = "finish";
					this.options.onFinish(text ?? "");
				} else if (text?.trim()) {
					outcome = "result";
					this.options.onResult(text);
				} else {
					outcome = "empty";
				}
			})
			.catch((error) => {
				if (this.disposed || abort.signal.aborted) {
					outcome = "cancelled";
					return;
				}
				outcome = "error";
				this.emitError(error instanceof Error ? error.message : "Transcription failed");
				if (intent === "edit") this.options.onFinish("");
			})
			.finally(() => {
				clearTimeout(timer);
				if (this.abortController === abort) this.abortController = undefined;
				if (this.state === "transcribing") this.setState("idle");
				if (!this.disposed) this.options.onTranscriptionEnd?.(outcome);
			});
	}

	startTickTimer() {
		this.stopTickTimer();
		this.tickTimer = setInterval(() => {
			this.tick += 1;
			this.options.onStateChange?.();
		}, 80);
		this.tickTimer.unref?.();
	}

	stopTickTimer() {
		if (this.tickTimer) clearInterval(this.tickTimer);
		this.tickTimer = undefined;
	}

	setState(state) {
		if (this.state === state) return;
		this.state = state;
		this.options.onStateChange?.();
	}

	emitError(message) {
		this.options.onError?.(message);
	}
}

class HarnessApp {
	constructor(config, initialAgent, initialTransport) {
		this.config = config;
		this.activeKey = initialAgent;
		this.transport = initialTransport ?? config.agents[initialAgent]?.transport ?? "acp";
		this.ready = false;
		this.busy = false;
		this.client = undefined;
		this.menuHandle = undefined;
		this.menuEditorText = undefined;
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.lastInputClearSource = undefined;
		this.lastKnownEditorText = "";
		this.suppressNextPairedEmptyInterrupt = false;
		this.spinnerTimer = undefined;
		this.spinnerIndex = 0;
		this.statusState = "";
		this.promptQueue = [];
		this.flushingPromptQueue = false;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.activeToolIds = new Set();
		this.seenToolThisTurn = false;
		this.availableCommands = new Map();
		this.sessionStates = new Map();
		this.voiceController = undefined;
		this.voiceModeEnabled = true;
		this.voiceOriginalOnSubmit = undefined;
		this.voicePendingSubmit = undefined;
		this.voiceTargetEditor = undefined;
		this.startupConnectTimer = undefined;
		this.markdownPreloadTimer = undefined;
		this.resizeActive = false;

		const terminal = createHarnessTerminal({
			onResizeStart: () => this.beginResize(),
			onResizeEnd: () => this.endResize(),
		});
		this.ui = new TUI(terminal, true);
		this.ui.queryCellSize = () => {};
		this.installResizeRenderGate();
		this.chat = new Container();
		this.commandPanel = new Container();
		this.editor = new VoiceEditor(this.ui, EDITOR_THEME, { paddingX: 0, autocompleteMaxVisible: 8 });
		this.status = new StatusLine(() => ({
			agent: this.activeKey,
			state: this.statusState,
			spinner: this.statusState ? SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length] : "",
			transport: this.transport,
		}));
		this.ui.addChild(this.chat);
		this.ui.addChild(this.commandPanel);
		this.queueSummary = new PromptQueueSummary(
			() => this.promptQueue,
			() => SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length],
		);
		this.ui.addChild(this.queueSummary);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.status);
		this.ui.setFocus(this.editor);
		this.updateAutocomplete();
		this.initVoiceInput();
		this.adoptPrepaintedFrame();

		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
	}

	async start() {
		this.ui.start();
		if (MARKDOWN_PRELOAD_DELAY_MS >= 0) {
			this.markdownPreloadTimer = setTimeout(() => {
				this.markdownPreloadTimer = undefined;
				loadMarkdownRenderer(() => this.ui.requestRender());
			}, MARKDOWN_PRELOAD_DELAY_MS);
			this.markdownPreloadTimer.unref?.();
		}
		if (BACKGROUND_CONNECT_DELAY_MS < 0) return;
		this.startupConnectTimer = setTimeout(() => {
			this.startupConnectTimer = undefined;
			if (!this.client) void this.switchAgent(this.activeKey, this.transport, { quiet: true });
		}, BACKGROUND_CONNECT_DELAY_MS);
		this.startupConnectTimer.unref?.();
	}

	installResizeRenderGate() {
		const requestRender = this.ui.requestRender.bind(this.ui);
		this.ui.requestRender = (force = false) => {
			if (this.resizeActive && !force) return;
			requestRender(force);
		};
	}

	beginResize() {
		if (this.resizeActive) return;
		this.resizeActive = true;
		if (this.ui.renderTimer) {
			clearTimeout(this.ui.renderTimer);
			this.ui.renderTimer = undefined;
		}
		if (this.ui.renderRequested) {
			this.ui.renderRequested = false;
		}
	}

	endResize() {
		this.resizeActive = false;
	}

	adoptPrepaintedFrame() {
		if (process.env.CC_PREPAINTED !== "1") return;
		if (process.env.CC_PREPAINT_AGENT !== this.activeKey || this.transport !== "acp") return;
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const rendered = this.ui.render(width).map((line) => `${normalizeTerminalOutput(line)}${TUI.SEGMENT_RESET}`);
		if (rendered.length === 0) return;
		this.ui.previousLines = rendered;
		this.ui.previousWidth = width;
		this.ui.previousHeight = height;
		this.ui.cursorRow = rendered.length - 1;
		this.ui.hardwareCursorRow = rendered.length - 1;
		this.ui.maxLinesRendered = rendered.length;
		this.ui.previousViewportTop = Math.max(0, Math.max(height, rendered.length) - height);
		process.env.CC_ADOPTED_PREPAINT = "1";
	}

	async switchAgent(key, transport = "acp", options = {}) {
		if (this.startupConnectTimer) {
			clearTimeout(this.startupConnectTimer);
			this.startupConnectTimer = undefined;
		}
		const agent = this.config.agents[key];
		if (!agent) {
			this.addNotice(`unknown agent: ${key}`);
			return;
		}
		this.closeMenu();
		if (this.client) this.client.stop();
		this.activeKey = key;
		this.transport = transport;
		this.ready = false;
		this.busy = false;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.activeToolIds.clear();
		this.seenToolThisTurn = false;
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.statusState = options.statusState ?? (this.promptQueue.length > 0 ? "connecting" : "");
		this.updateSpinner();
		this.updateAutocomplete();
		if (!options.quiet) this.addNotice(`Switched to ${agent.label ?? key}`);
		this.ui.requestRender();

		if (transport !== "acp") {
			this.addNotice("PTY fallback is intentionally not used by the shared Pi TUI.");
			this.transport = "acp";
		}
		let client;
		client = new AcpClient(agent, (event) => {
			if (this.client === client) this.handleBackendEvent(event);
		});
		this.client = client;
		try {
			await client.initialize();
			if (this.client !== client) return;
			this.ready = true;
			this.statusState = "";
			this.updateSpinner();
			void this.flushPromptQueue();
			this.ui.requestRender();
		} catch (error) {
			if (this.client !== client) return;
			this.ready = false;
			this.statusState = "";
			this.updateSpinner();
			this.addError(error.message ?? String(error));
			this.ui.requestRender();
		}
	}

	handleGlobalInput(data) {
		if (isTerminalResponse(data)) return undefined;
		if (isKeyRelease(data)) return undefined;
		const control = splitControlInput(data);
		if (control) {
			this.applyInputPrefix(control.prefix);
			data = control.key;
		}
		if (this.menuHandle) {
			if (isCtrlD(data)) {
				this.stop();
				return { consume: true };
			}
			if (isCtrlC(data)) {
				this.handleInterrupt("input");
				return { consume: true };
			}
			this.menuHandle.handleInput(data);
			this.ui.requestRender();
			return { consume: true };
		}
		if (this.busy && isEscape(data)) {
			this.interruptTurn();
			return { consume: true };
		}
		const voiceWasRecording = this.voiceController?.isRecording();
		const voiceConsumed = this.handleVoiceKey(data, {
			isSpace: isPlainSpaceInput(data),
			isModifiedSpace: isModifiedSpaceInput(data),
			isCtrlSpace: matchesKey(data, "ctrl+space"),
		});
		if (voiceConsumed) return { consume: true };
		if (isCtrlD(data)) {
			this.stop();
			return { consume: true };
		}
		if (isCtrlC(data)) {
			if (voiceWasRecording && !this.editor.getText() && !this.lastKnownEditorText) {
				this.ui.requestRender();
				return { consume: true };
			}
			this.handleInterrupt("input");
			return { consume: true };
		}
		if (this.busy && isSubmitInput(data) && !this.editor.getText().trim()) {
			this.promoteNextQueuedPromptToAfterTool();
			return { consume: true };
		}
		if (isArrowUp(data) && !this.editor.getText() && this.unqueuePromptForEditing()) {
			return { consume: true };
		}
		this.rememberEditorTextAfterInput();
		return undefined;
	}

	handleInterrupt(source = "input") {
		if (this.menuHandle) {
			if (this.menuHandle.clearInput?.()) {
				this.ui.requestRender();
				return;
			}
			this.closeMenu();
			return;
		}
		if (this.editor.getText()) {
			this.editor.setText("");
			this.lastKnownEditorText = "";
			this.lastInputClearSource = source;
			this.suppressNextPairedEmptyInterrupt = true;
			this.ui.requestRender();
			return;
		}
		if (this.lastKnownEditorText) {
			this.lastKnownEditorText = "";
			this.lastInputClearSource = source;
			this.suppressNextPairedEmptyInterrupt = true;
			this.ui.requestRender();
			return;
		}
		if (this.suppressNextPairedEmptyInterrupt && source !== this.lastInputClearSource) {
			this.suppressNextPairedEmptyInterrupt = false;
			this.ui.requestRender();
			return;
		}
		this.suppressNextPairedEmptyInterrupt = false;
		this.addCtrlCExitHint();
		this.ui.requestRender();
	}

	applyInputPrefix(prefix) {
		if (!prefix) return;
		if (this.menuHandle) {
			for (const char of [...prefix]) this.menuHandle.handleInput(char);
			this.ui.requestRender();
			return;
		}
		if (this.editor.handleInput) {
			for (const char of [...prefix]) this.editor.handleInput(char);
			this.lastKnownEditorText = this.editor.getText();
			this.ui.requestRender();
		}
	}

	rememberEditorTextAfterInput() {
		queueMicrotask(() => {
			if (!this.menuHandle) this.lastKnownEditorText = this.editor.getText();
		});
	}

	initVoiceInput() {
		this.voiceController = new VoiceController({
			getApiKey: async () => process.env.OPENAI_API_KEY?.trim(),
			getBaseUrl: async () => process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim(),
			model: process.env.CC_TRANSCRIPTION_MODEL?.trim() || process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || undefined,
			onResult: (text) => this.handleVoiceResult(text),
			onFinish: (text) => this.handleVoiceFinish(text),
			onTranscriptionEnd: () => this.finalizeVoiceSession(),
			onStateChange: () => this.ui.requestRender(),
			onError: (message) => this.addError(message),
		});
		this.editor.placeholderLine = () => this.voicePlaceholderLine();
	}

	voicePlaceholderLine() {
		const controller = this.voiceController;
		if (!controller) return undefined;
		if (!this.voiceModeEnabled && !controller.isRecording() && !controller.isTranscribing()) return undefined;
		if (controller.isTranscribing()) return `${chalk.cyan("⦁")} ${chalk.dim("Transcribing…")}`;
		if (controller.isRecording()) {
			const frame = SPINNER_FRAMES[controller.getTick() % SPINNER_FRAMES.length];
			const elapsed = formatDuration(controller.getElapsedSeconds());
			return `${chalk.cyan("⦁")} ${chalk.cyan(frame)} ${chalk.cyan(`Rec ${elapsed}`)}  ${chalk.dim("voice: space send · ctrl+space or type to edit")}`;
		}
		return `${chalk.cyan("⦁")} ${chalk.dim("voice: space record · ctrl+space text input")}`;
	}

	enterVoiceMode() {
		if (this.voiceModeEnabled) return;
		this.voiceModeEnabled = true;
		this.ui.requestRender();
	}

	exitVoiceMode() {
		if (!this.voiceModeEnabled) return;
		this.voiceModeEnabled = false;
		this.ui.requestRender();
	}

	handleVoiceKey(_data, keyInfo) {
		const controller = this.voiceController;
		if (!controller) return false;

		if (!this.voiceModeEnabled) {
			return keyInfo.isCtrlSpace;
		}

		if (controller.isTranscribing()) {
			if (keyInfo.isSpace || keyInfo.isModifiedSpace || keyInfo.isCtrlSpace) return true;
			return false;
		}

		if (keyInfo.isCtrlSpace) {
			if (controller.isRecording()) {
				this.beginVoiceSession();
				controller.finish();
				this.exitVoiceMode();
			} else {
				this.exitVoiceMode();
			}
			return true;
		}

		if (keyInfo.isSpace) {
			if (controller.isRecording()) this.beginVoiceSession();
			controller.toggle();
			return true;
		}

		if (keyInfo.isModifiedSpace && !controller.isRecording()) return true;

		if (controller.isRecording()) {
			this.beginVoiceSession();
			controller.finish();
		}
		this.exitVoiceMode();
		return false;
	}

	beginVoiceSession() {
		const target = this.editor;
		this.voiceTargetEditor = target;
		this.voicePendingSubmit = undefined;
		this.voiceOriginalOnSubmit = target.onSubmit;
		target.onSubmit = (text) => {
			this.voicePendingSubmit = text;
		};
	}

	finalizeVoiceSession() {
		const target = this.voiceTargetEditor;
		if (target && this.voiceOriginalOnSubmit !== undefined) target.onSubmit = this.voiceOriginalOnSubmit;
		this.voiceOriginalOnSubmit = undefined;
		this.voiceTargetEditor = undefined;
		const pending = this.voicePendingSubmit;
		this.voicePendingSubmit = undefined;
		if (pending !== undefined) {
			const submit = target?.onSubmit ?? this.editor.onSubmit;
			if (submit && pending.trim()) submit(pending);
		}
	}

	getVoiceTargetEditor() {
		return this.voiceTargetEditor ?? this.editor;
	}

	handleVoiceResult(text) {
		const trimmed = text.trim();
		if (!trimmed) return;
		const submit = this.voiceOriginalOnSubmit ?? this.editor.onSubmit;
		if (!submit) return;
		const pending = this.voicePendingSubmit;
		this.voicePendingSubmit = undefined;
		const combined = pending?.trim() ? `${trimmed} ${pending}` : trimmed;
		submit(combined);
	}

	handleVoiceFinish(text) {
		const target = this.getVoiceTargetEditor();
		this.exitVoiceMode();
		const trimmed = text.trim();
		const pending = this.voicePendingSubmit;
		if (pending !== undefined) {
			this.voicePendingSubmit = undefined;
			const submit = this.voiceOriginalOnSubmit ?? this.editor.onSubmit;
			if (submit) {
				const sep = pending.startsWith(" ") || pending.startsWith("\n") || !pending ? "" : " ";
				const combined = trimmed ? `${trimmed}${sep}${pending}` : pending;
				if (combined.trim()) submit(combined);
			}
			this.ui.requestRender();
			return;
		}

		if (!trimmed) {
			this.ui.requestRender();
			return;
		}

		const current = target.getText();
		if (!current) {
			target.setText(trimmed);
			this.ui.requestRender();
			return;
		}

		const sep = current.startsWith(" ") || current.startsWith("\n") ? "" : " ";
		const prefix = `${trimmed}${sep}`;
		if (target.prependText) target.prependText(prefix);
		else target.setText(prefix + current);
		this.ui.requestRender();
	}

	async handleSubmit(rawText) {
		this.lastKnownEditorText = "";
		const text = rawText.trim();
		if (!text) return;
		this.editor.addToHistory(text);
		this.editor.onSubmit = undefined;
		queueMicrotask(() => {
			this.editor.onSubmit = (next) => void this.handleSubmit(next);
		});

		if (text.startsWith(HARNESS)) {
			await this.handleHarnessCommand(text);
			return;
		}
		if (text.startsWith("/")) {
			const handled = await this.handleSlashCommand(text);
			if (handled) return;
		}
		if (!this.ready) {
			this.enqueuePrompt(text);
			this.statusState = "connecting";
			this.updateSpinner();
			if (!this.client) void this.switchAgent(this.activeKey, this.transport, { quiet: true });
			this.ui.requestRender();
			return;
		}
		if (this.busy) {
			this.enqueuePrompt(text);
			return;
		}
		this.addUserMessage(text);
		await this.sendPrompt(text);
		await this.flushPromptQueue();
	}

	async sendPrompt(text) {
		if (!this.client || !this.ready) return;
		this.busy = true;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.activeToolIds.clear();
		this.seenToolThisTurn = false;
		this.currentAssistantText = undefined;
		this.statusState = "working";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.client.prompt(text);
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			if (this.cancelRequested) {
				for (const id of this.activeToolIds) this.updateTool("canceled", id);
			}
			this.activeToolIds.clear();
			this.busy = false;
			this.currentAssistantText = undefined;
			this.statusState = this.promptQueue.length > 0 ? "working" : "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async flushPromptQueue() {
		if (!this.ready || this.busy || this.flushingPromptQueue) return;
		this.flushingPromptQueue = true;
		try {
			while (this.ready && !this.busy && this.promptQueue.length > 0) {
				const prompt = this.promptQueue.shift();
				this.addUserMessage(prompt.text);
				this.ui.requestRender();
				await this.sendPrompt(prompt.text);
			}
		} finally {
			this.flushingPromptQueue = false;
		}
		if (this.promptQueue.length === 0 && !this.busy) {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	enqueuePrompt(text, timing = "afterTurn") {
		this.promptQueue.push({ text, timing });
		this.updateSpinner();
		this.ui.requestRender();
	}

	promoteNextQueuedPromptToAfterTool() {
		const prompt = this.promptQueue.find((entry) => entry.timing !== "afterTool");
		if (!prompt) return;
		prompt.timing = "afterTool";
		this.maybeCancelAfterTool();
		this.ui.requestRender();
	}

	unqueuePromptForEditing() {
		if (this.promptQueue.length === 0) return false;
		const prompt = this.promptQueue.pop();
		this.editor.setText(prompt.text);
		this.lastKnownEditorText = prompt.text;
		this.updateSpinner();
		this.ui.requestRender();
		return true;
	}

	interruptTurn() {
		if (!this.busy || !this.client || this.cancelRequested) return;
		this.cancelRequested = true;
		this.statusState = "canceling";
		this.updateSpinner();
		this.client.cancel();
		this.ui.requestRender();
	}

	maybeCancelAfterTool() {
		if (!this.busy || this.afterToolCancelPending || this.cancelRequested) return;
		if (!this.promptQueue.some((entry) => entry.timing === "afterTool")) return;
		if (!this.seenToolThisTurn) return;
		if (this.activeToolIds.size > 0) return;
		this.afterToolCancelPending = true;
		this.interruptTurn();
	}

	async handleHarnessCommand(command) {
		const parts = command.split(/\s+/).filter(Boolean);
		if (parts.length === 1) {
			this.openMenu();
			return;
		}
		if (parts.includes("exit") || parts.includes("quit")) {
			this.stop();
			return;
		}
		const agentKey = parts.find((part) => this.config.agents[part]);
		if (!agentKey) {
			this.addNotice(`usage: /harness [${Object.keys(this.config.agents).join("|")}]`);
			return;
		}
		await this.switchAgent(agentKey);
	}

	async handleSlashCommand(text) {
		const { name, argument } = parseSlashCommand(text);
		if (!name) return false;
		const available = this.availableCommands.get(this.activeKey) ?? [];
		const localNames = new Set(localSlashCommands(this).map((command) => command.name));
		const backendNames = new Set(available.map((command) => command.name));

		if (localNames.has(name)) {
			await this.runLocalSlashCommand(name, argument);
			return true;
		}
		if (backendNames.has(name)) return false;
		this.addNotice(`Unknown command: /${name}`);
		return true;
	}

	async runLocalSlashCommand(name, argument) {
		if (name === "help") {
			this.showHelp();
			return;
		}
		if (name === "status") {
			this.showStatus();
			return;
		}
		if (name === "clear") {
			this.chat.clear();
			this.currentAssistantText = undefined;
			this.currentUserText = undefined;
			this.currentToolSummary = undefined;
			this.ui.requestRender();
			return;
		}
		if (name === "voice") {
			if (argument) {
				this.addNotice("/voice only works by itself in an empty input box");
				return;
			}
			if (this.voiceController?.isRecording() || this.voiceController?.isTranscribing()) {
				this.addNotice("/voice is available after the current voice action finishes");
				return;
			}
			this.editor.setText("");
			this.enterVoiceMode();
			return;
		}
		if (name === "resume") {
			await this.openResumeDialog();
			return;
		}
		if (name === "model") {
			await this.openConfigDialog("model", "Model", argument);
			return;
		}
		if (name === "mode") {
			await this.openConfigDialog("mode", "Mode", argument);
			return;
		}
		if (name === "effort" || name === "reasoning" || name === "thinking") {
			await this.openConfigDialog("thought_level", "Reasoning", argument);
			return;
		}
		if (name === "plan") {
			await this.setPlanMode();
		}
	}

	async ensureConnected() {
		if (this.ready) return true;
		await this.switchAgent(this.activeKey, this.transport, { quiet: true, statusState: "connecting" });
		return this.ready;
	}

	showHelp() {
		const commands = dedupeCommands([
			...localSlashCommands(this),
			...(this.availableCommands.get(this.activeKey) ?? []),
		]);
		const lines = commands.map((command) => {
			const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
			const desc = command.description ? `  ${command.description}` : "";
			return `/${command.name}${hint}${desc}`;
		});
		this.addNotice(lines.join("\n"));
	}

	showStatus() {
		const state = this.sessionStates.get(this.activeKey) ?? {};
		const model = currentConfigLabel(findConfigOption(state, "model")) ?? state.models?.currentModelId;
		const mode = currentConfigLabel(findConfigOption(state, "mode")) ?? state.modes?.currentModeId;
		const effort = currentConfigLabel(findConfigOption(state, "thought_level"));
		const parts = [
			`${this.config.agents[this.activeKey]?.label ?? this.activeKey}`,
			model ? `model ${model}` : undefined,
			mode ? `mode ${mode}` : undefined,
			effort ? `reasoning ${effort}` : undefined,
			state.sessionId ? `session ${state.sessionId}` : undefined,
		].filter(Boolean);
		this.addNotice(parts.join(" · "));
	}

	async openResumeDialog() {
		if (!this.client || !this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		if (!supportsSessionList(this.sessionStates.get(this.activeKey))) {
			this.addNotice("This agent does not advertise session listing");
			return;
		}
		this.statusState = "loading sessions";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const sessions = await this.client.listSessions();
			const entries = sessions.map((session) => ({
				value: session.sessionId,
				label: session.title || session.sessionId,
				description: session.updatedAt ? `${compactDate(session.updatedAt)} · ${compactPath(session.cwd)}` : compactPath(session.cwd),
				active: session.sessionId === this.client.sessionId,
				session,
			}));
			this.openSelection("Resume session", entries, async (entry) => {
				this.closeMenu();
				if (!entry) return;
				await this.resumeSelectedSession(entry.session);
			});
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async resumeSelectedSession(session) {
		if (!this.client) return;
		if (session.sessionId === this.client.sessionId) {
			this.addNotice(`Already using ${session.title || session.sessionId}`);
			return;
		}
		this.statusState = "resuming";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const loadsHistory = Boolean(this.client.capabilities?.loadSession);
			this.chat.clear();
			this.currentAssistantText = undefined;
			this.currentToolSummary = undefined;
			this.currentUserText = undefined;
			if (loadsHistory) await this.client.loadSession(session.sessionId);
			else {
				await this.client.resumeSession(session.sessionId);
				this.addNotice(`Resumed ${session.title || session.sessionId}`);
			}
			if (loadsHistory && this.chat.children.length === 0) this.addNotice(`Resumed ${session.title || session.sessionId}`);
			this.updateAutocomplete();
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async openConfigDialog(category, title, argument = "") {
		if (!this.client || !this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		const state = this.sessionStates.get(this.activeKey);
		const option = findConfigOption(state, category);
		if (!option) {
			this.addNotice(`${title} selection is not advertised by this agent`);
			return;
		}
		const values = flattenConfigOptions(option);
		if (argument) {
			const match = values.find((entry) => entry.value === argument || entry.name === argument);
			if (!match) {
				this.addNotice(`Unknown ${title.toLowerCase()}: ${argument}`);
				return;
			}
			await this.setConfigValue(option, match.value, match.name);
			return;
		}
		const entries = values.map((value) => ({
			value: value.value,
			label: value.name,
			description: value.description,
			active: value.value === option.currentValue,
		}));
		this.openSelection(title, entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			await this.setConfigValue(option, entry.value, entry.label);
		});
	}

	async setConfigValue(option, value, label = value) {
		if (!this.client) return;
		this.statusState = "updating";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.client.setConfigOption(option.id, value);
			this.addNotice(`${option.name}: ${label}`);
			this.updateAutocomplete();
		} catch (error) {
			if (option.category === "mode" || option.id === "mode") {
				try {
					await this.client.setMode(value);
					this.addNotice(`${option.name}: ${label}`);
					this.updateAutocomplete();
					return;
				} catch (modeError) {
					this.addError(modeError.message ?? String(modeError));
				}
			} else {
				this.addError(error.message ?? String(error));
			}
		} finally {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async setPlanMode() {
		if (!this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		const state = this.sessionStates.get(this.activeKey);
		const option = findConfigOption(state, "mode");
		const value = flattenConfigOptions(option).find((entry) => entry.value === "plan" || entry.name.toLowerCase() === "plan");
		if (!option || !value) {
			this.addNotice("Plan mode is not advertised by this agent");
			return;
		}
		await this.setConfigValue(option, value.value, value.name);
	}

	openMenu() {
		this.closeMenu();
		this.menuHandle = new AgentMenu(this);
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.menuHandle);
		this.ui.requestRender();
	}

	openSelection(title, entries, onSelect, options = {}) {
		this.closeMenu();
		this.menuEditorText = this.editor.getText();
		this.updateFilterEditor("");
		this.menuHandle = new SelectionPanel(title, entries, onSelect, {
			...options,
			onQueryChange: (query) => this.updateFilterEditor(query),
		});
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	closeMenu() {
		if (this.menuHandle) {
			this.commandPanel.clear();
			this.menuHandle = undefined;
		}
		if (this.menuEditorText !== undefined) {
			this.editor.setText(this.menuEditorText);
			this.menuEditorText = undefined;
		}
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	updateFilterEditor(query) {
		this.editor.setText(`filter: ${query}`);
	}

	handleBackendEvent(event) {
		if (event.type === "text") {
			this.appendAssistantText(event.text);
		} else if (event.type === "line") {
			this.addNotice(event.text);
		} else if (event.type === "user_text") {
			this.appendUserText(event.text);
		} else if (event.type === "tool") {
			this.trackToolStatus(event.id, event.status);
			this.addTool(event.title, event.status, event.id);
		} else if (event.type === "tool_update") {
			this.trackToolStatus(event.id, event.status);
			this.updateTool(event.status, event.id, event.title);
		} else if (event.type === "error") {
			this.addError(event.message);
		} else if (event.type === "commands") {
			this.availableCommands.set(this.activeKey, event.commands);
			this.updateAutocomplete();
		} else if (event.type === "session_info") {
			this.sessionStates.set(this.activeKey, event.sessionInfo);
			this.updateAutocomplete();
		}
		this.ui.requestRender();
	}

	trackToolStatus(id, status) {
		if (!id) return;
		this.seenToolThisTurn = true;
		if (status === "running") this.activeToolIds.add(id);
		else this.activeToolIds.delete(id);
		this.maybeCancelAfterTool();
	}

	updateSpinner() {
		if (!this.statusState) {
			if (this.spinnerTimer) clearInterval(this.spinnerTimer);
			this.spinnerTimer = undefined;
			this.spinnerIndex = 0;
			return;
		}
		if (this.spinnerTimer) return;
		this.spinnerTimer = setInterval(() => {
			this.spinnerIndex += 1;
			this.ui.requestRender();
		}, 80);
	}

	updateAutocomplete() {
		const commands = [
			...localSlashCommands(this),
			...(this.availableCommands.get(this.activeKey) ?? []),
		];
		this.editor.setAutocompleteProvider(new LazyCombinedAutocompleteProvider(dedupeCommands(commands), process.cwd(), null));
	}

	addUserMessage(text) {
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new UserMessage(text));
	}

	appendUserText(text) {
		this.currentAssistantText = undefined;
		this.currentToolSummary = undefined;
		if (!this.currentUserText) {
			if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
			this.currentUserText = new MutableUserMessage("");
			this.chat.addChild(this.currentUserText);
		}
		this.currentUserText.append(text);
	}

	appendAssistantText(text) {
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (!this.currentAssistantText) {
			if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
			this.currentAssistantText = new MutableMarkdown("");
			this.chat.addChild(this.currentAssistantText);
		}
		this.currentAssistantText.append(text);
	}

	addNotice(text) {
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.dim(text), 0, 0));
	}

	addTool(title, status, id) {
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		if (!this.currentToolSummary) {
			if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
			this.currentToolSummary = new ToolSummary(() => SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length]);
			this.chat.addChild(this.currentToolSummary);
		}
		this.currentToolSummary.add(title, status, id);
	}

	updateTool(status, id, title) {
		if (!this.currentToolSummary) {
			this.addTool(title ?? "tool", status, id);
			return;
		}
		this.currentToolSummary.update(status, id, title);
	}

	addCtrlCExitHint() {
		const last = lastRenderableChild(this.chat);
		if (last instanceof CtrlCExitHint) return;
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new CtrlCExitHint());
	}

	addError(text) {
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (this.chat.children.length > 0) this.chat.addChild(new Spacer(1));
		this.chat.addChild(new Text(chalk.red(`! ${text}`), 0, 0));
	}

	stop() {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		if (this.markdownPreloadTimer) clearTimeout(this.markdownPreloadTimer);
		this.voiceController?.dispose();
		if (this.client) this.client.stop();
		this.ui.stop();
		process.exit(0);
	}
}

class MutableMarkdown {
	constructor(text) {
		this.text = text;
		this.cache = undefined;
	}

	append(text) {
		this.text += text;
		this.cache = undefined;
	}

	invalidate() {
		this.cache = undefined;
	}

	render(width) {
		const text = this.text.trimEnd();
		if (this.cache?.width === width && this.cache.text === text) return this.cache.lines.slice();
		const lines = renderMarkdown(text, width);
		this.cache = { width, text, lines };
		return lines.slice();
	}
}

class MutableUserMessage {
	constructor(text) {
		this.text = text;
		this.cache = undefined;
	}

	append(text) {
		this.text += text;
		this.cache = undefined;
	}

	invalidate() {
		this.cache = undefined;
	}

	render(width) {
		if (this.cache?.width === width && this.cache.text === this.text) return this.cache.lines.slice();
		const contentWidth = Math.max(1, width);
		const bg = bgHex(UI_COLORS.userMessageBg);
		const body = renderMarkdown(this.text, contentWidth, 0, 0, { color: (content) => content });
		const lines = [
			applyBackgroundToLine("", width, bg),
			...body.map((line) => applyBackgroundToLine(line, width, bg)),
			applyBackgroundToLine("", width, bg),
		];
		if (lines.length === 0) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		this.cache = { width, text: this.text, lines };
		return lines.slice();
	}
}

class UserMessage extends MutableUserMessage {}

class ToolSummary {
	constructor(getSpinner) {
		this.tools = [];
		this.getSpinner = getSpinner;
	}

	add(title, status = "running", id) {
		this.tools.push({ id, title: normalizeToolTitle(title), status });
	}

	update(status, id, title) {
		const tool = this.findTool(id) ?? [...this.tools].reverse().find((entry) => entry.status === "running") ?? this.tools[this.tools.length - 1];
		if (!tool) return;
		tool.status = status;
		if (title) tool.title = normalizeToolTitle(title);
	}

	findTool(id) {
		if (!id) return undefined;
		return this.tools.find((tool) => tool.id === id);
	}

	invalidate() {}

	render(width) {
		if (this.tools.length === 0) return [];
		const lines = this.tools.map((tool) => `${toolGlyph(tool.status, this.getSpinner)} ${tool.title}`);
		return lines.map((line) => chalk.dim(truncateVisual(line, width)));
	}
}

class CtrlCExitHint {
	invalidate() {}

	render(width) {
		return [chalk.dim(truncateVisual("• Press Ctrl-D to exit", width))];
	}
}

class PromptQueueSummary {
	constructor(getQueue, getSpinner) {
		this.getQueue = getQueue;
		this.getSpinner = getSpinner;
	}

	invalidate() {}

	render(width) {
		const queue = this.getQueue();
		if (queue.length === 0) return [];
		return ["", ...queue.map((entry) => {
			const prefix = entry.timing === "afterTool" ? `${this.getSpinner()} after tool` : "↵ queued";
			return chalk.dim(truncateVisual(`${prefix}: ${oneLine(entry.text)}`, width));
		})];
	}
}

class LazyCombinedAutocompleteProvider {
	constructor(commands, basePath, fdPath = null) {
		this.commands = commands;
		this.basePath = basePath;
		this.fdPath = fdPath;
		this.delegate = undefined;
	}

	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const Provider = await loadAutocompleteProvider();
		this.delegate ??= new Provider(this.commands, this.basePath, this.fdPath);
		return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		return this.delegate?.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}
}

function toolGlyph(status, getSpinner) {
	if (status === "complete") return "✓";
	if (status === "error") return "×";
	if (status === "canceled") return "×";
	return getSpinner();
}

function lastRenderableChild(container) {
	for (let index = container.children.length - 1; index >= 0; index--) {
		const child = container.children[index];
		if (!(child instanceof Spacer)) return child;
	}
	return undefined;
}

function oneLine(value) {
	return String(value).replace(/\s+/g, " ").trim();
}

function formatRpcError(method, error) {
	const message = error?.message ?? "unknown error";
	const code = error?.code === undefined ? "" : ` (${error.code})`;
	const data = error?.data === undefined ? "" : `: ${formatRpcErrorData(error.data)}`;
	return `${method} failed${code}: ${message}${data}`;
}

function formatRpcErrorData(data) {
	try {
		return truncateVisual(oneLine(typeof data === "string" ? data : JSON.stringify(data)), 180);
	} catch {
		return truncateVisual(oneLine(data), 180);
	}
}

function terminateChild(child) {
	if (!child || child.killed) return;
	try {
		if (process.platform !== "win32" && child.pid) {
			process.kill(-child.pid, "SIGTERM");
			return;
		}
	} catch {
		// Fall back to killing the direct child. This mainly matters if the
		// process has already exited or was not started as a process group.
	}
	child.kill();
}

function selectedPermissionOutcome(params = {}) {
	const options = Array.isArray(params.options) ? params.options : [];
	const selected =
		options.find((option) => option?.kind === "allow_once") ??
		options.find((option) => option?.kind === "allow_always") ??
		options.find((option) => String(option?.kind ?? "").startsWith("allow")) ??
		options[0];
	if (!selected?.optionId) return { outcome: "cancelled" };
	return { outcome: "selected", optionId: selected.optionId };
}

function normalizedToolStatus(status) {
	const value = oneLine(status).toLowerCase();
	if (["completed", "complete", "succeeded", "success", "done"].includes(value)) return "complete";
	if (["failed", "failure", "error"].includes(value)) return "error";
	if (["canceled", "cancelled"].includes(value)) return "canceled";
	return "running";
}

function toolId(update) {
	return update.toolCallId ?? update.tool_call_id ?? update.id ?? update.callId ?? update.call_id;
}

function toolTitle(update) {
	return normalizeToolTitle(update.title ?? update.name ?? update.kind ?? update.toolName ?? update.tool_name ?? "tool");
}

function normalizeToolTitle(title) {
	const value = oneLine(title).replace(/_/g, " ");
	if (!value) return "Tool";
	return value === value.toLowerCase() ? value.replace(/^\w/, (char) => char.toUpperCase()) : value;
}

function bgHex(color) {
	return (text) => chalk.bgHex(color)(text);
}

function createAnsiStyles() {
	const style = (open, close) => (text) => `${open}${text}${close}`;
	const black = Object.assign(style("\x1b[30m", "\x1b[39m"), {
		bgBlue: style("\x1b[30m\x1b[44m", "\x1b[39m\x1b[49m"),
	});
	return {
		black,
		blue: style("\x1b[34m", "\x1b[39m"),
		bold: style("\x1b[1m", "\x1b[22m"),
		cyan: style("\x1b[36m", "\x1b[39m"),
		dim: style("\x1b[2m", "\x1b[22m"),
		italic: style("\x1b[3m", "\x1b[23m"),
		red: style("\x1b[31m", "\x1b[39m"),
		strikethrough: style("\x1b[9m", "\x1b[29m"),
		underline: style("\x1b[4m", "\x1b[24m"),
		yellow: style("\x1b[33m", "\x1b[39m"),
		bgHex: (color) => {
			const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
			if (!match) return (text) => text;
			const [, r, g, b] = match;
			return style(
				`\x1b[48;2;${Number.parseInt(r, 16)};${Number.parseInt(g, 16)};${Number.parseInt(b, 16)}m`,
				"\x1b[49m",
			);
		},
	};
}

function localSlashCommands(app) {
	const state = app.sessionStates.get(app.activeKey);
	const commands = [
		{
			name: "harness",
			description: "Switch between configured agent backends",
			argumentHint: `[${Object.keys(app.config.agents).join("|")}]`,
			getArgumentCompletions: (prefix) => {
				const items = [
					...Object.entries(app.config.agents).map(([key, agent]) => ({
						value: key,
						label: key,
						description: agent.label ?? key,
					})),
					{ value: "exit", label: "exit", description: "Close cc" },
					{ value: "quit", label: "quit", description: "Close cc" },
				];
				return items.filter((item) => item.value.startsWith(prefix));
			},
		},
		{ name: "help", description: "Show available commands" },
		{ name: "status", description: "Show current session status" },
		{ name: "clear", description: "Clear the conversation" },
		{ name: "voice", description: "Enter voice input mode" },
	];
	const addIfMissing = (command) => {
		if (!commands.some((existing) => existing.name === command.name)) commands.push(command);
	};

	addIfMissing({ name: "resume", description: "Resume a previous ACP session" });
	addIfMissing({ name: "model", description: "Change model" });
	addIfMissing({ name: "mode", description: "Change agent mode" });
	addIfMissing({ name: "effort", description: "Change reasoning effort" });
	addIfMissing({ name: "reasoning", description: "Change reasoning effort" });
	addIfMissing({ name: "thinking", description: "Change reasoning effort" });
	addIfMissing({ name: "plan", description: "Switch to plan mode" });

	if (supportsSessionList(state)) {
		addIfMissing({ name: "resume", description: "Resume a previous ACP session" });
	}

	const modelOption = findConfigOption(state, "model");
	if (modelOption) replaceCommand(commands, configSlashCommand("model", "Change model", modelOption));

	const modeOption = findConfigOption(state, "mode");
	if (modeOption) replaceCommand(commands, configSlashCommand("mode", "Change agent mode", modeOption));

	const effortOption = findConfigOption(state, "thought_level");
	if (effortOption) {
		const effortCommand = configSlashCommand("effort", "Change reasoning effort", effortOption);
		replaceCommand(commands, effortCommand);
		replaceCommand(commands, { ...effortCommand, name: "reasoning" });
		replaceCommand(commands, { ...effortCommand, name: "thinking" });
	}

	const hasPlanMode = flattenConfigOptions(modeOption).some((entry) => entry.value === "plan" || entry.name.toLowerCase() === "plan");
	if (hasPlanMode) addIfMissing({ name: "plan", description: "Switch to plan mode" });

	return commands;
}

function replaceCommand(commands, command) {
	const index = commands.findIndex((entry) => entry.name === command.name);
	if (index >= 0) commands[index] = command;
	else commands.push(command);
}

function configSlashCommand(name, description, option) {
	const values = flattenConfigOptions(option);
	return {
		name,
		description,
		argumentHint: `[${values.map((entry) => entry.value).join("|")}]`,
		getArgumentCompletions: (prefix) =>
			values
				.filter((entry) => entry.value.startsWith(prefix) || entry.name.toLowerCase().includes(prefix.toLowerCase()))
				.map((entry) => ({
					value: entry.value,
					label: entry.name,
					description: entry.description,
				})),
	};
}

function dedupeCommands(commands) {
	const seen = new Set();
	const result = [];
	for (const command of commands) {
		if (!command?.name || seen.has(command.name)) continue;
		seen.add(command.name);
		result.push(command);
	}
	return result;
}

function renderMarkdown(text, width, paddingX = 0, paddingY = 0, defaultTextStyle) {
	const Markdown = MarkdownComponent;
	if (Markdown) return new Markdown(text, paddingX, paddingY, MARKDOWN_THEME, defaultTextStyle).render(width);
	loadMarkdownRenderer();
	return renderPlainText(text, width, paddingX, paddingY, defaultTextStyle);
}

function loadMarkdownRenderer(onLoaded) {
	if (MarkdownComponent) {
		onLoaded?.();
		return;
	}
	if (markdownLoadPromise) {
		if (onLoaded) void markdownLoadPromise.then(onLoaded);
		return;
	}
	markdownLoadPromise = import("@mariozechner/pi-tui/dist/components/markdown.js")
		.then((module) => {
			MarkdownComponent = module.Markdown;
			onLoaded?.();
		})
		.catch(() => {})
		.finally(() => {
			markdownLoadPromise = undefined;
		});
}

async function loadAutocompleteProvider() {
	if (CombinedAutocompleteProviderClass) return CombinedAutocompleteProviderClass;
	if (!autocompleteLoadPromise) {
		autocompleteLoadPromise = import("@mariozechner/pi-tui/dist/autocomplete.js")
			.then((module) => {
				CombinedAutocompleteProviderClass = module.CombinedAutocompleteProvider;
				return CombinedAutocompleteProviderClass;
			})
			.finally(() => {
				autocompleteLoadPromise = undefined;
			});
	}
	return autocompleteLoadPromise;
}

function renderPlainText(text, width, paddingX = 0, paddingY = 0, defaultTextStyle) {
	const contentWidth = Math.max(1, width - paddingX * 2);
	const pad = " ".repeat(Math.max(0, paddingX));
	const vertical = Array(Math.max(0, paddingY)).fill("");
	const color = defaultTextStyle?.color ?? ((content) => content);
	const body = [];
	for (const line of String(text || "").split("\n")) {
		const wrapped = wrapTextWithAnsi(line, contentWidth);
		body.push(...(wrapped.length ? wrapped : [""]));
	}
	return [
		...vertical,
		...body.map((line) => `${pad}${color(line)}${pad}`),
		...vertical,
	];
}

function parseSlashCommand(text) {
	const match = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
	return { name: match?.[1] ?? "", argument: match?.[2]?.trim() ?? "" };
}

function parseDelay(value, fallback) {
	if (value === undefined || value === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function isTerminalResponse(data) {
	return (
		/^\x1b\[6;\d+;\d+t$/.test(data) ||
		/^\x1b\[\?\d+u$/.test(data) ||
		/^\x1bP[^\x1b]*(?:\x1b\\)?$/.test(data) ||
		/^\x1b\][\s\S]*(?:\x07|\x1b\\)$/.test(data)
	);
}

function formatDuration(seconds) {
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins}:${String(secs).padStart(2, "0")}`;
}

function which(bin) {
	const paths = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of paths) {
		if (!dir) continue;
		for (const ext of exts) {
			try {
				if (fs.existsSync(path.join(dir, `${bin}${ext}`))) return true;
			} catch {}
		}
	}
	return false;
}

function enumerateWindowsAudioDevice() {
	try {
		const result = spawnSync("ffmpeg", ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], {
			stdio: ["ignore", "ignore", "pipe"],
			timeout: 5_000,
			encoding: "utf8",
		});
		const stderr = typeof result.stderr === "string" ? result.stderr : "";
		const audioHeaderIndex = stderr.search(/DirectShow audio devices|audio devices/i);
		if (audioHeaderIndex < 0) return undefined;
		const match = stderr.slice(audioHeaderIndex).match(/"([^"]+)"/);
		return match?.[1];
	} catch {
		return undefined;
	}
}

function hasPulseSocket() {
	const candidates = [];
	const pulseServer = process.env.PULSE_SERVER?.trim();
	if (pulseServer) candidates.push(pulseServer.startsWith("unix:") ? pulseServer.slice("unix:".length) : pulseServer);
	const xdg = process.env.XDG_RUNTIME_DIR?.trim();
	if (xdg) candidates.push(`${xdg}/pulse/native`);
	if (typeof process.getuid === "function") candidates.push(`/run/user/${process.getuid()}/pulse/native`);
	for (const candidate of candidates) {
		try {
			if (fs.existsSync(candidate)) return true;
		} catch {}
	}
	return false;
}

function audioCommand() {
	const deviceOverride = process.env.CC_AUDIO_DEVICE?.trim() || process.env.PI_AUDIO_DEVICE?.trim();

	if (which("rec")) return ["rec", "-q", "-t", "wav", "-"];
	if (which("ffmpeg")) {
		const base = ["-loglevel", "quiet", "-f"];
		const tail = ["-f", "wav", "-ac", "1", "-ar", "16000", "pipe:1"];

		if (process.platform === "darwin") {
			return ["ffmpeg", ...base, "avfoundation", "-i", deviceOverride || ":default", ...tail];
		}

		if (process.platform === "win32") {
			const deviceName = deviceOverride || enumerateWindowsAudioDevice();
			if (!deviceName) {
				throw new Error(
					'No DirectShow audio capture device found. Plug in a microphone, or set CC_AUDIO_DEVICE="<device name>".',
				);
			}
			return ["ffmpeg", ...base, "dshow", "-i", `audio=${deviceName}`, ...tail];
		}

		const match = deviceOverride?.match(/^(pulse|alsa):(.+)$/);
		const forcedBackend = match?.[1];
		const forcedDevice = match?.[2];
		const backend = forcedBackend ?? (hasPulseSocket() ? "pulse" : "alsa");
		const device = forcedDevice ?? deviceOverride ?? "default";
		return ["ffmpeg", ...base, backend, "-i", device, ...tail];
	}

	const installHint =
		process.platform === "darwin"
			? "Install with: brew install ffmpeg"
			: process.platform === "win32"
				? "Install with: winget install ffmpeg"
				: "Install ffmpeg or sox with your package manager.";
	throw new Error(`ffmpeg or sox is required for voice recording. ${installHint}`);
}

function recordAudio() {
	const [bin, ...args] = audioCommand();
	const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
	const chunks = [];
	child.stdout?.on("data", (data) => chunks.push(data));
	child.stderr?.on("data", () => {});

	let startError;
	child.on("error", (error) => {
		startError = error;
	});

	let stopped = false;
	const closed = new Promise((resolve) => {
		child.once("close", () => resolve());
	});

	return {
		async stop() {
			if (startError) throw startError;
			if (!stopped) {
				stopped = true;
				try {
					child.kill("SIGTERM");
				} catch {}
			}
			await closed;
			if (startError) throw startError;
			let total = 0;
			for (const chunk of chunks) total += chunk.length;
			const out = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				out.set(chunk, offset);
				offset += chunk.length;
			}
			return out;
		},
	};
}

async function transcribeAudio({
	apiKey,
	audio,
	model = DEFAULT_TRANSCRIPTION_MODEL,
	baseUrl = "https://api.openai.com/v1",
	abortSignal,
	filename = "recording.wav",
	mimeType = "audio/wav",
}) {
	if (!apiKey) throw new Error("OPENAI_API_KEY is required for voice transcription");

	const form = new FormData();
	form.append("file", new Blob([audio.slice()], { type: mimeType }), filename);
	form.append("model", model);
	form.append("response_format", "text");

	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
		method: "POST",
		headers: { Authorization: `Bearer ${apiKey}` },
		body: form,
		signal: abortSignal,
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Transcription request failed (${response.status}): ${body || response.statusText}`);
	}
	return (await response.text()).trim();
}

function isPrintableInput(data) {
	return typeof data === "string" && data.length === 1 && data >= " " && data !== "\x7f";
}

function isPlainSpaceInput(data) {
	return matchesKey(data, "space") && !isModifiedSpaceInput(data);
}

function isModifiedSpaceInput(data) {
	return matchesKey(data, "shift+space") || matchesKey(data, "alt+space") || matchesKey(data, "super+space");
}

function isSubmitInput(data) {
	return matchesKey(data, "enter") || matchesKey(data, "return");
}

function isEscape(data) {
	return matchesKey(data, "escape") || matchesKey(data, "esc");
}

function isArrowUp(data) {
	return matchesKey(data, "up");
}

function createHarnessTerminal(resizeHooks = {}) {
	const terminal = new ProcessTerminal();
	const start = terminal.start.bind(terminal);
	const stop = terminal.stop.bind(terminal);
	const write = terminal.write.bind(terminal);
	let resizeTimer;
	terminal.start = (onInput, onResize) => {
		start(onInput, () => {
			if (RESIZE_SETTLE_DELAY_MS <= 0) {
				onResize();
				return;
			}
			resizeHooks.onResizeStart?.();
			if (resizeTimer) clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => {
				resizeTimer = undefined;
				resizeHooks.onResizeEnd?.();
				onResize();
			}, RESIZE_SETTLE_DELAY_MS);
			resizeTimer.unref?.();
		});
		if (process.env.CC_PREPAINTED === "1") {
			if (process.env.CC_ADOPTED_PREPAINT !== "1") write("\x1b8\x1b[J\x1b7");
			delete process.env.CC_PREPAINTED;
			delete process.env.CC_PREPAINT_AGENT;
			delete process.env.CC_ADOPTED_PREPAINT;
		} else {
			write("\x1b7");
		}
	};
	terminal.stop = () => {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = undefined;
		resizeHooks.onResizeEnd?.();
		stop();
	};
	terminal.write = (data) => write(rewriteFullScreenClear(data));
	return terminal;
}

function rewriteFullScreenClear(data) {
	const fullClear = "\x1b[2J\x1b[H\x1b[3J";
	if (!data.includes("\x1b[3J")) return data;
	if (!data.includes(fullClear)) return data.replaceAll("\x1b[3J", "");
	return data.replaceAll(fullClear, "\x1b8\x1b[J");
}

function splitControlInput(data) {
	if (typeof data !== "string" || data.length <= 1) return undefined;
	const ctrlC = data.indexOf("\x03");
	const ctrlD = data.indexOf("\x04");
	const indexes = [ctrlC, ctrlD].filter((index) => index >= 0);
	if (indexes.length === 0) return undefined;
	const index = Math.min(...indexes);
	return {
		prefix: data.slice(0, index),
		key: data[index],
	};
}

function isCtrlC(data) {
	return data === "\x03" || matchesKey(data, "ctrl+c");
}

function isCtrlD(data) {
	return data === "\x04" || matchesKey(data, "ctrl+d");
}

function supportsSessionList(state) {
	return Boolean(state?.capabilities?.sessionCapabilities?.list && (state?.capabilities?.loadSession || state?.capabilities?.sessionCapabilities?.resume));
}

function findConfigOption(state, category) {
	return (state?.configOptions ?? []).find((option) => option?.category === category || option?.id === category);
}

function flattenConfigOptions(option) {
	if (!option?.options) return [];
	const options = option.options;
	const flattened = [];
	for (const entry of options) {
		if (Array.isArray(entry?.options)) {
			for (const child of entry.options) flattened.push(normalizeConfigValue(child, entry.name));
		} else {
			flattened.push(normalizeConfigValue(entry));
		}
	}
	return flattened.filter((entry) => entry.value && entry.name);
}

function normalizeConfigValue(value, groupName = "") {
	return {
		value: value?.value,
		name: value?.name ?? value?.value ?? "",
		description: [groupName, value?.description].filter(Boolean).join(" · ") || undefined,
	};
}

function currentConfigLabel(option) {
	if (!option?.currentValue) return undefined;
	const value = flattenConfigOptions(option).find((entry) => entry.value === option.currentValue);
	return value?.name ?? option.currentValue;
}

function compactDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function compactPath(value) {
	return value ? compactCwd(value) : "";
}

function loadConfig() {
	const file = configPath();
	if (!fs.existsSync(file)) return DEFAULT_CONFIG;
	const user = JSON.parse(fs.readFileSync(file, "utf8"));
	return deepMerge(DEFAULT_CONFIG, user);
}

function configPath() {
	if (process.env.CC_CONFIG) return process.env.CC_CONFIG;
	if (process.env.HARNESS_CONFIG) return process.env.HARNESS_CONFIG;
	const current = path.join(os.homedir(), ".config", "cc", "config.json");
	if (fs.existsSync(current)) return current;
	return path.join(os.homedir(), ".config", "uni-agent-cli", "config.json");
}

function deepMerge(base, override) {
	if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
	const merged = { ...base };
	for (const [key, value] of Object.entries(override)) {
		merged[key] = deepMerge(base?.[key], value);
	}
	return merged;
}

function compactCwd(cwd) {
	const home = os.homedir();
	return cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function truncateVisual(value, width) {
	return visibleWidth(value) <= width ? value : truncateToWidth(value, Math.max(1, width - 1)) + "~";
}

function printHelp() {
	console.log(`cc

Usage:
  cc [agent]
  cc --list

Inside the TUI:
  /harness
  /harness codex
  /harness claude
  /harness cursor
  /harness exit
`);
}

export async function runCli(args = process.argv.slice(2)) {
	if (args.includes("--help") || args.includes("-h")) {
		printHelp();
		process.exit(0);
	}

	const config = loadConfig();
	if (args.includes("--list")) {
		for (const [key, agent] of Object.entries(config.agents)) {
			const acp = agent.acp ? `${agent.acp.command} ${(agent.acp.args ?? []).join(" ")}` : "(none)";
			console.log(`${key}\t${agent.label ?? key}\tdefault=${agent.transport}\tacp=${acp}`);
		}
		process.exit(0);
	}

	const initialAgent = args.find((arg) => !arg.startsWith("-") && config.agents[arg]) ?? config.defaultAgent;

	const app = new HarnessApp(config, initialAgent);
	process.on("SIGINT", () => app.handleInterrupt("signal"));
	for (const signal of ["SIGTERM", "SIGHUP"]) {
		process.once(signal, () => app.stop());
	}
	await app.start();
}

if (isDirectRun()) {
	runCli().catch((error) => {
		console.error(`cc: ${error.message ?? error}`);
		process.exit(1);
	});
}

function isDirectRun() {
	return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}
