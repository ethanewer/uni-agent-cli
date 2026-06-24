#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Editor } from "@mariozechner/pi-tui/dist/components/editor.js";
import { Spacer } from "@mariozechner/pi-tui/dist/components/spacer.js";
import { Text } from "@mariozechner/pi-tui/dist/components/text.js";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui/dist/keys.js";
import { ProcessTerminal } from "@mariozechner/pi-tui/dist/terminal.js";
import { Container, TUI } from "@mariozechner/pi-tui/dist/tui.js";
import { normalizeTerminalOutput, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui/dist/utils.js";

const HARNESS = "/harness";
// Commands the shared UI always owns, even if a backend advertises the same name.
const RESERVED_LOCAL_COMMANDS = new Set(["harness", "help", "status", "clear", "voice", "theme", "btw", "diff", "copy"]);
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.join(SOURCE_DIR, "harnesses");
const HARNESS_PYTHON = resolveHarnessPython();
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// Cursor Agent-style two-cell wave. The first frame starts with a Braille blank.
const AGENT_WORK_FRAMES = ["⠀⠞", "⠠⠜", "⠰⠰", "⠘⠤", "⠘⠆", "⠘⠣", "⠰⠳", "⠠⠛"];
const VOICE_RECORDING_BLINK_INTERVAL_MS = 500;
const DEFAULT_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
const BACKGROUND_CONNECT_DELAY_MS = parseDelay(process.env.CC_BACKGROUND_CONNECT_DELAY_MS, 250);
const MARKDOWN_PRELOAD_DELAY_MS = parseDelay(process.env.CC_MARKDOWN_PRELOAD_DELAY_MS, 750);
const RESIZE_SETTLE_DELAY_MS = parseDelay(process.env.CC_RESIZE_SETTLE_DELAY_MS, 90);
const VS_CODE_AUTO_ACTIVATION_MAX_INPUT_GAP_MS = 15;
const VS_CODE_AUTO_ACTIVATION_MAX_SUBMIT_AGE_MS = 75;
const CLIPBOARD_IMAGE_TIMEOUT_MS = 2_500;
const STREAMING_MARKDOWN_MUTABLE_TAIL_LINES = 4;
const PI_TUI_FULL_CLEAR = "\x1b[2J\x1b[H\x1b[3J";
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
		"terminus-2": {
			label: "Terminus-2",
			transport: "acp",
			command: "terminus-2",
			args: [],
			acp: { command: HARNESS_PYTHON, args: [path.join(HARNESS_ROOT, "terminus_2", "bridge.py")] },
		},
		"mini-swe-agent": {
			label: "mini-swe-agent",
			transport: "acp",
			command: "mini",
			args: [],
			acp: { command: HARNESS_PYTHON, args: [path.join(HARNESS_ROOT, "mini_swe_agent", "bridge.py")] },
		},
	},
};

const DEFAULT_SETTINGS = {
	agents: {},
	theme: "system",
};

const THEME_ROLE_ORDER = [
	"primary",
	"secondary",
	"accent",
	"success",
	"warning",
	"error",
	"text",
	"textMuted",
	"textEmphasized",
	"border",
	"borderActive",
	"selectionText",
	"selectionBackground",
	"markdownCode",
	"markdownQuote",
];

const THEME_DISPLAY_ORDER = [
	"system",
	"opencode",
	"tokyonight",
	"everforest",
	"ayu",
	"catppuccin",
	"catppuccin-macchiato",
	"gruvbox",
	"kanagawa",
	"nord",
	"matrix",
	"one-dark",
	"dracula",
	"monokai",
];

const THEME_ALIASES = {
	onedark: "one-dark",
	"one_dark": "one-dark",
	catppuccinmacchiato: "catppuccin-macchiato",
	"catppuccin_macchiato": "catppuccin-macchiato",
	tokyo: "tokyonight",
	"tokyo-night": "tokyonight",
	cursor: "cursor-dark",
	"cursor-default": "cursor-dark",
	"cursor-dark-midnight": "cursor-midnight",
	cursormidnight: "cursor-midnight",
	"cursor_dark_midnight": "cursor-midnight",
	cursorlight: "cursor-light",
	"cursor_light": "cursor-light",
	"cursor-dark-high-contrast": "cursor-high-contrast",
	cursorhighcontrast: "cursor-high-contrast",
	vscode: "vscode-dark-modern",
	code: "vscode-dark-modern",
	"vs-code": "vscode-dark-modern",
	"visual-studio-code": "vscode-dark-modern",
	"vs-code-dark-modern": "vscode-dark-modern",
	"visual-studio-code-dark-modern": "vscode-dark-modern",
	"dark-modern": "vscode-dark-modern",
	"vs-code-dark+": "vscode-dark-plus",
	"vs-code-dark-plus": "vscode-dark-plus",
	"visual-studio-code-dark+": "vscode-dark-plus",
	"visual-studio-code-dark-plus": "vscode-dark-plus",
	"dark+": "vscode-dark-plus",
	"dark-plus": "vscode-dark-plus",
	darkplus: "vscode-dark-plus",
	"vs-code-light-modern": "vscode-light-modern",
	"visual-studio-code-light-modern": "vscode-light-modern",
	"light-modern": "vscode-light-modern",
	"vs-code-light+": "vscode-light-plus",
	"vs-code-light-plus": "vscode-light-plus",
	"visual-studio-code-light+": "vscode-light-plus",
	"visual-studio-code-light-plus": "vscode-light-plus",
	"light+": "vscode-light-plus",
	"light-plus": "vscode-light-plus",
	lightplus: "vscode-light-plus",
	"vs-code-dark-2026": "vscode-dark-2026",
	"visual-studio-code-dark-2026": "vscode-dark-2026",
	"dark-2026": "vscode-dark-2026",
	"vs-code-light-2026": "vscode-light-2026",
	"visual-studio-code-light-2026": "vscode-light-2026",
	"light-2026": "vscode-light-2026",
};

const BUILTIN_THEMES = {
	system: {
		label: "System",
		description: "Terminal palette",
		system: true,
		colors: {
			primary: "#0000aa",
			secondary: "#00aaaa",
			accent: "#00aaaa",
			success: "#00aa00",
			warning: "#aa5500",
			error: "#aa0000",
			text: "#e5e5e5",
			textMuted: "#808080",
			textEmphasized: "#ffffff",
			border: "#0000aa",
			borderActive: "#0000aa",
			selectionText: "#000000",
			selectionBackground: "#0000aa",
			markdownCode: "#aa5500",
			markdownQuote: "#808080",
		},
	},
	opencode: {
		label: "OpenCode",
		description: "Clean cyan and violet",
		colors: {
			primary: "#7dd3fc",
			secondary: "#a78bfa",
			accent: "#34d399",
			success: "#22c55e",
			warning: "#f59e0b",
			error: "#fb7185",
			text: "#e5e7eb",
			textMuted: "#94a3b8",
			textEmphasized: "#ffffff",
			border: "#334155",
			borderActive: "#7dd3fc",
			selectionText: "#0f172a",
			selectionBackground: "#7dd3fc",
			markdownCode: "#fbbf24",
			markdownQuote: "#94a3b8",
		},
	},
	"cursor-dark": {
		label: "Cursor Dark",
		description: "Cursor default dark",
		colors: {
			primary: "#81a1c1",
			secondary: "#b48ead",
			accent: "#81a1c1",
			success: "#3fa266",
			warning: "#d2943e",
			error: "#fc6b83",
			text: "#e4e4e4",
			textMuted: "#898989",
			textEmphasized: "#ffffff",
			border: "#34373b",
			borderActive: "#81a1c1",
			selectionText: "#e4e4e4",
			selectionBackground: "#404040",
			markdownCode: "#e394dc",
			markdownQuote: "#898989",
		},
	},
	"cursor-midnight": {
		label: "Cursor Dark Midnight",
		description: "Deep Cursor night",
		colors: {
			primary: "#88c0d0",
			secondary: "#7d7c9b",
			accent: "#8fbcbb",
			success: "#a3be8c",
			warning: "#ebcb8b",
			error: "#bf616a",
			text: "#d8dee9",
			textMuted: "#4c566a",
			textEmphasized: "#eceff4",
			border: "#272c36",
			borderActive: "#88c0d0",
			selectionText: "#d8dee9",
			selectionBackground: "#434c5e",
			markdownCode: "#8fbcbb",
			markdownQuote: "#4c566a",
		},
	},
	"cursor-light": {
		label: "Cursor Light",
		description: "Cursor default light",
		colors: {
			primary: "#3c7cab",
			secondary: "#b8448b",
			accent: "#3c7cab",
			success: "#1f8a65",
			warning: "#a16900",
			error: "#cf2d56",
			text: "#141414",
			textMuted: "#898989",
			textEmphasized: "#000000",
			border: "#dcdce0",
			borderActive: "#3c7cab",
			selectionText: "#141414",
			selectionBackground: "#e8e8e8",
			markdownCode: "#5e5e5e",
			markdownQuote: "#5e5e5e",
		},
	},
	"cursor-high-contrast": {
		label: "Cursor Dark High Contrast",
		description: "Cursor high contrast",
		colors: {
			primary: "#434c5e",
			secondary: "#b48ead",
			accent: "#88c0d0",
			success: "#a3be8c",
			warning: "#ebcb8b",
			error: "#bf616a",
			text: "#ffffff",
			textMuted: "#505050",
			textEmphasized: "#ffffff",
			border: "#2a2a2a",
			borderActive: "#434c5e",
			selectionText: "#ffffff",
			selectionBackground: "#404040",
			markdownCode: "#e394dc",
			markdownQuote: "#505050",
		},
	},
	"vscode-dark-modern": {
		label: "VS Code Dark Modern",
		description: "Default VS Code dark",
		colors: {
			primary: "#0078d4",
			secondary: "#c586c0",
			accent: "#4daafc",
			success: "#b5cea8",
			warning: "#dcdcaa",
			error: "#f85149",
			text: "#cccccc",
			textMuted: "#9d9d9d",
			textEmphasized: "#ffffff",
			border: "#313131",
			borderActive: "#0078d4",
			selectionText: "#cccccc",
			selectionBackground: "#3a3d41",
			markdownCode: "#ce9178",
			markdownQuote: "#6a9955",
		},
	},
	"vscode-dark-plus": {
		label: "VS Code Dark+",
		description: "Classic VS Code dark",
		colors: {
			primary: "#569cd6",
			secondary: "#c586c0",
			accent: "#4ec9b0",
			success: "#b5cea8",
			warning: "#dcdcaa",
			error: "#f44747",
			text: "#d4d4d4",
			textMuted: "#808080",
			textEmphasized: "#ffffff",
			border: "#303031",
			borderActive: "#569cd6",
			selectionText: "#d4d4d4",
			selectionBackground: "#3a3d41",
			markdownCode: "#ce9178",
			markdownQuote: "#6a9955",
		},
	},
	"vscode-light-modern": {
		label: "VS Code Light Modern",
		description: "Default VS Code light",
		colors: {
			primary: "#005fb8",
			secondary: "#af00db",
			accent: "#267f99",
			success: "#098658",
			warning: "#795e26",
			error: "#f85149",
			text: "#3b3b3b",
			textMuted: "#6e7681",
			textEmphasized: "#000000",
			border: "#e5e5e5",
			borderActive: "#005fb8",
			selectionText: "#3b3b3b",
			selectionBackground: "#e5ebf1",
			markdownCode: "#a31515",
			markdownQuote: "#008000",
		},
	},
	"vscode-light-plus": {
		label: "VS Code Light+",
		description: "Classic VS Code light",
		colors: {
			primary: "#0000ff",
			secondary: "#af00db",
			accent: "#267f99",
			success: "#098658",
			warning: "#795e26",
			error: "#cd3131",
			text: "#000000",
			textMuted: "#6f6f6f",
			textEmphasized: "#000000",
			border: "#d4d4d4",
			borderActive: "#007acc",
			selectionText: "#000000",
			selectionBackground: "#e5ebf1",
			markdownCode: "#a31515",
			markdownQuote: "#008000",
		},
	},
	"vscode-dark-2026": {
		label: "VS Code Dark 2026",
		description: "VS Code 2026 dark",
		colors: {
			primary: "#3994bc",
			secondary: "#c586c0",
			accent: "#48a0c7",
			success: "#7ee787",
			warning: "#dcdcaa",
			error: "#f48771",
			text: "#bbbebf",
			textMuted: "#8c8c8c",
			textEmphasized: "#ffffff",
			border: "#2a2b2c",
			borderActive: "#3994bc",
			selectionText: "#bbbebf",
			selectionBackground: "#276782",
			markdownCode: "#a5d6ff",
			markdownQuote: "#8b949e",
		},
	},
	"vscode-light-2026": {
		label: "VS Code Light 2026",
		description: "VS Code 2026 light",
		colors: {
			primary: "#0069cc",
			secondary: "#cf222e",
			accent: "#0a3069",
			success: "#116329",
			warning: "#795e26",
			error: "#ad0707",
			text: "#202020",
			textMuted: "#606060",
			textEmphasized: "#000000",
			border: "#e2e2e5",
			borderActive: "#0069cc",
			selectionText: "#202020",
			selectionBackground: "#d7eaff",
			markdownCode: "#0a3069",
			markdownQuote: "#6e7781",
		},
	},
	tokyonight: {
		label: "Tokyo Night",
		description: "Neon on navy",
		colors: {
			primary: "#7aa2f7",
			secondary: "#bb9af7",
			accent: "#7dcfff",
			success: "#9ece6a",
			warning: "#e0af68",
			error: "#f7768e",
			text: "#c0caf5",
			textMuted: "#565f89",
			textEmphasized: "#ffffff",
			border: "#414868",
			borderActive: "#7aa2f7",
			selectionText: "#1a1b26",
			selectionBackground: "#7aa2f7",
			markdownCode: "#e0af68",
			markdownQuote: "#565f89",
		},
	},
	everforest: {
		label: "Everforest",
		description: "Soft forest contrast",
		colors: {
			primary: "#a7c080",
			secondary: "#d699b6",
			accent: "#83c092",
			success: "#a7c080",
			warning: "#dbbc7f",
			error: "#e67e80",
			text: "#d3c6aa",
			textMuted: "#859289",
			textEmphasized: "#f2efdf",
			border: "#4f5b58",
			borderActive: "#a7c080",
			selectionText: "#2b3339",
			selectionBackground: "#a7c080",
			markdownCode: "#dbbc7f",
			markdownQuote: "#859289",
		},
	},
	ayu: {
		label: "Ayu",
		description: "Amber and ocean blue",
		colors: {
			primary: "#59c2ff",
			secondary: "#d2a6ff",
			accent: "#95e6cb",
			success: "#aad94c",
			warning: "#ffb454",
			error: "#f07178",
			text: "#b3b1ad",
			textMuted: "#626a73",
			textEmphasized: "#e6e1cf",
			border: "#3d424d",
			borderActive: "#59c2ff",
			selectionText: "#0f1419",
			selectionBackground: "#59c2ff",
			markdownCode: "#ffb454",
			markdownQuote: "#626a73",
		},
	},
	catppuccin: {
		label: "Catppuccin Mocha",
		description: "Pastel dark",
		colors: {
			primary: "#89b4fa",
			secondary: "#cba6f7",
			accent: "#94e2d5",
			success: "#a6e3a1",
			warning: "#f9e2af",
			error: "#f38ba8",
			text: "#cdd6f4",
			textMuted: "#7f849c",
			textEmphasized: "#f5e0dc",
			border: "#45475a",
			borderActive: "#89b4fa",
			selectionText: "#1e1e2e",
			selectionBackground: "#89b4fa",
			markdownCode: "#fab387",
			markdownQuote: "#7f849c",
		},
	},
	"catppuccin-macchiato": {
		label: "Catppuccin Macchiato",
		description: "Cool pastel dark",
		colors: {
			primary: "#8aadf4",
			secondary: "#c6a0f6",
			accent: "#8bd5ca",
			success: "#a6da95",
			warning: "#eed49f",
			error: "#ed8796",
			text: "#cad3f5",
			textMuted: "#8087a2",
			textEmphasized: "#f4dbd6",
			border: "#494d64",
			borderActive: "#8aadf4",
			selectionText: "#24273a",
			selectionBackground: "#8aadf4",
			markdownCode: "#f5a97f",
			markdownQuote: "#8087a2",
		},
	},
	gruvbox: {
		label: "Gruvbox",
		description: "Retro warm contrast",
		colors: {
			primary: "#83a598",
			secondary: "#b16286",
			accent: "#8ec07c",
			success: "#b8bb26",
			warning: "#fabd2f",
			error: "#fb4934",
			text: "#ebdbb2",
			textMuted: "#928374",
			textEmphasized: "#fbf1c7",
			border: "#665c54",
			borderActive: "#83a598",
			selectionText: "#282828",
			selectionBackground: "#83a598",
			markdownCode: "#fabd2f",
			markdownQuote: "#928374",
		},
	},
	kanagawa: {
		label: "Kanagawa",
		description: "Ink and muted brights",
		colors: {
			primary: "#7e9cd8",
			secondary: "#957fb8",
			accent: "#7aa89f",
			success: "#98bb6c",
			warning: "#e6c384",
			error: "#e82424",
			text: "#dcd7ba",
			textMuted: "#727169",
			textEmphasized: "#c8c093",
			border: "#54546d",
			borderActive: "#7e9cd8",
			selectionText: "#1f1f28",
			selectionBackground: "#7e9cd8",
			markdownCode: "#e6c384",
			markdownQuote: "#727169",
		},
	},
	nord: {
		label: "Nord",
		description: "Arctic blue",
		colors: {
			primary: "#88c0d0",
			secondary: "#b48ead",
			accent: "#8fbcbb",
			success: "#a3be8c",
			warning: "#ebcb8b",
			error: "#bf616a",
			text: "#d8dee9",
			textMuted: "#81a1c1",
			textEmphasized: "#eceff4",
			border: "#4c566a",
			borderActive: "#88c0d0",
			selectionText: "#2e3440",
			selectionBackground: "#88c0d0",
			markdownCode: "#ebcb8b",
			markdownQuote: "#81a1c1",
		},
	},
	matrix: {
		label: "Matrix",
		description: "Terminal green",
		colors: {
			primary: "#00ff41",
			secondary: "#5cff8d",
			accent: "#00cc33",
			success: "#00ff41",
			warning: "#b6ff5c",
			error: "#ff5555",
			text: "#c8ffd4",
			textMuted: "#4f8f5c",
			textEmphasized: "#ffffff",
			border: "#2f6f3a",
			borderActive: "#00ff41",
			selectionText: "#001a06",
			selectionBackground: "#00ff41",
			markdownCode: "#b6ff5c",
			markdownQuote: "#4f8f5c",
		},
	},
	"one-dark": {
		label: "One Dark",
		description: "Editor classic",
		colors: {
			primary: "#61afef",
			secondary: "#c678dd",
			accent: "#56b6c2",
			success: "#98c379",
			warning: "#e5c07b",
			error: "#e06c75",
			text: "#abb2bf",
			textMuted: "#5c6370",
			textEmphasized: "#ffffff",
			border: "#4b5263",
			borderActive: "#61afef",
			selectionText: "#282c34",
			selectionBackground: "#61afef",
			markdownCode: "#e5c07b",
			markdownQuote: "#5c6370",
		},
	},
	dracula: {
		label: "Dracula",
		description: "High contrast purple",
		colors: {
			primary: "#8be9fd",
			secondary: "#bd93f9",
			accent: "#50fa7b",
			success: "#50fa7b",
			warning: "#f1fa8c",
			error: "#ff5555",
			text: "#f8f8f2",
			textMuted: "#6272a4",
			textEmphasized: "#ffffff",
			border: "#6272a4",
			borderActive: "#8be9fd",
			selectionText: "#282a36",
			selectionBackground: "#8be9fd",
			markdownCode: "#f1fa8c",
			markdownQuote: "#6272a4",
		},
	},
	monokai: {
		label: "Monokai",
		description: "Bright editor palette",
		colors: {
			primary: "#66d9ef",
			secondary: "#ae81ff",
			accent: "#a6e22e",
			success: "#a6e22e",
			warning: "#e6db74",
			error: "#f92672",
			text: "#f8f8f2",
			textMuted: "#75715e",
			textEmphasized: "#ffffff",
			border: "#75715e",
			borderActive: "#66d9ef",
			selectionText: "#272822",
			selectionBackground: "#66d9ef",
			markdownCode: "#e6db74",
			markdownQuote: "#75715e",
		},
	},
};

