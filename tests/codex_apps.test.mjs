import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexAppMention, HarnessApp, localSlashCommands } from "../src/pi-harness.mjs";

const threadId = "019abcde-1234-7abc-8def-0123456789ab";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-codex-apps-"));
const codexPath = path.join(root, "codex.mjs");
fs.writeFileSync(codexPath, "process.exit(0);\n");
fs.chmodSync(codexPath, 0o755);

function appHarness() {
	const commands = [];
	const notices = [];
	const errors = [];
	const selections = [];
	const rpcCalls = [];
	const agent = { env: { CODEX_PATH: codexPath, PATH: "" } };
	const app = Object.create(HarnessApp.prototype);
	Object.assign(app, {
		activeKey: "codex",
		activeAgentGeneration: 0,
		transport: "acp",
		config: { agents: { codex: agent }, settings: {} },
		client: { sessionId: threadId, exited: false, capabilities: {} },
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
		async runFencedCodexAppServerRequests(_invocation, requests, _agent, options) {
			rpcCalls.push({ requests, options });
			return [{ data: [], nextCursor: null }];
		},
	});
	return { app, commands, notices, errors, selections, rpcCalls };
}

try {
	assert.equal(codexAppMention("google-drive_v2.1"), "[$google-drive-v2-1](app://google-drive_v2.1)");
	assert.equal(codexAppMention("connector-42", "Google Drive"), "[$google-drive](app://connector-42)");
	assert.equal(codexAppMention("connector-42", "🔥"), "[$app](app://connector-42)");
	assert.equal(codexAppMention("connector-42", "A".repeat(1_000)), `[$${"a".repeat(128)}](app://connector-42)`);
	for (const invalid of ["", " bad", "bad app", "bad/slash", "bad\ncommand", "$already", "x".repeat(257), null]) {
		assert.throws(() => codexAppMention(invalid), /cannot be inserted safely/);
	}

	{
		const { app } = appHarness();
		assert.equal(app.slashCommandRoute("apps"), "local");
		assert.ok(localSlashCommands(app).some((entry) => entry.name === "apps"));
	}

	// Discovery uses one bounded snapshot and never loads the adapter-owned live
	// thread. Ready apps sort first; selection inserts an explicit app:// mention.
	{
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async (_invocation, requests, _agent, options) => {
			harness.rpcCalls.push({ requests, options });
			return [{
				data: [{
					id: "needs-setup",
					name: "Needs setup",
					description: "Connect this app\nfirst",
					isAccessible: false,
					isEnabled: true,
				}, {
					id: "google-drive",
					name: "Google Drive",
					description: "Search shared files",
					isAccessible: true,
					isEnabled: true,
				}],
				nextCursor: null,
			}];
		};
		await harness.app.openCodexApps();
		assert.deepEqual(harness.commands, ["/apps"]);
		assert.equal(harness.rpcCalls.length, 1);
		assert.deepEqual(harness.rpcCalls[0], {
			requests: [{ method: "app/list", params: { limit: 500 } }],
			options: {
				timeoutMs: 120_000,
				capabilities: {
					experimentalApi: false,
					requestAttestation: false,
					optOutNotificationMethods: ["app/list/updated"],
				},
			},
		});
		assert.equal(harness.selections.length, 1);
		const selection = harness.selections[0];
		assert.deepEqual(selection.entries.map((entry) => entry.value.id), ["google-drive", "needs-setup"]);
		assert.equal(selection.entries[1].description.includes("\n"), false);
		await selection.onSelect(selection.entries[0]);
		assert.equal(harness.app.editor.text, "[$google-drive](app://google-drive) ");
	}

	// Refresh applies only to the first page; subsequent cursor reads use the
	// refreshed cache rather than repeatedly invalidating it.
	{
		const harness = appHarness();
		await harness.app.openCodexApps("refresh");
		assert.deepEqual(harness.commands, ["/apps refresh"]);
		assert.equal(harness.rpcCalls[0].requests[0].params.forceRefetch, true);
	}

	// Disabled and inaccessible apps remain discoverable but are not inserted.
	{
		for (const record of [
			{ id: "disabled", name: "Disabled", isAccessible: true, isEnabled: false },
			{ id: "unavailable", name: "Unavailable", isAccessible: false, isEnabled: true },
		]) {
			const harness = appHarness();
			harness.app.runFencedCodexAppServerRequests = async () => [{ data: [record], nextCursor: null }];
			await harness.app.openCodexApps();
			await harness.selections[0].onSelect(harness.selections[0].entries[0]);
			assert.equal(harness.app.editor.text, "");
			assert.match(harness.notices.join("\n"), record.isEnabled ? /not connected|unavailable/ : /disabled/);
		}
	}

	// Remote identifiers are treated as data, not composer syntax.
	{
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async () => [{
			data: [{ id: "bad id\n/inject", name: "Bad", isAccessible: true, isEnabled: true }],
			nextCursor: null,
		}];
		await harness.app.openCodexApps();
		await harness.selections[0].onSelect(harness.selections[0].entries[0]);
		assert.equal(harness.app.editor.text, "");
		assert.match(harness.errors.join("\n"), /cannot be inserted safely/);
	}

	// Any running main or side turn prevents discovery, and no app-server process
	// is created. This avoids opening a picker over live approval UI.
	{
		for (const sideBusy of [false, true]) {
			const harness = appHarness();
			if (sideBusy) harness.app.btwThread = { busy: true };
			else harness.app.busy = true;
			await harness.app.openCodexApps();
			assert.deepEqual(harness.rpcCalls, []);
			assert.match(harness.notices.join("\n"), /turn is running/);
		}
	}

	// Oversized catalogs stop at one deterministic bounded snapshot.
	{
		const bounded = appHarness();
		const apps = Array.from({ length: 500 }, (_, index) => ({
			id: `app-${index}`,
			name: `App ${index}`,
			isAccessible: true,
			isEnabled: true,
		}));
		let calls = 0;
		bounded.app.runFencedCodexAppServerRequests = async (_invocation, requests) => {
			calls += 1;
			assert.equal(Object.hasOwn(requests[0].params, "threadId"), false);
			return [{ data: apps, nextCursor: "more" }];
		};
		await bounded.app.openCodexApps();
		assert.equal(calls, 1);
		assert.equal(bounded.selections[0].entries.length, 500);
		assert.equal(bounded.selections[0].title, "Codex apps (first 500)");
	}

	// A session replacement while loading suppresses the stale picker.
	{
		const harness = appHarness();
		harness.app.runFencedCodexAppServerRequests = async () => {
			harness.app.client = { sessionId: threadId, exited: false };
			return [{ data: [{ id: "stale", name: "Stale", isAccessible: true, isEnabled: true }], nextCursor: null }];
		};
		await harness.app.openCodexApps();
		assert.deepEqual(harness.selections, []);
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

console.log("codex apps: bounded discovery and safe mention insertion");
