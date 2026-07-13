import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	copyResponseChoices,
	fencedCodeBlocks,
	resolveCopyWritePath,
	writeCopySelection,
} from "../src/harness/copy-response.mjs";
import { assistantResponseTexts, HarnessApp, SelectionPanel } from "../src/pi-harness.mjs";

const response = [
	"Use this:",
	"",
	"```js",
	"console.log(`ok`);",
	"```",
	"",
	"And:",
	"~~~~text",
	"hello",
	"~~~",
	"~~~~",
].join("\n");
assert.deepEqual(fencedCodeBlocks(response), [
	{ language: "js", text: "console.log(`ok`);" },
	{ language: "text", text: "hello\n~~~" },
]);
const choices = copyResponseChoices(response);
assert.equal(choices[0].kind, "full", "full response is always the first choice");
assert.equal(choices[1].text, "console.log(`ok`);");
assert.equal(choices[2].text, "hello\n~~~");
assert.deepEqual(copyResponseChoices("plain response").map((choice) => choice.kind), ["full"]);
assert.deepEqual(
	copyResponseChoices("Nothing inside:\n\n```js\n  \n```").map((choice) => choice.kind),
	["full"],
	"empty fenced blocks are not offered as copy/write targets",
);
assert.deepEqual(
	fencedCodeBlocks("Truncated:\n\n```js\nconst x = 1;\nconsole.log(x);"),
	[{ language: "js", text: "const x = 1;\nconsole.log(x);" }],
	"an unclosed fence runs to the end of the response",
);
assert.deepEqual(
	copyResponseChoices("Truncated:\n\n```js\nconst x = 1;").map((choice) => choice.kind),
	["full", "code"],
	"a response ending mid-fence still offers its code block",
);

let writeSelection;
let enterSelection;
const panel = new SelectionPanel("Copy response", choices, (entry) => {
	enterSelection = entry;
}, {
	onWrite: (entry) => {
		writeSelection = entry;
	},
});
assert.ok(panel.render(100).some((line) => line.includes("w write to file")));
panel.handleInput("w");
assert.equal(writeSelection.kind, "full", "w writes the selected entry when the filter is empty");
panel.selected = 1;
panel.handleInput("\r");
assert.equal(enterSelection.kind, "code", "Enter selects the highlighted entry normally");

let filteredWrite = false;
const filteredPanel = new SelectionPanel("Copy response", choices, () => {}, {
	onWrite: () => {
		filteredWrite = true;
	},
});
filteredPanel.handleInput("c");
filteredPanel.handleInput("w");
assert.equal(filteredWrite, false, "w remains ordinary filter text after filtering starts");
assert.equal(filteredPanel.query, "cw");

function responseChat(text) {
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
	app.appendAssistantText(text);
	app.closeCurrentAssistantText();
	return app.chat;
}

// User text replayed from the backend (resume/branch/rewind) is appended via
// appendUserText, which creates the base MutableUserMessage class. It must
// still be a response boundary, so /copy after a replay targets the latest
// response instead of the merged transcript.
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
		ui: { terminal: { rows: 24 } },
	});
	app.appendUserText("first replayed prompt");
	app.appendAssistantText("first replayed response");
	app.appendUserText("second replayed prompt");
	app.appendAssistantText("second replayed response");
	app.closeCurrentAssistantText();
	assert.deepEqual(assistantResponseTexts(app.chat), [
		"first replayed response",
		"second replayed response",
	]);
}

// /copy follows the focused side pane instead of silently falling back to the
// main transcript.
{
	const app = Object.create(HarnessApp.prototype);
	let copied;
	const sideCommands = [];
	const sideNotices = [];
	const mainCommands = [];
	const sideThread = {
		chat: responseChat("side response"),
		client: { sessionId: "side-session" },
		sessionId: "side-session",
		addCommandMessage: (message) => sideCommands.push(message),
		addNotice: (message) => sideNotices.push(message),
	};
	Object.assign(app, {
		activeKey: "claude",
		btwThread: sideThread,
		chat: responseChat("main response"),
		config: { agents: { claude: {} }, settings: {} },
		focusedThread: "btw",
		activeAgentLaunchSpec: () => undefined,
		addCommandMessage: (message) => mainCommands.push(message),
		addNotice: (message) => assert.fail(message),
		onThreadActivity() {},
		ui: { requestRender() {} },
		copyResponseChoice: async (choice) => { copied = choice.text; },
	});
	await app.runCopy();
	assert.equal(copied, "side response");
	assert.deepEqual(sideCommands, ["/copy"]);
	assert.deepEqual(mainCommands, [], "a side-pane /copy command stays in the side transcript");
	app.focusedThread = "main";
	copied = undefined;
	await app.runCopy("", { targetThread: app.btwThread });
	assert.equal(copied, "side response", "a deferred /copy retains its original side-pane target after focus changes");
	assert.deepEqual(sideCommands, ["/copy", "/copy"]);
	sideThread.chat = responseChat("");
	await app.runCopy("", { targetThread: sideThread });
	assert.equal(sideNotices.at(-1), "Nothing to copy yet.");
	assert.deepEqual(mainCommands, [], "side-pane copy feedback stays out of the main transcript");
}

