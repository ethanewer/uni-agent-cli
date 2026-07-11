import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	codexMcpCliArguments,
	formatCodexHooksReport,
	formatCodexMcpCommandDisplay,
	formatCodexPluginMarketplaceCommandDisplay,
	HarnessApp,
	isCodexMcpManagementArgument,
	localSlashCommands,
	redactCodexMcpError,
	redactCodexMcpJson,
	redactCodexPluginMarketplaceError,
} from "../src/pi-harness.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-management-"));
const codexPath = path.join(root, "codex.mjs");
fs.writeFileSync(codexPath, "process.exit(0);\n");
fs.chmodSync(codexPath, 0o755);

function appHarness() {
	const agent = { env: { CODEX_PATH: codexPath, PATH: "" } };
	const commands = [];
	const notices = [];
	const errors = [];
	const blocks = [];
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { codex: agent }, settings: {} },
		client: { exited: false, capabilities: {} },
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		permissionPromptActive: false,
		statusState: "",
		sessionStates: new Map(),
		availableCommands: new Map([["codex", [{ name: "mcp" }, { name: "hooks" }]]]),
		commandsLoaded: new Set(["codex"]),
		ui: { requestRender() {} },
		addCommandMessage(value) { commands.push(value); },
		addNotice(value) { notices.push(value); },
		addError(value) { errors.push(value); },
		showMarkdownBlock(value) { blocks.push(value); },
		updateSpinner() {},
		beginAsyncPickerLoad() {
			this.asyncPickerLoadCount += 1;
			return Symbol("operation");
		},
		endAsyncPickerLoad() { this.asyncPickerLoadCount -= 1; },
		closeMenu() {},
	});
	return { app, agent, commands, notices, errors, blocks };
}

