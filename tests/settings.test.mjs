import assert from "node:assert/strict";
import {
	AcpClient,
	applyHarnessSettings,
	autoPermissionOutcome,
	isVsCodeAutoActivationCommand,
	isVsCodeTerminal,
	rewriteFullScreenClear,
	shouldDropVsCodeAutoActivationInput,
} from "../src/pi-harness.mjs";

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
