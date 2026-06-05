import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	AcpClient,
	applyHarnessSettings,
	autoPermissionOutcome,
	findConfigValue,
	findMode,
	flattenModes,
	HarnessApp,
	hideCursorDuringRender,
	isVsCodeAutoActivationCommand,
	isVsCodeTerminal,
	loadConfig,
	resolveThemeName,
	rewriteFullScreenClear,
	saveSettingsPatch,
	shouldDropVsCodeAutoActivationInput,
	stabilizeGrowingRenderedLines,
	stabilizeMutableRenderedLines,
	themeNames,
} from "../src/pi-harness.mjs";

function clipboardReplayHarness() {
	const replayed = [];
	const app = Object.create(HarnessApp.prototype);
	app.bufferedClipboardPasteInput = [];
	app.clipboardPasteInProgress = false;
	app.ui = {
		handleInput(data) {
			replayed.push(data);
		},
	};
	return { app, replayed };
}

function afterToolHarness() {
	let cancelCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.busy = true;
	app.afterToolCancelPending = false;
	app.cancelRequested = false;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.seenToolThisTurn = false;
	app.promptQueue = [{ text: "queued", timing: "afterTool" }];
	app.client = {
		cancel() {
			cancelCount += 1;
		},
	};
	app.statusState = "working";
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	return { app, cancelCount: () => cancelCount };
}

function busyPromptHarness(agentName = "codex-acp") {
	const prompts = [];
	let cancelCount = 0;
	const app = Object.create(HarnessApp.prototype);
	app.ready = true;
	app.busy = true;
	app.cancelRequested = false;
	app.sessionSwitchInProgress = false;
	app.activeKey = agentName === "codex-acp" ? "codex" : "claude";
	app.config = config;
	app.client = {
		agentInfo: { name: agentName },
		prompt(prompt) {
			prompts.push(prompt);
			return new Promise(() => {});
		},
		cancel() {
			cancelCount += 1;
		},
	};
	app.sessionStates = new Map([[app.activeKey, { agentInfo: { name: agentName } }]]);
	app.promptQueue = [];
	app.promptQueueDrainScheduled = false;
	app.afterToolCancelPending = false;
	app.seenToolThisTurn = false;
	app.activeToolIds = new Set();
	app.activeAnonymousToolCount = 0;
	app.updateSpinner = () => {};
	app.ui = { requestRender() {} };
	app.promptForActiveCapabilities = (text) => text;
	return { app, prompts, cancelCount: () => cancelCount };
}

const config = {
	defaultAgent: "codex",
	agents: {
		claude: {
			label: "Claude Code",
			transport: "acp",
			acp: { command: "claude-agent-acp", args: [] },
		},
		codex: {
			label: "Codex",
			transport: "acp",
			acp: { command: "codex-acp", args: [] },
		},
		cursor: {
			label: "Cursor Agent",
			transport: "acp",
			acp: { command: "cursor-agent", args: ["acp"] },
		},
		"terminus-2": {
			label: "Terminus-2",
			transport: "acp",
			acp: { command: "python3", args: ["src/harnesses/terminus_2/bridge.py"] },
		},
		"mini-swe-agent": {
			label: "mini-swe-agent",
			transport: "acp",
			acp: { command: "python3", args: ["src/harnesses/mini_swe_agent/bridge.py"] },
		},
	},
};

{
	const { app, replayed } = clipboardReplayHarness();
	app.bufferClipboardPasteInput("\r");
	app.bufferClipboardPasteInput("n");
	app.flushBufferedClipboardPasteInput({ allowSubmit: true });
	assert.deepEqual(replayed, ["\r", "n"]);
	assert.deepEqual(app.bufferedClipboardPasteInput, []);
}

