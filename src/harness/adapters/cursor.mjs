// Cursor adapter — inserts native CLI args before the `acp` subcommand and
// declares interactiveRequests (the cursor/ask_question + cursor/create_plan
// prompts). Permissions (auto-accept from --force/-f/--yolo, and generation of
// --force from the unified mode) are handled generically by BaseAcpAdapter via
// the unified engine. It advertises no fork, so `/btw` reports "unavailable" via
// the generic capability check — no name special-case.

import { BaseAcpAdapter } from "../acp-base.mjs";
import { insertArgsBefore } from "../util.mjs";

export class CursorAdapter extends BaseAcpAdapter {
	static workflowMcpLaunch = true;

	declaredCapabilities() {
		return { interactiveRequests: true };
	}

	applyNativeArgs(baseArgs, nativeArgs) {
		return insertArgsBefore(baseArgs, "acp", nativeArgs);
	}
}
