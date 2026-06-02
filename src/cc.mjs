#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const shouldPrepaint =
	process.env.CC_PREPAINTED !== "1" &&
	!isVsCodeTerminal() &&
	process.stdout.isTTY &&
	!args.includes("--help") &&
	!args.includes("-h") &&
	!args.includes("--list");

function prepaint(args) {
	const width = process.stdout.columns || Number(process.env.COLUMNS) || 80;
	const preload = preloadConfig();
	const themeName = resolveThemeName(preload.settings.theme) ?? "system";
	const theme = PREPAINT_THEMES[themeName] ?? PREPAINT_THEMES.system;
	const styles = createPrepaintStyles(theme);
	const agent = args.find((arg) => !arg.startsWith("-")) || preload.config.defaultAgent || "codex";
	process.env.CC_PREPAINT_AGENT = agent;
	process.env.CC_PREPAINT_THEME = themeName;
	const cwd = compactCwd(process.cwd());
	const rule = "─".repeat(Math.max(1, width));
	const voice = `${styles.accent("○")}   ${styles.muted("Space to record · Ctrl+Space for text")}`;
	const status = styles.muted(`${agent} acp · ${cwd}`);
	process.stdout.write(`\x1b7\x1b[?2026h${styles.primary(rule)}\n${truncate(voice, width)}\n${styles.primary(rule)}\n${truncate(status, width)}\x1b[?2026l\x1b[?25l`);
}

const PREPAINT_THEME_ALIASES = {
	onedark: "one-dark",
	"one_dark": "one-dark",
	catppuccinmacchiato: "catppuccin-macchiato",
	"catppuccin_macchiato": "catppuccin-macchiato",
	tokyo: "tokyonight",
	"tokyo-night": "tokyonight",
};

const PREPAINT_THEMES = {
	system: { system: true },
	opencode: { primary: "#7dd3fc", accent: "#34d399", muted: "#94a3b8" },
	tokyonight: { primary: "#7aa2f7", accent: "#7dcfff", muted: "#565f89" },
	everforest: { primary: "#a7c080", accent: "#83c092", muted: "#859289" },
	ayu: { primary: "#59c2ff", accent: "#95e6cb", muted: "#626a73" },
	catppuccin: { primary: "#89b4fa", accent: "#94e2d5", muted: "#7f849c" },
	"catppuccin-macchiato": { primary: "#8aadf4", accent: "#8bd5ca", muted: "#8087a2" },
	gruvbox: { primary: "#83a598", accent: "#8ec07c", muted: "#928374" },
	kanagawa: { primary: "#7e9cd8", accent: "#7aa89f", muted: "#727169" },
	nord: { primary: "#88c0d0", accent: "#8fbcbb", muted: "#81a1c1" },
	matrix: { primary: "#00ff41", accent: "#00cc33", muted: "#4f8f5c" },
	"one-dark": { primary: "#61afef", accent: "#56b6c2", muted: "#5c6370" },
	dracula: { primary: "#8be9fd", accent: "#50fa7b", muted: "#6272a4" },
	monokai: { primary: "#66d9ef", accent: "#a6e22e", muted: "#75715e" },
};

function createPrepaintStyles(theme) {
	if (theme.system) {
		return {
			primary: (text) => `\x1b[34m${text}\x1b[39m`,
			accent: (text) => `\x1b[36m${text}\x1b[39m`,
			muted: (text) => `\x1b[2m${text}\x1b[22m`,
		};
	}
	return {
		primary: truecolorStyle(theme.primary),
		accent: truecolorStyle(theme.accent),
		muted: truecolorStyle(theme.muted),
	};
}

function preloadConfig() {
	const config = readJson(configPath()) ?? {};
	const settings = deepMerge(config.settings ?? {}, readJson(settingsPath()) ?? {});
	const themeSource = Object.prototype.hasOwnProperty.call(settings, "theme") ? settings.theme : config.theme;
	return {
		config,
		settings: {
			...settings,
			theme: resolveThemeName(themeSource) ?? "system",
		},
	};
}

function configPath() {
	return process.env.CC_CONFIG || path.join(os.homedir(), ".config", "cc", "config.json");
}

function settingsPath() {
	return process.env.CC_SETTINGS || path.join(os.homedir(), ".config", "cc", "settings.json");
}

function readJson(file) {
	try {
		return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : undefined;
	} catch {
		return undefined;
	}
}

function deepMerge(base, override) {
	if (!override || typeof override !== "object" || Array.isArray(override)) return override ?? base;
	const merged = { ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}) };
	for (const [key, value] of Object.entries(override)) {
		merged[key] = deepMerge(merged[key], value);
	}
	return merged;
}

function resolveThemeName(value) {
	const key = String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-");
	if (!key) return undefined;
	if (PREPAINT_THEMES[key]) return key;
	const alias = PREPAINT_THEME_ALIASES[key] ?? PREPAINT_THEME_ALIASES[key.replace(/[-_]/g, "")];
	return PREPAINT_THEMES[alias] ? alias : undefined;
}

function truecolorStyle(hex) {
	const rgb = hexToRgb(hex);
	return (text) => `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}\x1b[39m`;
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

function isVsCodeTerminal(env = process.env) {
	return env.TERM_PROGRAM === "vscode" || Boolean(env.VSCODE_PID || env.VSCODE_INJECTION);
}

function compactCwd(cwd) {
	const home = process.env.HOME;
	return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

function truncate(value, width) {
	return stripAnsi(value).length <= width ? value : `${value.slice(0, Math.max(1, width - 1))}~`;
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
}

if (shouldPrepaint) {
	process.env.CC_PREPAINTED = "1";
	prepaint(args);
}

try {
	const { runCli } = await import("./pi-harness.mjs");
	await runCli(args);
} catch (error) {
	if (shouldPrepaint) process.stdout.write("\x1b8\x1b[J\x1b[?25h");
	console.error(`cc: ${error?.message ?? error}`);
	process.exit(1);
}
