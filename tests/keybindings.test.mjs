import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	CC_NATIVE_INPUT_CONTEXT,
	CC_UNBOUND_ACTION,
	CcKeybindingDispatcher,
	ccKeybindingsPath,
	compileCcKeybindings,
	ensureCcKeybindingsFile,
	formatCcKeybindingsStatus,
	loadCcKeybindings,
	normalizeCcKeyStroke,
	watchCcKeybindings,
} from "../src/harness/keybindings.mjs";
import { configureCcKeybindings, HarnessApp, localSlashCommands, SelectionPanel } from "../src/pi-harness.mjs";

assert.deepEqual(normalizeCcKeyStroke("option+return"), { key: "alt+enter" });
assert.deepEqual(normalizeCcKeyStroke("command+shift+P"), { key: "shift+super+p" });
assert.deepEqual(normalizeCcKeyStroke("K"), { key: "shift+k" });
assert.deepEqual(normalizeCcKeyStroke("ctrl+K"), { key: "ctrl+k" });
assert.deepEqual(normalizeCcKeyStroke("PageUp"), { key: "pageUp" });
assert.deepEqual(normalizeCcKeyStroke("ctrl+K   ctrl+S"), { key: "ctrl+k ctrl+s" });
assert.match(normalizeCcKeyStroke("ctrl+k ctrl+s ctrl+x").error, /at most two/);
assert.match(normalizeCcKeyStroke("hyper+k").error, /unknown modifier/);
assert.deepEqual(normalizeCcKeyStroke("+"), { key: "+" });
assert.deepEqual(normalizeCcKeyStroke("ctrl++"), { key: "ctrl++" });
assert.match(normalizeCcKeyStroke("++").error, /empty key or modifier/);

{
	const keybindings = configureCcKeybindings({
		"tui.input.newLine": ["ctrl+j"],
		"tui.input.submit": ["ctrl+q"],
	});
	assert.equal(keybindings.matches("\n", "tui.input.newLine"), true);
	assert.equal(keybindings.matches("\x11", "tui.input.submit"), true);
	assert.equal(keybindings.matches("\r", "tui.input.submit"), false);
}

{
	const result = compileCcKeybindings(undefined);
	assert.deepEqual(result.userBindings["tui.input.newLine"], ["shift+enter", "alt+enter"]);
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Task" && binding.key === "ctrl+x ctrl+b" && binding.action === "cc.task.background"));
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Chat" && binding.key === "space" && binding.action === "cc.voice.pushToTalk" && binding.default));
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Chat" && binding.key === "shift+tab" && binding.action === "cc.chat.cycleMode" && binding.default));
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Global" && binding.key === "ctrl+t" && binding.action === "cc.app.toggleTodos" && binding.default));
	assert.deepEqual(result.warnings, []);
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.deepEqual(
		dispatcher.handle("\r", ["Autocomplete", "Chat", "Global"]),
		{ consume: false },
		"without a lower collision, native autocomplete keeps Pi's exact accept-and-submit behavior",
	);
	dispatcher.dispose();
}

{
	const result = compileCcKeybindings({
		bindings: [
			{
				context: "Chat",
				bindings: {
					enter: "chat:newline",
					"shift+enter": null,
					"ctrl+u": null,
					"ctrl+k": "chat:newline",
					"ctrl+q": "chat:submit",
				},
			},
			{
				context: "Autocomplete",
				bindings: {
					"ctrl+n": "autocomplete:next",
					"ctrl+p": "autocomplete:previous",
				},
			},
		],
	});
	assert.deepEqual(result.userBindings["tui.input.newLine"], ["shift+enter", "alt+enter"]);
	assert.equal(result.userBindings["tui.input.submit"], undefined);
	assert.equal(result.userBindings["tui.editor.deleteToLineStart"], undefined);
	assert.equal(result.userBindings["tui.editor.deleteToLineEnd"], undefined);
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Autocomplete" && binding.key === "ctrl+n" && binding.action === "tui.select.down"));
	assert.ok(result.actionBindings.some((binding) =>
		binding.context === "Autocomplete" && binding.key === "ctrl+p" && binding.action === "tui.select.up"));
	assert.deepEqual(result.warnings, []);
}