{
	const { app, replayed } = clipboardReplayHarness();
	app.bufferClipboardPasteInput("a");
	app.bufferClipboardPasteInput("\r");
	app.bufferClipboardPasteInput("b");
	app.bufferClipboardPasteInput("\n");
	app.bufferClipboardPasteInput("c");
	app.flushBufferedClipboardPasteInput({ allowSubmit: false });
	assert.deepEqual(replayed, ["a", "b", "c"]);
	assert.deepEqual(app.bufferedClipboardPasteInput, []);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus("read-1", "running");
	app.trackToolStatus("read-2", "running");
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 0);
	assert.equal(app.cancelRequested, false);
	assert.equal(app.afterToolCancelPending, false);
	app.trackToolStatus("read-2", "complete");
	assert.equal(cancelCount(), 1);
	assert.equal(app.cancelRequested, true);
	assert.equal(app.afterToolCancelPending, true);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running");
	assert.equal(cancelCount(), 0);
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 1);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running");
	app.trackToolStatus(undefined, "running");
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 0);
	assert.equal(app.activeAnonymousToolCount, 1);
	app.trackToolStatus(undefined, "complete");
	assert.equal(cancelCount(), 1);
	assert.equal(app.activeAnonymousToolCount, 0);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running", { startsTool: true });
	app.trackToolStatus(undefined, "running", { startsTool: false });
	assert.equal(app.activeAnonymousToolCount, 1);
	app.trackToolStatus(undefined, "complete", { startsTool: false });
	assert.equal(cancelCount(), 1);
	assert.equal(app.activeAnonymousToolCount, 0);
}

{
	const { app, cancelCount } = afterToolHarness();
	app.trackToolStatus(undefined, "running", { startsTool: true });
	app.trackToolStatus(undefined, "complete", { startsTool: true });
	assert.equal(app.activeAnonymousToolCount, 1);
	assert.equal(cancelCount(), 0);
	app.trackToolStatus(undefined, "complete", { startsTool: false });
	assert.equal(app.activeAnonymousToolCount, 0);
	assert.equal(cancelCount(), 1);
}

{
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	app.activeToolIds.add("read-1");
	await app.submitBackendPrompt("steer now");
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "steer now");
	assert.equal(app.promptQueue[0].timing, "afterTurn");
	assert.equal(cancelCount(), 0);
	app.promoteNextQueuedPromptToAfterTool();
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(cancelCount(), 0);
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 1);
}

{
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	app.activeToolIds.add("read-1");
	await app.submitBackendPrompt("first steer");
	await app.submitBackendPrompt("second queued");
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 2);
	assert.equal(app.promptQueue[0].timing, "afterTurn");
	assert.equal(app.promptQueue[1].timing, "afterTurn");
	app.promoteNextQueuedPromptToAfterTool();
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(app.promptQueue[1].timing, "afterTurn");
	app.trackToolStatus("read-1", "complete");
	assert.equal(cancelCount(), 1);

	app.promptQueue.shift();
	app.cancelRequested = false;
	app.afterToolCancelPending = false;
	app.seenToolThisTurn = false;
	app.activeToolIds.clear();
	app.activeAnonymousToolCount = 0;
	app.trackToolStatus("next-turn-tool", "running");
	app.trackToolStatus("next-turn-tool", "complete");
	assert.equal(cancelCount(), 1);
}

{
	const { app, prompts, cancelCount } = busyPromptHarness("fake-acp");
	app.seenToolThisTurn = true;
	await app.submitBackendPrompt("queue after tool");
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "queue after tool");
	assert.equal(app.promptQueue[0].timing, "afterTurn");
	assert.equal(cancelCount(), 0);
	app.promoteNextQueuedPromptToAfterTool();
	assert.equal(app.promptQueue[0].timing, "afterTool");
	assert.equal(cancelCount(), 1);
}

{
	const { app, prompts, cancelCount } = busyPromptHarness("codex-acp");
	app.seenToolThisTurn = true;
	await app.submitBackendPrompt("/review", { compactCommand: true });
	assert.deepEqual(prompts, []);
	assert.equal(app.promptQueue.length, 1);
	assert.equal(app.promptQueue[0].text, "/review");
	assert.equal(app.promptQueue[0].timing, "afterTurn");
	assert.equal(cancelCount(), 0);
}

{
	let invalidated = false;
	const app = Object.create(HarnessApp.prototype);
	app.ui = { terminal: { rows: 4 } };
	app.currentAssistantText = {
		invalidate: () => {
			invalidated = true;
		},
	};
	app.closeCurrentAssistantText();
	assert.equal(invalidated, true);
	assert.equal(app.currentAssistantText, undefined);
}

