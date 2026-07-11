// Codex adapter — the most tightly coupled harness. Re-homes every codex-only
// branch from pi-harness.mjs behind interface methods: copy-fork, prompt unsend,
// the /review preset dialog, and CODEX_CONFIG translation. It reuses the
// exact exported production helpers so behavior is identical.

import {
	acquireForkOperationLock,
	codexHome,
	copyCodexRolloutWithNewId,
	findCodexRolloutPath,
	forgetForkIds,
	mergeEnvironments,
	readCodexThreadState,
	recordForkId,
	stopClientsForReplacement,
} from "../../pi-harness.mjs";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BaseAcpAdapter, REVIEW_PRESET } from "../acp-base.mjs";

const CODEX_ACP_AGENT_NAME = "@agentclientprotocol/codex-acp";

function parseCodexConfig(value) {
	try {
		const parsed = JSON.parse(value ?? "{}");
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export class CodexAdapter extends BaseAcpAdapter {
	declaredCapabilities() {
		return { fork: "copy", retractPrompt: true, commandPresets: ["review"] };
	}

	// Unsend is only safe against the maintained Codex ACP backend. Narrow only
	// once connected to a live backend;
	// pre-connect, keep the declared capability (the contract says pre-connect caps
	// expose the declared subset). Pointing the codex key at another bridge then keeps
	// unsend off rather than advertising a feature that backend can't honor.
	refineCapabilities(caps) {
		if (this.connection) caps.retractPrompt = this.connection.agentInfo?.name === CODEX_ACP_AGENT_NAME;
		return caps;
	}

	// The maintained adapter consumes Codex overrides as a JSON object. Preserve
	// any config supplied directly through env, then let explicit cc settings win.
	translateConfig(applied, config) {
		const existing = {
			...parseCodexConfig(process.env.CODEX_CONFIG),
			...parseCodexConfig(applied.env?.CODEX_CONFIG),
		};
		applied.env = {
			...(applied.env ?? {}),
			CODEX_CONFIG: JSON.stringify({ ...existing, ...config }),
		};
	}

	removeConfig(applied, names) {
		const parsed = {
			...parseCodexConfig(process.env.CODEX_CONFIG),
			...parseCodexConfig(applied.env?.CODEX_CONFIG),
		};
		for (const name of names) delete parsed[name];
		applied.env = { ...(applied.env ?? {}), CODEX_CONFIG: JSON.stringify(parsed) };
	}

	// Permission intent maps to the successor adapter's ACP modes through the
	// unified engine in BaseAcpAdapter.
	codexEnvironment() {
		const command = this.launchSpec?.acp ?? this.launchSpec;
		return mergeEnvironments([process.env, this.launchSpec?.env, command?.env]);
	}

	// codex-acp exposes no session/fork. Copy the parent's rollout JSONL to a new
	// id and session/load the copy: an isolated branch, parent untouched.
	async fork(parentSessionId) {
		const releaseForkOperation = await acquireForkOperationLock({ operation: `fork ${parentSessionId}` });
		try {
			const environment = this.codexEnvironment();
			const rolloutPath = findCodexRolloutPath(parentSessionId, path.join(codexHome(environment), "sessions"));
			if (!rolloutPath) throw new Error("could not locate the Codex session rollout to fork");
			if (rolloutPath.endsWith(".zst")) throw new Error("the Codex session rollout is compressed; cannot fork it");
			const newId = randomUUID();
			let copiedRolloutPath;
			try {
				copiedRolloutPath = copyCodexRolloutWithNewId(rolloutPath, parentSessionId, newId, {
					beforePublish: () => {
						recordForkId(newId, parentSessionId, { required: true });
					},
				});
			} catch (error) {
				forgetForkIds(newId, { required: true });
				throw error;
			}
			try {
				await this.loadSession(newId);
			} catch (error) {
				await stopClientsForReplacement([this.connection]);
				fs.rmSync(copiedRolloutPath, { force: true });
				forgetForkIds(newId, { required: true });
				throw error;
			}
		} finally {
			releaseForkOperation();
		}
	}

	// Unsend: snapshot the on-disk thread state, then check it is unchanged before
	// retracting the just-sent prompt.
	snapshotRetractionState() {
		return readCodexThreadState(
			this.sessionId,
			path.join(codexHome(this.codexEnvironment()), "state_5.sqlite"),
		);
	}

	canRetract(snapshot) {
		if (!snapshot) return false;
		const current = readCodexThreadState(
			snapshot.sessionId,
			path.join(codexHome(this.codexEnvironment()), "state_5.sqlite"),
		);
		return Boolean(current && JSON.stringify(current) === JSON.stringify(snapshot));
	}

	// Codex always offers the /review preset; the base also fires it for any backend
	// advertising the review/review-branch/review-commit trio.
	interceptCommand(name, argument, backendNames = new Set()) {
		const generic = super.interceptCommand(name, argument, backendNames);
		if (generic) return generic;
		if (name === "review" && !argument && this.key === "codex") return REVIEW_PRESET;
		return null;
	}
}