{
	const result = compileCcKeybindings({
		bindings: [
			{ context: "Global", bindings: { "ctrl+k": "app:toggleTodos", "ctrl+q": "app:redraw" } },
			{
				context: "Chat",
				bindings: {
					"ctrl+c": "chat:newline",
					"ctrl+b": "chat:newline",
					"ctrl+x ctrl+e": "chat:newline",
					"ctrl+q": "chat:not-real",
					"super+k": "chat:clearScreen",
				},
			},
			{ context: "Task", bindings: { "ctrl+x ctrl+z": "task:kill" } },
		],
	});
	assert.ok(result.actionBindings.some((binding) => binding.context === "Global" && binding.key === "ctrl+q" && binding.action === "cc.app.redraw"));
	assert.ok(result.actionBindings.some((binding) => binding.context === "Global" && binding.key === "ctrl+k" && binding.action === "cc.app.toggleTodos"));
	assert.ok(result.warnings.some((warning) => /reserved/.test(warning)));
	assert.ok(result.warnings.some((warning) => /tmux/.test(warning)));
	assert.ok(result.actionBindings.some((binding) => binding.key === "ctrl+x ctrl+e" && binding.action === "tui.input.newLine"));
	assert.equal(result.warnings.some((warning) => /app:toggleTodos.*not supported/.test(warning)), false);
	assert.ok(result.warnings.some((warning) => /chat:clearScreen.*not supported/.test(warning)));
	assert.ok(result.warnings.some((warning) => /task:kill.*not supported/.test(warning)));
	assert.ok(result.warnings.some((warning) => /not supported/.test(warning)));
	assert.equal(result.userBindings["tui.input.newLine"].includes("ctrl+b"), false);
}

{
	const result = compileCcKeybindings({
		bindings: [
			{ context: "Chat", bindings: { "ctrl+x ctrl+n": "chat:newline", "ctrl+u": null } },
			{ context: "Autocomplete", bindings: { "ctrl+x ctrl+j": "autocomplete:next" } },
			{ context: "Select", bindings: { j: "select:next", k: "select:previous" } },
			{ context: "Confirmation", bindings: { a: "confirm:yes", d: "confirm:no", t: "confirm:toggle" } },
			{ context: "Task", bindings: { "ctrl+x ctrl+t": "task:background" } },
		],
	});
	const lookup = (context, key) => result.actionBindings.find((binding) => binding.context === context && binding.key === key)?.action;
	assert.equal(lookup("Chat", "ctrl+x ctrl+n"), "tui.input.newLine");
	assert.equal(lookup("Chat", "ctrl+u"), CC_UNBOUND_ACTION);
	assert.equal(lookup("Autocomplete", "ctrl+x ctrl+j"), "tui.select.down");
	assert.equal(lookup("Select", "j"), "cc.select.next");
	assert.equal(lookup("Confirmation", "a"), "cc.confirm.yes");
	assert.equal(lookup("Confirmation", "t"), "cc.confirm.toggle");
	assert.equal(lookup("Task", "ctrl+x ctrl+t"), "cc.task.background");
	assert.equal(result.userBindings["tui.select.down"], undefined, "Select bindings must not leak into Autocomplete");
}