const applied = applyHarnessSettings(config, {
	agents: {
		claude: {
			settings: {
				model: "sonnet",
				permissions: { defaultMode: "bypassPermissions" },
			},
		},
		codex: {
			config: {
				model: "gpt-5",
				approval_policy: "never",
				sandbox_mode: "danger-full-access",
			},
		},
		cursor: {
			args: ["--model", "gpt-5", "--force", "--sandbox", "disabled", "--approve-mcps"],
		},
		"terminus-2": {
			args: ["--model", "openai/gpt-5", "--max-episodes", "2"],
		},
		"mini-swe-agent": {
			args: ["--model", "openai/gpt-5", "--no-yolo"],
		},
	},
});

assert.equal(applied.agents.claude._startupMode, "bypassPermissions");
assert.equal(applied.theme, "system");
assert.equal(applied.settings.theme, "system");
assert.equal(applied.agents.claude._autoPermissionRequests, true);
assert.deepEqual(applied.agents.claude._sessionMeta, {
	claudeCode: {
		options: {
			settings: {
				model: "sonnet",
				permissions: { defaultMode: "bypassPermissions" },
			},
		},
	},
});

assert.deepEqual(applied.agents.codex.acp.args, [
	"-c",
	"model=\"gpt-5\"",
	"-c",
	"approval_policy=\"never\"",
	"-c",
	"sandbox_mode=\"danger-full-access\"",
]);
assert.equal(applied.agents.codex._autoPermissionRequests, true);

assert.deepEqual(applied.agents.cursor.acp.args, [
	"--model",
	"gpt-5",
	"--force",
	"--sandbox",
	"disabled",
	"--approve-mcps",
	"acp",
]);
assert.equal(applied.agents.cursor._autoPermissionRequests, true);
assert.deepEqual(config.agents.cursor.acp.args, ["acp"]);
assert.deepEqual(applied.agents["terminus-2"].acp.args, [
	"src/harnesses/terminus_2/bridge.py",
	"--model",
	"openai/gpt-5",
	"--max-episodes",
	"2",
]);
assert.deepEqual(applied.agents["mini-swe-agent"].acp.args, [
	"src/harnesses/mini_swe_agent/bridge.py",
	"--model",
	"openai/gpt-5",
	"--no-yolo",
]);

const previousDefaultCcConfig = process.env.CC_CONFIG;
const previousDefaultCcSettings = process.env.CC_SETTINGS;
process.env.CC_CONFIG = path.join(os.tmpdir(), `cc-missing-config-${process.pid}.json`);
process.env.CC_SETTINGS = path.join(os.tmpdir(), `cc-missing-settings-${process.pid}.json`);
const defaultConfig = loadConfig();
if (previousDefaultCcConfig === undefined) delete process.env.CC_CONFIG;
else process.env.CC_CONFIG = previousDefaultCcConfig;
if (previousDefaultCcSettings === undefined) delete process.env.CC_SETTINGS;
else process.env.CC_SETTINGS = previousDefaultCcSettings;
assert.ok(defaultConfig.agents["terminus-2"]);
assert.ok(defaultConfig.agents["mini-swe-agent"]);
assert.match(defaultConfig.agents["terminus-2"].acp.args[0], /terminus_2\/bridge\.py$/);
assert.match(defaultConfig.agents["mini-swe-agent"].acp.args[0], /mini_swe_agent\/bridge\.py$/);

assert.ok(themeNames().includes("tokyonight"));
assert.ok(themeNames().includes("matrix"));
assert.ok(themeNames().includes("cursor-dark"));
assert.ok(themeNames().includes("cursor-midnight"));
assert.ok(themeNames().includes("vscode-dark-modern"));
assert.ok(themeNames().includes("vscode-dark-2026"));
assert.equal(resolveThemeName("Tokyo Night"), "tokyonight");
assert.equal(resolveThemeName("onedark"), "one-dark");
assert.equal(resolveThemeName("catppuccin_macchiato"), "catppuccin-macchiato");
assert.equal(resolveThemeName("cursor"), "cursor-dark");
assert.equal(resolveThemeName("Cursor Dark Midnight"), "cursor-midnight");
assert.equal(resolveThemeName("Cursor Dark High Contrast"), "cursor-high-contrast");
assert.equal(resolveThemeName("VS Code Dark Modern"), "vscode-dark-modern");
assert.equal(resolveThemeName("VS Code Dark+"), "vscode-dark-plus");
assert.equal(resolveThemeName("dark plus"), "vscode-dark-plus");
assert.equal(resolveThemeName("Light 2026"), "vscode-light-2026");
assert.equal(resolveThemeName("missing-theme"), undefined);
assert.equal(applyHarnessSettings(config, { agents: {}, theme: "matrix" }).theme, "matrix");
assert.equal(applyHarnessSettings(config, { agents: {}, theme: "not-real" }).theme, "system");