try {
	// Only explicit management actions are intercepted. Live-session inspection
	// remains an ACP command even before/without a backend command catalog match.
	{
		const { app } = appHarness();
		assert.equal(app.slashCommandRoute("mcp", ""), "backend");
		assert.equal(app.slashCommandRoute("mcp", "verbose"), "backend");
		assert.equal(app.slashCommandRoute("mcp", "future-subcommand"), "backend");
		for (const action of ["list", "get server", "add server -- node", "remove server", "login server", "logout server"]) {
			assert.equal(app.slashCommandRoute("mcp", action), "local", action);
			assert.equal(isCodexMcpManagementArgument(action), true);
		}
		assert.equal(app.slashCommandRoute("hooks", ""), "local");
	}

	// The local catalog enriches /mcp autocomplete without changing the routing
	// contract above.
	{
		const { app } = appHarness();
		const catalog = localSlashCommands(app);
		assert.ok(catalog.some((entry) => entry.name === "hooks"));
		const mcp = catalog.find((entry) => entry.name === "mcp");
		assert.ok(mcp);
		assert.deepEqual(
			mcp.getArgumentCompletions("").map((entry) => entry.value),
			["list", "get", "add", "remove", "login", "logout", "verbose"],
		);
	}

	// CLI argv remains an array of literal tokens. Display text deliberately hides
	// all add-command detail after the server name.
	{
		const args = ["add", "demo", "--env", "TOKEN=top secret", "--", "node", "script with space"];
		assert.deepEqual(codexMcpCliArguments(args), ["mcp", ...args]);
		assert.deepEqual(codexMcpCliArguments(["get", "demo"]), ["mcp", "get", "demo", "--json"]);
		assert.deepEqual(codexMcpCliArguments(["list", "--json"]), ["mcp", "list", "--json"]);
		const display = formatCodexMcpCommandDisplay(args);
		assert.equal(display, "/mcp add demo …");
		assert.doesNotMatch(display, /top secret|TOKEN=/);
	}

	// Even a backend mismatch or process-tree fence reports only the sanitized
	// command label; the common requireActiveCodex error path must not echo input.
	await (async () => {
		for (const fenced of [false, true]) {
			const harness = appHarness();
			if (fenced) harness.app.replacementProcessFence = new Error("old process still running");
			else {
				harness.app.activeKey = "claude";
				harness.app.config.agents.claude = {};
			}
			await harness.app.runCodexMcpManagement("add demo --env TOKEN=never-print -- node server.mjs");
			const rendered = [...harness.commands, ...harness.notices, ...harness.errors].join("\n");
			assert.doesNotMatch(rendered, /never-print|TOKEN=/);
			assert.match(rendered, /\/mcp add demo/);
		}
	})();

	// Every environment/header value and directly named secret is redacted. Names
	// of environment variables remain useful configuration metadata.
	{
		const rendered = JSON.stringify(redactCodexMcpJson({
			env: { TOKEN: "env-secret" },
			headers: [{ name: "Authorization", value: "header-secret" }],
			api_key: "api-secret",
			oauth_state: "state-secret",
			bearer_token_env_var: "MCP_TOKEN",
			url: "https://example.test/mcp?token=url-secret&safe=yes#fragment-secret",
			args: ["--token", "argv-secret", "token=assignment-secret", "--safe", "visible"],
			transport: {
				args: [
					"docker",
					"run",
					"-e",
					"OPENAI_API_KEY=docker-secret",
					"API_TOKEN=positional-secret",
					"SAFE_NAME=also-private",
					"image",
				],
			},
		}));
		for (const secret of [
			"env-secret",
			"header-secret",
			"api-secret",
			"state-secret",
			"url-secret",
			"fragment-secret",
			"argv-secret",
			"assignment-secret",
			"docker-secret",
			"positional-secret",
			"also-private",
		]) {
			assert.doesNotMatch(rendered, new RegExp(secret));
		}
		assert.match(rendered, /Authorization/);
		assert.match(rendered, /MCP_TOKEN/);
		assert.match(rendered, /visible/);
		assert.match(rendered, /\[redacted\]/);

		const error = redactCodexMcpError(
			new Error("failed for --env TOKEN=top-secret and token=top-secret at https://auth.test/callback?state=oauth-secret"),
			["add", "demo", "--env", "TOKEN=top-secret"],
		);
		assert.doesNotMatch(error, /top-secret|TOKEN=top|oauth-secret/);

		const configError = redactCodexMcpError(
			new Error("Codex rejected -c =SUPERSECRET123: Empty key in override: =SUPERSECRET123"),
			["add", "demo", "-c", "=SUPERSECRET123", "--url", "https://example.test/mcp"],
		);
		assert.doesNotMatch(configError, /SUPERSECRET123/);
		assert.match(configError, /\[redacted\]/);
	}

	// Marketplace sources and config overrides can contain credentials. They are
	// preserved as literal CLI argv, but never copied into the transcript or an
	// error that Codex echoes back to the user.
	await (async () => {
		const args = [
			"add",
			"https://git-user:private-pat@example.test/org/repo",
			"--config",
			"api_key=market-secret",
			"--ref",
			"main",
		];
		const display = formatCodexPluginMarketplaceCommandDisplay(args);
		assert.doesNotMatch(display, /git-user|private-pat|market-secret/);
		assert.match(display, /example\.test\/org\/repo/);
		assert.match(display, /\[redacted\]|redacted/);

		const safeError = redactCodexPluginMarketplaceError(
			new Error("clone failed for https://git-user:private-pat@example.test/org/repo with api_key=market-secret"),
			args,
		);
		assert.doesNotMatch(safeError, /git-user|private-pat|market-secret/);

		const harness = appHarness();
		let invocationArgs;
		harness.app.runTrackedCodexCommand = async (_invocation, cliArgs) => {
			invocationArgs = cliArgs;
			throw new Error("clone failed for https://git-user:private-pat@example.test/org/repo with api_key=market-secret");
		};
		await harness.app.runPluginMarketplaceCommand(
			{ command: codexPath, args: [] },
			args,
			"plugins",
			harness.app.captureActiveAgentContext(),
		);
		assert.deepEqual(invocationArgs, ["plugin", "marketplace", ...args, "--json"]);
		const rendered = [...harness.commands, ...harness.errors, ...harness.notices].join("\n");
		assert.doesNotMatch(rendered, /git-user|private-pat|market-secret/);
		assert.match(rendered, /example\.test\/org\/repo/);

		const listHarness = appHarness();
		listHarness.app.runTrackedCodexCommand = async (_invocation, cliArgs) => {
			assert.deepEqual(cliArgs, ["plugin", "marketplace", "list", "--json"]);
			return {
				stdout: Buffer.from(JSON.stringify({
					marketplaces: [{
						name: "private",
						marketplaceSource: {
							source: "https://list-user:list-pat@example.test/org/catalog?token=list-token#list-fragment",
						},
					}],
				})),
				stderr: Buffer.alloc(0),
				code: 0,
			};
		};
		await listHarness.app.runPluginMarketplaceCommand(
			{ command: codexPath, args: [] },
			["list"],
			"plugins",
			listHarness.app.captureActiveAgentContext(),
		);
		assert.equal(listHarness.blocks.length, 1);
		assert.doesNotMatch(listHarness.blocks[0], /list-user|list-pat|list-token|list-fragment/);
		assert.match(listHarness.blocks[0], /example\.test\/org\/catalog/);
	})();

	// Hook reports expose the stable fields and diagnostics, and remain bounded
	// even if a malformed configuration produces an extreme catalog.
	{
		const report = formatCodexHooksReport({ data: [{
			cwd: process.cwd(),
			hooks: [{
				eventName: "preToolUse",
				handlerType: "command",
				source: "user",
				sourcePath: "/tmp/hooks.json",
				enabled: true,
				trustStatus: "trusted",
			}],
			errors: [{ path: "/tmp/bad.json", message: "invalid hook" }],
			warnings: ["slow hook"],
		}] }, process.cwd());
		for (const value of ["preToolUse", "command", "user", "enabled", "trusted", "invalid hook", "slow hook"]) {
			assert.match(report, new RegExp(value));
		}
		const oversized = formatCodexHooksReport({ data: [{
			cwd: process.cwd(),
			hooks: Array.from({ length: 1_000 }, (_, index) => ({
				eventName: `event-${index}`,
				handlerType: "command",
				source: "user",
				enabled: true,
				trustStatus: "trusted",
			})),
		}] }, process.cwd());
		assert.ok(oversized.split("\n").length <= 500);
		assert.match(oversized, /truncated/);
		assert.throws(() => formatCodexHooksReport({}), /invalid response/);
	}

	// /hooks sends exactly one stable hooks/list request for the absolute cwd and
	// never publishes a response after the active agent context changes.
	await (async () => {
		const harness = appHarness();
		let request;
		harness.app.runFencedCodexAppServerRequests = async (_invocation, requests) => {
			request = requests;
			return [{ data: [{ cwd: process.cwd(), hooks: [], errors: [], warnings: [] }] }];
		};
		await harness.app.openCodexHooksReport();
		assert.deepEqual(request, [{ method: "hooks/list", params: { cwds: [path.resolve(process.cwd())] } }]);
		assert.equal(harness.blocks.length, 1);
		assert.ok(harness.notices.some((entry) => entry.includes("native Codex CLI")));

		const stale = appHarness();
		stale.app.runFencedCodexAppServerRequests = async () => {
			stale.app.activeAgentGeneration += 1;
			return [{ data: [{ cwd: process.cwd(), hooks: [], errors: [], warnings: [] }] }];
		};
		await stale.app.openCodexHooksReport();
		assert.deepEqual(stale.blocks, []);
		assert.ok(!stale.notices.some((entry) => entry.includes("native Codex CLI")));

		const sideBusy = appHarness();
		sideBusy.app.btwThread = { busy: true };
		sideBusy.app.runFencedCodexAppServerRequests = async () => { throw new Error("must not run"); };
		await sideBusy.app.openCodexHooksReport();
		assert.ok(sideBusy.notices.some((entry) => entry.includes("while a turn is running")));
		assert.deepEqual(sideBusy.errors, []);
	})();

	// MCP execution preserves parsed argv, bounds process output, redacts rendered
	// JSON, and reminds the user to refresh the live session after mutations.
	await (async () => {
		const add = appHarness();
		let call;
		add.app.runTrackedCodexCommand = async (_invocation, args, _agent, options) => {
			call = { args, options };
			return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
		};
		await add.app.runCodexMcpManagement('add demo --env "TOKEN=top secret" -- node "script with space"');
		assert.deepEqual(call.args, ["mcp", "add", "demo", "--env", "TOKEN=top secret", "--", "node", "script with space"]);
		assert.ok(call.options.maxStdoutBytes > 0 && call.options.maxStderrBytes > 0);
		assert.equal(add.commands[0], "/mcp add demo …");
		assert.ok(![...add.commands, ...add.notices, ...add.errors].join("\n").includes("top secret"));
		assert.ok(add.notices.some((entry) => entry.includes("Run /new")));

		const login = appHarness();
		let loginTimeout;
		login.app.runTrackedCodexCommand = async (_invocation, args, _agent, options) => {
			assert.deepEqual(args, ["mcp", "login", "demo", "--scopes", "tools.read,tools.write"]);
			loginTimeout = options.timeoutMs;
			return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
		};
		await login.app.runCodexMcpManagement("login demo --scopes tools.read,tools.write");
		assert.ok(loginTimeout >= 5 * 60_000);
		assert.ok(login.notices.some((entry) => entry.includes("open a browser")));
		assert.ok(login.notices.some((entry) => entry.includes("Run /new")));

		const list = appHarness();
		list.app.runTrackedCodexCommand = async (_invocation, args) => {
			assert.deepEqual(args, ["mcp", "list", "--json"]);
			return {
				stdout: Buffer.from(JSON.stringify({ demo: { env: { TOKEN: "hidden" }, headers: { Authorization: "also-hidden" } } })),
				stderr: Buffer.alloc(0),
				code: 0,
			};
		};
		await list.app.runCodexMcpManagement("list");
		assert.equal(list.blocks.length, 1);
		assert.doesNotMatch(list.blocks[0], /hidden|also-hidden/);
		assert.match(list.blocks[0], /\[redacted\]/);

		const stale = appHarness();
		stale.app.runTrackedCodexCommand = async () => {
			stale.app.activeAgentGeneration += 1;
			return { stdout: Buffer.from("{}"), stderr: Buffer.alloc(0), code: 0 };
		};
		await stale.app.runCodexMcpManagement("list");
		assert.deepEqual(stale.blocks, []);

		for (const action of ["add", "login"]) {
			const sideBusy = appHarness();
			sideBusy.app.btwThread = { busy: true };
			let calls = 0;
			sideBusy.app.runTrackedCodexCommand = async () => { calls += 1; };
			await sideBusy.app.runCodexMcpManagement(`${action} demo -- node server.mjs`);
			assert.equal(calls, 0);
			assert.ok(sideBusy.notices.some((entry) => entry.includes("while a turn is running")));
		}
	})();

	// Destructive remove/logout operations do nothing until the explicit picker
	// confirmation arrives, and a stale confirmation is ignored.
	await (async () => {
		for (const action of ["remove", "logout"]) {
			const harness = appHarness();
			let selection;
			let calls = 0;
			harness.app.openSelection = (title, entries, onSelect) => { selection = { title, entries, onSelect }; };
			harness.app.runTrackedCodexCommand = async (_invocation, args) => {
				calls += 1;
				assert.deepEqual(args, ["mcp", action, "demo"]);
				return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
			};
			await harness.app.runCodexMcpManagement(`${action} demo`);
			assert.equal(calls, 0);
			assert.match(selection.title, /demo/);
			await selection.onSelect({ value: action });
			assert.equal(calls, 1);

			const sideBusy = appHarness();
			let sideBusySelect;
			let sideBusyCalls = 0;
			sideBusy.app.openSelection = (_title, _entries, onSelect) => { sideBusySelect = onSelect; };
			sideBusy.app.runTrackedCodexCommand = async () => { sideBusyCalls += 1; };
			await sideBusy.app.runCodexMcpManagement(`${action} demo`);
			sideBusy.app.btwThread = { busy: true };
			await sideBusySelect({ value: action });
			assert.equal(sideBusyCalls, 0);

			const stale = appHarness();
			let staleSelect;
			stale.app.openSelection = (_title, _entries, onSelect) => { staleSelect = onSelect; };
			stale.app.runTrackedCodexCommand = async () => { throw new Error("must not run"); };
			await stale.app.runCodexMcpManagement(`${action} demo`);
			stale.app.activeAgentGeneration += 1;
			await staleSelect({ value: action });
			assert.deepEqual(stale.errors, []);
		}
	})();

	console.log("codex management tests passed");
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