let activeThemeName = "system";

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
			lines.push(index === this.selected ? chalk.blue(label) : chalk.text(label));
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
			if (key) void this.app.switchAgent(key, "acp", { persist: true, displayText: slashPromptDisplay("/harness", this.app.config.agents[key]?.label ?? key) });
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			const key = keys[this.selected];
			if (key) void this.app.switchAgent(key, "acp", { persist: true, displayText: slashPromptDisplay("/harness", this.app.config.agents[key]?.label ?? key) });
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
			lines.push(index === this.selected ? chalk.blue(label) : chalk.text(label));
		}

		const position = entries.length > 0 ? `${this.selected + 1}/${entries.length}` : "0/0";
		lines.push("", chalk.dim(position), chalk.dim("type to filter · enter select · esc cancel"));
		return lines.map((line) => truncateVisual(line, width));
	}

	handleInput(data) {
		if (matchesKey(data, "escape") || data === "\x03") {
			this.cancel();
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

	cancel() {
		this.onSelect(undefined);
	}

	filteredEntries() {
		if (!this.query) return this.entries;
		const query = this.query.toLowerCase();
		return this.entries.filter((entry) =>
			[entry.label, entry.description, entry.value].filter(Boolean).some((value) => String(value).toLowerCase().includes(query)),
		);
	}
}

class ThemePanel {
	constructor(app) {
		this.app = app;
		this.entries = themeEntries(app.themeName);
		this.selected = Math.max(0, this.entries.findIndex((entry) => entry.value === app.themeName));
		this.query = "";
		this.previewSelectedTheme();
	}

	invalidate() {}

	render(width) {
		const entries = this.filteredEntries();
		const maxVisible = 8;
		const half = Math.floor(maxVisible / 2);
		this.selected = entries.length > 0 ? Math.min(this.selected, entries.length - 1) : 0;
		const start = Math.max(0, Math.min(this.selected - half, entries.length - maxVisible));
		const visible = entries.slice(start, start + maxVisible);
		const selected = entries[this.selected];
		const selectedTheme = selected ? BUILTIN_THEMES[selected.value] : undefined;
		const lines = [chalk.bold("Theme"), ""];

		for (let offset = 0; offset < maxVisible; offset += 1) {
			const entry = visible[offset];
			if (!entry) {
				if (offset === 0) lines.push(chalk.dim(this.query ? "No matches" : "No themes"));
				else lines.push("");
				continue;
			}
			const index = start + offset;
			const cursor = index === this.selected ? "›" : " ";
			const active = entry.value === this.app.themeName ? "●" : " ";
			const swatches = compactThemeSwatches(entry.value);
			const label = `${cursor} ${active} ${entry.label.padEnd(22)} ${swatches}  ${entry.description ?? ""}`;
			lines.push(index === this.selected ? chalk.blue(label) : chalk.text(label));
		}

		const position = entries.length > 0 ? `${this.selected + 1}/${entries.length}` : "0/0";
		lines.push("", chalk.dim(position), chalk.dim("type to filter · enter select · q/esc cancel"));
		if (selectedTheme) {
			lines.push("", ...themePaletteLines(selected.value), "", ...themePreviewLines(selected.value, width));
		}
		return lines.map((line) => truncateVisual(line, width));
	}

	handleInput(data) {
		if (matchesKey(data, "escape") || data === "\x03" || (data === "q" && !this.query)) {
			this.cancel();
			return;
		}
		if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
			this.query = this.query.slice(0, -1);
			this.selected = 0;
			this.previewSelectedTheme();
			this.app.updateFilterEditor(this.query);
			return;
		}
		if (data === "\x15") {
			this.query = "";
			this.selected = 0;
			this.previewSelectedTheme();
			this.app.updateFilterEditor(this.query);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.previewSelectedTheme();
			return;
		}
		if (matchesKey(data, "down")) {
			const entries = this.filteredEntries();
			this.selected = entries.length > 0 ? Math.min(entries.length - 1, this.selected + 1) : 0;
			this.previewSelectedTheme();
			return;
		}
		const entries = this.filteredEntries();
		if ((matchesKey(data, "enter") || data === "\r" || data === "\n") && entries[this.selected]) {
			void this.app.applyTheme(entries[this.selected].value, {
				displayText: slashPromptDisplay("/theme", entries[this.selected].label),
			});
			return;
		}
		if (isPrintableInput(data)) {
			this.query += data;
			this.selected = 0;
			this.previewSelectedTheme();
			this.app.updateFilterEditor(this.query);
		}
	}

	clearInput() {
		if (!this.query) return false;
		this.query = "";
		this.selected = 0;
		this.previewSelectedTheme();
		this.app.updateFilterEditor(this.query);
		return true;
	}

	cancel() {
		this.app.closeMenu();
	}

	filteredEntries() {
		if (!this.query) return this.entries;
		const query = this.query.toLowerCase();
		return this.entries.filter((entry) =>
			[entry.label, entry.description, entry.value].filter(Boolean).some((value) => String(value).toLowerCase().includes(query)),
		);
	}

	previewSelectedTheme() {
		const entries = this.filteredEntries();
		const entry = entries[this.selected];
		this.app.previewTheme(entry?.value ?? this.app.themeName);
	}
}

// A forked side conversation ("/btw"). It owns its own AcpClient (a separate
// backend process whose session is a fork/resume of the main session, so it has
// full context AND tools), its own chat container, and its own streaming/turn
// state — so it can run concurrently with the main thread without clobbering it.
// It reuses the same hardened render components as the main thread.
class BtwThread {
	constructor(app, client, question) {
		this.app = app;
		this.client = client;
		this.question = question;
		this.chat = new Container();
		this.sessionId = undefined;
		this.state = "connecting"; // connecting | ready | working | done | error
		this.statusState = "connecting";
		this.busy = false;
		this.cancelRequested = false;
		this.activeToolIds = new Set();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.currentAssistantText = undefined;
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.lastAssistantText = "";
		this.pendingUserEchoes = [];
		this.queue = [];
		this.ready = false;
		this.cancelGraceTimer = undefined;
		// Page-view scroll state for this fork thread.
		this.view = { offset: 0, stick: true };
	}

	terminalRows() {
		return this.app.ui.terminal.rows;
	}

	clearCancelGraceTimer() {
		if (this.cancelGraceTimer) {
			clearTimeout(this.cancelGraceTimer);
			this.cancelGraceTimer = undefined;
		}
	}

	handleEvent(event) {
		// Until the fork is ready, drop streamed content. This discards the parent
		// transcript that session/load replays while the fork is being established,
		// so the side pane shows only the new conversation (the parent thread is
		// already visible above). Establishment errors surface via runBtw's catch.
		if (!this.ready) return;
		if (event.type === "text") this.appendAssistantText(event.text);
		else if (event.type === "line") this.addNotice(event.text);
		else if (event.type === "user_text") {
			const text = this.consumeUserEcho(event.text);
			if (text) this.appendUserText(text);
		} else if (event.type === "tool") {
			this.trackToolStatus(event.id, event.status, { startsTool: true });
			this.addTool(event.title, event.status, event.id);
		} else if (event.type === "tool_update") {
			this.trackToolStatus(event.id, event.status, { startsTool: false });
			this.updateTool(event.status, event.id, event.title);
		} else if (event.type === "error") {
			this.addError(event.message);
		} else if (event.type === "cursor_todos") {
			this.addNotice(cursorTodosText(event.todos));
		} else if (event.type === "backend_exit") {
			this.busy = false;
			this.statusState = "";
			this.state = "error";
			this.closeCurrentAssistantText();
		}
		this.app.onThreadActivity();
	}

	async submit(text, promptParts) {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (!this.client || this.client.exited) {
			this.addError("Side thread backend has exited — press esc to close.");
			this.app.onThreadActivity();
			return;
		}
		// Queue until the fork session is established (ready), or while busy.
		if (!this.ready || this.busy) {
			this.queue.push({ text: trimmed, promptParts });
			this.app.onThreadActivity();
			return;
		}
		this.addUserMessage(trimmed);
		await this.sendPrompt(trimmed, promptParts);
	}

	// Called once the fork session exists; flushes anything typed while connecting.
	markReady() {
		this.ready = true;
		if (this.state === "connecting") {
			this.state = "ready";
			this.statusState = "";
		}
		this.drainQueue();
	}

	drainQueue() {
		if (!this.ready || this.busy || this.queue.length === 0) return;
		const next = this.queue.shift();
		this.addUserMessage(next.text);
		void this.sendPrompt(next.text, next.promptParts);
	}

	async sendPrompt(text, promptParts) {
		if (!this.client || this.client.exited) return;
		this.busy = true;
		this.cancelRequested = false;
		this.activeToolIds.clear();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.closeCurrentAssistantText();
		this.state = "working";
		this.statusState = "working";
		this.app.onThreadActivity();
		const echo = this.trackUserEcho(text);
		// Only attach images if the fork's backend advertises image support.
		const payload = promptParts && imagePromptCapability(this.client.capabilities) === true ? promptParts : text;
		try {
			const result = await this.client.prompt(payload);
			if (!this.cancelRequested && result?.stopReason === "refusal") this.addNotice("The model declined to respond.");
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.clearCancelGraceTimer();
			this.expireUserEcho(echo);
			if (this.cancelRequested) {
				for (const id of this.activeToolIds) this.updateTool("canceled", id);
			}
			this.activeToolIds.clear();
			this.activeAnonymousToolCount = 0;
			this.busy = false;
			this.closeCurrentAssistantText();
			this.state = "done";
			this.statusState = "";
			this.app.onThreadActivity();
			if (!this.cancelRequested) this.drainQueue();
		}
	}

	interrupt() {
		if (!this.busy || !this.client || this.cancelRequested) return;
		this.cancelRequested = true;
		this.statusState = "canceling";
		this.client.cancel();
		this.app.onThreadActivity();
		// Force-settle if the backend acknowledges cancel but never finishes.
		this.clearCancelGraceTimer();
		this.cancelGraceTimer = setTimeout(() => this.client?.forceResolvePrompt?.(), 8000);
		this.cancelGraceTimer?.unref?.();
	}

	stop() {
		this.clearCancelGraceTimer();
		this.client?.stop?.();
	}

	trackUserEcho(text) {
		const entry = { remaining: text };
		this.pendingUserEchoes.push(entry);
		return entry;
	}

	expireUserEcho(entry) {
		if (!entry) return;
		const index = this.pendingUserEchoes.indexOf(entry);
		if (index !== -1) this.pendingUserEchoes.splice(index, 1);
	}

	consumeUserEcho(text) {
		let remaining = text;
		while (remaining && this.pendingUserEchoes.length > 0) {
			const pending = this.pendingUserEchoes[0].remaining;
			if (pending.startsWith(remaining)) {
				const next = pending.slice(remaining.length);
				if (next) this.pendingUserEchoes[0].remaining = next;
				else this.pendingUserEchoes.shift();
				return "";
			}
			if (remaining.startsWith(pending)) {
				remaining = remaining.slice(pending.length);
				this.pendingUserEchoes.shift();
				continue;
			}
			this.pendingUserEchoes.shift();
		}
		return remaining;
	}

	trackToolStatus(id, status, options = {}) {
		this.seenToolThisTurn = true;
		if (!id) {
			if (status === "running") {
				if (options.startsTool !== false) this.activeAnonymousToolCount += 1;
			} else if (this.activeAnonymousToolCount > 0 && options.startsTool !== true) {
				this.activeAnonymousToolCount = Math.max(0, this.activeAnonymousToolCount - 1);
			} else if (options.startsTool === false) {
				const latestActiveId = [...this.activeToolIds].pop();
				if (latestActiveId) this.activeToolIds.delete(latestActiveId);
			}
		} else if (status === "running") {
			this.activeToolIds.add(id);
		} else {
			this.activeToolIds.delete(id);
		}
	}

	addUserMessage(text) {
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("user");
		this.chat.addChild(new UserMessage(text));
	}

	appendUserText(text) {
		this.closeCurrentAssistantText();
		this.currentToolSummary = undefined;
		if (!this.currentUserText) {
			this.addHistorySpacer("user");
			this.currentUserText = new MutableUserMessage("", () => this.terminalRows());
			this.chat.addChild(this.currentUserText);
		}
		this.currentUserText.append(text);
	}

	appendAssistantText(text) {
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (!this.currentAssistantText) {
			this.addHistorySpacer("assistant");
			this.currentAssistantText = new MutableMarkdown("");
			this.chat.addChild(this.currentAssistantText);
		}
		this.currentAssistantText.append(text);
	}

	addNotice(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("notice");
		this.chat.addChild(new Text(chalk.dim(text), 0, 0));
	}

	addError(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("error");
		this.chat.addChild(new Text(chalk.red(`! ${text}`), 0, 0));
	}

	addTool(title, status, id) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		if (!this.currentToolSummary) {
			this.addHistorySpacer("tool");
			this.currentToolSummary = new ToolSummary(() => this.terminalRows());
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

	closeCurrentAssistantText() {
		const text = this.currentAssistantText?.text?.trim();
		if (text) this.lastAssistantText = this.currentAssistantText.text;
		this.currentAssistantText?.invalidate();
		this.currentAssistantText = undefined;
	}

	addHistorySpacer(kind) {
		const last = lastRenderableChild(this.chat);
		if (!last) return;
		if (last instanceof CommandMessage) {
			if (kind === "command" || kind === "assistant" || kind === "notice" || kind === "tool") return;
		}
		this.chat.addChild(new Spacer(1));
	}
}

// The single top-level view. Normally it renders the stacked layout (chat,
// menus, queue, editor, status) exactly as before — so the no-fork experience is
// unchanged. While a /btw fork is open it switches to a Codex-style PAGE VIEW: a
// frame exactly terminal.rows tall (a header tab-bar + one app-scrolled thread
// transcript + the pinned menu/queue/editor/status). Because the frame never
// exceeds the screen height, nothing spills into terminal scrollback and the
// per-thread scroll offset is the only way to see earlier content — clean,
// switchable paging without the alternate screen.
class RootView {
	constructor(app) {
		this.app = app;
	}

	invalidate() {}

	render(width) {
		const app = this.app;
		if (!app.pageViewActive) {
			return [
				...app.chat.render(width),
				...app.commandPanel.render(width),
				...app.queueSummary.render(width),
				...app.editor.render(width),
				...app.status.render(width),
			];
		}
		return this.renderPage(width);
	}

	renderPage(width) {
		const app = this.app;
		const rows = app.ui.terminal.rows || 24;
		const onBtw = app.focusedThread === "btw" && Boolean(app.btwThread);
		const chat = onBtw ? app.btwThread.chat : app.chat;
		const view = onBtw ? app.btwThread.view : app.mainView;
		// Pinned bottom UI — each component already returns width-correct lines.
		const menuLines = app.commandPanel.render(width);
		const queueLines = onBtw ? [] : app.queueSummary.render(width);
		const editorLines = app.editor.render(width);
		const statusLines = app.status.render(width);
		const body = chat.render(width);
		const viewportH = Math.max(0, rows - 1 - menuLines.length - queueLines.length - editorLines.length - statusLines.length);
		const maxOffset = Math.max(0, body.length - viewportH);
		if (view.stick) view.offset = maxOffset;
		view.offset = Math.min(Math.max(0, view.offset), maxOffset);
		// At the bottom re-engages follow (covers End and paging to the bottom).
		if (view.offset >= maxOffset) view.stick = true;
		const slice = body.slice(view.offset, view.offset + viewportH);
		while (slice.length < viewportH) slice.push("");
		const frame = [this.headerLine(width, maxOffset, view.offset), ...slice, ...menuLines, ...queueLines, ...editorLines, ...statusLines];
		// Never exceed the screen height — surplus rows would scroll into terminal
		// scrollback (e.g. a tall permission menu on a short terminal). Keep the
		// bottom (editor + status + cursor marker) visible.
		return frame.length > rows ? frame.slice(frame.length - rows) : frame;
	}

