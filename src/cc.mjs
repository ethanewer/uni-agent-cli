#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STARTUP_INPUT_GUARD = Symbol.for("cc.startup-input-guard");
const TERMINAL_RESTORE_MONITOR = Symbol.for("cc.terminal-restore-monitor");

function startTerminalRestoreMonitor(state) {
	if (!state || !process.stdin.isTTY || process.platform === "win32") return undefined;
	try {
		const monitor = spawn(process.execPath, [fileURLToPath(new URL("./terminal-restore.mjs", import.meta.url)), state], {
			detached: true,
			env: {},
			stdio: ["pipe", "ignore", "ignore", process.stdin],
			windowsHide: true,
		});
		monitor.on("error", () => {});
		monitor.unref();
		monitor.stdin.unref?.();
		globalThis[TERMINAL_RESTORE_MONITOR] = monitor;
		return monitor;
	} catch {
		return undefined;
	}
}

function restoreTerminalMode(state) {
	if (!state) return true;
	let tty;
	try {
		if (process.platform !== "win32") tty = fs.openSync("/dev/tty", "r+");
		const restored = spawnSync("stty", [state], {
			stdio: [tty ?? "inherit", "ignore", "ignore"],
			timeout: 1_000,
		});
		if (restored.status !== 0) return false;
		// macOS includes the transient PENDIN state in `stty -g`, but replaying
		// the encoded state does not set that bit. Restore it explicitly when it
		// was present in the shell snapshot so SIGKILL recovery is exact too.
		const localFlags = /^gfmt1:.*(?:^|:)lflag=([0-9a-f]+)(?::|$)/u.exec(state)?.[1];
		if (process.platform === "darwin" && localFlags &&
			(BigInt(`0x${localFlags}`) & 0x20000000n) !== 0n) {
			const pending = spawnSync("stty", ["pendin"], {
				stdio: [tty ?? "inherit", "ignore", "ignore"], timeout: 1_000,
			});
			if (pending.status !== 0) return false;
		}
	} catch {
		// Best effort only; setRawMode(false) below still restores ordinary launches.
		return false;
	} finally { if (tty !== undefined) try { fs.closeSync(tty); } catch {} }
	return true;
}

function captureTerminalMode() {
	if (!process.stdin.isTTY || process.platform === "win32") return undefined;
	let tty;
	try {
		tty = fs.openSync("/dev/tty", "r+");
		const captured = spawnSync("stty", ["-g"], {
			encoding: "utf8",
			stdio: [tty, "pipe", "ignore"],
			timeout: 1_000,
		});
		const state = String(captured.stdout ?? "").trim();
		return captured.status === 0 && state.length > 0 && state.length <= 4_096 && !/[\r\n\0]/u.test(state) ? state : undefined;
	} catch {
		return undefined;
	} finally { if (tty !== undefined) try { fs.closeSync(tty); } catch {} }
}

function restoreInheritedTerminalMode() {
	const state = process.env.CC_STARTUP_STTY_STATE;
	if (!restoreTerminalMode(state)) return false;
	delete process.env.CC_STARTUP_STTY_STATE;
	return true;
}

const expectedLauncherPid = Number(process.env.CC_LAUNCHER_PID);
const hasExpectedLauncher = Number.isSafeInteger(expectedLauncherPid) && expectedLauncherPid > 1;
const terminateAfterLauncherLoss = () => {
	if (!hasExpectedLauncher || process.ppid === expectedLauncherPid) return;
	const guard = globalThis[STARTUP_INPUT_GUARD];
	if (guard?.terminate) guard.terminate(143);
	else {
		restoreInheritedTerminalMode();
		process.exit(143);
	}
};
if (hasExpectedLauncher && process.ppid !== expectedLauncherPid) terminateAfterLauncherLoss();
const launcherLifetimeMonitor = hasExpectedLauncher ? setInterval(terminateAfterLauncherLoss, 50) : undefined;
launcherLifetimeMonitor?.unref();

