import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	ShellCommandHistory,
	normalizeHistoryCommand,
	parseShellHistory,
	shellHistoryFiles,
} from "../src/harness/shell-history.mjs";
import { HarnessApp, LazyCombinedAutocompleteProvider } from "../src/pi-harness.mjs";

assert.deepEqual(
	parseShellHistory(": 1710000000:0;git status\n: 1710000001:2;npm test\n", "/tmp/.zsh_history"),
	["git status", "npm test"],
);
assert.deepEqual(
	parseShellHistory("- cmd: git status\n  when: 1\n- cmd: printf foo\\nbar\n", "/tmp/fish_history"),
	["git status", "printf foo bar"],
);
assert.equal(normalizeHistoryCommand("  printf\t'ok'\u001b[2J  "), "printf 'ok'");
assert.equal(normalizeHistoryCommand("bad\0command"), undefined);
assert.deepEqual(shellHistoryFiles({ HISTFILE: "~/custom", SHELL: "/bin/zsh" }, "/home/test"), [
	path.resolve("/home/test/custom"),
	path.resolve("/home/test/.zsh_history"),
]);

const history = new ShellCommandHistory({
	files: ["first", "second"],
	readTail(file) {
		return file === "first" ? "git status\nnpm test\n" : "git status\ngit stash list\n";
	},
});
assert.deepEqual(history.suggestions("git"), ["git stash list", "git status"]);
history.remember("git status --short");
assert.deepEqual(history.suggestions("git"), ["git status --short", "git stash list", "git status"]);
history.remember("git status");
assert.deepEqual(history.suggestions("git").slice(0, 2), ["git status", "git status --short"]);

