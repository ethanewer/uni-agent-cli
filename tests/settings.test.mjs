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