	headerLine(width, maxOffset, offset) {
		const app = this.app;
		const onBtw = app.focusedThread === "btw" && Boolean(app.btwThread);
		const mainTab = (onBtw ? chalk.dim : chalk.blue)(`${onBtw ? "  " : "› "}main`);
		const btwTab = (onBtw ? chalk.blue : chalk.dim)(`${onBtw ? "› " : "  "}btw (fork)`);
		const left = `${mainTab}   ${btwTab}`;
		const pct = maxOffset > 0 ? ` ${Math.round((offset / maxOffset) * 100)}%` : "";
		const right = chalk.dim(`shift+tab switch · pgup/pgdn scroll · esc close${pct}`);
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
		return truncateVisual(`${left}${" ".repeat(gap)}${right}`, width);
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
		// Decode each stream incrementally so multibyte UTF-8 split across chunk
		// boundaries is not corrupted into replacement characters.
		const stdoutDecoder = new StringDecoder("utf8");
		const stderrDecoder = new StringDecoder("utf8");
		this.child.stdout.on("data", (chunk) => this.appendOutput(stdoutDecoder.write(chunk)));
		this.child.stderr.on("data", (chunk) => this.appendOutput(stderrDecoder.write(chunk)));
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

	appendOutput(text) {
		this.output += text;
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

export class AcpClient {
	constructor(agent, onEvent, options = {}) {
		this.agent = agent;
		this.onEvent = onEvent;
		this.onPermissionRequest = options.onPermissionRequest;
		this.onCursorRequest = options.onCursorRequest;
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
		this.bufferingSessionUpdates = false;
		this.bufferedSessionUpdates = [];
		this.terminals = new Map();
		this.nextTerminalId = 1;
		this.exited = false;
		this.stopping = false;
		this.stderrTail = "";
	}

	start() {
		const command = this.agent.acp ?? this.agent;
		const env = { ...process.env, ...(this.agent.env ?? {}), ...(command.env ?? {}) };
		this.child = spawn(command.command, command.args ?? [], {
			cwd: process.cwd(),
			env,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.child.once("error", (error) => {
			this.rejectPending(error);
			this.onEvent({ type: "error", message: error.message });
		});
		// Mark dead immediately on exit so in-flight writes stop, but reject pending
		// requests on close (after stdio drains) so the crash stderr is complete.
		this.child.once("exit", () => {
			this.exited = true;
		});
		this.child.once("close", (code, signal) => {
			this.exited = true;
			const reason = signal ?? code ?? "unknown";
			const tail = this.stderrTail.trim();
			const lastLines = tail ? tail.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ") : "";
			const stderr = lastLines ? `: ${oneLine(lastLines)}` : "";
			const hadPending = this.pending.size > 0;
			this.rejectPending(new Error(`backend exited (${reason})${stderr}`));
			if (!this.stopping) this.onEvent({ type: "backend_exit" });
			if (!this.stopping && !hadPending) this.onEvent({ type: "line", text: `• backend exited (${reason})${stderr}` });
		});
		this.child.stderr.on("data", (chunk) => {
			this.stderrTail = (this.stderrTail + String(chunk)).slice(-4096);
		});
		this.child.stdin.on("error", (error) => this.rejectPending(error));
		const rl = readline.createInterface({ input: this.child.stdout });
		rl.on("line", (line) => this.handleLine(line));
	}

	async initialize(options = {}) {
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
		// createSession:false lets a caller (e.g. /btw) decide between newSession,
		// forkSession, or loadSession after seeing the advertised capabilities.
		if (options.createSession !== false) await this.newSession();
		return initialized;
	}

	async newSession(options = {}) {
		return await this.switchSession("session/new", this.sessionRequestParams(), undefined, options);
	}

	supportsFork() {
		return Boolean(this.capabilities?.sessionCapabilities?.fork);
	}

	// Create a new session branched from an existing one's full history (ACP
	// unstable session/fork). The new session gets a fresh id; the parent is
	// untouched and the default tool preset is preserved.
	async forkSession(parentSessionId, options = {}) {
		return await this.switchSession("session/fork", this.sessionRequestParams({ sessionId: parentSessionId }), undefined, options);
	}

	async prompt(prompt) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		const parts = Array.isArray(prompt) ? prompt : [{ type: "text", text: prompt }];
		return await this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: parts,
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
		const params = this.sessionRequestParams({ sessionId });
		return await this.switchSession(this.capabilities?.loadSession ? "session/load" : "session/resume", params, sessionId);
	}

	async resumeSession(sessionId) {
		return await this.switchSession("session/resume", this.sessionRequestParams({ sessionId }), sessionId);
	}

	async switchSession(method, params, targetSessionId = undefined, options = {}) {
		this.bufferingSessionUpdates = true;
		this.bufferedSessionUpdates = [];
		let result;
		try {
			result = await this.request(method, params);
		} catch (error) {
			this.bufferingSessionUpdates = false;
			this.bufferedSessionUpdates = [];
			throw error;
		}
		const sessionId = targetSessionId ?? result?.sessionId ?? result?.id;
		if (!sessionId) {
			this.bufferingSessionUpdates = false;
			this.bufferedSessionUpdates = [];
			throw new Error("ACP session/new did not return a session id");
		}
		this.sessionId = sessionId;
		this.applySessionState(result);
		// Keep buffering across beforeReplay so a live update arriving during its
		// await cannot jump ahead of the older buffered updates. Drain via shift()
		// so anything appended mid-drain stays FIFO-ordered.
		await options.beforeReplay?.(result);
		this.bufferingSessionUpdates = false;
		while (this.bufferedSessionUpdates.length > 0) {
			this.handleSessionUpdate(this.bufferedSessionUpdates.shift());
		}
		this.bufferedSessionUpdates = [];
		await this.applyStartupMode();
		return result;
	}

	sessionRequestParams(params = {}) {
		return {
			...params,
			cwd: process.cwd(),
			mcpServers: [],
			...(this.agent._sessionMeta ? { _meta: this.agent._sessionMeta } : {}),
		};
	}

	async applyStartupMode() {
		if (this.agent._startupMode) await this.setMode(this.agent._startupMode);
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

	// Locally settle a still-pending session/prompt request (e.g. a backend that
	// acknowledged session/cancel but never sent the final response). Resolves
	// rather than rejects so no spurious error is surfaced.
	forceResolvePrompt() {
		for (const [id, pending] of this.pending) {
			if (pending.method === "session/prompt") {
				this.pending.delete(id);
				pending.resolve({ stopReason: "cancelled" });
				return true;
			}
		}
		return false;
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
		this.writeSafe({ jsonrpc: "2.0", method, params });
	}

	write(message) {
		if (!this.child || this.exited) throw new Error("ACP backend is not running");
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	// Best-effort write for replies/notifications: the backend may exit while a
	// response is in flight, so never let the write throw out to a caller.
	writeSafe(message) {
		if (!this.child || this.exited || this.stopping) return;
		try {
			this.write(message);
		} catch {
			// The backend exited mid-flight; replies/notifications are best-effort.
		}
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
		// A JSON-RPC response is distinguished from a request solely by the absence
		// of `method`: the backend numbers its own outbound requests independently of
		// ours, so an incoming request id can collide with one of our in-flight
		// request ids. Without the `method === undefined` guard such a request would
		// be misrouted as a response — resolving our prompt early and leaving the
		// backend's request unanswered (a hang). Real backends never put `method` on
		// a response, so this guard never rejects a genuine reply.
		if (message.id !== undefined && message.method === undefined && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(formatRpcError(pending.method, message.error)));
			else pending.resolve(message.result);
			return;
		}
		if (message.method === "session/update") {
			if (this.sessionUpdateTargetsCurrentSession(message.params)) this.onEvent({ type: "backend_activity" });
			this.handleSessionUpdate(message.params);
			return;
		}
		if (message.id !== undefined && message.method?.startsWith("terminal/")) {
			this.onEvent({ type: "backend_activity" });
			void this.handleTerminalRequest(message);
			return;
		}
		if (message.id !== undefined && message.method === "session/request_permission") {
			this.onEvent({ type: "backend_activity" });
			void this.handlePermissionRequest(message);
			return;
		}
		if (message.id !== undefined && message.method?.startsWith("cursor/")) {
			this.onEvent({ type: "backend_activity" });
			void this.handleCursorRequest(message);
			return;
		}
		if (message.id !== undefined && message.method) {
			// Any other id-bearing request must be answered or the backend hangs
			// waiting (e.g. an optional/extension method we do not implement).
			// Reply method-not-found so the agent can fall back gracefully.
			this.onEvent({ type: "backend_activity" });
			this.writeSafe({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
		}
	}

	async handlePermissionRequest(message) {
		try {
			const outcome = this.onPermissionRequest
				? await this.onPermissionRequest(message.params)
				: { outcome: "cancelled" };
			this.replyPermissionRequest(message.id, outcome);
		} catch {
			this.replyPermissionRequest(message.id, { outcome: "cancelled" });
		}
	}

	replyPermissionRequest(id, outcome) {
		if (!this.child || this.exited || this.stopping) return;
		try {
			this.write({ jsonrpc: "2.0", id, result: { outcome } });
		} catch {
			// The backend may exit while the user is answering the permission
			// prompt. Permission replies are best-effort at that point.
		}
	}

	// Cursor sends every cursor/* extension as a JSON-RPC request (with an id),
	// so each must be answered or the agent's tool call hangs. The fire-and-forget
	// ones are rendered and acked with {}; ask_question/create_plan block on a real
	// user outcome (correct tagged-union result shapes), defaulting to cancelled.
	async handleCursorRequest(message) {
		const method = message.method;
		const params = message.params ?? {};
		if (method === "cursor/update_todos") {
			this.onEvent({ type: "cursor_todos", todos: Array.isArray(params.todos) ? params.todos : [] });
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		}
		if (method === "cursor/task") {
			this.onEvent({ type: "line", text: cursorTaskLine(params) });
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		}
		if (method === "cursor/generate_image") {
			const description = params.description ? `: ${oneLine(params.description)}` : "";
			this.onEvent({ type: "line", text: `• Generating image${description}` });
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result: {} });
			return;
		}
		if (method === "cursor/ask_question" || method === "cursor/create_plan") {
			let result = cursorCancelResult(method);
			if (this.onCursorRequest) {
				try {
					result = (await this.onCursorRequest(method, params)) ?? cursorCancelResult(method);
				} catch {
					result = cursorCancelResult(method);
				}
			}
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result });
			return;
		}
		// Unknown cursor/* request: ack so the agent never hangs.
		this.writeSafe({ jsonrpc: "2.0", id: message.id, result: {} });
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
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result });
		} catch (error) {
			this.writeSafe({
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
		if (this.bufferingSessionUpdates) {
			this.bufferedSessionUpdates.push(params);
			return;
		}
		if (!this.sessionUpdateTargetsCurrentSession(params)) return;
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

	sessionUpdateTargetsCurrentSession(params) {
		const sessionId = params?.sessionId ?? params?.session?.sessionId ?? params?.session?.id;
		return !(sessionId && this.sessionId && sessionId !== this.sessionId);
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

	queue() {
		if (this.state !== "recording") return;
		this.stopAndTranscribe({ intent: "queue" });
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
				} else if (intent === "queue") {
					outcome = "queue";
					this.options.onQueue(text ?? "");
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
				else if (intent === "queue") this.options.onQueue("");
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
		}, VOICE_RECORDING_BLINK_INTERVAL_MS);
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

export class HarnessApp {
	constructor(config, initialAgent, initialTransport) {
		this.config = config;
		this.themeName = resolveThemeName(config.theme ?? config.settings?.theme) ?? "system";
		this.previewThemeName = undefined;
		setActiveTheme(this.themeName);
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
		this.pendingUserEchoes = [];
		this.pendingUnsendPrompt = undefined;
		this.codexThreadStateSnapshot = undefined;
		this.lastInputClearSource = undefined;
		this.lastKnownEditorText = "";
		this.suppressNextPairedEmptyInterrupt = false;
		this.spinnerTimer = undefined;
		this.spinnerIndex = 0;
		this.statusState = "";
		this.promptQueue = [];
		this.flushingPromptQueue = false;
		this.promptQueueDrainScheduled = false;
		this.pendingNewSessionCommandName = undefined;
		this.sessionSwitchInProgress = false;
		this.deferredLocalSlashCommands = [];
		this.permissionQueue = [];
		this.permissionPromptActive = false;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.cancelGraceTimer = undefined;
		this.activeToolIds = new Set();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.pendingPromptDisplay = undefined;
		this.availableCommands = new Map();
		this.commandsLoaded = new Set();
		this.lastAutocompleteKey = undefined;
		this.sessionStates = new Map();
		this.voiceController = undefined;
		this.voiceModeEnabled = true;
		this.voiceOriginalOnSubmit = undefined;
		this.voicePendingSubmit = undefined;
		this.voiceTargetEditor = undefined;
		this.startupConnectTimer = undefined;
		this.markdownPreloadTimer = undefined;
		this.resizeActive = false;
		this.vsCodeActivationInputBurst = undefined;
		this.clipboardImages = [];
		this.clipboardImageCounter = 0;
		this.clipboardPasteInProgress = false;
		this.bufferedClipboardPasteInput = [];
		this.lastAssistantText = "";
		this.btwThread = undefined;
		this.focusedThread = "main";
		// Page-view scroll state for the main thread (offset from top; stick=follow tail).
		this.mainView = { offset: 0, stick: true };

		const terminal = createHarnessTerminal({
			onResizeStart: () => this.beginResize(),
			onResizeEnd: (options) => this.endResize(options),
		});
		this.ui = new TUI(terminal, true);
		this.ui.queryCellSize = () => {};
		this.installResizeRenderGate();
		this.chat = new Container();
		this.commandPanel = new Container();
		this.editor = new VoiceEditor(this.ui, EDITOR_THEME, { paddingX: 0, autocompleteMaxVisible: 8 });
		this.status = new StatusLine(() => {
			const btwFocused = this.focusedThread === "btw" && this.btwThread;
			const state = btwFocused ? this.btwThread.statusState : this.statusState;
			return {
				agent: btwFocused ? `${this.activeKey} · btw` : this.activeKey,
				state,
				spinner: state ? AGENT_WORK_FRAMES[this.spinnerIndex % AGENT_WORK_FRAMES.length] : "",
				transport: this.transport,
			};
		});
		this.queueSummary = new PromptQueueSummary(
			() => this.promptQueue,
			() => SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length],
		);
		// Single root view: it renders the normal stacked layout, or — while a /btw
		// fork is open — a fixed-height, app-scrolled page view of one thread.
		this.rootView = new RootView(this);
		this.ui.addChild(this.rootView);
		this.ui.setFocus(this.editor);
		this.updateAutocomplete();
		this.initVoiceInput();
		this.adoptPrepaintedFrame();

		this.editor.onSubmit = (text) => {
			void this.handleSubmit(text);
		};
		this.ui.addInputListener((data) => this.handleGlobalInput(data));
	}

	// The page view is active exactly when a /btw fork is open.
	get pageViewActive() {
		return Boolean(this.btwThread);
	}

	focusedView() {
		return this.focusedThread === "btw" && this.btwThread ? this.btwThread.view : this.mainView;
	}

	// App-managed scroll for the page view. Returns true if the key was handled.
	// PgUp/PgDn always scroll; Home/End and Up/Down only when the input is empty,
	// so line-editing keys (Home/End/Ctrl+A-E, arrows) keep working while typing.
	// Arrow-Up is left for the main queue's "edit last queued" when one is queued.
	handlePageScroll(data) {
		if (!this.pageViewActive) return false;
		const view = this.focusedView();
		const page = Math.max(1, (this.ui.terminal.rows || 24) - 4);
		const editorEmpty = !this.editor.getText();
		const queuedMain = this.focusedThread === "main" && this.promptQueue.length > 0;
		let handled = true;
		if (matchesKey(data, "pageup")) view.offset -= page;
		else if (matchesKey(data, "pagedown")) view.offset += page;
		else if (editorEmpty && matchesKey(data, "home")) view.offset = 0;
		else if (editorEmpty && matchesKey(data, "end")) view.offset = Number.MAX_SAFE_INTEGER;
		else if (editorEmpty && !queuedMain && isArrowUp(data)) view.offset -= 1;
		else if (editorEmpty && matchesKey(data, "down")) view.offset += 1;
		else handled = false;
		if (!handled) return false;
		view.offset = Math.max(0, view.offset);
		// End pins follow; renderPage re-engages follow when any scroll lands at the bottom.
		view.stick = view.offset === Number.MAX_SAFE_INTEGER;
		this.ui.requestRender();
		return true;
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
			if (this.resizeActive) {
				if (!force) return;
				// A forced render slipped through mid-resize (e.g. theme preview).
				// Prime the resize-aware full clear so it doesn't use the stale
				// DECRC restore that mis-clears after the terminal reflowed.
				this.prepareResizeFullClear();
			}
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

	endResize(options = {}) {
		this.resizeActive = false;
		if (options.render !== false) {
			this.prepareResizeFullClear();
			this.ui.requestRender(true);
		}
	}

	prepareResizeFullClear() {
		const terminal = this.ui.terminal;
		if (typeof terminal.useFullClearReplacementOnce !== "function") return;
		if (shouldUseNativeResizeFullClear(this.ui, terminal)) {
			terminal.useFullClearReplacementOnce(PI_TUI_FULL_CLEAR);
			return;
		}
		const height = Math.max(1, this.ui.previousHeight || terminal.rows || 1);
		const screenRow = Math.max(
			0,
			Math.min(height - 1, (this.ui.hardwareCursorRow || 0) - (this.ui.previousViewportTop || 0)),
		);
		const moveToFrameTop = screenRow > 0 ? `\x1b[${screenRow}A` : "";
		terminal.useFullClearReplacementOnce(`\r${moveToFrameTop}\x1b[J\x1b7`);
	}

	// Hard absolute-clear + renderer reset. Used only on page-view <-> natural-flow
	// transitions, where the frame height changes drastically and the differential
	// clear (a relative cursor restore) would leave stale rows on screen.
	forceFullRepaint() {
		const ui = this.ui;
		ui.terminal.write("\x1b[2J\x1b[H");
		ui.previousLines = [];
		ui.maxLinesRendered = 0;
		ui.previousViewportTop = 0;
		ui.hardwareCursorRow = 0;
		ui.cursorRow = 0;
		ui.requestRender(true);
	}

	adoptPrepaintedFrame() {
		if (process.env.CC_PREPAINTED !== "1") return;
		if (process.env.CC_PREPAINT_AGENT !== this.activeKey || this.transport !== "acp") return;
		if ((process.env.CC_PREPAINT_THEME || "system") !== this.themeName) return;
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
		this.cancelPermissionPrompts();
		this.closeMenu();
		// A /btw fork is branched from the current agent's session; switching
		// agents invalidates it, so tear it down.
		if (this.btwThread) this.closeBtw();
		if (this.client) this.client.stop();
		this.activeKey = key;
		this.transport = transport;
		// Remember an explicit harness pick so it carries over to the next `cc`
		// session, mirroring how /theme persists. Best-effort: a failed write
		// should not block switching.
		if (options.persist) {
			try {
				saveSettingsPatch({ defaultAgent: key });
				this.config.defaultAgent = key;
				this.config.settings = { ...(this.config.settings ?? {}), defaultAgent: key };
			} catch (error) {
				this.addError(`Could not save harness: ${error.message ?? error}`);
			}
		}
		this.ready = false;
		this.busy = false;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.clearCancelGraceTimer();
		this.pendingNewSessionCommandName = undefined;
		this.sessionSwitchInProgress = false;
		this.deferredLocalSlashCommands = [];
		this.activeToolIds.clear();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.pendingUserEchoes = [];
		this.pendingUnsendPrompt = undefined;
		this.codexThreadStateSnapshot = undefined;
		this.statusState = options.statusState ?? (this.promptQueue.length > 0 ? "connecting" : "");
		this.updateSpinner();
		this.updateAutocomplete();
		if (!options.quiet) this.addCommandMessage(options.displayText ?? slashPromptDisplay("/harness", agent.label ?? key));
		this.ui.requestRender();

		if (transport !== "acp") {
			this.addNotice("PTY fallback is intentionally not used by the shared Pi TUI.");
			this.transport = "acp";
		}
		let client;
		client = new AcpClient(agent, (event) => {
			if (this.client === client) this.handleBackendEvent(event);
		}, {
			onPermissionRequest: (params) => {
				if (this.client !== client) return { outcome: "cancelled" };
				if (agent._autoPermissionRequests) return autoPermissionOutcome(params);
				return this.requestPermission(params);
			},
			onCursorRequest: (method, params) => {
				if (this.client !== client) return cursorCancelResult(method);
				if (agent._autoPermissionRequests) return autoCursorOutcome(method, params);
				return this.requestCursorInteraction(method, params);
			},
		});
		this.client = client;
		try {
			await client.initialize();
			if (this.client !== client) return;
			this.ready = true;
			this.statusState = "";
			this.updateSpinner();
			// Load the markdown renderer now (before the first token) so it never
			// flips plain->markdown mid-stream and re-styles already-scrolled lines.
			loadMarkdownRenderer(() => this.ui.requestRender());
			this.schedulePromptQueueDrain();
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
		if (isMouseInput(data)) return { consume: true };
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
		// While a clipboard paste is resolving (an async image read kicked off by
		// Ctrl+V), buffer every subsequent keystroke and replay it in order once the
		// read settles. This must precede all interactive interpretation below —
		// otherwise busy-steering would consume a buffered Tab/Esc and act on stale
		// editor text (the not-yet-applied buffered input), scrambling the result.
		if (this.clipboardPasteInProgress) {
			this.bufferClipboardPasteInput(data);
			return { consume: true };
		}
		// Shift+Tab toggles focus between the main thread and the /btw fork.
		if (this.btwThread && matchesKey(data, "shift+tab")) {
			this.focusedThread = this.focusedThread === "btw" ? "main" : "btw";
			this.ui.requestRender();
			return { consume: true };
		}
		// Page-view scrolling (PgUp/PgDn/Home/End, and Up/Down when the input is empty).
		if (this.handlePageScroll(data)) {
			return { consume: true };
		}
		// When the /btw fork is focused, Esc cancels its turn (second Esc force-
		// settles a stuck cancel) or closes it when idle. Voice cancel takes
		// precedence so a recording can still be aborted. (Copy is via /copy,
		// which routes to the focused thread — a bare letter would eat typing.)
		if (this.btwThread && this.focusedThread === "btw" && isEscape(data)) {
			if (this.voiceController?.isRecording() || this.voiceController?.isTranscribing()) {
				// fall through to voice handling below
			} else if (this.btwThread.busy) {
				if (this.btwThread.cancelRequested) this.btwThread.client?.forceResolvePrompt?.();
				else this.btwThread.interrupt();
				return { consume: true };
			} else {
				this.closeBtw();
				return { consume: true };
			}
		}
		const voiceWasRecording = this.voiceController?.isRecording();
		const voiceWasActive = voiceWasRecording || this.voiceController?.isTranscribing();
		const voiceKeyInfo = {
			isSpace: isPlainSpaceInput(data),
			isModifiedSpace: isModifiedSpaceInput(data),
			isCtrlSpace: matchesKey(data, "ctrl+space"),
			isSubmit: isSubmitInput(data),
			isTab: isTabInput(data),
			isCancel: isCtrlC(data) || isEscape(data),
		};
		if (voiceWasActive && this.handleVoiceKey(data, voiceKeyInfo)) return { consume: true };
		// Busy-input steering applies to the focused main thread only.
		if (this.focusedThread === "main" && this.busy && isEscape(data)) {
			if (this.tryUnsendPendingPrompt()) return { consume: true };
			this.interruptViaEscape();
			return { consume: true };
		}
		if (this.focusedThread === "main" && this.busy && isTabInput(data) && this.editor.getText().trim() && !this.editor.autocompleteState) {
			this.queueCurrentInput("afterTurn");
			return { consume: true };
		}
		if (!voiceWasActive && this.handleVoiceKey(data, voiceKeyInfo)) return { consume: true };
		if (isClipboardPasteInput(data)) {
			void this.handleClipboardPaste();
			return { consume: true };
		}
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
		if (this.consumeVsCodeAutoActivationInput(data)) return { consume: true };
		if (this.focusedThread === "main" && isArrowUp(data) && !this.editor.getText() && this.unqueuePromptForEditing()) {
			return { consume: true };
		}
		this.rememberEditorTextAfterInput();
		return undefined;
	}

	consumeVsCodeAutoActivationInput(data) {
		if (!isVsCodeTerminal() || this.menuHandle) return false;
		if (isPrintableInput(data)) {
			this.trackVsCodeActivationBurst(data);
			return false;
		}
		if (!isSubmitInput(data)) {
			this.vsCodeActivationInputBurst = undefined;
			return false;
		}
		const text = this.editor.getText().trim();
		const burst = this.vsCodeActivationInputBurst;
		this.vsCodeActivationInputBurst = undefined;
		if (!shouldDropVsCodeAutoActivationInput(text, { burst, now: performance.now() })) return false;
		this.editor.setText("");
		this.lastKnownEditorText = "";
		this.ui.requestRender();
		return true;
	}

	trackVsCodeActivationBurst(data) {
		const now = performance.now();
		const burst = this.vsCodeActivationInputBurst;
		if (!burst || now - burst.lastAt > VS_CODE_AUTO_ACTIVATION_MAX_INPUT_GAP_MS) {
			this.vsCodeActivationInputBurst = { text: data, firstAt: now, lastAt: now, maxGapMs: 0 };
			return;
		}
		const gap = now - burst.lastAt;
		burst.text += data;
		burst.lastAt = now;
		burst.maxGapMs = Math.max(burst.maxGapMs, gap);
	}

	handleInterrupt(source = "input") {
		if (this.menuHandle) {
			if (this.menuHandle.clearInput?.()) {
				this.ui.requestRender();
				return;
			}
			if (this.menuHandle.cancel) {
				this.menuHandle.cancel();
				return;
			}
			this.closeMenu();
			return;
		}
		if (this.editor.getText()) {
			this.editor.setText("");
			this.clearClipboardImages();
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

	async handleClipboardPaste() {
		if (this.clipboardPasteInProgress) return;
		if (this.imagePromptCapability() === false) {
			this.addNotice(`${this.config.agents[this.activeKey]?.label ?? this.activeKey} does not support image prompts.`);
			this.ui.requestRender();
			return;
		}
		this.clipboardPasteInProgress = true;
		this.exitVoiceMode();
		let inserted = false;
		try {
			const image = await readClipboardImage();
			if (!image) {
				this.addNotice("No image found in clipboard.");
				this.ui.requestRender();
				return;
			}
			const label = `[Image ${++this.clipboardImageCounter}]`;
			this.clipboardImages.push({ ...image, label });
			this.insertClipboardImagePlaceholder(label);
			this.lastKnownEditorText = this.editor.getText();
			inserted = true;
			this.ui.requestRender();
		} catch (error) {
			this.addError(error.message ?? String(error));
			this.ui.requestRender();
		} finally {
			this.clipboardPasteInProgress = false;
			this.flushBufferedClipboardPasteInput({ allowSubmit: inserted });
		}
	}

	insertClipboardImagePlaceholder(label) {
		const cursor = this.editor.getCursor?.();
		const lines = this.editor.getLines?.();
		const line = cursor && lines ? (lines[cursor.line] ?? "") : this.editor.getText();
		const before = cursor ? line.slice(0, cursor.col) : line;
		const after = cursor ? line.slice(cursor.col) : "";
		const prefix = before && !/\s$/.test(before) ? " " : "";
		const suffix = after && !/^\s/.test(after) ? " " : "";
		const text = `${prefix}${label}${suffix || " "}`;
		if (this.editor.insertTextAtCursor) this.editor.insertTextAtCursor(text);
		else this.editor.setText(`${this.editor.getText()}${text}`);
	}

	clearClipboardImages() {
		this.clipboardImages = [];
	}

	bufferClipboardPasteInput(data) {
		this.bufferedClipboardPasteInput.push(data);
	}

	flushBufferedClipboardPasteInput(options = {}) {
		const allowSubmit = options.allowSubmit === true;
		const buffered = this.bufferedClipboardPasteInput;
		this.bufferedClipboardPasteInput = [];
		for (const data of buffered) {
			if (this.clipboardPasteInProgress) {
				this.bufferedClipboardPasteInput.push(data);
				continue;
			}
			if (!allowSubmit && isSubmitInput(data)) continue;
			this.ui.handleInput(data);
		}
	}

	consumeImagePromptParts(text) {
		if (this.clipboardImages.length === 0) return undefined;
		const images = this.clipboardImages;
		this.clipboardImages = [];

		const matches = images
			.map((image) => ({ image, index: text.indexOf(image.label) }))
			.filter((entry) => entry.index >= 0)
			.sort((a, b) => a.index - b.index);

		if (matches.length === 0) return [{ type: "text", text }];

		const parts = [];
		let offset = 0;
		for (const { image, index } of matches) {
			const before = text.slice(offset, index);
			if (before.trim()) parts.push({ type: "text", text: before });
			parts.push({ type: "image", data: image.data, mimeType: image.mimeType });
			offset = index + image.label.length;
		}
		const after = text.slice(offset);
		if (after.trim()) parts.push({ type: "text", text: after });
		return parts.length > 0 ? parts : matches.map(({ image }) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
	}

	restagePromptImages(text, promptParts) {
		this.clipboardImages = imageAttachmentsFromPromptParts(text, promptParts);
	}

	imagePromptCapability() {
		const state = this.sessionStates.get(this.activeKey);
		const capabilities = state?.capabilities ?? this.client?.capabilities;
		return imagePromptCapability(capabilities);
	}

	promptForActiveCapabilities(text, promptParts) {
		if (!hasImagePromptPart(promptParts)) return promptParts ?? text;
		if (this.imagePromptCapability() === true) return promptParts;
		this.addNotice(`${this.config.agents[this.activeKey]?.label ?? this.activeKey} does not support image prompts; sending text only.`);
		return text;
	}

	initVoiceInput() {
		this.voiceController = new VoiceController({
			getApiKey: async () => process.env.OPENAI_API_KEY?.trim(),
			getBaseUrl: async () => process.env.OPENAI_BASE_URL?.trim() || process.env.OPENAI_API_BASE?.trim(),
			model: process.env.CC_TRANSCRIPTION_MODEL?.trim() || process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || undefined,
			onResult: (text) => this.handleVoiceResult(text),
			onQueue: (text) => this.handleVoiceQueue(text),
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
		if (controller.isTranscribing()) return `${chalk.cyan("○")}   ${chalk.dim("Transcribing…")}`;
		if (controller.isRecording()) {
			const circle = controller.getTick() % 2 === 0 ? "●" : "○";
			const elapsed = formatDuration(controller.getElapsedSeconds());
			return `${chalk.cyan(circle)} ${chalk.cyan(elapsed)}   ${chalk.dim("Space/Enter to send · Tab to queue · type to edit")}`;
		}
		return `${chalk.cyan("○")}   ${chalk.dim("Space to record · Ctrl+Space for text")}`;
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

		// Ctrl+C / Esc aborts an in-progress recording or transcription (discard,
		// no transcription) instead of finalizing and sending it.
		if (keyInfo.isCancel && (controller.isRecording() || controller.isTranscribing())) {
			controller.cancel();
			this.exitVoiceMode();
			return true;
		}

		if (!this.voiceModeEnabled) {
			return keyInfo.isCtrlSpace;
		}

		if (controller.isTranscribing()) {
			if (keyInfo.isSpace || keyInfo.isModifiedSpace || keyInfo.isCtrlSpace || keyInfo.isSubmit || keyInfo.isTab) return true;
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

		if (keyInfo.isSubmit && controller.isRecording()) {
			this.beginVoiceSession();
			controller.toggle();
			return true;
		}

		if (keyInfo.isTab && controller.isRecording()) {
			this.beginVoiceSession();
			controller.queue();
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
		const sep = !pending || pending.startsWith(" ") || pending.startsWith("\n") ? "" : " ";
		const combined = pending?.trim() ? `${trimmed}${sep}${pending}` : trimmed;
		submit(combined);
	}

	handleVoiceQueue(text) {
		const trimmed = text.trim();
		const pending = this.voicePendingSubmit;
		this.voicePendingSubmit = undefined;
		const sep = pending?.startsWith(" ") || pending?.startsWith("\n") || !pending ? "" : " ";
		const combined = pending !== undefined ? (trimmed ? `${trimmed}${sep}${pending}` : pending) : trimmed;
		if (!combined.trim()) return;
		void this.handleSubmit(combined, { queueTiming: "afterTurn" });
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

	async handleSubmit(rawText, opts = {}) {
		this.lastKnownEditorText = "";
		const text = rawText.trim();
		if (!text) return;
		// When the /btw fork is focused, the editor drives that thread — except
		// harness and reserved local UI commands, which still run on the main path.
		if (this.focusedThread === "btw" && this.btwThread) {
			this.editor.addToHistory(text);
			if (isHarnessCommandText(text)) {
				await this.handleHarnessCommand(text);
				return;
			}
			if (text.startsWith("/")) {
				const { name, argument } = parseSlashCommand(text);
				// Mirror the main dispatcher's precedence (handleSlashCommand) so the fork
				// behaves like the main thread: reserved UI commands always run locally; a
				// command the backend actually advertises stays reachable (falls through to
				// the fork); only a non-advertised local command (/model, /effort, /new,
				// /resume, …) runs on the main path instead of being sent to the fork as
				// literal chat text. A fork is the same agent as main, so main's advertised
				// command set applies to it.
				const backendNames = new Set((this.availableCommands.get(this.activeKey) ?? []).map((command) => command.name));
				const localNames = new Set(localSlashCommands(this).map((command) => command.name));
				if (RESERVED_LOCAL_COMMANDS.has(name)) {
					await this.runLocalSlashCommand(name, argument);
					return;
				}
				if (!backendNames.has(name) && localNames.has(name)) {
					await this.runLocalSlashCommand(name, argument);
					return;
				}
			}
			const promptParts = this.consumeImagePromptParts(text);
			void this.btwThread.submit(text, promptParts);
			return;
		}
		const displayText = this.consumePromptDisplay(text);
		this.editor.addToHistory(text);
		this.editor.onSubmit = undefined;
		queueMicrotask(() => {
			this.editor.onSubmit = (next) => void this.handleSubmit(next);
		});

		if (isHarnessCommandText(text)) {
			await this.handleHarnessCommand(text);
			return;
		}
		let compactCommand = false;
		if (text.startsWith("/")) {
			const handled = await this.handleSlashCommand(text);
			compactCommand = handled === "backend";
			if (handled === true) return;
		}
		// Consume staged images only once we know this is a real backend prompt — a
		// locally-handled command must not silently swallow a pending attachment.
		const promptParts = this.consumeImagePromptParts(text);
		await this.submitBackendPrompt(text, { displayText, compactCommand, promptParts, queueTiming: opts.queueTiming });
	}

	async submitBackendPrompt(text, options = {}) {
		const displayText = options.displayText ?? text;
		if (!this.ready) {
			this.enqueuePrompt(text, "afterTurn", { displayText, compactCommand: options.compactCommand, promptParts: options.promptParts });
			this.statusState = "connecting";
			this.updateSpinner();
			// Reconnect when there is no client or the previous one died (e.g. backend crash).
			if (!this.client || this.client.exited) void this.switchAgent(this.activeKey, this.transport, { quiet: true });
			this.ui.requestRender();
			return;
		}
		if (this.busy || this.sessionSwitchInProgress) {
			// While a turn is running, Enter queues "after tool" (steer at the next
			// tool-call boundary); Tab queues "after turn". During a session switch
			// there is no live turn, so always queue for after the switch.
			const timing = this.busy ? (options.queueTiming ?? "afterTool") : "afterTurn";
			this.enqueuePrompt(text, timing, {
				displayText,
				compactCommand: options.compactCommand,
				promptParts: options.promptParts,
			});
			return;
		}
		const pendingUserEcho = this.trackPendingUserEcho(text);
		const transcriptEntry = this.addUserMessage(displayText, { compactCommand: options.compactCommand });
		this.armPendingUnsendPrompt({
			text,
			displayText,
			promptParts: options.promptParts,
			pendingUserEcho,
			transcriptEntry,
		});
		await this.sendPrompt(text, { pendingUserEcho, promptParts: options.promptParts });
		await this.flushPromptQueue();
	}

	armPendingUnsendPrompt(entry) {
		const sessionId = this.client?.sessionId;
		const stateSnapshot = this.codexThreadStateSnapshot;
		if (!entry.transcriptEntry?.message || !this.isCodexAcpActive() || !sessionId || stateSnapshot?.sessionId !== sessionId) {
			this.pendingUnsendPrompt = undefined;
			return;
		}
		this.pendingUnsendPrompt = {
			...entry,
			sessionId,
			client: this.client,
			stateSnapshot,
		};
	}

	disarmPendingUnsendPrompt(pendingUserEcho) {
		if (!this.pendingUnsendPrompt) return;
		if (!pendingUserEcho || this.pendingUnsendPrompt.pendingUserEcho === pendingUserEcho) {
			this.pendingUnsendPrompt = undefined;
		}
	}

	tryUnsendPendingPrompt() {
		const pending = this.pendingUnsendPrompt;
		if (!pending || pending.client !== this.client || !this.busy || this.cancelRequested) return false;
		if (this.promptQueue.some((entry) => entry.timing === "afterTool")) return false;
		if (!this.isCodexAcpActive()) {
			this.pendingUnsendPrompt = undefined;
			return false;
		}
		const currentState = this.readCodexThreadState(pending.sessionId);
		if (!codexThreadStatesEqual(currentState, pending.stateSnapshot)) {
			this.pendingUnsendPrompt = undefined;
			this.codexThreadStateSnapshot = currentState;
			return false;
		}

		this.pendingUnsendPrompt = undefined;
		this.restoreSoftQueuedPromptsToComposer();
		this.removeTranscriptEntry(pending.transcriptEntry);
		this.expirePendingUserEcho(pending.pendingUserEcho);
		this.restoreUnsentPromptToComposer(pending);
		this.cancelRequested = true;
		this.afterToolCancelPending = false;
		this.statusState = "";
		this.updateSpinner();
		this.client?.cancel?.();
		this.forceSettleCanceledTurn();
		this.ui.requestRender();
		return true;
	}

	restoreUnsentPromptToComposer(pending) {
		const current = this.editor.getText();
		const next = current ? `${pending.text}\n${current}` : pending.text;
		this.editor.setText(next);
		const restored = imageAttachmentsFromPromptParts(pending.text, Array.isArray(pending.promptParts) ? pending.promptParts : []);
		this.clipboardImages = [...restored, ...this.clipboardImages];
		this.pendingPromptDisplay = pending.displayText && pending.displayText !== pending.text
			? { text: pending.text, displayText: pending.displayText }
			: undefined;
		this.lastKnownEditorText = next;
	}

	restoreSoftQueuedPromptsToComposer() {
		const queued = this.promptQueue.filter((entry) => entry.timing === "afterTurn");
		if (queued.length === 0) return;
		this.promptQueue = this.promptQueue.filter((entry) => entry.timing !== "afterTurn");
		this.pendingPromptDisplay = undefined;
		this.restoreQueuedTextToComposer(queued);
	}

	removeTranscriptEntry(entry) {
		if (!entry?.message || !this.chat?.children) return;
		const index = this.chat.children.indexOf(entry.message);
		if (index === -1) return;
		if (entry.spacer && this.chat.children[index - 1] === entry.spacer) {
			this.chat.removeChild(entry.spacer);
		}
		this.chat.removeChild(entry.message);
	}

	isCodexAcpActive() {
		const info = this.client?.agentInfo ?? this.sessionStates.get(this.activeKey)?.agentInfo;
		return this.transport === "acp" && info?.name === "codex-acp";
	}

	refreshCodexThreadStateSnapshot(sessionInfo = undefined) {
		if (!this.isCodexAcpActive()) return;
		const sessionId = sessionInfo?.sessionId ?? this.client?.sessionId;
		const snapshot = this.readCodexThreadState(sessionId);
		if (snapshot) this.codexThreadStateSnapshot = snapshot;
	}

	readCodexThreadState(sessionId) {
		return readCodexThreadState(sessionId);
	}

	async sendPrompt(text, options = {}) {
		if (!this.client || !this.ready || this.client.exited) {
			this.expirePendingUserEcho(options.pendingUserEcho);
			this.disarmPendingUnsendPrompt(options.pendingUserEcho);
			return;
		}
		this.busy = true;
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.activeToolIds.clear();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.closeCurrentAssistantText();
		this.statusState = "working";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const result = await this.client.prompt(this.promptForActiveCapabilities(text, options.promptParts));
			this.noticeForStopReason(result?.stopReason);
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.clearCancelGraceTimer();
			this.expirePendingUserEcho(options.pendingUserEcho);
			this.disarmPendingUnsendPrompt(options.pendingUserEcho);
			if (this.cancelRequested) {
				for (const id of this.activeToolIds) this.updateTool("canceled", id);
			}
			this.activeToolIds.clear();
			this.activeAnonymousToolCount = 0;
			this.busy = false;
			this.closeCurrentAssistantText();
			// A user Escape (cancelRequested without an intentional after-tool send)
			// must not auto-fire queued after-turn prompts, and should drop the spinner.
			const userCanceled = this.cancelRequested && !this.afterToolCancelPending;
			this.statusState = this.promptQueue.length > 0 && !userCanceled ? "working" : "";
			this.updateSpinner();
			this.refreshCodexThreadStateSnapshot();
			this.ui.requestRender();
			if (this.pendingNewSessionCommandName) {
				const commandName = this.pendingNewSessionCommandName;
				this.pendingNewSessionCommandName = undefined;
				await this.startNewSession(commandName, { afterTurn: true });
				return;
			}
			if (!userCanceled) this.schedulePromptQueueDrain();
		}
	}

	noticeForStopReason(stopReason) {
		if (!stopReason || this.cancelRequested) return;
		if (stopReason === "refusal") this.addNotice("The model declined to respond.");
		else if (stopReason === "max_tokens") this.addNotice("Response stopped at the output token limit.");
		else if (stopReason === "max_turn_requests") this.addNotice("Response stopped at the per-turn request limit.");
	}

	async flushPromptQueue() {
		if (!this.ready || this.busy || this.sessionSwitchInProgress || this.flushingPromptQueue || this.client?.exited) return;
		this.flushingPromptQueue = true;
		try {
			while (this.ready && !this.busy && !this.sessionSwitchInProgress && !this.client?.exited && this.promptQueue.length > 0) {
				const prompt = this.promptQueue.shift();
				const pendingUserEcho = this.trackPendingUserEcho(prompt.text);
				const transcriptEntry = this.addUserMessage(prompt.displayText ?? prompt.text, { compactCommand: prompt.compactCommand });
				this.armPendingUnsendPrompt({
					text: prompt.text,
					displayText: prompt.displayText ?? prompt.text,
					promptParts: prompt.promptParts,
					pendingUserEcho,
					transcriptEntry,
				});
				this.ui.requestRender();
				await this.sendPrompt(prompt.text, { pendingUserEcho, promptParts: prompt.promptParts });
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

	enqueuePrompt(text, timing = "afterTurn", options = {}) {
		this.promptQueue.push({ text, timing, displayText: options.displayText, compactCommand: options.compactCommand, promptParts: options.promptParts });
		this.updateSpinner();
		this.ui.requestRender();
		if (timing === "afterTool") this.maybeCancelAfterTool();
		this.schedulePromptQueueDrain();
	}

	schedulePromptQueueDrain() {
		if (this.promptQueueDrainScheduled || this.promptQueue.length === 0) return;
		this.promptQueueDrainScheduled = true;
		const timer = setTimeout(() => {
			this.promptQueueDrainScheduled = false;
			void this.flushPromptQueue();
		}, 0);
		timer.unref?.();
	}

	queueCurrentInput(timing) {
		const text = this.editor.getText();
		if (!text.trim()) return false;
		this.editor.setText("");
		this.lastKnownEditorText = "";
		void this.handleSubmit(text, { queueTiming: timing });
		return true;
	}

	interruptViaEscape() {
		if (!this.busy || !this.client) return;
		// A second Escape while already canceling force-settles a stuck turn.
		if (this.cancelRequested) {
			this.interruptTurn();
			return;
		}
		// After-tool messages are committed: stop now and let them send immediately.
		if (this.promptQueue.some((entry) => entry.timing === "afterTool")) {
			this.afterToolCancelPending = true;
			this.interruptTurn();
			return;
		}
		// After-turn messages are a soft queue: stop, do not send, and hand them
		// back to the composer (newline-joined) so the user can edit/resubmit.
		const queued = this.promptQueue.filter((entry) => entry.timing === "afterTurn");
		if (queued.length > 0) {
			this.promptQueue = this.promptQueue.filter((entry) => entry.timing !== "afterTurn");
			this.pendingPromptDisplay = undefined;
			this.restoreQueuedTextToComposer(queued);
		}
		this.interruptTurn();
	}

	restoreQueuedTextToComposer(entries) {
		const joined = entries.map((entry) => entry.text).join("\n");
		const current = this.editor.getText();
		const next = current ? `${joined}\n${current}` : joined;
		this.editor.setText(next);
		// Prepend the queued entries' images to any image the user already staged in
		// the composer rather than overwriting; labels stay unique so consume matches
		// each by its placeholder regardless of order.
		const promptParts = entries.flatMap((entry) => (Array.isArray(entry.promptParts) ? entry.promptParts : []));
		const restored = imageAttachmentsFromPromptParts(joined, promptParts);
		this.clipboardImages = [...restored, ...this.clipboardImages];
		this.lastKnownEditorText = next;
	}

	unqueuePromptForEditing() {
		if (this.promptQueue.length === 0) return false;
		const prompt = this.promptQueue.pop();
		this.editor.setText(prompt.text);
		this.restagePromptImages(prompt.text, prompt.promptParts);
		this.pendingPromptDisplay = prompt.displayText ? { text: prompt.text, displayText: prompt.displayText } : undefined;
		this.lastKnownEditorText = prompt.text;
		this.updateSpinner();
		this.ui.requestRender();
		return true;
	}

	interruptTurn() {
		if (!this.busy || !this.client) return;
		// Already canceling and the backend has not settled the prompt: force it
		// locally so the UI can never get stuck in "canceling".
		if (this.cancelRequested) {
			this.forceSettleCanceledTurn();
			return;
		}
		this.cancelRequested = true;
		this.statusState = "canceling";
		this.updateSpinner();
		this.client.cancel();
		this.ui.requestRender();
		this.clearCancelGraceTimer();
		this.cancelGraceTimer = setTimeout(() => this.forceSettleCanceledTurn(), 8000);
		this.cancelGraceTimer?.unref?.();
	}

	forceSettleCanceledTurn() {
		this.clearCancelGraceTimer();
		// Resolve the still-pending session/prompt without killing the backend so
		// sendPrompt's finally runs and the UI returns to idle.
		this.client?.forceResolvePrompt?.();
	}

	clearCancelGraceTimer() {
		if (this.cancelGraceTimer) {
			clearTimeout(this.cancelGraceTimer);
			this.cancelGraceTimer = undefined;
		}
	}

	deferNewSessionUntilIdle(commandName = "new") {
		this.pendingNewSessionCommandName = commandName;
		this.promptQueue = [];
		this.pendingPromptDisplay = undefined;
		this.interruptTurn();
		if (!this.cancelRequested) {
			this.statusState = "starting new session";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	maybeCancelAfterTool() {
		if (!this.busy || this.afterToolCancelPending || this.cancelRequested) return;
		if (!this.promptQueue.some((entry) => entry.timing === "afterTool")) return;
		if (!this.seenToolThisTurn) return;
		if (this.activeToolIds.size > 0) return;
		if (this.activeAnonymousToolCount > 0) return;
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
			this.addCommandMessage(command);
			this.addNotice(`usage: /harness [${Object.keys(this.config.agents).join("|")}]`);
			return;
		}
		await this.switchAgent(agentKey, "acp", { persist: true, displayText: slashPromptDisplay("/harness", this.config.agents[agentKey]?.label ?? agentKey) });
	}

	async handleSlashCommand(text) {
		const { name, argument } = parseSlashCommand(text);
		if (!name) return false;
		const available = this.availableCommands.get(this.activeKey) ?? [];
		const localNames = new Set(localSlashCommands(this).map((command) => command.name));
		const backendNames = new Set(available.map((command) => command.name));

		if (this.shouldOpenCodexReviewDialog(name, argument, backendNames)) {
			this.openCodexReviewDialog();
			return true;
		}
		// Reserved UI commands stay local even if a backend advertises the name.
		if (RESERVED_LOCAL_COMMANDS.has(name) && localNames.has(name)) {
			await this.runLocalSlashCommand(name, argument);
			return true;
		}
		if (this.isKnownCodexReviewCommand(name)) return "backend";
		// Prefer the backend's own command when it actually advertises the name,
		// so a backend /model or /new is reachable instead of being shadowed.
		if (backendNames.has(name)) return "backend";
		if (localNames.has(name)) {
			await this.runLocalSlashCommand(name, argument);
			return true;
		}
		// The command list may not have arrived yet (cold start / right after a
		// switch); forward to the backend rather than rejecting a valid command.
		if (!this.commandsLoaded.has(this.activeKey)) return "backend";
		this.addCommandMessage(text);
		this.addNotice(`Unknown command: /${name}`);
		return true;
	}

	shouldOpenCodexReviewDialog(name, argument, backendNames) {
		if (name !== "review" || argument) return false;
		if (this.activeKey === "codex") return true;
		return backendNames.has("review") && backendNames.has("review-branch") && backendNames.has("review-commit");
	}

	isKnownCodexReviewCommand(name) {
		return this.activeKey === "codex" && (name === "review" || name === "review-branch" || name === "review-commit");
	}

	openCodexReviewDialog() {
		const entries = [
			{ value: "branch", label: "Review against a base branch", description: "PR Style" },
			{ value: "uncommitted", label: "Review uncommitted changes" },
			{ value: "commit", label: "Review a commit" },
			{ value: "custom", label: "Custom review instructions" },
		];
		this.openSelection("Select a review preset", entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			if (entry.value === "uncommitted") {
				await this.submitBackendPrompt("/review", { displayText: reviewPromptDisplay("/review", entry.label), compactCommand: true });
				return;
			}
			const prefixes = {
				branch: "/review-branch ",
				commit: "/review-commit ",
				custom: "/review ",
			};
			const prefix = prefixes[entry.value] ?? "/review ";
			this.editor.setText(prefix);
			this.pendingPromptDisplay = { prefix, label: entry.label };
			this.lastKnownEditorText = this.editor.getText();
			this.ui.requestRender();
		});
	}

	consumePromptDisplay(text) {
		const display = this.pendingPromptDisplay;
		this.pendingPromptDisplay = undefined;
		if (!display) return undefined;
		if (display.displayText && display.text === text) return display.displayText;
		if (display.prefix && text.startsWith(display.prefix.trimEnd())) return reviewPromptDisplay(text, display.label);
		return undefined;
	}

	async runLocalSlashCommand(name, argument) {
		if (this.sessionSwitchInProgress && shouldDeferLocalSlashCommand(name)) {
			this.deferLocalSlashCommand(name, argument);
			return;
		}
		if (name === "help") {
			this.addCommandMessage(slashCommandText(name, argument));
			this.showHelp();
			return;
		}
		if (name === "status") {
			this.addCommandMessage(slashCommandText(name, argument));
			this.showStatus();
			return;
		}
		if (name === "clear") {
			if (this.btwThread) this.closeBtw();
			this.resetConversationView();
			this.ui.requestRender();
			return;
		}
		if (name === "voice") {
			if (argument) {
				this.addCommandMessage(slashCommandText(name, argument));
				this.addNotice("/voice only works by itself in an empty input box");
				return;
			}
			if (this.voiceController?.isRecording() || this.voiceController?.isTranscribing()) {
				this.addCommandMessage(slashCommandText(name, argument));
				this.addNotice("/voice is available after the current voice action finishes");
				return;
			}
			this.editor.setText("");
			this.enterVoiceMode();
			return;
		}
		if (name === "btw") {
			await this.runBtw(argument);
			return;
		}
		if (name === "diff") {
			await this.runDiff(argument);
			return;
		}
		if (name === "copy") {
			await this.runCopy();
			return;
		}
		if (name === "theme") {
			await this.openThemeDialog(argument, name);
			return;
		}
		if (name === "resume") {
			await this.openResumeDialog(name);
			return;
		}
		if (name === "new") {
			await this.startNewSession(name);
			return;
		}
		if (name === "model") {
			await this.openConfigDialog("model", "Model", argument, name);
			return;
		}
		if (name === "mode") {
			await this.openConfigDialog("mode", "Mode", argument, name);
			return;
		}
		if (name === "effort" || name === "reasoning" || name === "thinking") {
			await this.openConfigDialog("thought_level", "Reasoning", argument, name);
			return;
		}
		if (name === "plan") {
			await this.setPlanMode(name);
		}
	}

	deferLocalSlashCommand(name, argument = "") {
		this.deferredLocalSlashCommands.push({ name, argument });
		this.updateSpinner();
		this.ui.requestRender();
	}

	async flushDeferredLocalSlashCommands() {
		while (!this.sessionSwitchInProgress && this.deferredLocalSlashCommands.length > 0) {
			const command = this.deferredLocalSlashCommands.shift();
			await this.runLocalSlashCommand(command.name, command.argument);
		}
	}

	resetConversationView() {
		this.chat.clear();
		this.currentAssistantText = undefined;
		this.currentToolSummary = undefined;
		this.currentUserText = undefined;
		this.pendingUserEchoes = [];
		this.pendingUnsendPrompt = undefined;
		this.pendingPromptDisplay = undefined;
		this.lastAssistantText = "";
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
			`theme ${themeLabel(this.themeName)}`,
			state.sessionId ? `session ${state.sessionId}` : undefined,
		].filter(Boolean);
		this.addNotice(parts.join(" · "));
	}

	async openThemeDialog(argument = "", commandName = "theme") {
		if (argument) {
			const canonical = resolveThemeName(argument);
			if (!canonical) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`Unknown theme: ${argument}`);
				return;
			}
			await this.applyTheme(canonical, {
				displayText: slashPromptDisplay(slashCommandText(commandName, argument), themeLabel(canonical)),
			});
			return;
		}
		this.closeMenu({ cancelSelection: true });
		this.menuEditorText = this.editor.getText();
		this.updateFilterEditor("");
		this.menuHandle = new ThemePanel(this);
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	async applyTheme(themeName, options = {}) {
		const canonical = resolveThemeName(themeName);
		if (!canonical) return false;
		try {
			saveSettingsPatch({ theme: canonical });
		} catch (error) {
			this.closeMenu();
			this.addCommandMessage(options.displayText ?? slashPromptDisplay("/theme", themeLabel(canonical)));
			this.addError(`Could not save theme: ${error.message ?? error}`);
			this.ui.requestRender();
			return false;
		}
		this.closeMenu({ keepThemePreview: true });
		this.themeName = canonical;
		this.previewThemeName = undefined;
		this.config.theme = canonical;
		this.config.settings = { ...(this.config.settings ?? {}), theme: canonical };
		setActiveTheme(canonical);
		this.invalidateRenderedChildren();
		this.addCommandMessage(options.displayText ?? slashPromptDisplay("/theme", themeLabel(canonical)));
		this.updateAutocomplete();
		this.ui.requestRender(true);
		return true;
	}

	previewTheme(themeName) {
		const canonical = resolveThemeName(themeName) ?? this.themeName;
		if (this.previewThemeName === canonical && activeThemeName === canonical) return;
		this.previewThemeName = canonical;
		setActiveTheme(canonical);
		this.invalidateRenderedChildren();
		this.ui.requestRender(true);
	}

	restoreThemePreview() {
		if (!this.previewThemeName && activeThemeName === this.themeName) return;
		this.previewThemeName = undefined;
		setActiveTheme(this.themeName);
		this.invalidateRenderedChildren();
		this.ui.requestRender(true);
	}

	invalidateRenderedChildren() {
		invalidateRenderableTree(this.chat);
		if (this.btwThread) invalidateRenderableTree(this.btwThread.chat);
		invalidateRenderableTree(this.commandPanel);
		invalidateRenderableTree(this.queueSummary);
		invalidateRenderableTree(this.editor);
		invalidateRenderableTree(this.status);
	}

	async openResumeDialog(commandName = "resume") {
		if (!this.client || !this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		if (!supportsSessionList(this.sessionStates.get(this.activeKey))) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice("This agent does not advertise session listing");
			return;
		}
		this.statusState = "loading sessions";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const sessions = await this.client.listSessions();
			const forkIds = loadForkIds();
			const entries = sessions.map((session) => {
				const title = session.title || session.sessionId;
				return {
					value: session.sessionId,
					// /btw forks inherit the parent's title; mark them so a resume list
					// of a parent + its fork(s) is distinguishable.
					label: forkIds.has(session.sessionId) ? `(fork) ${title}` : title,
					description: session.updatedAt ? `${compactDate(session.updatedAt)} · ${compactPath(session.cwd)}` : compactPath(session.cwd),
					active: session.sessionId === this.client.sessionId,
					session,
				};
			});
			this.openSelection("Resume session", entries, async (entry) => {
				this.closeMenu();
				if (!entry) return;
				await this.resumeSelectedSession(entry.session, {
					displayText: slashPromptDisplay(`/${commandName}`, entry.label),
				});
			});
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async resumeSelectedSession(session, options = {}) {
		if (!this.client) return;
		const displayText = options.displayText ?? slashPromptDisplay("/resume", session.title || session.sessionId);
		if (session.sessionId === this.client.sessionId) {
			this.addCommandMessage(displayText);
			this.addNotice(`Already using ${session.title || session.sessionId}`);
			return;
		}
		this.statusState = "resuming";
		// Guard the in-flight load like startNewSession does: until the new sessionId
		// is live, a prompt submitted mid-load would otherwise be sent against the
		// session being abandoned. The guard makes such a prompt queue and drain after.
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const loadsHistory = Boolean(this.client.capabilities?.loadSession);
			this.resetConversationView();
			if (loadsHistory) await this.client.loadSession(session.sessionId);
			else {
				await this.client.resumeSession(session.sessionId);
				this.addCommandMessage(displayText);
			}
			if (loadsHistory) this.addCommandMessage(displayText);
			this.updateAutocomplete();
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			// Mirror startNewSession: a local command (/model, /mode, /effort, /plan,
			// /resume) submitted mid-resume is deferred while the switch flag is set,
			// so it must be flushed once the flag clears or it stays queued until the
			// next session switch.
			await this.flushDeferredLocalSlashCommands();
			this.schedulePromptQueueDrain();
		}
	}

	async startNewSession(commandName = "new", options = {}) {
		const displayText = slashPromptDisplay(`/${commandName}`, "New session");
		// A /btw fork is branched from the session we're about to replace.
		if (this.btwThread) this.closeBtw();
		if (!this.client || !this.ready) {
			const wasReady = this.ready;
			const connected = await this.ensureConnected();
			if (!connected) return;
			if (!wasReady) {
				this.promptQueue = [];
				this.pendingPromptDisplay = undefined;
				this.resetConversationView();
				this.addCommandMessage(displayText);
				this.updateAutocomplete();
				this.ui.requestRender();
				return;
			}
		}
		if (this.sessionSwitchInProgress) {
			this.addNotice("Already starting a new session");
			this.ui.requestRender();
			return;
		}
		if (this.busy && !options.afterTurn) {
			this.deferNewSessionUntilIdle(commandName);
			return;
		}
		this.promptQueue = [];
		this.pendingPromptDisplay = undefined;
		this.statusState = "starting new session";
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		const client = this.client;
		let switched = false;
		try {
			await client.newSession({
				beforeReplay: async () => {
					if (this.client !== client) return;
					switched = true;
					this.resetConversationView();
					this.addCommandMessage(displayText);
					this.updateAutocomplete();
				},
			});
			if (this.client !== client) return;
		} catch (error) {
			if (this.client !== client) return;
			this.promptQueue = [];
			this.deferredLocalSlashCommands = [];
			this.pendingPromptDisplay = undefined;
			this.addError(error.message ?? String(error));
		} finally {
			if (this.client !== client) return;
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			if (switched) {
				await this.flushDeferredLocalSlashCommands();
				this.schedulePromptQueueDrain();
			}
		}
	}

	async openConfigDialog(category, title, argument = "", commandName = title.toLowerCase()) {
		if (!this.client || !this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		const state = this.sessionStates.get(this.activeKey);
		const option = findConfigOption(state, category);
		if (!option && category === "mode") {
			await this.openModeDialog(title, argument, commandName);
			return;
		}
		if (!option) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`${title} selection is not advertised by this agent`);
			return;
		}
		const values = flattenConfigOptions(option);
		if (argument) {
			const match = values.find((entry) => entry.value === argument || entry.name === argument);
			if (!match) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`Unknown ${title.toLowerCase()}: ${argument}`);
				return;
			}
			await this.setConfigValue(option, match.value, match.name, {
				displayText: slashPromptDisplay(slashCommandText(commandName, argument), match.name),
			});
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
			await this.setConfigValue(option, entry.value, entry.label, {
				displayText: slashPromptDisplay(`/${commandName}`, entry.label),
			});
		});
	}

	async setConfigValue(option, value, label = value, options = {}) {
		if (!this.client) return;
		const displayText = options.displayText ?? slashPromptDisplay(`/${option.category ?? option.id ?? "config"}`, label);
		this.statusState = "updating";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.client.setConfigOption(option.id, value);
			this.addCommandMessage(displayText);
			this.updateAutocomplete();
		} catch (error) {
			if (option.category === "mode" || option.id === "mode") {
				try {
					await this.client.setMode(value);
					this.addCommandMessage(displayText);
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

	async openModeDialog(title, argument = "", commandName = title.toLowerCase()) {
		const modes = flattenModes(this.sessionStates.get(this.activeKey));
		if (modes.length === 0) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`${title} selection is not advertised by this agent`);
			return;
		}
		if (argument) {
			const match = modes.find((entry) => entry.id === argument || entry.name.toLowerCase() === argument.toLowerCase());
			if (!match) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`Unknown ${title.toLowerCase()}: ${argument}`);
				return;
			}
			await this.setModeValue(match.id, match.name, {
				displayText: slashPromptDisplay(slashCommandText(commandName, argument), match.name),
			});
			return;
		}
		const currentModeId = this.sessionStates.get(this.activeKey)?.modes?.currentModeId;
		const entries = modes.map((mode) => ({
			value: mode.id,
			label: mode.name,
			description: mode.description,
			active: mode.id === currentModeId,
		}));
		this.openSelection(title, entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			await this.setModeValue(entry.value, entry.label, {
				displayText: slashPromptDisplay(`/${commandName}`, entry.label),
			});
		});
	}

	async setModeValue(modeId, label = modeId, options = {}) {
		if (!this.client) return;
		const displayText = options.displayText ?? slashPromptDisplay("/mode", label);
		this.statusState = "updating";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.client.setMode(modeId);
			this.addCommandMessage(displayText);
			this.updateAutocomplete();
		} catch (error) {
			this.addError(error.message ?? String(error));
		} finally {
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async setPlanMode(commandName = "plan") {
		if (!this.ready) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		const state = this.sessionStates.get(this.activeKey);
		const option = findConfigOption(state, "mode");
		const value = findConfigValue(option, "plan");
		if (option && value) {
			await this.setConfigValue(option, value.value, value.name, {
				displayText: slashPromptDisplay(`/${commandName}`, value.name),
			});
			return;
		}
		const mode = findMode(state, "plan");
		if (mode) {
			await this.setModeValue(mode.id, mode.name, {
				displayText: slashPromptDisplay(`/${commandName}`, mode.name),
			});
			return;
		}
		this.addCommandMessage(`/${commandName}`);
		this.addNotice("Plan mode is not advertised by this agent");
	}

	async runBtw(question) {
		const trimmed = (question ?? "").trim();
		this.addCommandMessage(trimmed ? slashCommandText("btw", trimmed) : "/btw");
		if (this.btwThread) {
			this.addNotice("A /btw thread is already open — shift+tab to focus it, esc (when focused) to close.");
			this.ui.requestRender();
			return;
		}
		if (this.activeKey === "cursor") {
			this.addNotice("/btw is not supported for Cursor (it does not support session forking).");
			this.ui.requestRender();
			return;
		}
		if (!this.ready || !this.client?.sessionId) {
			this.addNotice("/btw needs an active session — try again once connected.");
			this.ui.requestRender();
			return;
		}
		const agent = this.config.agents[this.activeKey];
		this.closeMenu();
		const parentSessionId = this.client.sessionId;
		let thread;
		const btwClient = new AcpClient(
			agent,
			(event) => {
				if (this.btwThread === thread) thread.handleEvent(event);
			},
			{
				onPermissionRequest: (params) => {
					if (this.btwThread !== thread) return { outcome: "cancelled" };
					if (agent._autoPermissionRequests) return autoPermissionOutcome(params);
					return this.requestPermission(params);
				},
				onCursorRequest: (method, params) => {
					if (this.btwThread !== thread) return cursorCancelResult(method);
					if (agent._autoPermissionRequests) return autoCursorOutcome(method, params);
					return this.requestCursorInteraction(method, params);
				},
			},
		);
		thread = new BtwThread(this, btwClient, trimmed);
		this.btwThread = thread;
		this.focusedThread = "btw";
		this.updateSpinner();
		// Entering the fixed-height page view from natural flow: hard repaint.
		this.forceFullRepaint();
		// Queue the initial question (if any) — it sends once the fork is ready.
		// A bare /btw just opens the focused fork, ready for the first message.
		if (trimmed) thread.submit(trimmed);

		try {
			await btwClient.initialize({ createSession: false });
			if (this.btwThread !== thread) {
				btwClient.stop();
				return;
			}
			if (btwClient.supportsFork()) {
				await btwClient.forkSession(parentSessionId);
			} else if (this.activeKey === "codex") {
				await this.forkCodexSession(btwClient, parentSessionId);
			} else {
				throw new Error("this agent does not support session forking");
			}
			thread.sessionId = btwClient.sessionId;
			// Remember this fork so /resume can label it (it inherits the parent's title).
			recordForkId(btwClient.sessionId);
			thread.markReady();
			this.onThreadActivity();
		} catch (error) {
			// Fork setup failed (submit handles its own errors internally), so the
			// fork's backend never got going — stop it to avoid a leaked process.
			btwClient.stop();
			if (this.btwThread === thread) {
				thread.addError(`Could not start side thread: ${error.message ?? error}`);
				thread.state = "error";
				thread.statusState = "";
				this.onThreadActivity();
			}
		}
	}

	closeBtw() {
		const thread = this.btwThread;
		this.btwThread = undefined;
		this.focusedThread = "main";
		this.mainView.stick = true;
		if (thread) {
			thread.cancelRequested = true;
			thread.client?.cancel?.();
			thread.stop();
		}
		this.updateSpinner();
		// Leaving the fixed-height page view back to natural flow: hard repaint so
		// the main transcript is re-emitted cleanly into the terminal scrollback.
		this.forceFullRepaint();
	}

	// Codex's ACP bridge (codex-acp) does not expose session/fork — session/load and
	// session/resume reuse the SAME thread id and append to the SAME rollout file,
	// so resuming the live session in a second process would corrupt its rollout.
	// To fork safely we copy the main session's rollout JSONL to a brand-new id and
	// load the copy: an isolated branch with full history + tools, parent untouched.
	//
	// VERSION-SPECIFIC ASSUMPTIONS (verified against openai/codex + codex-acp as of
	// 2026-06; if Codex changes its on-disk layout this is where to fix it):
	//   • Rollouts live under $CODEX_HOME (default ~/.codex) at
	//     sessions/YYYY/MM/DD/rollout-<timestamp>-<threadUuid>.jsonl (JSON Lines).
	//   • The ACP session id returned by session/new equals <threadUuid>, which is
	//     also embedded in the rollout (SessionMeta header + per-item thread_id).
	//   • codex-acp resolves session/load by scanning rollout filenames for the id,
	//     so writing a copy named with the new uuid makes it loadable without the
	//     state_5.sqlite index. Replacing every occurrence of the old uuid with the
	//     new one keeps the header and all item records internally consistent.
	// If any assumption no longer holds, forking throws a clear error (shown in the
	// /btw pane) rather than corrupting anything.
	async forkCodexSession(btwClient, parentSessionId) {
		const rolloutPath = findCodexRolloutPath(parentSessionId);
		if (!rolloutPath) throw new Error("could not locate the Codex session rollout to fork (see forkCodexSession notes)");
		if (rolloutPath.endsWith(".zst")) throw new Error("the Codex session rollout is compressed; cannot fork it (see forkCodexSession notes)");
		const newId = randomUUID();
		copyCodexRolloutWithNewId(rolloutPath, parentSessionId, newId);
		// codex-acp only implements session/load (session/resume is "method not
		// found"), and load replays the parent transcript. That replay arrives
		// before the thread is marked ready, and BtwThread discards pre-ready
		// events, so the fork inherits context without dumping history into the
		// pane (the parent conversation is already visible in the main thread).
		await btwClient.loadSession(newId);
	}

	async runDiff(argument) {
		this.addCommandMessage(slashCommandText("diff", argument));
		const args = argument ? argument.split(/\s+/).filter(Boolean) : ["HEAD"];
		if (!this.busy) {
			this.statusState = "loading diff";
			this.updateSpinner();
			this.ui.requestRender();
		}
		try {
			const result = await runCapture("git", ["--no-pager", "diff", ...args], { rejectOnExit: false, timeoutMs: 30_000 });
			const text = result.stdout.toString("utf8");
			if (result.code !== 0 && !text.trim()) {
				const detail = oneLine(result.stderr.toString("utf8")) || "git diff failed";
				this.addNotice(detail);
			} else if (!text.trim()) {
				this.addNotice("No changes in the working tree.");
			} else {
				this.showMarkdownBlock(`\`\`\`diff\n${truncateDiff(text)}\n\`\`\``);
			}
		} catch (error) {
			this.addError(`git diff failed: ${error.message ?? error}`);
		} finally {
			// Don't drop the spinner if a turn is still running or messages are queued.
			this.statusState = this.busy || this.promptQueue.length > 0 ? "working" : "";
			this.updateSpinner();
			this.ui.requestRender();
		}
	}

	async runCopy() {
		this.addCommandMessage("/copy");
		// Copy the focused thread's last response (the fork, when it is focused).
		const text =
			this.focusedThread === "btw" && this.btwThread
				? this.btwThread.lastAssistantText?.trim()
				: (this.currentAssistantText?.text?.trim() ? this.currentAssistantText.text : this.lastAssistantText)?.trim();
		if (!text) {
			this.addNotice("Nothing to copy yet.");
			this.ui.requestRender();
			return;
		}
		try {
			await writeClipboardText(text);
			this.addNotice("Copied the last response to the clipboard.");
		} catch (error) {
			this.addError(`Could not copy: ${error.message ?? error}`);
		}
		this.ui.requestRender();
	}

	async copyTextToClipboard(text) {
		try {
			await writeClipboardText(text);
			return true;
		} catch (error) {
			this.addError(`Could not copy: ${error.message ?? error}`);
			this.ui.requestRender();
			return false;
		}
	}

	showMarkdownBlock(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("assistant");
		this.chat.addChild(new MutableMarkdown(text));
	}

	openMenu() {
		this.closeMenu();
		this.menuHandle = new AgentMenu(this);
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.menuHandle);
		this.ui.requestRender();
	}

	openSelection(title, entries, onSelect, options = {}) {
		this.closeMenu({ cancelSelection: true });
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

	closeMenu(options = {}) {
		const handle = this.menuHandle;
		if (this.menuHandle) {
			this.commandPanel.clear();
			this.menuHandle = undefined;
		}
		if (handle instanceof ThemePanel && !options.keepThemePreview) {
			this.restoreThemePreview();
		}
		if (this.menuEditorText !== undefined) {
			this.editor.setText(this.menuEditorText);
			this.menuEditorText = undefined;
		}
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
		if (options.cancelSelection && !(handle instanceof ThemePanel)) handle?.cancel?.();
	}

	updateFilterEditor(query) {
		this.editor.setText(query);
	}

	requestPermission(params = {}) {
		return new Promise((resolve) => {
			this.permissionQueue.push({ kind: "permission", params, resolve });
			this.drainPermissionQueue();
		});
	}

	requestCursorInteraction(method, params = {}) {
		return new Promise((resolve) => {
			this.permissionQueue.push({ kind: "cursor", method, params, resolve });
			this.drainPermissionQueue();
		});
	}

	drainPermissionQueue() {
		if (this.permissionPromptActive) return;
		const request = this.permissionQueue.shift();
		if (!request) return;
		this.permissionPromptActive = true;
		if (request.kind === "cursor") this.openCursorInteraction(request);
		else this.openPermissionRequest(request);
	}

	openCursorInteraction(request) {
		const { method, params, resolve } = request;
		const finish = (result) => {
			this.closeMenu();
			resolve(result);
			this.permissionPromptActive = false;
			this.drainPermissionQueue();
		};
		if (method === "cursor/create_plan") {
			this.addNotice(cursorPlanText(params));
			const entries = [
				{ value: "accepted", label: "Accept plan" },
				{ value: "rejected", label: "Reject plan" },
			];
			this.openSelection(`Plan: ${oneLine(params.name ?? params.overview ?? "proposed plan")}`, entries, (entry) => {
				finish({ outcome: { outcome: entry?.value === "accepted" ? "accepted" : "rejected" } });
			});
			return;
		}
		const questions = Array.isArray(params.questions) ? params.questions : [];
		const answers = [];
		const askNext = (index) => {
			if (index >= questions.length) {
				finish({ outcome: { outcome: "answered", answers } });
				return;
			}
			const question = questions[index] ?? {};
			const options = Array.isArray(question.options) ? question.options : [];
			const entries = options.map((option) => ({ value: option.id, label: oneLine(option.label ?? option.id) }));
			const title = oneLine(question.prompt ?? params.title ?? "Question");
			this.openSelection(title, entries, (entry) => {
				if (!entry) {
					finish({ outcome: { outcome: "cancelled" } });
					return;
				}
				answers.push({ questionId: question.id, selectedOptionIds: [entry.value] });
				this.closeMenu();
				askNext(index + 1);
			}, { emptyText: "No options" });
		};
		askNext(0);
	}

	openPermissionRequest({ params, resolve }) {
		const options = Array.isArray(params.options) ? params.options : [];
		if (options.length === 0) {
			resolve({ outcome: "cancelled" });
			this.permissionPromptActive = false;
			this.drainPermissionQueue();
			return;
		}
		const entries = options.map((option, index) => ({
			value: option,
			label: permissionOptionLabel(option, index),
			description: permissionOptionDescription(option),
		}));
		let settled = false;
		const finish = (entry) => {
			if (settled) return;
			settled = true;
			this.closeMenu();
			const option = entry?.value;
			resolve(option?.optionId ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" });
			this.permissionPromptActive = false;
			this.drainPermissionQueue();
		};
		this.openSelection(permissionTitle(params), entries, finish, { emptyText: "No permission options" });
	}

	cancelPermissionPrompts() {
		const queued = this.permissionQueue.splice(0);
		for (const request of queued) {
			request.resolve(request.kind === "cursor" ? cursorCancelResult(request.method) : { outcome: "cancelled" });
		}
		if (!this.permissionPromptActive) return;
		this.permissionPromptActive = false;
		this.closeMenu({ cancelSelection: true });
	}

	handleBackendEvent(event) {
		if (event.type === "backend_activity") {
			this.disarmPendingUnsendPrompt();
		} else if (event.type === "text") {
			this.disarmPendingUnsendPrompt();
			this.appendAssistantText(event.text);
		} else if (event.type === "line") {
			this.disarmPendingUnsendPrompt();
			this.addNotice(event.text);
		} else if (event.type === "user_text") {
			this.disarmPendingUnsendPrompt();
			const text = this.consumePendingUserEcho(event.text);
			if (text) this.appendUserText(text);
		} else if (event.type === "tool") {
			this.disarmPendingUnsendPrompt();
			this.trackToolStatus(event.id, event.status, { startsTool: true });
			this.addTool(event.title, event.status, event.id);
		} else if (event.type === "tool_update") {
			this.disarmPendingUnsendPrompt();
			this.trackToolStatus(event.id, event.status, { startsTool: false });
			this.updateTool(event.status, event.id, event.title);
		} else if (event.type === "error") {
			this.disarmPendingUnsendPrompt();
			this.addError(event.message);
		} else if (event.type === "backend_exit") {
			// The backend died unexpectedly. Mark it dead so queued prompts are
			// preserved (not drained into errors) and the next submit reconnects
			// against a fresh client instead of erroring on the dead one.
			this.cancelPermissionPrompts();
			this.clearCancelGraceTimer();
			this.ready = false;
			this.busy = false;
			this.cancelRequested = false;
			this.afterToolCancelPending = false;
			this.pendingUnsendPrompt = undefined;
			this.statusState = "";
			this.updateSpinner();
		} else if (event.type === "cursor_todos") {
			this.disarmPendingUnsendPrompt();
			this.addNotice(cursorTodosText(event.todos));
		} else if (event.type === "commands") {
			this.availableCommands.set(this.activeKey, event.commands);
			this.commandsLoaded.add(this.activeKey);
			this.updateAutocomplete();
		} else if (event.type === "session_info") {
			this.sessionStates.set(this.activeKey, event.sessionInfo);
			this.refreshCodexThreadStateSnapshot(event.sessionInfo);
			this.updateAutocomplete();
		}
		this.ui.requestRender();
	}

	trackPendingUserEcho(text) {
		const entry = { remaining: text };
		this.pendingUserEchoes.push(entry);
		return entry;
	}

	expirePendingUserEcho(entry) {
		if (!entry) return;
		const index = this.pendingUserEchoes.indexOf(entry);
		if (index !== -1) this.pendingUserEchoes.splice(index, 1);
	}

	consumePendingUserEcho(text) {
		let remaining = text;
		while (remaining && this.pendingUserEchoes.length > 0) {
			const pending = this.pendingUserEchoes[0].remaining;
			if (pending.startsWith(remaining)) {
				const next = pending.slice(remaining.length);
				if (next) this.pendingUserEchoes[0].remaining = next;
				else this.pendingUserEchoes.shift();
				return "";
			}
			if (remaining.startsWith(pending)) {
				remaining = remaining.slice(pending.length);
				this.pendingUserEchoes.shift();
				continue;
			}
			this.pendingUserEchoes.shift();
		}
		return remaining;
	}

	trackToolStatus(id, status, options = {}) {
		const finishedTool = status !== "running";
		this.seenToolThisTurn = true;
		if (!id) {
			if (status === "running") {
				if (options.startsTool !== false) this.activeAnonymousToolCount += 1;
			} else if (this.activeAnonymousToolCount > 0 && options.startsTool !== true) {
				this.activeAnonymousToolCount = Math.max(0, this.activeAnonymousToolCount - 1);
			} else if (options.startsTool === false) {
				const latestActiveId = [...this.activeToolIds].pop();
				if (latestActiveId) this.activeToolIds.delete(latestActiveId);
			}
		} else if (status === "running") {
			this.activeToolIds.add(id);
		} else {
			this.activeToolIds.delete(id);
		}
		if (finishedTool) this.maybeCancelAfterTool();
	}

	updateSpinner() {
		if (!this.statusState && !this.btwThread?.statusState) {
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

	// A btw thread changed state; refresh the spinner driver and repaint.
	onThreadActivity() {
		this.updateSpinner();
		this.ui.requestRender();
	}

	updateAutocomplete() {
		const commands = dedupeCommands([
			...localSlashCommands(this),
			...(this.availableCommands.get(this.activeKey) ?? []),
		]);
		// Rebuilding the provider tears down any open autocomplete popup, so skip
		// it when the effective command set is unchanged (a frequent no-op on
		// every config/mode/session-info update while the user is mid-type).
		const key = `${this.activeKey} ${JSON.stringify(commands.map((command) => [command.name, command.description, command.argumentHint]))}`;
		if (key === this.lastAutocompleteKey) return;
		this.lastAutocompleteKey = key;
		this.editor.setAutocompleteProvider(new LazyCombinedAutocompleteProvider(commands, process.cwd(), null));
	}

	addUserMessage(text, options = {}) {
		if (options.compactCommand) {
			this.addCommandMessage(text);
			return undefined;
		}
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		const spacer = this.addHistorySpacer("user");
		const message = new UserMessage(text);
		this.chat.addChild(message);
		return { spacer, message };
	}

	appendUserText(text) {
		this.closeCurrentAssistantText();
		this.currentToolSummary = undefined;
		if (!this.currentUserText) {
			this.addHistorySpacer("user");
			this.currentUserText = new MutableUserMessage("", () => this.ui.terminal.rows);
			this.chat.addChild(this.currentUserText);
		}
		this.currentUserText.append(text);
	}

	appendAssistantText(text) {
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		if (!this.currentAssistantText) {
			this.addHistorySpacer("assistant");
			this.currentAssistantText = new MutableMarkdown("");
			this.chat.addChild(this.currentAssistantText);
		}
		this.currentAssistantText.append(text);
	}

	addCommandMessage(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("command");
		this.chat.addChild(new CommandMessage(text));
	}

	addNotice(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("notice");
		this.chat.addChild(new Text(chalk.dim(text), 0, 0));
	}

	addTool(title, status, id) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		if (!this.currentToolSummary) {
			this.addHistorySpacer("tool");
			this.currentToolSummary = new ToolSummary(() => this.ui.terminal.rows);
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
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("notice");
		this.chat.addChild(new CtrlCExitHint());
	}

	addError(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("error");
		this.chat.addChild(new Text(chalk.red(`! ${text}`), 0, 0));
	}

	closeCurrentAssistantText() {
		const text = this.currentAssistantText?.text?.trim();
		if (text) this.lastAssistantText = this.currentAssistantText.text;
		this.currentAssistantText?.invalidate();
		this.currentAssistantText = undefined;
	}

	addHistorySpacer(kind) {
		const last = lastRenderableChild(this.chat);
		if (!last) return;
		if (last instanceof CommandMessage) {
			if (kind === "command" || kind === "assistant" || kind === "notice" || kind === "tool") return;
		}
		const spacer = new Spacer(1);
		this.chat.addChild(spacer);
		return spacer;
	}

	stop() {
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		if (this.markdownPreloadTimer) clearTimeout(this.markdownPreloadTimer);
		this.clearCancelGraceTimer();
		this.cancelPermissionPrompts();
		this.voiceController?.dispose();
		if (this.client) this.client.stop();
		// Tear down the /btw fork's backend process too, if one is open.
		this.btwThread?.stop?.();
		this.btwThread = undefined;
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
	}

	invalidate() {
		this.cache = undefined;
	}

	render(width) {
		const text = this.text.trimEnd();
		const renderer = MarkdownComponent ? "markdown" : (this.cache?.renderer ?? "plain");
		if (this.cache?.width === width && this.cache.text === text && this.cache.renderer === renderer) return this.cache.lines.slice();
		const defaultTextStyle = { color: (content) => chalk.text(content) };
		const rendered = renderMarkdown(text, width, 0, 0, defaultTextStyle, renderer);
		const mutableTailLines = streamingMutableTail(text, rendered.length, {
			width,
			renderer,
			defaultTextStyle,
			previousText: this.cache?.text,
			previousRenderer: this.cache?.renderer,
			previousRenderedLineCount: this.cache?.lines.length,
		});
		const lines = stabilizeGrowingRenderedLines(this.cache, { width, text, lines: rendered, renderer }, mutableTailLines);
		this.cache = { width, text, lines, renderer };
		return lines.slice();
	}
}

class MutableUserMessage {
	constructor(text, getMutableTailLines = () => Number.POSITIVE_INFINITY) {
		this.text = text;
		this.getMutableTailLines = getMutableTailLines;
		this.cache = undefined;
	}

	append(text) {
		this.text += text;
	}

	invalidate() {
		this.cache = undefined;
	}

	render(width) {
		const renderer = MarkdownComponent ? "markdown" : (this.cache?.renderer ?? "plain");
		if (this.cache?.width === width && this.cache.text === this.text && this.cache.renderer === renderer) {
			return markUserMessageLines(this.cache.lines);
		}
		const contentWidth = Math.max(1, width);
		const body = renderMarkdown(this.text, contentWidth, 0, 0, { color: (content) => chalk.text(content) }, renderer);
		const rail = chalk.dim("─".repeat(Math.max(1, width)));
		const rendered = [
			rail,
			...body,
			rail,
		];
		const lines = stabilizeGrowingRenderedLines(
			this.cache,
			{ width, text: this.text, lines: rendered, renderer },
			this.getMutableTailLines(),
		);
		this.cache = { width, text: this.text, lines, renderer };
		return markUserMessageLines(lines);
	}
}

class UserMessage extends MutableUserMessage {}

class MutableCommandMessage {
	constructor(text) {
		this.text = text;
	}

	append(text) {
		this.text += text;
	}

	invalidate() {}

	render(width) {
		return [chalk.dim(truncateVisual(oneLine(this.text), width))];
	}
}

class CommandMessage extends MutableCommandMessage {}

class ToolSummary {
	constructor(getMutableTailLines = () => 0) {
		this.tools = [];
		this.getMutableTailLines = getMutableTailLines;
		this.cache = undefined;
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

	invalidate() {
		this.cache = undefined;
	}

	render(width) {
		if (this.tools.length === 0) return [];
		const terminalRows = this.getMutableTailLines();
		const longSummary = this.tools.length > terminalRows;
		const rendered = this.tools
			.map((tool) => `${longSummary ? "•" : toolGlyph(tool.status)} ${tool.title}`)
			.map((line) => chalk.dim(truncateVisual(line, width)));
		if (longSummary) rendered.push(chalk.dim(truncateVisual(toolSummaryFooter(this.tools), width)));
		const previousLineCount = this.cache?.lines.length ?? 0;
		const mutableTailLines = previousLineCount <= terminalRows ? terminalRows : (longSummary ? 1 : 0);
		// For summaries taller than the terminal, rewriting historical rows replays
		// the block into tmux scrollback/copy-mode panes. Keep rows append-stable
		// and expose status changes through the mutable aggregate footer.
		const lines = stabilizeMutableRenderedLines(this.cache, { width, lines: rendered }, mutableTailLines);
		this.cache = { width, lines };
		return lines.slice();
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
			const prefix = entry.timing === "afterTool" ? `${this.getSpinner()} after tool` : "⇥ queued";
			return chalk.dim(truncateVisual(`${prefix}: ${oneLine(entry.displayText ?? entry.text)}`, width));
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

function toolGlyph(status) {
	if (status === "complete") return "✓";
	if (status === "error") return "×";
	if (status === "canceled") return "×";
	return "•";
}

function toolSummaryFooter(tools) {
	const counts = new Map();
	for (const tool of tools) counts.set(tool.status, (counts.get(tool.status) ?? 0) + 1);
	const parts = [
		["running", "running"],
		["complete", "complete"],
		["error", "error"],
		["canceled", "canceled"],
	]
		.map(([status, label]) => {
			const count = counts.get(status) ?? 0;
			return count > 0 ? `${count} ${label}` : undefined;
		})
		.filter(Boolean);
	return `• ${tools.length} tools · ${parts.join(" · ")}`;
}

function markUserMessageLines(lines) {
	if (lines.length === 0) return [];
	const marked = lines.slice();
	marked[0] = OSC133_ZONE_START + marked[0];
	marked[marked.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + marked[marked.length - 1];
	return marked;
}

function lastRenderableChild(container) {
	for (let index = container.children.length - 1; index >= 0; index--) {
		const child = container.children[index];
		if (!(child instanceof Spacer)) return child;
	}
	return undefined;
}

function invalidateRenderableTree(node) {
	if (!node) return;
	node.invalidate?.();
	if (Array.isArray(node.children)) {
		for (const child of node.children) invalidateRenderableTree(child);
	}
}

export function stabilizeGrowingRenderedLines(previous, next, mutableTailLines = STREAMING_MARKDOWN_MUTABLE_TAIL_LINES) {
	if (!previous || previous.width !== next.width) return next.lines.slice();
	if (next.text.length <= previous.text.length || !next.text.startsWith(previous.text)) return next.lines.slice();
	// A growing prefix is diffed line-by-line even across a plain->markdown
	// renderer flip (the async markdown load landing mid-stream), so already
	// committed/scrolled-off lines stay byte-stable and never force a repaint.
	return stabilizeMutableRenderedLines(previous, next, mutableTailLines);
}

// How many trailing rendered lines may still restructure as more text streams.
// Closed markdown blocks never change, so only the open trailing block needs to
// stay mutable; freezing everything before it keeps scrolled-off lines stable.
export function streamingMutableTail(text, renderedLineCount, options = {}) {
	const sourceLines = String(text).split("\n");
	let fenceOpen = false;
	let fenceStart = -1;
	let fenceChar = "";
	let fenceLen = 0;
	for (let index = 0; index < sourceLines.length; index += 1) {
		const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(sourceLines[index]);
		if (!fence) continue;
		const marker = fence[1][0];
		const runLength = fence[1].length;
		if (fenceOpen) {
			// CommonMark: a closing fence must use the same marker character, be at
			// least as long as the opener, and carry no info string. Anything else
			// (a different marker, a shorter run, or trailing text) is block content,
			// so the fence stays open — the conservative, freeze-avoiding direction.
			if (marker !== fenceChar || runLength < fenceLen || fence[2].trim() !== "") continue;
			fenceOpen = false;
			fenceStart = -1;
			fenceChar = "";
			fenceLen = 0;
		} else {
			fenceOpen = true;
			fenceStart = index;
			fenceChar = marker;
			fenceLen = runLength;
		}
	}
	if (fenceOpen && fenceStart >= 0) {
		// An open code fence re-styles its whole block when it closes; keep it mutable.
		const openSourceLines = sourceLines.length - fenceStart;
		return Math.min(renderedLineCount, Math.max(STREAMING_MARKDOWN_MUTABLE_TAIL_LINES, openSourceLines + 2));
	}

	const activeTableStartLine = activeMarkdownTableStartLine(sourceLines);
	const tableStartLine = activeTableStartLine >= 0
		? activeTableStartLine
		: previousActiveMarkdownTableStartLine(options.previousText, sourceLines);
	if (tableStartLine >= 0) {
		if (!options.width || !options.renderer) return renderedLineCount;
		if (options.previousRenderer && options.previousRenderer !== options.renderer) return renderedLineCount;
		const prefixText = sourceLines.slice(0, tableStartLine).join("\n").trimEnd();
		const prefixLineCount = prefixText
			? renderMarkdown(prefixText, options.width, 0, 0, options.defaultTextStyle, options.renderer).length
			: 0;
		// A pipe table's terminal rendering is width-aware across the whole table:
		// adding a wider row can change every earlier border/header line. Keep the
		// active or just-active table mutable while it can still be remeasured.
		const lineCountForTail = options.previousRenderedLineCount ?? renderedLineCount;
		return Math.min(renderedLineCount, Math.max(STREAMING_MARKDOWN_MUTABLE_TAIL_LINES, lineCountForTail - prefixLineCount));
	}
	return STREAMING_MARKDOWN_MUTABLE_TAIL_LINES;
}

function previousActiveMarkdownTableStartLine(previousText, sourceLines) {
	if (previousText === undefined) return -1;
	const previousStart = activeMarkdownTableStartLine(String(previousText).split("\n"));
	if (previousStart < 0) return -1;
	return hasMarkdownTableAtLine(sourceLines, previousStart) ? previousStart : -1;
}

function activeMarkdownTableStartLine(sourceLines) {
	let end = sourceLines.length - 1;
	let trailingBlankLines = 0;
	while (end >= 0 && sourceLines[end].trim() === "") {
		trailingBlankLines += 1;
		end -= 1;
	}
	if (end < 0 || trailingBlankLines >= 2) return -1;

	let blockStart = end;
	while (blockStart > 0 && sourceLines[blockStart - 1].trim() !== "") {
		blockStart -= 1;
	}

	for (let index = blockStart + 1; index <= end; index += 1) {
		if (isMarkdownTableDelimiterLine(sourceLines[index]) && isMarkdownTableRowLine(sourceLines[index - 1])) {
			return index - 1;
		}
	}
	return -1;
}

function hasMarkdownTableAtLine(sourceLines, startLine) {
	if (!isMarkdownTableRowLine(sourceLines[startLine])) return false;
	for (let index = startLine + 1; index < sourceLines.length && String(sourceLines[index]).trim() !== ""; index += 1) {
		if (isMarkdownTableDelimiterLine(sourceLines[index])) return true;
	}
	return false;
}

function isMarkdownTableRowLine(line) {
	const trimmed = markdownTableSyntaxText(line);
	return trimmed.length > 0 && /(^|[^\\])\|/.test(trimmed);
}

function isMarkdownTableDelimiterLine(line) {
	const trimmed = markdownTableSyntaxText(line).replace(/^\|/, "").replace(/\|$/, "");
	const cells = trimmed.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
	return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function markdownTableSyntaxText(line) {
	let text = String(line);
	while (/^\s{0,3}>\s?/.test(text)) text = text.replace(/^\s{0,3}>\s?/, "");
	text = text.replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "");
	return text.trim();
}

export function stabilizeMutableRenderedLines(previous, next, mutableTailLines = 0) {
	if (!previous || previous.width !== next.width) return next.lines.slice();
	if (next.lines.length < previous.lines.length) return next.lines.slice();

	const protectedPrefixLength = Math.max(0, previous.lines.length - Math.max(0, mutableTailLines));
	if (protectedPrefixLength === 0) return next.lines.slice();

	let commonPrefixLength = 0;
	while (
		commonPrefixLength < protectedPrefixLength &&
		previous.lines[commonPrefixLength] === next.lines[commonPrefixLength]
	) {
		commonPrefixLength += 1;
	}
	if (commonPrefixLength >= protectedPrefixLength) return next.lines.slice();

	return [
		...previous.lines.slice(0, protectedPrefixLength),
		...next.lines.slice(protectedPrefixLength),
	];
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

function permissionTitle(params = {}) {
	const toolCall = params.toolCall ?? params.tool_call ?? {};
	const title = toolCall.title ?? toolCall.name ?? params.title;
	return title ? `Permission: ${oneLine(title)}` : "Permission request";
}

function permissionOptionLabel(option = {}, index = 0) {
	return oneLine(option.name ?? option.label ?? humanizePermissionKind(option.kind) ?? `Option ${index + 1}`);
}

function permissionOptionDescription(option = {}) {
	const parts = [
		option.description,
		option.kind ? humanizePermissionKind(option.kind) : undefined,
	].filter(Boolean);
	return parts.length > 0 ? parts.map(oneLine).join(" · ") : undefined;
}

export function autoPermissionOutcome(params = {}) {
	const option = autoPermissionOption(Array.isArray(params.options) ? params.options : []);
	return option?.optionId ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

function autoPermissionOption(options) {
	const allowed = options.filter(isAllowPermissionOption);
	return (
		allowed.find((option) => option.optionId === "bypassPermissions") ??
		allowed.find((option) => String(option.kind ?? "").toLowerCase() === "allow_always") ??
		allowed[0]
	);
}

function isAllowPermissionOption(option = {}) {
	const kind = String(option.kind ?? "").toLowerCase();
	if (kind.includes("reject") || kind.includes("deny") || kind.includes("cancel")) return false;
	if (kind.includes("allow") || kind.includes("approve")) return true;
	const text = `${option.optionId ?? ""} ${option.name ?? ""} ${option.label ?? ""}`.toLowerCase();
	return /\b(allow|approve|yes|accept|bypass)\b/.test(text) && !/\b(reject|deny|cancel|no)\b/.test(text);
}

function humanizePermissionKind(kind) {
	if (!kind) return undefined;
	return String(kind)
		.replace(/_/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

function cursorCancelResult(method) {
	if (method === "cursor/create_plan") return { outcome: { outcome: "rejected", reason: "Cancelled" } };
	if (method === "cursor/ask_question") return { outcome: { outcome: "cancelled" } };
	return {};
}

export function autoCursorOutcome(method, params = {}) {
	if (method === "cursor/create_plan") return { outcome: { outcome: "accepted" } };
	if (method === "cursor/ask_question") {
		const answers = (Array.isArray(params.questions) ? params.questions : []).map((question) => ({
			questionId: question.id,
			selectedOptionIds: question.options?.[0]?.id ? [question.options[0].id] : [],
		}));
		return { outcome: { outcome: "answered", answers } };
	}
	return {};
}

function cursorTaskLine(params = {}) {
	const type = params.subagentType ? ` (${oneLine(params.subagentType)})` : "";
	const description = params.description ?? params.prompt ?? "subagent task";
	return `• Subagent${type}: ${oneLine(description)}`;
}

function cursorTodoGlyph(status) {
	const value = oneLine(status).toLowerCase();
	if (value === "completed" || value === "complete") return "✓";
	if (value === "in_progress") return "▸";
	if (value === "cancelled" || value === "canceled") return "×";
	return "○";
}

function cursorPlanText(params = {}) {
	const lines = [];
	const heading = params.name ?? params.overview;
	if (heading) lines.push(`Plan: ${oneLine(heading)}`);
	if (params.overview && params.overview !== heading) lines.push(oneLine(params.overview));
	for (const todo of Array.isArray(params.todos) ? params.todos : []) {
		lines.push(`  ${cursorTodoGlyph(todo.status)} ${oneLine(todo.content ?? "")}`);
	}
	return lines.length > 0 ? lines.join("\n") : "Proposed plan";
}

function cursorTodosText(todos) {
	const list = Array.isArray(todos) ? todos : [];
	if (list.length === 0) return "• todos updated";
	return ["• todos", ...list.map((todo) => `  ${cursorTodoGlyph(todo.status)} ${oneLine(todo.content ?? "")}`)].join("\n");
}

function normalizedToolStatus(status) {
	const value = oneLine(status).toLowerCase();
	const normalized = value.replace(/[\s-]+/g, "_");
	if ([
		"completed",
		"complete",
		"succeeded",
		"success",
		"done",
		"finished",
		"finished_successfully",
		"successful",
		"ok",
		"passed",
	].includes(normalized)) return "complete";
	if ([
		"failed",
		"failure",
		"error",
		"errored",
		"rejected",
		"denied",
	].includes(normalized)) return "error";
	if ([
		"canceled",
		"cancelled",
		"aborted",
		"abort",
		"stopped",
		"timed_out",
		"timeout",
	].includes(normalized)) return "canceled";
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
		text: (text) => text,
		underline: style("\x1b[4m", "\x1b[24m"),
		yellow: style("\x1b[33m", "\x1b[39m"),
	};
}

function createThemeStyles(themeName) {
	const theme = themeByName(themeName);
	if (theme.system) return createAnsiStyles();
	const colors = theme.colors;
	const fg = (role) => truecolorStyle(colors[role], "fg");
	const fgHex = (hex) => truecolorStyle(hex, "fg");
	const selection = (text) => `${truecolorOpen(colors.selectionText, "fg")}${truecolorOpen(colors.selectionBackground, "bg")}${text}\x1b[39m\x1b[49m`;
	const black = Object.assign(fg("selectionText"), { bgBlue: selection });
	return {
		black,
		blue: fg("primary"),
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		cyan: fg("accent"),
		dim: fg("textMuted"),
		green: fg("success"),
		italic: (text) => `\x1b[3m${text}\x1b[23m`,
		magenta: fgHex(colors.secondary),
		red: fg("error"),
		strikethrough: (text) => `\x1b[9m${text}\x1b[29m`,
		text: fg("text"),
		underline: (text) => `\x1b[4m${text}\x1b[24m`,
		yellow: fg("markdownCode"),
	};
}

function setActiveTheme(themeName) {
	const canonical = resolveThemeName(themeName) ?? "system";
	activeThemeName = canonical;
	Object.assign(chalk, createThemeStyles(canonical));
}

export function resolveThemeName(value) {
	const key = normalizeThemeKey(value);
	if (!key) return undefined;
	if (BUILTIN_THEMES[key]) return key;
	const alias = THEME_ALIASES[key] ?? THEME_ALIASES[key.replace(/[-_]/g, "")];
	return BUILTIN_THEMES[alias] ? alias : undefined;
}

export function themeNames() {
	const ordered = THEME_DISPLAY_ORDER.filter((name) => BUILTIN_THEMES[name]);
	const seen = new Set(ordered);
	return [...ordered, ...Object.keys(BUILTIN_THEMES).filter((name) => !seen.has(name))];
}

function themeByName(themeName) {
	return BUILTIN_THEMES[resolveThemeName(themeName) ?? "system"];
}

function themeLabel(themeName) {
	return themeByName(themeName).label;
}

function themeEntries(activeTheme) {
	return themeNames().map((name) => ({
		value: name,
		label: BUILTIN_THEMES[name].label,
		description: BUILTIN_THEMES[name].description,
		active: name === activeTheme,
	}));
}

function normalizeThemeKey(value) {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
}

function compactThemeSwatches(themeName) {
	const roles = ["primary", "secondary", "accent", "success", "warning", "error"];
	return roles.map((role) => themeSwatch(themeName, role, "  ")).join(" ");
}

function themePaletteLines(themeName) {
	const theme = themeByName(themeName);
	const lines = [chalk.bold(`Palette: ${theme.label}`)];
	for (let index = 0; index < THEME_ROLE_ORDER.length; index += 3) {
		const group = THEME_ROLE_ORDER.slice(index, index + 3).map((role) => {
			const hex = theme.colors[role];
			return `${themeSwatch(themeName, role, "  ")} ${role} ${hex}`;
		});
		lines.push(group.join("  "));
	}
	return lines;
}

function themePreviewLines(themeName, width) {
	const theme = themeByName(themeName);
	const styles = createThemeStyles(themeName);
	const contentWidth = Math.max(12, Math.min(46, width - 2));
	const rail = styles.dim("─".repeat(contentWidth));
	const sample = [
		styles.bold(`Preview: ${theme.label}`),
		rail,
		styles.dim(`/theme (${theme.label})`),
		`You ${styles.dim("asked")}: Build theme support`,
		`${styles.blue("Assistant")} ${styles.dim("uses markdown")} ${styles.yellow("`code`")} ${styles.cyan("link")}`,
		`${styles.green ? styles.green("✓") : styles.cyan("✓")} Tool complete`,
		styles.red("! Example error"),
		styles.blue(`┌${"─".repeat(Math.max(1, contentWidth - 2))}┐`),
		styles.blue("│") + truncateVisual(" Space to record · Ctrl+Space for text".padEnd(contentWidth - 2), contentWidth - 2) + styles.blue("│"),
		styles.blue(`└${"─".repeat(Math.max(1, contentWidth - 2))}┘`),
	];
	return sample;
}

function themeSwatch(themeName, role, text = "  ") {
	const color = themeByName(themeName).colors[role] ?? "#ffffff";
	return `${truecolorOpen(color, "bg")}${text}\x1b[49m`;
}

function truecolorStyle(hex, target = "fg") {
	const open = truecolorOpen(hex, target);
	const close = target === "bg" ? "\x1b[49m" : "\x1b[39m";
	return (text) => `${open}${text}${close}`;
}

function truecolorOpen(hex, target = "fg") {
	const rgb = hexToRgb(hex);
	const code = target === "bg" ? 48 : 38;
	return `\x1b[${code};2;${rgb.r};${rgb.g};${rgb.b}m`;
}

function hexToRgb(hex) {
	const match = String(hex ?? "").match(/^#?([0-9a-f]{6})$/i);
	const value = match ? match[1] : "ffffff";
	return {
		r: Number.parseInt(value.slice(0, 2), 16),
		g: Number.parseInt(value.slice(2, 4), 16),
		b: Number.parseInt(value.slice(4, 6), 16),
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
		{ name: "btw", description: "Fork this conversation into a side thread (full context + tools)", argumentHint: "<question>" },
		{ name: "diff", description: "Show the working-tree git diff" },
		{ name: "copy", description: "Copy the last response to the clipboard" },
		themeSlashCommand(app),
	];
	const addIfMissing = (command) => {
		if (!commands.some((existing) => existing.name === command.name)) commands.push(command);
	};

	addIfMissing({ name: "resume", description: "Resume a previous ACP session" });
	addIfMissing({ name: "new", description: "Start a new ACP session" });
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
	else if (flattenModes(state).length > 0) replaceCommand(commands, modeSlashCommand("mode", "Change agent mode", state));

	const effortOption = findConfigOption(state, "thought_level");
	if (effortOption) {
		const effortCommand = configSlashCommand("effort", "Change reasoning effort", effortOption);
		replaceCommand(commands, effortCommand);
		replaceCommand(commands, { ...effortCommand, name: "reasoning" });
		replaceCommand(commands, { ...effortCommand, name: "thinking" });
	}

	const hasPlanMode = Boolean(findConfigValue(modeOption, "plan") || findMode(state, "plan"));
	if (hasPlanMode) addIfMissing({ name: "plan", description: "Switch to plan mode" });

	return commands;
}

function themeSlashCommand(app) {
	const entries = themeEntries(app.themeName);
	return {
		name: "theme",
		description: "Change color theme",
		argumentHint: `[${entries.map((entry) => entry.value).join("|")}]`,
		getArgumentCompletions: (prefix) =>
			entries
				.filter((entry) => entry.value.startsWith(prefix) || entry.label.toLowerCase().includes(prefix.toLowerCase()))
				.map((entry) => ({
					value: entry.value,
					label: entry.label,
					description: entry.description,
				})),
	};
}

function shouldDeferLocalSlashCommand(name) {
	return ["resume", "model", "mode", "effort", "reasoning", "thinking", "plan"].includes(name);
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

function modeSlashCommand(name, description, state) {
	const values = flattenModes(state);
	return {
		name,
		description,
		argumentHint: `[${values.map((entry) => entry.id).join("|")}]`,
		getArgumentCompletions: (prefix) =>
			values
				.filter((entry) => entry.id.startsWith(prefix) || entry.name.toLowerCase().includes(prefix.toLowerCase()))
				.map((entry) => ({
					value: entry.id,
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

function renderMarkdown(text, width, paddingX = 0, paddingY = 0, defaultTextStyle, renderer = MarkdownComponent ? "markdown" : "plain") {
	const Markdown = MarkdownComponent;
	if (renderer === "markdown" && Markdown) return new Markdown(text, paddingX, paddingY, MARKDOWN_THEME, defaultTextStyle).render(width);
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

function isHarnessCommandText(text) {
	return new RegExp(`^${escapeRegExp(HARNESS)}(?:\\s|$)`).test(text);
}

function slashCommandText(name, argument = "") {
	const command = String(name ?? "").startsWith("/") ? String(name ?? "") : `/${name ?? ""}`;
	const suffix = oneLine(argument);
	return suffix ? `${command} ${suffix}` : command;
}

function slashPromptDisplay(prompt, label) {
	return `${prompt} (${label})`;
}

function reviewPromptDisplay(prompt, label) {
	return slashPromptDisplay(prompt, label);
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isMouseInput(data) {
	return typeof data === "string" && (/^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || /^\x1b\[M[\s\S]{3}$/.test(data));
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

async function readClipboardImage() {
	if (process.platform === "darwin") return await readMacClipboardImage();
	if (process.platform === "win32" || isWsl()) return await readWindowsClipboardImage();
	if (process.platform === "linux") return await readLinuxClipboardImage();
	return undefined;
}

async function readMacClipboardImage() {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cc-clipboard-"));
	const file = path.join(dir, "clipboard.png");
	const escaped = file.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	try {
		await runCapture("osascript", [
			"-e",
			'set imageData to the clipboard as "PNGf"',
			"-e",
			`set fileRef to open for access POSIX file "${escaped}" with write permission`,
			"-e",
			"set eof fileRef to 0",
			"-e",
			"write imageData to fileRef",
			"-e",
			"close access fileRef",
		]);
		const data = await fs.promises.readFile(file);
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png" };
	} catch {
		return undefined;
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function readWindowsClipboardImage() {
	const script =
		"Add-Type -AssemblyName System.Windows.Forms; " +
		"$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
		"if ($img) { $ms = New-Object System.IO.MemoryStream; " +
		"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); " +
		"[System.Convert]::ToBase64String($ms.ToArray()) }";
	try {
		const result = await runCapture("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script]);
		const base64 = result.stdout.toString("utf8").trim();
		if (!base64) return undefined;
		const data = Buffer.from(base64, "base64");
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png" };
	} catch {
		return undefined;
	}
}

async function readLinuxClipboardImage() {
	const wayland = await runCapture("wl-paste", ["-t", "image/png"], { rejectOnExit: false }).catch(() => undefined);
	if (wayland?.stdout?.length > 0) return { data: wayland.stdout.toString("base64"), mimeType: "image/png" };
	const x11 = await runCapture("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], { rejectOnExit: false }).catch(() => undefined);
	if (x11?.stdout?.length > 0) return { data: x11.stdout.toString("base64"), mimeType: "image/png" };
	return undefined;
}

function runCapture(command, args = [], options = {}) {
	const timeoutMs = options.timeoutMs ?? CLIPBOARD_IMAGE_TIMEOUT_MS;
	const rejectOnExit = options.rejectOnExit !== false;
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		const stdout = [];
		const stderr = [];
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGTERM");
			} catch {}
			reject(new Error(`${command} timed out`));
		}, timeoutMs);
		timer.unref?.();

		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve(result);
		};

		child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.once("error", (error) => finish(error));
		child.once("close", (code, signal) => {
			const result = { code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
			if (rejectOnExit && code !== 0) {
				const details = result.stderr.toString("utf8").trim();
				finish(new Error(`${command} exited ${signal ?? code}${details ? `: ${oneLine(details)}` : ""}`));
				return;
			}
			finish(undefined, result);
		});
	});
}

function isWsl(env = process.env, release = os.release()) {
	return Boolean(env.WSL_DISTRO_NAME || /microsoft|wsl/i.test(release));
}

function codexHome() {
	return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexStateDbPath() {
	return path.join(codexHome(), "state_5.sqlite");
}

function sqlString(value) {
	return `'${String(value).replaceAll("'", "''")}'`;
}

export function readCodexThreadState(sessionId, dbPath = codexStateDbPath()) {
	if (!sessionId) return undefined;
	if (!fs.existsSync(dbPath)) return undefined;
	const sessionsRoot = path.join(path.dirname(dbPath), "sessions");
	const sql = [
		"select id, rollout_path, updated_at, updated_at_ms, has_user_event, archived,",
		"tokens_used, title, first_user_message, preview, model, reasoning_effort",
		"from threads",
		`where id = ${sqlString(sessionId)}`,
		"limit 1;",
	].join(" ");
	const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
		encoding: "utf8",
		timeout: 1000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return undefined;
	let rows;
	try {
		rows = JSON.parse(result.stdout || "[]");
	} catch {
		return undefined;
	}
	const row = rows?.[0];
	if (!row) {
		const rolloutPath = findCodexRolloutPath(sessionId, sessionsRoot);
		return {
			sessionId,
			row: null,
			rollout: codexRolloutStat(rolloutPath) ?? null,
		};
	}
	const rollout = codexRolloutStat(row.rollout_path) ?? null;
	return {
		sessionId,
		row,
		rollout,
	};
}

function codexRolloutStat(rolloutPath) {
	if (!rolloutPath) return undefined;
	try {
		const stat = fs.statSync(rolloutPath);
		return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
	} catch {
		return undefined;
	}
}

function codexThreadStatesEqual(a, b) {
	return Boolean(a && b && JSON.stringify(a) === JSON.stringify(b));
}

// Locate a Codex rollout file for a thread id by scanning $CODEX_HOME/sessions
// newest-first (the layout is sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl).
export function findCodexRolloutPath(sessionId, root = path.join(codexHome(), "sessions")) {
	if (!sessionId) return undefined;
	return findRolloutFile(root, `-${sessionId}.jsonl`, 0);
}

function findRolloutFile(dir, suffix, depth) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		// Match the plain rollout; also match a compressed one so the caller can
		// report it rather than silently failing to locate the session.
		if (entry.isFile() && (entry.name.endsWith(suffix) || entry.name.endsWith(`${suffix}.zst`))) {
			return path.join(dir, entry.name);
		}
	}
	if (depth >= 5) return undefined;
	const dirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
		.reverse();
	for (const name of dirs) {
		const found = findRolloutFile(path.join(dir, name), suffix, depth + 1);
		if (found) return found;
	}
	return undefined;
}

// Copy a rollout to a sibling file named with newId, replacing every occurrence
// of the old thread uuid (header + item records) so the copy is a consistent,
// independent branch. Returns the new file path.
export function copyCodexRolloutWithNewId(srcPath, oldId, newId) {
	const content = fs.readFileSync(srcPath, "utf8");
	const rewritten = content.split(oldId).join(newId);
	const destName = path.basename(srcPath).split(oldId).join(newId);
	const dest = path.join(path.dirname(srcPath), destName);
	fs.writeFileSync(dest, rewritten);
	return dest;
}

function truncateDiff(text, maxLines = 500) {
	const lines = String(text).split("\n");
	if (lines.length <= maxLines) return text;
	return [...lines.slice(0, maxLines), `… (${lines.length - maxLines} more lines truncated)`].join("\n");
}

function writeClipboardText(text) {
	const targets =
		process.platform === "darwin"
			? [["pbcopy", []]]
			: process.platform === "win32"
				? [["clip", []]]
				: [
						["wl-copy", []],
						["xclip", ["-selection", "clipboard"]],
						["xsel", ["--clipboard", "--input"]],
					];
	return writeToFirstClipboardTarget(targets, text);
}

async function writeToFirstClipboardTarget(targets, text) {
	let lastError;
	for (const [command, args] of targets) {
		try {
			await pipeToCommand(command, args, text);
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError ?? new Error("No clipboard tool available");
}

function pipeToCommand(command, args, input) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const done = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		// wl-copy and friends keep serving the selection and never exit; once
		// stdin is flushed, treat that as success after a short grace period.
		const timer = setTimeout(() => done(undefined), 500);
		timer.unref?.();
		child.once("error", (error) => done(error));
		child.once("close", (code) => done(code === 0 ? undefined : new Error(`${command} exited ${code}`)));
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
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

function imageAttachmentsFromPromptParts(text, promptParts) {
	if (!Array.isArray(promptParts)) return [];
	const imageParts = promptParts.filter((part) => part?.type === "image" && part.data);
	if (imageParts.length === 0) return [];
	const labels = [...String(text ?? "").matchAll(/\[Image \d+\]/g)].map((match) => match[0]);
	return imageParts.slice(0, labels.length).map((part, index) => ({
		label: labels[index],
		data: part.data,
		mimeType: part.mimeType ?? part.mime_type ?? "image/png",
	}));
}

function hasImagePromptPart(promptParts) {
	return Array.isArray(promptParts) && promptParts.some((part) => part?.type === "image");
}

function imagePromptCapability(capabilities) {
	if (!capabilities || Object.keys(capabilities).length === 0) return undefined;
	return capabilities.promptCapabilities?.image === true;
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

function isTabInput(data) {
	return matchesKey(data, "tab");
}

function isClipboardPasteInput(data) {
	return (
		data === "\x16" ||
		matchesKey(data, "ctrl+v") ||
		matchesKey(data, "ctrl+shift+v") ||
		matchesKey(data, "super+v") ||
		data === "\x1b[200~\x1b[201~"
	);
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
	const useAlternateScreen = isVsCodeTerminal();
	let resizeTimer;
	let fullClearReplacementOnce;
	terminal.useFullClearReplacementOnce = (replacement) => {
		fullClearReplacementOnce = replacement;
	};
	terminal.start = (onInput, onResize) => {
		start(onInput, () => {
			if (RESIZE_SETTLE_DELAY_MS <= 0) {
				// Still run the resize lifecycle so prepareResizeFullClear primes the
				// relative-move clear; otherwise the forced render falls back to the
				// stale DECRC clear and leaves garbled rows after a resize.
				resizeHooks.onResizeStart?.();
				resizeHooks.onResizeEnd?.();
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
		if (useAlternateScreen) {
			write("\x1b[?1049h\x1b[2J\x1b[H");
			delete process.env.CC_PREPAINTED;
			delete process.env.CC_PREPAINT_AGENT;
			delete process.env.CC_PREPAINT_THEME;
			delete process.env.CC_ADOPTED_PREPAINT;
		} else if (process.env.CC_PREPAINTED === "1") {
			if (process.env.CC_ADOPTED_PREPAINT !== "1") write("\x1b8\x1b[J\x1b7");
			delete process.env.CC_PREPAINTED;
			delete process.env.CC_PREPAINT_AGENT;
			delete process.env.CC_PREPAINT_THEME;
			delete process.env.CC_ADOPTED_PREPAINT;
		} else {
			write("\x1b7");
		}
	};
	terminal.stop = () => {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = undefined;
		resizeHooks.onResizeEnd?.({ render: false });
		stop();
		if (useAlternateScreen) write("\x1b[?1049l\x1b[?25h");
	};
	terminal.write = (data) => {
		const hasFullClear = data.includes("\x1b[2J\x1b[H\x1b[3J");
		const fullClearReplacement = hasFullClear ? fullClearReplacementOnce : undefined;
		if (hasFullClear) fullClearReplacementOnce = undefined;
		const rewritten = rewriteFullScreenClear(data, { alternateScreen: useAlternateScreen, fullClearReplacement });
		write(hideCursorDuringRender(rewritten));
	};
	return terminal;
}

export function hideCursorDuringRender(data) {
	const syncStart = "\x1b[?2026h";
	const hideCursor = "\x1b[?25l";
	if (!data.includes(syncStart)) return data;

	let output = "";
	let index = 0;
	while (index < data.length) {
		const syncIndex = data.indexOf(syncStart, index);
		if (syncIndex === -1) {
			output += data.slice(index);
			break;
		}
		const afterSync = syncIndex + syncStart.length;
		output += data.slice(index, afterSync);
		if (!data.startsWith(hideCursor, afterSync)) output += hideCursor;
		index = afterSync;
	}
	return output;
}

export function rewriteFullScreenClear(data, options = {}) {
	const fullClear = PI_TUI_FULL_CLEAR;
	if (!data.includes("\x1b[3J")) return data;
	if (!data.includes(fullClear)) return data.replaceAll("\x1b[3J", "");
	if (options.alternateScreen) return data.replaceAll(fullClear, "\x1b[2J\x1b[H");
	return data.replaceAll(fullClear, options.fullClearReplacement ?? "\x1b8\x1b[J\x1b7");
}

function shouldUseNativeResizeFullClear(ui, terminal) {
	if ((ui.previousViewportTop || 0) > 0) return true;
	const previousLines = ui.previousLines ?? [];
	if (previousLines.length === 0) return false;
	const width = Math.max(1, terminal.columns || ui.previousWidth || 1);
	const height = Math.max(1, terminal.rows || ui.previousHeight || 1);
	const reflowedRows = estimatedTerminalRowsAfterReflow(previousLines, width);
	return reflowedRows !== previousLines.length || reflowedRows > height;
}

function estimatedTerminalRowsAfterReflow(lines, width) {
	const safeWidth = Math.max(1, width);
	return lines.reduce((rowCount, line) => rowCount + Math.max(1, Math.ceil(visibleWidth(line) / safeWidth)), 0);
}

export function isVsCodeTerminal(env = process.env) {
	return env.TERM_PROGRAM === "vscode" || Boolean(env.VSCODE_PID || env.VSCODE_INJECTION);
}

export function shouldDropVsCodeAutoActivationInput(text, context = {}, env = process.env) {
	const command = String(text ?? "").trim();
	const burstText = context.burst?.text?.trim();
	const submitAgeMs = (context.now ?? Infinity) - (context.burst?.lastAt ?? -Infinity);
	return (
		isVsCodeTerminal(env) &&
		Boolean(burstText) &&
		burstText === command &&
		(context.burst?.maxGapMs ?? Infinity) <= VS_CODE_AUTO_ACTIVATION_MAX_INPUT_GAP_MS &&
		submitAgeMs >= 0 &&
		submitAgeMs <= VS_CODE_AUTO_ACTIVATION_MAX_SUBMIT_AGE_MS &&
		isVsCodeAutoActivationCommand(command)
	);
}

export function isVsCodeAutoActivationCommand(text) {
	const command = String(text ?? "").trim();
	if (!command || /[\r\n]/.test(command)) return false;
	if (/^(?:source|\.)\s+(?:"[^"\r\n]*\/bin\/activate"|'[^'\r\n]*\/bin\/activate'|\S*\/bin\/activate)\s*$/.test(command)) {
		return true;
	}
	const activationMatch = command.match(/^(conda|mamba|micromamba|pyenv)\s+activate(?:\s+(.+))?$/);
	if (!activationMatch) return false;
	const argument = activationMatch[2]?.trim();
	return !argument || isSingleShellToken(argument);
}

function isSingleShellToken(value) {
	return /^(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'`;&|<>()[\]{}]+)$/.test(value);
}

function splitControlInput(data) {
	if (typeof data !== "string" || data.length <= 1) return undefined;
	// Never split a bracketed paste: its content may contain literal control
	// bytes that are not Ctrl+C/Ctrl+D. The editor's paste handler strips them.
	if (data.includes("\x1b[200~")) return undefined;
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

export function findConfigValue(option, target) {
	const normalizedTarget = String(target ?? "").toLowerCase();
	return flattenConfigOptions(option).find((entry) => entry.value === target || entry.name.toLowerCase() === normalizedTarget);
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

export function flattenModes(state) {
	const modes = state?.modes?.availableModes;
	if (!Array.isArray(modes)) return [];
	return modes
		.map((mode) => {
			const id = mode?.id ?? mode?.modeId ?? mode?.value;
			const name = mode?.name ?? mode?.label ?? id;
			return {
				id,
				name,
				description: mode?.description,
			};
		})
		.filter((mode) => mode.id && mode.name);
}

export function findMode(state, target) {
	const normalizedTarget = String(target ?? "").toLowerCase();
	return flattenModes(state).find((mode) => mode.id === target || mode.name.toLowerCase() === normalizedTarget);
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

export function loadConfig() {
	const file = configPath();
	const user = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	const config = deepMerge(DEFAULT_CONFIG, user);
	const settings = normalizeSettings(deepMerge(config.settings ?? {}, loadSettings()), config.theme);
	return applyHarnessSettings(config, settings);
}

function configPath() {
	if (process.env.CC_CONFIG) return process.env.CC_CONFIG;
	return path.join(os.homedir(), ".config", "cc", "config.json");
}

function loadSettings() {
	const file = settingsPath();
	if (!fs.existsSync(file)) return {};
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

function settingsPath() {
	if (process.env.CC_SETTINGS) return process.env.CC_SETTINGS;
	return path.join(os.homedir(), ".config", "cc", "settings.json");
}

// /btw forks reuse the parent's title, so they are indistinguishable in a resume
// list. Persist the session ids cc forks (across both backends) so /resume can
// mark them. Capped so the file can't grow without bound.
function forksPath() {
	if (process.env.CC_FORKS) return process.env.CC_FORKS;
	return path.join(path.dirname(settingsPath()), "forks.json");
}

export function loadForkIds() {
	try {
		const data = JSON.parse(fs.readFileSync(forksPath(), "utf8"));
		return new Set(Array.isArray(data?.forks) ? data.forks.filter((id) => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

export function recordForkId(sessionId) {
	if (!sessionId) return;
	const ids = loadForkIds();
	if (ids.has(sessionId)) return;
	ids.add(sessionId);
	const forks = [...ids].slice(-500);
	try {
		const file = forksPath();
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${JSON.stringify({ forks })}\n`);
	} catch {
		// Best-effort: fork labeling in /resume is a nicety, not critical.
	}
}

function resolveHarnessPython() {
	if (process.env.CC_HARNESS_PYTHON) return process.env.CC_HARNESS_PYTHON;
	for (const candidate of [
		path.join(SOURCE_DIR, "..", ".venv", "bin", "python"),
		path.join(process.cwd(), ".venv", "bin", "python"),
		"python3",
		"python3.12",
		"python3.11",
		"python3.10",
	]) {
		if (isHarnessPython(candidate)) return candidate;
	}
	return "python3";
}

function isHarnessPython(command) {
	if (command.includes(path.sep) && !fs.existsSync(command)) return false;
	const result = spawnSync(command, ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"], {
		stdio: "ignore",
	});
	return result.status === 0;
}

export function applyHarnessSettings(config, settings = {}) {
	settings = normalizeSettings(settings, config.theme ?? config.settings?.theme);
	const normalized = normalizeHarnessSettings(settings);
	const agents = {};
	for (const [key, agent] of Object.entries(config.agents ?? {})) {
		agents[key] = applyAgentSettings(key, agent, normalized[key] ?? {});
	}
	// A harness persisted from a prior session (via /harness) becomes the default
	// when no harness is named on the command line. Ignore stale keys.
	const defaultAgent = typeof settings.defaultAgent === "string" && agents[settings.defaultAgent] ? settings.defaultAgent : config.defaultAgent;
	return { ...config, defaultAgent, settings, theme: settings.theme, agents };
}

export function saveSettingsPatch(patch) {
	const file = settingsPath();
	const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
	const next = normalizeSettings(deepMerge(current, patch));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

function normalizeSettings(settings = {}, fallbackTheme = DEFAULT_SETTINGS.theme) {
	const normalized = isPlainObject(settings) ? { ...settings } : {};
	normalized.agents = isPlainObject(normalized.agents) ? normalized.agents : {};
	normalized.theme =
		resolveThemeName(Object.prototype.hasOwnProperty.call(normalized, "theme") ? normalized.theme : fallbackTheme) ?? DEFAULT_SETTINGS.theme;
	if (typeof normalized.defaultAgent !== "string" || !normalized.defaultAgent) delete normalized.defaultAgent;
	return normalized;
}

function normalizeHarnessSettings(settings) {
	return isPlainObject(settings?.agents) ? settings.agents : {};
}

function applyAgentSettings(key, agent, settings) {
	const applied = clonePlain(agent);
	if (!isPlainObject(settings)) return applied;
	applied.env = { ...(applied.env ?? {}), ...(settings.env ?? {}) };
	if (applied.acp) applied.acp = clonePlain(applied.acp);

	const command = applied.acp ?? applied;
	const nativeArgs = stringArray(settings.args ?? settings.nativeArgs);
	if (nativeArgs.length > 0) command.args = applyNativeArgs(key, command.args ?? [], nativeArgs);

	const acpArgs = stringArray(settings.acpArgs);
	if (acpArgs.length > 0) command.args = [...(command.args ?? []), ...acpArgs];

	if (isPlainObject(settings.config)) command.args = applyConfigSettings(key, command.args ?? [], settings.config);
	if (isPlainObject(settings.settings)) applyNativeSettings(key, applied, settings.settings);
	applyNativePermissionSetting(key, applied, settings);
	return applied;
}

function applyNativeArgs(key, baseArgs, nativeArgs) {
	if (key === "cursor") return insertArgsBefore(baseArgs, "acp", nativeArgs);
	return [...baseArgs, ...nativeArgs];
}

function applyConfigSettings(key, baseArgs, config) {
	if (key !== "codex") return baseArgs;
	const args = [...baseArgs];
	for (const [name, value] of Object.entries(config)) {
		args.push("-c", `${name}=${tomlValue(value)}`);
	}
	return args;
}

function applyNativeSettings(key, agent, settings) {
	if (key !== "claude") return;
	const options = agent._sessionMeta?.claudeCode?.options ?? {};
	const currentSettings = isPlainObject(options.settings) ? options.settings : {};
	agent._sessionMeta = deepMerge(agent._sessionMeta ?? {}, {
		claudeCode: {
			options: {
				settings: deepMerge(currentSettings, settings),
			},
		},
	});
}

function applyNativePermissionSetting(key, agent, settings) {
	if (key === "claude") {
		const mode = settings.settings?.permissions?.defaultMode;
		if (isBypassPermissionMode(mode)) {
			agent._startupMode = "bypassPermissions";
			agent._autoPermissionRequests = true;
		}
		return;
	}
	if (key === "codex") {
		const config = settings.config;
		if (config?.approval_policy === "never" && config?.sandbox_mode === "danger-full-access") {
			agent._autoPermissionRequests = true;
		}
		return;
	}
	if (key === "cursor") {
		const args = (agent.acp ?? agent).args ?? [];
		if (args.includes("--force") || args.includes("-f") || args.includes("--yolo")) {
			agent._autoPermissionRequests = true;
		}
	}
}

function isBypassPermissionMode(mode) {
	return typeof mode === "string" && ["bypasspermissions", "bypass"].includes(mode.trim().toLowerCase());
}

function insertArgsBefore(baseArgs, marker, inserted) {
	const index = baseArgs.indexOf(marker);
	if (index === -1) return [...baseArgs, ...inserted];
	return [...baseArgs.slice(0, index), ...inserted, ...baseArgs.slice(index)];
}

function tomlValue(value) {
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

function tomlKey(key) {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function stringArray(value) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return [];
	return value.filter((entry) => typeof entry === "string");
}

function isPlainObject(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clonePlain(value) {
	return JSON.parse(JSON.stringify(value));
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
  /harness terminus-2
  /harness mini-swe-agent
  /theme
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