{
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-shell-history-completion-"));
	try {
		const completionHistory = new ShellCommandHistory({ files: [] });
		completionHistory.remember("git status --short");
		completionHistory.remember("git stash list");
		const provider = new LazyCombinedAutocompleteProvider([], root, null, completionHistory);
		const line = "!git st";
		const suggestions = await provider.getSuggestions([line], 0, line.length, {
			force: false,
			signal: new AbortController().signal,
		});
		assert.deepEqual(
			suggestions.items.map((item) => item.value),
			["!git stash list", "!git status --short"],
			"recent prefix matches are offered after path completion has no match",
		);
		const applied = provider.applyCompletion(
			["!git st --discard-this-suffix"],
			0,
			line.length,
			suggestions.items[0],
			suggestions.prefix,
		);
		assert.deepEqual(applied, {
			lines: ["!git stash list"],
			cursorLine: 0,
			cursorCol: "!git stash list".length,
		}, "history completion replaces the entire leading shell command");

		fs.writeFileSync(path.join(root, "status.txt"), "test\n");
		completionHistory.remember("cat stash");
		const pathLine = "!cat sta";
		const pathSuggestions = await provider.getSuggestions([pathLine], 0, pathLine.length, {
			force: false,
			signal: new AbortController().signal,
		});
		assert.ok(pathSuggestions.items.some((item) => item.value === "status.txt"));
		assert.ok(pathSuggestions.items.every((item) => item.ccShellHistory !== true), "path matches take precedence");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

{
	const appHistory = new ShellCommandHistory({ files: [] });
	const config = {
		defaultAgent: "codex",
		agents: { codex: { label: "Codex", transport: "acp", acp: { command: "codex-acp", args: [] } } },
	};
	const app = new HarnessApp(config, "codex", "acp", { shellCommandHistory: appHistory });
	try {
		assert.equal(app.shellCommandHistory, appHistory);
		assert.equal(app.editor.autocompleteProvider.shellCommandHistory, appHistory);
		let finishShell;
		app.runShellInput = () => new Promise((resolve) => { finishShell = resolve; });
		const submission = app.handleSubmit("!printf integration");
		assert.deepEqual(
			appHistory.suggestions("printf"),
			["printf integration"],
			"a submitted shell command is remembered before its process finishes",
		);
		finishShell();
		await submission;

		const blockedMessages = [];
		const sentinel = path.join(os.tmpdir(), `cc-shell-transition-${process.pid}-${Date.now()}`);
		app.runShellInput = HarnessApp.prototype.runShellInput.bind(app);
		app.addCommandMessage = (message) => blockedMessages.push(["command", message]);
		app.addNotice = (message) => blockedMessages.push(["notice", message]);
		app.sessionSwitchInProgress = true;
		await app.handleSubmit(`!touch ${JSON.stringify(sentinel)}`);
		assert.equal(fs.existsSync(sentinel), false, "leading-! input must not launch during a session transition");
		assert.deepEqual(blockedMessages, [
			["command", `!touch ${JSON.stringify(sentinel)}`],
			["notice", "Shell commands are unavailable while a session transition is in progress"],
		]);
		app.sessionSwitchInProgress = false;
		app.workingDirectoryCommandTransition = {};
		const cwdSentinel = `${sentinel}-cwd`;
		await app.handleSubmit(`!touch ${JSON.stringify(cwdSentinel)}`);
		assert.equal(fs.existsSync(cwdSentinel), false, "leading-! input must not launch during an in-flight /cd");
		assert.deepEqual(blockedMessages.slice(-2), [
			["command", `!touch ${JSON.stringify(cwdSentinel)}`],
			["notice", "Shell commands are unavailable while the working directory is changing"],
		]);
		app.workingDirectoryCommandTransition = undefined;
		app.workingTreeMutationOperation = { label: "Codex Cloud is applying changes" };
		const mutationSentinel = `${sentinel}-mutation`;
		await app.handleSubmit(`!touch ${JSON.stringify(mutationSentinel)}`);
		assert.equal(fs.existsSync(mutationSentinel), false, "leading-! input must not launch during a working-tree mutation");
		assert.deepEqual(blockedMessages.slice(-2), [
			["command", `!touch ${JSON.stringify(mutationSentinel)}`],
			["notice", "Shell commands are unavailable while Codex Cloud is applying changes"],
		]);
		app.switchAgent = async () => assert.fail("a harness switch must not overlap a working-tree mutation");
		await app.handleHarnessCommand("/harness codex");
		assert.deepEqual(blockedMessages.slice(-2), [
			["command", "/harness codex"],
			["notice", "Harness switching is unavailable while Codex Cloud is applying changes"],
		]);
		app.workingTreeMutationOperation = undefined;

		let cwdRequests = 0;
		app.config.settings = { respondToBashCommands: false };
		app.client = {
			exited: false,
			sessionId: "shell-cwd-session",
			capabilities: { appendContext: true, changeWorkingDirectory: true },
			async appendContext() {},
			async changeWorkingDirectory() {
				cwdRequests += 1;
				return { status: "ok", cwd: process.cwd(), changed: false };
			},
		};
		app.ready = true;
		const delayedShell = app.runShellInput(
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('done'), 80)")}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(app.activeShellInputCount, 1);
		await app.runChangeWorkingDirectory(process.cwd());
		assert.equal(cwdRequests, 0, "/cd must not race a shell command that captured the old cwd");
		await delayedShell;
		assert.equal(app.activeShellInputCount, 0);

		// Leading-! input is available before lazy ACP startup. Installing the first
		// client for the same agent generation must not make that command look stale
		// or discard its output.
		app.client = undefined;
		app.ready = false;
		app.clientInstallSequence = 0;
		let appendedColdOutput;
		const coldShell = app.runShellInput(
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('cold done'), 80)")}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		app.client = {
			exited: false,
			sessionId: "first-lazy-client",
			capabilities: { appendContext: true },
			async appendContext(text) { appendedColdOutput = text; },
		};
		app.clientInstallSequence += 1;
		app.initialSessionIdByClient.set(app.client, app.client.sessionId);
		app.ready = true;
		await coldShell;
		assert.match(appendedColdOutput, /cold done/u, "cold shell output reaches the first lazily-installed client");
		assert.ok(
			!blockedMessages.some(([, message]) => message.includes("its original session changed")),
			"normal first-client startup is not reported as a session replacement",
		);

		// The startup exception is limited to that first session. A same-client
		// resume/new/branch must not receive output launched before startup.
		app.client = undefined;
		app.ready = false;
		app.clientInstallSequence = 0;
		appendedColdOutput = undefined;
		const staleColdShell = app.runShellInput(
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('stale cold'), 80)")}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		app.client = {
			exited: false,
			sessionId: "initial-session",
			capabilities: { appendContext: true },
			async appendContext(text) { appendedColdOutput = text; },
		};
		app.clientInstallSequence += 1;
		app.initialSessionIdByClient.set(app.client, app.client.sessionId);
		app.ready = true;
		app.client.sessionId = "replacement-session";
		await staleColdShell;
		assert.equal(appendedColdOutput, undefined, "cold shell output cannot cross a same-client session switch");
		assert.ok(
			blockedMessages.some(([, message]) => message.includes("its original session changed")),
			"discarded cross-session output is explained",
		);

		// A resume picker can open while a concrete-session shell is running. Keep
		// its model follow-up target-bound in the queue, then discard it if the picker
		// commits a different session before the queue drains.
		app.config.settings.respondToBashCommands = true;
		let backendPrompts = 0;
		app.client = {
			exited: false,
			sessionId: "queued-shell-source",
			capabilities: {},
			async prompt() { backendPrompts += 1; return {}; },
		};
		app.ready = true;
		app.foregroundOperation = { commandName: "resume", status: "loading sessions", cancelled: false };
		await app.runShellInput(`${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('queue me')")}`);
		assert.equal(app.promptQueue.length, 1);
		assert.ok(app.promptQueue[0].sessionCommandTarget, "queued shell follow-up retains its source identity");
		app.client.sessionId = "queued-shell-replacement";
		app.foregroundOperation = undefined;
		await app.flushPromptQueue();
		assert.equal(backendPrompts, 0, "target-bound shell output cannot drain into a resumed session");
		assert.equal(app.promptQueue.length, 0);

		// If the first lazy ACP attempt fails, cold output is never left for a later
		// reconnect. Reporting the result must not itself launch another attempt.
		app.client = undefined;
		app.ready = false;
		app.clientInstallSequence = 0;
		app.ensureConnected = async () => false;
		await app.runShellInput(`${JSON.stringify(process.execPath)} -e ${JSON.stringify("console.log('no target')")}`);
		assert.equal(app.promptQueue.length, 0, "failed first startup leaves no unfenced shell prompt");

		// A completed failed/auth-required first install is not an in-flight attempt.
		// Shell completion must not tear it down and launch an indistinguishable retry.
		app.client = undefined;
		app.ready = false;
		app.clientInstallSequence = 0;
		app.agentSwitchAttempt = undefined;
		app.connectionAttempt = undefined;
		let reconnects = 0;
		app.ensureConnected = async () => {
			reconnects += 1;
			return true;
		};
		const settledFailureShell = app.runShellInput(
			`${JSON.stringify(process.execPath)} -e ${JSON.stringify("setTimeout(() => console.log('settled failure'), 80)")}`,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		app.client = { exited: false, sessionId: undefined, capabilities: {} };
		app.clientInstallSequence += 1;
		await settledFailureShell;
		assert.equal(reconnects, 0, "cold shell output cannot start a second ACP lifecycle after the first settled unsuccessfully");
		assert.ok(
			blockedMessages.some(([, message]) => message.includes("first backend connection never became ready")),
			"the discarded cold output explains the failed first target",
		);
	} finally {
		app.voiceController?.dispose();
	}
}

console.log("shell history tests passed");
