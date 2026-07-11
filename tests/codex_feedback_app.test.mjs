import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

const threadId = "019abcde-1234-7abc-8def-0123456789ab";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-feedback-"));
const codexPath = path.join(root, "codex.mjs");
fs.writeFileSync(codexPath, "process.exit(0);\n");
fs.chmodSync(codexPath, 0o755);

function appHarness(options = {}) {
	const commands = [];
	const notices = [];
	const errors = [];
	const selections = [];
	const captures = [];
	const requests = [];
	const appServerOptions = [];
	const agent = { env: { CODEX_PATH: codexPath, PATH: "" } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		platform: options.platform ?? "darwin",
		config: { agents: { codex: agent }, settings: {} },
		client: { sessionId: options.sessionId ?? threadId, exited: false, capabilities: {} },
		ready: true,
		busy: false,
		sessionSwitchInProgress: false,
		selectionActionInProgress: false,
		asyncPickerLoadCount: 0,
		configUpdateCount: 0,
		statusState: "",
		sessionStates: new Map(),
		availableCommands: new Map(),
		commandsLoaded: new Set(["codex"]),
		ui: { requestRender() {} },
		editor: {
			text: "",
			getText() { return this.text; },
			setText(value) { this.text = value; },
		},
		addCommandMessage(value) { commands.push(value); },
		addNotice(value) { notices.push(value); },
		addError(value) { errors.push(value); },
		updateSpinner() {},
		onThreadActivity() {},
		bindEditorToSideThread(target) { this.boundEditorTarget = target; },
		openSelection(title, entries, onSelect) { selections.push({ title, entries, onSelect }); },
		closeMenu() {},
		beginAsyncPickerLoad() {
			this.asyncPickerLoadCount += 1;
			return Symbol("operation");
		},
		endAsyncPickerLoad() { this.asyncPickerLoadCount -= 1; },
		async runFencedCodexNativeOperation(operation) { return await operation(); },
		async runTrackedCapture(command, args, captureOptions) {
			captures.push({ command, args, captureOptions });
			return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
		},
		async runFencedCodexAppServerRequests(_invocation, rpcRequests, _agent, options) {
			requests.push(...rpcRequests);
			appServerOptions.push(options);
			return rpcRequests.map(() => ({ threadId }));
		},
	});
	return { app, agent, commands, notices, errors, selections, captures, requests, appServerOptions };
}

