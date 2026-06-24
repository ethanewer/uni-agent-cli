// Codex adapter — the most tightly coupled harness. Re-homes every codex-only
// branch from pi-harness.mjs behind interface methods: copy-fork, prompt unsend,
// the /review preset dialog, and `-c key=value` config translation. It reuses the
// exact exported production helpers so behavior is identical.

import { copyCodexRolloutWithNewId, findCodexRolloutPath, readCodexThreadState } from "../../pi-harness.mjs";
import { randomUUID } from "node:crypto";
import { BaseAcpAdapter, REVIEW_PRESET } from "../acp-base.mjs";
import { tomlValue } from "../util.mjs";

export class CodexAdapter extends BaseAcpAdapter {
	declaredCapabilities() {
		return { fork: "copy", retractPrompt: true, commandPresets: ["review"] };
	}

	// Unsend is only safe against the real codex-acp backend (matches isCodexAcpActive:
	// agentInfo.name === "codex-acp"). Narrow only once connected to a live backend;
	// pre-connect, keep the declared capability (the contract says pre-connect caps
	// expose the declared subset). Pointing the codex key at another bridge then keeps
	// unsend off rather than advertising a feature that backend can't honor.
	refineCapabilities(caps) {
		if (this.connection) caps.retractPrompt = this.connection.agentInfo?.name === "codex-acp";
		return caps;
	}

	// `settings.config` -> repeated `-c name=<tomlValue>` spawn args.
	translateConfig(baseArgs, config) {
		const args = [...baseArgs];
		for (const [name, value] of Object.entries(config)) {
			args.push("-c", `${name}=${tomlValue(value)}`);
		}
		return args;
	}

	// Permissions (auto-accept from approval_policy=never + sandbox_mode=
	// danger-full-access, and generation of those keys from the unified mode) are
	// handled generically by BaseAcpAdapter via the unified engine.

	// codex-acp exposes no session/fork. Copy the parent's rollout JSONL to a new
	// id and session/load the copy: an isolated branch, parent untouched.
	async fork(parentSessionId) {
		const rolloutPath = findCodexRolloutPath(parentSessionId);
		if (!rolloutPath) throw new Error("could not locate the Codex session rollout to fork");
		if (rolloutPath.endsWith(".zst")) throw new Error("the Codex session rollout is compressed; cannot fork it");
		const newId = randomUUID();
		copyCodexRolloutWithNewId(rolloutPath, parentSessionId, newId);
		await this.loadSession(newId);
	}

	// Unsend: snapshot the on-disk thread state, then check it is unchanged before
	// retracting the just-sent prompt.
	snapshotRetractionState() {
		return readCodexThreadState(this.sessionId);
	}

	canRetract(snapshot) {
		if (!snapshot) return false;
		const current = readCodexThreadState(snapshot.sessionId);
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
