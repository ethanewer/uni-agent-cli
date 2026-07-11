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
	} finally {
		app.voiceController?.dispose();
	}
}

console.log("shell history tests passed");