try {
	// Catalog and routing expose desktop handoff only where Codex Desktop exists,
	// while feedback is available on every platform and completes categories.
	{
		const { app } = appHarness({ platform: "darwin" });
		let catalog = localSlashCommands(app);
		assert.ok(catalog.some((entry) => entry.name === "app"));
		assert.ok(catalog.some((entry) => entry.name === "feedback"));
		assert.equal(app.slashCommandRoute("app"), "local");
		assert.equal(app.slashCommandRoute("feedback"), "local");
		const feedback = catalog.find((entry) => entry.name === "feedback");
		assert.deepEqual(
			feedback.getArgumentCompletions("").map((entry) => entry.value),
			["bug", "bad-result", "good-result", "safety-check", "other"],
		);
		assert.deepEqual(feedback.getArgumentCompletions("bad").map((entry) => entry.value), ["bad-result"]);
		assert.deepEqual(feedback.getArgumentCompletions("bug note"), []);

		app.platform = "linux";
		catalog = localSlashCommands(app);
		assert.equal(catalog.some((entry) => entry.name === "app"), false);
		assert.ok(catalog.some((entry) => entry.name === "feedback"));
	}

	// Bare feedback opens the category picker and stages a category-specific
	// command for editing, preserving a /btw target binding when present.
	{
		const { app, commands, selections } = appHarness();
		await app.openCodexFeedback();
		assert.deepEqual(commands, ["/feedback"]);
		assert.equal(selections.length, 1);
		assert.equal(selections[0].title, "Feedback category");
		await selections[0].onSelect(selections[0].entries[1]);
		assert.equal(app.editor.text, "/feedback bad-result ");
	}

	// The default consent choice excludes logs. The private note reaches only the
	// RPC request; neither commands nor success/error transcript text echoes it.
	{
		const secret = "private customer token sk-do-not-render";
		const harness = appHarness();
		await harness.app.openCodexFeedback(`bug ${secret}`);
		assert.equal(harness.selections.length, 1);
		const consent = harness.selections[0];
		assert.equal(consent.entries[0].value, "without-logs");
		assert.equal(consent.entries[1].value, "with-logs");
		await consent.onSelect(consent.entries[0]);
		assert.deepEqual(harness.requests, [{
			method: "feedback/upload",
			params: {
				classification: "bug",
				reason: secret,
				threadId,
				includeLogs: false,
			},
		}]);
		assert.equal(harness.appServerOptions[0].acceptForcedTeardownAfterResponse, true);
		assert.equal(typeof harness.appServerOptions[0].sanitizeError, "function");
		const rendered = [...harness.commands, ...harness.notices, ...harness.errors].join("\n");
		assert.doesNotMatch(rendered, /private customer|sk-do-not-render/);
		assert.deepEqual(harness.commands, ["/feedback bug"]);
		assert.match(rendered, /without Codex logs/);
	}

	// If an upstream error echoes the private note and process teardown becomes a
	// shared fatal fence, only the sanitized error may survive into later commands.
	{
		const secret = "fence-must-never-render-this-note";
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async (_invocation, _requests, _agent, options) => {
			const upstream = new Error(`feedback rejected: ${secret}`);
			upstream.code = "PROCESS_TREE_TERMINATION_FAILED";
			const safe = options.sanitizeError(upstream);
			harness.app.recordReplacementProcessFence(safe, { preserveReady: true });
			throw harness.app.replacementProcessFenceError();
		};
		await harness.app.openCodexFeedback(`bug ${secret}`);
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		harness.app.requireActiveCodex("hooks");
		const rendered = [...harness.commands, ...harness.notices, ...harness.errors].join("\n");
		assert.doesNotMatch(rendered, new RegExp(secret));
		assert.match(rendered, /previous process tree could not be confirmed stopped/);
	}

	// Attaching diagnostics requires choosing the second, explicit option.
	{
		const harness = appHarness();
		await harness.app.openCodexFeedback("good-result useful");
		const consent = harness.selections[0];
		await consent.onSelect(consent.entries[1]);
		assert.equal(harness.requests[0].params.includeLogs, true);
		assert.match(harness.notices.join("\n"), /with Codex logs/);
	}

	// A hostile upstream error may echo the private reason. The TUI reports a
	// fixed failure message and drops that upstream text.
	{
		const secret = "never-print-this-note";
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async () => {
			throw new Error(`server rejected ${secret}`);
		};
		await harness.app.openCodexFeedback(`other ${secret}`);
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		const rendered = [...harness.commands, ...harness.notices, ...harness.errors].join("\n");
		assert.doesNotMatch(rendered, new RegExp(secret));
		assert.match(rendered, /no upload confirmation/);
	}

	// Replacing the target while the consent dialog is open cancels the upload.
	{
		const harness = appHarness();
		await harness.app.openCodexFeedback("bug stale target");
		harness.app.client = { sessionId: threadId, exited: false };
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		assert.deepEqual(harness.requests, []);
		assert.match(harness.notices.join("\n"), /targeted \/btw thread|cancelled|no longer open/i);
	}

	// Non-Codex and validation failures never echo the supplied note either.
	{
		const harness = appHarness();
		harness.app.activeKey = "claude";
		harness.app.config.agents.claude = {};
		await harness.app.openCodexFeedback("bug backend-secret");
		assert.doesNotMatch([...harness.commands, ...harness.notices].join("\n"), /backend-secret/);

		const invalid = appHarness();
		await invalid.app.openCodexFeedback("unknown validation-secret");
		assert.doesNotMatch([...invalid.commands, ...invalid.notices].join("\n"), /validation-secret/);
	}

	// Desktop handoff launches the validated current UUID through the fixed system
	// launcher. It never shells out through the Codex CLI or forwards arguments.
	{
		const harness = appHarness({ platform: "darwin" });
		await harness.app.openCodexDesktopThread();
		assert.deepEqual(harness.commands, ["/app"]);
		assert.equal(harness.captures.length, 1);
		assert.equal(harness.captures[0].command, "/usr/bin/open");
		assert.deepEqual(harness.captures[0].args, [`codex://threads/${threadId}`]);
		assert.match(harness.notices.join("\n"), /Opened this thread/);
	}

	// Side-pane handoff uses that fork's UUID and reports in that pane.
	{
		const harness = appHarness({ platform: "darwin" });
		const sideId = "aaaaaaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
		const sideCommands = [];
		const sideNotices = [];
		const sideErrors = [];
		const side = {
			ready: true,
			busy: false,
			sessionId: sideId,
			client: { sessionId: sideId, exited: false },
			addCommandMessage(value) { sideCommands.push(value); },
			addNotice(value) { sideNotices.push(value); },
			addError(value) { sideErrors.push(value); },
		};
		harness.app.btwThread = side;
		await harness.app.openCodexDesktopThread("", "app", { targetThread: side });
		assert.deepEqual(harness.captures[0].args, [`codex://threads/${sideId}`]);
		assert.deepEqual(sideCommands, ["/app"]);
		assert.match(sideNotices.join("\n"), /Opened this thread/);
		assert.deepEqual(sideErrors, []);
	}

	// Unsupported systems and malformed session ids fail without starting a
	// process. `/app` is hidden on Linux, but direct calls remain deterministic.
	{
		const linux = appHarness({ platform: "linux" });
		await linux.app.openCodexDesktopThread();
		assert.deepEqual(linux.captures, []);
		assert.match(linux.notices.join("\n"), /macOS and Windows/);

		const malformed = appHarness({ platform: "darwin", sessionId: "not-a-thread" });
		await malformed.app.openCodexDesktopThread();
		assert.deepEqual(malformed.captures, []);
		assert.match(malformed.errors.join("\n"), /canonical UUID/);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("codex feedback/app: privacy, consent, routing, and desktop handoff");