{
	const result = compileCcKeybindings({
		bindings: [
			{ context: "Global", bindings: { "ctrl+g": "app:redraw" } },
			{ context: "Chat", bindings: { "ctrl+g": "chat:cancel", "ctrl+x ctrl+n": "chat:newline" } },
		],
	});
	let timeoutCallback;
	let cleared = 0;
	const dispatcher = new CcKeybindingDispatcher(result, {
		setTimeout(callback) {
			timeoutCallback = callback;
			return 1;
		},
		clearTimeout() { cleared += 1; },
	});
	assert.deepEqual(dispatcher.handle("\x07", ["Chat", "Global"]), {
		consume: true,
		action: "cc.chat.cancel",
		chord: "ctrl+g",
		binding: result.actionBindings.find((binding) => binding.context === "Chat" && binding.key === "ctrl+g"),
	});
	assert.deepEqual(dispatcher.handle("\x18", ["Chat", "Global"]), { consume: true, pending: true });
	assert.equal(dispatcher.handle("\x0e", ["Chat", "Global"]).action, "tui.input.newLine");
	assert.ok(cleared >= 1);
	assert.deepEqual(dispatcher.handle("\x18", ["Chat"]), { consume: true, pending: true });
	timeoutCallback();
	assert.deepEqual(dispatcher.handle("x", ["Chat"]), { consume: false });
	dispatcher.dispose();
}

