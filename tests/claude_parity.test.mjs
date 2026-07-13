import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	formatShellFollowup,
	formatShellTranscript,
	normalizeShellResult,
	parseShellInput,
	sanitizeShellOutput,
	shellInvocation,
} from "../src/harness/shell-input.mjs";
import {
	agentMentionsFromConfigOptions,
	assistantResponseTexts,
	buildEmbeddedFilePromptParts,
	HarnessApp,
	LazyCombinedAutocompleteProvider,
} from "../src/pi-harness.mjs";

assert.equal(parseShellInput("hello"), undefined);
assert.equal(parseShellInput("! pwd "), "pwd");
assert.equal(parseShellInput("!"), "");
assert.throws(() => shellInvocation("bad\0command"), /NUL/u);
assert.deepEqual(shellInvocation("pwd", { platform: "darwin", environment: { SHELL: "/bin/zsh" } }), {
	command: "/bin/zsh",
	args: ["-lc", "pwd"],
});
assert.deepEqual(shellInvocation("pwd", { platform: "darwin", environment: { SHELL: "/bin/tcsh" } }), {
	command: "/bin/tcsh",
	args: ["-c", "pwd"],
}, "csh-family shells reject combined -lc");
assert.deepEqual(shellInvocation("dir", { platform: "win32", environment: { ComSpec: "C:\\Windows\\cmd.exe" } }), {
	command: "C:\\Windows\\cmd.exe",
	args: ["/d", "/s", "/c", "dir"],
});