// Fenced responses retain Full response as the first entry, include code
// blocks, and offer the persistent full-response action after text choices.
{
	const app = Object.create(HarnessApp.prototype);
	let picker;
	let preference;
	let copied;
	Object.assign(app, {
		btwThread: undefined,
		chat: responseChat("Answer\n\n```js\nconst value = 1;\n```"),
		config: { settings: {} },
		focusedThread: "main",
		addCommandMessage() {},
		addNotice: (message) => assert.fail(message),
		ui: { requestRender() {} },
		closeMenu() {},
		openSelection: (title, entries, onSelect, options) => { picker = { title, entries, onSelect, options }; },
		setCopyAlwaysFullResponse: (enabled) => { preference = enabled; return true; },
		copyResponseChoice: async (choice) => { copied = choice.text; },
	});
	await app.runCopy();
	assert.deepEqual(picker.entries.map((entry) => entry.label), [
		"Full response",
		"Code block 1 (js)",
		"Always copy full response",
	]);
	await picker.onSelect(picker.entries.at(-1));
	assert.equal(preference, true);
	assert.match(copied, /^Answer/u);
}

{
	const app = Object.create(HarnessApp.prototype);
	let copied;
	let reset;
	let picker;
	Object.assign(app, {
		btwThread: undefined,
		chat: responseChat("Full\n\n```text\ncode\n```"),
		config: { settings: { copyAlwaysFullResponse: true } },
		focusedThread: "main",
		addCommandMessage() {},
		addNotice() {},
		ui: { requestRender() {} },
		openSelection: (...args) => { picker = args; },
		copyResponseChoice: async (choice) => { copied = choice.text; },
		setCopyAlwaysFullResponse: (enabled) => { reset = enabled; return true; },
	});
	await app.runCopy();
	assert.match(copied, /^Full/u);
	assert.equal(picker, undefined, "the saved full-response preference skips the ordinary picker");
	await app.runCopy("picker");
	assert.equal(reset, false, "/copy picker disables the saved preference");
	assert.equal(picker?.[0], "Copy response", "/copy picker immediately reopens the current response picker");
	assert.deepEqual(picker?.[1].map((entry) => entry.label), [
		"Full response",
		"Code block 1 (text)",
		"Always copy full response",
	]);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-copy-response-"));
try {
	const target = resolveCopyWritePath("reports/answer.md", { cwd: root, homeDirectory: root });
	assert.equal(target, path.join(root, "reports", "answer.md"));
	assert.equal(writeCopySelection("reports/answer.md", "answer\n", { cwd: root }), target);
	assert.equal(fs.readFileSync(target, "utf8"), "answer\n");
	assert.throws(() => writeCopySelection("reports/answer.md", "overwrite", { cwd: root }), /EEXIST/u);
	assert.equal(writeCopySelection("reports/answer.md", "replaced", { cwd: root, overwrite: true }), target);
	assert.equal(fs.readFileSync(target, "utf8"), "replaced");

	let overwriteDialog;
	const app = Object.create(HarnessApp.prototype);
	app.ui = { requestRender() {} };
	app.addError = (message) => assert.fail(message);
	app.addNotice = () => {};
	app.closeMenu = () => {};
	app.openSelection = (title, entries, onSelect) => {
		overwriteDialog = { title, entries, onSelect };
	};
	app.writeCopyChoice(target, { kind: "full", label: "Full response", text: "confirmed" });
	assert.equal(fs.readFileSync(target, "utf8"), "replaced", "an existing file is untouched before confirmation");
	assert.match(overwriteDialog.title, /Overwrite/u);
	overwriteDialog.onSelect(overwriteDialog.entries[0]);
	assert.equal(fs.readFileSync(target, "utf8"), "confirmed", "confirmed overwrite installs the selection");
	const directoryTarget = path.join(root, "existing-directory");
	fs.mkdirSync(directoryTarget);
	assert.throws(
		() => writeCopySelection(directoryTarget, "must not replace a directory", { overwrite: true }),
		/not a regular file/u,
	);
	assert.equal(fs.statSync(directoryTarget).isDirectory(), true);

	const previousSettings = process.env.CC_SETTINGS;
	const settingsFile = path.join(root, "settings.json");
	process.env.CC_SETTINGS = settingsFile;
	try {
		const preferenceApp = Object.create(HarnessApp.prototype);
		preferenceApp.config = { settings: {} };
		preferenceApp.addError = (message) => assert.fail(message);
		assert.equal(preferenceApp.setCopyAlwaysFullResponse(true), true);
		assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).copyAlwaysFullResponse, true);
		assert.equal(preferenceApp.copyAlwaysFullResponse(), true);
		assert.equal(preferenceApp.setCopyAlwaysFullResponse(false), true);
		assert.equal(preferenceApp.copyAlwaysFullResponse(), false);
	} finally {
		if (previousSettings === undefined) delete process.env.CC_SETTINGS;
		else process.env.CC_SETTINGS = previousSettings;
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("copy response tests passed");