{
	// Active components retain their native keys ahead of lower Chat/Global
	// bindings. In particular, Pi's autocomplete Enter both completes and submits
	// slash commands, so it must pass through rather than becoming host newline.
	const result = compileCcKeybindings({
		bindings: [
			{ context: "Global", bindings: { enter: "app:redraw", j: "app:toggleTodos", x: "app:redraw" } },
			{ context: "Chat", bindings: { enter: "chat:newline", backspace: "chat:fastMode", "tab x": "chat:submit" } },
		],
	});
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.deepEqual(dispatcher.handle("\r", ["Autocomplete", "Chat", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("\t", ["Autocomplete", "Chat", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("j", ["Autocomplete", "Chat", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("x", ["Autocomplete", "Chat", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("\x7f", ["Autocomplete", "Chat", "Global"]), { consume: false });
	assert.equal(dispatcher.handle("\r", ["Chat", "Global"]).action, "tui.input.newLine");
	assert.deepEqual(dispatcher.handle("\r", ["Select", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("j", ["Select", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("\x1b[6~", ["Select", "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("x", [CC_NATIVE_INPUT_CONTEXT, "Global"]), { consume: false });
	assert.deepEqual(dispatcher.handle("\x7f", [CC_NATIVE_INPUT_CONTEXT, "Global"]), { consume: false });
	dispatcher.dispose();
}

{
	// A binding in the higher component context still replaces its default, and
	// its chord keeps normal prefix/completion semantics.
	const result = compileCcKeybindings({
		bindings: [
			{ context: "Autocomplete", bindings: { enter: "autocomplete:next", "tab x": "autocomplete:accept" } },
			{ context: "Chat", bindings: { enter: "chat:newline", tab: "chat:submit" } },
			{ context: "Select", bindings: { j: "select:next" } },
		],
	});
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.equal(dispatcher.handle("\r", ["Autocomplete", "Chat", "Global"]).action, "tui.select.down");
	assert.deepEqual(dispatcher.handle("\t", ["Autocomplete", "Chat", "Global"]), { consume: true, pending: true });
	assert.equal(dispatcher.handle("x", ["Autocomplete", "Chat", "Global"]).action, "tui.select.confirm");
	assert.equal(dispatcher.handle("j", ["Select", "Global"]).action, "cc.select.next");
	dispatcher.dispose();
}

{
	// Integration with Pi's real editor: a lower Chat Enter remap must not remain
	// in the process-global key manager after slash autocomplete accepts a command.
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-keybinding-autocomplete-integration-"));
	try {
		const file = path.join(temporary, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({
			bindings: [{ context: "Chat", bindings: { enter: "chat:newline" } }],
		}));
		const config = {
			defaultAgent: "codex",
			agents: { codex: { label: "Codex", transport: "acp", acp: { command: "codex-acp", args: [] } } },
		};
		const app = new HarnessApp(config, "codex", "acp", { keybindingsOptions: { file } });
		try {
			app.editor.setText("/r");
			app.editor.autocompleteState = "regular";
			app.editor.autocompletePrefix = "/r";
			app.editor.autocompleteList = { getSelectedItem: () => ({ value: "/resume", label: "resume" }) };
			app.editor.autocompleteProvider = {
				applyCompletion: () => ({ lines: ["/resume"], cursorLine: 0, cursorCol: 7 }),
			};
			let submitted;
			app.editor.onSubmit = (text) => { submitted = text; };
			assert.deepEqual(
				app.keybindingDispatcher.handle("\r", ["Autocomplete", "Chat", "Global"]),
				{ consume: false },
			);
			app.editor.handleInput("\r");
			assert.equal(submitted, "/resume");
			assert.equal(app.editor.getText(), "", "autocomplete Enter submits instead of inserting a Chat newline");
		} finally {
			app.keybindingDispatcher.dispose();
			app.voiceController?.dispose();
		}
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

{
	const result = compileCcKeybindings({
		bindings: [{
			context: "Chat",
			bindings: {
				"ctrl+x ctrl+k": null,
				"ctrl+x": "chat:newline",
			},
		}],
	});
	assert.equal(result.warnings.some((warning) => /also a chord prefix/.test(warning)), false);
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.equal(dispatcher.handle("\x18", ["Chat"]).action, "tui.input.newLine", "unbinding the last chord frees its prefix");
	dispatcher.dispose();
}

{
	const app = Object.create(HarnessApp.prototype);
	app.menuHandle = undefined;
	app.editor = { autocompleteState: {}, getText: () => "" };
	app.focusedThread = "main";
	app.busy = true;
	app.client = { capabilities: { backgroundTasks: true } };
	assert.deepEqual(app.activeCcKeybindingContexts(), ["Autocomplete", "Task", "Chat", "Global"]);
	app.menuHandle = { keybindingContext: "Confirmation" };
	assert.deepEqual(app.activeCcKeybindingContexts(), ["Confirmation", "Global"]);
	app.menuHandle = { activeKeybindingContexts: () => [] };
	assert.deepEqual(
		app.activeCcKeybindingContexts(),
		[CC_NATIVE_INPUT_CONTEXT, "Global"],
		"free-text forms keep native input priority without treating y/n as confirmation actions",
	);
}

{
	const input = [];
	let renders = 0;
	const app = Object.create(HarnessApp.prototype);
	app.menuHandle = { handleInput: (data) => input.push(data) };
	app.ui = { requestRender: () => { renders += 1; } };
	assert.equal(app.executeCcKeybindingAction("cc.confirm.yes"), true);
	assert.equal(app.executeCcKeybindingAction("cc.select.next"), true);
	assert.deepEqual(input, ["\r", "\x1b[B"]);
	assert.equal(renders, 2);
}

{
	let text = "preserve this draft";
	let repaints = 0;
	const app = Object.create(HarnessApp.prototype);
	app.editor = { getText: () => text };
	app.forceFullRepaint = () => { repaints += 1; };
	assert.equal(app.executeCcKeybindingAction("cc.app.redraw"), true);
	assert.equal(text, "preserve this draft", "chat:clearInput redraw must preserve composer input");
	assert.equal(repaints, 1);
}

{
	const notices = [];
	const app = Object.create(HarnessApp.prototype);
	app.sessionSwitchInProgress = true;
	app.stop = () => assert.fail("app:exit must not stop cc during a session transition");
	app.addNotice = (message) => notices.push(message);
	app.ui = { requestRender() {} };
	assert.equal(app.executeCcKeybindingAction("cc.app.exit"), true);
	assert.deepEqual(notices, ["Exit is unavailable while a session transition is in progress"]);
}

{
	let entered = 0;
	let voiceCalls = 0;
	const app = Object.create(HarnessApp.prototype);
	app.voiceModeEnabled = false;
	app.lastKnownEditorText = "";
	app.editor = { getText: () => "" };
	app.enterVoiceMode = () => { entered += 1; app.voiceModeEnabled = true; };
	app.exitVoiceMode = () => { app.voiceModeEnabled = false; };
	app.handleVoiceKey = () => { voiceCalls += 1; return true; };
	assert.equal(app.executeCcKeybindingAction("cc.voice.pushToTalk", {
		chord: "space",
		binding: { default: true },
	}), false, "default Space must remain ordinary text outside voice mode");
	assert.equal(voiceCalls, 0);
	app.voiceModeEnabled = true;
	app.editor.getText = () => "draft";
	assert.equal(app.executeCcKeybindingAction("cc.voice.pushToTalk", {
		chord: "space",
		binding: { default: true },
	}), false);
	assert.equal(app.voiceModeEnabled, false, "typing state wins over the default voice binding");
	app.editor.getText = () => "";
	assert.equal(app.executeCcKeybindingAction("cc.voice.pushToTalk", {
		chord: "alt+v",
		binding: { default: false },
	}), true, "an explicit modifier binding can enter voice mode");
	assert.equal(entered, 1);
	assert.equal(voiceCalls, 1);
}

{
	const notices = [];
	let toggles = 0;
	let voiceCalls = 0;
	let sideInterrupts = 0;
	let renders = 0;
	const app = Object.create(HarnessApp.prototype);
	app.foregroundOperation = {
		commandName: "resume",
		status: "loading sessions",
		cancelled: false,
	};
	app.addNotice = (message) => notices.push(message);
	app.ui = { requestRender: () => { renders += 1; } };
	app.focusedThread = "btw";
	app.btwThread = { busy: true, interrupt: () => { sideInterrupts += 1; } };
	app.deferredLocalSlashCommands = [];
	app.schedulePromptQueueDrain = () => {};
	app.toggleTodosPanel = () => { toggles += 1; };
	app.handleVoiceKey = () => { voiceCalls += 1; return true; };
	assert.equal(app.executeCcKeybindingAction("cc.app.toggleTodos"), true);
	assert.equal(app.executeCcKeybindingAction("cc.voice.pushToTalk", {
		chord: "alt+v",
		binding: { default: false },
	}), true);
	assert.equal(toggles, 0, "Ctrl+T must not replace a picker that is still loading");
	assert.equal(voiceCalls, 0, "push-to-talk must not start during an exclusive operation");
	assert.deepEqual(notices, ["/resume is still in progress. Wait or press Ctrl+C to cancel."]);
	assert.equal(renders, 2);
	assert.equal(app.executeCcKeybindingAction("cc.chat.cancel"), true);
	assert.equal(app.foregroundOperation, undefined, "Ctrl+C cancels the global foreground owner");
	assert.equal(sideInterrupts, 0, "a focused /btw turn cannot steal foreground cancellation");
	app.workingTreeMutationOperation = {
		terminal: true,
		label: "Codex Cloud apply may still be changing files; restart cc",
	};
	assert.equal(app.executeCcKeybindingAction("cc.app.toggleTodos"), true);
	assert.equal(toggles, 0, "host shortcuts stay blocked after an unconfirmed Cloud apply");
	assert.ok(notices.some((message) => /Restart cc before using this shortcut/u.test(message)));
}

{
	const notices = [];
	const stopped = [];
	const client = {
		capabilities: { backgroundTasks: true },
		async backgroundTasks() { return { backgrounded: true }; },
		async listBackgroundTasks() {
			return {
				tasks: [
					{ id: "running", status: "running" },
					{ id: "paused", status: "paused" },
					{ id: "done", status: "completed" },
				],
			};
		},
		async stopBackgroundTask(id) { stopped.push(id); },
	};
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "main";
	app.client = client;
	app.captureSessionCommandTarget = () => ({ client });
	app.isSessionCommandTargetActive = () => true;
	app.addSessionTargetNotice = (_target, message) => notices.push(message);
	app.addSessionTargetError = (_target, message) => assert.fail(message);
	app.ui = { requestRender() {} };
	await app.backgroundTaskFromKeybinding();
	await app.killRunningTasksFromKeybinding();
	assert.deepEqual(stopped, ["running", "paused"]);
	assert.ok(notices.some((message) => /running in the background/.test(message)));
	assert.ok(notices.some((message) => /2 running agents/.test(message)));
}

{
	let selected;
	const client = {};
	const target = { client };
	const app = Object.create(HarnessApp.prototype);
	app.focusedThread = "main";
	app.captureSessionCommandTarget = () => target;
	app.isSessionCommandTargetActive = () => true;
	app.sessionStateForCommandTarget = () => ({
		modes: {
			currentModeId: "ask",
			availableModes: [
				{ id: "ask", name: "Ask" },
				{ id: "auto", name: "Auto" },
			],
		},
	});
	app.setModeValueForCommandTarget = async (_target, value, name) => { selected = [value, name]; };
	app.addSessionTargetNotice = (_target, message) => assert.fail(message);
	app.ui = { requestRender() {} };
	await app.cycleModeFromKeybinding();
	assert.deepEqual(selected, ["auto", "Auto"]);
	let cycles = 0;
	app.btwThread = {};
	app.cycleModeFromKeybinding = async () => { cycles += 1; };
	assert.equal(app.executeCcKeybindingAction("cc.chat.cycleMode", {
		binding: { default: true },
	}), false, "the default Shift+Tab remains /btw focus while a side thread is open");
	assert.equal(cycles, 0);
}

{
	// Pure-UI keys stay usable while a foreground operation runs: the default
	// Shift+Tab keeps toggling /btw pane focus, and a default plain Space keeps
	// typing into the composer instead of being swallowed with a notice.
	const app = Object.create(HarnessApp.prototype);
	app.foregroundOperation = { commandName: "resume", status: "loading sessions", cancelled: false };
	app.btwThread = {};
	app.voiceModeEnabled = false;
	app.lastKnownEditorText = "";
	app.editor = { getText: () => "use opus" };
	app.exitVoiceMode = () => {};
	app.addNotice = () => assert.fail("pane focus and typing must not raise the in-progress notice");
	assert.equal(app.executeCcKeybindingAction("cc.chat.cycleMode", {
		binding: { default: true },
	}), false, "the default Shift+Tab pane toggle bypasses the foreground-operation block");
	assert.equal(app.executeCcKeybindingAction("cc.voice.pushToTalk", {
		chord: "space",
		binding: { default: true },
	}), false, "a default plain Space stays composer text during a foreground operation");
}

{
	// Confirmation 'y'/'n' on a permission prompt select the affirmative/negative
	// option instead of replaying Enter (highlighted row) or Escape (cancel).
	const options = [
		{ optionId: "always", name: "Always allow", kind: "allow_always" },
		{ optionId: "once", name: "Allow once", kind: "allow_once" },
		{ optionId: "no", name: "Don't allow", kind: "reject_once" },
	];
	const selections = [];
	const app = Object.create(HarnessApp.prototype);
	app.ui = { requestRender() {} };
	app.menuHandle = new SelectionPanel("Allow tool?", options.map((option) => ({
		value: option,
		label: option.name,
	})), (entry) => selections.push(entry?.value?.optionId), { keybindingContext: "Confirmation" });
	assert.equal(app.executeCcKeybindingAction("cc.confirm.yes"), true);
	assert.deepEqual(selections, [], "a confirmation shortcut cannot act before its exact choice has rendered");
	app.menuHandle.render(80, 10);
	assert.equal(app.executeCcKeybindingAction("cc.confirm.yes"), true);
	app.menuHandle.onSelect = (entry) => selections.push(entry?.value?.optionId);
	assert.equal(app.executeCcKeybindingAction("cc.confirm.no"), true);
	assert.deepEqual(selections, ["once"], "changing the shortcut target requires a render before confirmation");
	app.menuHandle.render(80, 10);
	assert.equal(app.executeCcKeybindingAction("cc.confirm.no"), true);
	assert.deepEqual(selections, ["once", "no"], "y/n pick the narrowest allow/deny options");
	const hiddenSelections = [];
	app.menuHandle = new SelectionPanel("Allow tool?", options.map((option) => ({ value: option, label: option.name })),
		(entry) => hiddenSelections.push(entry?.value?.optionId), { keybindingContext: "Confirmation" });
	app.menuHandle.handleInput("Don't");
	app.menuHandle.render(80, 10);
	assert.equal(app.executeCcKeybindingAction("cc.confirm.yes"), true);
	assert.deepEqual(hiddenSelections, [], "a confirmation shortcut cannot select an allow choice hidden by the filter");
}

{
	// While agents run, Task claims the ctrl+x prefix; same-prefix chords in
	// lower contexts (Chat ctrl+x ctrl+k) must still complete.
	const result = compileCcKeybindings(undefined);
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.deepEqual(dispatcher.handle("\x18", ["Task", "Chat", "Global"]), { consume: true, pending: true });
	assert.equal(dispatcher.handle("\x0b", ["Task", "Chat", "Global"]).action, "cc.chat.killAgents");
	assert.deepEqual(dispatcher.handle("\x18", ["Task", "Chat", "Global"]), { consume: true, pending: true });
	assert.equal(dispatcher.handle("\x02", ["Task", "Chat", "Global"]).action, "cc.task.background");
	dispatcher.dispose();
}

{
	// The plus key is bindable even though "+" is also the modifier separator.
	const result = compileCcKeybindings({
		bindings: [{ context: "Chat", bindings: { "ctrl++": "chat:submit", "+": "chat:newline" } }],
	});
	assert.deepEqual(result.warnings, []);
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.equal(dispatcher.handle("\x1b[43;5u", ["Chat", "Global"]).action, "tui.input.submit");
	assert.equal(dispatcher.handle("+", ["Chat", "Global"]).action, "tui.input.newLine");
	dispatcher.dispose();
}

{
	const result = compileCcKeybindings({
		bindings: [{ context: "Chat", bindings: { "ctrl+x": "chat:newline" } }],
	});
	assert.ok(result.warnings.some((warning) => /also a chord prefix/.test(warning)));
	const dispatcher = new CcKeybindingDispatcher(result);
	assert.deepEqual(dispatcher.handle("\x18", ["Chat"]), { consume: true, pending: true });
	dispatcher.dispose();
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-keybindings-test-"));
try {
	const defaultPath = ccKeybindingsPath({ homeDirectory: temporary, environment: {} });
	assert.equal(defaultPath, path.join(temporary, ".config", "cc", "keybindings.json"));
	assert.equal(
		ccKeybindingsPath({ environment: { CC_SETTINGS: path.join(temporary, "beta", "settings.json") } }),
		path.join(temporary, "beta", "keybindings.json"),
	);
	assert.equal(
		ccKeybindingsPath({ environment: { CC_KEYBINDINGS: path.join(temporary, "custom.json") } }),
		path.join(temporary, "custom.json"),
	);

	const file = path.join(temporary, "config", "keybindings.json");
	const created = ensureCcKeybindingsFile({ file });
	assert.equal(created.created, true);
	assert.equal(ensureCcKeybindingsFile({ file }).created, false);
	assert.equal(fs.statSync(file).mode & 0o777, 0o600);
	const template = JSON.parse(fs.readFileSync(file, "utf8"));
	assert.ok(Array.isArray(template.bindings));
	assert.match(template.$schema, /claude-code-keybindings/);

	fs.writeFileSync(file, JSON.stringify({
		bindings: [{ context: "Chat", bindings: { "ctrl+j": "chat:submit" } }],
	}));
	const loaded = loadCcKeybindings({ file });
	assert.equal(loaded.exists, true);
	assert.equal(loaded.userBindings["tui.input.submit"], undefined);
	assert.ok(loaded.actionBindings.some((binding) =>
		binding.context === "Chat" && binding.key === "ctrl+j" && binding.action === "tui.input.submit"));
	assert.match(formatCcKeybindingsStatus(loaded), /Chat ctrl\+j -> chat:submit/);

	fs.writeFileSync(file, "{ nope");
	const invalid = loadCcKeybindings({ file });
	assert.ok(invalid.warnings.some((warning) => /Could not parse/.test(warning)));
	assert.deepEqual(invalid.userBindings["tui.input.newLine"], ["shift+enter", "alt+enter"]);
} finally {
	fs.rmSync(temporary, { recursive: true, force: true });
}

{
	const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "cc-keybindings-command-test-"));
	try {
		const file = path.join(temporary, "keybindings.json");
		fs.writeFileSync(file, JSON.stringify({
			bindings: [{ context: "Chat", bindings: { "ctrl+j": "chat:submit" } }],
		}));
		const messages = [];
		const app = Object.create(HarnessApp.prototype);
		app.keybindingsOptions = { file };
		app.keybindingsResult = loadCcKeybindings({ file });
		app.inputKeybindings = configureCcKeybindings(app.keybindingsResult.userBindings);
		app.addCommandMessage = (message) => messages.push(["command", message]);
		app.addNotice = (message) => messages.push(["notice", message]);
		app.addError = (message) => messages.push(["error", message]);
		app.ui = { requestRender() {} };
		app.openKeybindingsFile = async (opened) => messages.push(["opened", opened]);

		await app.runKeybindingsCommand("show");
		assert.ok(messages.some(([kind, message]) => kind === "notice" && /Chat ctrl\+j -> chat:submit/.test(message)));
		messages.length = 0;
		await app.runKeybindingsCommand("edit");
		assert.deepEqual(messages.find(([kind]) => kind === "opened"), ["opened", file]);
		assert.ok(messages.some(([kind, message]) => kind === "notice" && message === `Opened ${file}`));
	} finally {
		fs.rmSync(temporary, { recursive: true, force: true });
	}
}

{
	const app = {
		focusedThread: "main",
		btwThread: undefined,
		client: undefined,
		sessionStates: new Map(),
		activeKey: "claude",
		config: { agents: { claude: { label: "Claude" } } },
		isCodexBackendActive: () => false,
		themeName: "system",
	};
	const command = localSlashCommands(app).find((entry) => entry.name === "keybindings");
	assert.equal(command?.description, "Open or reload cc keyboard shortcuts");
	assert.deepEqual(command.getArgumentCompletions("re").map((entry) => entry.value), ["reload"]);
}

{
	let listener;
	let unwatched;
	let changes = 0;
	const stop = watchCcKeybindings("/tmp/cc-keybindings.json", () => {
		changes += 1;
	}, {
		watchFile(file, options, callback) {
			assert.equal(file, "/tmp/cc-keybindings.json");
			assert.equal(options.persistent, false);
			listener = callback;
		},
		unwatchFile(file, callback) {
			unwatched = [file, callback];
		},
	});
	listener({ mtimeMs: 1, size: 3 }, { mtimeMs: 0, size: 0 });
	assert.equal(changes, 1);
	listener({ mtimeMs: 1, size: 3 }, { mtimeMs: 1, size: 3 });
	assert.equal(changes, 1);
	stop();
	assert.deepEqual(unwatched, ["/tmp/cc-keybindings.json", listener]);
	listener({ mtimeMs: 2, size: 4 }, { mtimeMs: 1, size: 3 });
	assert.equal(changes, 1);
}

console.log("keybindings tests passed");