const previousCcSettings = process.env.CC_SETTINGS;
const previousCcConfig = process.env.CC_CONFIG;
const tempSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-theme-settings-"));
try {
	const settingsFile = path.join(tempSettingsDir, "settings.json");
	fs.writeFileSync(
		settingsFile,
		`${JSON.stringify({ agents: { codex: { config: { model: "gpt-4.1" } } } }, null, 2)}\n`,
	);
	process.env.CC_SETTINGS = settingsFile;
	process.env.CC_CONFIG = path.join(process.cwd(), "tests", "fake_config.json");

	const saved = saveSettingsPatch({ theme: "onedark" });
	assert.equal(saved.theme, "one-dark");
	assert.deepEqual(saved.agents.codex.config, { model: "gpt-4.1" });
	assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).theme, "one-dark");

	const loaded = loadConfig();
	assert.equal(loaded.theme, "one-dark");
	assert.deepEqual(loaded.settings.agents.codex.config, { model: "gpt-4.1" });

	const configThemeFile = path.join(tempSettingsDir, "config-theme.json");
	const nestedThemeSettingsFile = path.join(tempSettingsDir, "nested-theme-settings.json");
	fs.writeFileSync(
		configThemeFile,
		`${JSON.stringify({ ...config, theme: "matrix" }, null, 2)}\n`,
	);
	fs.writeFileSync(
		nestedThemeSettingsFile,
		`${JSON.stringify({ agents: { codex: { config: { theme: "tokyonight" } } } }, null, 2)}\n`,
	);
	process.env.CC_CONFIG = configThemeFile;
	process.env.CC_SETTINGS = nestedThemeSettingsFile;
	const configThemeLoaded = loadConfig();
	assert.equal(configThemeLoaded.theme, "matrix");
	assert.equal(configThemeLoaded.settings.theme, "matrix");
	assert.equal(configThemeLoaded.settings.agents.codex.config.theme, "tokyonight");

	const configSettingsThemeFile = path.join(tempSettingsDir, "config-settings-theme.json");
	fs.writeFileSync(
		configSettingsThemeFile,
		`${JSON.stringify({ ...config, theme: "matrix", settings: { theme: "tokyonight" } }, null, 2)}\n`,
	);
	process.env.CC_CONFIG = configSettingsThemeFile;
	process.env.CC_SETTINGS = nestedThemeSettingsFile;
	const configSettingsThemeLoaded = loadConfig();
	assert.equal(configSettingsThemeLoaded.theme, "tokyonight");
	assert.equal(configSettingsThemeLoaded.settings.theme, "tokyonight");
} finally {
	if (previousCcSettings === undefined) delete process.env.CC_SETTINGS;
	else process.env.CC_SETTINGS = previousCcSettings;
	if (previousCcConfig === undefined) delete process.env.CC_CONFIG;
	else process.env.CC_CONFIG = previousCcConfig;
	fs.rmSync(tempSettingsDir, { recursive: true, force: true });
}

assert.deepEqual(
	autoPermissionOutcome({
		options: [
			{ kind: "reject_once", name: "Reject", optionId: "reject" },
			{ kind: "allow_once", name: "Allow", optionId: "allow" },
		],
	}),
	{ outcome: "selected", optionId: "allow" },
);

assert.deepEqual(
	autoPermissionOutcome({
		options: [
			{ kind: "allow_always", name: 'Yes, and use "auto" mode', optionId: "auto" },
			{ kind: "allow_always", name: "Yes, and bypass permissions", optionId: "bypassPermissions" },
			{ kind: "reject_once", name: "No, keep planning", optionId: "plan" },
		],
	}),
	{ outcome: "selected", optionId: "bypassPermissions" },
);

