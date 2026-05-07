import assert from "node:assert/strict";
import { AcpClient, applyHarnessSettings } from "../src/pi-harness.mjs";

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
			dangerouslySkipPermissions: true,
			settings: { model: "sonnet" },
		},
		codex: {
			dangerouslySkipPermissions: true,
			config: { model: "gpt-5" },
		},
		cursor: {
			dangerouslySkipPermissions: true,
			args: ["--model", "gpt-5"],
		},
	},
});

assert.equal(applied.agents.claude._startupMode, "bypassPermissions");
assert.deepEqual(applied.agents.claude._sessionMeta, {
	claudeCode: {
		options: {
			settings: { model: "sonnet" },
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

assert.deepEqual(applied.agents.cursor.acp.args, ["--model", "gpt-5", "--force", "--sandbox", "disabled", "acp"]);
assert.deepEqual(config.agents.cursor.acp.args, ["acp"]);

const harnessesSettings = applyHarnessSettings(config, {
	agents: {},
	harnesses: {
		codex: {
			config: {
				model: "gpt-5-mini",
				"shell_environment_policy.set": { CI: "1", "DEBUG-FLAG": "false" },
			},
		},
	},
});

assert.deepEqual(harnessesSettings.agents.codex.acp.args, [
	"-c",
	"model=\"gpt-5-mini\"",
	"-c",
	"shell_environment_policy.set={ CI = \"1\", DEBUG-FLAG = \"false\" }",
]);

const flatSettings = applyHarnessSettings(config, {
	agents: {},
	cursor: {
		args: ["--model", "gpt-5-mini"],
	},
});

assert.deepEqual(flatSettings.agents.cursor.acp.args, ["--model", "gpt-5-mini", "acp"]);

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
