#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as zlib from "node:zlib";
import { Editor } from "@mariozechner/pi-tui/dist/components/editor.js";
import { Spacer } from "@mariozechner/pi-tui/dist/components/spacer.js";
import { Text } from "@mariozechner/pi-tui/dist/components/text.js";
import { isKeyRelease, matchesKey } from "@mariozechner/pi-tui/dist/keys.js";
import { ProcessTerminal } from "@mariozechner/pi-tui/dist/terminal.js";
import { Container, TUI } from "@mariozechner/pi-tui/dist/tui.js";
import { extractAnsiCode, normalizeTerminalOutput, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui/dist/utils.js";
import {
	cancelledOutcome,
	classifyOption,
	coercePermissionMode,
	decidePermission,
	forgetGrants,
	inferModeFromNative,
	isAlwaysOption,
	loadGrants,
	nativePermissionConfig,
	nonPersistentSameDirection,
	normalizePermissionSettings,
	outcomeForDecision,
	permissionRequestInfo,
	pickAllowOption,
	policyNeedsGating,
	recordGrant,
	resolvePermissionPolicy,
	selectedOutcome,
	stripFlags,
} from "./harness/permissions.mjs";
import {
	CODEX_FEEDBACK_CATEGORIES,
	codexFeedbackUploadParams,
	launchCodexDesktopThread,
	parseCodexFeedbackArgument,
	sanitizeCodexFeedbackOperationError,
} from "./harness/codex-native-ui.mjs";
import { formatCodexDebugConfig } from "./harness/codex-config-report.mjs";
import {
	codexImportCompletionMatches,
	codexImportItemCount,
	codexImportItemLabel,
	formatCodexImportCompletion,
	normalizeCodexImportDetection,
} from "./harness/codex-import.mjs";
import {
	codexMemoryConfigBatchParams,
	codexMemorySettingsFromConfigRead,
	codexThreadMemoryModeParams,
	codexMemoryWriteStatus,
	parseCodexMemoryCommand,
} from "./harness/codex-memory.mjs";
import { codexPersistentForkParams, codexPersistentForkSession } from "./harness/codex-thread.mjs";
import {
	ELICITATION_LIMITS,
	normalizeElicitationFormRequest,
	normalizeElicitationResponse,
	validateElicitationFieldValue,
} from "./harness/elicitation.mjs";

const HARNESS = "/harness";
// Commands the shared UI owns when localSlashCommands exposes them, even if a
// backend advertises the same name.
const RESERVED_LOCAL_COMMANDS = new Set([
	"harness",
	"help",
	"cc-status",
	"clear",
	"voice",
	"theme",
	"btw",
	"side",
	"fork",
	"diff",
	"copy",
	"config",
	"fast",
	"delete",
	"archive",
	"unarchive",
	"login",
	"logout",
	"plugins",
	"hooks",
	"app",
	"apps",
	"feedback",
	"import",
	"memories",
	"debug-config",
	"doctor",
	"experimental",
	"init",
	"rename",
	"usage",
	"cloud",
	"exit",
	"quit",
	"yolo",
	"auto",
	"permissions",
]);
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = path.join(SOURCE_DIR, "harnesses");
const HARNESS_PYTHON = resolveHarnessPython();
const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const PLAN_FALLBACK_INSTRUCTION =
	"Work in planning mode. Do not modify files or run state-changing commands. Analyze the request and produce a concrete, actionable plan.";
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
const CODEX_COMMAND_TIMEOUT_MS = 30_000;
const CODEX_THREAD_SOURCE_KINDS = [
	"cli",
	"vscode",
	"exec",
	"appServer",
	"subAgent",
	"subAgentReview",
	"subAgentCompact",
	"subAgentThreadSpawn",
	"subAgentOther",
	"unknown",
];
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_FORCE_KILL_WAIT_MS = 5_000;
const PROCESS_TREE_POLL_INTERVAL_MS = 10;
const WINDOWS_PROCESS_TREE_SETTLE_MS = 25;
const CODEX_PLUGIN_COMMAND_TIMEOUT_MS = 5 * 60_000;
const CODEX_MCP_AUTH_TIMEOUT_MS = 5 * 60_000;
const CODEX_MCP_OUTPUT_MAX_BYTES = 256 * 1024;
const CODEX_MCP_STDERR_MAX_BYTES = 64 * 1024;
const CODEX_MCP_REPORT_MAX_LINES = 500;
const CODEX_HOOKS_REPORT_MAX_LINES = 500;
const CODEX_APPS_MAX_ENTRIES = 500;
const CODEX_APPS_LIST_TIMEOUT_MS = 120_000;
const CODEX_CLOUD_OUTPUT_MAX_BYTES = 512 * 1024;
const CODEX_CLOUD_STDERR_MAX_BYTES = 64 * 1024;
const EMBEDDED_FILE_MAX_BYTES = 512 * 1024;
const EMBEDDED_FILE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const EMBEDDED_FILE_MAX_MENTIONS = 32;
const DIFF_DISPLAY_MAX_LINES = 500;
const DIFF_OUTPUT_MAX_BYTES = 512 * 1024;
const DIFF_UNTRACKED_MANIFEST_MAX_BYTES = 128 * 1024;
const DIFF_UNTRACKED_MAX_PATHS = 128;
// Keep the temporary-index `git add` invocation below Windows' much smaller
// command-line ceiling as well as POSIX ARG_MAX.
const DIFF_UNTRACKED_MAX_ARGUMENT_BYTES = 12 * 1024;
const DIFF_STDERR_MAX_BYTES = 64 * 1024;
const MAX_ACP_SESSION_LIST_PAGES = 200;
const MAX_ACP_SESSION_LIST_ENTRIES = 1_000;
const FORK_REGISTRY_VERSION = 2;
const FORK_REGISTRY_LABEL_LIMIT = 500;
const FORK_REGISTRY_LOCK_TIMEOUT_MS = 2_000;
const FORK_REGISTRY_STALE_LOCK_MS = 30_000;
const FORK_REGISTRY_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const FORK_OPERATION_LOCK_TIMEOUT_MS = 2_000;
const FORK_OPERATION_LOCK_ORPHAN_GRACE_MS = 30_000;
const FORK_LEGACY_PREFIX_MAX_BYTES = 16 * 1024 * 1024;
const CLIPBOARD_IMAGE_LABEL = Symbol("cc.clipboardImageLabel");
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
			_requiredAgentName: "@agentclientprotocol/codex-acp",
			_minimumAgentVersion: "1.1.2",
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

	insertCharacter(char, skipUndoCoalescing) {
		super.insertCharacter(char, skipUndoCoalescing);
		if (this.autocompleteState) return;
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const beforeCursor = line.slice(0, this.state.cursorCol);
		// Pi's base editor knows how to keep slash and @ completions alive, but not
		// native $skill tokens. Re-evaluate the whole token after every valid
		// character so a pending request invalidated by later input is restarted.
		if (/(?:^|[\s])\$[A-Za-z0-9._-]*$/.test(beforeCursor)) this.tryTriggerAutocomplete?.();
	}

	handlePaste(pastedText) {
		super.handlePaste(pastedText);
		// Base paste handling intentionally cancels autocomplete. A pasted partial
		// slash command or $skill should still open suggestions without requiring
		// the user to erase and retype it.
		this.refreshAutocompleteForCurrentInput();
	}

	handleBackspace() {
		super.handleBackspace();
		// Pi re-opens slash/@/# completion after deleting a no-match suffix, but it
		// does not know about Codex's native $skill tokens. Without this, `$bad`
		// followed by backspace can leave a now-valid skill prefix permanently dark.
		if (this.autocompleteState) return;
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const beforeCursor = line.slice(0, this.state.cursorCol);
		if (/(?:^|[\s])\$[A-Za-z0-9._-]*$/.test(beforeCursor)) this.tryTriggerAutocomplete?.();
	}

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

	refreshAutocompleteForCurrentInput() {
		const line = this.state.lines[this.state.cursorLine] ?? "";
		const beforeCursor = line.slice(0, this.state.cursorCol);
		const slashCommand = this.state.cursorLine === 0 && /^\/[A-Za-z0-9._-]*$/.test(beforeCursor);
		const skillToken = /(?:^|\s)\$[A-Za-z0-9._-]*$/.test(beforeCursor);
		if (!slashCommand && !skillToken) return;
		if (this.autocompleteState) this.updateAutocomplete();
		else this.tryTriggerAutocomplete();
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

export function singleLineMenuText(value) {
	const source = String(value ?? "");
	let plain = "";
	for (let index = 0; index < source.length; ) {
		const ansi = source.charCodeAt(index) === 0x1b ? extractAnsiCode(source, index) : null;
		if (ansi) {
			index += ansi.length;
			continue;
		}
		plain += source[index];
		index += 1;
	}
	return plain
		.replace(/[\r\n\t\f\v]+/g, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
		.replace(/\s+/gu, " ")
		.trim();
}

export class SelectionPanel {
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
		const lines = [chalk.bold(singleLineMenuText(this.title)), ""];

		for (let offset = 0; offset < rowCount; offset += 1) {
			const entry = visible[offset];
			if (!entry) {
				lines.push(offset === 0 && entries.length === 0 ? chalk.dim(this.query ? "No matches" : this.emptyText) : "");
				continue;
			}
			const index = start + offset;
			const cursor = index === this.selected ? "›" : " ";
			const marker = entry.active ? "●" : " ";
			const entryLabel = singleLineMenuText(entry.label);
			const entryDescription = singleLineMenuText(entry.description);
			const description = entryDescription ? chalk.dim(`  ${entryDescription}`) : "";
			const label = `${cursor} ${marker} ${entryLabel}${description}`;
			lines.push(index === this.selected ? chalk.blue(label) : chalk.text(label));
		}

		const position = entries.length > 0 ? `${this.selected + 1}/${entries.length}` : "0/0";
		lines.push("", chalk.dim(position), chalk.dim("type to filter · enter select · esc cancel"));
		// Keep the final terminal cell empty. A very long session title rendered into
		// that cell can trigger an implicit terminal wrap, leaving the tail of one
		// picker row underneath the next row on incremental repaints.
		const safeWidth = Math.max(1, width - 1);
		return lines.map((line) => truncateVisual(line, safeWidth));
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
			return;
		}
		const pasted = selectionFilterPasteText(data);
		if (pasted) {
			this.query += pasted;
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
			[entry.label, entry.description, entry.value].filter(Boolean).some((value) => singleLineMenuText(value).toLowerCase().includes(query)),
		);
	}
}

function elicitationInputChunk(data) {
	if (typeof data !== "string" || !data) return "";
	const bracketed = /^\x1b\[200~([\s\S]*)\x1b\[201~$/u.exec(data);
	let source = bracketed ? bracketed[1] : data;
	// Unknown escape-bearing chunks are key sequences, not user text. Bracketed
	// paste is text, but may itself contain terminal escape sequences, so strip
	// those before accepting any characters.
	if (!bracketed && source.includes("\x1b")) return "";
	source = source
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\r\n\t\f\v]+/gu, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
	return source;
}

function elicitationVisibleInput(value) {
	return String(value ?? "")
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/gu, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "");
}

function elicitationFieldHint(field) {
	const hints = [];
	if (field.required) hints.push("required");
	else hints.push("optional");
	if (field.type === "string") {
		if (field.minLength !== undefined) hints.push(`min ${field.minLength} chars`);
		if (field.maxLength !== undefined) hints.push(`max ${field.maxLength} chars`);
		if (field.format) hints.push(field.format);
		if (field.pattern) hints.push("pattern constrained");
	} else if (field.type === "number" || field.type === "integer") {
		if (field.minimum !== undefined) hints.push(`min ${field.minimum}`);
		if (field.maximum !== undefined) hints.push(`max ${field.maximum}`);
	} else if (field.type === "array") {
		if (field.minItems !== undefined) hints.push(`min ${field.minItems} selections`);
		if (field.maxItems !== undefined) hints.push(`max ${field.maxItems} selections`);
	}
	return hints.join(" · ");
}

export class ElicitationFormPanel {
	constructor(form, onFinish) {
		this.form = form;
		this.onFinish = onFinish;
		this.fieldIndex = 0;
		this.values = Object.create(null);
		this.stage = "field";
		this.selected = 0;
		this.input = "";
		this.multiSelected = new Set();
		this.error = "";
		this.settled = false;
		this.prepareField();
	}

	invalidate() {}

	activeField() {
		return this.form.fields[this.fieldIndex];
	}

	prepareField() {
		const field = this.activeField();
		this.error = "";
		this.selected = 0;
		this.input = "";
		this.multiSelected = new Set();
		if (!field) {
			this.stage = "review";
			return;
		}
		if (field.type === "string" && !field.options) {
			this.input = field.default ?? "";
			return;
		}
		if (field.type === "number" || field.type === "integer") {
			this.input = field.default === undefined ? "" : String(field.default);
			return;
		}
		if (field.type === "array") {
			this.multiSelected = new Set(field.default ?? []);
			if (!field.required && field.default === undefined) this.selected = field.options.length;
			return;
		}
		const choices = this.currentChoices();
		if (field.default !== undefined) {
			const defaultIndex = choices.findIndex((entry) => entry.value === field.default);
			if (defaultIndex >= 0) this.selected = defaultIndex;
		} else if (!field.required) {
			const skipIndex = choices.findIndex((entry) => entry.omit);
			if (skipIndex >= 0) this.selected = skipIndex;
		} else if (field.type === "boolean") {
			this.selected = choices.findIndex((entry) => entry.value === false);
		}
	}

	currentChoices() {
		const field = this.activeField();
		if (!field) return [];
		let choices;
		if (field.type === "boolean") {
			choices = [
				{ value: true, label: "True" },
				{ value: false, label: "False" },
			];
		} else {
			choices = field.options ?? [];
		}
		return field.required ? choices : [...choices, { omit: true, label: "Skip this optional field" }];
	}

	currentArrayChoices() {
		const field = this.activeField();
		if (!field || field.type !== "array") return [];
		return field.required
			? field.options
			: [...field.options, { omit: true, label: "Skip this optional field" }];
	}

	render(width) {
		const safeWidth = Math.max(1, width - 1);
		const lines = [chalk.bold(this.form.title)];
		if (this.form.message && this.form.message !== this.form.title) lines.push(chalk.text(this.form.message));
		if (this.form.description) lines.push(chalk.dim(this.form.description));
		lines.push("");
		if (this.stage === "review") {
			lines.push(chalk.bold("Review and submit"), chalk.dim("Values are not printed in the transcript."), "");
			const maxFields = 10;
			for (const field of this.form.fields.slice(0, maxFields)) {
				const provided = Object.prototype.hasOwnProperty.call(this.values, field.key);
				lines.push(`${provided ? "✓" : "○"} ${field.title}  ${chalk.dim(provided ? "provided" : "not provided")}`);
			}
			if (this.form.fields.length > maxFields) lines.push(chalk.dim(`…and ${this.form.fields.length - maxFields} more fields`));
			lines.push("");
			const reviewChoices = ["Submit", "Decline"];
			for (let index = 0; index < reviewChoices.length; index += 1) {
				const label = `${index === this.selected ? "›" : " "} ${reviewChoices[index]}`;
				lines.push(index === this.selected ? chalk.blue(label) : label);
			}
			lines.push("", chalk.dim("↑/↓ choose · enter confirm · esc cancel"));
			return lines.map((line) => truncateVisual(line, safeWidth));
		}

		const field = this.activeField();
		lines.push(chalk.dim(`${this.fieldIndex + 1}/${this.form.fields.length}`));
		lines.push(chalk.bold(field.title));
		if (field.description) lines.push(chalk.dim(field.description));
		lines.push(chalk.dim(elicitationFieldHint(field)), "");
		if ((field.type === "string" && !field.options) || field.type === "number" || field.type === "integer") {
			const visible = field.secret ? "•".repeat(Math.min(Array.from(this.input).length, 80)) : elicitationVisibleInput(this.input);
			lines.push(`› ${visible}`);
			lines.push("", chalk.dim("enter continue · esc cancel"));
		} else if (field.type === "array") {
			const choices = this.currentArrayChoices();
			const start = Math.max(0, Math.min(this.selected - 5, choices.length - 12));
			for (const [offset, option] of choices.slice(start, start + 12).entries()) {
				const index = start + offset;
				const cursor = index === this.selected ? "›" : " ";
				const mark = option.omit ? "   " : this.multiSelected.has(option.value) ? "[x]" : "[ ]";
				const description = option.description ? chalk.dim(`  ${option.description}`) : "";
				const line = `${cursor} ${mark} ${option.label}${description}`;
				lines.push(index === this.selected ? chalk.blue(line) : line);
			}
			lines.push("", chalk.dim("↑/↓ move · space toggle · enter continue/skip · esc cancel"));
		} else {
			const choices = this.currentChoices();
			const start = Math.max(0, Math.min(this.selected - 5, choices.length - 12));
			for (const [offset, option] of choices.slice(start, start + 12).entries()) {
				const index = start + offset;
				const cursor = index === this.selected ? "›" : " ";
				const description = option.description ? chalk.dim(`  ${option.description}`) : "";
				const line = `${cursor} ${option.label}${description}`;
				lines.push(index === this.selected ? chalk.blue(line) : line);
			}
			lines.push("", chalk.dim("↑/↓ choose · enter continue · esc cancel"));
		}
		if (this.error) lines.push(chalk.red(this.error));
		return lines.map((line) => truncateVisual(line, safeWidth));
	}

	handleInput(data) {
		if (this.settled) return;
		if (matchesKey(data, "escape") || data === "\x03") {
			this.cancel();
			return;
		}
		if (this.stage === "review") {
			if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
			else if (matchesKey(data, "down")) this.selected = Math.min(1, this.selected + 1);
			else if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
				if (this.selected === 1) this.finish({ action: "decline" });
				else this.submit();
			}
			return;
		}
		const field = this.activeField();
		if ((field.type === "string" && !field.options) || field.type === "number" || field.type === "integer") {
			this.handleTextInput(data, field);
			return;
		}
		const choices = field.type === "array" ? this.currentArrayChoices() : this.currentChoices();
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			return;
		}
		if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, choices.length - 1), this.selected + 1);
			return;
		}
		if (field.type === "array" && (matchesKey(data, "space") || data === " ")) {
			const option = choices[this.selected];
			if (!option) return;
			if (option.omit) {
				this.multiSelected.clear();
				this.error = "";
				return;
			}
			if (this.multiSelected.has(option.value)) this.multiSelected.delete(option.value);
			else this.multiSelected.add(option.value);
			this.error = "";
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			if (field.type === "array") {
				const choice = choices[this.selected];
				this.recordAndAdvance(choice?.omit ? undefined : [...this.multiSelected]);
			}
			else {
				const choice = choices[this.selected];
				if (choice) this.recordAndAdvance(choice.omit ? undefined : choice.value);
			}
		}
	}

	handleTextInput(data, field) {
		if (matchesKey(data, "backspace") || data === "\x7f" || data === "\b") {
			this.input = Array.from(this.input).slice(0, -1).join("");
			this.error = "";
			return;
		}
		if (data === "\x15") {
			this.input = "";
			this.error = "";
			return;
		}
		if (matchesKey(data, "enter") || data === "\r" || data === "\n") {
			this.recordAndAdvance(this.input);
			return;
		}
		const chunk = elicitationInputChunk(data);
		if (!chunk) return;
		const maximum = Math.min(field.maxLength ?? ELICITATION_LIMITS.inputCharacters, ELICITATION_LIMITS.inputCharacters);
		this.input = Array.from(`${this.input}${chunk}`).slice(0, maximum).join("");
		this.error = "";
	}

	recordAndAdvance(rawValue) {
		const field = this.activeField();
		const checked = validateElicitationFieldValue(field, rawValue);
		if (!checked.ok) {
			this.error = singleLineMenuText(checked.error);
			return;
		}
		if (checked.omit) delete this.values[field.key];
		else this.values[field.key] = checked.value;
		this.fieldIndex += 1;
		this.prepareField();
	}

	submit() {
		const content = Object.create(null);
		for (const field of this.form.fields) {
			const checked = validateElicitationFieldValue(field, this.values[field.key]);
			if (!checked.ok) {
				this.error = singleLineMenuText(checked.error);
				this.stage = "field";
				this.fieldIndex = this.form.fields.indexOf(field);
				this.prepareField();
				this.error = singleLineMenuText(checked.error);
				return;
			}
			if (!checked.omit) content[field.key] = checked.value;
		}
		this.finish({ action: "accept", content });
	}

	clearInput() {
		const field = this.activeField();
		if (this.stage !== "field" || !field || !this.input) return false;
		if (!((field.type === "string" && !field.options) || field.type === "number" || field.type === "integer")) return false;
		this.input = "";
		this.error = "";
		return true;
	}

	cancel() {
		this.finish({ action: "cancel" });
	}

	finish(result) {
		if (this.settled) return;
		this.settled = true;
		this.input = "";
		this.multiSelected.clear();
		this.values = Object.create(null);
		this.onFinish(result);
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
export class BtwThread {
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
		this.localCommandQueue = [];
		this.localCommandDrainActive = false;
		this.queuedInputOrder = 0;
		this.availableCommands = [];
		this.commandsLoaded = false;
		this.ready = false;
		this.readyWaiters = [];
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
		// Command availability belongs to the forked session, not necessarily the
		// main session it was copied from. Capture it even during fork setup, when
		// transcript updates are deliberately suppressed below.
		if (event.type === "commands") {
			this.availableCommands = Array.isArray(event.commands) ? event.commands : [];
			this.commandsLoaded = true;
			if (this.app.btwThread === this && this.app.focusedThread === "btw") {
				this.app.updateAutocomplete();
			}
			this.app.onThreadActivity();
			return;
		}
		if (event.type === "session_info") {
			this.app.syncRuntimePermissionModeForSideClient?.(this.client, event.sessionInfo, { onlyIfChanged: true });
			return;
		}
		if (event.type === "backend_exit") {
			this.busy = false;
			this.statusState = "";
			this.state = "error";
			this.settleReadyWaiters(false);
			this.cancelDeferredLocalCommands();
			this.closeCurrentAssistantText();
			this.app.onThreadActivity();
			return;
		}
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
		}
		this.app.onThreadActivity();
	}

	waitUntilReady() {
		if (this.ready) return Promise.resolve(true);
		if (!this.client || this.client.exited || this.state === "error") return Promise.resolve(false);
		return new Promise((resolve) => this.readyWaiters.push(resolve));
	}

	settleReadyWaiters(ready) {
		const waiters = this.readyWaiters.splice(0);
		for (const resolve of waiters) resolve(ready);
	}

	async submit(text, promptParts, options = {}) {
		const trimmed = text.trim();
		if (!trimmed) return;
		if (!this.client || this.client.exited) {
			this.addError("Side thread backend has exited — press esc to close.");
			this.app.onThreadActivity();
			return;
		}
		// Queue until the fork session is established (ready), or while busy.
		if (
			!this.ready ||
			this.busy ||
			this.configUpdateTail ||
			this.localCommandDrainActive ||
			this.localCommandQueue.length > 0
		) {
			this.queue.push({
				text: trimmed,
				promptParts,
				queuedInputOrder: options.queuedInputOrder ?? this.nextQueuedInputOrder(),
			});
			this.queue.sort((left, right) => left.queuedInputOrder - right.queuedInputOrder);
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
		this.settleReadyWaiters(true);
		this.drainQueue();
	}

	deferLocalCommand(name, argument = "", options = {}) {
		return new Promise((resolve) => {
			this.localCommandQueue.push({
				name,
				argument,
				...(Array.isArray(options.promptParts) ? { promptParts: options.promptParts } : {}),
				queuedInputOrder: this.nextQueuedInputOrder(),
				resolve,
			});
			this.app.onThreadActivity();
			this.drainQueue();
		});
	}

	nextQueuedInputOrder() {
		if (typeof this.app.nextQueuedInputOrder === "function") return this.app.nextQueuedInputOrder();
		this.queuedInputOrder += 1;
		return this.queuedInputOrder;
	}

	cancelDeferredLocalCommands() {
		for (const command of this.localCommandQueue.splice(0)) command.resolve(false);
	}

	drainQueue() {
		if (
			!this.ready ||
			this.busy ||
			this.configUpdateTail ||
			this.localCommandDrainActive ||
			(this.app.asyncPickerLoadCount ?? 0) > 0 ||
			(this.app.configUpdateCount ?? 0) > 0 ||
			this.app.menuHandle ||
			this.app.selectionActionInProgress
		) return;
		const command = this.localCommandQueue[0];
		const prompt = this.queue[0];
		if (!command && !prompt) return;
		if (command && (!prompt || command.queuedInputOrder <= prompt.queuedInputOrder)) {
			this.localCommandQueue.shift();
			if (this.app.btwThread !== this || this.client?.exited) {
				command.resolve(false);
				this.drainQueue();
				return;
			}
			this.localCommandDrainActive = true;
			void this.app.runLocalSlashCommand(command.name, command.argument, {
				fromSideCommandQueue: true,
				promptParts: command.promptParts,
				queuedInputOrder: command.queuedInputOrder,
				targetThread: this,
			}).then(
				() => command.resolve(true),
				(error) => {
					if (this.app.btwThread === this) this.addError(error.message ?? String(error));
					command.resolve(false);
				},
			).finally(() => {
				this.localCommandDrainActive = false;
				if (this.app.btwThread === this && !this.client?.exited) this.drainQueue();
			});
			return;
		}
		this.queue.shift();
		this.addUserMessage(prompt.text);
		void this.sendPrompt(prompt.text, prompt.promptParts);
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
		let backendText = text;
		let backendParts = promptParts;
		if (
			!text.startsWith("/") &&
			this.planPromptFallback?.client === this.client &&
			this.planPromptFallback?.sessionId === this.client.sessionId
		) {
			backendText = `${PLAN_FALLBACK_INSTRUCTION}\n\n${text}`;
			backendParts = [
				{ type: "text", text: PLAN_FALLBACK_INSTRUCTION },
				...(Array.isArray(promptParts) ? promptParts : [{ type: "text", text }]),
			];
		}
		const payload = this.app.promptForActiveCapabilities(backendText, backendParts, {
			capabilities: this.client.capabilities,
			onNotice: (message) => this.addNotice(message),
		});
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
			// Messages submitted while this turn was running are committed FIFO
			// entries. A cancellation settles only the active turn, so continue with
			// those entries just as a normal turn completion does. Never revive work
			// from a side thread that was closed or replaced while the prompt settled.
			if (this.app.btwThread === this && this.client && !this.client.exited) this.drainQueue();
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
		this.settleReadyWaiters(false);
		this.cancelDeferredLocalCommands();
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

	addCommandMessage(text) {
		this.closeCurrentAssistantText();
		this.currentUserText = undefined;
		this.currentToolSummary = undefined;
		this.addHistorySpacer("command");
		this.chat.addChild(new CommandMessage(text));
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
// transcript + the pinned menu/queue/editor/status). The app enters the alternate
// screen for this page view so the fixed-height frame cannot mix with the natural
// scrolling transcript behind it.
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

		const terminalEnv = {};
		for (const entry of params.env ?? []) {
			if (entry?.name) terminalEnv[entry.name] = entry.value ?? "";
		}
		const env = mergeEnvironments([process.env, terminalEnv]);
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
		this.onElicitationRequest = options.onElicitationRequest;
		this.elicitationCapabilities = options.elicitationCapabilities;
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
		this.childClosed = true;
		this.childExitObserved = true;
		this.processGroupConfirmedGone = true;
		this.exitedProcessGroupForceSignalled = false;
		this.stopWaiterCount = 0;
		this.stopAndWaitPromise = undefined;
		this.stopping = false;
		this.stderrTail = "";
		this.stdoutBuffer = "";
	}

	start() {
		const command = this.agent.acp ?? this.agent;
		const env = mergedAgentEnvironment(this.agent);
		const cwd = process.cwd();
		// npm exposes global bins as .cmd shims on Windows, which Node cannot spawn
		// with shell:false. Resolve only package-local JS entrypoints and execute
		// them with Node; never enable a command shell for ACP launch data. For a
		// bare package command, prefer a later compatible maintained adapter over an
		// older package that happens to shadow it earlier on PATH.
		const { executable, prefixArgs } = resolveAgentAcpExecutable(this.agent, cwd, env);
		this.childClosed = false;
		this.childExitObserved = false;
		this.processGroupConfirmedGone = false;
		this.exitedProcessGroupForceSignalled = false;
		this.stopWaiterCount = 0;
		this.stopAndWaitPromise = undefined;
		this.child = spawn(executable, [...prefixArgs, ...(command.args ?? [])], {
			cwd,
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
			this.childExitObserved = true;
			if (process.platform !== "win32") {
				const pid = Number(this.child?.pid);
				if (!Number.isInteger(pid) || pid <= 0 || !posixProcessGroupExists(pid)) {
					// Once absence has been observed, never signal this numeric PGID again:
					// the kernel may recycle it for an unrelated process group.
					this.processGroupConfirmedGone = true;
				} else if ((this.stopWaiterCount ?? 0) === 0) {
					// The root has exited while its original detached group is still present.
					// With no stopAndWait owner, sweep it immediately while that observation
					// still proves ownership; a delayed retry after disappearance would risk a
					// recycled PGID. An active waiter instead retains the ownership lease and
					// gives descendants their configured graceful-exit window.
					const cleanup = terminateChild(this.child, "SIGKILL", { includeExitedGroup: true });
					this.exitedProcessGroupForceSignalled ||= cleanup.treeSignalled;
				}
			}
		});
		this.child.once("close", (code, signal) => {
			this.childClosed = true;
			this.exited = true;
			if (process.platform !== "win32") {
				const pid = Number(this.child?.pid);
				if (!Number.isInteger(pid) || pid <= 0 || !posixProcessGroupExists(pid)) {
					this.processGroupConfirmedGone = true;
				}
			}
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
		// ACP is newline-delimited JSON. Node readline also splits on U+2028, which
		// can appear inside raw tool output strings and corrupt an otherwise valid frame.
		const stdoutDecoder = new StringDecoder("utf8");
		this.child.stdout.on("data", (chunk) => this.handleStdoutText(stdoutDecoder.write(chunk)));
		this.child.stdout.on("end", () => {
			const tail = stdoutDecoder.end();
			if (tail) this.handleStdoutText(tail);
			this.flushStdoutLine();
		});
	}

	handleStdoutText(text) {
		if (!text) return;
		this.stdoutBuffer += text;
		while (true) {
			const newlineIndex = this.stdoutBuffer.indexOf("\n");
			if (newlineIndex < 0) return;
			this.handleLine(this.normalizeStdoutLine(this.stdoutBuffer.slice(0, newlineIndex)));
			this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
		}
	}

	flushStdoutLine() {
		if (!this.stdoutBuffer) return;
		this.handleLine(this.normalizeStdoutLine(this.stdoutBuffer));
		this.stdoutBuffer = "";
	}

	normalizeStdoutLine(line) {
		return line.endsWith("\r") ? line.slice(0, -1) : line;
	}

	async initialize(options = {}) {
		this.start();
		const elicitationModes = {};
		if (typeof this.onElicitationRequest === "function") {
			// URL remains the compatibility default for embedders that supplied the
			// original callback before mode-specific negotiation existed. Form is
			// opt-in: advertising it means the handler can actually render and settle
			// the structured request.
			if (this.elicitationCapabilities?.url !== false) elicitationModes.url = {};
			if (this.elicitationCapabilities?.form === true) elicitationModes.form = {};
		}
		const elicitationCapabilities = Object.keys(elicitationModes).length > 0
			? { elicitation: elicitationModes }
			: {};
		const initialized = await this.request("initialize", {
			protocolVersion: 1,
			clientCapabilities: {
				auth: { terminal: true },
				fs: { readTextFile: false, writeTextFile: false },
				terminal: true,
				session: { configOptions: { boolean: {} } },
				// A client must not negotiate an elicitation mode unless it can surface
				// and settle the resulting elicitation/create request.
				...elicitationCapabilities,
			},
			clientInfo: { name: "cc", title: "cc", version: "0.1.0" },
		});
		this.capabilities = initialized?.agentCapabilities ?? {};
		this.agentInfo = initialized?.agentInfo ?? {};
		this.authMethods = initialized?.authMethods ?? [];
		const requiredAgentName = this.agent._requiredAgentName;
		if (requiredAgentName && this.agentInfo.name !== requiredAgentName) {
			this.stop();
			const actual = this.agentInfo.name || "unknown";
			throw new Error(
				`Unsupported Codex ACP adapter (${actual}). Install the maintained adapter with: npm install -g @agentclientprotocol/codex-acp`,
			);
		}
		const minimumAgentVersion = this.agent._minimumAgentVersion;
		if (minimumAgentVersion && !versionAtLeast(this.agentInfo.version, minimumAgentVersion)) {
			this.stop();
			const actual = this.agentInfo.version || "unknown";
			throw new Error(
				`Codex ACP adapter ${actual} is too old; version ${minimumAgentVersion} or newer is required. Update it with: npm install -g @agentclientprotocol/codex-acp@latest`,
			);
		}
		// createSession:false lets a caller (e.g. /btw) decide between newSession,
		// forkSession, or loadSession after seeing the advertised capabilities.
		if (options.createSession !== false) await this.newSession();
		return initialized;
	}

	async newSession(options = {}) {
		return await this.switchSession("session/new", this.sessionRequestParams(), undefined, options);
	}

	async authenticate(methodId, meta = undefined) {
		return await this.request("authenticate", {
			methodId,
			...(meta ? { _meta: meta } : {}),
		});
	}

	async logout() {
		return await this.request("logout", {});
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
		const result = await this.request("session/prompt", {
			sessionId: this.sessionId,
			prompt: parts,
		});
		if (result?.usage) {
			// Prompt-result usage is usually turn token accounting, while a prior
			// usage_update may also contain the context-window size/consumption. Keep
			// both views instead of replacing the richer context data at turn end.
			this.applySessionState({
				sessionInfo: { usage: { ...(this.sessionInfo?.usage ?? {}), ...result.usage } },
			});
		}
		return result;
	}

	async listSessions() {
		const sessions = [];
		const sessionIds = new Set();
		const cursors = new Set();
		let cursor = undefined;
		for (let page = 0; page < MAX_ACP_SESSION_LIST_PAGES; page += 1) {
			const result = await this.request("session/list", {
				cwd: process.cwd(),
				...(cursor ? { cursor } : {}),
			});
			for (const session of result?.sessions ?? []) {
				const id = session?.sessionId;
				if (id && sessionIds.has(id)) continue;
				if (id) sessionIds.add(id);
				sessions.push(session);
				if (sessions.length >= MAX_ACP_SESSION_LIST_ENTRIES) return sessions;
			}
			const nextCursor = result?.nextCursor;
			if (!nextCursor || cursors.has(nextCursor)) break;
			cursors.add(nextCursor);
			cursor = nextCursor;
		}
		return sessions;
	}

	async loadSession(sessionId, options = {}) {
		const params = this.sessionRequestParams({ sessionId });
		return await this.switchSession(this.capabilities?.loadSession ? "session/load" : "session/resume", params, sessionId, options);
	}

	async deleteSession(sessionId) {
		return await this.request("session/delete", { sessionId });
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
		// All of these fields describe one session. A sparse session/new or
		// session/load response must not inherit usage, title, model, or mode state
		// from the session that was just replaced; buffered updates below repopulate
		// anything the backend publishes asynchronously.
		this.configOptions = [];
		this.models = undefined;
		this.modes = undefined;
		this.sessionInfo = {};
		this.applySessionState(result);
		// Keep buffering across beforeReplay so a live update arriving during its
		// await cannot jump ahead of the older buffered updates. Once the session RPC
		// has committed, callback failure must not strand buffering or discard history:
		// replay the committed session's updates, then surface the callback error.
		let beforeReplayError;
		try {
			await options.beforeReplay?.(result);
		} catch (error) {
			beforeReplayError = error;
		}
		this.bufferingSessionUpdates = false;
		try {
			while (this.bufferedSessionUpdates.length > 0) {
				this.handleSessionUpdate(this.bufferedSessionUpdates.shift());
			}
		} finally {
			this.bufferedSessionUpdates = [];
		}
		if (beforeReplayError) throw beforeReplayError;
		await this.applyStartupMode();
		return result;
	}

	sessionRequestParams(params = {}) {
		const supportsAdditionalDirectories = Boolean(this.capabilities?.sessionCapabilities?.additionalDirectories);
		const additionalDirectories = supportsAdditionalDirectories
			? normalizeAdditionalDirectories(this.agent.additionalDirectories)
			: [];
		const mcpServers = normalizeMcpServers(
			this.agent.mcpServers,
			this.capabilities?.mcpCapabilities,
			mergedAgentEnvironment(this.agent),
		);
		return {
			...params,
			cwd: process.cwd(),
			mcpServers,
			...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
			...(this.agent._sessionMeta ? { _meta: this.agent._sessionMeta } : {}),
		};
	}

	async applyStartupMode() {
		if (this.agent._startupMode) await this.setMode(this.agent._startupMode);
	}

	async setConfigOption(configId, value, type = undefined) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		const requestSessionId = this.sessionId;
		const result = await this.request("session/set_config_option", {
			sessionId: requestSessionId,
			configId,
			value,
			...(type === "boolean" ? { type: "boolean" } : {}),
		});
		if (this.sessionId === requestSessionId) this.applySessionState(result);
		return result;
	}

	async setMode(modeId) {
		if (!this.sessionId) throw new Error("ACP session is not ready");
		const requestSessionId = this.sessionId;
		const result = await this.request("session/set_mode", {
			sessionId: requestSessionId,
			modeId,
		});
		if (this.sessionId === requestSessionId) {
			this.applySessionState({ modes: { ...this.modes, currentModeId: modeId } });
		}
		return result;
	}

	applySessionState(state = {}) {
		if (Array.isArray(state.configOptions)) {
			this.configOptions = state.configOptions;
			const modeOption = findConfigOption({ configOptions: this.configOptions }, "mode");
			if (modeOption?.currentValue !== undefined && this.modes) {
				this.modes = { ...this.modes, currentModeId: modeOption.currentValue };
			}
		}
		if (state.models) this.models = state.models;
		if (state.modes) {
			this.modes = state.modes;
			const currentModeId = state.modes.currentModeId;
			if (currentModeId !== undefined) {
				this.configOptions = this.configOptions.map((option) =>
					option?.category === "mode" || option?.id === "mode"
						? { ...option, currentValue: currentModeId }
						: option,
				);
			}
		}
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

	stop(options = {}) {
		this.stopping = true;
		// A deliberately stopped client is unusable immediately, even though the
		// child process reports its actual exit on a later event-loop turn. Keeping
		// this state synchronous prevents commands such as /login from racing a
		// just-stopped backend and writing to its closing stdin.
		this.exited = true;
		for (const terminal of this.terminals.values()) terminal.kill();
		this.terminals.clear();
		this.rejectPending(new Error("backend stopped"));
		const termination = terminateChild(this.child, "SIGTERM", options);
		// A successful taskkill /T is Windows' process-tree completion contract.
		// Persist that result immediately: stop() is also used without awaiting the
		// root handle, and a later stopAndWaitOwned() must not mistake the now-exited
		// root for an unconfirmed tree (or lose the fact that /T required /F).
		if ((options.platform ?? process.platform) === "win32" && termination.treeSignalled) {
			this.processGroupConfirmedGone = true;
			this.exitedProcessGroupForceSignalled ||= termination.forceSignalled;
		}
		return termination;
	}

	stopAndWait(timeoutMs = 5_000) {
		if (this.stopAndWaitPromise) return this.stopAndWaitPromise;
		this.stopWaiterCount = (this.stopWaiterCount ?? 0) + 1;
		let operation;
		operation = this.stopAndWaitOwned(timeoutMs).finally(() => {
			this.stopWaiterCount = Math.max(0, (this.stopWaiterCount ?? 1) - 1);
			if (this.stopAndWaitPromise === operation) this.stopAndWaitPromise = undefined;
		});
		this.stopAndWaitPromise = operation;
		return operation;
	}

	async stopAndWaitOwned(timeoutMs = 5_000, options = {}) {
		const platform = options.platform ?? process.platform;
		const child = this.child;
		// Register before signalling: a fast child can otherwise close between
		// stop() and listener installation. Do not act on a PID that was already
		// closed before this operation, since it may since have been recycled.
		const closedBeforeStop = !child || this.childClosed;
		const exitedBeforeStop = Boolean(
			child && (
				this.childExitObserved ||
				(child.exitCode !== null && child.exitCode !== undefined) ||
				child.signalCode
			),
		);
		let directChildClosed = closedBeforeStop;
		if (child && !directChildClosed) child.once?.("close", () => { directChildClosed = true; });
		let termination = this.stop({
			platform,
			...(options.runWindowsTaskkill ? { runWindowsTaskkill: options.runWindowsTaskkill } : {}),
		});
		if (!child) return;

		// When a POSIX root exited before this call, its exit handler made the only
		// safe post-exit signalling decision synchronously: either it observed the
		// group absent (and retired the PGID forever), or it swept the still-owned
		// group. Windows cannot make that post-exit check. From here we only observe
		// established quiescence; never signal a possibly recycled id.
		if (exitedBeforeStop) {
			if (platform === "win32") {
				// Once a Windows root exits, taskkill /T can no longer safely identify its
				// descendants: the numeric PID may already have been recycled. Only a prior
				// tree-aware shutdown can establish quiescence. Treat an otherwise
				// pre-exited root as unconfirmed so every replacement path installs its
				// sticky process-tree fence instead of launching alongside an orphan.
				if (!this.processGroupConfirmedGone) {
					throw processTreeTerminationError(
						"ACP backend root exited before shutdown, so its Windows process tree could not be confirmed stopped",
					);
				}
				if (!await waitForDirectChildExit(() => directChildClosed, PROCESS_FORCE_KILL_WAIT_MS)) {
					throw processTreeTerminationError("ACP backend process tree stopped, but its root handle did not close");
				}
				if (this.exitedProcessGroupForceSignalled) {
					throw processTreeForceKilledError("ACP backend process tree was force-killed before shutdown completed");
				}
				return;
			}
			if (this.processGroupConfirmedGone) {
				if (!await waitForDirectChildExit(() => directChildClosed, PROCESS_FORCE_KILL_WAIT_MS)) {
					throw processTreeTerminationError("ACP backend process group exited, but its root handle did not close");
				}
				if (this.exitedProcessGroupForceSignalled) {
					throw processTreeForceKilledError("ACP backend root exited before shutdown; its surviving process group was force-killed");
				}
				return;
			}
			if (!await waitForProcessTreeExit(child, () => directChildClosed, PROCESS_FORCE_KILL_WAIT_MS, undefined, {
				platform,
				onPosixGroupGone: () => { this.processGroupConfirmedGone = true; },
			})) {
				throw processTreeTerminationError("ACP backend root exited, but its process group could not be confirmed stopped");
			}
			this.processGroupConfirmedGone = true;
			if (this.exitedProcessGroupForceSignalled) {
				throw processTreeForceKilledError("ACP backend root exited before shutdown; its surviving process group was force-killed");
			}
			return;
		}
		if (closedBeforeStop) return;

		// A direct `close` is not enough on POSIX: an ACP adapter can exit while a
		// same-group Codex descendant ignores SIGTERM with detached stdio. Wait for
		// both Node to reap the child and the process group to disappear.
		if (await waitForProcessTreeExit(child, () => directChildClosed, timeoutMs, termination, {
			platform,
			onPosixGroupGone: () => { this.processGroupConfirmedGone = true; },
		})) {
			this.processGroupConfirmedGone = true;
			if (termination.forceSignalled) {
				throw processTreeForceKilledError("ACP backend graceful shutdown failed; its process tree was force-killed");
			}
			if (this.exitedProcessGroupForceSignalled) {
				throw processTreeForceKilledError("ACP backend root exited during shutdown; its surviving process group was force-killed");
			}
			return;
		}
		if (platform !== "win32" && this.processGroupConfirmedGone) {
			if (!await waitForDirectChildExit(() => directChildClosed, PROCESS_FORCE_KILL_WAIT_MS)) {
				throw processTreeTerminationError("ACP backend process group exited, but its root handle did not close");
			}
			return;
		}

		termination = mergeTerminationResults(
			termination,
			terminateChild(child, "SIGKILL", {
				includeExitedGroup: true,
				platform,
				...(options.runWindowsTaskkill ? { runWindowsTaskkill: options.runWindowsTaskkill } : {}),
			}),
		);
		if (!await waitForProcessTreeExit(child, () => directChildClosed, PROCESS_FORCE_KILL_WAIT_MS, termination, {
			platform,
			onPosixGroupGone: () => { this.processGroupConfirmedGone = true; },
		})) {
			throw processTreeTerminationError(`ACP backend process tree did not exit after SIGKILL`);
		}
		this.processGroupConfirmedGone = true;
		throw processTreeForceKilledError(`ACP backend did not exit within ${timeoutMs}ms; its process tree was force-killed`);
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
		if (message.id !== undefined && message.method === "elicitation/create") {
			this.onEvent({ type: "backend_activity" });
			void this.handleElicitationRequest(message);
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

	async handleElicitationRequest(message) {
		try {
			const candidate = this.onElicitationRequest
				? await this.onElicitationRequest(message.params ?? {})
				: { action: "cancel" };
			const result = normalizeElicitationResponse(message.params ?? {}, candidate);
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result });
		} catch {
			this.writeSafe({ jsonrpc: "2.0", id: message.id, result: { action: "cancel" } });
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
		if (kind === "usage_update") {
			this.sessionInfo = { ...this.sessionInfo, usage: update };
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
		const toolUpdateStatus = toolUpdateField(update, "status");
		if (kind === "tool_call_update" && toolUpdateStatus) {
			const title = toolUpdateField(update, "title");
			this.onEvent({
				type: "tool_update",
				id: toolId(update),
				title: title ? normalizeToolTitle(title) : undefined,
				status: normalizedToolStatus(toolUpdateStatus),
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
		this.activeAgentGeneration = 0;
		this.ready = false;
		this.busy = false;
		this.client = undefined;
		this.connectionAttempt = undefined;
		this.agentSwitchTail = undefined;
		this.replacementProcessFence = undefined;
		this.menuHandle = undefined;
		this.menuEditorText = undefined;
		this.selectionActions = new Set();
		this.selectionActionInProgress = false;
		this.configUpdateTokens = new Set();
		this.configUpdateCount = 0;
		this.asyncPickerLoads = new Set();
		this.asyncPickerLoadCount = 0;
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
		this.flushingDeferredLocalSlashCommands = false;
		this.queuedInputOrder = 0;
		this.permissionQueue = [];
		this.permissionPromptActive = false;
		this.activeInteractiveRequest = undefined;
		// Persisted "allow always" grants (harness-agnostic, survive restarts) and
		// the per-agent runtime mode override set by /yolo. See src/harness/permissions.mjs.
		this.permissionGrants = loadGrants();
		this.runtimePermissionMode = new Map();
		this.runtimePermissionModeByClient = new WeakMap();
		this.runtimePermissionBackendContextByClient = new WeakMap();
		this.cancelRequested = false;
		this.afterToolCancelPending = false;
		this.cancelGraceTimer = undefined;
		this.activeToolIds = new Set();
		this.activeAnonymousToolCount = 0;
		this.seenToolThisTurn = false;
		this.pendingPromptDisplay = undefined;
		// Editable commands staged by a /btw picker belong to that exact side
		// process even if focus changes before Enter. closeBtw clears this binding.
		this.editorTargetThread = undefined;
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
		this.btwShutdownTail = undefined;
		this.btwShutdownClients = new WeakMap();
		// Native Codex/app-server commands and local capture helpers are detached
		// process-group leaders just like ACP backends. Keep one app-owned registry
		// so Ctrl-D and signal shutdown can retire every active tree before returning
		// control to the shell.
		this.nativeProcessTracker = new NativeProcessTracker();
		this.stopping = false;
		this.stopPromise = undefined;
		this.deferredBtwPrompts = [];
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
	forceFullRepaint(options = {}) {
		const ui = this.ui;
		ui.terminal.write("\x1b[2J\x1b[H");
		ui.previousLines = [];
		ui.maxLinesRendered = 0;
		ui.previousViewportTop = 0;
		ui.hardwareCursorRow = 0;
		ui.cursorRow = 0;
		ui.requestRender(true);
		if (options.immediate && typeof ui.doRender === "function") {
			if (ui.renderTimer) {
				clearTimeout(ui.renderTimer);
				ui.renderTimer = undefined;
			}
			ui.renderRequested = false;
			ui.doRender();
		}
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

	recordReplacementProcessFence(error, options = {}) {
		if (!isProcessTreeTerminationFailure(error)) return false;
		this.replacementProcessFence ??= error;
		if (options.preserveReady !== true) this.ready = false;
		return true;
	}

	replacementProcessFenceMessage() {
		const detail = this.replacementProcessFence?.message;
		return (
			"Backend restart is blocked because a previous process tree could not be confirmed stopped. " +
			"Manually terminate the old backend process tree, then restart cc" +
			(detail ? ` (${detail})` : "")
		);
	}

	replacementProcessFenceError() {
		const error = new Error(this.replacementProcessFenceMessage());
		error.code = "PROCESS_TREE_TERMINATION_FAILED";
		error.cause = this.replacementProcessFence;
		return error;
	}

	reportReplacementProcessFence() {
		this.addError(this.replacementProcessFenceMessage());
		this.ui.requestRender();
	}

	async retireSupersededClient(client) {
		try {
			await stopClientsForReplacement([client]);
		} catch (error) {
			if (this.recordReplacementProcessFence(error)) this.reportReplacementProcessFence();
			else this.addError(`Could not stop a superseded backend: ${error.message ?? error}`);
		}
	}

	async switchAgent(key, transport = "acp", options = {}) {
		if (this.stopping) return;
		// Serialize the complete retirement + startup lifecycle. A second switch that
		// observes `client = undefined` while the first is still reaping the old tree
		// must wait, rather than launching a competing backend.
		const previous = this.agentSwitchTail ?? Promise.resolve();
		let release;
		const turn = new Promise((resolve) => { release = resolve; });
		const tail = previous.then(() => turn);
		this.agentSwitchTail = tail;
		await previous;
		try {
			// Shutdown may have started while this replacement was queued behind an
			// earlier lifecycle turn. Never let a queued turn launch after the TUI has
			// begun returning control to the shell.
			if (this.stopping) return;
			if (this.replacementProcessFence) {
				this.reportReplacementProcessFence();
				return;
			}
			if (this.btwShutdownTail) await this.btwShutdownTail;
			if (this.stopping) return;
			if (this.replacementProcessFence) {
				this.reportReplacementProcessFence();
				return;
			}
			return await this.switchAgentUnlocked(key, transport, options);
		} finally {
			release();
			if (this.agentSwitchTail === tail) this.agentSwitchTail = undefined;
		}
	}

	async switchAgentUnlocked(key, transport = "acp", options = {}) {
		if (this.stopping) return;
		if (this.startupConnectTimer) {
			clearTimeout(this.startupConnectTimer);
			this.startupConnectTimer = undefined;
		}
		const agent = this.config.agents[key];
		if (!agent) {
			this.addNotice(`unknown agent: ${key}`);
			return;
		}
		const previousClient = this.client;
		const previousBtwClient = this.btwThread?.client;
		const transitionWasInProgress = this.sessionSwitchInProgress === true;
		this.cancelPermissionPrompts();
		this.closeMenu();
		// A /btw fork is branched from the current agent's session; switching
		// agents invalidates it, so tear it down.
		if (this.btwThread) this.closeBtw({ stop: false });
		if (previousClient || previousBtwClient) {
			// Detach the main client before waiting so late callbacks from either old
			// process are stale. Authentication reconnects can otherwise start a new
			// credential-bearing backend while the prior one still owns the same Codex
			// state and retains old credentials in its process environment.
			if (this.client === previousClient) this.client = undefined;
			this.ready = false;
			this.sessionSwitchInProgress = true;
			this.statusState = options.statusState ?? "stopping previous backend";
			this.updateSpinner();
			this.ui.requestRender();
			try {
				await stopClientsForReplacement([previousClient, previousBtwClient]);
			} catch (error) {
				this.sessionSwitchInProgress = transitionWasInProgress;
				this.statusState = "";
				this.updateSpinner();
				if (this.recordReplacementProcessFence(error)) this.reportReplacementProcessFence();
				else {
					this.addError(`Could not stop the previous backend: ${error.message ?? error}`);
					this.ui.requestRender();
				}
					return;
				}
			// The old trees are now confirmed gone, but shutdown may have begun while
			// that bounded wait was in flight. Leave the app detached instead of
			// starting a replacement that stopAndExit did not get a chance to snapshot.
			if (this.stopping) {
				this.sessionSwitchInProgress = false;
				this.statusState = "";
				return;
			}
		}
		if (this.activeKey !== key || this.transport !== transport) {
			this.activeAgentGeneration = (this.activeAgentGeneration ?? 0) + 1;
		}
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
		this.selectionActions?.clear();
		this.selectionActionInProgress = false;
		this.configUpdateTokens?.clear();
		this.configUpdateCount = 0;
		// Native picker/load tokens outlive the agent context that created them.
		// Their context checks discard stale UI results, while each operation's
		// `finally` releases its token. Preserve that input gate across replacement
		// startup so prompts on the new backend cannot overlap an old Codex CLI or
		// app-server mutation that is still settling.
		this.sessionSwitchInProgress = options.continueSessionSwitch === true;
		// A deferred config command can discover that the backend exited and reconnect
		// through ensureConnected(). Only that narrow reconnect path preserves the
		// remaining ordered flush; an explicit harness switch discards old-agent work.
		if (!this.sessionSwitchInProgress && options.preserveDeferredCommands !== true) this.deferredLocalSlashCommands = [];
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
					if (this.client !== client) return cancelledOutcome();
					return this.resolvePermissionOutcome(key, agent, params, { sourceClient: client });
				},
				onCursorRequest: (method, params) => {
					if (this.client !== client) return cursorCancelResult(method);
					return this.resolveCursorOutcome(key, agent, method, params, { sourceClient: client });
				},
				onElicitationRequest: (params) => {
					if (this.client !== client) return { action: "cancel" };
					return this.requestElicitation(params, { sourceClient: client });
				},
				elicitationCapabilities: { url: true, form: true },
		});
		this.client = client;
		let settleConnectionAttempt;
		const connectionAttempt = { client };
		connectionAttempt.promise = new Promise((resolve) => {
			settleConnectionAttempt = resolve;
		});
		this.connectionAttempt = connectionAttempt;
		try {
			const sessionIdToLoad = options.loadSessionId;
			await client.initialize({ createSession: !sessionIdToLoad });
			if (sessionIdToLoad) {
				await client.loadSession(sessionIdToLoad, {
					beforeReplay: options.beforeSessionReplay,
				});
			}
			if (this.client !== client) {
				await this.retireSupersededClient(client);
				return;
			}
			this.ready = true;
			this.statusState = "";
			this.updateSpinner();
			// Load the markdown renderer now (before the first token) so it never
			// flips plain->markdown mid-stream and re-styles already-scrolled lines.
			loadMarkdownRenderer(() => this.ui.requestRender());
			// A caller-owned session transition must apply deferred local config
			// commands before any prompt entered during the switch. Its outer owner
			// clears the flag and schedules the drain after those commands finish.
			if (!this.sessionSwitchInProgress) this.schedulePromptQueueDrain();
			this.ui.requestRender();
		} catch (error) {
			if (this.client !== client) {
				await this.retireSupersededClient(client);
				return;
			}
			const authenticationPending = client.authMethods.length > 0 && isAuthenticationRequiredError(error);
			if (!authenticationPending) client.stop();
			this.ready = false;
			this.statusState = "";
			this.updateSpinner();
			this.addError(error.message ?? String(error));
			if (authenticationPending) {
				this.addNotice("Authentication is required. Run /login to sign in without leaving cc.");
			}
			this.ui.requestRender();
		} finally {
			settleConnectionAttempt();
			if (this.connectionAttempt === connectionAttempt) this.connectionAttempt = undefined;
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
			this.updateAutocomplete();
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
		this.editorTargetThread = undefined;
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
			this.editorTargetThread = undefined;
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
			const image = await readClipboardImage(this.trackedNativeProcessOptions());
			if (!image) {
				this.addNotice("No image found in clipboard.");
				this.ui.requestRender();
				return;
			}
			const label = this.nextClipboardImageLabel();
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

	nextClipboardImageLabel() {
		this.clipboardImageCounter ??= 0;
		const editorText = String(this.editor.getText?.() ?? "");
		const stagedLabels = new Set(this.clipboardImages.map((image) => image.label));
		let label;
		do {
			label = `[Image ${++this.clipboardImageCounter}]`;
		} while (editorText.includes(label) || stagedLabels.has(label));
		return label;
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
			parts.push(clipboardImagePromptPart(image));
			offset = index + image.label.length;
		}
		const after = text.slice(offset);
		if (after.trim()) parts.push({ type: "text", text: after });
		return parts.length > 0 ? parts : matches.map(({ image }) => clipboardImagePromptPart(image));
	}

	restagePromptImages(text, promptParts) {
		this.clipboardImages = imageAttachmentsFromPromptParts(text, promptParts);
	}

	imagePromptCapability(capabilitiesOverride = undefined) {
		const state = this.sessionStates.get(this.activeKey);
		const capabilities = capabilitiesOverride ?? state?.capabilities ?? this.client?.capabilities;
		return imagePromptCapability(capabilities);
	}

	embeddedContextCapability(capabilitiesOverride = undefined) {
		const state = this.sessionStates.get(this.activeKey);
		const capabilities = capabilitiesOverride ?? state?.capabilities ?? this.client?.capabilities;
		if (!capabilities || Object.keys(capabilities).length === 0) return undefined;
		return capabilities.promptCapabilities?.embeddedContext === true;
	}

	promptForActiveCapabilities(text, promptParts, options = {}) {
		let parts = Array.isArray(promptParts) ? promptParts : [{ type: "text", text }];
		let structured = Array.isArray(promptParts);
		if (hasImagePromptPart(parts) && this.imagePromptCapability(options.capabilities) !== true) {
			const notice = `${this.config.agents[this.activeKey]?.label ?? this.activeKey} does not support image prompts; sending text only.`;
			if (options.onNotice) options.onNotice(notice);
			else this.addNotice(notice);
			parts = [{ type: "text", text }];
			structured = false;
		}
		if (this.embeddedContextCapability(options.capabilities) === true) {
			const expanded = [];
			let embedded = 0;
			const expansionState = { seenPaths: new Set(), embeddedCount: 0, embeddedBytes: 0 };
			for (const part of parts) {
				if (part?.type !== "text") {
					expanded.push(part);
					continue;
				}
				const result = buildEmbeddedFilePromptParts(part.text, process.cwd(), { state: expansionState });
				expanded.push(...result.parts);
				embedded += result.embeddedCount;
			}
			if (embedded > 0) {
				parts = expanded;
				structured = true;
			}
		}
		// codex-acp (and other command-aware ACP agents) parse a slash command from
		// the first text block only. Splitting `/review inspect @notes.md and more`
		// around an embedded resource would silently truncate its arguments at the
		// mention. Keep the complete command in block zero, but retain the resources
		// and images produced above so slash commands get the same embedded-context
		// behavior as ordinary prompts.
		if (/^\s*\/\S/.test(String(text ?? ""))) {
			const attachments = parts.filter((part) => part?.type !== "text");
			return attachments.length > 0 ? [{ type: "text", text }, ...attachments] : text;
		}
		return structured ? parts : text;
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
		if (!text) {
			this.editorTargetThread = undefined;
			return;
		}
		const boundSideThread = this.editorTargetThread;
		this.editorTargetThread = undefined;
		if (boundSideThread && (this.btwThread !== boundSideThread || boundSideThread.client?.exited)) {
			this.addNotice("The /btw thread closed before the staged command could be submitted.");
			this.ui.requestRender();
			return;
		}
		const inputSideThread = boundSideThread ?? (
			this.focusedThread === "btw" && this.btwThread ? this.btwThread : undefined
		);
		// When the /btw fork is focused, the editor drives that thread — except
		// harness and reserved local UI commands, which still run on the main path.
		if (inputSideThread) {
			const targetThread = inputSideThread;
			this.editor.addToHistory(text);
			if (isHarnessCommandText(text)) {
				await this.handleHarnessCommand(text);
				return;
			}
			if (text.startsWith("/")) {
				const { name, argument } = parseSlashCommand(text);
				const route = this.slashCommandRoute(name, argument, {
					// Until the fork publishes its own list, retain the main session's
					// list as a provisional hint and keep cold-start forwarding enabled.
					availableCommands: targetThread.commandsLoaded ? targetThread.availableCommands : undefined,
					commandsLoaded: targetThread.commandsLoaded,
				});
				if (route === "review-dialog") {
					this.openCodexReviewDialog({ targetThread });
					return;
				}
				if (route === "local") {
					await this.runLocalSlashCommand(name, argument, { targetThread });
					return;
				}
				if (route === "unknown") {
					targetThread.addNotice(`Unknown command: /${name}`);
					this.onThreadActivity();
					return;
				}
			}
			const promptParts = this.consumeImagePromptParts(text);
			if (this.sessionSwitchInProgress) {
				// The transition may or may not close this fork (for example deleting a
				// named session needs an async lookup first). Hold the input until the
				// outcome is known, then send it to the surviving fork or queue it on main.
				this.deferredBtwPrompts ??= [];
				this.deferredBtwPrompts.push({
					text,
					promptParts,
					compactCommand: text.startsWith("/"),
					queuedInputOrder: this.nextQueuedInputOrder(),
				});
				this.ui.requestRender();
				return;
			}
			void targetThread.submit(text, promptParts);
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
		if (!this.ready || !this.client || this.client.exited) {
			if (this.client?.exited) this.ready = false;
			this.enqueuePrompt(text, "afterTurn", { displayText, compactCommand: options.compactCommand, promptParts: options.promptParts });
			if (!this.sessionSwitchInProgress) this.statusState = "connecting";
			this.updateSpinner();
			// Reconnect when there is no client or the previous one died (e.g. backend crash).
			if (!this.sessionSwitchInProgress && (!this.client || this.client.exited)) {
				void this.switchAgent(this.activeKey, this.transport, { quiet: true });
			}
			this.ui.requestRender();
			return;
		}
		if (
			this.busy ||
			this.sessionSwitchInProgress ||
			this.flushingDeferredLocalSlashCommands ||
			this.selectionActionInProgress ||
			(this.configUpdateCount ?? 0) > 0 ||
			(this.asyncPickerLoadCount ?? 0) > 0
		) {
			// While a turn is running, Enter queues "after tool" (steer at the next
			// tool-call boundary); Tab queues "after turn". During a session switch
			// or deferred config flush there is no live turn, so always queue behind it.
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
		const client = this.client;
		await this.sendPrompt(text, { pendingUserEcho, promptParts: options.promptParts });
		if (this.client === client) await this.flushPromptQueue();
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
		const info = this.client?.agentInfo ?? this.sessionStates?.get?.(this.activeKey)?.agentInfo;
		return this.transport === "acp" && info?.name === "@agentclientprotocol/codex-acp";
	}

	isCodexBackendActive() {
		return this.activeKey === "codex" || this.isCodexAcpActive();
	}

	requireActiveCodex(commandName, argument = "") {
		if (this.replacementProcessFence) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.reportReplacementProcessFence();
			return false;
		}
		if (this.isCodexBackendActive()) return true;
		this.addCommandMessage(slashCommandText(commandName, argument));
		this.addNotice(`/${commandName} is available only while the Codex backend is active`);
		return false;
	}

	async runFencedCodexAppServerRequests(invocation, requests, agent = {}, options = {}) {
		return await this.runFencedCodexNativeOperation(() =>
			runCodexAppServerRequests(invocation, requests, agent, this.trackedNativeProcessOptions(options)),
		);
	}

	trackedNativeProcessOptions(options = {}) {
		this.nativeProcessTracker ??= new NativeProcessTracker();
		return { ...options, processTracker: this.nativeProcessTracker };
	}

	async runFencedCodexNativeOperation(operation) {
		if (this.replacementProcessFence) throw this.replacementProcessFenceError();
		try {
			return await operation();
		} catch (error) {
			// An unconfirmed native process tree is just as unsafe to retry as an
			// unconfirmed ACP replacement. Keep one app-lifetime fence across both
			// transports so a second state-changing CLI command cannot overlap it.
			if (this.recordReplacementProcessFence(error, { preserveReady: true })) throw this.replacementProcessFenceError();
			throw error;
		}
	}

	runTrackedCodexCommand(invocation, args, agent = {}, options = {}) {
		return this.runFencedCodexNativeOperation(() =>
			runCodexCommand(invocation, args, agent, this.trackedNativeProcessOptions(options)),
		);
	}

	runTrackedCapture(command, args = [], options = {}) {
		return runCapture(command, args, this.trackedNativeProcessOptions(options));
	}

	async resolveLiveNativeCodexDeletionOwners(
		targetId,
		invocation,
		agent,
		mainClient,
		sideThread = this.btwThread,
	) {
		const mainSessionId = mainClient?.sessionId;
		const sideSessionId = sideThread?.sessionId ?? sideThread?.client?.sessionId;
		const forkRegistry = recoverCodexForkRegistry(agent);
		const copyForkIds = forkDescendantIds(targetId, forkRegistry.parents);
		const directOwnershipIds = [targetId, ...copyForkIds];
		const directlyDeletingMain = directOwnershipIds.some((id) => sameSessionId(id, mainSessionId));
		const directlyDeletingSide = Boolean(
			sideThread && directOwnershipIds.some((id) => sameSessionId(id, sideSessionId)),
		);
		const nativeDescendantIds = [];
		const needsNativeScan =
			Object.keys(forkRegistry.parents).length > 0 ||
			(!directlyDeletingMain && Boolean(mainSessionId)) ||
			(!directlyDeletingSide && Boolean(sideSessionId));
		let cursor;
		const seenCursors = new Set();
		for (let pageIndex = 0; needsNativeScan && pageIndex < MAX_ACP_SESSION_LIST_PAGES; pageIndex += 1) {
			const [page] = await this.runFencedCodexAppServerRequests(invocation, [{
				method: "thread/list",
				params: {
					ancestorThreadId: targetId,
					limit: 1_000,
					sourceKinds: CODEX_THREAD_SOURCE_KINDS,
					...(cursor ? { cursor } : {}),
				},
			}], agent, { capabilities: { experimentalApi: true } });
			if (!page || !Array.isArray(page.data)) {
				throw new Error("Codex thread/list returned an invalid response while checking deletion descendants");
			}
			for (const thread of page.data) {
				if (thread?.id && !nativeDescendantIds.some((id) => sameSessionId(id, thread.id))) {
					nativeDescendantIds.push(thread.id);
					if (nativeDescendantIds.length > MAX_ACP_SESSION_LIST_ENTRIES) {
						throw new Error("Codex deletion descendant list exceeded the safety limit");
					}
				}
			}
			const nextCursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
			if (!nextCursor) break;
			if (seenCursors.has(nextCursor)) {
				throw new Error("Codex thread/list repeated a cursor while checking deletion descendants");
			}
			seenCursors.add(nextCursor);
			cursor = nextCursor;
			if (pageIndex === MAX_ACP_SESSION_LIST_PAGES - 1) {
				throw new Error("Codex deletion descendant list exceeded the page safety limit");
			}
		}

		// Native deletion traverses the spawn subtree above, but not copy-fork
		// lineage. Add every registered copy below the root or any native descendant
		// so a nested subagent's /btw history cannot be orphaned either.
		for (const rootId of nativeDescendantIds) {
			for (const copyId of forkDescendantIds(rootId, forkRegistry.parents)) {
				if (!copyForkIds.some((id) => sameSessionId(id, copyId))) copyForkIds.push(copyId);
			}
		}
		const possibleLegacyParents = [targetId, ...nativeDescendantIds, ...copyForkIds];
		for (const unresolved of forkRegistry.unresolved ?? []) {
			if (sameSessionId(unresolved?.child, targetId)) continue;
			const candidates = Array.isArray(unresolved?.candidateIds) ? unresolved.candidateIds : [];
			if (
				candidates.length === 0 ||
				candidates.some((candidate) => possibleLegacyParents.some((parent) => sameSessionId(candidate, parent)))
			) {
				throw new Error(
					`cannot safely determine the parent of legacy copy-fork ${unresolved?.child ?? "unknown"}; ` +
					"its transcript was left untouched",
				);
			}
		}
		const ownershipIds = [targetId, ...nativeDescendantIds, ...copyForkIds];
		const deletingMain = ownershipIds.some((id) => sameSessionId(id, mainSessionId));
		const deletingSide = Boolean(sideThread && ownershipIds.some((id) => sameSessionId(id, sideSessionId)));
		return {
			deletingMain,
			deletingSide,
			sideThread,
			copyForkIds,
			deletionIds: [...copyForkIds, targetId],
		};
	}

	captureActiveAgentContext(options = {}) {
		const key = this.activeKey;
		return {
			key,
			agent: this.config.agents[key],
			transport: this.transport,
			generation: this.activeAgentGeneration ?? 0,
			...(options.includeClient ? { client: this.client } : {}),
		};
	}

	captureSessionCommandTarget(targetThread = undefined) {
		const agentContext = this.captureActiveAgentContext();
		if (!targetThread) {
			return {
				agentContext,
				client: this.client,
				sessionId: this.client?.sessionId,
			};
		}
		return {
			agentContext,
			targetThread,
			client: targetThread.client,
			sessionId: targetThread.sessionId ?? targetThread.client?.sessionId,
		};
	}

	async prepareSessionConfigCommandTarget(commandName, argument = "", targetThread = undefined) {
		let target = this.captureSessionCommandTarget(targetThread);
		if (targetThread) {
			if (!this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName, argument);
				return undefined;
			}
			if (targetThread.ready === false) {
				const ready = typeof targetThread.waitUntilReady === "function"
					? await targetThread.waitUntilReady()
					: false;
				if (!ready || !this.isSessionCommandTargetActive(target)) {
					this.reportClosedSessionCommandTarget(commandName, argument);
					return undefined;
				}
				// Fork establishment assigns the definitive side session id. Capture it
				// only after readiness so a config operation can never target the parent
				// session or race the adapter's startup-mode request.
				target = this.captureSessionCommandTarget(targetThread);
			}
			return this.isSessionCommandTargetActive(target) ? target : undefined;
		}
		if (!this.client || !this.ready || this.client.exited) {
			const connected = await this.ensureConnected();
			if (!connected) return undefined;
			target = this.captureSessionCommandTarget();
		}
		return this.isSessionCommandTargetActive(target) ? target : undefined;
	}

	sessionStateForCommandTarget(target) {
		if (!target?.targetThread) return this.sessionStates.get(this.activeKey);
		if (typeof target.client?.getSessionInfo === "function") return target.client.getSessionInfo();
		return {
			sessionId: target.client?.sessionId,
			configOptions: target.client?.configOptions,
			modes: target.client?.modes,
		};
	}

	addSessionTargetCommand(target, text) {
		if (target?.targetThread) {
			if (this.isSessionCommandTargetActive(target)) {
				target.targetThread.addCommandMessage(text);
				this.onThreadActivity();
				return true;
			}
			return false;
		}
		this.addCommandMessage(text);
		return true;
	}

	addSessionTargetNotice(target, text) {
		if (target?.targetThread) {
			if (this.isSessionCommandTargetActive(target)) {
				target.targetThread.addNotice(text);
				this.onThreadActivity();
				return true;
			}
			return false;
		}
		this.addNotice(text);
		return true;
	}

	addSessionTargetError(target, text) {
		if (target?.targetThread) {
			if (this.isSessionCommandTargetActive(target)) {
				target.targetThread.addError(text);
				this.onThreadActivity();
				return true;
			}
			return false;
		}
		this.addError(text);
		return true;
	}

	isSessionCommandTargetActive(target) {
		if (!target || !this.isActiveAgentContext(target.agentContext)) return false;
		if (!target.targetThread) return this.client === target.client;
		if (this.btwThread !== target.targetThread || target.targetThread.client !== target.client) return false;
		const liveSessionId = target.targetThread.sessionId ?? target.client?.sessionId;
		return !target.client?.exited && (
			target.sessionId === undefined || sameSessionId(liveSessionId, target.sessionId)
		);
	}

	reportClosedSessionCommandTarget(commandName, argument = "") {
		this.addCommandMessage(slashCommandText(commandName, argument));
		this.addNotice(`/${commandName} was cancelled because the targeted /btw thread is no longer open`);
		this.ui.requestRender();
	}

	bindEditorToSideThread(targetThread) {
		this.editorTargetThread = targetThread;
	}

	clearEditorSideThreadBinding(targetThread, options = {}) {
		if (!targetThread || this.editorTargetThread !== targetThread) return false;
		this.editorTargetThread = undefined;
		this.pendingPromptDisplay = undefined;
		if (options.clearText !== false) {
			this.editor.setText("");
			this.clearClipboardImages();
			this.lastKnownEditorText = "";
		}
		return true;
	}

	isActiveAgentContext(context) {
		return Boolean(
			context &&
				this.activeKey === context.key &&
				this.config.agents[context.key] === context.agent &&
				this.transport === context.transport &&
				(this.activeAgentGeneration ?? 0) === (context.generation ?? 0) &&
			(!Object.hasOwn(context, "client") || this.client === context.client),
		);
	}

	refreshCodexThreadStateSnapshot(sessionInfo = undefined) {
		if (!this.isCodexAcpActive()) return;
		const sessionId = sessionInfo?.sessionId ?? this.client?.sessionId;
		const snapshot = this.readCodexThreadState(sessionId);
		if (snapshot) this.codexThreadStateSnapshot = snapshot;
	}

	readCodexThreadState(sessionId) {
		const env = mergedAgentEnvironment(this.config.agents[this.activeKey]);
		return readCodexThreadState(sessionId, codexStateDbPath(env));
	}

	async sendPrompt(text, options = {}) {
		if (!this.client || !this.ready || this.client.exited) {
			this.expirePendingUserEcho(options.pendingUserEcho);
			this.disarmPendingUnsendPrompt(options.pendingUserEcho);
			return;
		}
		const client = this.client;
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
			let backendText = text;
			let backendParts = options.promptParts;
			if (
				!text.startsWith("/") &&
				this.planPromptFallback?.client === client &&
				this.planPromptFallback?.sessionId === client.sessionId
			) {
				backendText = `${PLAN_FALLBACK_INSTRUCTION}\n\n${text}`;
				backendParts = [
					{ type: "text", text: PLAN_FALLBACK_INSTRUCTION },
					...(Array.isArray(options.promptParts) ? options.promptParts : [{ type: "text", text }]),
				];
			}
			const result = await client.prompt(this.promptForActiveCapabilities(backendText, backendParts));
			if (this.client === client) this.noticeForStopReason(result?.stopReason);
		} catch (error) {
			if (this.client === client) this.addError(error.message ?? String(error));
		} finally {
			if (this.client !== client) return;
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
			if ((this.deferredLocalSlashCommands?.length ?? 0) > 0) {
				await this.flushDeferredLocalSlashCommands();
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
		if (
			!this.ready ||
			this.busy ||
			this.sessionSwitchInProgress ||
			this.flushingDeferredLocalSlashCommands ||
			this.selectionActionInProgress ||
			(this.configUpdateCount ?? 0) > 0 ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			this.menuHandle ||
			this.flushingPromptQueue ||
			this.client?.exited
		) return;
		this.flushingPromptQueue = true;
		try {
			while (
				this.ready &&
				!this.busy &&
				!this.sessionSwitchInProgress &&
				!this.flushingDeferredLocalSlashCommands &&
				!this.selectionActionInProgress &&
				(this.configUpdateCount ?? 0) === 0 &&
				(this.asyncPickerLoadCount ?? 0) === 0 &&
				!this.menuHandle &&
				!this.client?.exited &&
				this.promptQueue.length > 0
			) {
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
		this.promptQueue.push({
			text,
			timing,
			displayText: options.displayText,
			compactCommand: options.compactCommand,
			promptParts: options.promptParts,
			queuedInputOrder: this.nextQueuedInputOrder(),
		});
		this.updateSpinner();
		this.ui.requestRender();
		if (timing === "afterTool") this.maybeCancelAfterTool();
		this.schedulePromptQueueDrain();
	}

	schedulePromptQueueDrain() {
		// The transition owner must first apply deferred local commands (for
		// example /model) to the target session. It explicitly schedules the queue
		// after those commands finish, so never leave an early timer armed here.
		if (!Array.isArray(this.promptQueue) || this.promptQueue.length === 0) return;
		if (
			this.sessionSwitchInProgress ||
			this.flushingDeferredLocalSlashCommands ||
			this.selectionActionInProgress ||
			(this.configUpdateCount ?? 0) > 0 ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			this.menuHandle ||
			this.promptQueueDrainScheduled
		) return;
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
		const restoringBehindMenu = Boolean(this.menuHandle && this.menuEditorText !== undefined);
		const current = restoringBehindMenu ? this.menuEditorText : this.editor.getText();
		const next = current ? `${joined}\n${current}` : joined;
		if (restoringBehindMenu) this.menuEditorText = next;
		else this.editor.setText(next);
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
		// Own the transition immediately, not only after the canceled turn settles.
		// Config commands entered in this window must apply to the fresh session.
		this.clearConfigUpdates();
		this.sessionSwitchInProgress = true;
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
		if (parts.includes("exit") || parts.includes("quit")) {
			this.stop();
			return;
		}
		if (this.sessionSwitchInProgress) {
			this.addCommandMessage(command);
			this.addNotice("Harness switching is unavailable while a session transition is in progress");
			return;
		}
		if (parts.length === 1) {
			this.openMenu();
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
		const route = this.slashCommandRoute(name, argument);
		if (route === "review-dialog") {
			this.openCodexReviewDialog();
			return true;
		}
		if (route === "local") {
			await this.runLocalSlashCommand(name, argument);
			return true;
		}
		if (route === "backend") return "backend";
		this.addCommandMessage(text);
		this.addNotice(`Unknown command: /${name}`);
		return true;
	}

	slashCommandRoute(name, argument = "", options = {}) {
		const available = Array.isArray(options.availableCommands)
			? options.availableCommands
			: (this.availableCommands.get(this.activeKey) ?? []);
		const commandsLoaded = typeof options.commandsLoaded === "boolean"
			? options.commandsLoaded
			: this.commandsLoaded?.has(this.activeKey);
		const localNames = new Set(localSlashCommands(this).map((command) => command.name));
		const backendNames = new Set(available.map((command) => command.name));

		if (this.shouldOpenCodexReviewDialog(name, argument, backendNames)) {
			return "review-dialog";
		}
		// Codex's bare `/mcp` and `/mcp verbose` are live-session ACP
		// commands. Only the native CLI's explicit management subcommands are
		// owned locally, so status/tool inspection continues through the adapter.
		if (name === "mcp" && this.isCodexBackendActive()) {
			return isCodexMcpManagementArgument(argument) ? "local" : "backend";
		}
		if (name === "goal" && this.isCodexBackendActive() && ["", "view", "edit"].includes(argument.trim().toLowerCase())) {
			return "local";
		}
		// Persistent Codex forking is owned by cc's guarded main-session
		// transition. Keep it local even while /btw is focused, where the command
		// is deliberately hidden and rejected instead of leaking to the backend.
		if (["fork", "import", "memories"].includes(name) && this.isCodexBackendActive()) return "local";
		// Reserved UI commands stay local even if a backend advertises the name.
		if (RESERVED_LOCAL_COMMANDS.has(name) && localNames.has(name)) {
			return "local";
		}
		if (this.isKnownCodexReviewCommand(name)) return "backend";
		// Codex ACP publishes its command list asynchronously. Its /status carries
		// context/token/rate-limit details that cc's wrapper status cannot reproduce,
		// so preserve it even when the user types during that short startup window.
		if (name === "status" && this.activeKey === "codex" && !commandsLoaded) return "backend";
		// Prefer the backend's own command when it actually advertises the name,
		// so a backend /model or /new is reachable instead of being shadowed.
		if (backendNames.has(name)) return "backend";
		if (localNames.has(name)) return "local";
		// The command list may not have arrived yet (cold start / right after a
		// switch); forward to the backend rather than rejecting a valid command.
		if (!commandsLoaded) return "backend";
		return "unknown";
	}

	shouldOpenCodexReviewDialog(name, argument, backendNames) {
		if (name !== "review" || argument || this.sessionSwitchInProgress) return false;
		if (this.activeKey === "codex") return true;
		return backendNames.has("review") && backendNames.has("review-branch") && backendNames.has("review-commit");
	}

	isKnownCodexReviewCommand(name) {
		return this.activeKey === "codex" && (name === "review" || name === "review-branch" || name === "review-commit");
	}

	openCodexReviewDialog(options = {}) {
		const targetThread = options.targetThread ?? (
			this.focusedThread === "btw" && this.btwThread ? this.btwThread : undefined
		);
		const entries = [
			{ value: "branch", label: "Review against a base branch", description: "PR Style" },
			{ value: "uncommitted", label: "Review uncommitted changes" },
			{ value: "commit", label: "Review a commit" },
			{ value: "custom", label: "Custom review instructions" },
		];
		this.openSelection("Select a review preset", entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			if (targetThread && this.btwThread !== targetThread) {
				this.addNotice("The /btw thread closed before the review could start.");
				this.ui.requestRender();
				return;
			}
			if (entry.value === "uncommitted") {
				if (targetThread) {
					this.pendingPromptDisplay = undefined;
					this.bindEditorToSideThread(undefined);
					// Side turns run independently of main. Do not keep the selection
					// action open for the duration of the review turn.
					void targetThread.submit("/review");
					return;
				}
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
			this.bindEditorToSideThread(targetThread);
			this.pendingPromptDisplay = targetThread ? undefined : { prefix, label: entry.label };
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

	async runLocalSlashCommand(name, argument, options = {}) {
		// `/plan <prompt>` and `/btw <prompt>` both become later backend prompts.
		// Reserve staged images before any deferral so a subsequent queued message
		// cannot steal them while the mode change/fork waits.
		const promptBearingParts = (name === "plan" || name === "btw" || name === "side") && argument
			? (Object.hasOwn(options, "promptParts") ? options.promptParts : this.consumeImagePromptParts(argument))
			: undefined;
		if (this.sessionSwitchInProgress && shouldDeferLocalSlashCommand(name)) {
			this.deferLocalSlashCommand(name, argument, { promptParts: promptBearingParts, targetThread: options.targetThread });
			return;
		}
		const sideTarget = options.targetThread;
		if (sideTarget && !options.fromSideCommandQueue && shouldDeferBusySideConfigCommand(name)) {
			await sideTarget.deferLocalCommand(name, argument, { promptParts: promptBearingParts });
			return;
		}
		if (!sideTarget && this.busy && shouldDeferBusyConfigCommand(name)) {
			this.deferLocalSlashCommand(name, argument, { promptParts: promptBearingParts, targetThread: options.targetThread });
			return;
		}
		if ((this.asyncPickerLoadCount ?? 0) > 0 && shouldDeferDuringLocalOperation(name)) {
			if (sideTarget && shouldDeferBusySideConfigCommand(name)) {
				await sideTarget.deferLocalCommand(name, argument, { promptParts: promptBearingParts });
			} else {
				this.deferLocalSlashCommand(name, argument, { promptParts: promptBearingParts, targetThread: options.targetThread });
			}
			return;
		}
		if ((this.configUpdateCount ?? 0) > 0 && shouldDeferDuringLocalOperation(name)) {
			if (sideTarget && shouldDeferBusySideConfigCommand(name)) {
				await sideTarget.deferLocalCommand(name, argument, { promptParts: promptBearingParts });
			} else {
				this.deferLocalSlashCommand(name, argument, { promptParts: promptBearingParts, targetThread: options.targetThread });
			}
			return;
		}
		if (name === "help") {
			this.addCommandMessage(slashCommandText(name, argument));
			this.showHelp();
			return;
		}
		if (name === "status" || name === "cc-status") {
			this.addCommandMessage(slashCommandText(name, argument));
			this.showStatus();
			return;
		}
		if (name === "clear") {
			await this.startNewSession(name);
			return;
		}
		if (name === "exit" || name === "quit") {
			this.stop();
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
		if (name === "btw" || name === "side") {
			await this.runBtw(argument, { promptParts: promptBearingParts, commandName: name });
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
		if (name === "config") {
			await this.openGenericConfigDialog(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "fast") {
			await this.openFastModeDialog(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "delete") {
			await this.openDeleteDialog(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "archive" || name === "unarchive") {
			await this.runCodexSessionCommand(name, argument, { targetThread: options.targetThread });
			return;
		}
		if (name === "login") {
			await this.openAuthenticationDialog(argument, name);
			return;
		}
		if (name === "logout") {
			await this.logoutActiveAgent(name);
			return;
		}
		if (name === "plugins") {
			await this.openPluginsDialog(argument, name);
			return;
		}
		if (name === "hooks") {
			await this.openCodexHooksReport(argument, name);
			return;
		}
		if (name === "app") {
			await this.openCodexDesktopThread(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "apps") {
			await this.openCodexApps(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "feedback") {
			await this.openCodexFeedback(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "import") {
			await this.openCodexImport(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "memories") {
			await this.openCodexMemories(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "debug-config") {
			await this.openCodexDebugConfig(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "mcp") {
			await this.runCodexMcpManagement(argument, name);
			return;
		}
		if (name === "doctor") {
			await this.runCodexDoctor(name);
			return;
		}
		if (name === "experimental") {
			await this.openExperimentalFeatures(argument, name);
			return;
		}
		if (name === "init") {
			await this.runInitCommand(name);
			return;
		}
		if (name === "rename") {
			await this.renameCodexSession(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "usage") {
			await this.runCodexUsage(argument, name);
			return;
		}
		if (name === "cloud") {
			await this.runCodexCloud(argument, name);
			return;
		}
		if (name === "goal") {
			await this.runCodexGoalView(argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "fork") {
			await this.forkCodexPersistentSession(argument, name, { targetThread: options.targetThread });
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
			await this.openConfigDialog("model", "Model", argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "mode") {
			await this.openConfigDialog("mode", "Mode", argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "effort" || name === "reasoning" || name === "thinking") {
			await this.openConfigDialog("thought_level", "Reasoning", argument, name, { targetThread: options.targetThread });
			return;
		}
		if (name === "plan") {
			await this.setPlanMode(name, argument, {
				promptParts: promptBearingParts,
				queuedInputOrder: options.queuedInputOrder,
				targetThread: options.targetThread,
			});
			return;
		}
		if (name === "yolo" || name === "auto") {
			this.toggleAutoApprove(name, argument);
			return;
		}
		if (name === "permissions") {
			await this.runPermissions(name, argument, { targetThread: options.targetThread });
		}
	}

	// Flip the active harness's permission mode at runtime, harness-agnostically.
	// `/yolo` toggles auto<->ask; `/yolo ask|auto|deny` sets it explicitly.
	toggleAutoApprove(name, argument) {
		this.addCommandMessage(slashCommandText(name, argument));
		const agentKey = this.activeKey;
		const agent = this.config.agents[agentKey];
		const current = this.permissionPolicyFor(agentKey, agent).mode;
		let next;
		if (argument) {
			next = coercePermissionMode(argument);
			if (!next) {
				this.addNotice(`Unknown permission mode: ${oneLine(argument)} (try ask, auto, or deny)`);
				return;
			}
		} else {
			next = current === "auto" ? "ask" : "auto";
		}
		this.runtimePermissionMode.set(agentKey, next);
		this.runtimePermissionModeSource ??= new Map();
		this.runtimePermissionModeSource.set(agentKey, "host");
		const label = next === "auto" ? "auto-approve ON" : next === "deny" ? "auto-deny ON" : "ask on every request";
		this.addNotice(`Permissions for ${agentKey}: ${label}`);
		// Only a genuine native-bypass launch can't be tightened at runtime: it emits
		// no permission requests, and /new reuses the same process + spawn args. Gated
		// auto and generic harnesses keep prompting, so /yolo ask|deny DOES take effect
		// for them — don't warn there. Be honest: only re-launching with the mode in
		// settings re-spawns a native-bypass backend in a prompting configuration.
		const backendContext = this.runtimePermissionBackendContext?.get(agentKey);
		const hasCurrentBackendMode =
			backendContext?.client === this.client &&
			backendContext?.sessionId === this.client?.sessionId;
		const liveFullAccess = hasCurrentBackendMode && backendContext.mode === "agent-full-access";
		// Once the live adapter has reported a mode for this exact client/session,
		// that state supersedes the launch-time bypass flag. For example, changing
		// from full access to `agent` makes the host gate enforceable immediately.
		const cannotGate = hasCurrentBackendMode ? liveFullAccess : agent?._nativeBypass === true;
		if (next !== "auto" && cannotGate) {
			this.addNotice(
				liveFullAccess
					? `Note: ${agentKey} is in full-access mode and won't emit requests for cc to gate. ` +
						`Run /permissions auto or /permissions read-only, then /yolo ${next} again.`
					: `Note: ${agentKey} was launched in auto mode and won't emit requests to gate this session. ` +
						`Set "permissions" for ${agentKey} in settings.json and restart cc to fully enforce ${next}.`,
			);
		}
		this.ui.requestRender();
	}

	// Codex exposes its read-only/agent/full-access presets as ACP modes. Keep that
	// backend sandbox and cc's host-side permission gate synchronized; `show` and
	// `clear` retain cc's cross-agent grant management.
	async runPermissions(name, argument, options = {}) {
		const arg = oneLine(argument).toLowerCase();
		const agentKey = this.activeKey;
		const targetThread = options.targetThread;
		let target = this.captureSessionCommandTarget(targetThread);
		if (targetThread && !this.isSessionCommandTargetActive(target)) {
			this.reportClosedSessionCommandTarget(name, argument);
			return;
		}
		if (arg === "clear") {
			this.addSessionTargetCommand(target, slashCommandText(name, argument));
			try {
				this.permissionGrants = forgetGrants(() => true);
				this.addSessionTargetNotice(target, "Cleared all remembered permission grants.");
			} catch (error) {
				this.addSessionTargetNotice(target, `Could not clear permission grants: ${error.message ?? error}`);
			}
			this.ui.requestRender();
			return;
		}
		if (this.isCodexBackendActive() && arg !== "show" && arg !== "grants") {
			target = await this.prepareSessionConfigCommandTarget(name, argument, targetThread);
			if (!target) return;
			const state = this.sessionStateForCommandTarget(target);
			const option = findConfigOption(state, "mode");
			const modes = flattenModes(state);
			const values = option ? flattenConfigOptions(option) : modes.map((mode) => ({ value: mode.id, name: mode.name, description: mode.description }));
			const permissionValues = values.filter((entry) => codexPermissionMode(entry.value));
			if (permissionValues.length === 0) {
				this.addSessionTargetCommand(target, slashCommandText(name, argument));
				this.addSessionTargetNotice(target, "Codex did not advertise permission modes for this session");
				return;
			}
			const apply = async (entry, displayArgument = argument) => {
				const displayText = slashPromptDisplay(slashCommandText(name, displayArgument), entry.name);
				if (targetThread) {
					if (!this.isSessionCommandTargetActive(target)) {
						this.reportClosedSessionCommandTarget(name, displayArgument);
						return false;
					}
					const changed = await this.setSideThreadModeValue(target, option, entry.value, { displayText });
					if (!changed && !this.isSessionCommandTargetActive(target)) {
						this.reportClosedSessionCommandTarget(name, displayArgument);
					}
					return changed;
				}
				if (option) return await this.setConfigValue(option, entry.value, entry.name, { displayText });
				return await this.setModeValue(entry.value, entry.name, { displayText });
			};
			if (!arg) {
				const current = option?.currentValue ?? state?.modes?.currentModeId;
				this.openSelection("Permissions", permissionValues.map((entry) => ({
					value: entry,
					label: entry.name,
					description: entry.description,
					active: entry.value === current,
				})), async (entry) => {
					this.closeMenu();
					if (entry?.value) await apply(entry.value, "");
				});
				return;
			}
			const targetMode = codexPermissionMode(arg);
			const entry = permissionValues.find((value) => codexPermissionMode(value.value) === targetMode);
			if (!targetMode || !entry) {
				this.addSessionTargetCommand(target, slashCommandText(name, argument));
				this.addSessionTargetNotice(target, `Unknown Codex permission mode: ${argument} (try read-only, auto, or full-access)`);
				return;
			}
			await apply(entry);
			return;
		}
		this.addSessionTargetCommand(target, slashCommandText(name, argument));
		const policy = this.permissionPolicyFor(agentKey, this.config.agents[agentKey], {
			sourceClient: targetThread ? target.client : undefined,
		});
		const lines = [`Permissions — ${agentKey}: mode=${policy.mode}, remember=${policy.remember ? "on" : "off"}`];
		if (policy.rules.length === 0) {
			lines.push("  (no rules or remembered grants)");
		} else {
			for (const rule of policy.rules) {
				const scope = rule.agent ? `${rule.agent}:` : "*:";
				lines.push(`  ${rule.action === "deny" ? "deny " : "allow"} ${scope}${rule.tool}`);
			}
		}
		lines.push("Use /permissions [read-only|auto|full-access] for Codex, /yolo [ask|auto|deny] for cc's host gate, or /permissions clear to forget grants.");
		this.addSessionTargetNotice(target, lines.join("\n"));
		this.ui.requestRender();
	}

	deferLocalSlashCommand(name, argument = "", options = {}) {
		this.deferredLocalSlashCommands.push({
			name,
			argument,
			...(Array.isArray(options.promptParts) ? { promptParts: options.promptParts } : {}),
			...(options.targetThread ? { targetThread: options.targetThread } : {}),
			queuedInputOrder: this.nextQueuedInputOrder(),
		});
		this.updateSpinner();
		this.ui.requestRender();
	}

	nextQueuedInputOrder() {
		this.queuedInputOrder = (this.queuedInputOrder ?? 0) + 1;
		return this.queuedInputOrder;
	}

	restoreFailedSessionSwitchInput() {
		const queued = Array.isArray(this.promptQueue) ? this.promptQueue.splice(0) : [];
		const deferredCommands = Array.isArray(this.deferredLocalSlashCommands)
			? this.deferredLocalSlashCommands.splice(0)
			: [];
		const deferred = deferredCommands.map((command) => ({
			text: slashCommandText(command.name, command.argument),
			timing: "afterTurn",
			promptParts: command.promptParts,
			queuedInputOrder: command.queuedInputOrder,
		}));
		const entries = [...queued, ...deferred].sort(
			(a, b) => (a.queuedInputOrder ?? Number.MAX_SAFE_INTEGER) - (b.queuedInputOrder ?? Number.MAX_SAFE_INTEGER),
		);
		if (entries.length === 0) return;
		this.pendingPromptDisplay = undefined;
		this.restoreQueuedTextToComposer(entries);
	}

	async flushDeferredLocalSlashCommands() {
		this.deferredLocalSlashCommands ??= [];
		// A config/picker finalizer can fire while the drain that started it is
		// still awaiting the command. Never let that finalizer create a second
		// consumer for the same FIFO.
		if (this.flushingDeferredLocalSlashCommands) return;
		this.flushingDeferredLocalSlashCommands = true;
		try {
			while (!this.sessionSwitchInProgress && !this.menuHandle && this.deferredLocalSlashCommands.length > 0) {
				const command = this.deferredLocalSlashCommands[0];
				// Mirror runLocalSlashCommand's gates before removing the head. If it
				// cannot run yet, leave it in place; shifting and immediately re-adding
				// it would rotate this loop forever and starve the operation we await.
				if (
					(this.busy && shouldDeferBusyConfigCommand(command.name)) ||
					((this.asyncPickerLoadCount ?? 0) > 0 && shouldDeferDuringLocalOperation(command.name)) ||
					((this.configUpdateCount ?? 0) > 0 && shouldDeferDuringLocalOperation(command.name))
				) break;
				this.deferredLocalSlashCommands.shift();
				await this.runLocalSlashCommand(command.name, command.argument, {
					fromDeferredLocalSlashQueue: true,
					promptParts: command.promptParts,
					targetThread: command.targetThread,
				});
			}
		} finally {
			this.flushingDeferredLocalSlashCommands = false;
			// A prompt-drain timer may have fired while this FIFO owner was
			// awaiting a config/picker command and returned at the guard above.
			// Wake it again after releasing ownership so queued prompts cannot be
			// stranded until the next unrelated UI event.
			this.schedulePromptQueueDrain();
		}
	}

	async settleDeferredBtwPrompts() {
		const deferred = Array.isArray(this.deferredBtwPrompts) ? this.deferredBtwPrompts.splice(0) : [];
		if (deferred.length === 0) return;
		if (this.btwThread) {
			const thread = this.btwThread;
			for (const entry of deferred) {
				// submit() marks an idle thread busy synchronously; later calls then enter
				// its own queue. Never await a model turn while finalizing the main transition.
				void thread.submit(entry.text, entry.promptParts).catch((error) => {
					if (this.btwThread === thread) thread.addError(error.message ?? String(error));
				});
			}
			return;
		}
		// The fork was closed by a committed transition. Preserve the inputs on the
		// replacement main session, behind any deferred config commands.
		for (const entry of deferred) {
			this.promptQueue.push({
				text: entry.text,
				timing: "afterTurn",
				displayText: entry.text,
				compactCommand: entry.compactCommand,
				promptParts: entry.promptParts,
				queuedInputOrder: entry.queuedInputOrder,
			});
		}
		this.promptQueue.sort(
			(a, b) => (a.queuedInputOrder ?? Number.MAX_SAFE_INTEGER) - (b.queuedInputOrder ?? Number.MAX_SAFE_INTEGER),
		);
		this.updateSpinner();
		this.ui.requestRender();
	}

	beginAsyncPickerLoad() {
		this.asyncPickerLoads ??= new Set();
		const token = Symbol("async-picker-load");
		this.asyncPickerLoads.add(token);
		this.asyncPickerLoadCount = this.asyncPickerLoads.size;
		return token;
	}

	endAsyncPickerLoad(token) {
		this.asyncPickerLoads ??= new Set();
		this.asyncPickerLoads.delete(token);
		this.asyncPickerLoadCount = this.asyncPickerLoads.size;
		if (this.asyncPickerLoadCount === 0) this.btwThread?.drainQueue?.();
		if (
			this.asyncPickerLoadCount === 0 &&
			!this.flushingDeferredLocalSlashCommands &&
			!this.sessionSwitchInProgress &&
			!this.selectionActionInProgress &&
			!this.menuHandle &&
			(this.deferredLocalSlashCommands?.length ?? 0) > 0
		) {
			void this.flushDeferredLocalSlashCommands().then(() => this.schedulePromptQueueDrain());
			return;
		}
		this.schedulePromptQueueDrain();
	}

	canOpenAsyncPicker() {
		return (
			!this.busy &&
			!this.sessionSwitchInProgress &&
			!this.selectionActionInProgress &&
			(this.configUpdateCount ?? 0) === 0 &&
			!this.permissionPromptActive &&
			!this.menuHandle
		);
	}

	beginConfigUpdate() {
		this.configUpdateTokens ??= new Set();
		const token = Symbol("config-update");
		this.configUpdateTokens.add(token);
		this.configUpdateCount = this.configUpdateTokens.size;
		return token;
	}

	endConfigUpdate(token) {
		this.configUpdateTokens ??= new Set();
		this.configUpdateTokens.delete(token);
		this.configUpdateCount = this.configUpdateTokens.size;
		if (this.configUpdateCount === 0) this.btwThread?.drainQueue?.();
		if (
			this.configUpdateCount === 0 &&
			!this.flushingDeferredLocalSlashCommands &&
			!this.sessionSwitchInProgress &&
			!this.selectionActionInProgress &&
			!this.menuHandle &&
			(this.deferredLocalSlashCommands?.length ?? 0) > 0
		) {
			void this.flushDeferredLocalSlashCommands().then(() => this.schedulePromptQueueDrain());
			return;
		}
		this.schedulePromptQueueDrain();
	}

	clearConfigUpdates() {
		this.configUpdateTokens?.clear();
		this.configUpdateCount = 0;
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

	async ensureConnected(options = {}) {
		if (this.ready && this.client && !this.client.exited) return true;
		if (this.client?.exited) this.ready = false;
		const context = this.captureActiveAgentContext();
		await this.switchAgent(context.key, context.transport, {
			quiet: true,
			statusState: options.statusState ?? "connecting",
			continueSessionSwitch: options.continueSessionSwitch === true,
			preserveDeferredCommands: this.flushingDeferredLocalSlashCommands === true,
		});
		return Boolean(this.isActiveAgentContext(context) && this.ready && this.client && !this.client.exited);
	}

	showHelp() {
		const sideCommands =
			this.focusedThread === "btw" && this.btwThread?.commandsLoaded
				? this.btwThread.availableCommands
				: undefined;
		const commands = dedupeCommands([
			...localSlashCommands(this),
			...(sideCommands ?? this.availableCommands.get(this.activeKey) ?? []),
		]);
		const lines = commands.map((command) => {
			const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
			const desc = command.description ? `  ${command.description}` : "";
			const prefix = command.name.startsWith("$") ? "" : "/";
			return `${prefix}${command.name}${hint}${desc}`;
		});
		this.addNotice(lines.join("\n"));
	}

	showStatus() {
		const state = this.sessionStates.get(this.activeKey) ?? {};
		const model = currentConfigLabel(findConfigOption(state, "model")) ?? state.models?.currentModelId;
		const mode = currentConfigLabel(findConfigOption(state, "mode")) ?? state.modes?.currentModeId;
		const effort = currentConfigLabel(findConfigOption(state, "thought_level"));
		const fast = currentConfigLabel(findFastModeOption(state));
		const usage = state.sessionInfo?.usage;
		const parts = [
			`${this.config.agents[this.activeKey]?.label ?? this.activeKey}`,
			model ? `model ${model}` : undefined,
			mode ? `mode ${mode}` : undefined,
			effort ? `reasoning ${effort}` : undefined,
			fast ? `fast ${fast}` : undefined,
			formatUsageSummary(usage),
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

	async openGenericConfigDialog(argument = "", commandName = "config", commandOptions = {}) {
		const target = await this.prepareSessionConfigCommandTarget(commandName, argument, commandOptions.targetThread);
		if (!target) return;
		const options = (this.sessionStateForCommandTarget(target)?.configOptions ?? []).filter((option) => option?.id);
		if (options.length === 0) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, "This agent does not advertise configurable session options");
			return;
		}
		const [requested, ...valueParts] = splitCommandArguments(argument);
		if (requested) {
			const normalized = requested.toLowerCase();
			const option = options.find(
				(entry) =>
					entry.id === requested ||
					entry.category === requested ||
					String(entry.name ?? "").toLowerCase() === normalized,
			);
			if (!option) {
				this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
				this.addSessionTargetNotice(target, `Unknown configuration option: ${requested}`);
				return;
			}
			const valueArgument = valueParts.join(" ");
			await this.openConfigOptionDialog(option, valueArgument, commandName, [requested, valueArgument].filter(Boolean).join(" "), { target });
			return;
		}
		const entries = options.map((option) => ({
			value: option,
			label: option.name ?? option.id,
			description: [currentConfigLabel(option) ? `Current: ${currentConfigLabel(option)}` : "", option.description]
				.filter(Boolean)
				.join(" · ") || undefined,
		}));
		this.openSelection("Session configuration", entries, async (entry) => {
			this.closeMenu();
			if (!entry?.value) return;
			if (target.targetThread && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName);
				return;
			}
			await this.openConfigOptionDialog(entry.value, "", commandName, "", { target });
		});
	}

	async openFastModeDialog(argument = "", commandName = "fast", commandOptions = {}) {
		const target = await this.prepareSessionConfigCommandTarget(commandName, argument, commandOptions.targetThread);
		if (!target) return;
		const option = findFastModeOption(this.sessionStateForCommandTarget(target));
		if (!option) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, "Fast mode is not advertised for the selected model");
			return;
		}
		if (!argument) {
			const values = flattenConfigOptions(option);
			const current = values.find((entry) => entry.value === option.currentValue);
			const currentBoolean = booleanLikeConfigValue(current ?? { value: option.currentValue });
			const other = currentBoolean !== undefined && values.length === 2 && values.every((entry) => booleanLikeConfigValue(entry) !== undefined)
				? values.find((entry) => booleanLikeConfigValue(entry) !== currentBoolean)
				: undefined;
			if (current && other) {
				await this.setConfigValueForCommandTarget(target, option, other.value, other.name, {
					displayText: slashPromptDisplay(`/${commandName}`, other.name),
					commandName,
				});
				return;
			}
		}
		await this.openConfigOptionDialog(option, argument, commandName, argument, { target });
	}

	async openConfigOptionDialog(option, argument = "", commandName = "config", displayArgument = argument, commandOptions = {}) {
		const target = commandOptions.target ?? this.captureSessionCommandTarget();
		const values = flattenConfigOptions(option);
		if (values.length === 0) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, `${option.name ?? option.id} has no supported values`);
			return;
		}
		if (argument) {
			const match = findConfigValue(option, argument);
			if (!match) {
				this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
				this.addSessionTargetNotice(target, `Unknown ${String(option.name ?? option.id).toLowerCase()} value: ${argument}`);
				return;
			}
			await this.setConfigValueForCommandTarget(target, option, match.value, match.name, {
				displayText: slashPromptDisplay(slashCommandText(commandName, displayArgument), match.name),
				commandName,
			});
			return;
		}
		const entries = values.map((value) => ({
			value: value.value,
			label: value.name,
			description: value.description,
			active: value.value === option.currentValue,
		}));
		this.openSelection(option.name ?? option.id, entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			if (target.targetThread && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName);
				return;
			}
			await this.setConfigValueForCommandTarget(target, option, entry.value, entry.label, {
				displayText: slashPromptDisplay(`/${commandName}`, entry.label),
				commandName,
			});
		});
	}

	async setConfigValueForCommandTarget(target, option, value, label = value, options = {}) {
		if (target?.targetThread) {
			if (!this.isSessionCommandTargetActive(target)) return false;
			const changed = await this.setSideThreadConfigValue(target, option, value, options);
			if (!changed && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(options.commandName ?? option?.category ?? option?.id ?? "config");
			}
			return changed;
		}
		return await this.setConfigValue(option, value, label, options);
	}

	async openDeleteDialog(argument = "", commandName = "delete", options = {}) {
		if (this.replacementProcessFence) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.reportReplacementProcessFence();
			return;
		}
		const targetThread = options.targetThread;
		// Deletion can remove the main session, the side session, or a shared native
		// ancestor of either one. Never mutate storage while either ACP process is in
		// a turn, regardless of which pane submitted the command.
		if (this.busy || this.btwThread?.busy) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice("A session cannot be deleted while a turn is running");
			return;
		}
		const requestedAgentContext = this.captureActiveAgentContext();
		let requestedTarget = this.captureSessionCommandTarget(targetThread);
		if (targetThread && !this.isSessionCommandTargetActive(requestedTarget)) {
			this.reportClosedSessionCommandTarget(commandName, argument);
			return;
		}
		if (!targetThread && (!this.client || this.client.exited)) {
			await this.switchAgent(this.activeKey, this.transport, { quiet: true, statusState: "connecting" });
			if (!this.isActiveAgentContext(requestedAgentContext)) return;
			requestedTarget = this.captureSessionCommandTarget();
		}
		if (!this.isSessionCommandTargetActive(requestedTarget)) return;
		const currentId = requestedTarget.sessionId;
		const targetId = argument.trim() || currentId;
		if (!targetId) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(targetThread ? "The /btw session is not ready to delete" : "There is no active session to delete");
			return;
		}
		const isCodex = this.isCodexAcpActive() || this.activeKey === "codex";
		const supportsDelete = Boolean(requestedTarget.client?.capabilities?.sessionCapabilities?.delete);
		if (!isCodex && !supportsDelete) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice("This agent does not advertise session deletion");
			return;
		}
		const entries = [
			{
				value: "delete",
				label: "Delete permanently",
				description: isCodex
					? "Removes the transcript and descendant sessions; this cannot be undone"
					: "Requests permanent deletion from the active ACP agent",
			},
			{ value: "cancel", label: "Cancel" },
		];
		this.openSelection(`Delete session ${singleLineMenuText(targetId)}?`, entries, async (entry) => {
			this.closeMenu();
			if (entry?.value !== "delete") return;
			await this.deleteSessionPermanently(targetId, {
				commandName,
				current: sameSessionId(targetId, currentId),
				codex: isCodex,
				targetThread,
			});
		});
	}

	async deleteSessionPermanently(sessionId, options = {}) {
		const commandName = options.commandName ?? "delete";
		if (this.replacementProcessFence) {
			this.addCommandMessage(slashCommandText(commandName, sessionId));
			this.reportReplacementProcessFence();
			return;
		}
		const requestedTarget = options.targetThread
			? this.captureSessionCommandTarget(options.targetThread)
			: { client: this.client, sessionId: this.client?.sessionId };
		if (options.targetThread && !this.isSessionCommandTargetActive(requestedTarget)) {
			this.reportClosedSessionCommandTarget(commandName, sameSessionId(sessionId, requestedTarget.sessionId) ? "" : sessionId);
			return;
		}
		const displayText = slashCommandText(commandName, sameSessionId(sessionId, requestedTarget.sessionId) ? "" : sessionId);
		this.addCommandMessage(displayText);
		if (this.busy || this.btwThread?.busy) {
			this.addNotice("A session cannot be deleted while a turn is running");
			return;
		}
		if (this.sessionSwitchInProgress) {
			this.addNotice("A session transition is already in progress");
			return;
		}
		const operationKey = this.activeKey;
		const operationTransport = this.transport;
		const operationClient = this.client;
		const targetClient = requestedTarget.client ?? operationClient;
		const agent = this.config?.agents?.[operationKey] ?? {};
		this.statusState = "deleting session";
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		let stoppedSessionId;
		let deletingMain = false;
		let deletingSide = false;
		let mainStopStarted = false;
		let mutationAttempted = false;
		let transitionSettled = false;
		const deletedSessionIds = new Set();
		try {
			if (options.codex) {
					const invocation = resolveCodexInvocation(agent);
					if (!invocation) throw new Error("no compatible Codex CLI was found for permanent deletion");
					const targetId = await resolveCodexSessionTargetForCommand(sessionId, agent, targetClient);
					const releaseForkOperation = await acquireForkOperationLock({ operation: `delete ${targetId}` });
					try {
						if (this.activeKey !== operationKey || this.client !== operationClient) return;
						if (options.targetThread && this.btwThread !== options.targetThread) {
							throw new Error("the targeted /btw thread closed before deletion could start");
						}
						const owners = await this.resolveLiveNativeCodexDeletionOwners(
							targetId,
							invocation,
							agent,
							operationClient,
							this.btwThread,
						);
						if (this.activeKey !== operationKey || this.client !== operationClient) return;
						if (this.btwThread !== owners.sideThread) {
							throw new Error("the live /btw thread changed while deletion descendants were being checked");
						}
						if (this.busy || this.btwThread?.busy) {
							throw new Error("a session cannot be deleted while a turn is running");
						}
						deletingMain = owners.deletingMain;
						deletingSide = owners.deletingSide;
						const liveSideThread = owners.sideThread;
						// Every live owner in the native/copy deletion closure has its own ACP
						// process. Detach and prove those trees gone before touching any rollout.
						if (liveSideThread && (deletingMain || deletingSide)) {
							const sideClient = liveSideThread.client;
							this.closeBtw({ stop: false });
							await stopClientForNativeMutation(sideClient);
						}
						if (deletingMain) {
							this.ready = false;
							stoppedSessionId = operationClient?.sessionId;
							mainStopStarted = true;
							await stopClientForNativeMutation(operationClient);
						}
						// Copy-forks are standalone Codex threads. Remove the complete registered
						// subtree deepest-first, then the requested root; a child failure leaves
						// the root intact and its relationship retryable.
						for (const deletionId of owners.deletionIds) {
							if (!sameSessionId(deletionId, targetId)) {
								const presence = codexStoredSessionPresence(deletionId, agent);
								if (presence.status === "unknown") {
									throw new Error(`could not safely verify copy-fork ${deletionId}: ${presence.reason ?? "storage state is unknown"}`);
								}
								if (presence.status === "absent") {
									forgetForkIds(deletionId);
									continue;
								}
							}
							mutationAttempted = true;
							await this.runTrackedCodexCommand(invocation, ["delete", deletionId, "--force"], agent);
							deletedSessionIds.add(isUuid(deletionId) ? deletionId.toLowerCase() : deletionId);
							forgetForkIds(deletionId);
						}
					} finally {
						releaseForkOperation();
					}
				} else {
				let targetId = sessionId;
				// ACP deletion takes an opaque session id, while the command is also
				// useful with the human-readable titles shown by /resume. Resolve an
				// exact, unambiguous title through session/list when it is available.
				if (
					targetId !== targetClient?.sessionId &&
					targetClient?.capabilities?.sessionCapabilities?.list &&
					typeof targetClient.listSessions === "function"
				) {
					const sessions = await targetClient.listSessions();
					const idMatch = sessions.find((session) => session?.sessionId === targetId);
					if (!idMatch) {
						const normalizedTitle = singleLineMenuText(targetId);
						const titleMatches = sessions.filter(
							(session) => singleLineMenuText(session?.title ?? "") === normalizedTitle,
						);
						if (titleMatches.length > 1) {
							throw new Error(`more than one session is named ${normalizedTitle}; use its session id to disambiguate`);
						}
						if (titleMatches.length === 1) targetId = titleMatches[0].sessionId;
					}
				}
				if (options.targetThread && this.btwThread !== options.targetThread) {
					throw new Error("the targeted /btw thread closed before deletion could start");
				}
				if (this.busy || this.btwThread?.busy) {
					throw new Error("a session cannot be deleted while a turn is running");
				}
				const liveSideThread = this.btwThread;
				const liveSideId = liveSideThread?.sessionId ?? liveSideThread?.client?.sessionId;
				deletingMain = sameSessionId(targetId, operationClient?.sessionId);
				deletingSide = Boolean(liveSideThread && sameSessionId(targetId, liveSideId));
				const deletionClient = deletingMain
					? operationClient
					: deletingSide
						? liveSideThread.client
						: targetClient;
				mutationAttempted = true;
				await deletionClient.deleteSession(targetId);
				if (deletingSide && this.btwThread === liveSideThread) this.closeBtw();
			}
			if (this.activeKey !== operationKey || this.client !== operationClient) return;
			this.addNotice(`Deleted session ${singleLineMenuText(sessionId)}.`);
			if (deletingMain) {
				this.resetConversationView();
				await this.switchAgent(operationKey, operationTransport, {
					quiet: true,
					statusState: "starting new session",
					continueSessionSwitch: true,
				});
				transitionSettled = this.ready;
				stoppedSessionId = undefined;
			} else {
				transitionSettled = this.client === operationClient && this.ready;
			}
		} catch (error) {
			if (this.activeKey !== operationKey || this.client !== operationClient) return;
			if (isProcessTreeTerminationFailure(error)) {
				this.recordReplacementProcessFence(error, { preserveReady: !mainStopStarted });
				this.reportReplacementProcessFence();
				// Liveness was not confirmed after SIGKILL. Starting a replacement here
				// could put two backends on the same session files, so leave this client
				// terminal and let the transition finalizer restore queued input.
				if (mainStopStarted) {
					this.ready = false;
					stoppedSessionId = undefined;
				} else {
					// The failed tree was the detached side process; the main client was
					// never stopped and remains safe to use because no mutation was run.
					transitionSettled = this.ready;
				}
			} else if (stoppedSessionId) {
				const canonicalStoppedId = isUuid(stoppedSessionId) ? stoppedSessionId.toLowerCase() : stoppedSessionId;
				if (deletedSessionIds.has(canonicalStoppedId)) {
					// A later member of the requested deletion closure failed after the live
					// main copy was already removed. Its transcript cannot be reloaded.
					this.ready = false;
					await this.switchAgent(operationKey, operationTransport, {
						quiet: true,
						statusState: "starting new session",
						continueSessionSwitch: true,
					});
					if (this.ready) this.resetConversationView();
				} else {
					await this.reloadSessionAfterMutationFailure(stoppedSessionId, displayText);
				}
				transitionSettled = this.ready;
				stoppedSessionId = undefined;
			} else if (deletingMain && mutationAttempted) {
				// An ACP delete is allowed to tear down its in-memory session before it
				// mutates persistent storage. Claude does exactly that, so an I/O failure
				// can leave the old client connected but unable to accept another prompt.
				// Reload the transcript only when that separately negotiated capability is
				// present. A delete-only backend cannot restore the torn-down session, so
				// reconnect it to a usable fresh session instead of sending an unsupported
				// session/resume request.
				this.ready = false;
				const canReload = Boolean(
					operationClient?.capabilities?.loadSession ||
					operationClient?.capabilities?.sessionCapabilities?.resume,
				);
				if (canReload) {
					await this.reloadSessionAfterMutationFailure(operationClient?.sessionId ?? sessionId, displayText);
				} else {
					await this.switchAgent(operationKey, operationTransport, {
						quiet: true,
						statusState: "starting new session",
						continueSessionSwitch: true,
					});
					if (this.ready) {
						this.resetConversationView();
						this.addCommandMessage(displayText);
					}
				}
				transitionSettled = this.ready;
			} else if (!deletingMain && this.client === operationClient && this.ready) {
				// Deleting another session failed; the active session is unchanged.
				transitionSettled = true;
			}
			this.addError(`Could not delete session: ${error.message ?? error}`);
		} finally {
			if (this.activeKey === operationKey && this.sessionSwitchInProgress) {
				await this.settleDeferredBtwPrompts();
				this.sessionSwitchInProgress = false;
				if (transitionSettled && this.ready) {
					await this.flushDeferredLocalSlashCommands();
					this.schedulePromptQueueDrain();
				} else {
					this.restoreFailedSessionSwitchInput();
				}
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
		}
	}

	async runCodexSessionCommand(commandName, argument = "", options = {}) {
		if (this.replacementProcessFence) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.reportReplacementProcessFence();
			return;
		}
		if (this.activeKey !== "codex" && !this.isCodexAcpActive()) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`/${commandName} is a Codex session command`);
			return;
		}
		if (this.busy || this.btwThread?.busy) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`/${commandName} is unavailable while a turn is running`);
			return;
		}
		if (this.sessionSwitchInProgress) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice("A session transition is already in progress");
			return;
		}
		const requestedTarget = this.captureSessionCommandTarget(options.targetThread);
		if (options.targetThread && !this.isSessionCommandTargetActive(requestedTarget)) {
			this.reportClosedSessionCommandTarget(commandName, argument);
			return;
		}
		const target = argument.trim() || (commandName === "archive" ? requestedTarget.sessionId : "");
		if (!target) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`usage: /${commandName} <session-id-or-name>`);
			return;
		}
		const operationKey = this.activeKey;
		const operationTransport = this.transport;
		const operationClient = this.client;
		const targetClient = requestedTarget.client ?? operationClient;
		const agent = this.config.agents[operationKey];
		const invocation = resolveCodexInvocation(agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required for archive operations");
			return;
		}
		const displayText = slashCommandText(commandName, argument);
		this.addCommandMessage(displayText);
		this.statusState = `${commandName} session`;
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		let stoppedSessionId;
		let isMain = false;
		let isSide = false;
		let mainStopStarted = false;
		let transitionSettled = false;
		try {
			const targetId = await resolveCodexSessionTargetForCommand(target, agent, targetClient, {
				archived: commandName === "unarchive",
			});
			if (this.activeKey !== operationKey || this.client !== operationClient) return;
			if (options.targetThread && this.btwThread !== options.targetThread) {
				throw new Error(`the targeted /btw thread closed before ${commandName} could start`);
			}
			if (this.busy || this.btwThread?.busy) {
				throw new Error(`/${commandName} is unavailable while a turn is running`);
			}
			isMain = sameSessionId(targetId, operationClient?.sessionId);
			const liveSideThread = this.btwThread;
			const liveSideId = liveSideThread?.sessionId ?? liveSideThread?.client?.sessionId;
			isSide = Boolean(liveSideThread && sameSessionId(targetId, liveSideId));
			if (liveSideThread && (isMain || isSide)) {
				const sideClient = liveSideThread.client;
				this.closeBtw({ stop: false });
				await stopClientForNativeMutation(sideClient);
			}
			if (isMain) {
				this.ready = false;
				stoppedSessionId = operationClient?.sessionId;
				mainStopStarted = true;
				await stopClientForNativeMutation(operationClient);
			}
			await this.runTrackedCodexCommand(invocation, [commandName, targetId], agent);
			if (this.activeKey !== operationKey || this.client !== operationClient) return;
			this.addNotice(`${commandName === "archive" ? "Archived" : "Restored"} session ${singleLineMenuText(target)}.`);
			if (isMain) {
				this.resetConversationView();
				await this.switchAgent(operationKey, operationTransport, {
					quiet: true,
					statusState: "starting new session",
					continueSessionSwitch: true,
				});
				transitionSettled = this.ready;
				stoppedSessionId = undefined;
			} else {
				transitionSettled = this.client === operationClient && this.ready;
			}
		} catch (error) {
			if (this.activeKey !== operationKey || this.client !== operationClient) return;
			if (isProcessTreeTerminationFailure(error)) {
				this.recordReplacementProcessFence(error, { preserveReady: !mainStopStarted });
				this.reportReplacementProcessFence();
				// Do not recover into a possibly live predecessor. Preserve the failed
				// command/input in the composer and require an explicit fresh start.
				if (mainStopStarted) {
					this.ready = false;
					stoppedSessionId = undefined;
				} else {
					transitionSettled = this.ready;
				}
			} else if (stoppedSessionId) {
				await this.reloadSessionAfterMutationFailure(stoppedSessionId, displayText);
				transitionSettled = this.ready;
				stoppedSessionId = undefined;
			} else if (!isMain && this.client === operationClient && this.ready) {
				transitionSettled = true;
			}
			this.addError(`Codex ${commandName} failed: ${error.message ?? error}`);
		} finally {
			if (this.activeKey === operationKey && this.sessionSwitchInProgress) {
				await this.settleDeferredBtwPrompts();
				this.sessionSwitchInProgress = false;
				if (transitionSettled && this.ready) {
					await this.flushDeferredLocalSlashCommands();
					this.schedulePromptQueueDrain();
				} else {
					this.restoreFailedSessionSwitchInput();
				}
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
		}
	}

	async reloadSessionAfterMutationFailure(sessionId, displayText) {
		await this.switchAgent(this.activeKey, this.transport, {
			quiet: true,
			statusState: "reloading session",
			loadSessionId: sessionId,
			continueSessionSwitch: true,
			beforeSessionReplay: () => this.resetConversationView(),
		});
		this.addCommandMessage(displayText);
	}

	async openAuthenticationDialog(argument = "", commandName = "login") {
		if (this.busy) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice("Authentication is unavailable while a turn is running");
			return;
		}
		const requestedKey = this.activeKey;
		const requestedContext = this.captureActiveAgentContext();
		while (!this.ready) {
			const pendingConnection = this.connectionAttempt;
			if (!pendingConnection || pendingConnection.client !== this.client) break;
			await pendingConnection.promise;
			if (this.activeKey !== requestedKey) return;
			if (this.sessionSwitchInProgress) {
				this.deferLocalSlashCommand(commandName, argument);
				return;
			}
		}
		if (this.sessionSwitchInProgress) {
			this.deferLocalSlashCommand(commandName, argument);
			return;
		}
		if (
			!this.client ||
			this.client.exited ||
			(!this.ready && (this.client.authMethods?.length ?? 0) === 0)
		) {
			await this.switchAgent(this.activeKey, this.transport, { quiet: true, statusState: "connecting" });
		}
		if (!this.isActiveAgentContext(requestedContext)) return;
		const methods = this.client?.authMethods ?? [];
		if (methods.length === 0) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice("This agent does not advertise authentication methods");
			return;
		}
		if (argument) {
			const normalized = argument.trim().toLowerCase();
			const method = methods.find((entry) => entry.id === argument.trim() || String(entry.name ?? "").toLowerCase() === normalized);
			if (!method) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`Unknown authentication method: ${argument}`);
				return;
			}
			await this.authenticateWithMethod(method, commandName);
			return;
		}
		const entries = methods.map((method) => ({
			value: method,
			label: method.name ?? method.id,
			description:
				method?.type !== "env_var" &&
				method.id === "api-key" &&
				this.isCodexBackendActive() &&
				!hasConfiguredCodexApiKey(this.config?.agents?.[this.activeKey])
					? "Set CODEX_API_KEY or OPENAI_API_KEY before choosing this method"
					: method.description,
		}));
		this.openSelection("Authenticate", entries, async (entry) => {
			this.closeMenu();
			if (entry?.value) await this.authenticateWithMethod(entry.value, commandName);
		});
	}

	async authenticateWithMethod(method, commandName = "login", options = {}) {
		const methodLabel = method?.name ?? method?.id ?? "authentication";
		if (this.busy) {
			this.addCommandMessage(slashPromptDisplay(`/${commandName}`, methodLabel));
			this.addNotice("Authentication is unavailable while a turn is running");
			return;
		}
		if (this.sessionSwitchInProgress) {
			this.addCommandMessage(slashPromptDisplay(`/${commandName}`, methodLabel));
			this.addNotice("Authentication is unavailable while a session transition is in progress");
			return;
		}
		if (
			method?.type !== "terminal" &&
			method?.type !== "env_var" &&
			method.id === "api-key" &&
			this.isCodexBackendActive() &&
			!hasConfiguredCodexApiKey(this.config?.agents?.[this.activeKey])
		) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice("Set CODEX_API_KEY or OPENAI_API_KEY, then run /login api-key again");
			return;
		}
		const transitionKey = this.activeKey;
		const client = this.client;
		this.sessionSwitchInProgress = true;
		try {
			if (method?.type === "terminal") {
				await this.authenticateWithTerminalMethod(method, commandName, {
					...options,
					continueSessionSwitch: true,
				});
				return;
			}
			if (method?.type === "env_var") {
				await this.authenticateWithEnvironmentMethod(method, commandName, {
					...options,
					continueSessionSwitch: true,
				});
				return;
			}
			this.addCommandMessage(slashPromptDisplay(`/${commandName}`, methodLabel));
			this.statusState = "authenticating";
			this.updateSpinner();
			this.ui.requestRender();
			const authenticationMeta =
				method.id === "api-key" && this.isCodexAcpActive()
					? codexApiKeyAuthenticationMeta(this.config.agents[transitionKey])
					: undefined;
			await client.authenticate(method.id, authenticationMeta);
			if (this.client !== client || this.activeKey !== transitionKey) return;
			// A successful, explicit /login authorizes configured credentials again.
			// /logout masks those values for future child processes so an ambient key
			// cannot silently sign the user straight back in; do not lift that mask for
			// a failed or stale authentication attempt.
			clearSignedOutAuthenticationEnvironment(this.config?.agents?.[transitionKey]);
			if (!client.sessionId) await client.newSession();
			if (this.client !== client || this.activeKey !== transitionKey) return;
			this.ready = true;
			this.updateAutocomplete();
			this.addNotice(`Authenticated with ${methodLabel}.`);
		} catch (error) {
			if (this.client === client && this.activeKey === transitionKey) {
				this.ready = Boolean(client?.sessionId && !client.exited);
				this.addError(`Authentication failed: ${error.message ?? error}`);
			}
		} finally {
			// Terminal/env-var methods reconnect with continueSessionSwitch=true, so
			// the same owner applies commands queued during authentication before it
			// lets any queued prompt run. An unrelated replacement owns its own state.
			if (this.activeKey !== transitionKey || !this.sessionSwitchInProgress) return;
			await this.settleDeferredBtwPrompts();
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			if (this.ready) {
				await this.flushDeferredLocalSlashCommands();
				this.schedulePromptQueueDrain();
			} else {
				this.restoreFailedSessionSwitchInput();
			}
		}
	}

	async authenticateWithEnvironmentMethod(method, commandName = "login", options = {}) {
		const authenticationKey = this.activeKey;
		const authenticationTransport = this.transport;
		const authenticationAgent = this.config.agents[authenticationKey];
		this.addCommandMessage(slashPromptDisplay(`/${commandName}`, method.name ?? method.id));
		this.statusState = "collecting credentials";
		this.updateSpinner();
		this.ui.requestRender();
		let credentials;
		let suspended = false;
		try {
			this.statusState = "";
			this.updateSpinner();
			suspended = true;
			this.ui.stop();
			const collect = options.collectEnvironmentVariables ?? collectEnvironmentAuthenticationVariables;
			// Do not treat a prior session-only credential as configured input. If it
			// failed authentication, the next /login must prompt so the user can
			// replace it without restarting cc.
			credentials = await collect(method, configuredAgentEnvironment(authenticationAgent));
		} catch (error) {
			this.addError(`Authentication failed: ${error.message ?? error}`);
		} finally {
			if (suspended && !this.stopping) {
				this.ui.start();
				this.ui.requestRender(true);
			}
		}
		if (!credentials) return;
		if (
			this.stopping ||
			this.activeKey !== authenticationKey ||
			this.transport !== authenticationTransport ||
			this.config.agents[authenticationKey] !== authenticationAgent
		) return;

		// ACP env_var authentication is completed by restarting the agent with the
		// supplied variables. Keep them on the in-memory launch spec only: they are
		// neither copied into process.env nor persisted to cc settings.
		authenticationAgent._sessionAuthEnv = { ...credentials };
		await this.switchAgent(authenticationKey, authenticationTransport, {
			quiet: true,
			statusState: "connecting",
			continueSessionSwitch: options.continueSessionSwitch === true,
		});
		if (
			this.activeKey !== authenticationKey ||
			this.transport !== authenticationTransport ||
			this.config.agents[authenticationKey] !== authenticationAgent
		) return;
		if (this.ready) {
			clearSignedOutAuthenticationEnvironment(authenticationAgent);
			this.addNotice(`Authenticated with ${method.name ?? method.id}.`);
		}
		else this.addNotice("Credentials were supplied, but the agent still requires sign-in.");
		this.ui.requestRender();
	}

	async authenticateWithTerminalMethod(method, commandName = "login", options = {}) {
		const authenticationKey = this.activeKey;
		const authenticationTransport = this.transport;
		const authenticationAgent = this.config.agents[authenticationKey];
		this.addCommandMessage(slashPromptDisplay(`/${commandName}`, method.name ?? method.id));
		this.statusState = "opening authentication terminal";
		this.updateSpinner();
		this.ui.requestRender();
		let authenticated = false;
		let suspended = false;
		try {
			// Terminal auth owns the real terminal. Release raw mode and all TUI input
			// listeners before giving the configured agent process inherited stdio.
			this.statusState = "";
			this.updateSpinner();
			suspended = true;
			this.ui.stop();
			const runner = options.runTerminalAuthentication ?? runTerminalAuthentication;
			await runner(
				authenticationAgent,
				method,
				this.trackedNativeProcessOptions({ terminationGraceMs: options.terminationGraceMs }),
			);
			authenticated = true;
		} catch (error) {
			this.addError(`Authentication failed: ${error.message ?? error}`);
		} finally {
			if (suspended && !this.stopping) {
				this.ui.start();
				// Authentication output may have moved the hardware cursor arbitrarily;
				// discard the diff renderer's old coordinates and repaint from scratch.
				this.ui.requestRender(true);
			}
		}
		if (!authenticated) return;

		// Terminal methods authenticate by running the agent binary; they are not
		// sent through the ACP authenticate request. Reconnect so the agent reads
		// the new credentials and creates a session under that identity. A prior
		// env-var login is session-only and would otherwise override credentials the
		// terminal flow just persisted in the replacement process.
		delete authenticationAgent._sessionAuthEnv;
		clearSignedOutAuthenticationEnvironment(authenticationAgent);
		// A lifecycle turn that was already queued can replace the active harness
		// while the real terminal is owned by the login process. Clear the credentials
		// on the agent that actually authenticated, but never reconnect or mutate the
		// now-active, unrelated harness.
		if (
			this.stopping ||
			this.activeKey !== authenticationKey ||
			this.transport !== authenticationTransport ||
			this.config.agents[authenticationKey] !== authenticationAgent
		) return;
		await this.switchAgent(authenticationKey, authenticationTransport, {
			quiet: true,
			statusState: "connecting",
			continueSessionSwitch: options.continueSessionSwitch === true,
		});
		if (
			this.activeKey !== authenticationKey ||
			this.transport !== authenticationTransport ||
			this.config.agents[authenticationKey] !== authenticationAgent
		) return;
		if (this.ready) this.addNotice(`Authenticated with ${method.name ?? method.id}.`);
		else this.addNotice("Authentication finished, but the agent still requires sign-in.");
		this.ui.requestRender();
	}

	async logoutActiveAgent(commandName = "logout") {
		this.addCommandMessage(`/${commandName}`);
		if (this.busy) {
			this.addNotice("Logout is unavailable while a turn is running");
			return;
		}
		if (this.sessionSwitchInProgress) {
			this.addNotice("Logout is unavailable while a session transition is in progress");
			return;
		}
		if (!this.client || this.client.exited) {
			this.addNotice("The active agent is not connected");
			return;
		}
		if (!agentSupportsLogout(this.client.capabilities)) {
			this.addNotice("This agent does not advertise logout support");
			return;
		}
		const client = this.client;
		const transitionKey = this.activeKey;
		const agent = this.config.agents[transitionKey];
		const authenticationEnvironmentNames = signedOutAuthenticationEnvironmentNames(
			client.authMethods,
			agent,
		);
		this.sessionSwitchInProgress = true;
		this.statusState = "signing out";
		this.updateSpinner();
		this.ui.requestRender();
		let signedOut = false;
		try {
			await client.logout();
			if (this.client !== client || this.activeKey !== transitionKey) return;
			signedOut = true;
			maskSignedOutAuthenticationEnvironment(agent, authenticationEnvironmentNames);
			// /btw owns a separate authenticated ACP process. Keep it intact when the
			// logout RPC fails, but close it after success so it cannot keep prompting
			// under credentials the main session just signed out from.
			const btwClient = this.btwThread?.client;
			if (this.btwThread) this.closeBtw({ stop: false });
			delete agent._sessionAuthEnv;
			this.ready = false;
			await stopClientsForReplacement([client, btwClient]);
			this.addNotice("Signed out. Run /login to authenticate again.");
		} catch (error) {
			if (this.client === client && this.activeKey === transitionKey) {
				this.ready = signedOut ? false : this.ready && !client.exited;
				if (signedOut && this.recordReplacementProcessFence(error)) {
					this.reportReplacementProcessFence();
				} else {
					this.addError(
						signedOut
							? `Signed out, but could not confirm backend shutdown: ${error.message ?? error}`
							: `Logout failed: ${error.message ?? error}`,
					);
				}
			}
		} finally {
			if (this.client !== client || this.activeKey !== transitionKey || !this.sessionSwitchInProgress) return;
			await this.settleDeferredBtwPrompts();
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			if (this.ready) {
				await this.flushDeferredLocalSlashCommands();
				this.schedulePromptQueueDrain();
			} else {
				this.restoreFailedSessionSwitchInput();
			}
			this.ui.requestRender();
		}
	}

	async openPluginsDialog(argument = "", commandName = "plugins") {
		if (!this.requireActiveCodex(commandName, argument)) return;
		if (this.busy || (this.asyncPickerLoadCount ?? 0) > 0) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(this.busy ? "Plugin management is unavailable while a turn is running" : "Another picker is still loading");
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addError("A compatible Codex CLI is required for plugin management");
			return;
		}
		const args = splitCommandArguments(argument);
		if (args[0] === "marketplace") {
			await this.runPluginMarketplaceCommand(invocation, args.slice(1), commandName, context);
			return;
		}
		if (args.length > 0 && ["add", "install", "remove"].includes(args[0])) {
			const action = args[0] === "install" ? "add" : args[0];
			const plugin = args.slice(1).join(" ").trim();
			if (!plugin) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`usage: /${commandName} ${args[0]} <plugin[@marketplace]>`);
				return;
			}
			await this.runPluginAction(invocation, action, plugin, commandName, context);
			return;
		}
		if (args.length > 0 && args[0] !== "list" && args[0] !== "refresh") {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`usage: /${commandName} [install|remove|refresh|marketplace]`);
			return;
		}
		this.addCommandMessage(slashCommandText(commandName, argument));
		const pickerLoad = this.beginAsyncPickerLoad();
		this.statusState = "loading plugins";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			if (args[0] === "refresh") {
				this.statusState = "refreshing plugin marketplaces";
				this.updateSpinner();
				await this.runTrackedCodexCommand(
					invocation,
					["plugin", "marketplace", "upgrade", "--json"],
					context.agent,
					{ timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS },
				);
				if (!this.isActiveAgentContext(context)) return;
				this.addNotice("Refreshed configured Git plugin marketplaces.");
				this.statusState = "loading plugins";
				this.updateSpinner();
			}
			const result = await this.runTrackedCodexCommand(
				invocation,
				["plugin", "list", "--available", "--json"],
				context.agent,
				{ timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS },
			);
			if (!this.isActiveAgentContext(context)) return;
			const catalog = JSON.parse(result.stdout.toString("utf8") || "{}");
			const installed = Array.isArray(catalog.installed) ? catalog.installed : [];
			const available = Array.isArray(catalog.available) ? catalog.available : [];
			const byId = new Map();
			for (const plugin of [...available, ...installed]) {
				const key = pluginSelector(plugin);
				if (key) byId.set(key, { ...byId.get(key), ...plugin });
			}
			const entries = [...byId.entries()].map(([selector, plugin]) => ({
				value: { selector, plugin },
				label: plugin.name ?? plugin.pluginId ?? selector,
				description: `${plugin.installed ? "Installed" : "Available"}${plugin.version ? ` · ${plugin.version}` : ""}${plugin.marketplaceName ? ` · ${plugin.marketplaceName}` : ""}`,
			}));
			if (entries.length === 0) {
				this.addNotice("No installed or discoverable Codex plugins were found.");
				return;
			}
			if (!this.canOpenAsyncPicker()) {
				this.addNotice("Plugin results are ready, but another interaction is active. Run /plugins again to open them.");
				return;
			}
			this.openSelection("Codex plugins", entries, (entry) => {
				if (!this.isActiveAgentContext(context)) return;
				this.closeMenu();
				if (!entry) return;
				const action = entry.value.plugin.installed ? "remove" : "add";
				const actionLabel = action === "add" ? "Install plugin" : "Remove plugin";
				this.openSelection(`${actionLabel}: ${entry.label}?`, [
					{ value: action, label: actionLabel },
					{ value: "cancel", label: "Cancel" },
				], async (confirmation) => {
					if (!this.isActiveAgentContext(context)) return;
					this.closeMenu();
					if (confirmation?.value === action) {
						await this.runPluginAction(invocation, action, entry.value.selector, commandName, context);
					}
				});
			});
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not load Codex plugins: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(pickerLoad);
		}
	}

	async runPluginAction(invocation, action, plugin, commandName = "plugins", context = this.captureActiveAgentContext()) {
		const operation = this.beginAsyncPickerLoad();
		this.addCommandMessage(`/${commandName} ${action === "add" ? "install" : "remove"} ${plugin}`);
		this.statusState = action === "add" ? "installing plugin" : "removing plugin";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.runTrackedCodexCommand(invocation, ["plugin", action, plugin, "--json"], context.agent, {
				timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS,
			});
			if (!this.isActiveAgentContext(context)) return;
			this.addNotice(`${action === "add" ? "Installed" : "Removed"} plugin ${singleLineMenuText(plugin)}. Start a new session to refresh skills and tools.`);
		} catch (error) {
			if (this.isActiveAgentContext(context)) {
				this.addError(`Plugin ${action === "add" ? "installation" : "removal"} failed: ${error.message ?? error}`);
			}
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runPluginMarketplaceCommand(invocation, args, commandName = "plugins", context = this.captureActiveAgentContext()) {
		const [action, ...actionArgs] = args;
		const supported = new Set(["list", "add", "upgrade", "remove"]);
		if (!supported.has(action) || (["add", "remove"].includes(action) && actionArgs.length === 0)) {
			this.addCommandMessage(formatCodexPluginMarketplaceCommandDisplay(args, commandName));
			this.addNotice(
				`usage: /${commandName} marketplace ` +
					"list|add <source> [--ref <ref>] [--sparse <path>]|upgrade [name]|remove <name>",
			);
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.addCommandMessage(formatCodexPluginMarketplaceCommandDisplay([action, ...actionArgs], commandName));
		this.statusState = action === "list" ? "loading plugin marketplaces" : `${action} plugin marketplace`;
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const cliArgs = ["plugin", "marketplace", action, ...actionArgs];
			if (!cliArgs.includes("--json")) cliArgs.push("--json");
			const result = await this.runTrackedCodexCommand(invocation, cliArgs, context.agent, {
				timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS,
			});
			if (!this.isActiveAgentContext(context)) return;
				if (action === "list") {
					const output = result.stdout.toString("utf8").trim() || '{"marketplaces":[]}';
					const catalog = JSON.parse(output);
					if (!Array.isArray(catalog.marketplaces) || catalog.marketplaces.length === 0) {
						this.addNotice("No plugin marketplaces are configured.");
					} else {
						// Marketplace sources may be authenticated Git URLs. Preserve the useful
						// catalog structure while stripping URL userinfo, secret query values, and
						// any explicitly sensitive fields before it reaches terminal scrollback.
						const safeCatalog = redactCodexMcpJson(catalog);
						this.showMarkdownBlock(`\`\`\`json\n${truncateDiff(JSON.stringify(safeCatalog, null, 2), 300)}\n\`\`\``);
					}
			} else {
				this.addNotice(`Plugin marketplace ${action} completed.`);
			}
		} catch (error) {
			if (this.isActiveAgentContext(context)) {
				this.addError(`Plugin marketplace ${action} failed: ${redactCodexPluginMarketplaceError(error, args)}`);
			}
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexHooksReport(argument = "", commandName = "hooks") {
		if (!this.requireActiveCodex(commandName, argument)) return;
		this.addCommandMessage(slashCommandText(commandName, argument));
		if (argument.trim()) {
			this.addNotice(`usage: /${commandName}`);
			return;
		}
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addNotice(this.busy || this.btwThread?.busy ? "Hook inspection is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required to inspect hooks");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		const cwd = path.resolve(process.cwd());
		this.statusState = "loading hooks";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [result] = await this.runFencedCodexAppServerRequests(invocation, [{
				method: "hooks/list",
				params: { cwds: [cwd] },
			}], context.agent);
			if (!this.isActiveAgentContext(context)) return;
			this.showMarkdownBlock(formatCodexHooksReport(result, cwd));
			this.addNotice(
				"Hook enablement and trust changes remain available only in the native Codex CLI; " +
				"the public app-server API does not expose a hook write method.",
			);
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not inspect Codex hooks: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexDesktopThread(argument = "", commandName = "app", options = {}) {
		// The deep link contains only a validated thread UUID. Never forward arbitrary
		// command text to the operating-system launcher.
		if (!this.requireActiveCodex(commandName)) return;
		if (argument.trim()) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(`usage: /${commandName}`);
			return;
		}
		const platform = this.platform ?? process.platform;
		if (!["darwin", "win32"].includes(platform)) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice("Codex Desktop handoff is available only on macOS and Windows");
			return;
		}
		const target = await this.prepareSessionConfigCommandTarget(commandName, "", options.targetThread);
		if (!target) return;
		if (!this.addSessionTargetCommand(target, `/${commandName}`)) return;
		const operation = this.beginAsyncPickerLoad();
		const wasTurning = this.busy || this.btwThread?.busy;
		if (!wasTurning) {
			this.statusState = "opening Codex Desktop";
			this.updateSpinner();
		}
		this.ui.requestRender();
		try {
			await this.runFencedCodexNativeOperation(() => launchCodexDesktopThread(target.sessionId, {
				platform,
				runCaptureImpl: (command, args, captureOptions) =>
					this.runTrackedCapture(command, args, captureOptions),
			}));
			if (this.isSessionCommandTargetActive(target)) {
				this.addSessionTargetNotice(target, "Opened this thread in Codex Desktop.");
			}
		} catch (error) {
			if (this.isSessionCommandTargetActive(target)) {
				this.addSessionTargetError(target, `Could not open Codex Desktop: ${oneLine(error.message ?? error)}`);
			}
		} finally {
			if (this.isActiveAgentContext(target.agentContext) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexApps(argument = "", commandName = "apps", options = {}) {
		if (!this.requireActiveCodex(commandName)) return;
		const action = argument.trim().toLowerCase();
		const safeCommand = `/${commandName}${action === "refresh" ? " refresh" : ""}`;
		if (action && action !== "refresh") {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(`usage: /${commandName} [refresh]`);
			return;
		}
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addCommandMessage(safeCommand);
			this.addNotice(this.busy || this.btwThread?.busy ? "App discovery is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const target = await this.prepareSessionConfigCommandTarget(commandName, "", options.targetThread);
		if (!target) return;
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addSessionTargetCommand(target, safeCommand);
			this.addSessionTargetNotice(target, this.busy || this.btwThread?.busy
				? "App discovery is unavailable while a turn is running"
				: "Another local operation is still running");
			return;
		}
		if (!this.addSessionTargetCommand(target, safeCommand)) return;
		const invocation = resolveCodexInvocation(target.agentContext.agent);
		if (!invocation) {
			this.addSessionTargetError(target, "A compatible Codex CLI is required to browse apps");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = action === "refresh" ? "refreshing Codex apps" : "loading Codex apps";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			// app/list rebuilds connector/MCP discovery inside each app-server
			// process, and its cursor is only an offset into that process's snapshot.
			// Request one bounded page so separate helper processes cannot skip or
			// duplicate apps. Omitting threadId also avoids loading the ACP-owned live
			// thread merely to derive configuration that is already present in env.
			const [page] = await this.runFencedCodexAppServerRequests(invocation, [{
				method: "app/list",
				params: {
					limit: CODEX_APPS_MAX_ENTRIES,
					...(action === "refresh" ? { forceRefetch: true } : {}),
				},
			}], target.agentContext.agent, {
				timeoutMs: CODEX_APPS_LIST_TIMEOUT_MS,
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					optOutNotificationMethods: ["app/list/updated"],
				},
			});
			if (!this.isSessionCommandTargetActive(target)) return;
			if (!page || !Array.isArray(page.data)) throw new Error("Codex app/list returned an invalid response");
			const apps = [];
			const seenIds = new Set();
			for (const app of page.data.slice(0, CODEX_APPS_MAX_ENTRIES)) {
				if (!app || typeof app.id !== "string" || !app.id || seenIds.has(app.id)) continue;
				seenIds.add(app.id);
				apps.push(app);
			}
			const truncated = page.data.length > CODEX_APPS_MAX_ENTRIES || Boolean(page.nextCursor);
			if (!this.isSessionCommandTargetActive(target)) return;
			if (apps.length === 0) {
				this.addSessionTargetNotice(target, "No Codex apps are available for this account and session.");
				return;
			}
			apps.sort((left, right) => {
				const leftReady = left.isAccessible === true && left.isEnabled !== false ? 0 : 1;
				const rightReady = right.isAccessible === true && right.isEnabled !== false ? 0 : 1;
				return leftReady - rightReady || String(left.name ?? left.id).localeCompare(String(right.name ?? right.id));
			});
			const entries = apps.map((app) => {
				const status = app.isEnabled === false
					? "disabled in Codex config"
					: app.isAccessible !== true
						? "not connected or unavailable"
						: "ready";
				const description = singleLineMenuText(app.description ?? "").slice(0, 300);
				return {
					value: app,
					label: singleLineMenuText(app.name ?? app.id).slice(0, 160) || "unnamed app",
					description: [status, description].filter(Boolean).join(" · "),
				};
			});
			this.openSelection(truncated ? "Codex apps (first 500)" : "Codex apps", entries, (entry) => {
				this.closeMenu();
				if (!entry?.value) return;
				if (!this.isSessionCommandTargetActive(target)) {
					if (target.targetThread) this.reportClosedSessionCommandTarget(commandName);
					else this.addNotice("App selection was cancelled because the active session changed");
					return;
				}
				const selected = entry.value;
				if (selected.isEnabled === false) {
					this.addSessionTargetNotice(target, "That app is disabled in Codex configuration.");
					return;
				}
				if (selected.isAccessible !== true) {
					this.addSessionTargetNotice(target, "That app is not connected or is unavailable for this account.");
					return;
				}
				let mention;
				try {
					mention = codexAppMention(selected.id, selected.name);
				} catch (error) {
					this.addSessionTargetError(target, error.message ?? "Codex returned an invalid app identifier");
					return;
				}
				const current = this.editor.getText();
				const next = current ? `${mention} ${current}` : `${mention} `;
				this.editor.setText(next);
				this.bindEditorToSideThread(target.targetThread);
				this.lastKnownEditorText = next;
				this.ui.requestRender();
			});
		} catch (error) {
			if (this.isSessionCommandTargetActive(target)) {
				const detail = singleLineMenuText(error.message ?? error).slice(0, 500) || "unknown error";
				this.addSessionTargetError(target, `Could not load Codex apps: ${detail}`);
			}
		} finally {
			if (this.isActiveAgentContext(target.agentContext) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexFeedback(argument = "", commandName = "feedback", options = {}) {
		// Feedback notes can contain sensitive context. This command deliberately
		// renders only the normalized category in conversation messages and errors.
		if (!this.requireActiveCodex(commandName)) return;
		let feedback;
		try {
			feedback = parseCodexFeedbackArgument(argument);
		} catch (error) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(error.message ?? `usage: /${commandName} [category] [note]`);
			return;
		}
		const category = feedback && CODEX_FEEDBACK_CATEGORIES.find(
			(entry) => entry.classification === feedback.classification,
		);
		const safeCommand = `/${commandName}${category ? ` ${category.commandValue}` : ""}`;
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addCommandMessage(safeCommand);
			this.addNotice(this.busy || this.btwThread?.busy ? "Feedback is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const target = await this.prepareSessionConfigCommandTarget(commandName, "", options.targetThread);
		if (!target) return;
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addSessionTargetCommand(target, safeCommand);
			this.addSessionTargetNotice(target, this.busy || this.btwThread?.busy
				? "Feedback is unavailable while a turn is running"
				: "Another local operation is still running");
			return;
		}
		if (!feedback) {
			if (!this.addSessionTargetCommand(target, `/${commandName}`)) return;
			this.openSelection("Feedback category", CODEX_FEEDBACK_CATEGORIES.map((entry) => ({
				value: entry,
				label: entry.label,
				description: entry.description,
			})), (entry) => {
				this.closeMenu();
				if (!entry?.value) return;
				if (!this.isSessionCommandTargetActive(target)) {
					if (target.targetThread) this.reportClosedSessionCommandTarget(commandName);
					else this.addNotice("Feedback was cancelled because the active session changed");
					return;
				}
				const prefix = `/${commandName} ${entry.value.commandValue} `;
				this.editor.setText(prefix);
				this.bindEditorToSideThread(target.targetThread);
				this.lastKnownEditorText = prefix;
				this.ui.requestRender();
			});
			return;
		}
		if (!category || !this.addSessionTargetCommand(target, safeCommand)) return;
		const invocation = resolveCodexInvocation(target.agentContext.agent);
		if (!invocation) {
			this.addSessionTargetError(target, "A compatible Codex CLI is required to send feedback");
			return;
		}
		this.openSelection("Attach Codex diagnostics to this feedback?", [
			{
				value: "without-logs",
				label: "Send without logs",
				description: "Sends the category, note, thread ID, and basic metadata only.",
			},
			{
				value: "with-logs",
				label: "Include logs and send",
				description: "Also sends Codex logs, transcripts, and diagnostics for this report.",
			},
			{ value: "cancel", label: "Cancel" },
		], async (entry) => {
			this.closeMenu();
			if (!entry || entry.value === "cancel") return;
			if (!this.isSessionCommandTargetActive(target)) {
				if (target.targetThread) this.reportClosedSessionCommandTarget(commandName);
				else this.addNotice("Feedback was cancelled because the active session changed");
				return;
			}
			if (
				this.busy ||
				this.btwThread?.busy ||
				this.sessionSwitchInProgress ||
				(this.asyncPickerLoadCount ?? 0) > 0 ||
				(this.configUpdateCount ?? 0) > 0
			) {
				this.addSessionTargetNotice(target, "Feedback became unavailable before confirmation; run the command again");
				return;
			}
			await this.sendCodexFeedback(invocation, target, feedback, entry.value === "with-logs");
		});
	}

	async sendCodexFeedback(invocation, target, feedback, includeLogs) {
		if (!this.isSessionCommandTargetActive(target)) return;
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "sending feedback";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const params = codexFeedbackUploadParams({
				classification: feedback.classification,
				reason: feedback.reason,
				threadId: target.sessionId,
				includeLogs,
			});
			await this.runFencedCodexAppServerRequests(
				invocation,
				[{ method: "feedback/upload", params }],
				target.agentContext.agent,
				{
					sanitizeError: sanitizeCodexFeedbackOperationError,
					// A successful upload response is authoritative. Confirmed forceful
					// teardown cannot undo it and must not encourage a duplicate retry;
					// an unconfirmed process tree still raises the fatal shared fence.
					acceptForcedTeardownAfterResponse: true,
				},
			);
			if (this.isSessionCommandTargetActive(target)) {
				this.addSessionTargetNotice(target, `Feedback sent ${includeLogs ? "with" : "without"} Codex logs. Thank you.`);
			}
		} catch {
			// App-server errors are intentionally not rendered: an upstream error can
			// echo the submitted reason, which must not leak into the transcript.
			if (this.isSessionCommandTargetActive(target)) {
				this.addSessionTargetError(target, "Codex feedback could not be sent; no upload confirmation was received.");
			}
		} finally {
			if (this.isActiveAgentContext(target.agentContext) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexDebugConfig(argument = "", commandName = "debug-config", options = {}) {
		if (!this.requireActiveCodex(commandName, argument)) return;
		if (argument.trim()) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(`usage: /${commandName}`);
			return;
		}
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(this.busy || this.btwThread?.busy ? "Config inspection is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const target = await this.prepareSessionConfigCommandTarget(commandName, "", options.targetThread);
		if (!target || !this.addSessionTargetCommand(target, `/${commandName}`)) return;
		const invocation = resolveCodexInvocation(target.agentContext.agent);
		if (!invocation) {
			this.addSessionTargetError(target, "A compatible Codex CLI is required to inspect configuration");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "loading Codex configuration";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [configRead, requirementsRead] = await this.runFencedCodexAppServerRequests(
				invocation,
				[
					{ method: "config/read", params: { includeLayers: true, cwd: path.resolve(process.cwd()) } },
					{ method: "configRequirements/read" },
				],
				target.agentContext.agent,
				{
					capabilities: { experimentalApi: true },
					sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex config inspection failed"),
				},
			);
			if (!this.isSessionCommandTargetActive(target)) return;
			this.addSessionTargetNotice(target, formatCodexDebugConfig(configRead, requirementsRead));
		} catch (error) {
			if (this.isSessionCommandTargetActive(target)) {
				this.addSessionTargetError(target, "Could not inspect Codex configuration; no config values were displayed.");
			}
		} finally {
			if (this.isActiveAgentContext(target.agentContext) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexImport(argument = "", commandName = "import", options = {}) {
		const displayText = `/${commandName}`;
		if (options.targetThread) {
			const target = this.captureSessionCommandTarget(options.targetThread);
			if (!this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName, argument);
				return;
			}
			this.addSessionTargetCommand(target, displayText);
			this.addSessionTargetNotice(target, "/import changes shared Codex configuration and is available only from the main thread");
			return;
		}
		if (!this.requireActiveCodex(commandName, argument)) return;
		this.addCommandMessage(displayText);
		if (argument.trim()) {
			this.addNotice(`usage: /${commandName}`);
			return;
		}
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addNotice(this.busy || this.btwThread?.busy ? "Import is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required to import Claude Code configuration");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "detecting Claude Code configuration";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [response] = await this.runFencedCodexAppServerRequests(
				invocation,
				[{
					method: "externalAgentConfig/detect",
					params: { includeHome: true, cwds: [path.resolve(process.cwd())] },
				}],
				context.agent,
				{
					capabilities: { experimentalApi: true },
					sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex import detection failed"),
				},
			);
			if (!this.isActiveAgentContext(context)) return;
			const items = normalizeCodexImportDetection(response);
			if (items.length === 0) {
				this.addNotice("No Claude Code configuration or artifacts are available to import.");
				return;
			}
			if (!this.canOpenAsyncPicker()) {
				this.addNotice("Import results are ready, but another interaction is active. Run /import again to open them.");
				return;
			}
			const total = items.reduce((sum, item) => sum + codexImportItemCount(item), 0);
			const entries = items.length > 1
				? [{
					value: items,
					label: "Import everything detected",
					description: `${total} artifact${total === 1 ? "" : "s"} across ${items.length} groups`,
				}, ...items.map((item) => ({
					value: [item],
					label: singleLineMenuText(codexImportItemLabel(item)),
					description: singleLineMenuText(item.description).slice(0, 300),
				}))]
				: [{
					value: items,
					label: singleLineMenuText(codexImportItemLabel(items[0])),
					description: singleLineMenuText(items[0].description).slice(0, 300),
				}];
			this.openSelection("Import from Claude Code", entries, (entry) => {
				this.closeMenu();
				if (!entry?.value || !this.isActiveAgentContext(context)) return;
				this.confirmCodexImport(invocation, context, entry.value);
			});
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError("Could not detect Claude Code configuration; no config values were displayed.");
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	confirmCodexImport(invocation, context, items) {
		const total = items.reduce((sum, item) => sum + codexImportItemCount(item), 0);
		this.openSelection(`Import ${total} Claude Code artifact${total === 1 ? "" : "s"}?`, [
			{ value: "import", label: "Import", description: "Copies the selected artifacts into Codex configuration" },
			{ value: "cancel", label: "Cancel" },
		], async (entry) => {
			this.closeMenu();
			if (entry?.value !== "import" || !this.isActiveAgentContext(context)) return;
			if (this.busy || this.btwThread?.busy || this.sessionSwitchInProgress) {
				this.addNotice("Import became unavailable before confirmation; run /import again");
				return;
			}
			await this.executeCodexImport(invocation, context, items);
		});
	}

	async executeCodexImport(invocation, context, items) {
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "importing Claude Code configuration";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [, completion] = await this.runFencedCodexAppServerRequests(
				invocation,
				[{
					method: "externalAgentConfig/import",
					params: { migrationItems: items, source: "cc" },
				}],
				context.agent,
				{
					timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS,
					capabilities: {
						experimentalApi: true,
						optOutNotificationMethods: ["externalAgentConfig/import/progress"],
					},
					waitForNotification: {
						method: "externalAgentConfig/import/completed",
						matches: codexImportCompletionMatches,
					},
					acceptForcedTeardownAfterResponse: true,
					sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex import request failed"),
				},
			);
			if (!this.isActiveAgentContext(context)) return;
			let summary;
			try {
				summary = formatCodexImportCompletion(completion);
			} catch {
				summary = "Claude Code import completed, but result details could not be displayed.";
			}
			this.addNotice(summary);
			this.addNotice("Start a new session to load imported configuration, skills, plugins, hooks, and MCP servers.");
		} catch (error) {
			if (this.isActiveAgentContext(context)) {
				this.addError(error?.code === "CODEX_COMPLETION_UNCONFIRMED"
					? "Codex accepted the import, but completion could not be confirmed. Run /import again to re-detect what remains before deciding whether to retry."
					: "Claude Code import did not return a completion confirmation. Run /import again to re-detect what remains before retrying.");
			}
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openCodexMemories(argument = "", commandName = "memories", options = {}) {
		const displayText = slashCommandText(commandName, argument);
		if (options.targetThread) {
			const target = this.captureSessionCommandTarget(options.targetThread);
			if (!this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName, argument);
				return;
			}
			this.addSessionTargetCommand(target, displayText);
			this.addSessionTargetNotice(target, "/memories changes the persistent main task and is unavailable from /btw");
			return;
		}
		if (!this.requireActiveCodex(commandName, argument)) return;
		let action;
		try {
			action = parseCodexMemoryCommand(argument);
		} catch (error) {
			this.addCommandMessage(displayText);
			this.addNotice(error.message ?? "Invalid memory command");
			return;
		}
		if (this.busy || this.btwThread?.busy) {
			this.addCommandMessage(displayText);
			this.addNotice("Memory settings cannot change while a turn is running");
			return;
		}
		if (this.btwThread && action.action !== "status") {
			this.addCommandMessage(displayText);
			this.addNotice("Close the /btw thread before changing task memory settings");
			return;
		}
		if (
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0 ||
			this.permissionPromptActive ||
			this.menuHandle
		) {
			this.addCommandMessage(displayText);
			this.addNotice("Another local or session operation is still running");
			return;
		}
		const target = await this.prepareSessionConfigCommandTarget(commandName);
		if (!target || !this.addSessionTargetCommand(target, displayText)) return;
		const context = this.captureActiveAgentContext({ includeClient: true });
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required to manage memories");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "loading memory settings";
		this.updateSpinner();
		this.ui.requestRender();
		let current;
		try {
			const [response] = await this.runFencedCodexAppServerRequests(
				invocation,
				[{ method: "config/read", params: { cwd: path.resolve(process.cwd()) } }],
				context.agent,
				{ sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex memory request failed") },
			);
			if (!this.isActiveAgentContext(context)) return;
			current = codexMemorySettingsFromConfigRead(response);
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not load Codex memory settings: ${oneLine(error.message ?? error)}`);
			return;
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
		if (!current || !this.isActiveAgentContext(context)) return;
		if (action.action === "status") {
			this.addNotice(this.codexMemoryStatusText(current));
			return;
		}
		if (action.action === "menu") {
			this.openCodexMemoryMenu(invocation, context, current, commandName);
			return;
		}
		if (action.action === "reset") {
			this.openSelection("Reset all Codex memories?", [
				{ value: "reset", label: "Reset all memories", description: "Deletes generated memory summaries for every task" },
				{ value: "cancel", label: "Cancel" },
			], async (entry) => {
				this.closeMenu();
				if (entry?.value !== "reset" || !this.isActiveAgentContext(context)) return;
				await this.executeCodexMemoryMutation(invocation, context, current, action, displayText);
			});
			return;
		}
		await this.executeCodexMemoryMutation(invocation, context, current, action, displayText);
	}

	codexMemoryStatusText(settings) {
		return [
			"Codex memories:",
			`  feature: ${settings.featureEnabled ? "enabled" : "disabled"}`,
			`  use memories: ${settings.useMemories ? "on" : "off"}`,
			`  generate memories: ${settings.generateMemories ? "on" : "off"}`,
		].join("\n");
	}

	openCodexMemoryMenu(invocation, context, current, commandName) {
		const entries = [];
		if (!current.featureEnabled) {
			entries.push({ value: { action: "settings", enableFeature: true }, label: "Enable memories", description: "Enables the feature and reloads this task" });
		}
		entries.push(
			{
				value: { action: "settings", enableFeature: !current.useMemories ? true : undefined, useMemories: !current.useMemories },
				label: `${current.useMemories ? "Disable" : "Enable"} using memories`,
				description: current.useMemories ? "Stops applying saved memories to future turns" : "Applies relevant saved memories to future turns",
			},
			{
				value: { action: "settings", enableFeature: !current.generateMemories ? true : undefined, generateMemories: !current.generateMemories },
				label: `${current.generateMemories ? "Disable" : "Enable"} generating memories`,
				description: current.generateMemories ? "Stops this task from generating memories" : "Allows this task to generate memory summaries",
			},
			{ value: { action: "reset" }, label: "Reset all memories", description: "Deletes generated memory summaries for every task" },
		);
		this.openSelection("Codex memories", entries, async (entry) => {
			this.closeMenu();
			if (!entry?.value || !this.isActiveAgentContext(context)) return;
			const action = entry.value;
			const displayText = action.action === "reset"
				? `/${commandName} reset`
				: `/${commandName}${Object.hasOwn(action, "useMemories")
					? ` use ${action.useMemories ? "on" : "off"}`
					: Object.hasOwn(action, "generateMemories")
						? ` generate ${action.generateMemories ? "on" : "off"}`
						: " enable"}`;
			if (action.action === "reset") {
				this.openSelection("Reset all Codex memories?", [
					{ value: "reset", label: "Reset all memories" },
					{ value: "cancel", label: "Cancel" },
				], async (confirmation) => {
					this.closeMenu();
					if (confirmation?.value === "reset" && this.isActiveAgentContext(context)) {
						await this.executeCodexMemoryMutation(invocation, context, current, action, displayText);
					}
				});
				return;
			}
			await this.executeCodexMemoryMutation(invocation, context, current, action, displayText);
		});
	}

	async executeCodexMemoryMutation(invocation, context, current, action, displayText) {
		if (!this.isActiveAgentContext(context)) return;
		if (this.replacementProcessFence) {
			this.reportReplacementProcessFence();
			return;
		}
		if (
			this.busy ||
			this.btwThread ||
			this.btwShutdownTail ||
			this.agentSwitchTail ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0 ||
			this.permissionPromptActive ||
			this.menuHandle ||
			this.flushingPromptQueue ||
			this.stopping
		) {
			this.addNotice("Another local or session operation is still running; the memory update was not started");
			return;
		}
		const client = context.client;
		const agentContext = {
			key: context.key,
			agent: context.agent,
			transport: context.transport,
			generation: context.generation,
		};
		const sessionId = client?.sessionId;
		if (!client || !sessionId || client.exited || !this.ready) {
			this.addNotice("The active Codex session is not ready for a memory update");
			return;
		}
		let configRequest;
		const reset = action.action === "reset";
		const explicitGenerate = typeof action.generateMemories === "boolean";
		let next = current;
		try {
			if (!reset) {
				const batch = codexMemoryConfigBatchParams(current, action);
				next = {
					featureEnabled: action.enableFeature === true ? true : current.featureEnabled,
					useMemories: typeof action.useMemories === "boolean" ? action.useMemories : current.useMemories,
					generateMemories: typeof action.generateMemories === "boolean" ? action.generateMemories : current.generateMemories,
				};
				if (batch.edits.length > 0) configRequest = { method: "config/batchWrite", params: batch };
			}
		} catch (error) {
			this.addError(`Could not prepare memory update: ${error.message ?? error}`);
			return;
		}
		if (!reset && !configRequest && !explicitGenerate) {
			this.addNotice("Codex memory settings are already in that state.");
			return;
		}

		this.clearConfigUpdates();
		this.sessionSwitchInProgress = true;
		this.statusState = action.action === "reset" ? "resetting memories" : "updating memories";
		this.updateSpinner();
		this.ui.requestRender();
		let releaseForkOperation;
		let stopStarted = false;
		let transitionSettled = false;
		let configWriteConfirmed = false;
		let effectiveResolved = !configRequest;
		let threadModeConfirmed = false;
		let resetConfirmed = false;
		let overridden = false;
		try {
			releaseForkOperation = await acquireForkOperationLock({ operation: `memory update ${sessionId}` });
			if (!this.isActiveAgentContext(context)) return;
			if (this.replacementProcessFence) {
				this.reportReplacementProcessFence();
				return;
			}
			if (
				this.busy ||
				this.btwThread ||
				this.btwShutdownTail ||
				this.agentSwitchTail ||
				(this.asyncPickerLoadCount ?? 0) > 0 ||
				(this.configUpdateCount ?? 0) > 0 ||
				this.permissionPromptActive ||
				this.menuHandle ||
				this.flushingPromptQueue ||
				this.stopping ||
				this.client !== client ||
				client.exited ||
				!this.ready
			) throw new Error("another local or session operation started before the memory update");
			this.ready = false;
			stopStarted = true;
			await stopClientForNativeMutation(client);
			if (reset) {
				await this.runFencedCodexAppServerRequests(invocation, [{ method: "memory/reset" }], context.agent, {
					capabilities: { experimentalApi: true },
					acceptForcedTeardownAfterResponse: true,
					sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex memory request failed"),
				});
				resetConfirmed = true;
			} else {
				if (configRequest) {
					const [writeResponse] = await this.runFencedCodexAppServerRequests(
						invocation,
						[configRequest],
						context.agent,
						{
							acceptForcedTeardownAfterResponse: true,
							sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex memory request failed"),
						},
					);
					const write = codexMemoryWriteStatus(writeResponse);
					configWriteConfirmed = true;
					overridden = write.overridden;
					if (write.overridden) {
						const [effectiveResponse] = await this.runFencedCodexAppServerRequests(
							invocation,
							[{ method: "config/read", params: { cwd: path.resolve(process.cwd()) } }],
							context.agent,
							{ sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex memory request failed") },
						);
						next = codexMemorySettingsFromConfigRead(effectiveResponse, current);
					}
					effectiveResolved = true;
				}
				if (explicitGenerate) {
					// Always reapply an explicitly requested generation mode, even when
					// config/read already showed that value. This makes a retry repair a
					// prior partial failure after the global write was committed.
					await this.runFencedCodexAppServerRequests(
						invocation,
						[{
							method: "thread/memoryMode/set",
							params: codexThreadMemoryModeParams(sessionId, next.generateMemories),
						}],
						context.agent,
						{
							capabilities: { experimentalApi: true },
							acceptForcedTeardownAfterResponse: true,
							sanitizeError: (error) => sanitizeCodexSensitiveOperationError(error, "Codex memory request failed"),
						},
					);
					threadModeConfirmed = true;
				}
			}
			if (!this.isActiveAgentContext(context)) return;
			await this.switchAgent(context.key, context.transport, {
				quiet: true,
				statusState: "reloading task",
				loadSessionId: sessionId,
				continueSessionSwitch: true,
				beforeSessionReplay: () => this.resetConversationView(),
			});
			transitionSettled = this.ready;
			if (transitionSettled) {
				this.addCommandMessage(displayText);
				this.addNotice(action.action === "reset" ? "Reset all Codex memories." : this.codexMemoryStatusText(next));
				if (overridden) {
					this.addNotice("Memory changes were saved but overridden by a higher-precedence configuration layer.");
				}
			}
		} catch (error) {
			if (!this.isActiveAgentContext(agentContext)) return;
			if (isProcessTreeTerminationFailure(error)) {
				this.recordReplacementProcessFence(error, { preserveReady: !stopStarted });
				this.reportReplacementProcessFence();
			} else if (stopStarted) {
				await this.reloadSessionAfterMutationFailure(sessionId, displayText);
				transitionSettled = this.ready;
			}
			const detail = oneLine(error.message ?? error);
			if (resetConfirmed) {
				this.addError(`Codex memories were reset, but the task could not be reloaded: ${detail}`);
			} else if (threadModeConfirmed) {
				this.addError(`Codex memory settings and task mode were applied, but the task could not be reloaded: ${detail}`);
			} else if (configWriteConfirmed && explicitGenerate) {
				this.addError(`Codex memory settings were saved, but the current task mode was not synchronized: ${detail}. Re-run the same /memories generate command to repair it.`);
			} else if (configWriteConfirmed && !effectiveResolved) {
				this.addError(`Codex memory settings were saved, but their managed effective values could not be verified: ${detail}. Run /memories status before retrying.`);
			} else if (configWriteConfirmed) {
				this.addError(`Codex memory settings were saved, but the task could not be reloaded: ${detail}`);
			} else {
				this.addError(`Codex memory update failed: ${detail}`);
			}
		} finally {
			releaseForkOperation?.();
			if (this.activeKey === context.key && this.transport === context.transport && this.sessionSwitchInProgress) {
				await this.settleDeferredBtwPrompts();
				this.sessionSwitchInProgress = false;
				if (transitionSettled && this.ready) {
					await this.flushDeferredLocalSlashCommands();
					this.schedulePromptQueueDrain();
				} else {
					this.restoreFailedSessionSwitchInput();
				}
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
		}
	}

	async runCodexMcpManagement(argument = "", commandName = "mcp") {
		const args = splitCommandArguments(argument);
		const displayText = formatCodexMcpCommandDisplay(args, commandName);
		const safeArgument = displayText.slice(`/${commandName}`.length).trim();
		if (!this.requireActiveCodex(commandName, safeArgument)) return;
		const action = args[0]?.toLowerCase();
		if (!isCodexMcpManagementAction(action)) {
			this.addCommandMessage(displayText);
			this.addNotice(`usage: /${commandName} list|get|add|remove|login|logout [arguments]`);
			return;
		}
		if (
			this.busy ||
			this.btwThread?.busy ||
			this.sessionSwitchInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0
		) {
			this.addCommandMessage(displayText);
			this.addNotice(this.busy || this.btwThread?.busy ? "MCP management is unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const actionArgs = args.slice(1);
		if (action !== "list" && !actionArgs[0]) {
			this.addCommandMessage(displayText);
			this.addNotice(`usage: /${commandName} ${action} <server> [arguments]`);
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addCommandMessage(displayText);
			this.addError("A compatible Codex CLI is required for MCP management");
			return;
		}
		this.addCommandMessage(displayText);
		if (action === "remove" || action === "logout") {
			const server = singleLineMenuText(actionArgs[0]);
			const label = action === "remove" ? "Remove MCP server" : "Log out of MCP server";
			this.openSelection(`${label} ${server}?`, [
				{ value: action, label },
				{ value: "cancel", label: "Cancel" },
			], async (entry) => {
				if (!this.isActiveAgentContext(context)) return;
				this.closeMenu();
				if (entry?.value !== action) return;
				if (this.busy || this.btwThread?.busy || this.sessionSwitchInProgress) {
					this.addNotice("MCP management became unavailable before confirmation; run the command again");
					return;
				}
				await this.executeCodexMcpManagement(invocation, args, commandName, context);
			});
			return;
		}
		await this.executeCodexMcpManagement(invocation, args, commandName, context);
	}

	async executeCodexMcpManagement(
		invocation,
		args,
		commandName = "mcp",
		context = this.captureActiveAgentContext(),
	) {
		const action = args[0]?.toLowerCase();
		const server = singleLineMenuText(args[1] ?? "");
		if (
			["add", "remove", "login", "logout"].includes(action) &&
			(this.busy || this.btwThread?.busy || this.sessionSwitchInProgress)
		) {
			this.addNotice("MCP management is unavailable while a turn is running");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = action === "login" ? "waiting for MCP login" : `${action} MCP configuration`;
		this.updateSpinner();
		this.ui.requestRender();
		if (action === "login") this.addNotice("Codex may open a browser to authorize this MCP server.");
		const cliArgs = codexMcpCliArguments(args);
		try {
			const result = await this.runTrackedCodexCommand(invocation, cliArgs, context.agent, {
				timeoutMs: action === "login" ? CODEX_MCP_AUTH_TIMEOUT_MS : CODEX_COMMAND_TIMEOUT_MS,
				maxStdoutBytes: CODEX_MCP_OUTPUT_MAX_BYTES,
				maxStderrBytes: CODEX_MCP_STDERR_MAX_BYTES,
			});
			if (!this.isActiveAgentContext(context)) return;
			if (action === "list" || action === "get") {
				if (result.stdoutTruncated) throw new Error("Codex MCP JSON output exceeded the safety limit");
				const output = result.stdout.toString("utf8").trim();
				if (!output) {
					this.addNotice(action === "list" ? "No MCP servers are configured." : `Codex returned no configuration for ${server}.`);
					return;
				}
				let parsed;
				try {
					parsed = JSON.parse(output);
				} catch {
					throw new Error("Codex returned invalid MCP JSON");
				}
				const catalog = redactCodexMcpJson(parsed);
				this.showMarkdownBlock(`\`\`\`json\n${truncateDiff(JSON.stringify(catalog, null, 2), CODEX_MCP_REPORT_MAX_LINES)}\n\`\`\``);
				return;
			}
			const target = server ? ` ${server}` : "";
			this.addNotice(`Codex MCP ${action} completed${target}. Run /new to refresh MCP tools in the live session.`);
		} catch (error) {
			if (this.isActiveAgentContext(context)) {
				this.addError(`Codex MCP ${action ?? "management"} failed: ${redactCodexMcpError(error, args)}`);
			}
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runCodexDoctor(commandName = "doctor") {
		if (!this.requireActiveCodex(commandName)) return;
		if (this.busy || (this.asyncPickerLoadCount ?? 0) > 0) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(this.busy ? "Diagnostics are unavailable while a turn is running" : "Another local operation is still running");
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		this.addCommandMessage(`/${commandName}`);
		if (!invocation) {
			this.addError("A compatible Codex CLI was not found");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "running diagnostics";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const result = await this.runTrackedCodexCommand(
				invocation,
				["doctor", "--summary", "--no-color", "--ascii"],
				context.agent,
				{ rejectOnExit: false },
			);
			if (!this.isActiveAgentContext(context)) return;
			const stdout = result.stdout.toString("utf8").trim();
			if (stdout) this.showMarkdownBlock(`\`\`\`text\n${truncateDiff(stdout, 300)}\n\`\`\``);
			if (result.code !== 0) {
				const details = result.stderr.toString("utf8").trim();
				this.addError(`Codex doctor exited ${result.signal ?? result.code}${details ? `: ${oneLine(details)}` : ""}`);
			} else if (!stdout) {
				this.addNotice("Codex doctor completed without output");
			}
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Codex doctor failed: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async openExperimentalFeatures(argument = "", commandName = "experimental") {
		if (!this.requireActiveCodex(commandName, argument)) return;
		if (this.busy || (this.asyncPickerLoadCount ?? 0) > 0) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(this.busy ? "Feature management is unavailable while a turn is running" : "Another picker is still loading");
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addError("A compatible Codex CLI is required to manage feature flags");
			return;
		}
		const args = splitCommandArguments(argument);
		if (args.length > 0 && ["enable", "disable"].includes(args[0])) {
			if (!args[1]) {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice(`usage: /${commandName} ${args[0]} <feature>`);
				return;
			}
			await this.setExperimentalFeature(invocation, args[0], args[1], commandName, context);
			return;
		}
		if (args.length > 0) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`usage: /${commandName} [enable|disable] [feature]`);
			return;
		}
		this.addCommandMessage(`/${commandName}`);
		const pickerLoad = this.beginAsyncPickerLoad();
		this.statusState = "loading feature flags";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const result = await this.runTrackedCodexCommand(invocation, ["features", "list"], context.agent);
			if (!this.isActiveAgentContext(context)) return;
			const features = result.stdout
				.toString("utf8")
				.split("\n")
				.map(parseCodexFeatureLine)
				.filter((feature) => feature && !["removed", "deprecated"].includes(feature.stage));
			const entries = features.map((feature) => ({
				value: feature,
				label: feature.name,
				description: `${feature.enabled ? "Enabled" : "Disabled"} · ${feature.stage}`,
				active: feature.enabled,
			}));
			if (!this.canOpenAsyncPicker()) {
				this.addNotice("Feature results are ready, but another interaction is active. Run /experimental again to open them.");
				return;
			}
			this.openSelection("Codex feature flags", entries, (entry) => {
				if (!this.isActiveAgentContext(context)) return;
				this.closeMenu();
				if (!entry) return;
				const action = entry.value.enabled ? "disable" : "enable";
				this.openSelection(`${action === "enable" ? "Enable" : "Disable"} ${entry.value.name}?`, [
					{ value: action, label: action === "enable" ? "Enable feature" : "Disable feature" },
					{ value: "cancel", label: "Cancel" },
				], async (confirmation) => {
					if (!this.isActiveAgentContext(context)) return;
					this.closeMenu();
					if (confirmation?.value === action) {
						await this.setExperimentalFeature(invocation, action, entry.value.name, commandName, context);
					}
				});
			}, { emptyText: "No configurable features" });
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not load Codex feature flags: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(pickerLoad);
		}
	}

	async setExperimentalFeature(invocation, action, feature, commandName = "experimental", context = this.captureActiveAgentContext()) {
		const operation = this.beginAsyncPickerLoad();
		this.addCommandMessage(`/${commandName} ${action} ${feature}`);
		this.statusState = `${action === "enable" ? "enabling" : "disabling"} feature`;
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.runTrackedCodexCommand(invocation, ["features", action, feature], context.agent);
			if (!this.isActiveAgentContext(context)) return;
			this.addNotice(`${action === "enable" ? "Enabled" : "Disabled"} ${feature}. Restart the Codex backend if the feature requires it.`);
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not ${action} ${feature}: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runInitCommand(commandName = "init") {
		await this.submitBackendPrompt(
			"Create or improve an AGENTS.md file in the current directory. Capture durable repository conventions, important commands, verification steps, and review expectations. Inspect the repository first, keep the guidance concise and accurate, and do not overwrite useful existing instructions.",
			{ displayText: `/${commandName}`, compactCommand: true },
		);
	}

	async renameCodexSession(argument = "", commandName = "rename", options = {}) {
		if (!this.requireActiveCodex(commandName, argument)) return;
		let target = this.captureSessionCommandTarget(options.targetThread);
		if (options.targetThread && !this.isSessionCommandTargetActive(target)) {
			this.reportClosedSessionCommandTarget(commandName, argument);
			return;
		}
		const name = singleLineMenuText(argument).trim();
		if (!name) {
			this.addSessionTargetCommand(target, `/${commandName}`);
			this.addSessionTargetNotice(target, `usage: /${commandName} <name>`);
			return;
		}
		if (name.length > 1_000) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, "Session names must be at most 1,000 characters");
			return;
		}
		if (!options.targetThread && (!this.ready || !this.client || this.client.exited)) {
			const connected = await this.ensureConnected();
			if (!connected) return;
			target = this.captureSessionCommandTarget();
		}
		const context = target.agentContext;
		const sessionId = target.sessionId;
		const invocation = resolveCodexInvocation(context.agent);
		this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
		if (!sessionId) {
			this.addSessionTargetNotice(target, options.targetThread ? "The /btw session is not ready to rename" : "There is no active Codex session to rename");
			return;
		}
		if (!invocation) {
			this.addSessionTargetError(target, "A compatible Codex CLI is required to rename sessions");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "renaming session";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await this.runFencedCodexAppServerRequests(invocation, [{ method: "thread/name/set", params: { threadId: sessionId, name } }], context.agent);
			if (!this.isSessionCommandTargetActive(target)) return;
			target.client.sessionInfo = { ...(target.client.sessionInfo ?? {}), title: name };
			if (!target.targetThread) {
				const previous = this.sessionStates.get(this.activeKey) ?? {};
				this.sessionStates.set(this.activeKey, {
					...previous,
					title: name,
					sessionInfo: { ...(previous.sessionInfo ?? {}), title: name },
				});
			}
			this.addSessionTargetNotice(target, `Renamed this${target.targetThread ? " /btw" : ""} session to ${name}.`);
		} catch (error) {
			if (this.isSessionCommandTargetActive(target)) this.addSessionTargetError(target, `Could not rename session: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runCodexUsage(argument = "", commandName = "usage") {
		if (!this.requireActiveCodex(commandName, argument)) return;
		const action = oneLine(argument).trim().toLowerCase();
		if (action === "reset") {
			this.addCommandMessage(slashCommandText(commandName, argument));
			const context = this.captureActiveAgentContext();
			this.openSelection("Use one earned rate-limit reset credit?", [
				{ value: "reset", label: "Use reset credit", description: "Resets eligible Codex rate-limit windows" },
				{ value: "cancel", label: "Cancel" },
			], async (entry) => {
				this.closeMenu();
				if (entry?.value === "reset" && this.isActiveAgentContext(context)) await this.consumeCodexUsageReset(context);
			});
			return;
		}
		if (action) {
			this.addCommandMessage(slashCommandText(commandName, argument));
			this.addNotice(`usage: /${commandName} [reset]`);
			return;
		}
		const context = this.captureActiveAgentContext();
		const invocation = resolveCodexInvocation(context.agent);
		this.addCommandMessage(`/${commandName}`);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required to read account usage");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "loading account usage";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [usage] = await this.runFencedCodexAppServerRequests(invocation, [{ method: "account/usage/read" }], context.agent);
			if (!this.isActiveAgentContext(context)) return;
			let rateLimits = {};
			try {
				[rateLimits] = await this.runFencedCodexAppServerRequests(invocation, [{ method: "account/rateLimits/read" }], context.agent);
			} catch (error) {
				if (this.isActiveAgentContext(context)) this.addNotice(`Historical usage loaded, but rate limits were unavailable: ${error.message ?? error}`);
			}
			if (!this.isActiveAgentContext(context)) return;
			this.showMarkdownBlock(formatCodexAccountUsage(usage, rateLimits));
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not read Codex account usage: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async consumeCodexUsageReset(context = this.captureActiveAgentContext()) {
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required to use a reset credit");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "using reset credit";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [result] = await this.runFencedCodexAppServerRequests(invocation, [{
				method: "account/rateLimitResetCredit/consume",
				params: { idempotencyKey: randomUUID() },
			}], context.agent, {
				// A response confirms that the earned credit was consumed. If the
				// short-lived app-server then needs a forceful, but confirmed, tree
				// teardown, surface that response instead of inviting a retry with a
				// fresh idempotency key (and potentially consuming a second credit).
				acceptForcedTeardownAfterResponse: true,
			});
			if (!this.isActiveAgentContext(context)) return;
			this.addNotice(formatResetCreditOutcome(result?.outcome));
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Could not use reset credit: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runCodexGoalView(argument = "", commandName = "goal", options = {}) {
		if (!this.requireActiveCodex(commandName, argument)) return;
		let target = this.captureSessionCommandTarget(options.targetThread);
		if (options.targetThread && !this.isSessionCommandTargetActive(target)) {
			this.reportClosedSessionCommandTarget(commandName, argument);
			return;
		}
		if (!options.targetThread && (!this.ready || !this.client || this.client.exited)) {
			const connected = await this.ensureConnected();
			if (!connected) return;
			target = this.captureSessionCommandTarget();
		}
		const action = argument.trim().toLowerCase();
		const editorTextBeforeLoad = this.editor.getText();
		const context = target.agentContext;
		const sessionId = target.sessionId;
		const invocation = resolveCodexInvocation(context.agent);
		this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
		if (!sessionId || !invocation) {
			this.addSessionTargetError(target, !sessionId ? "There is no active Codex session" : "A compatible Codex CLI is required to read goals");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = "loading goal";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const [result] = await this.runFencedCodexAppServerRequests(invocation, [{ method: "thread/goal/get", params: { threadId: sessionId } }], context.agent);
			if (!this.isSessionCommandTargetActive(target)) return;
			const goal = result?.goal;
			if (!goal) {
				this.addSessionTargetNotice(target, "No goal is set for this session. Use /goal <objective> to create one.");
			} else if (action === "edit") {
				const prefix = "/goal ";
				if (this.editor.getText() === editorTextBeforeLoad) {
					this.editor.setText(`${prefix}${goal.objective ?? ""}`);
					this.bindEditorToSideThread(target.targetThread);
					this.lastKnownEditorText = this.editor.getText();
				} else {
					this.addSessionTargetNotice(target, `Goal loaded without replacing newer input. Current objective: ${oneLine(goal.objective ?? "(untitled)")}`);
				}
			} else {
				this.addSessionTargetNotice(target, formatCodexGoal(goal));
			}
		} catch (error) {
			if (!this.isSessionCommandTargetActive(target)) return;
			const unmaterializedSession =
				isCodexGoalThreadNotFoundError(error, sessionId) &&
				codexGoalSessionIsUnmaterialized(sessionId, context.agent);
			if (unmaterializedSession) {
				this.addSessionTargetNotice(
					target,
					"No goal is set for this new session yet. Use /goal <objective> to create one, " +
						"or send a regular message first so Codex can save the session.",
				);
			} else {
				this.addSessionTargetError(target, `Could not read goal: ${error.message ?? error}`);
			}
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
	}

	async runCodexCloud(argument = "", commandName = "cloud") {
		if (!this.requireActiveCodex(commandName, argument)) return;
		const args = splitCommandArguments(argument);
		const subcommand = args[0];
		this.addCommandMessage(slashCommandText(commandName, argument));
		if (!subcommand || !["list", "status", "diff", "apply", "exec"].includes(subcommand)) {
			this.addNotice(`usage: /${commandName} <list|status|diff|apply|exec> [arguments]`);
			return;
		}
		if (subcommand === "apply" && (this.busy || this.btwThread?.busy)) {
			this.addNotice("Codex Cloud changes cannot be applied while a turn is running");
			return;
		}
		const context = this.captureActiveAgentContext();
		if (subcommand === "apply") {
			this.openSelection("Apply this Codex Cloud task diff to the working tree?", [
				{ value: "apply", label: "Apply changes", description: "Modifies files in the current working tree" },
				{ value: "cancel", label: "Cancel" },
			], async (entry) => {
				this.closeMenu();
				if (entry?.value !== "apply" || !this.isActiveAgentContext(context)) return;
				if (this.busy || this.btwThread?.busy) {
					this.addNotice("Codex Cloud changes cannot be applied while a turn is running");
					return;
				}
				await this.executeCodexCloud(args, context);
			});
			return;
		}
		await this.executeCodexCloud(args, context);
	}

	async executeCodexCloud(args, context = this.captureActiveAgentContext()) {
		// This method is also called by the confirmation callback and tests/helpers.
		// Keep the mutation gate at the actual execution boundary as well as at the
		// dialog boundary so no late main or side turn can race `cloud apply`.
		if (args[0] === "apply" && (this.busy || this.btwThread?.busy)) {
			this.addNotice("Codex Cloud changes cannot be applied while a turn is running");
			return;
		}
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addError("A compatible Codex CLI is required for Codex Cloud");
			return;
		}
		const operation = this.beginAsyncPickerLoad();
		this.statusState = `${args[0]} cloud task`;
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const result = await this.runTrackedCodexCommand(invocation, ["cloud", ...args], context.agent, {
				rejectOnExit: false,
				timeoutMs: CODEX_PLUGIN_COMMAND_TIMEOUT_MS,
				maxStdoutBytes: CODEX_CLOUD_OUTPUT_MAX_BYTES,
				maxStderrBytes: CODEX_CLOUD_STDERR_MAX_BYTES,
			});
			if (!this.isActiveAgentContext(context)) return;
			const stdout = result.stdout.toString("utf8").trim();
			const stderr = result.stderr.toString("utf8").trim();
			if (stdout) {
				const language = args[0] === "diff" ? "diff" : "text";
				this.showMarkdownBlock(`\`\`\`${language}\n${truncateDiff(stdout, 500)}\n\`\`\``);
			}
			if (result.code !== 0) this.addError(`Codex Cloud exited ${result.signal ?? result.code}${stderr ? `: ${oneLine(stderr)}` : ""}`);
			else if (!stdout) this.addNotice(`Codex Cloud ${args[0]} completed.`);
			if (result.stdoutTruncated || result.stderrTruncated) {
				const streams = [result.stdoutTruncated ? "stdout" : "", result.stderrTruncated ? "stderr" : ""].filter(Boolean).join(" and ");
				this.addNotice(`Additional Codex Cloud ${streams} was omitted because the output safety limit was reached.`);
			}
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(`Codex Cloud failed: ${error.message ?? error}`);
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(operation);
		}
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

	async forkCodexPersistentSession(argument = "", commandName = "fork", options = {}) {
		const displayText = slashCommandText(commandName, argument);
		const targetThread = options.targetThread ?? (
			this.focusedThread === "btw" && this.btwThread ? this.btwThread : undefined
		);
		if (targetThread) {
			const target = this.captureSessionCommandTarget(targetThread);
			if (!this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName, argument);
				return;
			}
			this.addSessionTargetCommand(target, displayText);
			this.addSessionTargetNotice(target, "/fork changes the persistent main session and is unavailable from /btw");
			this.ui.requestRender();
			return;
		}
		if (!this.requireActiveCodex(commandName, argument)) return;
		if (this.busy || this.btwThread?.busy) {
			this.addCommandMessage(displayText);
			this.addNotice("A session cannot be forked while a turn is running");
			return;
		}
		const conflictingLocalOperation = () => Boolean(
			this.selectionActionInProgress ||
			(this.asyncPickerLoadCount ?? 0) > 0 ||
			(this.configUpdateCount ?? 0) > 0 ||
			(this.nativeProcessTracker?.entries?.size ?? 0) > 0 ||
			(this.flushingDeferredLocalSlashCommands && options.fromDeferredLocalSlashQueue !== true) ||
			this.permissionPromptActive ||
			this.menuHandle ||
			this.flushingPromptQueue ||
			this.btwShutdownTail ||
			(this.btwThread && this.btwThread.ready === false) ||
			this.btwThread?.configUpdateTail ||
			this.btwThread?.localCommandDrainActive
		);
		if (
			this.sessionSwitchInProgress ||
			conflictingLocalOperation()
		) {
			this.addCommandMessage(displayText);
			this.addNotice("Another local or session operation is still running");
			return;
		}
		const context = this.captureActiveAgentContext({ includeClient: true });
		const client = context.client;
		const parentSessionId = client?.sessionId;
		if (!client || !this.ready || client.exited || typeof client.loadSession !== "function" || !parentSessionId) {
			this.addCommandMessage(displayText);
			this.addNotice("The active Codex session is not ready to fork");
			return;
		}
		let params;
		try {
			params = codexPersistentForkParams(parentSessionId, argument || undefined);
		} catch (error) {
			this.addCommandMessage(displayText);
			this.addError(`Could not fork session: ${error.message ?? error}`);
			return;
		}
		const invocation = resolveCodexInvocation(context.agent);
		if (!invocation) {
			this.addCommandMessage(displayText);
			this.addError("A compatible Codex CLI is required to fork a persistent session");
			return;
		}

		// Own the transition before the first await. Inputs submitted from either
		// pane are now held until the fork either commits or the old session is known
		// to remain usable.
		this.addCommandMessage(displayText);
		this.clearConfigUpdates();
		this.sessionSwitchInProgress = true;
		this.statusState = "forking session";
		this.updateSpinner();
		this.ui.requestRender();
		let releaseForkOperation;
		let forked;
		let switched = false;
		try {
			releaseForkOperation = await acquireForkOperationLock({ operation: `persistent fork ${params.threadId}` });
			if (!this.isActiveAgentContext(context)) return;
			if (this.busy || this.btwThread?.busy || conflictingLocalOperation()) {
				throw new Error("a session cannot be forked while another turn or local operation is running");
			}
			const [response] = await this.runFencedCodexAppServerRequests(
				invocation,
				[{ method: "thread/fork", params }],
				context.agent,
				{
					// Once thread/fork has replied, its durable child is authoritative.
					// Confirmed forced teardown cannot undo it; an unconfirmed tree is
					// still promoted to the shared replacement fence by the wrapper.
					acceptForcedTeardownAfterResponse: true,
				},
			);
			if (!this.isActiveAgentContext(context)) return;
			forked = codexPersistentForkSession(response, params.threadId);
			try {
				recordForkId(forked.sessionId, params.threadId, { required: true });
			} catch (error) {
				throw new Error(
					`Codex created fork ${forked.sessionId}, but cc could not record its parent relation: ${error.message ?? error}`,
				);
			}
			if (!this.isActiveAgentContext(context)) return;
			if (this.busy || this.btwThread?.busy || conflictingLocalOperation()) {
				throw new Error("another turn or local operation started before the fork could be loaded");
			}
			await client.loadSession(forked.sessionId, {
				beforeReplay: () => {
					if (!this.isActiveAgentContext(context)) return;
					// Preserve the old main and its /btw page until ACP confirms the
					// child session. Replay then replaces the transcript atomically.
					if (this.btwThread) this.closeBtw();
					switched = true;
					this.resetConversationView();
					const title = singleLineMenuText(forked.title).slice(0, 160) || "Forked session";
					this.addCommandMessage(slashPromptDisplay(displayText, title));
					this.updateAutocomplete();
				},
			});
			if (!this.isActiveAgentContext(context)) return;
		} catch (error) {
			if (!this.isActiveAgentContext(context)) return;
			if (client.exited) this.ready = false;
			const prefix = forked
				? switched
					? `Fork ${forked.sessionId} loaded, but its session setup failed`
					: `Fork ${forked.sessionId} was created but could not be loaded`
				: "Could not fork session";
			this.addError(`${prefix}: ${error.message ?? error}`);
		} finally {
			releaseForkOperation?.();
			if (this.isActiveAgentContext(context) && this.sessionSwitchInProgress) {
				await this.settleDeferredBtwPrompts();
				if (client.exited) this.ready = false;
				const transitionUsable = Boolean(
					switched &&
					forked &&
					this.ready &&
					!client.exited &&
					sameSessionId(client.sessionId, forked.sessionId),
				);
				this.sessionSwitchInProgress = false;
				if (!transitionUsable) this.restoreFailedSessionSwitchInput();
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
				if (transitionUsable) {
					await this.flushDeferredLocalSlashCommands();
					this.schedulePromptQueueDrain();
				}
			}
		}
	}

	async openResumeDialog(commandName = "resume") {
		const requestedKey = this.activeKey;
		if (this.busy || (this.asyncPickerLoadCount ?? 0) > 0) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(this.busy ? "A session cannot be resumed while a turn is running" : "Another picker is still loading");
			return;
		}
		if (!this.client || !this.ready || this.client.exited) {
			const connected = await this.ensureConnected();
			if (!connected) return;
		}
		if (this.activeKey !== requestedKey) return;
		if (this.busy || this.sessionSwitchInProgress || (this.asyncPickerLoadCount ?? 0) > 0) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice(this.busy ? "A session cannot be resumed while a turn is running" : "Another session operation is active");
			return;
		}
		if (!supportsSessionList(this.sessionStates.get(this.activeKey))) {
			this.addCommandMessage(`/${commandName}`);
			this.addNotice("This agent does not advertise session listing");
			return;
		}
		const context = this.captureActiveAgentContext({ includeClient: true });
		const client = context.client;
		const pickerLoad = this.beginAsyncPickerLoad();
		this.statusState = "loading sessions";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			const codexEnvironment = mergedAgentEnvironment(context.agent);
			// codex-acp reads MODEL_PROVIDER at process launch and supplies it as the
			// preferred provider to thread/list. An unset value deliberately means all
			// providers, so mirror that distinction in the SQLite fast path.
			const preferredModelProvider = environmentValue(codexEnvironment, "MODEL_PROVIDER") || undefined;
			const localCodexSessions = this.isCodexAcpActive() || context.key === "codex"
				? listLocalCodexSessions(
						process.cwd(),
						codexStateDbPath(codexEnvironment),
						1_000,
						{ modelProvider: preferredModelProvider },
					)
				: undefined;
			// `[]` is an authoritative local-index answer for this cwd. Only fall
			// back to ACP when the index could not be queried at all (`undefined`),
			// otherwise large global histories make an empty picker needlessly slow.
			const sessions = localCodexSessions !== undefined ? localCodexSessions : await client.listSessions();
			if (!this.isActiveAgentContext(context)) return;
			const forkIds = loadForkIds();
			const entries = sessions.map((session) => {
				const title = singleLineMenuText(session.title) || singleLineMenuText(session.sessionId) || "unknown session";
				return {
					value: session.sessionId,
					// /btw forks inherit the parent's title; mark them so a resume list
					// of a parent + its fork(s) is distinguishable.
					label: forkIds.has(session.sessionId) ? `(fork) ${title}` : title,
					description: singleLineMenuText(
						session.updatedAt ? `${compactDate(session.updatedAt)} · ${compactPath(session.cwd)}` : compactPath(session.cwd),
					),
					active: session.sessionId === client.sessionId,
					session,
					};
				});
			if (!this.canOpenAsyncPicker()) {
				this.addNotice("Sessions are loaded, but another interaction is active. Run /resume again to open them.");
				return;
			}
			this.openSelection("Resume session", entries, async (entry) => {
				if (!this.isActiveAgentContext(context)) return;
				this.closeMenu();
				if (!entry) return;
				await this.resumeSelectedSession(entry.session, {
					displayText: slashPromptDisplay(`/${commandName}`, entry.label),
				});
			});
		} catch (error) {
			if (this.isActiveAgentContext(context)) this.addError(error.message ?? String(error));
		} finally {
			if (this.isActiveAgentContext(context) && !this.busy && !this.sessionSwitchInProgress) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endAsyncPickerLoad(pickerLoad);
		}
	}

	async resumeSelectedSession(session, options = {}) {
		if (!this.client) return;
		const title = singleLineMenuText(session.title) || singleLineMenuText(session.sessionId) || "unknown session";
		const displayText = options.displayText ?? slashPromptDisplay("/resume", title);
		if (this.busy) {
			this.addCommandMessage(displayText);
			this.addNotice("A session cannot be resumed while a turn is running");
			return;
		}
		if (session.sessionId === this.client.sessionId) {
			this.addCommandMessage(displayText);
			this.addNotice(`Already using ${title}`);
			return;
		}
		this.statusState = "resuming";
		// Guard the in-flight load like startNewSession does: until the new sessionId
		// is live, a prompt submitted mid-load would otherwise be sent against the
		// session being abandoned. The guard makes such a prompt queue and drain after.
		this.clearConfigUpdates();
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		const client = this.client;
		let switched = false;
		try {
			await client.loadSession(session.sessionId, {
				beforeReplay: () => {
					if (this.client !== client) return;
					// The fork belongs to the session being abandoned. Close it only
					// after load commits so a failed resume remains nondestructive.
					if (this.btwThread) this.closeBtw();
					switched = true;
					this.resetConversationView();
					this.addCommandMessage(displayText);
					this.updateAutocomplete();
				},
			});
			if (this.client !== client) return;
		} catch (error) {
			if (this.client !== client) return;
			if (client.exited) this.ready = false;
			this.addError(error.message ?? String(error));
		} finally {
			if (this.client !== client) return;
			await this.settleDeferredBtwPrompts();
			if (client.exited) this.ready = false;
			const transitionUsable = switched && this.ready && !client.exited;
			this.sessionSwitchInProgress = false;
			if (!transitionUsable) this.restoreFailedSessionSwitchInput();
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			if (transitionUsable) {
				// Commands and prompts entered during the transition belong to the
				// successfully loaded target session.
				await this.flushDeferredLocalSlashCommands();
				this.schedulePromptQueueDrain();
			}
		}
	}

	async startNewSession(commandName = "new", options = {}) {
		const displayText = slashPromptDisplay(`/${commandName}`, "New session");
		if (this.sessionSwitchInProgress && !options.afterTurn) {
			this.addNotice("Already starting a new session");
			this.ui.requestRender();
			return;
		}
		// A /btw fork is branched from the session we're about to replace.
		if (this.btwThread) this.closeBtw();
		if (!this.client || !this.ready || this.client.exited) {
			// The connection itself creates the requested fresh session. Discard only
			// input that predates /new, then own the transition before awaiting so text
			// entered during startup queues for (and cannot be erased from) that session.
			// The after-turn continuation of a busy /new already discarded the old
			// queue in deferNewSessionUntilIdle(); anything present now was typed while
			// cancellation settled and belongs to the replacement session.
			if (!options.afterTurn) {
				this.promptQueue = [];
				this.deferredLocalSlashCommands = [];
				this.pendingPromptDisplay = undefined;
			}
			this.statusState = "starting new session";
			this.clearConfigUpdates();
			this.sessionSwitchInProgress = true;
			this.updateSpinner();
			this.ui.requestRender();
			const connected = await this.ensureConnected({
				statusState: "starting new session",
				continueSessionSwitch: true,
			});
			if (!connected) {
				this.sessionSwitchInProgress = false;
				this.restoreFailedSessionSwitchInput();
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
				return;
			}
			this.resetConversationView();
			this.addCommandMessage(displayText);
			this.updateAutocomplete();
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			await this.flushDeferredLocalSlashCommands();
			this.schedulePromptQueueDrain();
			return;
		}
		if (this.busy && !options.afterTurn) {
			this.deferNewSessionUntilIdle(commandName);
			return;
		}
		// The first, busy-turn /new call already discarded everything that preceded
		// the command. On the after-turn continuation, the queue contains only input
		// entered while cancellation was settling, which belongs to the new session.
		if (!options.afterTurn) {
			this.promptQueue = [];
			this.pendingPromptDisplay = undefined;
		}
		this.statusState = "starting new session";
		this.clearConfigUpdates();
		this.sessionSwitchInProgress = true;
		this.updateSpinner();
		this.ui.requestRender();
		const client = this.client;
		let switched = false;
		let inputsRestored = false;
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
			if (client.exited) this.ready = false;
			if (!switched || !this.ready || client.exited) {
				this.restoreFailedSessionSwitchInput();
				inputsRestored = true;
			}
			this.addError(error.message ?? String(error));
		} finally {
			if (this.client !== client) return;
			if (client.exited) this.ready = false;
			const transitionUsable = switched && this.ready && !client.exited;
			if (!transitionUsable && !inputsRestored) {
				this.restoreFailedSessionSwitchInput();
				inputsRestored = true;
			}
			this.sessionSwitchInProgress = false;
			this.statusState = "";
			this.updateSpinner();
			this.ui.requestRender();
			if (transitionUsable) {
				await this.flushDeferredLocalSlashCommands();
				this.schedulePromptQueueDrain();
			}
		}
	}

	async openConfigDialog(category, title, argument = "", commandName = title.toLowerCase(), commandOptions = {}) {
		const target = await this.prepareSessionConfigCommandTarget(commandName, argument, commandOptions.targetThread);
		if (!target) return;
		const state = this.sessionStateForCommandTarget(target);
		const option = findConfigOption(state, category);
		if (!option && category === "mode") {
			await this.openModeDialog(title, argument, commandName, { target, state });
			return;
		}
		if (!option) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, `${title} selection is not advertised by this agent`);
			return;
		}
		const values = flattenConfigOptions(option);
		if (argument) {
			const match = values.find((entry) => entry.value === argument || entry.name === argument);
			if (!match) {
				this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
				this.addSessionTargetNotice(target, `Unknown ${title.toLowerCase()}: ${argument}`);
				return;
			}
			await this.setConfigValueForCommandTarget(target, option, match.value, match.name, {
				displayText: slashPromptDisplay(slashCommandText(commandName, argument), match.name),
				commandName,
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
			if (target.targetThread && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName);
				return;
			}
			await this.setConfigValueForCommandTarget(target, option, entry.value, entry.label, {
				displayText: slashPromptDisplay(`/${commandName}`, entry.label),
				commandName,
			});
		});
	}

	async setConfigValue(option, value, label = value, options = {}) {
		if (!this.client) return false;
		const client = this.client;
		const activeKey = this.activeKey;
		const sessionId = client.sessionId;
		const isCurrentContext = () =>
			this.client === client && this.activeKey === activeKey && client.sessionId === sessionId;
		const updateToken = this.beginConfigUpdate();
		const displayText = options.displayText ?? slashPromptDisplay(`/${option.category ?? option.id ?? "config"}`, label);
		this.statusState = "updating";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await client.setConfigOption(option.id, value, option.type);
			if (!isCurrentContext()) return false;
			this.syncRuntimePermissionModeForBackendMode(option, value);
			if (options.showCommand !== false) this.addCommandMessage(displayText);
			this.updateAutocomplete();
			return true;
		} catch (error) {
			if (!isCurrentContext()) return false;
			if (option.category === "mode" || option.id === "mode") {
				try {
					await client.setMode(value);
					if (!isCurrentContext()) return false;
					this.syncRuntimePermissionModeForBackendMode(option, value);
					if (options.showCommand !== false) this.addCommandMessage(displayText);
					this.updateAutocomplete();
					return true;
				} catch (modeError) {
					if (isCurrentContext()) this.addError(modeError.message ?? String(modeError));
				}
			} else {
				this.addError(error.message ?? String(error));
			}
			return false;
		} finally {
			if (isCurrentContext()) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endConfigUpdate(updateToken);
		}
	}

	async openModeDialog(title, argument = "", commandName = title.toLowerCase(), commandOptions = {}) {
		const target = commandOptions.target ?? this.captureSessionCommandTarget();
		const state = commandOptions.state ?? this.sessionStateForCommandTarget(target);
		const modes = flattenModes(state);
		if (modes.length === 0) {
			this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
			this.addSessionTargetNotice(target, `${title} selection is not advertised by this agent`);
			return;
		}
		if (argument) {
			const match = modes.find((entry) => entry.id === argument || entry.name.toLowerCase() === argument.toLowerCase());
			if (!match) {
				this.addSessionTargetCommand(target, slashCommandText(commandName, argument));
				this.addSessionTargetNotice(target, `Unknown ${title.toLowerCase()}: ${argument}`);
				return;
			}
			await this.setModeValueForCommandTarget(target, match.id, match.name, {
				displayText: slashPromptDisplay(slashCommandText(commandName, argument), match.name),
				commandName,
			});
			return;
		}
		const currentModeId = state?.modes?.currentModeId;
		const entries = modes.map((mode) => ({
			value: mode.id,
			label: mode.name,
			description: mode.description,
			active: mode.id === currentModeId,
		}));
		this.openSelection(title, entries, async (entry) => {
			this.closeMenu();
			if (!entry) return;
			if (target.targetThread && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName);
				return;
			}
			await this.setModeValueForCommandTarget(target, entry.value, entry.label, {
				displayText: slashPromptDisplay(`/${commandName}`, entry.label),
				commandName,
			});
		});
	}

	async setModeValueForCommandTarget(target, modeId, label = modeId, options = {}) {
		if (target?.targetThread) {
			if (!this.isSessionCommandTargetActive(target)) return false;
			const changed = await this.setSideThreadModeValue(target, undefined, modeId, options);
			if (!changed && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(options.commandName ?? "mode");
			}
			return changed;
		}
		return await this.setModeValue(modeId, label, options);
	}

	async setModeValue(modeId, label = modeId, options = {}) {
		if (!this.client) return false;
		const client = this.client;
		const activeKey = this.activeKey;
		const sessionId = client.sessionId;
		const isCurrentContext = () =>
			this.client === client && this.activeKey === activeKey && client.sessionId === sessionId;
		const updateToken = this.beginConfigUpdate();
		const displayText = options.displayText ?? slashPromptDisplay("/mode", label);
		this.statusState = "updating";
		this.updateSpinner();
		this.ui.requestRender();
		try {
			await client.setMode(modeId);
			if (!isCurrentContext()) return false;
			this.syncRuntimePermissionModeForBackendMode({ id: "mode", category: "mode" }, modeId);
			if (options.showCommand !== false) this.addCommandMessage(displayText);
			this.updateAutocomplete();
			return true;
		} catch (error) {
			if (isCurrentContext()) this.addError(error.message ?? String(error));
			return false;
		} finally {
			if (isCurrentContext()) {
				this.statusState = "";
				this.updateSpinner();
				this.ui.requestRender();
			}
			this.endConfigUpdate(updateToken);
		}
	}

	syncRuntimePermissionModeForBackendMode(option, value, options = {}) {
		if (option?.category !== "mode" && option?.id !== "mode") return;
		if (!this.isCodexBackendActive()) return;
		const mode = codexPermissionMode(value);
		if (!mode) return;
		const sessionInfo = options.sessionInfo;
		const context = {
			client: this.client,
			sessionId: sessionInfo?.sessionId ?? this.client?.sessionId,
			mode,
		};
		this.runtimePermissionBackendContext ??= new Map();
		this.runtimePermissionModeSource ??= new Map();
		const previous = this.runtimePermissionBackendContext.get(this.activeKey);
		const unchanged =
			options.onlyIfChanged === true &&
			previous?.client === context.client &&
			previous?.sessionId === context.sessionId &&
			previous?.mode === context.mode;
		if (unchanged) return;
		const source = this.runtimePermissionModeSource.get(this.activeKey);
		const sameSession =
			previous?.client === context.client &&
			previous?.sessionId === context.sessionId;
		this.runtimePermissionBackendContext.set(this.activeKey, context);
		if (options.onlyIfChanged === true) {
			// A backend-derived host mapping belongs only to the session that reported
			// it. Drop it at a session boundary so the new session starts from the
			// configured host policy while its initial wire state is merely observed.
			if (!sameSession && source === "backend") {
				this.runtimePermissionMode?.delete(this.activeKey);
				this.runtimePermissionModeSource.delete(this.activeKey);
			}
			// The first wire state reflects launch/config defaults already represented by
			// agent._permissionMode; do not turn configured deny or gated auto into ask.
			// Treat the first state of every replacement session the same way. A later
			// change in that exact client/session becomes authoritative unless the user
			// explicitly chose a host-only /yolo override.
			if (!sameSession || source === "host") return;
		}
		this.runtimePermissionMode ??= new Map();
		this.runtimePermissionMode.set(this.activeKey, mode === "agent-full-access" ? "auto" : "ask");
		this.runtimePermissionModeSource.set(this.activeKey, "backend");
		// Any explicit backend mode selection exits the prompt-based plan fallback.
		this.planPromptFallback = undefined;
	}

	syncRuntimePermissionModeFromSessionInfo(sessionInfo) {
		const option = findConfigOption(sessionInfo, "mode");
		const mode = option?.currentValue ?? sessionInfo?.modes?.currentModeId;
		if (mode === undefined) return;
		this.syncRuntimePermissionModeForBackendMode(option ?? { id: "mode", category: "mode" }, mode, {
			sessionInfo,
			onlyIfChanged: true,
		});
	}

	syncRuntimePermissionModeForSideClient(client, sessionInfo, options = {}) {
		if (!client || !this.isCodexBackendActive()) return;
		const option = findConfigOption(sessionInfo, "mode");
		const value = option?.currentValue ?? sessionInfo?.modes?.currentModeId;
		const permissionMode = codexPermissionMode(value);
		if (!permissionMode) return;
		const context = {
			sessionId: sessionInfo?.sessionId ?? client.sessionId,
			permissionMode,
		};
		this.runtimePermissionBackendContextByClient ??= new WeakMap();
		const previous = this.runtimePermissionBackendContextByClient.get(client);
		const sameSession = previous && sameSessionId(previous.sessionId, context.sessionId);
		const unchanged = sameSession && previous.permissionMode === context.permissionMode;
		this.runtimePermissionBackendContextByClient.set(client, context);
		if (options.onlyIfChanged === true && (!sameSession || unchanged)) {
			if (!sameSession) this.runtimePermissionModeByClient?.delete(client);
			return;
		}
		this.runtimePermissionModeByClient ??= new WeakMap();
		this.runtimePermissionModeByClient.set(client, {
			sessionId: context.sessionId,
			mode: permissionMode === "agent-full-access" ? "auto" : "ask",
		});
	}

	async setSideThreadConfigValue(target, option, value, options = {}) {
		if (!target?.targetThread || !this.isSessionCommandTargetActive(target)) return false;
		const thread = target.targetThread;
		const client = target.client;
		const predecessor = thread.configUpdateTail ?? Promise.resolve();
		let releaseTurn;
		const turn = new Promise((resolve) => { releaseTurn = resolve; });
		const tail = predecessor.then(() => turn);
		thread.configUpdateTail = tail;
		await predecessor;
		if (!this.isSessionCommandTargetActive(target)) {
			releaseTurn();
			if (thread.configUpdateTail === tail) thread.configUpdateTail = undefined;
			return false;
		}
		const isMode = options.mode === true || option?.category === "mode" || option?.id === "mode";
		thread.statusState = "updating";
		this.onThreadActivity();
		try {
			if (option && options.mode !== true) {
				try {
					await client.setConfigOption(option.id, value, option.type);
				} catch (error) {
					if (!isMode) throw error;
					await client.setMode(value);
				}
			} else {
				await client.setMode(value);
			}
			if (!this.isSessionCommandTargetActive(target)) return false;
			if (isMode) {
				// A direct permission/mode choice exits only this fork's prompt-based plan
				// fallback. Main-session planning and an explicit agent-wide /yolo gate are
				// separate, while backend-derived host modes remain client scoped.
				thread.planPromptFallback = undefined;
				const permissionMode = codexPermissionMode(value);
				if (permissionMode) {
					this.syncRuntimePermissionModeForSideClient(client, {
						sessionId: client.sessionId,
						configOptions: [{ id: "mode", category: "mode", currentValue: value }],
					});
				}
			}
			if (options.showCommand !== false) {
				thread.addCommandMessage(
					options.displayText ?? slashPromptDisplay(`/${option?.category ?? option?.id ?? (isMode ? "mode" : "config")}`, String(value)),
				);
			}
			this.updateAutocomplete();
			return true;
		} catch (error) {
			if (this.isSessionCommandTargetActive(target)) thread.addError(error.message ?? String(error));
			return false;
		} finally {
			releaseTurn();
			const ownsTail = thread.configUpdateTail === tail;
			if (ownsTail) thread.configUpdateTail = undefined;
			if (this.isSessionCommandTargetActive(target)) {
				thread.statusState = "";
				this.onThreadActivity();
				if (ownsTail && options.deferQueueDrain !== true) thread.drainQueue?.();
			}
		}
	}

	async setSideThreadModeValue(target, option, value, options = {}) {
		return await this.setSideThreadConfigValue(target, option, value, {
			...options,
			mode: option ? options.mode : true,
		});
	}

	async setPlanMode(commandName = "plan", argument = "", options = {}) {
		const targetThread = options.targetThread;
		let target;
		const inline = Boolean(argument.trim());
		const restoreInlineInput = () => {
			if (!inline) return;
			this.restoreQueuedTextToComposer([{
				text: slashCommandText(commandName, argument),
				...(Array.isArray(options.promptParts) ? { promptParts: options.promptParts } : {}),
			}]);
			if (targetThread && this.btwThread === targetThread) this.bindEditorToSideThread(targetThread);
			this.ui.requestRender();
		};
		target = await this.prepareSessionConfigCommandTarget(commandName, argument, targetThread);
		if (!target) {
			restoreInlineInput();
			return false;
		}
		const state = this.sessionStateForCommandTarget(target);
		const option = findConfigOption(state, "mode");
		const value = findConfigValue(option, "plan");
		let display = inline ? slashPromptDisplay(slashCommandText(commandName, argument), "Plan") : slashPromptDisplay(`/${commandName}`, "Plan");
		let changed = false;
		let nativePlan = false;
		const setConfig = async (configOption, nextValue, label, configOptions) => targetThread
			? this.setSideThreadModeValue(target, configOption, nextValue, configOptions)
			: this.setConfigValue(configOption, nextValue, label, configOptions);
		const setMode = async (mode, modeOptions) => targetThread
			? this.setSideThreadModeValue(target, undefined, mode.id, modeOptions)
			: this.setModeValue(mode.id, mode.name, modeOptions);
		if (option && value) {
			changed = await setConfig(option, value.value, value.name, {
				displayText: display,
				deferQueueDrain: inline,
				showCommand: !inline,
			});
			nativePlan = changed;
		} else {
			const mode = findMode(state, "plan");
			if (mode) {
				changed = await setMode(mode, {
					displayText: display,
					deferQueueDrain: inline,
					showCommand: !inline,
				});
				nativePlan = changed;
			} else if (this.isCodexBackendActive() && option) {
				// codex-acp 1.1.x does not expose native collaborationMode. Its read-only
				// preset plus an explicit planning instruction is the closest safe ACP
				// fallback: it prevents silent writes and keeps all turns/approvals in cc.
				const readOnly = findConfigValue(option, "read-only");
				if (readOnly) {
					display = inline
						? slashPromptDisplay(slashCommandText(commandName, argument), "Plan (read-only fallback)")
						: slashPromptDisplay(`/${commandName}`, "Plan (read-only fallback)");
					changed = await setConfig(option, readOnly.value, readOnly.name, {
						displayText: display,
						deferQueueDrain: inline,
						showCommand: !inline,
					});
					if (changed) {
						if (targetThread) {
							targetThread.planPromptFallback = { client: target.client, sessionId: target.sessionId };
							if (!inline) targetThread.addNotice("Codex ACP does not expose native plan mode; cc enabled a read-only planning fallback.");
						} else {
							this.planPromptFallback = { client: this.client, sessionId: this.client.sessionId };
							if (!inline) this.addNotice("Codex ACP does not expose native plan mode; cc enabled a read-only planning fallback. Use /permissions auto to leave it.");
						}
					}
				}
			}
		}
		if (nativePlan) {
			if (targetThread) targetThread.planPromptFallback = undefined;
			else this.planPromptFallback = undefined;
		}
		if (!changed) {
			if (targetThread && !this.isSessionCommandTargetActive(target)) {
				this.reportClosedSessionCommandTarget(commandName, argument);
			} else if (targetThread) {
				targetThread.addNotice("Plan mode is not advertised by this agent");
				this.onThreadActivity();
			} else {
				this.addCommandMessage(slashCommandText(commandName, argument));
				this.addNotice("Plan mode is not advertised by this agent");
			}
			restoreInlineInput();
			if (targetThread && this.isSessionCommandTargetActive(target)) targetThread.drainQueue();
			return false;
		}
		if (inline) {
			if (targetThread) {
				if (!this.isSessionCommandTargetActive(target)) {
					restoreInlineInput();
					return false;
				}
				void targetThread.submit(argument.trim(), options.promptParts, {
					queuedInputOrder: options.queuedInputOrder,
				});
			} else {
				await this.submitBackendPrompt(argument.trim(), {
					displayText: display,
					compactCommand: true,
					promptParts: options.promptParts,
				});
			}
		}
		return true;
	}

	async runBtw(question, options = {}) {
		const trimmed = (question ?? "").trim();
		const commandName = options.commandName === "side" ? "side" : "btw";
		const promptParts = Object.hasOwn(options, "promptParts")
			? options.promptParts
			: (trimmed ? this.consumeImagePromptParts(trimmed) : undefined);
		const restorePromptAttachments = () => {
			if (!Array.isArray(promptParts)) return;
			this.restoreQueuedTextToComposer([{
				text: slashCommandText(commandName, trimmed),
				promptParts,
			}]);
		};
		if (this.busy) {
			this.deferLocalSlashCommand(commandName, trimmed, { promptParts });
			return;
		}
		this.addCommandMessage(trimmed ? slashCommandText(commandName, trimmed) : `/${commandName}`);
		if (this.replacementProcessFence) {
			this.reportReplacementProcessFence();
			restorePromptAttachments();
			return;
		}
		if (this.btwThread) {
			this.addNotice("A /btw thread is already open — shift+tab to focus it, esc (when focused) to close.");
			restorePromptAttachments();
			this.ui.requestRender();
			return;
		}
		// A closed side pane may still be reaping its detached ACP tree. Do not let a
		// new fork (or its credentials/session files) overlap that retirement.
		if (this.btwShutdownTail) await this.btwShutdownTail;
		if (this.replacementProcessFence) {
			this.reportReplacementProcessFence();
			restorePromptAttachments();
			return;
		}
		if (this.btwThread) {
			this.addNotice("A /btw thread is already open — shift+tab to focus it, esc (when focused) to close.");
			restorePromptAttachments();
			this.ui.requestRender();
			return;
		}
		if (this.activeKey === "cursor") {
			this.addNotice("/btw is not supported for Cursor (it does not support session forking).");
			restorePromptAttachments();
			this.ui.requestRender();
			return;
		}
		if (!this.ready || !this.client?.sessionId) {
			this.addNotice("/btw needs an active session — try again once connected.");
			restorePromptAttachments();
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
						if (this.btwThread !== thread) return cancelledOutcome();
						return this.resolvePermissionOutcome(this.activeKey, agent, params, { sourceClient: btwClient });
					},
					onCursorRequest: (method, params) => {
						if (this.btwThread !== thread) return cursorCancelResult(method);
						return this.resolveCursorOutcome(this.activeKey, agent, method, params, { sourceClient: btwClient });
					},
					onElicitationRequest: (params) => {
						if (this.btwThread !== thread) return { action: "cancel" };
						return this.requestElicitation(params, { sourceClient: btwClient });
					},
					elicitationCapabilities: { url: true, form: true },
			},
		);
		thread = new BtwThread(this, btwClient, trimmed);
		this.btwThread = thread;
		this.focusedThread = "btw";
		this.updateAutocomplete();
		this.updateSpinner();
		// Entering the fixed-height page view from natural flow: isolate it from
		// transcript scrollback, then hard repaint into that clean surface.
		this.ui.terminal.enterAlternateScreen?.();
		this.forceFullRepaint();
		// Queue the initial question (if any) — it sends once the fork is ready.
		// A bare /btw just opens the focused fork, ready for the first message.
		if (trimmed) thread.submit(trimmed, promptParts);

		try {
			await btwClient.initialize({ createSession: false });
			if (this.btwThread !== thread) {
				await this.trackBtwShutdown(btwClient);
				return;
			}
			if (btwClient.supportsFork()) {
				await btwClient.forkSession(parentSessionId);
				recordForkId(btwClient.sessionId);
			} else if (this.activeKey === "codex") {
				await this.forkCodexSession(btwClient, parentSessionId);
			} else {
				throw new Error("this agent does not support session forking");
			}
			thread.sessionId = btwClient.sessionId;
			this.syncRuntimePermissionModeForSideClient(btwClient, btwClient.getSessionInfo(), { onlyIfChanged: true });
			thread.markReady();
			this.onThreadActivity();
		} catch (error) {
			// Fork setup failed (submit handles its own errors internally), so the
			// fork's backend never got going — stop it to avoid a leaked process.
			thread.settleReadyWaiters(false);
			thread.cancelDeferredLocalCommands();
			const shutdown = this.trackBtwShutdown(btwClient);
			if (this.btwThread === thread) {
				thread.addError(`Could not start side thread: ${error.message ?? error}`);
				thread.state = "error";
				thread.statusState = "";
				this.onThreadActivity();
			}
			await shutdown;
			restorePromptAttachments();
		}
	}

	trackBtwShutdown(client) {
		if (!client) return this.btwShutdownTail ?? Promise.resolve();
		this.btwShutdownClients ??= new WeakMap();
		const existing = this.btwShutdownClients.get(client);
		if (existing) return existing;
		// stopClientsForReplacement enters stopAndWait synchronously before its first
		// await, so close tracking is installed before any signal can make the root
		// disappear. Combine with an older retirement without delaying this one.
		const directShutdown = stopClientsForReplacement([client]);
		const previousShutdown = this.btwShutdownTail;
		const combined = previousShutdown
			? Promise.all([previousShutdown, directShutdown])
			: directShutdown;
		let tracked;
		tracked = Promise.resolve(combined)
			.catch((error) => {
				if (this.recordReplacementProcessFence(error, { preserveReady: true })) {
					this.reportReplacementProcessFence();
				} else {
					this.addError(`Could not stop the /btw backend: ${error.message ?? error}`);
					this.ui.requestRender();
				}
			})
			.finally(() => {
				if (this.btwShutdownClients?.get(client) === tracked) this.btwShutdownClients.delete(client);
				if (this.btwShutdownTail === tracked) this.btwShutdownTail = undefined;
			});
		this.btwShutdownClients.set(client, tracked);
		this.btwShutdownTail = tracked;
		return tracked;
	}

	closeBtw(options = {}) {
		const thread = this.btwThread;
		this.clearEditorSideThreadBinding(thread);
		this.btwThread = undefined;
		this.focusedThread = "main";
		this.updateAutocomplete();
		this.mainView.stick = true;
		if (thread) {
			thread.settleReadyWaiters?.(false);
			thread.cancelDeferredLocalCommands?.();
			this.cancelInteractiveRequestsForClient(thread.client);
			thread.cancelRequested = true;
			thread.clearCancelGraceTimer?.();
			if (options.stop !== false) {
				thread.client?.cancel?.();
				this.trackBtwShutdown(thread.client);
			}
		}
		this.updateSpinner();
		// Leaving the fixed-height page view back to natural flow: restore the normal
		// buffer, then hard repaint so main includes anything that arrived while the
		// fork page was open.
		this.ui.terminal.exitAlternateScreen?.();
		this.forceFullRepaint({ immediate: options.immediateRender === true });
		return this.btwShutdownTail ?? Promise.resolve();
	}

	// Codex's ACP bridge does not expose session/fork — session/load and
	// session/resume reuse the SAME thread id and append to the SAME rollout file,
	// so resuming the live session in a second process would corrupt its rollout.
	// To fork safely we copy the main session's rollout JSONL to a brand-new id and
	// load the copy: an isolated branch with full history + tools, parent untouched.
	//
	// VERSION-SPECIFIC ASSUMPTIONS (verified against openai/codex 0.144 and
	// @agentclientprotocol/codex-acp 1.1 as of 2026-07; if Codex changes its
	// on-disk layout this is where to fix it):
	//   • Rollouts live under $CODEX_HOME (default ~/.codex) at
	//     sessions/YYYY/MM/DD/rollout-<timestamp>-<threadUuid>.jsonl (JSON Lines).
	//   • The ACP session id returned by session/new equals <threadUuid>, which is
	//     stored in the session_meta identity fields.
	//   • codex-acp resolves session/load from a rollout filename containing the id,
	//     so writing a copy named with the new uuid makes it loadable without the
	//     state_5.sqlite index. Only the metadata identity is rewritten; UUID text in
	//     user messages and tool output remains part of the transcript verbatim.
	// If any assumption no longer holds, forking throws a clear error (shown in the
	// /btw pane) rather than corrupting anything.
	async forkCodexSession(btwClient, parentSessionId) {
		const releaseForkOperation = await acquireForkOperationLock({ operation: `fork ${parentSessionId}` });
		try {
			const env = mergedAgentEnvironment(this.config.agents[this.activeKey]);
			const rolloutPath = findCodexRolloutPath(parentSessionId, path.join(codexHome(env), "sessions"));
			if (!rolloutPath) throw new Error("could not locate the Codex session rollout to fork (see forkCodexSession notes)");
			if (rolloutPath.endsWith(".zst")) throw new Error("the Codex session rollout is compressed; cannot fork it (see forkCodexSession notes)");
			const newId = randomUUID();
			let copiedRolloutPath;
			try {
				copiedRolloutPath = copyCodexRolloutWithNewId(rolloutPath, parentSessionId, newId, {
					beforePublish: () => {
						recordForkId(newId, parentSessionId, { required: true });
					},
				});
			} catch (error) {
				forgetForkIds(newId, { required: true });
				throw error;
			}
			// Use session/load so the copied id is loaded directly. It replays the parent
			// transcript before the thread is marked ready, and BtwThread discards pre-ready
			// events, so the fork inherits context without dumping history into the pane.
			try {
				await btwClient.loadSession(newId);
			} catch (error) {
				// session/load can fail after opening the copied rollout. Retire the entire
				// ACP tree before unlinking it so a late writer cannot recreate or corrupt the
				// path; if liveness cannot be proven, preserve the copy for safe recovery.
				await stopClientsForReplacement([btwClient]);
				fs.rmSync(copiedRolloutPath, { force: true });
				forgetForkIds(newId, { required: true });
				throw error;
			}
		} finally {
			releaseForkOperation();
		}
	}

	async runDiff(argument) {
		this.addCommandMessage(slashCommandText("diff", argument));
		const explicitArgs = splitCommandArguments(argument);
		const args = explicitArgs.length > 0 ? explicitArgs : ["HEAD"];
		const supplementalNotices = [];
		if (!this.busy) {
			this.statusState = "loading diff";
			this.updateSpinner();
			this.ui.requestRender();
		}
		try {
			const captureOptions = {
				rejectOnExit: false,
				timeoutMs: 30_000,
				maxStdoutBytes: DIFF_OUTPUT_MAX_BYTES,
				maxStderrBytes: DIFF_STDERR_MAX_BYTES,
			};
			let result;
			// `git diff HEAD` omits files that are not in the index. Native Codex /diff
			// includes them. For the default view, use an isolated temporary index and
			// intent-to-add entries so one bounded Git process renders tracked files,
			// ordinary untracked files, and embedded repositories as gitlinks. This does
			// not touch the user's index and avoids a platform-specific null device. An
			// explicit `/diff --staged` or pathspec retains exact Git semantics.
			if (explicitArgs.length === 0) {
				const untracked = await this.runTrackedCapture("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
					rejectOnExit: false,
					timeoutMs: 30_000,
					maxStdoutBytes: DIFF_UNTRACKED_MANIFEST_MAX_BYTES,
					maxStderrBytes: DIFF_STDERR_MAX_BYTES,
				});
				if (untracked.code === 0) {
					// HEAD is absent in a freshly initialized repository. Detect that case
					// explicitly so the default view can compare the working tree with Git's
					// format-specific empty tree instead of failing on an ambiguous HEAD.
					const head = await this.runTrackedCapture("git", ["rev-parse", "--verify", "HEAD"], {
						...captureOptions,
						maxStdoutBytes: DIFF_STDERR_MAX_BYTES,
					});
					let unborn = false;
					if (head.code !== 0) {
						const symbolicHead = await this.runTrackedCapture("git", ["symbolic-ref", "-q", "HEAD"], {
							...captureOptions,
							maxStdoutBytes: DIFF_STDERR_MAX_BYTES,
						});
						unborn = symbolicHead.code === 0;
					}
					const manifest = untracked.stdout.toString("utf8");
					const entries = manifest.split("\0");
					// A byte-limited capture can end in the middle of a UTF-8 path. Never pass
					// that partial path back to Git.
					if (untracked.stdoutTruncated && !manifest.endsWith("\0")) entries.pop();
					const availablePaths = entries.filter(Boolean);
					const selectedPaths = [];
					let argumentBytes = 0;
					for (const file of availablePaths) {
						const fileArgumentBytes = Math.max(file.length, Buffer.byteLength(file, "utf8")) + 1;
						if (
							selectedPaths.length >= DIFF_UNTRACKED_MAX_PATHS ||
							argumentBytes + fileArgumentBytes > DIFF_UNTRACKED_MAX_ARGUMENT_BYTES
						) break;
						selectedPaths.push(file);
						argumentBytes += fileArgumentBytes;
					}
					const knownOmitted = availablePaths.length - selectedPaths.length;
					if (knownOmitted > 0 || untracked.stdoutTruncated) {
						const amount = untracked.stdoutTruncated
							? "Additional untracked paths"
							: `${knownOmitted} additional untracked path${knownOmitted === 1 ? "" : "s"}`;
						supplementalNotices.push(`${amount} omitted from /diff because the safety limit was reached.`);
					}
					if (selectedPaths.length > 0 || unborn) {
						const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cc-diff-index-"));
						const temporaryIndex = path.join(temporaryDirectory, "index");
						let preserveTemporaryDirectory = false;
						const temporaryIndexEnvironment = mergeEnvironments([
							process.env,
							{ GIT_INDEX_FILE: temporaryIndex, GIT_OPTIONAL_LOCKS: "0" },
						]);
						try {
							// Start from the user's active index, not HEAD. A HEAD-seeded index
							// silently loses staged additions and rename destinations whenever an
							// unrelated untracked path makes us take this branch. Resolving through
							// Git also respects linked worktrees and an explicit GIT_INDEX_FILE.
							const indexPathResult = await this.runTrackedCapture("git", ["rev-parse", "--git-path", "index"], {
								...captureOptions,
								maxStdoutBytes: DIFF_STDERR_MAX_BYTES,
							});
							const indexOutput = indexPathResult.stdout.toString("utf8");
							const indexPathValue = indexOutput.replace(/\r?\n$/, "");
							const usableIndexPath = !(
								indexPathResult.code !== 0 ||
								indexPathResult.stdoutTruncated ||
								!indexPathValue ||
								indexPathValue.includes("\0")
							);
							let indexReady = false;
							if (usableIndexPath) {
								const sourceIndex = path.isAbsolute(indexPathValue)
									? indexPathValue
									: path.resolve(process.cwd(), indexPathValue);
								try {
									await fs.promises.copyFile(sourceIndex, temporaryIndex, fs.constants.COPYFILE_EXCL);
									indexReady = true;
								} catch (error) {
									// A repository with no commits and no staged paths legitimately has no
									// index yet. Initialize only that case as empty; doing this in a normal
									// repository would turn tracked paths into bogus deletions.
									if (unborn && error?.code === "ENOENT") {
										const emptyIndex = await this.runTrackedCapture(
											"git",
											["-c", "core.splitIndex=false", "read-tree", "--empty"],
											{ ...captureOptions, env: temporaryIndexEnvironment },
										);
										indexReady = emptyIndex.code === 0;
									} else {
										supplementalNotices.push("Untracked paths could not be included in /diff; showing tracked changes only.");
									}
								}
							} else {
								supplementalNotices.push("Untracked paths could not be included in /diff; showing tracked changes only.");
							}

							if (indexReady) {
								let untrackedReady = true;
								if (selectedPaths.length > 0) {
									// A copied split index otherwise writes a new sharedindex.* beside the
									// user's real index. Disable splitting for this private mutation so /diff
									// remains read-only with respect to repository metadata.
									const add = await this.runTrackedCapture(
										"git",
										["--literal-pathspecs", "-c", "core.splitIndex=false", "add", "--intent-to-add", "--", ...selectedPaths],
										{ ...captureOptions, env: temporaryIndexEnvironment },
									);
									untrackedReady = add.code === 0;
									if (!untrackedReady) {
										supplementalNotices.push("Some untracked paths could not be included in /diff; showing tracked changes only.");
									}
								}

								let baseline = "HEAD";
								if (unborn) {
									const emptyTreeInput = path.join(temporaryDirectory, "empty-tree");
									await fs.promises.writeFile(emptyTreeInput, "");
									const emptyTree = await this.runTrackedCapture(
										"git",
										["hash-object", "-t", "tree", "--", emptyTreeInput],
										{ ...captureOptions, maxStdoutBytes: DIFF_STDERR_MAX_BYTES },
									);
									const value = emptyTree.stdout.toString("utf8").trim();
									if (emptyTree.code === 0 && !emptyTree.stdoutTruncated && /^[0-9a-f]{40,64}$/i.test(value)) {
										baseline = value;
									} else {
										result = emptyTree;
									}
								}
								// In an unborn repository, even an add failure should still show staged
								// paths from the copied index. In a normal repository the real-index
								// fallback below has the cleanest tracked-only semantics.
								if (!result && (untrackedReady || unborn)) {
									result = await this.runTrackedCapture("git", ["--no-pager", "diff", baseline], {
										...captureOptions,
										env: temporaryIndexEnvironment,
									});
								}
							}
						} catch (error) {
							// If Git's process tree is still live it may still own or reopen this
							// index. Preserve the private directory just as native session mutations
							// preserve files whose last writer cannot be proven dead.
							preserveTemporaryDirectory = isProcessTreeTerminationFailure(error);
							throw error;
						} finally {
							if (!preserveTemporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
						}
					}
				} else {
					supplementalNotices.push("Untracked paths could not be inspected; showing tracked changes only.");
				}
			}
			result ??= await this.runTrackedCapture("git", ["--no-pager", "diff", ...args], captureOptions);
			const text = result.stdout.toString("utf8");
			if (result.code !== 0 && !text.trim()) {
				const detail = oneLine(result.stderr.toString("utf8")) || "git diff failed";
				this.addNotice(detail);
			} else if (!text.trim() && supplementalNotices.length === 0) {
				this.addNotice("No changes in the working tree.");
			} else if (text.trim()) {
				this.showMarkdownBlock(`\`\`\`diff\n${truncateDiff(text, DIFF_DISPLAY_MAX_LINES, result.stdoutTruncated === true)}\n\`\`\``);
			}
			if (result.stdoutTruncated) supplementalNotices.push("Additional diff output was omitted because the display safety limit was reached.");
			for (const notice of supplementalNotices) this.addNotice(notice);
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
		const guardedOnSelect = async (entry) => {
			this.selectionActions ??= new Set();
			const actionToken = Symbol("selection-action");
			this.selectionActions.add(actionToken);
			this.selectionActionInProgress = true;
			try {
				await onSelect(entry);
			} catch (error) {
				this.addError(error.message ?? String(error));
			} finally {
				this.selectionActions.delete(actionToken);
				this.selectionActionInProgress = this.selectionActions.size > 0;
				if (!this.sessionSwitchInProgress && (this.deferredLocalSlashCommands?.length ?? 0) > 0) {
					await this.flushDeferredLocalSlashCommands();
				}
				this.btwThread?.drainQueue?.();
				this.schedulePromptQueueDrain();
				this.ui.requestRender();
			}
		};
		this.menuHandle = new SelectionPanel(title, entries, guardedOnSelect, {
			...options,
			onQueryChange: (query) => this.updateFilterEditor(query),
		});
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	openElicitationForm(form, onFinish) {
		this.closeMenu({ cancelSelection: true });
		this.menuEditorText = this.editor.getText();
		this.updateFilterEditor("");
		this.menuHandle = new ElicitationFormPanel(form, onFinish);
		this.commandPanel.addChild(this.menuHandle);
		this.ui.setFocus(this.menuHandle);
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
		if (
			handle &&
			!(handle instanceof SelectionPanel) &&
			!this.sessionSwitchInProgress &&
			!this.selectionActionInProgress &&
			(this.deferredLocalSlashCommands?.length ?? 0) > 0
		) {
			queueMicrotask(() => void this.flushDeferredLocalSlashCommands());
		}
		this.schedulePromptQueueDrain();
		this.btwThread?.drainQueue?.();
	}

	updateFilterEditor(query) {
		this.editor.setText(query);
	}

	// The single decision point shared by every connection (main + /btw + future
	// /remote). Resolves the harness-agnostic policy, lets the engine decide, and
	// only opens a dialog when the policy says "ask".
	resolvePermissionOutcome(agentKey, agent, params, requestContext = {}) {
		const policy = this.permissionPolicyFor(agentKey, agent, requestContext);
		const decision = decidePermission(policy, params, { agentKey });
		if (decision.action !== "ask") return outcomeForDecision(decision);
		return this.requestPermission(params, { ...requestContext, agentKey, policy });
	}

	// Cursor's interactive extension prompts (create_plan / ask_question) run through
	// the SAME policy engine as tool permissions: a matching deny rule/grant or deny
	// mode rejects them, auto accepts, otherwise the user is asked. (Mode alone is not
	// enough — a deny rule under auto mode must still reject.)
	resolveCursorOutcome(agentKey, agent, method, params, requestContext = {}) {
		const policy = this.permissionPolicyFor(agentKey, agent, requestContext);
		const synthetic = { toolCall: { title: cursorActionName(params), kind: method }, options: [] };
		const decision = decidePermission(policy, synthetic, { agentKey });
		if (decision.action === "deny") return cursorCancelResult(method);
		if (decision.action === "allow") return autoCursorOutcome(method, params);
		return this.requestCursorInteraction(method, params, requestContext);
	}

	// Effective policy for a harness: runtime /yolo override > the spawn-time mode
	// (agent._permissionMode, already = explicit settings ?? native-inferred) >
	// "ask". Rules come from settings + persisted grants.
	permissionPolicyFor(agentKey, agent, requestContext = {}) {
		const policy = resolvePermissionPolicy(this.config.settings ?? {}, agentKey, this.permissionGrants);
		const globalRuntime = this.runtimePermissionMode.get(agentKey);
		const globalSource = this.runtimePermissionModeSource?.get(agentKey);
		const sourceClient = requestContext.sourceClient;
		let runtime = globalRuntime;
		if (sourceClient && sourceClient !== this.client && globalSource !== "host") {
			const scoped = this.runtimePermissionModeByClient?.get(sourceClient);
			const scopedSessionMatches = scoped && (
				scoped.sessionId === undefined || sameSessionId(scoped.sessionId, sourceClient.sessionId)
			);
			// Backend-derived mode observations belong to the exact ACP connection that
			// reported them. A main full-access session must not silently auto-approve
			// requests from a prompting /btw fork. Explicit /yolo remains agent-global.
			runtime = scopedSessionMatches ? scoped.mode : globalSource === "backend" ? undefined : globalRuntime;
		}
		policy.mode = runtime ?? agent?._permissionMode ?? policy.mode;
		return policy;
	}

	// Record a user's "always" choice as a persistent, harness-agnostic grant.
	// Best-effort: a failed store write must NOT prevent the backend reply, or the
	// permission request would hang and the queue stall.
	rememberPermissionChoice(agentKey, params, option) {
		const tool = permissionRequestInfo(params).toolName;
		if (!tool || !option?.optionId) return;
		const action = classifyOption(option) === "deny" ? "deny" : "allow";
		try {
			this.permissionGrants = recordGrant({ agent: agentKey, tool, action });
			this.addNotice(`Remembered: ${action === "deny" ? "deny" : "allow"} "${oneLine(tool)}" for ${agentKey} (see /permissions)`);
		} catch (error) {
			this.addNotice(`Could not save permission grant: ${error.message ?? error}`);
		}
	}

	requestPermission(params = {}, context = {}) {
		return new Promise((resolve) => {
			this.permissionQueue.push({ kind: "permission", params, context, resolve });
			this.drainPermissionQueue();
		});
	}

	requestCursorInteraction(method, params = {}, context = {}) {
		return new Promise((resolve) => {
			this.permissionQueue.push({ kind: "cursor", method, params, context, resolve });
			this.drainPermissionQueue();
		});
	}

	requestElicitation(params = {}, context = {}) {
		return new Promise((resolve) => {
			this.permissionQueue.push({ kind: "elicitation", params, context, resolve });
			this.drainPermissionQueue();
		});
	}

	completeInteractiveRequest(request) {
		if (this.activeInteractiveRequest === request) this.activeInteractiveRequest = undefined;
		this.permissionPromptActive = false;
		this.drainPermissionQueue();
	}

	drainPermissionQueue() {
		if (this.permissionPromptActive) return;
		const request = this.permissionQueue.shift();
		if (!request) return;
		this.permissionPromptActive = true;
		this.activeInteractiveRequest = request;
		if (!this.interactiveRequestIsCurrent(request)) {
			request.resolve(this.cancelledInteractiveResult(request));
			this.completeInteractiveRequest(request);
			return;
		}
		if (request.kind === "cursor") {
			this.openCursorInteraction(request);
			return;
		}
		if (request.kind === "elicitation") {
			this.openElicitationRequest(request);
			return;
		}
		// Re-evaluate against the CURRENT policy before prompting: a grant just
		// recorded for an overlapping request (or a runtime /yolo change) may now
		// auto-resolve this one, so the user isn't re-asked about a tool they just
		// chose "always" for.
		const agentKey = request.context?.agentKey;
		if (agentKey) {
			const policy = this.permissionPolicyFor(agentKey, this.config.agents[agentKey], request.context);
			const decision = decidePermission(policy, request.params, { agentKey });
				if (decision.action !== "ask") {
					request.resolve(outcomeForDecision(decision));
					this.completeInteractiveRequest(request);
				return;
			}
			request.context = { ...request.context, policy };
		}
		this.openPermissionRequest(request);
	}

	interactiveRequestIsCurrent(request) {
		const sourceClient = request?.context?.sourceClient;
		if (!sourceClient) return true;
		if (sourceClient.exited || sourceClient.stopping) return false;
		if (this.client !== sourceClient && this.btwThread?.client !== sourceClient) return false;
		const requestedSessionId = request.params?.sessionId ?? request.params?.scope?.sessionId;
		if (requestedSessionId !== undefined && sourceClient.sessionId !== undefined) {
			return sameSessionId(requestedSessionId, sourceClient.sessionId);
		}
		return true;
	}

	openCursorInteraction(request) {
		const { method, params, resolve } = request;
		const finish = (result) => {
			this.closeMenu();
			resolve(result);
			this.completeInteractiveRequest(request);
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

	openElicitationRequest(request) {
		const { params, resolve } = request;
		let settled = false;
		let opening = false;
		const finish = (result) => {
			if (settled) return;
			settled = true;
			const canonical = result && ["accept", "decline", "cancel"].includes(result.action)
				? result
				: { action: "cancel" };
			const finalResult = canonical.action === "cancel" || this.interactiveRequestIsCurrent(request)
				? canonical
				: { action: "cancel" };
			try {
				this.closeMenu();
			} finally {
				resolve(finalResult);
				this.completeInteractiveRequest(request);
			}
		};
		if (!this.interactiveRequestIsCurrent(request)) {
			finish({ action: "cancel" });
			return;
		}
		if (params.mode === "form") {
			let form;
			try {
				form = normalizeElicitationFormRequest(params);
			} catch (error) {
				this.addNotice(`${singleLineMenuText(params.message ?? "Input requested")}: form could not be displayed (${singleLineMenuText(error.message ?? error)})`);
				finish({ action: "cancel" });
				return;
			}
			this.openElicitationForm(form, finish);
			return;
		}
		if (params.mode !== "url" || !params.url) {
			this.addNotice(`${singleLineMenuText(params.message ?? "Input requested")}: unsupported elicitation form`);
			finish({ action: "cancel" });
			return;
		}
		const entries = [
			{ value: "open", label: "Open authentication page", description: safeUrlDescription(params.url) },
			{ value: "copy", label: "Copy URL for manual opening", description: "May contain a one-time secret" },
			{ value: "decline", label: "Decline" },
		];
		this.openSelection(oneLine(params.message ?? "Authentication required"), entries, async (entry) => {
			if (settled) return;
			if (opening) {
				// A repeated selection while the browser command is in flight is noise,
				// but Esc/agent-switch cancellation must still release the ACP request.
				if (!entry) finish({ action: "cancel" });
				return;
			}
			if (entry?.value === "copy") {
				try {
					await writeSecretClipboardText(params.url);
					this.addNotice("Copied the authentication URL. Treat it as a secret until sign-in completes.");
				} catch {
					this.addNotice(`Open this authentication URL manually (it may contain a secret): ${singleLineMenuText(params.url)}`);
				}
				finish({ action: "accept" });
				return;
			}
			if (entry?.value !== "open") {
				finish({ action: entry ? "decline" : "cancel" });
				return;
			}
			opening = true;
			try {
				await openExternalUrl(params.url, this.trackedNativeProcessOptions());
				finish({ action: "accept" });
			} catch (error) {
				if (!settled) this.addError(`Could not open authentication page: ${error.message ?? error}`);
				if (!settled) {
					this.addNotice(`Open this authentication URL manually (it may contain a secret): ${singleLineMenuText(params.url)}`);
					finish({ action: "accept" });
				}
			}
		});
	}

	openPermissionRequest(request) {
		const { params, resolve, context = {} } = request;
		const options = Array.isArray(params.options) ? params.options : [];
		if (options.length === 0) {
			// Surface it rather than silently cancelling against the user.
			this.addNotice(`${permissionTitle(params)}: no options offered — cancelling`);
			resolve(cancelledOutcome());
			this.completeInteractiveRequest(request);
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
			// An "always" pick should never make BOTH cc and the backend persist it.
			// cc downgrades the backend reply to a one-time (non-persistent) option so
			// the backend doesn't persist, and records its own grant ONLY when
			// remembering is enabled (so remember:false truly persists nothing). If the
			// backend offers no non-persistent option in that direction, cc can't own
			// it — honor the user's pick but DON'T record a grant it couldn't revoke,
			// and tell the user the backend owns it.
			let toRemember = null;
			if (!option?.optionId) {
				resolve(cancelledOutcome());
			} else if (isAlwaysOption(option)) {
				const once = nonPersistentSameDirection(option, options);
				if (once) {
					resolve(selectedOutcome(once.optionId));
					if (context.policy?.remember !== false) toRemember = option;
				} else {
					resolve(selectedOutcome(option.optionId));
					this.addNotice(
						`${context.agentKey ?? "the backend"} will remember this itself — /permissions clear can't revoke it ` +
							"(no one-time option was offered).",
					);
				}
			} else {
				resolve(selectedOutcome(option.optionId));
			}
			// Record BEFORE draining so an overlapping queued request for the same tool
			// is re-evaluated against the new grant (drainPermissionQueue re-runs the
			// decision). Best-effort: rememberPermissionChoice catches write failures,
			// and the backend reply already happened above, so this can't block.
			if (toRemember) this.rememberPermissionChoice(context.agentKey, params, toRemember);
			this.completeInteractiveRequest(request);
		};
		this.openSelection(permissionTitle(params), entries, finish, { emptyText: "No permission options" });
	}

	cancelledInteractiveResult(request) {
		return request.kind === "cursor"
			? cursorCancelResult(request.method)
			: request.kind === "elicitation"
				? { action: "cancel" }
				: { outcome: "cancelled" };
	}

	cancelInteractiveRequestsForClient(client) {
		if (!client) return;
		const remaining = [];
		for (const request of this.permissionQueue) {
			if (request.context?.sourceClient === client) request.resolve(this.cancelledInteractiveResult(request));
			else remaining.push(request);
		}
		this.permissionQueue = remaining;
		if (this.activeInteractiveRequest?.context?.sourceClient === client) {
			this.closeMenu({ cancelSelection: true });
		}
	}

	cancelPermissionPrompts() {
		const queued = this.permissionQueue.splice(0);
		for (const request of queued) request.resolve(this.cancelledInteractiveResult(request));
		if (!this.permissionPromptActive) return;
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
				this.syncRuntimePermissionModeFromSessionInfo(event.sessionInfo);
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
		const sideCommands =
			this.focusedThread === "btw" && this.btwThread?.commandsLoaded
				? this.btwThread.availableCommands
				: undefined;
		const commands = dedupeCommands([
			...localSlashCommands(this),
			...(sideCommands ?? this.availableCommands.get(this.activeKey) ?? []),
		]);
		// Skip frequent no-op config/mode/session updates while the user is mid-type.
		const key = `${this.activeKey}\t${JSON.stringify(commands.map((command) => [command.name, command.description, command.argumentHint]))}`;
		if (key === this.lastAutocompleteKey) return;
		this.lastAutocompleteKey = key;
		const provider = this.editor.autocompleteProvider;
		if (provider instanceof LazyCombinedAutocompleteProvider) provider.setCommands(commands);
		else this.editor.setAutocompleteProvider(new LazyCombinedAutocompleteProvider(commands, process.cwd(), whichPath("fd")));
		// Backend commands commonly arrive after the user has already typed `/x`.
		// Re-evaluate that unchanged input immediately; replacing a provider alone
		// cancels Pi's popup and it otherwise stays closed until another keystroke.
		this.editor.refreshAutocompleteForCurrentInput?.();
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
		if (this.stopPromise) return this.stopPromise;
		this.stopPromise = this.stopAndExit();
		return this.stopPromise;
	}

	async stopAndExit(options = {}) {
		this.stopping = true;
		if (this.spinnerTimer) clearInterval(this.spinnerTimer);
		if (this.markdownPreloadTimer) clearTimeout(this.markdownPreloadTimer);
		if (this.startupConnectTimer) clearTimeout(this.startupConnectTimer);
		this.clearCancelGraceTimer();
		this.cancelPermissionPrompts();
		this.voiceController?.dispose();
		let sideShutdown = this.btwShutdownTail;
		if (this.btwThread) {
			// TUI.stop() positions its final cursor relative to the current buffer.
			// Leave /btw's alternate screen and render main synchronously first so
			// the shell prompt lands after the restored normal transcript.
			sideShutdown = this.closeBtw({ immediateRender: true });
		}
		// Starting the awaitable stop installs close tracking before the TUI teardown
		// or process exit can advance. Both main and side trees get bounded TERM/KILL
		// escalation, and process.exit happens only after those waiters settle.
		const mainShutdown = this.client ? stopClientsForReplacement([this.client]) : Promise.resolve();
		// A replacement may have detached `this.client` before waiting for its old
		// process tree. Its lifecycle tail owns that tree until the wait completes.
		// `stopping` makes every queued/reawakened switch return without spawning;
		// awaiting the tail ensures neither the predecessor nor a late replacement
		// can outlive cc.
		const agentSwitchShutdown = this.agentSwitchTail ?? Promise.resolve();
		// stopAndWait() synchronously closes the registry and signals every process
		// that was registered before shutdown. No later native helper can spawn, and
		// process.exit remains behind the bounded TERM/KILL tree waiters.
		const nativeShutdown = this.nativeProcessTracker?.stopAndWait?.() ?? Promise.resolve();
		this.ui.stop();
		await Promise.allSettled([sideShutdown, mainShutdown, agentSwitchShutdown, nativeShutdown].filter(Boolean));
		(options.exit ?? process.exit)(0);
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

export class LazyCombinedAutocompleteProvider {
	constructor(commands, basePath, fdPath = null) {
		this.commands = commands;
		this.slashCommands = commands.filter((command) => !String(command?.name ?? command?.value ?? "").startsWith("$"));
		this.basePath = basePath;
		this.fdPath = fdPath;
		this.delegate = undefined;
	}

	setCommands(commands) {
		this.commands = commands;
		this.slashCommands = commands.filter((command) => !String(command?.name ?? command?.value ?? "").startsWith("$"));
		if (this.delegate) this.delegate.commands = this.slashCommands;
	}

	async getSuggestions(lines, cursorLine, cursorCol, options) {
		const currentLine = lines[cursorLine] ?? "";
		const beforeCursor = currentLine.slice(0, cursorCol);
		const skillMatch = beforeCursor.match(/(?:^|[\s])(\$[A-Za-z0-9._-]*)$/);
		if (skillMatch) {
			const prefix = skillMatch[1];
			const normalized = prefix.toLowerCase();
			const items = this.commands
				.filter((command) => String(command?.name ?? command?.value ?? "").startsWith("$"))
				.map((command) => {
					const value = String(command.name ?? command.value);
					return { value, label: value, description: command.description };
				})
				.filter((item) => item.value.toLowerCase().includes(normalized));
			return items.length > 0 ? { items, prefix } : null;
		}
		const Provider = await loadAutocompleteProvider();
		this.delegate ??= new Provider(this.slashCommands, this.basePath, this.fdPath);
		const atMatch = beforeCursor.match(/(?:^|[\s])(@(?:"[^"]*|[^\s]*))$/);
		if (atMatch && !this.fdPath && typeof this.delegate.getFileSuggestions === "function") {
			const prefix = atMatch[1];
			const items = this.delegate.getFileSuggestions(prefix);
			return items.length > 0 ? { items, prefix } : null;
		}
		return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options);
	}

	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		if (prefix?.startsWith("$")) {
			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const suffix = afterCursor.startsWith(" ") ? "" : " ";
			const next = [...lines];
			next[cursorLine] = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
			return { lines: next, cursorLine, cursorCol: beforePrefix.length + item.value.length + suffix.length };
		}
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

export function versionAtLeast(actual, minimum) {
	const parse = (value) => {
		const match = String(value ?? "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
		return match
			? { parts: match.slice(1, 4).map(Number), prerelease: match[4] }
			: undefined;
	};
	const current = parse(actual);
	const required = parse(minimum);
	if (!current || !required) return false;
	for (let index = 0; index < 3; index += 1) {
		if (current.parts[index] !== required.parts[index]) return current.parts[index] > required.parts[index];
	}
	if (required.prerelease) return true;
	return !current.prerelease;
}

function isAuthenticationRequiredError(error) {
	return /auth(?:entication|orization)? required|sign[ -]?in required|log in|login required/i.test(error?.message ?? String(error));
}

function safeUrlDescription(value) {
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return "External URL";
		const destination = `${url.origin}${url.pathname}`;
		return destination.length > 120 ? `${destination.slice(0, 119)}…` : destination;
	} catch {
		return "External URL";
	}
}

function splitCommandArguments(value) {
	const result = [];
	let current = "";
	let quote = "";
	const source = String(value ?? "");
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (char === "\\") {
			const next = source[index + 1];
			// Slash-command text is not a shell command line. Keep ordinary and UNC
			// Windows paths literal; consume the backslash only when it clearly escapes
			// whitespace or a quote delimiter.
			if (next && (/\s/.test(next) || next === quote || (!quote && (next === '"' || next === "'")))) {
				current += next;
				index += 1;
			} else {
				current += char;
			}
			continue;
		}
		if (quote) {
			if (char === quote) quote = "";
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) result.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current) result.push(current);
	return result;
}

function isUuid(value) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value));
}

function sameSessionId(left, right) {
	if (left === undefined || left === null || right === undefined || right === null) return false;
	const first = String(left);
	const second = String(right);
	return isUuid(first) && isUuid(second) ? first.toLowerCase() === second.toLowerCase() : first === second;
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

function emptyTerminationResult() {
	return { signalled: false, treeSignalled: false, forceSignalled: false, treeSignalCompletedAt: 0 };
}

function mergeTerminationResults(left = emptyTerminationResult(), right = emptyTerminationResult()) {
	return {
		signalled: Boolean(left.signalled || right.signalled),
		treeSignalled: Boolean(left.treeSignalled || right.treeSignalled),
		forceSignalled: Boolean(left.forceSignalled || right.forceSignalled),
		treeSignalCompletedAt: Math.max(left.treeSignalCompletedAt ?? 0, right.treeSignalCompletedAt ?? 0),
	};
}

function windowsTaskkillPath(env = process.env) {
	const root = environmentValue(env, "SystemRoot", "win32") || environmentValue(env, "WINDIR", "win32");
	return root ? path.join(root, "System32", "taskkill.exe") : "taskkill.exe";
}

function runWindowsTaskkill(pid, force) {
	try {
		const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
		const result = spawnSync(windowsTaskkillPath(), args, {
			stdio: "ignore",
			windowsHide: true,
			shell: false,
			timeout: PROCESS_FORCE_KILL_WAIT_MS,
		});
		return !result.error && result.status === 0;
	} catch {
		return false;
	}
}

function terminateChild(child, signal = "SIGTERM", options = {}) {
	if (!child) return emptyTerminationResult();
	const platform = options.platform ?? process.platform;
	const childExited = (child.exitCode !== null && child.exitCode !== undefined) || Boolean(child.signalCode);
	const pid = Number(child.pid);
	if (platform === "win32" && Number.isInteger(pid) && pid > 0) {
		// Windows has no stable process-group identifier once the root exits. Never
		// run taskkill against a closed/recyclable PID; target the complete tree while
		// the root is known live instead. If a non-force tree stop fails, immediately
		// retry /F before falling back to Node's direct-process-only kill.
		if (childExited) return emptyTerminationResult();
		// Node's child.kill() only terminates the direct process on Windows. taskkill
		// is invoked without a command shell so descendants cannot survive and keep
		// inherited handles open. /F is reserved for the escalation pass.
		const force = signal === "SIGKILL";
		const taskkill = options.runWindowsTaskkill ?? runWindowsTaskkill;
		if (taskkill(pid, force)) {
			return { signalled: true, treeSignalled: true, forceSignalled: force, treeSignalCompletedAt: Date.now() };
		}
		if (!force && taskkill(pid, true)) {
			// A successful /T /F fallback proves the tree is gone, but it is still a
			// force-kill. Native session mutations must abort and recover rather than
			// treating that shutdown as the graceful release of rollout storage.
			return { signalled: true, treeSignalled: true, forceSignalled: true, treeSignalCompletedAt: Date.now() };
		}
	}
	if (childExited && options.includeExitedGroup !== true) return emptyTerminationResult();
	if (platform !== "win32" && Number.isInteger(pid) && pid > 0) {
		try {
			// ACP and captured native commands are detached process-group leaders on
			// POSIX, so a negative pid reaches every descendant in the group.
			process.kill(-pid, signal);
			return { signalled: true, treeSignalled: true, forceSignalled: signal === "SIGKILL", treeSignalCompletedAt: 0 };
		} catch {
			// Fall back to the direct child if it was not a process-group leader or
			// exited between the state check and signal delivery.
		}
	}
	if (childExited) return emptyTerminationResult();
	try {
		const signalled = child.kill(signal);
		return {
			signalled,
			treeSignalled: false,
			forceSignalled: Boolean(signalled && signal === "SIGKILL"),
			treeSignalCompletedAt: 0,
		};
	} catch {
		return emptyTerminationResult();
	}
}

function posixProcessGroupExists(pid, platform = process.platform) {
	if (platform === "win32" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		// EPERM still proves that the group exists; only ESRCH proves quiescence.
		return error?.code !== "ESRCH";
	}
}

async function waitForProcessTreeExit(child, isDirectChildClosed, timeoutMs, termination = emptyTerminationResult(), options = {}) {
	const platform = options.platform ?? process.platform;
	const pid = Number(child?.pid);
	const trackPosixGroup = platform !== "win32" && Number.isInteger(pid) && pid > 0;
	const deadline = Date.now() + Math.max(1, timeoutMs);
	while (true) {
		const groupGone = trackPosixGroup ? !posixProcessGroupExists(pid, platform) : true;
		if (trackPosixGroup && groupGone) options.onPosixGroupGone?.();
		// taskkill /T's successful exit is Windows' process-tree completion
		// contract. Give termination delivery one scheduler interval after taskkill
		// itself exits and the root handle closes; never probe its now-recyclable PID.
		const windowsTreeSettled = termination.treeSignalled &&
			Date.now() - (termination.treeSignalCompletedAt ?? 0) >= WINDOWS_PROCESS_TREE_SETTLE_MS;
		const treeConfirmed = platform === "win32" ? windowsTreeSettled : groupGone;
		if (isDirectChildClosed() && treeConfirmed) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(PROCESS_TREE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
	}
}

async function waitForDirectChildExit(isDirectChildClosed, timeoutMs) {
	const deadline = Date.now() + Math.max(1, timeoutMs);
	while (!isDirectChildClosed()) {
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, Math.min(PROCESS_TREE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now()))));
	}
	return true;
}

function processTreeTerminationError(message) {
	const error = new Error(message);
	error.code = "PROCESS_TREE_TERMINATION_FAILED";
	return error;
}

function processTreeForceKilledError(message) {
	const error = new Error(message);
	error.code = "PROCESS_TREE_FORCE_KILLED";
	return error;
}

function codexCompletionUnconfirmedError(message, cause = undefined) {
	const error = new Error(message);
	error.code = "CODEX_COMPLETION_UNCONFIRMED";
	if (cause !== undefined) error.cause = cause;
	return error;
}

function sanitizeCodexSensitiveOperationError(error, message = "Codex operation failed") {
	const safe = new Error(message);
	if (typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/.test(error.code)) safe.code = error.code;
	safe.cause = error;
	return safe;
}

function isProcessTreeTerminationFailure(error) {
	return error?.code === "PROCESS_TREE_TERMINATION_FAILED";
}

function nativeProcessShutdownError(command = "native operation") {
	const error = new Error(`${command} was stopped because cc is exiting`);
	error.code = "CC_NATIVE_PROCESS_SHUTDOWN";
	return error;
}

class NativeProcessTracker {
	constructor() {
		this.entries = new Set();
		this.stopping = false;
		this.stopPromise = undefined;
	}

	assertOpen() {
		if (this.stopping) throw nativeProcessShutdownError();
	}

	register(stopAndWait) {
		this.assertOpen();
		const entry = {
			stopPromise: undefined,
			stopAndWait: () => {
				if (!entry.stopPromise) {
					try {
						// Invoke synchronously so every process is signalled before TUI
						// teardown or another shutdown callback can advance.
						entry.stopPromise = Promise.resolve(stopAndWait());
					} catch (error) {
						entry.stopPromise = Promise.reject(error);
					}
				}
				return entry.stopPromise;
			},
		};
		this.entries.add(entry);
		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			this.entries.delete(entry);
		};
	}

	stopAndWait() {
		if (this.stopPromise) return this.stopPromise;
		this.stopping = true;
		const entries = [...this.entries];
		// Calling each wrapper here (rather than in a later Promise callback) starts
		// every bounded tree teardown in the same synchronous shutdown phase.
		const waits = entries.map((entry) => entry.stopAndWait());
		this.stopPromise = Promise.allSettled(waits).then((results) => {
			const failure = results.find((result) => result.status === "rejected");
			if (failure) throw failure.reason;
			if (this.entries.size > 0) {
				throw processTreeTerminationError("one or more native process trees could not be confirmed stopped");
			}
		});
		return this.stopPromise;
	}
}

async function stopClientForNativeMutation(client) {
	if (!client) return;
	if (typeof client.stopAndWait === "function") {
		await client.stopAndWait();
		return;
	}
	// Lightweight test/dummy clients may only implement the original synchronous
	// contract. Production AcpClient instances always take the awaitable path.
	client.stop?.();
}

// Replacements have a different contract from native mutations: a confirmed
// force-kill is safe to proceed from, while an unconfirmed process tree is not.
// Test doubles and non-ACP adapters retain the original synchronous fallback.
export async function stopClientsForReplacement(clients) {
	const unique = [...new Set((Array.isArray(clients) ? clients : [clients]).filter(Boolean))];
	const results = await Promise.allSettled(unique.map(async (client) => {
		if (typeof client.stopAndWait !== "function") {
			client.stop?.();
			return;
		}
		try {
			await client.stopAndWait();
		} catch (error) {
			if (error?.code === "PROCESS_TREE_FORCE_KILLED") return;
			throw error;
		}
	}));
	const failure = results.find((result) => result.status === "rejected");
	if (failure) throw failure.reason;
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

// Retained as the auto-accept entry point for the adapter prototype
// (src/harness/acp-base.mjs). It now delegates to the shared engine, which picks
// the narrowest safe allow option rather than escalating to the broadest grant.
export function autoPermissionOutcome(params = {}) {
	return selectedOutcome(pickAllowOption(Array.isArray(params.options) ? params.options : [])?.optionId);
}

function humanizePermissionKind(kind) {
	if (!kind) return undefined;
	return String(kind)
		.replace(/_/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

export function cursorCancelResult(method) {
	if (method === "cursor/create_plan") return { outcome: { outcome: "rejected", reason: "Cancelled" } };
	if (method === "cursor/ask_question") return { outcome: { outcome: "cancelled" } };
	return {};
}

// A human-ish name for a cursor extension request, used as the "tool" when matching
// permission rules against an interactive cursor prompt.
export function cursorActionName(params = {}) {
	return params.name ?? params.title ?? params.overview ?? params.prompt;
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

function toolUpdateField(update, name) {
	const fields = isPlainObject(update?.fields) ? update.fields : undefined;
	return update?.[name] ?? fields?.[name];
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

export function localSlashCommands(app) {
	const focusedSideThread = app.focusedThread === "btw" ? app.btwThread : undefined;
	const focusedClient = focusedSideThread?.client ?? app.client;
	let state;
	if (focusedSideThread) {
		// A /btw fork has an independent ACP session and may advertise a different
		// model, effort, mode, fast toggle, or logout capability. Dynamic local
		// completion must follow the focused client rather than the main-session
		// snapshot or commands such as `/model <tab>` suggest invalid values.
		if (typeof focusedClient?.getSessionInfo === "function") {
			try {
				state = focusedClient.getSessionInfo();
			} catch {
				// An exiting side client may reject state inspection; use its last
				// published fields until the pane is retired.
			}
		}
		state ??= {
			sessionId: focusedClient?.sessionId,
			capabilities: focusedClient?.capabilities,
			configOptions: focusedClient?.configOptions,
			models: focusedClient?.models,
			modes: focusedClient?.modes,
		};
	} else {
		state = app.sessionStates.get(app.activeKey);
	}
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
		{ name: "cc-status", description: "Show cc wrapper and ACP session status" },
		{ name: "clear", description: "Clear the conversation" },
		{ name: "voice", description: "Enter voice input mode" },
		{ name: "btw", description: "Fork this conversation into a side thread (full context + tools)", argumentHint: "<question>" },
		{ name: "side", description: "Alias for /btw", argumentHint: "<question>" },
		{ name: "diff", description: "Show the working-tree git diff" },
		{ name: "copy", description: "Copy the last response to the clipboard" },
		{ name: "config", description: "Change any configuration option advertised by the agent" },
		{ name: "fast", description: "Toggle the agent's advertised fast mode", argumentHint: "[on|off]" },
		{ name: "delete", description: "Permanently delete a saved session", argumentHint: "[session-id|name]" },
		{ name: "login", description: "Authenticate the active ACP agent", argumentHint: "[method]" },
		{ name: "init", description: "Generate repository guidance in AGENTS.md" },
		{ name: "exit", description: "Exit cc" },
		{ name: "quit", description: "Exit cc" },
		themeSlashCommand(app),
	];
	if (app.isCodexBackendActive()) {
		commands.push(
			...(focusedSideThread
				? []
				: [{ name: "fork", description: "Fork this Codex session, optionally through an earlier turn", argumentHint: "[last-turn-id]" }]),
			{ name: "archive", description: "Archive the current or named Codex session", argumentHint: "[session-id|name]" },
			{ name: "unarchive", description: "Restore an archived Codex session", argumentHint: "<session-id|name>" },
			{ name: "plugins", description: "Browse, install, or remove Codex plugins and marketplaces", argumentHint: "[install|remove|refresh|marketplace]" },
			{ name: "hooks", description: "Inspect Codex lifecycle hooks (read-only)" },
			...(["darwin", "win32"].includes(app.platform ?? process.platform)
				? [{ name: "app", description: "Open this thread in Codex Desktop" }]
				: []),
			{ name: "apps", description: "Browse Codex apps and insert an app mention", argumentHint: "[refresh]" },
			codexFeedbackSlashCommand(),
			...(focusedSideThread
				? []
				: [
					{ name: "import", description: "Import detected Claude Code configuration and artifacts" },
					{ name: "memories", description: "Inspect or change Codex memory behavior", argumentHint: "[status|enable|on|off|use on|off|generate on|off|reset]" },
				]),
			{ name: "debug-config", description: "Show redacted Codex config layers and managed requirements" },
			codexMcpSlashCommand(),
			{ name: "doctor", description: "Run Codex installation diagnostics" },
			{ name: "experimental", description: "Inspect or toggle Codex feature flags", argumentHint: "[enable|disable] [feature]" },
			{ name: "rename", description: "Rename the active Codex session", argumentHint: "<name>" },
			{ name: "usage", description: "Show historical account usage and rate limits", argumentHint: "[reset]" },
			{ name: "cloud", description: "Run Codex Cloud workflows", argumentHint: "<list|status|diff|apply|exec> [arguments]" },
		);
	}
	const addIfMissing = (command) => {
		if (!commands.some((existing) => existing.name === command.name)) commands.push(command);
	};
	const capabilities = focusedClient?.capabilities ?? state?.capabilities;
	if (agentSupportsLogout(capabilities)) addIfMissing({ name: "logout", description: "Sign out of the active ACP agent" });

	addIfMissing({ name: "resume", description: "Resume a previous ACP session" });
	addIfMissing({ name: "new", description: "Start a new ACP session" });
	addIfMissing({ name: "model", description: "Change model" });
	addIfMissing({ name: "mode", description: "Change agent mode" });
	addIfMissing({ name: "effort", description: "Change reasoning effort" });
	addIfMissing({ name: "reasoning", description: "Change reasoning effort" });
	addIfMissing({ name: "thinking", description: "Change reasoning effort" });
	addIfMissing({ name: "plan", description: "Switch to plan mode or plan an inline request", argumentHint: "[prompt]" });
	addIfMissing({ name: "yolo", description: "Toggle auto-approve for this harness", argumentHint: "[ask|auto|deny]" });
	addIfMissing({ name: "auto", description: "Toggle auto-approve for this harness", argumentHint: "[ask|auto|deny]" });
	addIfMissing({ name: "permissions", description: "Select Codex permissions or manage remembered grants", argumentHint: "[read-only|auto|full-access|show|clear]" });

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

	const fastOption = findFastModeOption(state);
	if (fastOption) replaceCommand(commands, configSlashCommand("fast", "Toggle fast mode", fastOption));

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

function codexMcpSlashCommand() {
	const actions = [
		{ value: "list", label: "list", description: "List configured MCP servers" },
		{ value: "get", label: "get", description: "Show one MCP server (secrets redacted)" },
		{ value: "add", label: "add", description: "Add an MCP server" },
		{ value: "remove", label: "remove", description: "Remove an MCP server after confirmation" },
		{ value: "login", label: "login", description: "Authorize an MCP server" },
		{ value: "logout", label: "logout", description: "Revoke MCP authorization after confirmation" },
		{ value: "verbose", label: "verbose", description: "Show live-session MCP status through Codex ACP" },
	];
	return {
		name: "mcp",
		description: "Inspect live MCP tools or manage Codex MCP servers",
		argumentHint: "[verbose|list|get|add|remove|login|logout]",
		getArgumentCompletions: (prefix) => actions.filter((entry) => entry.value.startsWith(prefix.toLowerCase())),
	};
}

function codexFeedbackSlashCommand() {
	return {
		name: "feedback",
		description: "Send product feedback with an explicit diagnostics choice",
		argumentHint: "[bug|bad-result|good-result|safety-check|other] [note]",
		getArgumentCompletions: (prefix) => {
			const query = String(prefix ?? "").toLowerCase();
			if (/\s/.test(query)) return [];
			return CODEX_FEEDBACK_CATEGORIES
				.filter((entry) => entry.commandValue.startsWith(query))
				.map((entry) => ({
					value: entry.commandValue,
					label: entry.label,
					description: entry.description,
				}));
		},
	};
}

function shouldDeferLocalSlashCommand(name) {
	return ["resume", "fork", "model", "mode", "effort", "reasoning", "thinking", "plan", "config", "fast", "permissions", "delete", "archive", "unarchive", "login", "logout", "btw", "side", "theme", "plugins", "hooks", "app", "apps", "feedback", "import", "memories", "debug-config", "mcp", "doctor", "experimental", "rename", "usage", "cloud", "goal"].includes(name);
}

function shouldDeferBusyConfigCommand(name) {
	return ["model", "mode", "effort", "reasoning", "thinking", "plan", "config", "fast", "permissions", "rename", "usage", "cloud", "goal", "btw", "side", "memories"].includes(name);
}

function shouldDeferBusySideConfigCommand(name) {
	return ["model", "mode", "effort", "reasoning", "thinking", "plan", "config", "fast", "permissions"].includes(name);
}

function shouldDeferDuringLocalOperation(name) {
	return name === "new" || name === "clear" || shouldDeferLocalSlashCommand(name);
}

function replaceCommand(commands, command) {
	const index = commands.findIndex((entry) => entry.name === command.name);
	if (index >= 0) commands[index] = command;
	else commands.push(command);
}

function configSlashCommand(name, description, option) {
	const values = flattenConfigOptions(option);
	const argumentValue = (entry) => option?.type === "boolean" ? entry.name.toLowerCase() : String(entry.value);
	return {
		name,
		description,
		argumentHint: `[${values.map(argumentValue).join("|")}]`,
		getArgumentCompletions: (prefix) =>
			values
				.filter((entry) => argumentValue(entry).startsWith(prefix) || entry.name.toLowerCase().includes(prefix.toLowerCase()))
				.map((entry) => ({
					value: argumentValue(entry),
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

function formatUsageSummary(usage) {
	if (!usage || typeof usage !== "object") return undefined;
	if (Number.isFinite(usage.used) && Number.isFinite(usage.size)) {
		const percent = usage.size > 0 ? Math.round((usage.used / usage.size) * 100) : 0;
		return `context ${formatInteger(usage.used)}/${formatInteger(usage.size)} (${percent}%)`;
	}
	const total = usage.totalTokens ?? usage.total_tokens;
	return Number.isFinite(total) ? `tokens ${formatInteger(total)}` : undefined;
}

function formatCodexAccountUsage(usage = {}, rateLimitResponse = {}) {
	const summary = usage?.summary ?? {};
	const lines = ["### Codex account usage", ""];
	const facts = [
		Number.isFinite(summary.lifetimeTokens) ? `- Lifetime tokens: ${formatInteger(summary.lifetimeTokens)}` : undefined,
		Number.isFinite(summary.peakDailyTokens) ? `- Peak daily tokens: ${formatInteger(summary.peakDailyTokens)}` : undefined,
		Number.isFinite(summary.currentStreakDays) ? `- Current streak: ${formatInteger(summary.currentStreakDays)} days` : undefined,
		Number.isFinite(summary.longestStreakDays) ? `- Longest streak: ${formatInteger(summary.longestStreakDays)} days` : undefined,
		Number.isFinite(summary.longestRunningTurnSec) ? `- Longest turn: ${formatLongDuration(summary.longestRunningTurnSec)}` : undefined,
	].filter(Boolean);
	lines.push(...(facts.length > 0 ? facts : ["No historical token summary is available."]));
	const buckets = Array.isArray(usage?.dailyUsageBuckets) ? usage.dailyUsageBuckets.slice(-7) : [];
	if (buckets.length > 0) {
		lines.push("", "Recent daily tokens:", "");
		for (const bucket of buckets) lines.push(`- ${bucket.startDate}: ${formatInteger(bucket.tokens)}`);
	}
	const byId = rateLimitResponse?.rateLimitsByLimitId;
	const snapshots = byId && typeof byId === "object" && Object.keys(byId).length > 0
		? Object.entries(byId)
		: [[rateLimitResponse?.rateLimits?.limitId ?? "Codex", rateLimitResponse?.rateLimits]];
	const rateLines = [];
	for (const [id, snapshot] of snapshots) {
		if (!snapshot) continue;
		const bucket = snapshot.limitName ?? id;
		for (const window of [
			formatRateLimitWindow(`${bucket} primary`, snapshot.primary),
			formatRateLimitWindow(`${bucket} secondary`, snapshot.secondary),
		].filter(Boolean)) rateLines.push(window);
		if (snapshot.credits?.unlimited) rateLines.push(`${bucket} credits: unlimited`);
		else if (snapshot.credits?.balance !== undefined && snapshot.credits?.balance !== null) {
			rateLines.push(`${bucket} credit balance: ${snapshot.credits.balance}`);
		}
		if (snapshot.individualLimit && Number.isFinite(snapshot.individualLimit.remainingPercent)) {
			rateLines.push(`${bucket} spend limit: ${formatInteger(snapshot.individualLimit.remainingPercent)}% remaining`);
		}
	}
	if (rateLines.length > 0) lines.push("", "Rate limits:", "", ...rateLines.map((window) => `- ${window}`));
	const availableResets = rateLimitResponse?.rateLimitResetCredits?.availableCount;
	if (Number.isFinite(availableResets)) {
		lines.push("", `Earned reset credits: ${formatInteger(availableResets)}${availableResets > 0 ? " (use `/usage reset` to redeem one)" : ""}`);
	}
	return lines.join("\n");
}

function formatRateLimitWindow(label, window) {
	if (!window || !Number.isFinite(window.usedPercent)) return undefined;
	const reset = Number.isFinite(window.resetsAt) ? ` · resets ${new Date(window.resetsAt * 1000).toLocaleString()}` : "";
	const duration = Number.isFinite(window.windowDurationMins) ? ` · ${formatInteger(window.windowDurationMins)} min window` : "";
	return `${label}: ${formatInteger(window.usedPercent)}% used${duration}${reset}`;
}

function formatLongDuration(seconds) {
	const total = Math.max(0, Math.floor(Number(seconds) || 0));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	return [days ? `${days}d` : "", hours ? `${hours}h` : "", minutes || (!days && !hours) ? `${minutes}m` : ""].filter(Boolean).join(" ");
}

function formatResetCreditOutcome(outcome) {
	if (outcome === "reset") return "The eligible Codex rate-limit windows were reset.";
	if (outcome === "nothingToReset") return "No current rate-limit window is eligible for a reset.";
	if (outcome === "noCredit") return "No earned reset credit is available.";
	if (outcome === "alreadyRedeemed") return "This reset request was already redeemed.";
	return `Reset request completed${outcome ? `: ${oneLine(outcome)}` : "."}`;
}

function formatCodexGoal(goal = {}) {
	const lines = [`Goal: ${oneLine(goal.objective ?? "(untitled)")}`, `Status: ${goal.status ?? "unknown"}`];
	if (Number.isFinite(goal.tokensUsed)) {
		const budget = Number.isFinite(goal.tokenBudget) ? ` / ${formatInteger(goal.tokenBudget)}` : "";
		lines.push(`Tokens: ${formatInteger(goal.tokensUsed)}${budget}`);
	}
	if (Number.isFinite(goal.timeUsedSeconds)) lines.push(`Time: ${formatLongDuration(goal.timeUsedSeconds)}`);
	lines.push("Use /goal edit to revise the objective, or /goal pause|resume|clear.");
	return lines.join("\n");
}

function isCodexGoalThreadNotFoundError(error, sessionId) {
	const match = /^thread\/goal\/get failed \(-32600\): thread not found:\s*([0-9a-f-]+)\s*$/iu.exec(
		String(error?.message ?? error).trim(),
	);
	return Boolean(match && sameSessionId(match[1], sessionId));
}

function formatInteger(value) {
	return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function mergeEnvironments(sources, platform = process.platform) {
	const result = {};
	const canonicalNames = new Map();
	for (const source of Array.isArray(sources) ? sources : [sources]) {
		if (!source || typeof source !== "object") continue;
		for (const [name, value] of Object.entries(source)) {
			if (platform === "win32") {
				const canonical = name.toLowerCase();
				const previous = canonicalNames.get(canonical);
				if (previous && previous !== name) delete result[previous];
				canonicalNames.set(canonical, name);
			}
			result[name] = value;
		}
	}
	return result;
}

function environmentValue(env, name, platform = process.platform) {
	if (!env || typeof env !== "object") return undefined;
	if (platform !== "win32") return env[name];
	const canonical = name.toLowerCase();
	const key = Object.keys(env).findLast((entry) => entry.toLowerCase() === canonical);
	return key === undefined ? undefined : env[key];
}

function which(bin) {
	return Boolean(whichPath(bin));
}

function whichPath(bin, pathValue = environmentValue(process.env, "PATH"), platform = process.platform) {
	for (const candidate of executablePathCandidates(bin, pathValue, platform)) {
		try {
			fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
			return candidate;
		} catch {}
	}
	return undefined;
}

function whichPaths(bin, pathValue = environmentValue(process.env, "PATH"), platform = process.platform) {
	const matches = [];
	for (const candidate of executablePathCandidates(bin, pathValue, platform)) {
		try {
			fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
			if (!matches.includes(candidate)) matches.push(candidate);
		} catch {}
	}
	return matches;
}

function executablePathCandidates(bin, pathValue, platform) {
	if (!bin) return [];
	const extensions = platform === "win32" && !path.extname(bin) ? [".exe", ".cmd", ".bat", ""] : [""];
	const pathApi = platform === "win32" ? path.win32 : path;
	const pathLike = pathApi.isAbsolute(bin) || bin.includes("/") || bin.includes("\\");
	if (pathLike) {
		const base = pathApi.isAbsolute(bin) ? bin : path.resolve(bin);
		return extensions.map((ext) => `${base}${ext}`);
	}
	const candidates = [];
	const paths = (pathValue ?? "").split(platform === "win32" ? ";" : ":");
	for (const dir of paths) {
		if (!dir) continue;
		for (const ext of extensions) candidates.push(path.join(dir, `${bin}${ext}`));
	}
	return candidates;
}

function readNodePackage(packageRoot) {
	try {
		const packageJson = path.join(packageRoot, "package.json");
		const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
		return { packageJson, metadata };
	} catch {
		return undefined;
	}
}

function findNodePackageRootFromBin(executable, packageName) {
	if (!executable) return undefined;
	const candidates = [];
	const addCandidate = (candidate) => {
		if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
	};
	try {
		let current = path.dirname(fs.realpathSync(executable));
		while (true) {
			addCandidate(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
	} catch {}
	const lexicalDir = path.dirname(path.resolve(executable));
	const packageSegments = packageName.split("/");
	if (path.basename(lexicalDir).toLowerCase() === ".bin") {
		addCandidate(path.join(path.dirname(lexicalDir), ...packageSegments));
	}
	// npm's Windows global shims live directly in the prefix, with packages in
	// <prefix>/node_modules. Unlike POSIX links, realpath() cannot reveal the
	// JavaScript entrypoint behind a .cmd shim, so include that layout explicitly.
	addCandidate(path.join(lexicalDir, "node_modules", ...packageSegments));
	for (const candidate of candidates) {
		const pkg = readNodePackage(candidate);
		if (pkg?.metadata?.name === packageName && executableBelongsToPackage(executable, candidate)) return candidate;
	}
	return undefined;
}

function executableBelongsToPackage(executable, packageRoot) {
	const isInside = (candidate) => {
		if (!candidate) return false;
		const relative = path.relative(path.resolve(packageRoot), path.resolve(candidate));
		return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
	};
	try {
		if (isInside(fs.realpathSync(executable))) return true;
	} catch {}
	if (path.extname(executable).toLowerCase() !== ".cmd") return false;
	try {
		return isInside(windowsNodeShimEntrypoint(executable));
	} catch {
		return false;
	}
}

function compatibleNodePackageExecutableOnPath(bin, packageName, minimumVersion, env, platform = process.platform) {
	if (typeof bin !== "string" || !bin) return undefined;
	const pathValue = environmentValue(env, "PATH", platform);
	for (const executable of whichPaths(bin, pathValue, platform)) {
		const packageRoot = findNodePackageRootFromBin(executable, packageName);
		const metadata = packageRoot && readNodePackage(packageRoot)?.metadata;
		if (!metadata || metadata.name !== packageName) continue;
		if (minimumVersion && !versionAtLeast(metadata.version, minimumVersion)) continue;
		return executable;
	}
	return undefined;
}

export function resolveAgentAcpExecutable(agent, cwd = process.cwd(), env = mergedAgentEnvironment(agent), platform = process.platform) {
	const command = agent?.acp ?? agent;
	let executable = command?.command;
	if (agent?._requiredAgentName) {
		const compatible = compatibleNodePackageExecutableOnPath(
			executable,
			agent._requiredAgentName,
			agent._minimumAgentVersion,
			env,
			platform,
		);
		if (compatible) {
			executable = compatible;
			// npm's POSIX bin is normally a symlink to a Node entrypoint. Invoke
			// that entrypoint with the same Node already running cc, so an older
			// `node` executable from the shadowing PATH prefix cannot break startup.
			if (platform !== "win32") {
				let realExecutable = compatible;
				try { realExecutable = fs.realpathSync(compatible); } catch {}
				if ([".js", ".mjs", ".cjs"].includes(path.extname(realExecutable).toLowerCase())) {
					return { executable: process.execPath, prefixArgs: [realExecutable] };
				}
			}
		}
	}
	return resolveAcpExecutable(executable, cwd, env, platform);
}

function nodePackageBin(packageJson, binName) {
	try {
		const metadata = JSON.parse(fs.readFileSync(packageJson, "utf8"));
		const relative = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.[binName];
		if (typeof relative !== "string" || !relative) return undefined;
		const executable = path.resolve(path.dirname(packageJson), relative);
		return fs.existsSync(executable) ? executable : undefined;
	} catch {
		return undefined;
	}
}

function resolveDependencyPackageJson(packageRoot, dependencyName) {
	try {
		return createRequire(path.join(packageRoot, "package.json")).resolve(`${dependencyName}/package.json`);
	} catch {
		const nested = path.join(packageRoot, "node_modules", ...dependencyName.split("/"), "package.json");
		return fs.existsSync(nested) ? nested : undefined;
	}
}

function codexInvocationFromExecutable(executable) {
	if (!executable) return undefined;
	let real = executable;
	try {
		real = fs.realpathSync(executable);
	} catch {}
	const scriptExtensions = new Set([".js", ".mjs", ".cjs"]);
	if (scriptExtensions.has(path.extname(real).toLowerCase())) {
		return { command: process.execPath, args: [real] };
	}
	const shimExtensions = new Set([path.extname(executable).toLowerCase(), path.extname(real).toLowerCase()]);
	if (shimExtensions.has(".cmd") || shimExtensions.has(".bat")) {
		const packageRoot = findNodePackageRootFromBin(executable, "@openai/codex");
		const packageJson = packageRoot && path.join(packageRoot, "package.json");
		const entrypoint = packageJson && nodePackageBin(packageJson, "codex");
		if (!entrypoint || path.resolve(entrypoint) === path.resolve(executable)) return undefined;
		return codexInvocationFromExecutable(entrypoint);
	}
	return { command: executable, args: [] };
}

export function resolveCodexInvocation(agent = {}) {
	const env = mergedAgentEnvironment(agent);
	const explicit = environmentValue(env, "CODEX_PATH");
	const explicitPath = explicit && whichPath(explicit, environmentValue(env, "PATH"));
	const explicitInvocation = codexInvocationFromExecutable(explicitPath);
	if (explicitInvocation) return explicitInvocation;
	const acpCommand = agent?.acp?.command ?? "codex-acp";
	const acpPath = compatibleNodePackageExecutableOnPath(
		acpCommand,
		"@agentclientprotocol/codex-acp",
		agent?._minimumAgentVersion ?? "1.1.2",
		env,
	);
	if (acpPath) {
		const adapterRoot = findNodePackageRootFromBin(acpPath, "@agentclientprotocol/codex-acp");
		const packageJson = adapterRoot && resolveDependencyPackageJson(adapterRoot, "@openai/codex");
		const bundled = packageJson && nodePackageBin(packageJson, "codex");
		const bundledInvocation = codexInvocationFromExecutable(bundled);
		if (bundledInvocation) return bundledInvocation;
	}
	return codexInvocationFromExecutable(whichPath("codex", environmentValue(env, "PATH")));
}

function configuredAgentEnvironment(agent = {}) {
	const command = agent?.acp ?? agent;
	return mergeEnvironments([process.env, agent?.env, command?.env]);
}

function mergedAgentEnvironment(agent = {}) {
	const configured = configuredAgentEnvironment(agent);
	removeEnvironmentVariables(configured, agent?._signedOutAuthEnvNames);
	// Credentials supplied by an explicit /login are allowed to override the
	// post-logout mask. They remain session-only and are removed by the next
	// successful logout.
	return mergeEnvironments([configured, agent?._sessionAuthEnv]);
}

export function agentSupportsLogout(capabilities) {
	return Boolean(capabilities?.auth?.logout);
}

function hasConfiguredCodexApiKey(agent = {}) {
	// This check gates an explicit /login action, so it must see configured keys
	// even while normal child launches are intentionally masking them after
	// /logout.
	const env = configuredAgentEnvironment(agent);
	return Boolean(configuredCodexApiKey(env));
}

function codexApiKeyAuthenticationMeta(agent = {}) {
	const apiKey = configuredCodexApiKey(configuredAgentEnvironment(agent));
	return apiKey ? { "api-key": { apiKey } } : undefined;
}

function configuredCodexApiKey(environment) {
	return environmentValue(environment, "CODEX_API_KEY") || environmentValue(environment, "OPENAI_API_KEY");
}

function signedOutAuthenticationEnvironmentNames(authMethods = [], agent = {}) {
	const names = new Set();
	for (const method of Array.isArray(authMethods) ? authMethods : []) {
		for (const variable of Array.isArray(method?.vars) ? method.vars : []) {
			if (isEnvironmentVariableName(variable?.name)) names.add(variable.name);
		}
		// The standard Codex API-key method predates typed env_var metadata. Cover
		// both accepted names so configured keys from any environment layer cannot
		// immediately undo a successful logout.
		if (String(method?.id ?? "").toLowerCase().replace(/[-_]/g, "") === "apikey") {
			names.add("CODEX_API_KEY");
			names.add("OPENAI_API_KEY");
		}
	}
	for (const name of Object.keys(agent?._sessionAuthEnv ?? {})) {
		if (isEnvironmentVariableName(name)) names.add(name);
	}
	return [...names];
}

function maskSignedOutAuthenticationEnvironment(agent, names) {
	if (!agent || typeof agent !== "object") return;
	const merged = new Set([
		...(Array.isArray(agent._signedOutAuthEnvNames) ? agent._signedOutAuthEnvNames : []),
		...(Array.isArray(names) ? names : []),
	].filter(isEnvironmentVariableName));
	if (merged.size > 0) agent._signedOutAuthEnvNames = [...merged];
}

function clearSignedOutAuthenticationEnvironment(agent) {
	if (agent && typeof agent === "object") delete agent._signedOutAuthEnvNames;
}

function removeEnvironmentVariables(environment, names, platform = process.platform) {
	if (!environment || typeof environment !== "object" || !Array.isArray(names) || names.length === 0) return environment;
	const masked = new Set(
		names
			.filter(isEnvironmentVariableName)
			.map((name) => platform === "win32" ? name.toLowerCase() : name),
	);
	for (const name of Object.keys(environment)) {
		const canonical = platform === "win32" ? name.toLowerCase() : name;
		if (masked.has(canonical)) delete environment[name];
	}
	return environment;
}

function isEnvironmentVariableName(name) {
	return typeof name === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

export function normalizeAdditionalDirectories(value, cwd = process.cwd()) {
	if (!Array.isArray(value)) return [];
	const seen = new Set([path.resolve(cwd)]);
	const result = [];
	for (const entry of value) {
		if (typeof entry !== "string" || !entry.trim()) continue;
		const expanded = entry === "~" ? os.homedir() : /^~[\\/]/.test(entry) ? path.join(os.homedir(), entry.slice(2)) : entry;
		const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
		if (seen.has(absolute)) continue;
		seen.add(absolute);
		result.push(absolute);
	}
	return result;
}

function normalizeNameValuePairs(value) {
	if (Array.isArray(value)) {
		return value
			.filter((entry) => entry && typeof entry.name === "string" && typeof entry.value === "string")
			.map((entry) => ({ name: entry.name, value: entry.value }));
	}
	if (isPlainObject(value)) {
		return Object.entries(value)
			.filter(([, entry]) => typeof entry === "string")
			.map(([name, entry]) => ({ name, value: entry }));
	}
	return [];
}

export function normalizeMcpServers(value, capabilities = undefined, env = process.env, platform = process.platform) {
	if (!Array.isArray(value)) return [];
	const result = [];
	for (const server of value) {
		if (!isPlainObject(server) || typeof server.name !== "string" || !server.name.trim()) continue;
		if (server.type === "http") {
			// HTTP transport is opt-in at the protocol level. Treat a missing
			// capability descriptor as unsupported instead of guessing during the
			// initialize/session boundary.
			if (capabilities?.http !== true) continue;
			if (typeof server.url !== "string" || !/^https?:\/\//i.test(server.url)) continue;
			result.push({ type: "http", name: server.name, url: server.url, headers: normalizeNameValuePairs(server.headers) });
			continue;
		}
		if (server.type && server.type !== "stdio") continue;
		if (typeof server.command !== "string" || !server.command.trim()) continue;
		const executable = whichPath(server.command, environmentValue(env, "PATH", platform), platform);
		if (!executable) continue;
		let command = executable;
		let prefixArgs = [];
		if (platform === "win32") {
			let realExecutable = executable;
			try {
				realExecutable = fs.realpathSync(executable);
			} catch {}
			const extensions = [executable, realExecutable].map((entry) => path.extname(entry).toLowerCase());
			if (extensions.some((extension) => extension === ".bat" || extension === ".ps1")) continue;
			if (extensions.includes(".cmd")) {
				const shim = path.extname(realExecutable).toLowerCase() === ".cmd" ? realExecutable : executable;
				try {
					prefixArgs = [windowsNodeShimEntrypoint(shim)];
					command = process.execPath;
				} catch {
					// Running a batch file through a shell would reinterpret MCP arguments.
					// Only npm-style Node shims have a shell-free, deterministic equivalent.
					continue;
				}
			} else if ([".js", ".mjs", ".cjs"].includes(path.extname(realExecutable).toLowerCase())) {
				command = process.execPath;
				prefixArgs = [realExecutable];
			}
		}
		result.push({
			name: server.name,
			command,
			args: [...prefixArgs, ...stringArray(server.args)],
			env: normalizeNameValuePairs(server.env),
		});
	}
	return result;
}

export async function runCodexCommand(invocation, args, agent = {}, options = {}) {
	if (!invocation?.command) throw new Error("no compatible Codex CLI invocation was found");
	let realCommand = invocation.command;
	try {
		realCommand = fs.realpathSync(invocation.command);
	} catch {}
	const commandExtensions = [path.extname(invocation.command), path.extname(realCommand)].map((extension) => extension.toLowerCase());
	if (commandExtensions.some((extension) => extension === ".cmd" || extension === ".bat")) {
		throw new Error("refusing to launch a Codex command shim directly");
	}
	return await runCapture(invocation.command, [...(invocation.args ?? []), ...args], {
		timeoutMs: options.timeoutMs ?? CODEX_COMMAND_TIMEOUT_MS,
		terminationGraceMs: options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
		env: mergedAgentEnvironment(agent),
		rejectOnExit: options.rejectOnExit !== false,
		...(Number.isFinite(options.maxStdoutBytes) ? { maxStdoutBytes: options.maxStdoutBytes } : {}),
		...(Number.isFinite(options.maxStderrBytes) ? { maxStderrBytes: options.maxStderrBytes } : {}),
		processTracker: options.processTracker,
	});
}

export async function runCodexAppServerRequests(invocation, requests, agent = {}, options = {}) {
	if (!invocation?.command) throw new Error("no compatible Codex CLI invocation was found");
	if (!Array.isArray(requests) || requests.some((request) => typeof request?.method !== "string" || !request.method)) {
		throw new Error("invalid Codex app-server request list");
	}
	if (
		options.waitForNotification !== undefined &&
		(
			!options.waitForNotification ||
			typeof options.waitForNotification !== "object" ||
			typeof options.waitForNotification.method !== "string" ||
			!options.waitForNotification.method
		)
	) {
		throw new Error("invalid Codex app-server completion notification");
	}
	if (
		options.waitForNotification?.matches !== undefined &&
		typeof options.waitForNotification.matches !== "function"
	) {
		throw new Error("invalid Codex app-server completion matcher");
	}
	let realCommand = invocation.command;
	try {
		realCommand = fs.realpathSync(invocation.command);
	} catch {}
	const extensions = [path.extname(invocation.command), path.extname(realCommand)].map((extension) => extension.toLowerCase());
	if (extensions.some((extension) => extension === ".cmd" || extension === ".bat")) {
		throw new Error("refusing to launch a Codex command shim directly");
	}
	const spawnProcess = options.spawnImpl ?? spawn;
	const timeoutMs = options.timeoutMs ?? CODEX_COMMAND_TIMEOUT_MS;
	const terminationGraceMs = options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
	const extraReadOnlyMethods = new Set([
		"externalAgentConfig/detect",
		"externalAgentConfig/import/readHistories",
	]);
	const hasStateChangingRequest = requests.some(
		(request) => !/\/(?:read|get|list)$/.test(request.method) && !extraReadOnlyMethods.has(request.method),
	);
	return await new Promise((resolve, reject) => {
		options.processTracker?.assertOpen();
		let child;
		try {
			child = spawnProcess(invocation.command, [...(invocation.args ?? []), "app-server", "--stdio"], {
				cwd: options.cwd ?? process.cwd(),
				env: mergedAgentEnvironment(agent),
				detached: process.platform !== "win32",
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (error) {
			reject(error);
			return;
		}
		const decoder = new StringDecoder("utf8");
		let stdoutBuffer = "";
		let stderr = "";
		let settled = false;
		let completed = false;
		let requestsCompleted = false;
		let teardownStarted = false;
		let teardownPromise;
		let directChildClosed = false;
		let activeId = 1;
		let requestIndex = -1;
		const results = [];
		const pendingCompletionNotifications = [];
		let pendingCompletionNotificationBytes = 0;
		let closeTimer;
		let timer;
		let unregister = () => {};
		const finish = (inputError) => {
			if (settled) return;
			let error = inputError;
			if (error && typeof options.sanitizeError === "function") {
				try {
					const sanitized = options.sanitizeError(error);
					if (sanitized instanceof Error) error = sanitized;
					else throw new Error("error sanitizer did not return an Error");
				} catch {
					const safe = new Error("Codex app-server request failed");
					safe.code = error?.code;
					safe.cause = error;
					error = safe;
				}
			}
			settled = true;
			clearTimeout(timer);
			if (closeTimer) clearTimeout(closeTimer);
			unregister();
			if (error) reject(error);
			else resolve(results);
		};
		const teardownAndFinish = (inputError = undefined) => {
			if (settled) return Promise.resolve();
			if (teardownPromise) return teardownPromise;
			let error = inputError;
			teardownStarted = true;
			clearTimeout(timer);
			if (closeTimer) clearTimeout(closeTimer);
			try { child.stdin?.end(); } catch {}
			teardownPromise = (async () => {
				// The bundled Codex JavaScript launcher owns a native app-server child.
				// Signal and await the complete tree: killing only the wrapper can orphan
				// that native process with inherited account credentials and database files.
				// Try a graceful tree stop on Windows too. terminateChild will immediately
				// fall back to taskkill /T /F if /T alone fails, and marks that fallback so
				// a state-changing app-server caller does not mistake forceful teardown for
				// an ordinary, fully settled completion.
				const initialSignal = "SIGTERM";
				let termination = terminateChild(child, initialSignal, { includeExitedGroup: true });
				let treeExited = await waitForProcessTreeExit(
					child,
					() => directChildClosed,
					terminationGraceMs,
					termination,
				);
				if (!treeExited) {
					termination = mergeTerminationResults(
						termination,
						terminateChild(child, "SIGKILL", { includeExitedGroup: true }),
					);
					treeExited = await waitForProcessTreeExit(
						child,
						() => directChildClosed,
						PROCESS_FORCE_KILL_WAIT_MS,
						termination,
					);
				}
				if (!treeExited) {
					const prefix = error?.message ? `${error.message}; ` : "";
					finish(processTreeTerminationError(`${prefix}Codex app-server process tree did not exit after SIGKILL`));
					return;
				}
				if (
					!error &&
					termination.forceSignalled &&
					hasStateChangingRequest &&
					options.acceptForcedTeardownAfterResponse !== true
				) {
					finish(processTreeForceKilledError("Codex app-server process tree required forceful termination"));
					return;
				}
				finish(error);
			})();
			return teardownPromise;
		};
		unregister = options.processTracker?.register(
			() => teardownAndFinish(nativeProcessShutdownError("Codex app-server")),
		) ?? unregister;
		const complete = () => {
			if (completed || settled) return;
			completed = true;
			clearTimeout(timer);
			// The final response completes the logical operation, but the helper still
			// owns a process tree. Start teardown now, while Windows still has a valid
			// root PID for taskkill /T; POSIX likewise confirms the detached group gone
			// before exposing completion to the caller.
			void teardownAndFinish();
		};
		const completionFailure = (message, cause = undefined) =>
			requestsCompleted && options.waitForNotification && !completed
				? codexCompletionUnconfirmedError(message, cause)
				: (cause instanceof Error ? cause : new Error(message));
		const tryCompletionNotification = (params) => {
			const expected = options.waitForNotification;
			if (!expected || !requestsCompleted || completed || settled) return false;
			let matches = true;
			try {
				if (typeof expected.matches === "function") matches = expected.matches(params, results) === true;
			} catch (error) {
				void teardownAndFinish(completionFailure("Codex accepted the request, but its completion notification could not be validated", error));
				return false;
			}
			if (!matches) return false;
			results.push(params ?? {});
			complete();
			return true;
		};
		const finishRequests = () => {
			requestsCompleted = true;
			if (!options.waitForNotification) {
				complete();
				return;
			}
			for (const params of pendingCompletionNotifications) {
				if (tryCompletionNotification(params)) return;
			}
			pendingCompletionNotifications.length = 0;
			pendingCompletionNotificationBytes = 0;
		};
		const write = (message) => {
			if (settled) return;
			try {
				child.stdin.write(`${JSON.stringify(message)}\n`);
			} catch (error) {
				void teardownAndFinish(error);
			}
		};
		const sendNext = () => {
			requestIndex += 1;
			if (requestIndex >= requests.length) {
				finishRequests();
				return;
			}
			activeId += 1;
			const request = requests[requestIndex];
			write({ id: activeId, method: request.method, ...(request.params !== undefined ? { params: request.params } : {}) });
		};
		const handleLine = (line) => {
			if (!line.trim() || settled) return;
			let message;
			try {
				message = JSON.parse(line);
			} catch (error) {
				void teardownAndFinish(completionFailure("Codex app-server returned invalid JSON", error));
				return;
			}
			if (typeof message?.method === "string") {
				if (
					message.id === undefined &&
					options.waitForNotification?.method === message.method
				) {
					const params = message.params ?? {};
					if (!tryCompletionNotification(params) && !requestsCompleted) {
						let size = 0;
						try { size = Buffer.byteLength(JSON.stringify(params)); } catch {}
						if (pendingCompletionNotificationBytes + size > 1024 * 1024) {
							void teardownAndFinish(new Error("Codex app-server completion notifications exceeded the safety limit"));
							return;
						}
						pendingCompletionNotificationBytes += size;
						pendingCompletionNotifications.push(params);
					}
					return;
				}
				// Account/name/goal operations should never need interactive callbacks.
				// Reject an unexpected server request promptly instead of leaving it hung;
				// notifications (no id) are intentionally ignored.
				if (message.id !== undefined) {
					write({ id: message.id, error: { code: -32601, message: `Unsupported app-server request: ${message.method}` } });
				}
				return;
			}
			if (message?.id !== activeId) return;
			if (message.error) {
				const detail = message.error.message ?? JSON.stringify(message.error);
				const method = requestIndex < 0 ? "initialize" : requests[requestIndex]?.method;
				void teardownAndFinish(new Error(`${method} failed${message.error.code === undefined ? "" : ` (${message.error.code})`}: ${detail}`));
				return;
			}
			if (requestIndex < 0) {
				write({ method: "initialized" });
				sendNext();
				return;
			}
			results.push(message.result ?? {});
			sendNext();
		};

		child.stdout?.on("data", (chunk) => {
			stdoutBuffer += decoder.write(Buffer.from(chunk));
			if (stdoutBuffer.length > 8 * 1024 * 1024) {
				void teardownAndFinish(completionFailure("Codex app-server response exceeded the safety limit"));
				return;
			}
			let newline;
			while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
				const line = stdoutBuffer.slice(0, newline).replace(/\r$/, "");
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				handleLine(line);
				if (settled) return;
			}
		});
		child.stdout?.on("end", () => {
			stdoutBuffer += decoder.end();
			if (stdoutBuffer.trim()) {
				const finalLine = stdoutBuffer.replace(/\r$/, "");
				stdoutBuffer = "";
				handleLine(finalLine);
			}
		});
		child.stderr?.on("data", (chunk) => {
			const remaining = 64 * 1024 - stderr.length;
			if (remaining > 0) stderr += Buffer.from(chunk).toString("utf8").slice(0, remaining);
		});
		child.stdin?.once("error", (error) => {
			if (!completed && !teardownStarted) {
				void teardownAndFinish(completionFailure("Codex accepted the request, but its input stream failed before completion", error));
			}
		});
		child.once("error", (error) => {
			if (settled || teardownStarted) return;
			// A spawn failure has no process tree to reap and is followed by close.
			// Avoid waiting for a Windows tree signal that can never exist without a PID.
			if (!Number.isInteger(Number(child.pid)) || Number(child.pid) <= 0) {
				finish(completed ? undefined : completionFailure("Codex accepted the request, but its process failed before confirming completion", error));
				return;
			}
			void teardownAndFinish(completed ? undefined : completionFailure("Codex accepted the request, but its process failed before confirming completion", error));
		});
		child.once("close", (code, signal) => {
			directChildClosed = true;
			if (closeTimer) clearTimeout(closeTimer);
			if (settled || teardownStarted) return;
			if (completed) {
				// taskkill /T is issued while the root is live on Windows. A normal root
				// close is the only safe signal available there; on POSIX, the stable
				// detached group id lets us also sweep a stray descendant after close.
				if (process.platform === "win32") finish();
				else void teardownAndFinish();
				return;
			}
			const detail = oneLine(stderr.trim());
			const error = completionFailure(
				"Codex accepted the request, but exited before confirming completion",
				new Error(`Codex app-server exited ${signal ?? code ?? "without a status"}${detail ? `: ${detail}` : ""}`),
			);
			if (process.platform === "win32") finish(error);
			else void teardownAndFinish(error);
		});
		timer = setTimeout(() => {
			void teardownAndFinish(completionFailure(
				"Codex accepted the request, but its completion notification was not received before timeout",
				new Error("Codex app-server timed out"),
			));
		}, timeoutMs);
		timer.unref?.();
		write({
			id: activeId,
			method: "initialize",
			params: {
				clientInfo: { name: "cc", title: "cc", version: "0.1.0" },
				capabilities: options.capabilities ?? null,
			},
		});
	});
}

export async function collectEnvironmentAuthenticationVariables(method, env = process.env, options = {}) {
	if (!Array.isArray(method?.vars) || method.vars.length === 0) {
		throw new Error("environment authentication did not advertise any variables");
	}
	if (options.signal?.aborted) throw environmentAuthenticationAbortError(options.signal);
	const prompt = options.prompt ?? promptEnvironmentAuthenticationValue;
	const credentials = {};
	if (method.link && options.output !== false) {
		const output = options.output ?? process.stdout;
		try {
			const link = new URL(method.link);
			if (link.protocol === "https:" || link.protocol === "http:") output.write?.(`Credentials: ${link.href}\n`);
		} catch {}
	}
	for (const variable of method.vars) {
		if (options.signal?.aborted) throw environmentAuthenticationAbortError(options.signal);
		const name = variable?.name;
		if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			throw new Error("environment authentication advertised an invalid variable name");
		}
		const label = singleLineMenuText(variable.label ?? name) || name;
		const configured = environmentValue(env, name);
		if (typeof configured === "string" && configured.length > 0) {
			credentials[name] = configured;
			continue;
		}
		const value = await prompt(variable, options);
		if (value === undefined || value === null) throw new Error("authentication cancelled");
		if (typeof value !== "string" || value.includes("\0")) throw new Error(`${label} must be text without NUL bytes`);
		if (!value && variable.optional !== true) throw new Error(`${label} is required`);
		if (value) credentials[name] = value;
	}
	return credentials;
}

function environmentAuthenticationAbortError(signal) {
	if (signal?.reason instanceof Error) return signal.reason;
	return new Error("authentication cancelled");
}

function promptEnvironmentAuthenticationValue(variable, options = {}) {
	const input = options.input ?? process.stdin;
	const output = options.output ?? process.stdout;
	if (options.signal?.aborted) throw environmentAuthenticationAbortError(options.signal);
	if (!input?.isTTY || !output?.isTTY || typeof input.on !== "function") {
		throw new Error(`set ${variable.name} in the agent environment before using this authentication method`);
	}
	const secret = variable.secret !== false;
	const optional = variable.optional === true ? " (optional)" : "";
	const label = singleLineMenuText(variable.label ?? variable.name) || variable.name;
	output.write(`${label}${optional}: `);
	return new Promise((resolve, reject) => {
		const decoder = new StringDecoder("utf8");
		const wasRaw = Boolean(input.isRaw);
		const wasPaused = input.isPaused?.() ?? false;
		let value = "";
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			input.off("data", onData);
			options.signal?.removeEventListener?.("abort", onAbort);
			try {
				input.setRawMode?.(wasRaw);
			} catch {}
			if (wasPaused) input.pause?.();
			output.write("\n");
			if (error) reject(error);
			else resolve(value);
		};
		const onData = (chunk) => {
			let text = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			if (text === "\x1b" || text.includes("\x03") || text.includes("\x04")) {
				finish(new Error("authentication cancelled"));
				return;
			}
			text = text
				.replace(/\x1b\[200~/g, "")
				.replace(/\x1b\[201~/g, "")
				.replace(/\x1b\[[0-9;:]*[A-Za-z~]/g, "");
			for (const character of Array.from(text)) {
				if (character === "\r" || character === "\n") {
					finish();
					return;
				}
				if (character === "\x7f" || character === "\b") {
					if (value) {
						value = Array.from(value).slice(0, -1).join("");
						output.write("\b \b");
					}
					continue;
				}
				if (character < " ") continue;
				value += character;
				output.write(secret ? "*" : character);
			}
		};
		const onAbort = () => finish(environmentAuthenticationAbortError(options.signal));
		options.signal?.addEventListener?.("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		input.on("data", onData);
		try {
			input.setRawMode?.(true);
			input.resume?.();
		} catch (error) {
			finish(error);
		}
	});
}

function terminalAuthArguments(value, label) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.includes("\0"))) {
		throw new Error(`${label} must contain only strings without NUL bytes`);
	}
	return [...value];
}

function terminalAuthEnvironment(value) {
	if (value === undefined) return {};
	if (!isPlainObject(value)) throw new Error("terminal authentication environment must be an object");
	const result = {};
	for (const [name, entry] of Object.entries(value)) {
		if (!name || name.includes("=") || name.includes("\0")) {
			throw new Error(`invalid terminal authentication environment variable: ${name}`);
		}
		if (typeof entry !== "string" || entry.includes("\0")) {
			throw new Error(`terminal authentication environment variable ${name} must be a string without NUL bytes`);
		}
		result[name] = entry;
	}
	return result;
}

function windowsNodeShimEntrypoint(shimPath) {
	let content;
	try {
		content = fs.readFileSync(shimPath, "utf8");
	} catch {
		throw new Error("the configured ACP agent command shim is unreadable");
	}
	if (content.length > 64 * 1024 || content.includes("\0")) {
		throw new Error("the configured ACP agent command shim is invalid");
	}
	// npm's generated .cmd launchers reference their JavaScript entrypoint via
	// either %dp0% or %~dp0. Extract only that local file path; never execute or
	// interpolate the batch program itself.
	const match = content.match(/(?:%~dp0|%dp0%)\\([^"\r\n]+?\.(?:cjs|mjs|js))(?=["\s])/i);
	const relative = match?.[1];
	if (!relative || relative.includes("%")) throw new Error("the configured ACP agent command shim has no safe Node entrypoint");
	const entrypoint = path.resolve(path.dirname(shimPath), relative.replaceAll("\\", path.sep));
	try {
		if (!fs.statSync(entrypoint).isFile()) throw new Error();
	} catch {
		throw new Error("the configured ACP agent command shim entrypoint is unavailable");
	}
	return entrypoint;
}

export function resolveAcpExecutable(command, cwd, env, platform = process.platform) {
	if (typeof command !== "string" || !command.trim() || command.includes("\0")) {
		throw new Error("the configured ACP agent has no valid executable");
	}
	const hasSeparator = command.includes("/") || (platform === "win32" && command.includes("\\"));
	let resolved;
	if (path.isAbsolute(command) || hasSeparator) {
		const candidate = path.resolve(cwd, command);
		try {
			fs.accessSync(candidate, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
			resolved = candidate;
		} catch {
			throw new Error("the configured ACP agent executable is unavailable");
		}
	} else {
		resolved = whichPath(command, environmentValue(env, "PATH", platform), platform);
		if (!resolved) throw new Error("the configured ACP agent executable is unavailable");
	}
	if (platform !== "win32") return { executable: resolved, prefixArgs: [] };
	let realExecutable = resolved;
	try {
		realExecutable = fs.realpathSync(resolved);
	} catch {}
	const extensions = [resolved, realExecutable].map((value) => path.extname(value).toLowerCase());
	if (extensions.includes(".bat")) throw new Error("batch-file ACP launchers are not supported");
	if (extensions.includes(".cmd")) {
		const shim = path.extname(realExecutable).toLowerCase() === ".cmd" ? realExecutable : resolved;
		return { executable: process.execPath, prefixArgs: [windowsNodeShimEntrypoint(shim)] };
	}
	if ([".js", ".mjs", ".cjs"].includes(path.extname(realExecutable).toLowerCase())) {
		return { executable: process.execPath, prefixArgs: [realExecutable] };
	}
	return { executable: resolved, prefixArgs: [] };
}

// ACP terminal authentication deliberately cannot choose an executable. It uses
// the same compatibility-aware agent resolution as normal startup, with the
// normal args/env plus the advertised additions. Resolving before applying
// method.env prevents a method from replacing a PATH-resolved executable;
// shell:false keeps backend-provided arguments literal.
export async function runTerminalAuthentication(agent, method, options = {}) {
	if (method?.type !== "terminal") throw new Error("not a terminal authentication method");
	const command = agent?.acp ?? agent;
	const cwd = options.cwd ?? process.cwd();
	const platform = options.platform ?? process.platform;
	const baseEnv = mergeEnvironments([options.env ?? process.env, agent?.env, command?.env], platform);
	const { executable, prefixArgs } = resolveAgentAcpExecutable(agent, cwd, baseEnv, platform);
	const args = [
		...prefixArgs,
		...terminalAuthArguments(command?.args, "configured ACP arguments"),
		...terminalAuthArguments(method.args, "terminal authentication arguments"),
	];
	const env = mergeEnvironments([baseEnv, terminalAuthEnvironment(method.env)], platform);
	const spawnProcess = options.spawnImpl ?? spawn;
	return await new Promise((resolve, reject) => {
		options.processTracker?.assertOpen();
		let child;
		try {
			child = spawnProcess(executable, args, {
				cwd,
				env,
				detached: platform !== "win32",
				shell: false,
				stdio: "inherit",
			});
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		let terminating = false;
		let terminationPromise;
		let directChildClosed = false;
		let unregister = () => {};
		const finish = (error) => {
			if (settled) return;
			settled = true;
			unregister();
			if (error) reject(error);
			else resolve();
		};
		const terminateProcessTree = () => {
			if (settled) return Promise.resolve();
			if (terminationPromise) return terminationPromise;
			terminating = true;
			terminationPromise = (async () => {
				const initialSignal = process.platform === "win32" ? "SIGKILL" : "SIGTERM";
				let termination = terminateChild(child, initialSignal);
				let treeExited = await waitForProcessTreeExit(
					child,
					() => directChildClosed,
					options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS,
					termination,
				);
				if (!treeExited) {
					termination = mergeTerminationResults(
						termination,
						terminateChild(child, "SIGKILL", { includeExitedGroup: true }),
					);
					treeExited = await waitForProcessTreeExit(
						child,
						() => directChildClosed,
						PROCESS_FORCE_KILL_WAIT_MS,
						termination,
					);
				}
				if (!treeExited) {
					finish(processTreeTerminationError(
						`${executable} authentication process tree did not exit after SIGKILL`,
					));
					return;
				}
				finish(nativeProcessShutdownError(`${executable} authentication`));
			})();
			return terminationPromise;
		};
		unregister = options.processTracker?.register(terminateProcessTree) ?? unregister;
		child.once("error", (error) => {
			if (!terminating) finish(error);
		});
		child.once("close", (code, signal) => {
			directChildClosed = true;
			if (terminating || settled) return;
			if (code === 0) finish();
			else finish(new Error(`terminal authentication exited ${signal ?? code ?? "without a status"}`));
		});
	});
}

function pluginSelector(plugin = {}) {
	const id = String(plugin.pluginId ?? plugin.id ?? plugin.name ?? "").trim();
	if (!id) return "";
	const marketplace = String(plugin.marketplaceName ?? plugin.marketplace ?? "").trim();
	return marketplace && !id.includes("@") ? `${id}@${marketplace}` : id;
}

const CODEX_MCP_MANAGEMENT_ACTIONS = new Set(["list", "get", "add", "remove", "login", "logout"]);

export function isCodexMcpManagementAction(value) {
	return CODEX_MCP_MANAGEMENT_ACTIONS.has(String(value ?? "").toLowerCase());
}

export function isCodexMcpManagementArgument(argument = "") {
	return isCodexMcpManagementAction(splitCommandArguments(argument)[0]);
}

export function codexMcpCliArguments(args = []) {
	const literal = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
	const action = literal[0]?.toLowerCase();
	const result = ["mcp", ...literal];
	if ((action === "list" || action === "get") && !literal.includes("--json")) result.push("--json");
	return result;
}

export function codexAppMention(appId, displayName = appId) {
	if (typeof appId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/.test(appId)) {
		throw new Error("Codex returned an app identifier that cannot be inserted safely");
	}
	const fullSlug = [...String(displayName ?? "").slice(0, 512)]
		.map((character) => /[A-Za-z0-9]/.test(character) ? character.toLowerCase() : "-")
		.join("")
		.replace(/^-+|-+$/g, "");
	const slug = fullSlug.slice(0, 128).replace(/-+$/g, "") || "app";
	// Codex's native TUI resolves a visible $slug into this collision-safe linked
	// form before submitting. codex-acp forwards plain text without that resolver,
	// so cc must preserve the app:// target explicitly for Codex core to activate
	// the selected connector.
	return `[$${slug}](app://${appId})`;
}

export function formatCodexMcpCommandDisplay(args = [], commandName = "mcp") {
	const action = singleLineMenuText(args[0] ?? "").toLowerCase();
	if (!action) return `/${commandName}`;
	const server = action === "list" ? "" : singleLineMenuText(args[1] ?? "").slice(0, 160);
	const hidden = args.length > (action === "list" ? 1 : 2) ? " …" : "";
	return `/${commandName} ${action}${server ? ` ${server}` : ""}${hidden}`;
}

function sensitiveMcpField(name) {
	return /(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)|(?:^|[_-])(?:oauth[_-]?)?state$/i.test(String(name));
}

function sensitiveMcpContainer(name) {
	return /^(?:envs?|env_vars?|environment(?:_variables)?|headers?|http_headers?|env_http_headers?|request_headers?)$/i.test(String(name));
}

function redactSensitiveUrl(value) {
	if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return value;
	try {
		const url = new URL(value);
		if (url.username) url.username = "redacted";
		if (url.password) url.password = "redacted";
		for (const key of [...url.searchParams.keys()]) {
			if (sensitiveMcpField(key) || /^(?:code|state)$/i.test(key)) url.searchParams.set(key, "[redacted]");
		}
		if (url.hash) url.hash = "[redacted]";
		return url.href;
	} catch {
		// Invalid URLs may still contain credentials. Do not let a parse failure turn
		// a display/error sanitizer into a credential disclosure.
		return value
			.replace(/^(https?:\/\/)[^/@\s]+@/i, "$1[redacted]@")
			.replace(/([?&](?:authorization|api[_-]?key|password|passwd|secret|token|(?:oauth[_-]?)?state)=)[^&#\s]*/gi, "$1[redacted]")
			.replace(/#.*$/u, "#[redacted]");
	}
}

function redactMcpArgvValues(value) {
	if (!Array.isArray(value)) return value;
	const result = [];
	let redactNext = false;
	for (const entry of value) {
		if (typeof entry !== "string") {
			result.push(redactCodexMcpJson(entry));
			redactNext = false;
			continue;
		}
		if (redactNext) {
			const separator = entry.indexOf("=");
			result.push(separator > 0 ? `${entry.slice(0, separator)}=[redacted]` : "[redacted]");
			redactNext = false;
			continue;
		}
		const assignment = entry.match(/^((?:-c|-e|--config|(?:--?)?(?:env|header|password|passwd|secret|token|api[_-]?key|authorization)))(?:=)(.*)$/i);
		if (assignment) {
			const valueSeparator = assignment[2].indexOf("=");
			const prefix = valueSeparator > 0 && (/(?:env|header)/i.test(assignment[1]) || assignment[1].toLowerCase() === "-e")
				? `${assignment[1]}=${assignment[2].slice(0, valueSeparator)}=`
				: `${assignment[1]}=`;
			result.push(`${prefix}[redacted]`);
			continue;
		}
		// MCP stdio commands commonly embed environment assignments inside argv,
		// especially Docker-style launchers. Values are configuration secrets as far
		// as a rendered catalog is concerned, even when the variable name is neutral.
		const environmentAssignment = entry.match(/^([A-Za-z_][A-Za-z0-9_]{0,255})=(.*)$/u);
		if (environmentAssignment) {
			result.push(`${environmentAssignment[1]}=[redacted]`);
			continue;
		}
		result.push(redactSensitiveUrl(entry));
		redactNext = /^(?:-c|-e|--config|--?(?:env|header|password|passwd|secret|token|api[_-]?key|authorization))$/i.test(entry);
	}
	return result;
}

function redactMcpContainer(value) {
	if (Array.isArray(value)) {
		return value.map((entry) => {
			if (!isPlainObject(entry)) return "[redacted]";
			const pair = {};
			for (const [key, child] of Object.entries(entry)) {
				pair[key] = /^(?:name|key)$/i.test(key) ? redactSensitiveUrl(child) : "[redacted]";
			}
			return pair;
		});
	}
	if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).map((key) => [key, "[redacted]"]));
	return "[redacted]";
}

export function redactCodexMcpJson(value, parentKey = "") {
	if (Array.isArray(value)) {
		if (/^(?:args|arguments|command_args)$/i.test(parentKey)) return redactMcpArgvValues(value);
		return value.map((entry) => redactCodexMcpJson(entry, parentKey));
	}
	if (!isPlainObject(value)) return redactSensitiveUrl(value);
	const result = {};
	for (const [key, child] of Object.entries(value)) {
		if (sensitiveMcpContainer(key)) result[key] = redactMcpContainer(child);
		else if (sensitiveMcpField(key) && !/(?:env(?:ironment)?_var(?:iable)?|env_var_name)$/i.test(key)) {
			result[key] = "[redacted]";
		} else result[key] = redactCodexMcpJson(child, key);
	}
	return result;
}

function mcpSecretArgumentValues(args = []) {
	const values = new Set();
	let secretNext = false;
	for (const entry of Array.isArray(args) ? args : []) {
		const text = String(entry ?? "");
		if (secretNext) {
			values.add(text);
			const separator = text.indexOf("=");
			if (separator >= 0 && text.slice(separator + 1)) values.add(text.slice(separator + 1));
			secretNext = false;
			continue;
		}
		const assignment = text.match(/^(?:-c|-e|--config|--?(?:env|header|password|passwd|secret|token|api[_-]?key|authorization))=(.*)$/i);
		if (assignment) {
			values.add(text);
			const separator = assignment[1].indexOf("=");
			values.add(separator >= 0 ? assignment[1].slice(separator + 1) : assignment[1]);
			continue;
		}
		const environmentAssignment = text.match(/^[A-Za-z_][A-Za-z0-9_]{0,255}=(.*)$/u);
		if (environmentAssignment) {
			values.add(text);
			values.add(environmentAssignment[1]);
			continue;
		}
		secretNext = /^(?:-c|-e|--config|--?(?:env|header|password|passwd|secret|token|api[_-]?key|authorization))$/i.test(text);
	}
	return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

export function redactCodexMcpError(error, args = []) {
	let message = oneLine(error?.message ?? error ?? "unknown error");
	for (const value of mcpSecretArgumentValues(args)) message = message.replaceAll(value, "[redacted]");
	message = message
		.replace(/https?:\/\/[^\s)\]}]+/gi, (url) => redactSensitiveUrl(url))
		.replace(/((?:-c|-e|--config|--?env)(?:=|\s+))(?:(?:"[^"]*")|(?:'[^']*')|\S+)/gi, "$1[redacted]")
		.replace(/\b(authorization|authorization[_-]?code|api[_-]?key|password|passwd|secret|token|(?:oauth[_-]?)?state)=\S+/gi, "$1=[redacted]");
	return message.slice(0, 1_000);
}

export function formatCodexPluginMarketplaceCommandDisplay(args = [], commandName = "plugins") {
	const literal = Array.isArray(args) ? args.map((entry) => String(entry)) : [];
	const redacted = redactMcpArgvValues(literal);
	const display = redacted.slice(0, 64).map((entry) => singleLineMenuText(entry).slice(0, 500));
	if (redacted.length > display.length) display.push("…");
	return `/${commandName} marketplace${display.length > 0 ? ` ${display.join(" ")}` : ""}`;
}

export function redactCodexPluginMarketplaceError(error, args = []) {
	return redactCodexMcpError(error, args);
}

function hookReportCode(value, fallback = "unknown") {
	const source = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? value
		: value === undefined || value === null ? fallback : JSON.stringify(value);
	const text = singleLineMenuText(source).slice(0, 500).replaceAll("`", "ˋ") || fallback;
	return `\`${text}\``;
}

export function formatCodexHooksReport(result, requestedCwd = process.cwd()) {
	if (!isPlainObject(result) || !Array.isArray(result.data)) {
		throw new Error("Codex hooks/list returned an invalid response");
	}
	const lines = [`### Codex hooks for ${hookReportCode(path.resolve(requestedCwd))}`];
	let hookCount = 0;
	let diagnosticCount = 0;
	for (const record of result.data) {
		if (!isPlainObject(record)) continue;
		const recordCwd = path.resolve(typeof record.cwd === "string" && record.cwd ? record.cwd : requestedCwd);
		if (result.data.length > 1) lines.push("", `#### ${hookReportCode(recordCwd)}`);
		for (const hook of Array.isArray(record.hooks) ? record.hooks : []) {
			if (!isPlainObject(hook)) continue;
			hookCount += 1;
			const enabled = hook.enabled === true ? "enabled" : hook.enabled === false ? "disabled" : "enabled unknown";
			const source = [hook.source, hook.sourcePath, hook.pluginId]
				.filter((entry) => entry !== undefined && entry !== null && String(entry).trim())
				.map((entry) => hookReportCode(entry))
				.join(" · ") || hookReportCode("unknown");
			lines.push(
				`- ${hookReportCode(hook.eventName)} · ${hookReportCode(hook.handlerType)} · ${enabled} · trust ${hookReportCode(hook.trustStatus)}`,
				`  Source: ${source}`,
			);
		}
		for (const error of Array.isArray(record.errors) ? record.errors : []) {
			diagnosticCount += 1;
			const location = isPlainObject(error) ? error.path : undefined;
			const message = isPlainObject(error) ? error.message : error;
			lines.push(`- Error${location ? ` in ${hookReportCode(location)}` : ""}: ${hookReportCode(message, "unknown error")}`);
		}
		for (const warning of Array.isArray(record.warnings) ? record.warnings : []) {
			diagnosticCount += 1;
			lines.push(`- Warning: ${hookReportCode(warning, "unknown warning")}`);
		}
	}
	if (hookCount === 0) lines.push("", "No hooks are registered for this working directory.");
	if (diagnosticCount === 0 && hookCount > 0) lines.push("", "No hook configuration errors or warnings were reported.");
	return truncateDiff(lines.join("\n"), CODEX_HOOKS_REPORT_MAX_LINES);
}

function parseCodexFeatureLine(line) {
	const match = String(line).match(/^(\S+)\s{2,}(.+?)\s{2,}(true|false)\s*$/);
	if (!match) return undefined;
	return { name: match[1], stage: match[2].trim(), enabled: match[3] === "true" };
}

function windowsSystem32ExecutablePath(executable, environment = process.env) {
	const configuredRoot = environmentValue(environment, "SystemRoot", "win32");
	const systemRoot = typeof configuredRoot === "string" && path.win32.isAbsolute(configuredRoot)
		? path.win32.normalize(configuredRoot)
		: "C:\\Windows";
	return path.win32.join(systemRoot, "System32", executable);
}

export function windowsExplorerPath(environment = process.env) {
	return windowsSystem32ExecutablePath("explorer.exe", environment);
}

export function linuxExternalUrlLauncherPath(options = {}) {
	const candidates = [
		"/usr/bin/xdg-open",
		"/bin/xdg-open",
		"/run/current-system/sw/bin/xdg-open",
	];
	const isExecutable = options.isExecutable ?? ((candidate) => {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
	for (const candidate of candidates) {
		if (isExecutable(candidate)) return candidate;
	}
	const error = new Error("No trusted system xdg-open executable was found");
	error.code = "CC_URL_LAUNCHER_UNAVAILABLE";
	throw error;
}

export async function openExternalUrl(value, options = {}) {
	const url = new URL(value);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("only HTTP(S) URLs can be opened");
	const platform = options.platform ?? process.platform;
	const runCaptureImpl = options.runCaptureImpl ?? runCapture;
	if (platform === "darwin") {
		// Resolve the operating-system launcher directly. A checkout-local `open`
		// earlier on PATH must not be able to intercept a one-time authentication URL.
		await runCaptureImpl("/usr/bin/open", [url.href], { timeoutMs: 5_000, processTracker: options.processTracker });
		return;
	}
	if (platform === "win32") {
		// Do not route backend-supplied URLs through cmd.exe: URL characters such
		// as '&' are shell metacharacters even when the value is a single argv item.
		// Resolve the inbox launcher by absolute path too: Windows searches the
		// current directory before PATH for a bare executable name.
		await runCaptureImpl(windowsExplorerPath(options.environment ?? process.env), [url.href], {
			timeoutMs: 5_000,
			processTracker: options.processTracker,
		});
		return;
	}
	if (platform === "linux") {
		const command = linuxExternalUrlLauncherPath({ isExecutable: options.isExecutable });
		await runCaptureImpl(command, [url.href], { timeoutMs: 5_000, processTracker: options.processTracker });
		return;
	}
	const error = new Error(`opening external URLs is unsupported on ${platform}`);
	error.code = "CC_URL_LAUNCHER_UNAVAILABLE";
	throw error;
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

async function readClipboardImage(options = {}) {
	if (process.platform === "darwin") return await readMacClipboardImage(options);
	if (process.platform === "win32" || isWsl()) return await readWindowsClipboardImage(options);
	if (process.platform === "linux") return await readLinuxClipboardImage(options);
	return undefined;
}

async function readMacClipboardImage(options = {}) {
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
		], { processTracker: options.processTracker });
		const data = await fs.promises.readFile(file);
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png" };
	} catch {
		return undefined;
	} finally {
		await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
	}
}

async function readWindowsClipboardImage(options = {}) {
	const script =
		"Add-Type -AssemblyName System.Windows.Forms; " +
		"$img = [System.Windows.Forms.Clipboard]::GetImage(); " +
		"if ($img) { $ms = New-Object System.IO.MemoryStream; " +
		"$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); " +
		"[System.Convert]::ToBase64String($ms.ToArray()) }";
	try {
		const result = await runCapture("powershell.exe", ["-NonInteractive", "-NoProfile", "-Command", script], {
			processTracker: options.processTracker,
		});
		const base64 = result.stdout.toString("utf8").trim();
		if (!base64) return undefined;
		const data = Buffer.from(base64, "base64");
		if (data.length === 0) return undefined;
		return { data: data.toString("base64"), mimeType: "image/png" };
	} catch {
		return undefined;
	}
}

async function readLinuxClipboardImage(options = {}) {
	const wayland = await runCapture("wl-paste", ["-t", "image/png"], {
		rejectOnExit: false,
		processTracker: options.processTracker,
	}).catch(() => undefined);
	if (wayland?.stdout?.length > 0) return { data: wayland.stdout.toString("base64"), mimeType: "image/png" };
	const x11 = await runCapture("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"], {
		rejectOnExit: false,
		processTracker: options.processTracker,
	}).catch(() => undefined);
	if (x11?.stdout?.length > 0) return { data: x11.stdout.toString("base64"), mimeType: "image/png" };
	return undefined;
}

function runCapture(command, args = [], options = {}) {
	const timeoutMs = options.timeoutMs ?? CLIPBOARD_IMAGE_TIMEOUT_MS;
	const terminationGraceMs = options.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
	const rejectOnExit = options.rejectOnExit !== false;
	const stdoutByteLimit = Number.isFinite(options.maxStdoutBytes) ? Math.max(0, Math.floor(options.maxStdoutBytes)) : Infinity;
	const stderrByteLimit = Number.isFinite(options.maxStderrBytes) ? Math.max(0, Math.floor(options.maxStderrBytes)) : Infinity;
	return new Promise((resolve, reject) => {
		options.processTracker?.assertOpen();
		const child = spawn(command, args, {
			stdio: ["ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
			shell: false,
			...(options.env ? { env: mergeEnvironments([options.env]) } : {}),
		});
		const stdout = [];
		const stderr = [];
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let terminating = false;
		let terminationPromise;
		let directChildClosed = false;
		let timer;
		let unregister = () => {};

		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unregister();
			if (error) reject(error);
			else resolve(result);
		};
		const terminateProcessTree = (reason) => {
			if (settled) return Promise.resolve();
			if (terminationPromise) return terminationPromise;
			terminating = true;
			terminationPromise = (async () => {
				// A Windows SIGTERM is already an unconditional direct-process kill, so use
				// taskkill /T /F while the root PID is still valid. POSIX gets a grace
				// period, but completion means the whole detached group is gone, not merely
				// that the direct child emitted close.
				const initialSignal = process.platform === "win32" ? "SIGKILL" : "SIGTERM";
				let forceKillUsed = initialSignal === "SIGKILL";
				let terminationResult = terminateChild(child, initialSignal);
				let treeExited = await waitForProcessTreeExit(
					child,
					() => directChildClosed,
					terminationGraceMs,
					terminationResult,
				);
				if (!treeExited) {
					forceKillUsed = true;
					terminationResult = mergeTerminationResults(
						terminationResult,
						terminateChild(child, "SIGKILL", { includeExitedGroup: true }),
					);
					treeExited = await waitForProcessTreeExit(
						child,
						() => directChildClosed,
						PROCESS_FORCE_KILL_WAIT_MS,
						terminationResult,
					);
				}
				if (!treeExited) {
					const prefix = reason === "timeout"
						? `${command} timed out after ${timeoutMs}ms`
						: nativeProcessShutdownError(command).message;
					finish(processTreeTerminationError(`${prefix} and its process tree did not exit after SIGKILL`));
					return;
				}
				if (reason === "timeout") {
					const termination = forceKillUsed ? "force-killed" : "terminated";
					finish(new Error(`${command} timed out after ${timeoutMs}ms; its process tree was ${termination}`));
					return;
				}
				finish(nativeProcessShutdownError(command));
			})();
			return terminationPromise;
		};
		unregister = options.processTracker?.register(() => terminateProcessTree("shutdown")) ?? unregister;
		timer = setTimeout(() => {
			void terminateProcessTree("timeout");
		}, Math.max(1, timeoutMs));
		timer.unref?.();

		child.stdout?.on("data", (chunk) => {
			const buffer = Buffer.from(chunk);
			const remaining = Math.max(0, stdoutByteLimit - stdoutBytes);
			if (remaining > 0) {
				const captured = buffer.subarray(0, remaining);
				stdout.push(captured);
				stdoutBytes += captured.length;
			}
			if (buffer.length > remaining) stdoutTruncated = true;
		});
		child.stderr?.on("data", (chunk) => {
			const buffer = Buffer.from(chunk);
			const remaining = Math.max(0, stderrByteLimit - stderrBytes);
			if (remaining > 0) {
				const captured = buffer.subarray(0, remaining);
				stderr.push(captured);
				stderrBytes += captured.length;
			}
			if (buffer.length > remaining) stderrTruncated = true;
		});
		child.once("error", (error) => {
			if (!terminating) finish(error);
		});
		child.once("close", (code, signal) => {
			directChildClosed = true;
			const result = {
				code,
				signal,
				stdout: Buffer.concat(stdout, stdoutBytes),
				stderr: Buffer.concat(stderr, stderrBytes),
				...(stdoutTruncated ? { stdoutTruncated: true } : {}),
				...(stderrTruncated ? { stderrTruncated: true } : {}),
			};
			if (terminating || settled) return;
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

export function codexHome(env = process.env) {
	return environmentValue(env, "CODEX_HOME") || path.join(os.homedir(), ".codex");
}

function codexStateDbPath(env = process.env) {
	return path.join(codexHome(env), "state_5.sqlite");
}

function resolveCodexSessionTarget(target, agent = {}, options = {}) {
	if (isUuid(target)) return target;
	const env = mergedAgentEnvironment(agent);
	const modelProvider = environmentValue(env, "MODEL_PROVIDER") || undefined;
	const sessions = listLocalCodexSessions(process.cwd(), codexStateDbPath(env), 10_000, {
		archived: options.archived === true,
		modelProvider,
	});
	if (sessions === undefined) throw new Error("cannot resolve a session name without the local Codex session index; use its UUID");
	return resolveCodexSessionTargetFromList(target, sessions, options);
}

async function resolveCodexSessionTargetForCommand(target, agent = {}, client = undefined, options = {}) {
	if (isUuid(target)) return target;
	const env = mergedAgentEnvironment(agent);
	const modelProvider = environmentValue(env, "MODEL_PROVIDER") || undefined;
	let sessions = listLocalCodexSessions(process.cwd(), codexStateDbPath(env), 10_000, {
		archived: options.archived === true,
		modelProvider,
	});
	if (sessions === undefined && options.archived !== true && typeof client?.listSessions === "function") {
		sessions = await client.listSessions();
	}
	// Archived sessions cannot be active and ACP does not list them. The native
	// CLI accepts an archived session name directly, so it is safe to delegate
	// name resolution when a local sqlite3 reader is unavailable (notably Windows).
	if (sessions === undefined && options.archived === true) return target;
	if (sessions === undefined) {
		throw new Error("cannot resolve a session name through the local index or ACP; use its UUID");
	}
	return resolveCodexSessionTargetFromList(target, sessions, options);
}

function resolveCodexSessionTargetFromList(target, sessions, options = {}) {
	const normalizedName = singleLineMenuText(target);
	const idMatch = sessions.find((session) => session?.sessionId === target);
	if (idMatch) return idMatch.sessionId;
	const matches = sessions.filter((session) => singleLineMenuText(session.title) === normalizedName);
	if (matches.length === 0) {
		const qualifier = options.archived === true ? "archived " : "";
		throw new Error(`no current-workspace ${qualifier}session is named ${normalizedName}; use its UUID`);
	}
	if (matches.length > 1) throw new Error(`more than one session is named ${normalizedName}; use a UUID to disambiguate`);
	return matches[0].sessionId;
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

function filesystemPathIsCaseInsensitive(targetPath, platform = process.platform) {
	if (platform === "win32") return true;
	let candidate = path.resolve(targetPath);
	// The requested cwd can have disappeared since Codex recorded it. Probe the
	// nearest existing ancestor, which is on the same path/volume and requires no
	// temporary filesystem writes.
	while (true) {
		try {
			fs.statSync(candidate);
			break;
		} catch (error) {
			const parent = path.dirname(candidate);
			if (parent === candidate) return false;
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") return false;
			candidate = parent;
		}
	}
	while (true) {
		const parent = path.dirname(candidate);
		if (parent === candidate) return false;
		const name = path.basename(candidate);
		const index = name.search(/[A-Za-z]/);
		if (index < 0) {
			candidate = parent;
			continue;
		}
		const character = name[index];
		const toggledCharacter = character === character.toLowerCase()
			? character.toUpperCase()
			: character.toLowerCase();
		const toggled = path.join(parent, `${name.slice(0, index)}${toggledCharacter}${name.slice(index + 1)}`);
		try {
			const originalStat = fs.statSync(candidate);
			const toggledStat = fs.statSync(toggled);
			return originalStat.dev === toggledStat.dev && originalStat.ino === toggledStat.ino;
		} catch (error) {
			if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
			candidate = parent;
		}
	}
}

// Codex's ACP session/list currently pages through the rollout store before it
// applies the cwd filter. Large histories can therefore require hundreds of
// round trips just to populate /resume. The local thread index is authoritative
// for a local Codex backend and can answer the same picker query in one read.
// Return undefined (rather than []) when the index cannot be queried so callers
// can fall back to the protocol implementation.
export function listLocalCodexSessions(cwd = process.cwd(), dbPath = codexStateDbPath(), limit = 1_000, options = {}) {
	if (!fs.existsSync(dbPath)) return undefined;
	const safeLimit = Math.max(1, Math.min(10_000, Number.isFinite(limit) ? Math.trunc(limit) : 1_000));
	const archived = options.archived === true ? 1 : 0;
	const platform = options.platform ?? process.platform;
	// Windows path identity is case-insensitive, as is the default macOS volume.
	// SQLite's binary `=` would hide sessions whenever Codex persisted a different
	// spelling of the same cwd (for example, a differently cased drive letter).
	// Probe the actual volume rather than assuming every APFS volume is insensitive;
	// an explicit override keeps the comparison deterministic for callers/tests.
	const caseInsensitiveFilesystem = options.caseInsensitiveFilesystem ?? filesystemPathIsCaseInsensitive(cwd, platform);
	const resolvedCwd = sqlString(path.resolve(cwd));
	const cwdPredicate = caseInsensitiveFilesystem
		? `and cwd collate nocase = ${resolvedCwd}`
		: `and cwd = ${resolvedCwd}`;
	const modelProvider = typeof options.modelProvider === "string" && options.modelProvider.trim()
		? options.modelProvider.trim()
		: undefined;
	const sql = [
		"select id, cwd,",
		"coalesce(nullif(title, ''), nullif(first_user_message, ''), nullif(preview, ''), id) as title,",
		"updated_at, updated_at_ms",
		"from threads",
		`where archived = ${archived}`,
		cwdPredicate,
		"and source <> 'exec'",
		"and source not like '{\"subagent\"%'",
		"and coalesce(thread_source, '') <> 'subagent'",
		...(modelProvider ? [`and model_provider = ${sqlString(modelProvider)}`] : []),
		"order by coalesce(updated_at_ms, updated_at * 1000) desc, id desc",
		`limit ${safeLimit};`,
	].join(" ");
	const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
		encoding: "utf8",
		timeout: 2_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) return undefined;
	let rows;
	try {
		rows = JSON.parse(result.stdout || "[]");
	} catch {
		return undefined;
	}
	if (!Array.isArray(rows)) return undefined;
	return rows.map((row) => {
		const explicitMs = Number(row.updated_at_ms);
		const seconds = Number(row.updated_at);
		const timestampMs = Number.isFinite(explicitMs) && explicitMs > 0
			? explicitMs
			: Number.isFinite(seconds) && seconds > 0
				? seconds * 1_000
				: undefined;
		return {
			sessionId: row.id,
			cwd: row.cwd,
			title: row.title,
			...(timestampMs ? { updatedAt: new Date(timestampMs).toISOString() } : {}),
		};
	});
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

function findRolloutFilePresence(dir, suffix, depth = 0) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "absent" };
		return { status: "unknown", reason: `could not inspect ${dir}: ${error.message ?? error}` };
	}
	const normalizedSuffix = suffix.toLowerCase();
	for (const entry of entries) {
		const normalizedName = entry.name.toLowerCase();
		if (entry.isFile() && (normalizedName.endsWith(normalizedSuffix) || normalizedName.endsWith(`${normalizedSuffix}.zst`))) {
			return { status: "present", path: path.join(dir, entry.name) };
		}
	}
	if (depth >= 8) {
		if (entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink())) {
			return { status: "unknown", reason: `the Codex session tree below ${dir} exceeded the scan depth` };
		}
		return { status: "absent" };
	}
	let unknown;
	for (const entry of entries) {
		if (entry.isSymbolicLink()) {
			unknown ??= { status: "unknown", reason: `the Codex session tree contains an unscanned symlink at ${path.join(dir, entry.name)}` };
			continue;
		}
		if (!entry.isDirectory()) continue;
		const result = findRolloutFilePresence(path.join(dir, entry.name), suffix, depth + 1);
		if (result.status === "present") return result;
		if (result.status === "unknown") unknown ??= result;
	}
	return unknown ?? { status: "absent" };
}

function codexRolloutStoragePresence(sessionId, env = process.env) {
	const home = codexHome(env);
	let unknown;
	for (const directory of ["sessions", "archived_sessions"]) {
		const result = findRolloutFilePresence(path.join(home, directory), `-${sessionId}.jsonl`);
		if (result.status === "present") return result;
		if (result.status === "unknown") unknown ??= result;
	}
	return unknown ?? { status: "absent" };
}

function codexStateDbSessionPresence(sessionId, env = process.env) {
	const dbPath = codexStateDbPath(env);
	try {
		const stat = fs.statSync(dbPath);
		if (!stat.isFile()) return { status: "unknown", reason: `${dbPath} is not a regular file` };
	} catch (error) {
		if (error?.code === "ENOENT") return { status: "absent" };
		return { status: "unknown", reason: `could not inspect ${dbPath}: ${error.message ?? error}` };
	}
	const sql = `select id from threads where lower(id) = lower(${sqlString(sessionId)}) limit 1;`;
	const result = spawnSync("sqlite3", ["-json", dbPath, sql], {
		encoding: "utf8",
		timeout: 1_000,
		windowsHide: true,
	});
	if (result.error?.code === "ENOENT") {
		return {
			status: "unknown",
			reason: "could not query the Codex session index because sqlite3 is unavailable",
			readerUnavailable: true,
		};
	}
	if (result.error || result.status !== 0) {
		const detail = result.error?.message ?? (String(result.stderr ?? "").trim() || `exit status ${result.status}`);
		return { status: "unknown", reason: `could not query the Codex session index: ${detail}` };
	}
	try {
		const rows = JSON.parse(result.stdout || "[]");
		if (!Array.isArray(rows)) throw new Error("the query did not return an array");
		return rows.length > 0 ? { status: "present" } : { status: "absent" };
	} catch (error) {
		return { status: "unknown", reason: `could not parse the Codex session index response: ${error.message ?? error}` };
	}
}

export function codexStoredSessionPresence(sessionId, agent = {}) {
	const env = mergedAgentEnvironment(agent);
	const filesystem = codexRolloutStoragePresence(sessionId, env);
	if (filesystem.status === "present") return filesystem;
	const database = codexStateDbSessionPresence(sessionId, env);
	if (database.status === "present") return database;
	if (filesystem.status === "unknown") return filesystem;
	if (database.status === "unknown") return database;
	return { status: "absent" };
}

function codexGoalSessionIsUnmaterialized(sessionId, agent = {}) {
	const env = mergedAgentEnvironment(agent);
	const filesystem = codexRolloutStoragePresence(sessionId, env);
	if (filesystem.status !== "absent") return false;
	const database = codexStateDbSessionPresence(sessionId, env);
	return database.status === "absent" || database.readerUnavailable === true;
}

function readCompressedCodexRollout(rolloutPath, maxBytes) {
	if (typeof zlib.zstdDecompressSync !== "function") return undefined;
	try {
		if (fs.statSync(rolloutPath).size > maxBytes) return undefined;
		const compressed = fs.readFileSync(rolloutPath);
		return zlib.zstdDecompressSync(compressed, { maxOutputLength: maxBytes });
	} catch {
		return undefined;
	}
}

function readCodexRolloutPrefix(rolloutPath, maxBytes = FORK_LEGACY_PREFIX_MAX_BYTES) {
	if (rolloutPath.endsWith(".zst")) {
		const decompressed = readCompressedCodexRollout(rolloutPath, maxBytes);
		if (!decompressed) return undefined;
		return decompressed.toString("utf8");
	}
	let descriptor;
	try {
		descriptor = fs.openSync(rolloutPath, "r");
		const stat = fs.fstatSync(descriptor);
		const length = Math.min(stat.size, maxBytes);
		const buffer = Buffer.alloc(length);
		const read = fs.readSync(descriptor, buffer, 0, length, 0);
		return buffer.subarray(0, read).toString("utf8");
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function readCodexSessionMeta(rolloutPath, maxBytes = 8 * 1024 * 1024) {
	if (rolloutPath.endsWith(".zst")) {
		const content = readCompressedCodexRollout(rolloutPath, maxBytes);
		if (!content) return undefined;
		try {
			const newline = content.indexOf(0x0a);
			if (newline < 0) return undefined;
			const record = JSON.parse(content.subarray(0, newline).toString("utf8").replace(/\r$/, ""));
			return record?.type === "session_meta" ? record : undefined;
		} catch {
			return undefined;
		}
	}
	let descriptor;
	try {
		descriptor = fs.openSync(rolloutPath, "r");
		const chunks = [];
		let total = 0;
		while (total < maxBytes) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total));
			const length = fs.readSync(descriptor, chunk, 0, chunk.length, total);
			if (length === 0) break;
			const slice = chunk.subarray(0, length);
			const newline = slice.indexOf(0x0a);
			if (newline >= 0) {
				chunks.push(slice.subarray(0, newline));
				const record = JSON.parse(Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""));
				return record?.type === "session_meta" ? record : undefined;
			}
			chunks.push(slice);
			total += length;
		}
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
	return undefined;
}

function normalizedCodexSessionMeta(record) {
	if (!record || typeof record !== "object") return undefined;
	let copy;
	try {
		copy = JSON.parse(JSON.stringify(record));
	} catch {
		return undefined;
	}
	for (const container of [copy, copy.payload]) {
		if (!container || typeof container !== "object" || Array.isArray(container)) continue;
		for (const key of [
			"id",
			"session_id",
			"sessionId",
			"thread_id",
			"threadId",
			"forked_from_id",
			"forkedFromId",
			"parent_thread_id",
			"parentThreadId",
		]) delete container[key];
	}
	return JSON.stringify(copy);
}

function codexRolloutFileIdentity(fileName) {
	const match = /^(.*-)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i.exec(fileName);
	return match ? { prefix: match[1], sessionId: match[2] } : undefined;
}

function normalizedCodexRolloutPrefixLines(rolloutPath) {
	const content = readCodexRolloutPrefix(rolloutPath);
	if (!content) return undefined;
	const lastNewline = content.lastIndexOf("\n");
	if (lastNewline < 0) return undefined;
	const lines = content.slice(0, lastNewline).split("\n");
	if (lines.length === 0) return undefined;
	try {
		const metadata = JSON.parse(lines[0].replace(/\r$/, ""));
		const normalized = normalizedCodexSessionMeta(metadata);
		if (!normalized) return undefined;
		lines[0] = normalized;
		return lines;
	} catch {
		return undefined;
	}
}

function commonCodexRolloutPrefixLength(left, right) {
	if (!Array.isArray(left) || !Array.isArray(right)) return undefined;
	const limit = Math.min(left.length, right.length);
	let index = 0;
	while (index < limit && left[index] === right[index]) index += 1;
	return index;
}

function recoverCodexForkRegistry(agent = {}) {
	// Permanent deletion must fail closed if ownership state is corrupt; treating
	// an unreadable registry as empty could remove a parent while leaving copies.
	const registry = readForkRegistry({ strict: true });
	const inferred = {};
	const unresolved = [];
	const env = mergedAgentEnvironment(agent);
	const canonicalId = (id) => isUuid(id) ? id.toLowerCase() : id;
	const forkIds = new Set(registry.forks.map(canonicalId));
	const forkOrder = new Map(registry.forks.map((id, index) => [canonicalId(id), index]));
	for (const child of registry.forks) {
		if (registry.parents[child]) continue;
		const presence = codexRolloutStoragePresence(child, env);
		if (presence.status !== "present") {
			// A flat registry entry may be a cosmetic label from another backend or a
			// stale Codex copy. Ignore it only when the rollout stores prove it absent;
			// an incomplete scan may conceal history with an unknown parent.
			if (presence.status === "unknown") unresolved.push({ child, candidateIds: [] });
			continue;
		}
		const rolloutPath = presence.path;
		const metadata = readCodexSessionMeta(rolloutPath);
		const recordedParent = metadata?.payload?.forked_from_id ?? metadata?.payload?.forkedFromId;
		if (typeof recordedParent === "string" && recordedParent && !sameSessionId(recordedParent, child)) {
			inferred[child] = recordedParent;
			continue;
		}

		// Legacy cc copies predate forked_from_id, but retained the parent's exact
		// rollout filename prefix and history snapshot. Prefer the earlier registered
		// candidate with the longest unique shared history, which recovers nested forks.
		// Compressed/oversized histories may not expose a prefix on this Node version.
		// A unique verified non-fork cohort root is safe only for a direct fork: once
		// an earlier registered fork shares the cohort, flattening to the root would
		// lose nested ownership and must remain unresolved.
		const identity = codexRolloutFileIdentity(path.basename(rolloutPath));
		if (!identity) {
			unresolved.push({ child, candidateIds: [] });
			continue;
		}
		const normalizedMetadata = normalizedCodexSessionMeta(metadata);
		let siblings;
		try {
			siblings = fs.readdirSync(path.dirname(rolloutPath), { withFileTypes: true });
		} catch {
			unresolved.push({ child, candidateIds: [] });
			continue;
		}
		const childOrder = forkOrder.get(canonicalId(child)) ?? Number.POSITIVE_INFINITY;
		const childPrefix = normalizedCodexRolloutPrefixLines(rolloutPath);
		const candidates = [];
		for (const sibling of siblings) {
			if (!sibling.isFile()) continue;
			const siblingIdentity = codexRolloutFileIdentity(sibling.name);
			if (!siblingIdentity || siblingIdentity.prefix !== identity.prefix) continue;
			const candidateId = siblingIdentity.sessionId;
			if (!candidateId || sameSessionId(candidateId, child)) continue;
			const canonicalCandidate = candidateId.toLowerCase();
			const candidateOrder = forkOrder.get(canonicalCandidate);
			if (candidateOrder !== undefined && candidateOrder >= childOrder) continue;
			const candidatePath = path.join(path.dirname(rolloutPath), sibling.name);
			const candidateMeta = readCodexSessionMeta(candidatePath);
			const candidateNormalizedMetadata = normalizedCodexSessionMeta(candidateMeta);
			if (normalizedMetadata && candidateNormalizedMetadata && candidateNormalizedMetadata !== normalizedMetadata) continue;
			const score = commonCodexRolloutPrefixLength(childPrefix, normalizedCodexRolloutPrefixLines(candidatePath));
			candidates.push({
				id: candidateId,
				isFork: forkIds.has(canonicalCandidate),
				metadataVerified: Boolean(
					normalizedMetadata &&
					candidateNormalizedMetadata &&
					candidateNormalizedMetadata === normalizedMetadata
				),
				score,
			});
		}
		const scored = candidates.filter((candidate) => Number.isInteger(candidate.score) && candidate.score > 1);
		if (scored.length > 0) {
			const bestScore = Math.max(...scored.map((candidate) => candidate.score));
			const best = scored.filter((candidate) => candidate.score === bestScore);
			if (best.length === 1) {
				inferred[child] = best[0].id;
				continue;
			}
		}
		const roots = candidates.filter((candidate) => !candidate.isFork && candidate.metadataVerified);
		if (roots.length === 1 && !candidates.some((candidate) => candidate.isFork)) {
			inferred[child] = roots[0].id;
			continue;
		}
		unresolved.push({ child, candidateIds: candidates.map((candidate) => candidate.id) });
	}
	if (Object.keys(inferred).length > 0) {
		updateForkRegistry((current) => {
			let changed = false;
			for (const [child, parent] of Object.entries(inferred)) {
				if (current.parents[child]) continue;
				current.parents[child] = parent;
				if (!current.forks.includes(child)) current.forks.push(child);
				changed = true;
			}
			return changed;
		}, { required: true });
		return { ...readForkRegistry({ strict: true }), unresolved };
	}
	return { ...registry, unresolved };
}

export function loadCodexForkDescendantIds(parentId, agent = {}) {
	return forkDescendantIds(parentId, recoverCodexForkRegistry(agent).parents);
}

// Copy a rollout to a sibling file named with newId. Only identity/lineage fields
// on session_meta records are rewritten: an old id can legitimately appear in
// user text or tool output and changing that content silently corrupts history.
// Every JSONL record is parsed before publishing the copy so a snapshot caught
// halfway through an append is rejected instead of creating an unloadable fork.
export function copyCodexRolloutWithNewId(srcPath, oldId, newId, options = {}) {
	let sourceFd;
	let before;
	let after;
	let content;
	try {
		sourceFd = fs.openSync(srcPath, "r");
		before = fs.fstatSync(sourceFd);
		content = fs.readFileSync(sourceFd, "utf8");
		after = fs.fstatSync(sourceFd);
	} finally {
		if (sourceFd !== undefined) fs.closeSync(sourceFd);
	}
	if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
		throw new Error("the Codex rollout changed while it was being copied; try /btw again after the turn settles");
	}
	if (!content || !content.endsWith("\n")) {
		throw new Error("the Codex rollout does not end with a complete JSONL record");
	}

	let rewrittenIdentityFields = 0;
	const lines = content.slice(0, -1).split("\n").map((line, index) => {
		if (!line) throw new Error(`the Codex rollout contains an empty JSONL record at line ${index + 1}`);
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			throw new Error(`the Codex rollout contains an incomplete JSONL record at line ${index + 1}`);
		}
		if (record?.type !== "session_meta") return line;
		let changed = false;
		for (const container of [record, record.payload]) {
			if (!container || typeof container !== "object" || Array.isArray(container)) continue;
			for (const key of ["id", "session_id", "sessionId", "thread_id", "threadId"]) {
				if (container[key] !== oldId) continue;
				container[key] = newId;
				rewrittenIdentityFields += 1;
				changed = true;
			}
		}
		if (record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)) {
			// Match native Codex fork metadata without pretending this is a spawned
			// subagent. Upstream deletion does not traverse forked_from_id, so cc's
			// persisted parent graph remains the deletion authority.
			record.payload.forked_from_id = oldId;
			delete record.payload.parent_thread_id;
			delete record.payload.parentThreadId;
			changed = true;
		}
		return changed ? JSON.stringify(record) : line;
	});
	if (rewrittenIdentityFields === 0) {
		throw new Error("the Codex rollout session metadata does not match the active session id");
	}
	const rewritten = `${lines.join("\n")}\n`;
	const sourceName = path.basename(srcPath);
	if (!sourceName.includes(oldId)) throw new Error("the Codex rollout filename does not match the active session id");
	const destName = sourceName.split(oldId).join(newId);
	const dest = path.join(path.dirname(srcPath), destName);
	if (dest === srcPath || fs.existsSync(dest)) throw new Error("the destination Codex fork rollout already exists");
	const temporary = path.join(path.dirname(srcPath), `.${destName}.${process.pid}.${randomUUID()}.tmp`);
	let published = false;
	try {
		fs.writeFileSync(temporary, rewritten, { flag: "wx", mode: before.mode & 0o777 });
		options.beforePublish?.({ destination: dest, sessionId: newId, parentSessionId: oldId });
		if (fs.existsSync(dest)) throw new Error("the destination Codex fork rollout already exists");
		fs.renameSync(temporary, dest);
		published = true;
	} finally {
		if (!published) fs.rmSync(temporary, { force: true });
	}
	return dest;
}

function truncateDiff(text, maxLines = 500, outputTruncated = false) {
	const lines = String(text).split("\n");
	if (lines.length <= maxLines && !outputTruncated) return text;
	const keptLineCount = Math.max(0, maxLines - 1);
	const capturedOmitted = Math.max(0, lines.length - keptLineCount);
	const detail = outputTruncated
		? `… (${capturedOmitted > 0 ? `${capturedOmitted}+` : "additional"} lines omitted at the display safety limit)`
		: `… (${capturedOmitted} more lines truncated)`;
	return [...lines.slice(0, keptLineCount), detail].join("\n");
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

export async function writeSecretClipboardText(text, options = {}) {
	const platform = options.platform ?? process.platform;
	const targets = platform === "darwin"
		? [["/usr/bin/pbcopy", []]]
		: platform === "win32"
			? [[windowsSystem32ExecutablePath("clip.exe", options.environment ?? process.env), []]]
			: [
					["/usr/bin/wl-copy", []],
					["/bin/wl-copy", []],
					["/run/current-system/sw/bin/wl-copy", []],
					["/usr/bin/xclip", ["-selection", "clipboard"]],
					["/bin/xclip", ["-selection", "clipboard"]],
					["/run/current-system/sw/bin/xclip", ["-selection", "clipboard"]],
					["/usr/bin/xsel", ["--clipboard", "--input"]],
					["/bin/xsel", ["--clipboard", "--input"]],
					["/run/current-system/sw/bin/xsel", ["--clipboard", "--input"]],
				];
	try {
		await writeToFirstClipboardTarget(targets, text, options.pipeToCommandImpl ?? pipeToCommand);
	} catch (cause) {
		const error = new Error("No trusted system clipboard tool is available");
		error.code = "CC_CLIPBOARD_TOOL_UNAVAILABLE";
		error.cause = cause;
		throw error;
	}
}

async function writeToFirstClipboardTarget(targets, text, pipeToCommandImpl = pipeToCommand) {
	let lastError;
	for (const [command, args] of targets) {
		try {
			await pipeToCommandImpl(command, args, text);
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

function selectionFilterPasteText(data) {
	if (typeof data !== "string" || data.length <= 1) return "";
	const bracketed = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data);
	if (bracketed) return singleLineMenuText(bracketed[1]);
	// StdinBuffer normally splits typed text into individual characters, but
	// accepting a plain multi-character chunk makes filtering robust across
	// terminals. Never reinterpret an unknown escape sequence as query text.
	if (data.includes("\x1b")) return "";
	return singleLineMenuText(data);
}

function clipboardImagePromptPart(image) {
	const part = { type: "image", data: image.data, mimeType: image.mimeType };
	// ACP payloads are JSON encoded, so a non-enumerable symbol gives the local
	// queue/recovery path an exact placeholder identity without leaking a private
	// field onto the protocol wire.
	Object.defineProperty(part, CLIPBOARD_IMAGE_LABEL, { value: image.label });
	return part;
}

function imageAttachmentsFromPromptParts(text, promptParts) {
	if (!Array.isArray(promptParts)) return [];
	const imageParts = promptParts.filter((part) => part?.type === "image" && part.data);
	if (imageParts.length === 0) return [];
	const labels = [...String(text ?? "").matchAll(/\[Image \d+\]/g)].map((match) => match[0]);
	const explicitLabels = new Set(
		imageParts
			.map((part) => part[CLIPBOARD_IMAGE_LABEL])
			.filter((label) => typeof label === "string" && labels.includes(label)),
	);
	const fallbackLabels = labels.filter((label) => !explicitLabels.has(label));
	let fallbackIndex = 0;
	const restored = [];
	for (const part of imageParts) {
		const explicit = part[CLIPBOARD_IMAGE_LABEL];
		const label = typeof explicit === "string" && labels.includes(explicit)
			? explicit
			: fallbackLabels[fallbackIndex++];
		if (!label) continue;
		restored.push({
			label,
			data: part.data,
			mimeType: part.mimeType ?? part.mime_type ?? "image/png",
		});
	}
	return restored;
}

function hasImagePromptPart(promptParts) {
	return Array.isArray(promptParts) && promptParts.some((part) => part?.type === "image");
}

function imagePromptCapability(capabilities) {
	if (!capabilities || Object.keys(capabilities).length === 0) return undefined;
	return capabilities.promptCapabilities?.image === true;
}

export function buildEmbeddedFilePromptParts(text, basePath = process.cwd(), options = {}) {
	const source = String(text ?? "");
	const state = options.state ?? {};
	if (!(state.seenPaths instanceof Set)) state.seenPaths = new Set();
	state.embeddedCount = Number.isFinite(state.embeddedCount) ? state.embeddedCount : 0;
	state.embeddedBytes = Number.isFinite(state.embeddedBytes) ? state.embeddedBytes : 0;
	const maxMentions = Number.isFinite(options.maxMentions)
		? Math.max(0, Math.trunc(options.maxMentions))
		: EMBEDDED_FILE_MAX_MENTIONS;
	const maxTotalBytes = Number.isFinite(options.maxTotalBytes)
		? Math.max(0, Math.trunc(options.maxTotalBytes))
		: EMBEDDED_FILE_MAX_TOTAL_BYTES;
	const platform = options.platform ?? process.platform;
	// Keep ':' excluded for ordinary mentions (so sentence punctuation remains
	// text), but admit it as part of an unquoted Windows drive-letter path.
	const pattern = /(^|[\s(])@(?:"([^"\r\n]+)"|([A-Za-z]:[\\/][^\s,;!?()[\]{}<>]+|[^\s,;:!?()[\]{}<>]+))/g;
	const parts = [];
	let offset = 0;
	let embeddedCount = 0;
	for (const match of source.matchAll(pattern)) {
		// Preserve the unexpanded mention and the remainder of the prompt verbatim
		// after the aggregate cap. This bounds both protocol blocks and filesystem
		// work even when a pasted prompt contains thousands of valid @paths.
		if (state.embeddedCount >= maxMentions) break;
		const prefix = match[1] ?? "";
		const mentionStart = match.index + prefix.length;
		let mentionEnd = match.index + match[0].length;
		let rawPath = match[2] ?? match[3];
		const resolvePath = (candidate) => {
			const expanded = candidate === "~"
				? os.homedir()
				: /^~[\\/]/.test(candidate)
					? path.join(os.homedir(), candidate.slice(2))
					: candidate;
			return path.resolve(basePath, expanded);
		};
		let absolute = resolvePath(rawPath);
		let stat;
		try {
			stat = fs.statSync(absolute);
		} catch {
			// A period normally terminates a sentence but is legal in a filename.
			// Prefer the full candidate; only peel terminal periods when that exact
			// path is absent and the trimmed path actually exists.
			const trimmed = match[2] === undefined ? rawPath.replace(/\.+$/, "") : rawPath;
			if (trimmed === rawPath || !trimmed) continue;
			const trimmedAbsolute = resolvePath(trimmed);
			try {
				stat = fs.statSync(trimmedAbsolute);
				absolute = trimmedAbsolute;
				mentionEnd -= rawPath.length - trimmed.length;
				rawPath = trimmed;
			} catch {
				continue;
			}
		}
		if (!stat.isFile()) continue;
		let identity = absolute;
		try {
			identity = fs.realpathSync.native?.(absolute) ?? fs.realpathSync(absolute);
		} catch {}
		if (platform === "win32") identity = identity.toLowerCase();
		if (state.seenPaths.has(identity)) continue;
		const before = source.slice(offset, mentionStart);
		if (before) parts.push({ type: "text", text: before });
		const uri = pathToFileURL(absolute).href;
		const mimeType = mimeTypeForPath(absolute);
		let contents;
		const remainingBytes = Math.max(0, maxTotalBytes - state.embeddedBytes);
		const contentLimit = Math.min(EMBEDDED_FILE_MAX_BYTES, remainingBytes);
		if (stat.size <= contentLimit) {
			contents = readBoundedEmbeddedTextFile(absolute, contentLimit);
		}
		const contentBytes = contents === undefined ? 0 : Buffer.byteLength(contents, "utf8");
		// The file may have grown after stat/readability inspection. Never let that
		// race bypass the aggregate payload bound; fall back to a resource link.
		if (contentBytes > remainingBytes || contentBytes > EMBEDDED_FILE_MAX_BYTES) contents = undefined;
		if (contents !== undefined) {
			parts.push({ type: "resource", resource: { uri, mimeType, text: contents } });
			state.embeddedBytes += contentBytes;
		} else {
			parts.push({ type: "resource_link", name: path.basename(absolute), uri, mimeType, size: stat.size });
		}
		state.seenPaths.add(identity);
		state.embeddedCount += 1;
		embeddedCount += 1;
		offset = mentionEnd;
	}
	if (embeddedCount === 0) return { parts: [{ type: "text", text: source }], embeddedCount: 0 };
	const after = source.slice(offset);
	if (after) parts.push({ type: "text", text: after });
	return { parts, embeddedCount };
}

function readBoundedEmbeddedTextFile(file, maxBytes) {
	const binaryExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".zst", ".wasm", ".exe", ".dylib", ".so"]);
	if (binaryExtensions.has(path.extname(file).toLowerCase())) return undefined;
	let fd;
	try {
		fd = fs.openSync(file, "r");
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const chunks = [];
		let total = 0;
		while (total <= maxBytes) {
			const sample = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
			const length = fs.readSync(fd, sample, 0, sample.length, null);
			if (length === 0) break;
			const chunk = sample.subarray(0, length);
			total += length;
			if (total > maxBytes || chunk.includes(0)) return undefined;
			chunks.push(decoder.decode(chunk, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {}
		}
	}
}

function mimeTypeForPath(file) {
	const extension = path.extname(file).toLowerCase();
	return ({
		".js": "text/javascript",
		".mjs": "text/javascript",
		".cjs": "text/javascript",
		".ts": "text/typescript",
		".tsx": "text/typescript",
		".json": "application/json",
		".md": "text/markdown",
		".html": "text/html",
		".css": "text/css",
		".py": "text/x-python",
		".rs": "text/x-rust",
		".sh": "text/x-shellscript",
		".yaml": "application/yaml",
		".yml": "application/yaml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".pdf": "application/pdf",
	})[extension] ?? "text/plain";
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
	let dynamicAlternateScreen = false;
	let resizeTimer;
	let fullClearReplacementOnce;
	terminal.useFullClearReplacementOnce = (replacement) => {
		fullClearReplacementOnce = replacement;
	};
	terminal.start = (onInput, onResize) => {
		start((data) => {
			// Input typed against the shell prepaint can already be waiting in the
			// terminal's canonical buffer when Pi enables raw mode. In that race the
			// line-ending arrives as LF, while Pi's key matcher expects CR for Enter.
			// Normalize only a standalone LF so pasted/multiline content is untouched.
			onInput(data === "\n" ? "\r" : data);
		}, () => {
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
		if (useAlternateScreen || dynamicAlternateScreen) {
			dynamicAlternateScreen = false;
			write("\x1b[?1049l\x1b[?25h");
		}
	};
	terminal.enterAlternateScreen = () => {
		if (useAlternateScreen || dynamicAlternateScreen) return;
		dynamicAlternateScreen = true;
		// Xterm 1049 uses the same save/restore slot as DECSC/DECRC on common
		// terminals. Restore the normal-flow anchor first so 1049 preserves that
		// anchor instead of the cursor position where /btw was opened.
		write("\x1b8\x1b[?1049h\x1b[2J\x1b[H");
	};
	terminal.exitAlternateScreen = () => {
		if (useAlternateScreen || !dynamicAlternateScreen) return;
		dynamicAlternateScreen = false;
		write("\x1b[?1049l\x1b7\x1b[?25h");
	};
	terminal.write = (data) => {
		const hasFullClear = data.includes("\x1b[2J\x1b[H\x1b[3J");
		const fullClearReplacement = hasFullClear ? fullClearReplacementOnce : undefined;
		if (hasFullClear) fullClearReplacementOnce = undefined;
		const rewritten = rewriteFullScreenClear(data, {
			alternateScreen: useAlternateScreen || dynamicAlternateScreen,
			fullClearReplacement,
		});
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

function findFastModeOption(state) {
	return (state?.configOptions ?? []).find(
		(option) => option?.id === "fast-mode" || option?.id === "fast" || option?.category === "model_config" && /fast/i.test(option?.name ?? ""),
	);
}

function booleanLikeConfigValue(entry) {
	if (!entry) return undefined;
	if (typeof entry.value === "boolean") return entry.value;
	const value = String(entry.value ?? entry.name ?? "").trim().toLowerCase();
	if (["true", "on", "enabled", "yes", "1"].includes(value)) return true;
	if (["false", "off", "disabled", "no", "0"].includes(value)) return false;
	const name = String(entry.name ?? "").trim().toLowerCase();
	if (["on", "enabled", "yes"].includes(name)) return true;
	if (["off", "disabled", "no"].includes(name)) return false;
	return undefined;
}

function codexPermissionMode(value) {
	const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
	if (["read-only", "readonly", "read"].includes(normalized)) return "read-only";
	if (["auto", "agent", "workspace-write", "workspacewrite"].includes(normalized)) return "agent";
	if (["full", "full-access", "agent-full-access", "danger-full-access", "yolo"].includes(normalized)) {
		return "agent-full-access";
	}
	return undefined;
}

export function findConfigValue(option, target) {
	const normalizedTarget = String(target ?? "").toLowerCase();
	return flattenConfigOptions(option).find((entry) => entry.value === target || entry.name.toLowerCase() === normalizedTarget);
}

function flattenConfigOptions(option) {
	if (option?.type === "boolean") {
		return [
			{ value: false, name: "Off", description: "Default speed and usage" },
			{ value: true, name: "On", description: option.description },
		];
	}
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
	return flattened.filter((entry) => entry.value !== undefined && entry.value !== null && entry.name);
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
	if (option?.currentValue === undefined || option?.currentValue === null) return undefined;
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
	// Persisted grants participate in spawn-time gating: a remembered deny means an
	// auto-mode backend must keep prompting so cc can enforce it.
	return applyHarnessSettings(config, settings, loadGrants());
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
// list. Codex copy-forks also need an explicit ownership graph: upstream records
// fork lineage separately from spawned-subagent lineage, and native `delete`
// intentionally traverses only the latter. The registry therefore remains the
// authority for deleting copied history with its parent.
function forksPath() {
	if (process.env.CC_FORKS) return process.env.CC_FORKS;
	return path.join(path.dirname(settingsPath()), "forks.json");
}

function normalizeForkRegistry(data) {
	const forks = [];
	const seen = new Set();
	const addFork = (id) => {
		if (typeof id !== "string" || !id || seen.has(id)) return;
		seen.add(id);
		forks.push(id);
	};
	const parents = {};
	for (const entry of Array.isArray(data?.forks) ? data.forks : []) {
		if (typeof entry === "string") {
			addFork(entry);
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		addFork(entry.id);
		if (typeof entry.id === "string" && typeof entry.parentId === "string" && entry.parentId && entry.parentId !== entry.id) {
			parents[entry.id] = entry.parentId;
		}
	}
	if (data?.parents && typeof data.parents === "object" && !Array.isArray(data.parents)) {
		for (const [child, parent] of Object.entries(data.parents)) {
			if (typeof child !== "string" || !child || typeof parent !== "string" || !parent || child === parent) continue;
			addFork(child);
			parents[child] = parent;
		}
	}
	return { version: FORK_REGISTRY_VERSION, forks, parents };
}

function readForkRegistry(options = {}) {
	const file = forksPath();
	try {
		return normalizeForkRegistry(JSON.parse(fs.readFileSync(file, "utf8")));
	} catch (error) {
		if (error?.code === "ENOENT") return normalizeForkRegistry({});
		if (options.strict) throw new Error(`could not read the fork registry: ${error.message ?? error}`);
		return normalizeForkRegistry({});
	}
}

function writeForkRegistry(registry) {
	const file = forksPath();
	const normalized = normalizeForkRegistry(registry);
	const relationshipIds = new Set(Object.keys(normalized.parents));
	const labelOnly = normalized.forks.filter((id) => !relationshipIds.has(id)).slice(-FORK_REGISTRY_LABEL_LIMIT);
	normalized.forks = [...labelOnly, ...normalized.forks.filter((id) => relationshipIds.has(id))];
	const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		fs.writeFileSync(temporary, `${JSON.stringify(normalized)}\n`, { flag: "wx", mode: 0o600 });
		fs.renameSync(temporary, file);
	} finally {
		fs.rmSync(temporary, { force: true });
	}
}

function forkOperationLockPath() {
	return `${forksPath()}.operation-lock`;
}

function forkOperationOwnerPath(lockPath) {
	return path.join(lockPath, "owner.json");
}

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (error?.code === "ESRCH") return false;
		if (error?.code === "EPERM") return true;
		return undefined;
	}
}

function reclaimAbandonedForkOperationLock(lockPath) {
	let stat;
	try {
		stat = fs.statSync(lockPath);
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		return false;
	}
	let owner;
	try {
		owner = JSON.parse(fs.readFileSync(forkOperationOwnerPath(lockPath), "utf8"));
	} catch {
		if (Date.now() - stat.mtimeMs < FORK_OPERATION_LOCK_ORPHAN_GRACE_MS) return false;
	}
	if (owner?.released === true) {
		try {
			fs.rmSync(lockPath, { recursive: true, force: true });
			return true;
		} catch {
			return false;
		}
	}
	if (owner?.hostname && owner.hostname !== os.hostname()) return false;
	const alive = processIsAlive(Number(owner?.pid));
	if (alive === true) return false;
	if (alive === undefined && Date.now() - stat.mtimeMs < FORK_OPERATION_LOCK_ORPHAN_GRACE_MS) return false;
	try {
		fs.rmSync(lockPath, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

export async function acquireForkOperationLock(options = {}) {
	const lockPath = forkOperationLockPath();
	const timeoutMs = Number.isFinite(options.timeoutMs)
		? Math.max(0, Math.trunc(options.timeoutMs))
		: FORK_OPERATION_LOCK_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	const token = randomUUID();
	const owner = {
		pid: process.pid,
		hostname: os.hostname(),
		token,
		createdAt: new Date().toISOString(),
		operation: typeof options.operation === "string" ? options.operation : "fork storage mutation",
	};
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	while (true) {
		try {
			fs.mkdirSync(lockPath);
			try {
				fs.writeFileSync(forkOperationOwnerPath(lockPath), `${JSON.stringify(owner)}\n`, { flag: "wx", mode: 0o600 });
			} catch (error) {
				fs.rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			let released = false;
			return () => {
				if (released) return true;
				let current;
				try {
					current = JSON.parse(fs.readFileSync(forkOperationOwnerPath(lockPath), "utf8"));
				} catch {
					return false;
				}
				if (current?.token !== token) {
					released = true;
					return false;
				}
				try {
					fs.rmSync(lockPath, { recursive: true, force: true });
					released = true;
					return true;
				} catch {
					try {
						fs.writeFileSync(
							forkOperationOwnerPath(lockPath),
							`${JSON.stringify({ ...current, released: true, releasedAt: new Date().toISOString() })}\n`,
							{ mode: 0o600 },
						);
					} catch {}
					return false;
				}
			};
		} catch (error) {
			if (error?.code !== "EEXIST") {
				throw new Error(`could not acquire the fork operation lock: ${error.message ?? error}`);
			}
			if (reclaimAbandonedForkOperationLock(lockPath)) continue;
			if (Date.now() >= deadline) {
				throw new Error("another cc process is changing Codex fork storage; try again after it finishes");
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
}

function updateForkRegistry(mutator, options = {}) {
	const file = forksPath();
	const lock = `${file}.lock`;
	const deadline = Date.now() + FORK_REGISTRY_LOCK_TIMEOUT_MS;
	let locked = false;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		while (!locked) {
			try {
				fs.mkdirSync(lock);
				locked = true;
			} catch (error) {
				if (error?.code !== "EEXIST") throw error;
				try {
					if (Date.now() - fs.statSync(lock).mtimeMs > FORK_REGISTRY_STALE_LOCK_MS) {
						fs.rmSync(lock, { recursive: true, force: true });
						continue;
					}
				} catch (statError) {
					if (statError?.code === "ENOENT") continue;
					throw statError;
				}
				if (Date.now() >= deadline) throw new Error("timed out waiting for the fork registry lock");
				Atomics.wait(FORK_REGISTRY_LOCK_WAIT, 0, 0, 10);
			}
		}
		const registry = readForkRegistry({ strict: true });
		const changed = mutator(registry) !== false;
		if (changed) writeForkRegistry(registry);
		return true;
	} catch (error) {
		if (options.required) throw new Error(`could not update the fork registry: ${error.message ?? error}`);
		return false;
	} finally {
		if (locked) fs.rmSync(lock, { recursive: true, force: true });
	}
}

export function loadForkIds() {
	return new Set(readForkRegistry().forks);
}

export function loadForkParents() {
	return new Map(Object.entries(readForkRegistry().parents));
}

export function recordForkId(sessionId, parentSessionId = undefined, options = {}) {
	if (!sessionId) return false;
	return updateForkRegistry((registry) => {
		let changed = false;
		if (!registry.forks.includes(sessionId)) {
			registry.forks.push(sessionId);
			changed = true;
		}
		if (parentSessionId && parentSessionId !== sessionId && registry.parents[sessionId] !== parentSessionId) {
			registry.parents[sessionId] = parentSessionId;
			changed = true;
		}
		return changed;
	}, { required: options.required === true || Boolean(parentSessionId) });
}

export function forgetForkIds(sessionIds, options = {}) {
	const canonicalId = (id) => {
		const value = String(id);
		return isUuid(value) ? value.toLowerCase() : value;
	};
	const ids = new Set((Array.isArray(sessionIds) ? sessionIds : [sessionIds]).filter(Boolean).map(canonicalId));
	if (ids.size === 0) return true;
	return updateForkRegistry((registry) => {
		const previousLength = registry.forks.length;
		registry.forks = registry.forks.filter((id) => !ids.has(canonicalId(id)));
		let changed = registry.forks.length !== previousLength;
		for (const id of Object.keys(registry.parents)) {
			if (ids.has(canonicalId(id))) {
				delete registry.parents[id];
				changed = true;
			}
		}
		return changed;
	}, options);
}

function forkDescendantIds(parentId, parents) {
	const children = new Map();
	for (const [child, parent] of Object.entries(parents ?? {})) {
		const canonicalParent = isUuid(parent) ? parent.toLowerCase() : parent;
		const list = children.get(canonicalParent) ?? [];
		list.push(child);
		children.set(canonicalParent, list);
	}
	const rawRoot = String(parentId ?? "");
	const root = isUuid(rawRoot) ? rawRoot.toLowerCase() : rawRoot;
	const visited = new Set();
	const visiting = new Set([root]);
	const result = [];
	const visit = (parent) => {
		for (const child of children.get(parent) ?? []) {
			const canonicalChild = isUuid(child) ? child.toLowerCase() : child;
			if (canonicalChild === root || visiting.has(canonicalChild) || visited.has(canonicalChild)) continue;
			visiting.add(canonicalChild);
			visit(canonicalChild);
			visiting.delete(canonicalChild);
			visited.add(canonicalChild);
			result.push(child);
		}
	};
	visit(root);
	return result;
}

export function loadForkDescendantIds(parentId) {
	return forkDescendantIds(parentId, readForkRegistry().parents);
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

export function applyHarnessSettings(config, settings = {}, grants = []) {
	settings = normalizeSettings(settings, config.theme ?? config.settings?.theme);
	const normalized = normalizeHarnessSettings(settings);
	const agents = {};
	for (const [key, agent] of Object.entries(config.agents ?? {})) {
		agents[key] = applyAgentSettings(key, agent, normalized[key] ?? {}, settings.permissions, grants);
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

function applyAgentSettings(key, agent, settings, globalPermissions, grants = []) {
	const applied = clonePlain(agent);
	if (!isPlainObject(settings)) {
		applyNativePermissionSetting(key, applied, {}, globalPermissions, grants);
		return applied;
	}
	applied.env = { ...(applied.env ?? {}), ...(settings.env ?? {}) };
	if (applied.acp) applied.acp = clonePlain(applied.acp);
	if (Array.isArray(settings.mcpServers)) applied.mcpServers = clonePlain(settings.mcpServers);
	if (Array.isArray(settings.additionalDirectories)) applied.additionalDirectories = [...settings.additionalDirectories];

	const command = applied.acp ?? applied;
	const nativeArgs = stringArray(settings.args ?? settings.nativeArgs);
	if (nativeArgs.length > 0) command.args = applyNativeArgs(key, command.args ?? [], nativeArgs);

	const acpArgs = stringArray(settings.acpArgs);
	if (acpArgs.length > 0) command.args = [...(command.args ?? []), ...acpArgs];

	if (isPlainObject(settings.config)) applyConfigSettings(key, applied, settings.config);
	if (isPlainObject(settings.settings)) applyNativeSettings(key, applied, settings.settings);
	applyNativePermissionSetting(key, applied, settings, globalPermissions, grants);
	return applied;
}

function applyNativeArgs(key, baseArgs, nativeArgs) {
	if (key === "cursor") return insertArgsBefore(baseArgs, "acp", nativeArgs);
	return [...baseArgs, ...nativeArgs];
}

function applyConfigSettings(key, agent, config) {
	if (key !== "codex") return;
	const existing = {
		...parseCodexConfig(process.env.CODEX_CONFIG),
		...parseCodexConfig(agent.env?.CODEX_CONFIG),
	};
	agent.env = {
		...(agent.env ?? {}),
		CODEX_CONFIG: JSON.stringify({ ...existing, ...config }),
	};
}

function removeConfigSettings(key, agent, names) {
	if (key !== "codex") return;
	const parsed = {
		...parseCodexConfig(process.env.CODEX_CONFIG),
		...parseCodexConfig(agent.env?.CODEX_CONFIG),
	};
	for (const name of names) delete parsed[name];
	agent.env = { ...(agent.env ?? {}), CODEX_CONFIG: JSON.stringify(parsed) };
}

function parseCodexConfig(value) {
	try {
		const parsed = JSON.parse(value ?? "{}");
		return isPlainObject(parsed) ? parsed : {};
	} catch {
		return {};
	}
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

// Resolve the harness-agnostic permission mode for an agent and apply it. An
// explicit unified `permissions.mode` (per-agent, then global) wins; otherwise it
// is inferred from native settings for back-compat. When the user expressed the
// unified mode directly, the backend's native dialect is generated too so cc and
// the backend never disagree. The decisioning side reads `agent._permissionMode`.
function applyNativePermissionSetting(key, agent, settings, globalPermissions, grants = []) {
	const explicitMode =
		normalizePermissionSettings(settings.permissions).mode ?? normalizePermissionSettings(globalPermissions).mode;
	// Pass the FINAL applied command args so a cursor --force baked into the base
	// acp.args (not just settings) is still inferred as auto.
	const appliedArgs = (agent.acp ?? agent).args ?? [];
	const mode = explicitMode ?? inferModeFromNative(key, settings, appliedArgs);
	if (mode) agent._permissionMode = mode;
	if (!mode) return;
	// auto with any deny rule/grant must NOT use a native bypass that stops the
	// backend asking — cc would never get to apply the denial. Gate it instead.
	const fullSettings = { permissions: globalPermissions, agents: { [key]: { permissions: settings.permissions } } };
	const gated = mode === "auto" && policyNeedsGating(resolvePermissionPolicy(fullSettings, key, grants));
	const native = nativePermissionConfig(key, mode, { gated });
	if (native.autoApprove) agent._autoPermissionRequests = true;
	if (native.startupMode) agent._startupMode = native.startupMode;
	// True iff the backend is launched in a real native bypass (no prompts): non-
	// gated auto on a harness that has a bypass dialect. Gated auto keeps prompting,
	// and generic harnesses have no bypass, so for those a runtime /yolo tighten
	// DOES take effect — only set this for the genuine can't-tighten-at-runtime case.
	if (mode === "auto" && !gated && (native.startupMode || native.config || native.args)) {
		agent._nativeBypass = true;
	}
	// Generate the backend's native dialect when the user chose the unified mode
	// directly (also neutralizing any conflicting native auto/bypass), OR when we
	// must gate an inferred auto so a deny rule is actually enforceable. Pure
	// back-compat (inferred, no gating) keeps the spawn spec byte-identical.
	if (explicitMode || gated) applyGeneratedNativeConfig(key, agent, native);
}

// Fold engine-generated native config into the spawn spec. Generated config keys
// OVERRIDE any conflicting user value (an explicit unified `mode: auto` must win,
// or cc and the backend would disagree); generated args are de-duplicated.
function applyGeneratedNativeConfig(key, agent, native) {
	const command = agent.acp ?? agent;
	if (native.settings) applyNativeSettings(key, agent, native.settings);
	if (Array.isArray(native.removeConfig) && native.removeConfig.length > 0) removeConfigSettings(key, agent, native.removeConfig);
	if (native.config) applyConfigSettings(key, agent, native.config);
	if (Array.isArray(native.removeArgs) && native.removeArgs.length > 0) {
		command.args = stripFlags(command.args ?? [], native.removeArgs);
	}
	if (Array.isArray(native.args) && native.args.length > 0) {
		const args = command.args ?? [];
		const missing = native.args.filter((arg) => !args.includes(arg));
		if (missing.length > 0) command.args = applyNativeArgs(key, args, missing);
	}
}

function insertArgsBefore(baseArgs, marker, inserted) {
	const index = baseArgs.indexOf(marker);
	if (index === -1) return [...baseArgs, ...inserted];
	return [...baseArgs.slice(0, index), ...inserted, ...baseArgs.slice(index)];
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
