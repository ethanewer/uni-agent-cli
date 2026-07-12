import assert from "node:assert/strict";
import {
	CHECKLIST_MAX_CONTENT_CHARS,
	CHECKLIST_MAX_ENTRIES,
	CHECKLIST_MAX_RAW_CONTENT_CHARS,
	ChecklistStore,
	emptyChecklistSnapshot,
	formatChecklistSnapshot,
	normalizeChecklistEntries,
} from "../src/harness/checklists.mjs";
import { EVENT_TYPES } from "../src/harness/interface.mjs";
import {
	AcpClient,
	BtwThread,
	ChecklistPanel,
	HarnessApp,
	localSlashCommands,
} from "../src/pi-harness.mjs";

const normalized = normalizeChecklistEntries([
	{ id: "one", content: "  Read\nfiles\u0000  ", status: "active", priority: "high" },
	{ subject: "Ship fix", status: "done", priority: "invalid" },
	{ content: "" },
]);
assert.deepEqual(normalized, [
	{ id: "default:one", content: "Read files", status: "in_progress", priority: "high" },
	{ id: "default:1", content: "Ship fix", status: "completed", priority: "medium" },
]);
assert.equal(normalizeChecklistEntries([{ content: "x".repeat(CHECKLIST_MAX_CONTENT_CHARS + 10) }])[0].content.length, CHECKLIST_MAX_CONTENT_CHARS);
const inspectionBound = Array.from({ length: CHECKLIST_MAX_ENTRIES + 1 }, () => null);
Object.defineProperty(inspectionBound, CHECKLIST_MAX_ENTRIES, {
	get() { throw new Error("normalization inspected beyond its bound"); },
});
assert.deepEqual(normalizeChecklistEntries(inspectionBound), []);
assert.equal(
	normalizeChecklistEntries([{ content: `${"x".repeat(CHECKLIST_MAX_RAW_CONTENT_CHARS)}${"y".repeat(1_000_000)}` }])[0].content,
	"x".repeat(CHECKLIST_MAX_CONTENT_CHARS),
);

const store = new ChecklistStore();
let snapshot = store.replace([
	{ content: "Inspect", status: "in_progress", priority: "medium" },
	{ content: "Implement", status: "pending", priority: "high" },
]);
assert.deepEqual({ total: snapshot.total, completed: snapshot.completed, inProgress: snapshot.inProgress, pending: snapshot.pending }, {
	total: 2,
	completed: 0,
	inProgress: 1,
	pending: 1,
});
assert.match(formatChecklistSnapshot(snapshot), /0\/2 complete/);
assert.match(formatChecklistSnapshot(snapshot), /\[>\] Inspect/);
snapshot = store.replacePlan("review", [{ content: "Review", status: "completed", priority: "low" }]);
assert.equal(snapshot.total, 3, "identified ACP plans coexist");
const revisionBeforeRemoval = snapshot.revision;
snapshot = store.removePlan("review");
assert.equal(snapshot.total, 2);
assert.ok(snapshot.revision > revisionBeforeRemoval);
assert.deepEqual(emptyChecklistSnapshot(), { revision: 0, entries: [], total: 0, completed: 0, inProgress: 0, pending: 0 });
assert.ok(EVENT_TYPES.includes("checklist"));
assert.ok(EVENT_TYPES.includes("cursor_todos"), "the legacy adapter event remains compatible");

// AcpClient owns the normalization boundary. Constructor-less instances are
// supported because several embedders and tests inject minimal transports.
const events = [];
const client = Object.create(AcpClient.prototype);
client.onEvent = (event) => events.push(event);
client.sessionId = "session-1";
client.bufferingSessionUpdates = false;
client.handleSessionUpdate({
	sessionId: "session-1",
	update: {
		sessionUpdate: "plan",
		entries: [{ content: "Plan it", status: "pending", priority: "medium" }],
	},
});
assert.equal(client.getSessionInfo().checklist.entries[0].content, "Plan it");
assert.equal(events.at(-1).type, "checklist");
client.handleSessionUpdate({
	sessionId: "session-1",
	update: {
		sessionUpdate: "plan_update",
		plan: { type: "items", planId: "secondary", entries: [{ content: "Do it", status: "completed", priority: "high" }] },
	},
});
assert.equal(client.checklistSnapshot.total, 2);
client.handleSessionUpdate({ sessionId: "session-1", update: { sessionUpdate: "plan_removed", planId: "secondary" } });
assert.equal(client.checklistSnapshot.total, 1);
const revision = client.checklistSnapshot.revision;
client.handleSessionUpdate({
	sessionId: "another-session",
	update: { sessionUpdate: "plan", entries: [{ content: "Wrong session", status: "pending", priority: "medium" }] },
});
assert.equal(client.checklistSnapshot.revision, revision);