assert.deepEqual(
	autoPermissionOutcome({
		options: [{ kind: "reject_once", name: "Reject", optionId: "reject" }],
	}),
	{ outcome: "cancelled" },
);

const fullClear = "\x1b[2J\x1b[H\x1b[3J";
assert.equal(rewriteFullScreenClear(`${fullClear}rendered`), "\x1b8\x1b[Jrendered");
assert.equal(rewriteFullScreenClear(`${fullClear}rendered`, { alternateScreen: true }), "\x1b[2J\x1b[Hrendered");
assert.equal(rewriteFullScreenClear(`before\x1b[3Jafter`), "beforeafter");
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "old", lines: ["a", "b", "c", "d", "tail"] },
		{ width: 20, text: "older", lines: ["A", "B", "C", "D", "tail", "new"] },
		2,
	),
	["a", "b", "c", "D", "tail", "new"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "old", lines: ["a", "b"] },
		{ width: 30, text: "older", lines: ["A", "B", "new"] },
		2,
	),
	["A", "B", "new"],
);
assert.deepEqual(
	stabilizeGrowingRenderedLines(
		{ width: 20, text: "# old", lines: ["# old"], renderer: "plain" },
		{ width: 20, text: "# older", lines: ["old", "new"], renderer: "markdown" },
		2,
	),
	["old", "new"],
);
assert.deepEqual(
	stabilizeMutableRenderedLines(
		{ width: 20, lines: ["old running", "old complete", "tail"] },
		{ width: 20, lines: ["new complete", "old complete", "tail", "new tail"] },
		1,
	),
	["old running", "old complete", "tail", "new tail"],
);
assert.equal(hideCursorDuringRender("\x1b[?2026hrendered"), "\x1b[?2026h\x1b[?25lrendered");
assert.equal(hideCursorDuringRender("\x1b[?2026h\x1b[?25lrendered"), "\x1b[?2026h\x1b[?25lrendered");
assert.equal(hideCursorDuringRender("plain cursor move"), "plain cursor move");
assert.equal(isVsCodeTerminal({ TERM_PROGRAM: "vscode" }), true);
assert.equal(isVsCodeTerminal({ VSCODE_PID: "123" }), true);
assert.equal(isVsCodeTerminal({ TERM_PROGRAM: "Apple_Terminal" }), false);
assert.equal(isVsCodeAutoActivationCommand("source /Users/ethanewer/wbl-agent-data/.venv/bin/activate"), true);
assert.equal(isVsCodeAutoActivationCommand('. "/Users/ethanewer/wbl agent data/.venv/bin/activate"'), true);
assert.equal(isVsCodeAutoActivationCommand("conda activate base"), true);
assert.equal(isVsCodeAutoActivationCommand("mamba activate 'project env'"), true);
assert.equal(isVsCodeAutoActivationCommand("micromamba activate"), true);
assert.equal(isVsCodeAutoActivationCommand("pyenv activate agent-env"), true);
assert.equal(isVsCodeAutoActivationCommand("source code analysis"), false);
assert.equal(isVsCodeAutoActivationCommand("source README.md"), false);
assert.equal(isVsCodeAutoActivationCommand("conda activate base is broken"), false);
assert.equal(isVsCodeAutoActivationCommand("source /tmp/.venv/bin/activate\nexplain this"), false);
assert.equal(shouldDropVsCodeAutoActivationInput("source /tmp/.venv/bin/activate", {}, { TERM_PROGRAM: "vscode" }), false);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "vscode" },
	),
	true,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 50, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "vscode" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 250 },
		{ TERM_PROGRAM: "vscode" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput(
		"source /tmp/.venv/bin/activate",
		{ burst: { text: "source /tmp/.venv/bin/activate", maxGapMs: 1, lastAt: 100 }, now: 110 },
		{ TERM_PROGRAM: "Apple_Terminal" },
	),
	false,
);
assert.equal(
	shouldDropVsCodeAutoActivationInput("source README.md", { burst: { text: "source README.md", maxGapMs: 1, lastAt: 100 }, now: 110 }, { TERM_PROGRAM: "vscode" }),
	false,
);