function beginStartupInputGuard(enabled) {
	if (!enabled || !process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return undefined;
	const chunks = [];
	const originalRaw = process.stdin.isRaw === true;
	const inheritedTerminalMode = process.env.CC_STARTUP_STTY_STATE;
	const startupTerminalMode = inheritedTerminalMode ?? captureTerminalMode();
	startTerminalRestoreMonitor(startupTerminalMode);
	let listening = true;
	let restored = false;
	let terminating = false;
	const startupSignalHandlers = new Map();
	const releaseSignalHandlers = () => {
		for (const [signal, handler] of startupSignalHandlers) process.removeListener(signal, handler);
		startupSignalHandlers.clear();
	};
	const onData = (data) => chunks.push(Buffer.isBuffer(data) ? Buffer.from(data) : String(data));
	process.stdin.on("data", onData);
	try {
		// The shell launcher enters cbreak/no-echo before doing any prepaint work.
		// Once this listener owns all pending bytes, restore the exact prior mode
		// synchronously and let Node enter raw mode from that clean baseline. Pi can
		// then restore normally without carrying an stty operation into shutdown.
		restoreInheritedTerminalMode();
		process.stdin.setRawMode(true);
		process.stdin.resume();
	} catch {
		process.stdin.removeListener("data", onData);
		restoreInheritedTerminalMode();
		return undefined;
	}
	const guard = {
		originalRaw,
		releaseSignalHandlers,
		handoff() {
			releaseSignalHandlers();
			if (listening) process.stdin.removeListener("data", onData);
			listening = false;
			return chunks.splice(0);
		},
		restore() {
			if (restored) return;
			restored = true;
			releaseSignalHandlers();
			if (listening) process.stdin.removeListener("data", onData);
			listening = false;
			try {
				process.stdin.setRawMode(originalRaw);
			} catch {
				// The terminal may already have disappeared.
			}
			// libuv may have initialized its TTY handle while the shell launcher's
			// cbreak guard was active. Restore the shell's exact termios snapshot as
			// the final authority instead of assuming setRawMode(false) is equivalent.
			restoreTerminalMode(startupTerminalMode);
		},
		terminate(exitCode) {
			if (restored) return;
			restored = true;
			releaseSignalHandlers();
			if (listening) process.stdin.removeListener("data", onData);
			listening = false;
			try { process.stdin.setRawMode(originalRaw); } catch {}
			process.stdin.pause();
			let finished = false;
			const finish = () => {
				if (finished) return;
				finished = true;
				restoreTerminalMode(startupTerminalMode);
				process.exit(exitCode);
			};
			process.stdin.once("close", finish);
			try { process.stdin.destroy(); } catch {}
			setTimeout(finish, 50);
		},
	};
	globalThis[STARTUP_INPUT_GUARD] = guard;
	for (const signal of ["SIGINT", "SIGTERM"]) {
		const handler = () => {
			if (terminating) return;
			terminating = true;
			guard.terminate(signal === "SIGINT" ? 130 : 143);
			// Re-signalling from inside a one-shot libuv signal callback can be
			// swallowed while the old watcher is being removed (observed on Node 24),
			// leaving startup alive in raw mode. Shell-visible signal exit semantics
			// are the conventional 128 + signal number codes.
			return;
		};
		startupSignalHandlers.set(signal, handler);
		process.once(signal, handler);
	}
	return guard;
}

const nodeVersionParts = process.versions.node.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
const [nodeMajorVersion, nodeMinorVersion, nodePatchVersion] = nodeVersionParts;
const supportedNodeVersion =
	nodeVersionParts.length === 3 &&
	nodeVersionParts.every(Number.isFinite) &&
	(nodeMajorVersion > 22 || (
		nodeMajorVersion === 22 &&
		(nodeMinorVersion > 19 || nodeMinorVersion === 19 && nodePatchVersion >= 0)
	));
if (!supportedNodeVersion) {
	restoreInheritedTerminalMode();
	if (process.env.CC_PREPAINTED === "1") {
		// The shell launcher has already drawn a placeholder and hidden the cursor.
		// Tear it down before exiting so an unsupported Node version cannot leave
		// the user's terminal in a hidden-cursor state.
		process.stdout.write("\x1b8\x1b[J\x1b[?25h");
	}
	console.error(
		`cc requires Node.js 22.19.0 or newer (found ${process.versions.node}). Upgrade Node.js, then reinstall cc.`,
	);
	process.exit(1);
}

const args = process.argv.slice(2);
const startsInteractiveTui =
	process.stdout.isTTY &&
	!args.includes("--help") &&
	!args.includes("-h") &&
	!args.includes("--list");
const shouldPrepaint =
	process.env.CC_PREPAINTED !== "1" &&
	!isVsCodeTerminal() &&
	startsInteractiveTui;
const startupInputGuard = beginStartupInputGuard(startsInteractiveTui);

function prepaint(args) {
	const width = process.stdout.columns || Number(process.env.COLUMNS) || 80;
	const preload = preloadConfig();
	const themeName = resolveThemeName(preload.settings.theme) ?? "system";
	const theme = PREPAINT_THEMES[themeName] ?? PREPAINT_THEMES.system;
	const styles = createPrepaintStyles(theme);
	const agent = args.find((arg) => !arg.startsWith("-")) || preload.config.defaultAgent || "codex";
	const defaults = preload.settings?.agents?.[agent]?.sessionDefaults;
	const model = typeof defaults?.modelDisplay === "string" && defaults.modelDisplay
		? defaults.modelDisplay
		: typeof defaults?.model === "string" ? defaults.model : "";
	const effort = typeof defaults?.effort === "string" ? defaults.effort : "";
	const modelDetails = [model, effort].filter(Boolean).join(" ");
	process.env.CC_PREPAINT_AGENT = agent;
	process.env.CC_PREPAINT_THEME = themeName;
	const cwd = compactCwd(process.cwd());
	const rule = "─".repeat(Math.max(1, width));
	const voice = `${styles.accent("○")}   ${styles.muted("Space to record · Ctrl+Space for text")}`;
	const status = styles.muted(`${modelDetails ? `${agent} · ${modelDetails}` : `${agent} acp`} · ${cwd}`);
	process.stdout.write(
		`\x1b7\x1b[?2026h${styles.primary(rule)}\r\n${truncateEllipsis(voice, width)}\r\n${styles.primary(rule)}\r\n${truncateVisual(status, width)}\x1b[?2026l\x1b[?25l`,
	);
}

const PREPAINT_THEME_ALIASES = {
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

const PREPAINT_THEMES = {
	system: { system: true },
	opencode: { primary: "#7dd3fc", accent: "#34d399", muted: "#94a3b8" },
	"cursor-dark": { primary: "#81a1c1", accent: "#81a1c1", muted: "#898989" },
	"cursor-midnight": { primary: "#88c0d0", accent: "#8fbcbb", muted: "#4c566a" },
	"cursor-light": { primary: "#3c7cab", accent: "#3c7cab", muted: "#898989" },
	"cursor-high-contrast": { primary: "#434c5e", accent: "#88c0d0", muted: "#505050" },
	"vscode-dark-modern": { primary: "#0078d4", accent: "#4daafc", muted: "#9d9d9d" },
	"vscode-dark-plus": { primary: "#569cd6", accent: "#4ec9b0", muted: "#808080" },
	"vscode-light-modern": { primary: "#005fb8", accent: "#267f99", muted: "#6e7681" },
	"vscode-light-plus": { primary: "#0000ff", accent: "#267f99", muted: "#6f6f6f" },
	"vscode-dark-2026": { primary: "#3994bc", accent: "#48a0c7", muted: "#8c8c8c" },
	"vscode-light-2026": { primary: "#0069cc", accent: "#0a3069", muted: "#606060" },
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

function truncateEllipsis(value, width) {
	return truncateAnsi(value, width, "...");
}

function truncateVisual(value, width) {
	if (stripAnsi(value).length <= width) return value;
	return `${truncateEllipsis(value, Math.max(1, width - 1))}~`;
}

function truncateAnsi(value, width, ellipsis) {
	if (width <= 0) return "";
	const ellipsisWidth = stripAnsi(ellipsis).length;
	if (ellipsisWidth >= width) return `\x1b[0m${ellipsis.slice(0, width)}\x1b[0m`;
	const textWidth = stripAnsi(value).length;
	if (textWidth <= width) return value;
	const contentWidth = width - ellipsisWidth;
	let visible = 0;
	let output = "";
	for (let index = 0; index < value.length && visible < contentWidth; ) {
		const ansi = value.slice(index).match(/^\x1b\[[\d;?]*[ -/]*[@-~]/);
		if (ansi) {
			output += ansi[0];
			index += ansi[0].length;
			continue;
		}
		const char = value[index];
		output += char;
		index += char.length;
		visible += 1;
	}
	return `${output}\x1b[0m${ellipsis}\x1b[0m`;
}

function stripAnsi(value) {
	return value.replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
}

if (shouldPrepaint) {
	process.env.CC_PREPAINTED = "1";
	prepaint(args);
}

const testImportDelay = Number(process.env.CC_TEST_STARTUP_IMPORT_DELAY_MS);
if (Number.isFinite(testImportDelay) && testImportDelay > 0) {
	await new Promise((resolve) => setTimeout(resolve, Math.min(testImportDelay, 10_000)));
}

try {
	const { runCli } = await import("./pi-harness.mjs");
	await runCli(args);
} catch (error) {
	startupInputGuard?.restore();
	if (shouldPrepaint) process.stdout.write("\x1b8\x1b[J\x1b[?25h");
	console.error(`cc: ${error?.message ?? error}`);
	process.exit(1);
}