const cursorReplies = [];
client.writeSafe = (message) => cursorReplies.push(message);
await client.handleCursorRequest({
	id: 9,
	method: "cursor/update_todos",
	params: { todos: [{ content: "Cursor task", status: "in_progress" }] },
});
assert.equal(client.checklistSnapshot.entries[0].content, "Cursor task");
assert.deepEqual(cursorReplies.at(-1), { jsonrpc: "2.0", id: 9, result: {} });

// Cursor can publish a todo snapshot while session/load is still pending. ACK
// immediately so the backend can finish loading, but preserve the snapshot in
// the ordered session replay instead of applying it to the old session and then
// erasing it at commit.
client.getChecklistStore().replace([{ content: "Old task", status: "pending" }]);
client.checklistSnapshot = client.getChecklistStore().list();
client.bufferingSessionUpdates = true;
client.bufferedSessionUpdates = [];
await client.handleCursorRequest({
	id: 10,
	method: "cursor/update_todos",
	params: { sessionId: "session-2", todos: [{ content: "Loaded task", status: "in_progress" }] },
});
assert.equal(cursorReplies.at(-1).id, 10, "the buffered todo request is acknowledged immediately");
assert.equal(client.checklistSnapshot.entries[0].content, "Old task");
assert.equal(client.bufferedSessionUpdates.length, 1);
client.sessionId = "session-2";
client.checklistSnapshot = client.getChecklistStore().reset();
client.bufferingSessionUpdates = false;
client.handleSessionUpdate(client.bufferedSessionUpdates.shift());
assert.equal(client.checklistSnapshot.entries[0].content, "Loaded task");

const loadedRevision = client.checklistSnapshot.revision;
await client.handleCursorRequest({
	id: 11,
	method: "cursor/update_todos",
	params: { sessionId: "stale-session", todos: [{ content: "Stale task", status: "pending" }] },
});
assert.equal(client.checklistSnapshot.revision, loadedRevision, "an explicitly stale todo snapshot is ignored");
assert.equal(cursorReplies.at(-1).id, 11, "stale todo requests are still acknowledged");

// Main and /btw retain independent generic snapshots.
const app = Object.create(HarnessApp.prototype);
app.activeKey = "claude";
app.sessionStates = new Map();
app.ui = { requestRender() {} };
app.handleBackendEvent({ type: "checklist", snapshot: store.list() });
assert.equal(app.sessionStates.get("claude").checklist, store.list());
const sideApp = { onThreadActivity() {}, ui: { terminal: { rows: 24 } } };
const side = new BtwThread(sideApp, {}, "question");
side.handleEvent({ type: "checklist", snapshot: client.checklistSnapshot });
assert.equal(side.checklist, client.checklistSnapshot);

// The local surface is harness-neutral, live, and keybinding-accessible.
const panelApp = {
	menuHandle: undefined,
	checklistSnapshotForTarget: () => client.checklistSnapshot,
	closeMenu() { this.menuHandle = undefined; },
};
const panel = new ChecklistPanel(panelApp, {});
panelApp.menuHandle = panel;
assert.match(panel.render(80).join("\n"), /Loaded task/);
panel.handleInput("\x1b");
assert.equal(panelApp.menuHandle, undefined);

const commandApp = Object.create(HarnessApp.prototype);
commandApp.config = { agents: { claude: { label: "Claude" } } };
commandApp.activeKey = "claude";
commandApp.focusedThread = "main";
commandApp.sessionStates = new Map();
commandApp.client = { capabilities: {}, getSessionInfo: () => ({ checklist: client.checklistSnapshot }) };
commandApp.availableCommands = new Map();
commandApp.commandsLoaded = new Set();
commandApp.backendCommandCatalog = undefined;
assert.ok(localSlashCommands(commandApp).some((command) => command.name === "todos"));
assert.equal(commandApp.slashCommandRoute("todos", ""), "local");
let toggled = 0;
commandApp.toggleTodosPanel = () => { toggled += 1; return true; };
assert.equal(commandApp.executeCcKeybindingAction("cc.app.toggleTodos"), true);
assert.equal(toggled, 1);

console.log("checklist tests passed");