assert.equal(sanitizeShellOutput("ok\u001b]52;c;secret\u0007\u001b[2J\nnext\r\n"), "ok\nnext\n");
const result = normalizeShellResult("printf test", {
	code: 0,
	stdout: Buffer.from("test\n```\n"),
	stderr: Buffer.from("warn\n"),
	stdoutTruncated: true,
});
const transcript = formatShellTranscript(result);
assert.match(transcript, /^!printf test/mu);
assert.match(transcript, /exit 0 · stdout truncated/u);
assert.match(transcript, /````text\ntest\n```\n````/u, "fence grows past command output backticks");
assert.match(formatShellFollowup(result), /directly ran a local shell command/u);
assert.doesNotMatch(formatShellFollowup(result), /\u001b/u);

// Leading-! input executes in the host, presents the exact command/result in
// the transcript, and sends only the normalized follow-up through the active
// harness. Disabling the response appends context without starting a model turn.
{
	const app = Object.create(HarnessApp.prototype);
	let submitted;
	const agent = { acp: { command: "fake", args: [] } };
	Object.assign(app, {
		activeKey: "claude",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { claude: agent }, settings: {} },
		client: { launchSpec: agent, sessionId: "shell-session", exited: false },
		statusState: "",
		ui: { requestRender() {} },
		updateSpinner() {},
		trackedNativeProcessOptions: (options) => options,
		submitBackendPrompt: async (prompt, options) => {
			submitted = { prompt, options };
		},
		addError: (message) => assert.fail(message),
	});
	await app.runShellInput("echo cc-shell-parity");
	assert.match(submitted.prompt, /cc-shell-parity/u);
	assert.match(submitted.options.displayText, /^!echo cc-shell-parity/mu);
	assert.match(submitted.options.displayText, /exit 0/u);
	assert.equal(app.shellInputsRunning, 0);

	let localDisplay;
	let appendedContext;
	app.config.settings.respondToBashCommands = false;
	app.submitBackendPrompt = async () => assert.fail("disabled shell responses must not start a model turn");
	app.client = {
		launchSpec: agent,
		sessionId: "shell-session",
		exited: false,
		capabilities: { appendContext: true },
		appendContext: async (text) => { appendedContext = text; },
	};
	app.addUserMessage = (text) => {
		localDisplay = text;
	};
	await app.runShellInput("echo local-only");
	assert.match(localDisplay, /local-only/u);
	assert.match(appendedContext, /local-only/u);
	assert.doesNotMatch(appendedContext, /Respond to the command result/u);

	let staleSubmitted = false;
	const staleNotices = [];
	app.config.settings.respondToBashCommands = true;
	app.submitBackendPrompt = async () => { staleSubmitted = true; };
	app.addNotice = (message) => staleNotices.push(message);
	const staleClient = app.client;
	const delayed = app.runShellInput(`${JSON.stringify(process.execPath)} -e 'setTimeout(() => console.log("late"), 80)'`);
	await new Promise((resolve) => setTimeout(resolve, 20));
	app.client = { launchSpec: agent, sessionId: "replacement-session", exited: false };
	app.activeAgentGeneration += 1;
	staleClient.exited = true;
	await delayed;
	assert.equal(staleSubmitted, false, "a delayed shell result must not cross into a replacement session");
	assert.ok(staleNotices.some((message) => message.includes("output was not sent to the replacement session")));

	// An append failure can arrive after the displayed command result's session
	// has closed. Keep that error out of the replacement transcript as well.
	let appendStarted;
	let rejectAppend;
	const appendEntered = new Promise((resolve) => { appendStarted = resolve; });
	const appendRelease = new Promise((_resolve, reject) => { rejectAppend = reject; });
	app.config.settings.respondToBashCommands = false;
	const appendClient = {
		launchSpec: agent,
		sessionId: "append-origin",
		exited: false,
		capabilities: { appendContext: true },
		async appendContext() {
			appendStarted();
			await appendRelease;
		},
	};
	app.client = appendClient;
	const staleAppend = app.runShellInput("printf append-stale");
	await appendEntered;
	app.client = { launchSpec: agent, sessionId: "append-replacement", exited: false };
	app.activeAgentGeneration += 1;
	appendClient.exited = true;
	rejectAppend(new Error("late append failure"));
	await staleAppend;
	assert.ok(staleNotices.some((message) => message.includes("context injection finished after its original session changed")));

	// The command runner itself may reject after a transition (timeout, shutdown,
	// or spawn failure). Simulate that boundary deterministically and verify the
	// generic error is not written into the new main session.
	const failedClient = {
		launchSpec: agent,
		sessionId: "failure-origin",
		exited: false,
	};
	app.client = failedClient;
	app.config.settings.respondToBashCommands = true;
	app.trackedNativeProcessOptions = (options) => {
		app.client = { launchSpec: agent, sessionId: "failure-replacement", exited: false };
		app.activeAgentGeneration += 1;
		failedClient.exited = true;
		return {
			...options,
			processTracker: { assertOpen() { throw new Error("late runner failure"); } },
		};
	};
	await app.runShellInput("printf failure-stale");
	assert.ok(staleNotices.some((message) => message.includes("failed after its original session changed")));

	// A redirected background job closes every pipe inherited by the shell, so the
	// wrapper's `close` event must not be mistaken for whole-process-group exit.
	// Sweep the still-owned detached group before resolving the shell input and
	// unregister it only after the descendant is confirmed gone.
	if (process.platform !== "win32") {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shell-descendant-"));
		const pidFile = path.join(root, "background.pid");
		let backgroundPid;
		try {
			app.trackedNativeProcessOptions = HarnessApp.prototype.trackedNativeProcessOptions;
			app.nativeProcessTracker = undefined;
			app.config.settings.respondToBashCommands = false;
			app.client = {
				launchSpec: agent,
				sessionId: "background-origin",
				exited: false,
				capabilities: {},
			};
			const quotedPidFile = `'${pidFile.replaceAll("'", `'\"'\"'`)}'`;
			await app.runShellInput(`sleep 100 >/dev/null 2>&1 & printf '%s' "$!" > ${quotedPidFile}`);
			backgroundPid = Number(fs.readFileSync(pidFile, "utf8"));
			assert.ok(Number.isInteger(backgroundPid) && backgroundPid > 0, "background shell descendant started");
			assert.throws(
				() => process.kill(backgroundPid, 0),
				(error) => error?.code === "ESRCH",
				"background shell descendant is gone before shell input resolves",
			);
			assert.equal(app.nativeProcessTracker.entries.size, 0, "completed shell process group is unregistered");
		} finally {
			if (backgroundPid) {
				try { process.kill(backgroundPid, "SIGKILL"); } catch {}
			}
			fs.rmSync(root, { recursive: true, force: true });
		}
	}
}

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shell-completion-"));
	try {
		fs.writeFileSync(path.join(root, "README.md"), "test\n");
		fs.mkdirSync(path.join(root, "reports"));
		const provider = new LazyCombinedAutocompleteProvider([], root, null);
		const line = "!cat RE";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			force: false,
			signal: new AbortController().signal,
		});
		assert.ok(suggestions.items.some((item) => item.value === "README.md"));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// Custom agents are discovered from the unified ACP config-option surface and