assert.deepEqual(
	flattenModes({
		modes: {
			availableModes: [
				{ id: "agent", name: "Agent" },
				{ modeId: "plan", label: "Plan", description: "Draft before editing" },
			],
		},
	}),
	[
		{ id: "agent", name: "Agent", description: undefined },
		{ id: "plan", name: "Plan", description: "Draft before editing" },
	],
);
assert.deepEqual(
	findMode({ modes: { availableModes: [{ id: "agent", name: "Agent" }, { id: "plan", name: "Plan" }] } }, "plan"),
	{ id: "plan", name: "Plan", description: undefined },
);
assert.deepEqual(
	findConfigValue(
		{
			options: [
				{ value: "agent", name: "Agent" },
				{ value: "plan", name: "Plan" },
			],
		},
		"plan",
	),
	{ value: "plan", name: "Plan", description: undefined },
);

async function captureSessionRequests(methodName) {
	const requests = [];
	const client = new AcpClient(
		{
			_sessionMeta: { claudeCode: { options: { settings: { model: "sonnet" } } } },
			_startupMode: "bypassPermissions",
		},
		() => {},
	);
	client.capabilities = methodName === "loadSession" ? { loadSession: true } : {};
	client.request = async (method, params) => {
		requests.push({ method, params });
		return method === "session/set_mode" ? {} : { configOptions: [] };
	};

	await client[methodName]("previous-session");
	return requests;
}

for (const methodName of ["loadSession", "resumeSession"]) {
	const requests = await captureSessionRequests(methodName);
	assert.equal(requests[0].method, methodName === "loadSession" ? "session/load" : "session/resume");
	assert.equal(requests[0].params.sessionId, "previous-session");
	assert.deepEqual(requests[0].params._meta, {
		claudeCode: {
			options: {
				settings: { model: "sonnet" },
			},
		},
	});
	assert.equal(requests[1].method, "session/set_mode");
	assert.equal(requests[1].params.sessionId, "previous-session");
	assert.equal(requests[1].params.modeId, "bypassPermissions");
}

const promptRequests = [];
const imagePromptClient = new AcpClient({ command: "fake" }, () => {});
imagePromptClient.sessionId = "image-session";
imagePromptClient.request = async (method, params) => {
	promptRequests.push({ method, params });
	return {};
};
await imagePromptClient.prompt([
	{ type: "text", text: "describe " },
	{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
]);
assert.deepEqual(promptRequests, [
	{
		method: "session/prompt",
		params: {
			sessionId: "image-session",
			prompt: [
				{ type: "text", text: "describe " },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			],
		},
	},
]);

const earlyEvents = [];
const earlyUpdateClient = new AcpClient({ command: "fake" }, (event) => earlyEvents.push(event));
earlyUpdateClient.sessionId = "current-session";
earlyUpdateClient.capabilities = { loadSession: true };
earlyUpdateClient.request = async (method) => {
	if (method === "session/load") {
		earlyUpdateClient.handleSessionUpdate({
			sessionId: "stale-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "stale history" },
			},
		});
		earlyUpdateClient.handleSessionUpdate({
			sessionId: "previous-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "early history" },
			},
		});
		return { configOptions: [] };
	}
	return {};
};
await earlyUpdateClient.loadSession("previous-session");
assert.deepEqual(
	earlyEvents.filter((event) => event.type === "text").map((event) => event.text),
	["early history"],
);

const newSessionOrder = [];
const earlyNewClient = new AcpClient({ command: "fake" }, (event) => {
	if (event.type === "text") newSessionOrder.push(event.text);
});
earlyNewClient.request = async (method) => {
	if (method === "session/new") {
		earlyNewClient.handleSessionUpdate({
			sessionId: "fresh-session",
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "fresh welcome" },
			},
		});
		return { sessionId: "fresh-session", configOptions: [] };
	}
	return {};
};
await earlyNewClient.newSession({
	beforeReplay: () => {
		newSessionOrder.push("before replay");
	},
});
assert.deepEqual(newSessionOrder, ["before replay", "fresh welcome"]);
