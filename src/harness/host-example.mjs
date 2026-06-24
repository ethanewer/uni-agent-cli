// How cc drives harnesses through the interface — the generic, harness-name-free
// control flow that REPLACES the per-harness branches in pi-harness.mjs. These are
// the functions cc would call; they name no harness. Exercised by
// tests/harness_adapter.test.mjs so the abstraction is proven, not just asserted.

import { createAdapter } from "./registry.mjs";

/**
 * Build the host bundle cc passes to an adapter. cc owns rendering + the
 * permission/interaction UI; the adapter calls back into these.
 */
export function createAdapterHost({ onEvent, requestPermission, requestInteraction }) {
	return { onEvent, requestPermission, requestInteraction };
}

/** Construct + connect an adapter the way cc would (one resolution point). */
export async function connectHarness(key, agentConfig, host, options = {}) {
	const adapter = createAdapter(key, agentConfig, host, options);
	await adapter.connect(options.connectOptions ?? {});
	return adapter;
}

/**
 * The /btw side-thread fork ladder.
 *
 * BEFORE (pi-harness.mjs runBtw ~3989-4043):
 *   if (this.activeKey === "cursor") { addNotice("/btw not supported"); return; }
 *   ...
 *   if (btwClient.supportsFork()) await btwClient.forkSession(parentId);
 *   else if (this.activeKey === "codex") await this.forkCodexSession(btwClient, parentId);
 *   else throw new Error("this agent does not support session forking");
 *
 * AFTER (no harness name):
 */
export async function openSideThread(forkAdapter, parentSessionId) {
	await forkAdapter.connect({ createSession: false });
	if (!forkAdapter.capabilities.fork) {
		throw new Error("/btw is not supported by this harness (no session forking)");
	}
	await forkAdapter.fork(parentSessionId);
	return forkAdapter.sessionId; // cc then calls recordForkId(sessionId) — generic /resume bookkeeping
}

/**
 * Slash-command dispatch with local preset interception.
 *
 * BEFORE (pi-harness.mjs handleSlashCommand ~3398): shouldOpenCodexReviewDialog()
 * branches on activeKey === "codex".
 *
 * AFTER: ask the adapter whether it wants to intercept; otherwise pass through.
 * Returns { handledLocally: true, preset } | { handledLocally: false }.
 */
export function dispatchSlashCommand(adapter, name, argument, backendCommandNames = new Set()) {
	const preset = adapter.interceptCommand?.(name, argument, backendCommandNames) ?? null;
	if (preset) return { handledLocally: true, preset };
	return { handledLocally: false };
}

/**
 * Unsend orchestration (Esc retracts the just-sent prompt).
 *
 * BEFORE: isCodexAcpActive() + readCodexThreadState() inline in pi-harness.
 * AFTER: cc snapshots after sending, then asks the adapter if it can still retract.
 * The lifecycle (when to snapshot/arm/disarm) stays generic in cc; only the
 * "is it still retractable?" judgment is the adapter's.
 */
export function armUnsend(adapter) {
	if (!adapter.capabilities.retractPrompt) return undefined;
	return adapter.snapshotRetractionState();
}

export function canUnsend(adapter, snapshot) {
	return adapter.capabilities.retractPrompt && adapter.canRetract(snapshot);
}
