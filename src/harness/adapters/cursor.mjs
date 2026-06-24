// Cursor adapter — inserts native CLI args before the `acp` subcommand, infers
// auto-accept from --force/-f/--yolo, and declares interactiveRequests (the
// cursor/ask_question + cursor/create_plan prompts). It advertises no fork, so
// `/btw` reports "unavailable" via the generic capability check — no name special-case.

import { BaseAcpAdapter } from "../acp-base.mjs";
import { insertArgsBefore } from "../util.mjs";

export class CursorAdapter extends BaseAcpAdapter {
	declaredCapabilities() {
		return { interactiveRequests: true };
	}

	applyNativeArgs(baseArgs, nativeArgs) {
		return insertArgsBefore(baseArgs, "acp", nativeArgs);
	}

	inferNativePermission(agent, settings) {
		const args = (agent.acp ?? agent).args ?? [];
		if (args.includes("--force") || args.includes("-f") || args.includes("--yolo")) {
			agent._autoPermissionRequests = true;
		}
		void settings;
	}
}