// share @ completion with files; no Claude SDK state leaks into the TUI.
{
	const mentions = agentMentionsFromConfigOptions([{
		id: "agent",
		type: "select",
		options: [
			{ value: "default", name: "Default" },
			{ value: "reviewer", description: "Project\nreviewer" },
			{ value: "unsafe/name" },
			{ value: "REVIEWER", description: "duplicate" },
		],
	}]);
	assert.deepEqual(mentions, [{ value: "reviewer", description: "Project reviewer" }]);
	assert.deepEqual(agentMentionsFromConfigOptions([{
		id: "agent",
		type: "select",
		options: [{
			group: "project",
			name: "Project agents",
			options: [{ value: "architect", name: "Architect", description: "Designs changes" }],
		}],
	}]), [{ value: "architect", description: "Project agents · Designs changes" }]);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-agent-completion-"));
	try {
		fs.writeFileSync(path.join(root, "reviewer"), "file named like an agent\n");
		const provider = new LazyCombinedAutocompleteProvider([], root, null, undefined, mentions);
		const suggestions = await provider.getSuggestions(["ask @rev"], 0, 8, {
			force: false,
			signal: new AbortController().signal,
		});
		assert.ok(suggestions.items.some((item) => item.value === "@reviewer" && item.ccAgentMention));
		assert.ok(suggestions.items.some((item) => item.value === '@"reviewer"'), "a colliding file remains explicitly selectable");
		const mention = suggestions.items.find((item) => item.ccAgentMention);
		const applied = provider.applyCompletion(["ask @rev"], 0, 8, mention, suggestions.prefix);
		assert.deepEqual(applied, { lines: ["ask @reviewer "], cursorLine: 0, cursorCol: 14 });
		const literalAgent = buildEmbeddedFilePromptParts("ask @reviewer", root, {
			reservedMentions: new Set(["reviewer"]),
		});
		assert.deepEqual(literalAgent, { parts: [{ type: "text", text: "ask @reviewer" }], embeddedCount: 0 });
		const explicitFile = buildEmbeddedFilePromptParts('ask @"reviewer"', root, {
			reservedMentions: new Set(["reviewer"]),
		});
		assert.equal(explicitFile.embeddedCount, 1);
		assert.equal(explicitFile.parts.find((part) => part.type === "resource").resource.text, "file named like an agent\n");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

{
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		chat: {
			children: [],
			addChild(child) { this.children.push(child); },
		},
		currentAssistantText: undefined,
		currentToolSummary: undefined,
		currentUserText: undefined,
		lastAssistantText: "",
		addHistorySpacer() {},
	});
	app.appendAssistantText("first before tool");
	app.closeCurrentAssistantText();
	app.appendAssistantText("first after tool");
	app.closeCurrentAssistantText();
	app.addUserMessage("next prompt");
	app.appendAssistantText("second response");
	app.closeCurrentAssistantText();
	app.showMarkdownBlock("host-only diff");
	assert.deepEqual(assistantResponseTexts(app.chat), [
		"first before tool\nfirst after tool",
		"second response",
	]);
}

console.log("claude parity tests passed");
