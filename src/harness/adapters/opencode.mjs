// opencode adapter (sst/opencode) — first-party native ACP via `opencode acp`.
// Adding it is this entire file plus one line in registry.mjs. opencode advertises
// native fork, list+load+resume, image, and MCP on the wire, so every capability
// is derived automatically and nothing harness-specific is needed here.
//
// Known gaps (not cc-side code, just capabilities it doesn't advertise as cc
// expects): reasoning effort + model/mode are exposed via opencode's
// `unstable_*`/configOptions path, which may or may not bind to cc's selectors;
// it does not advertise a shared agent terminal. Those simply stay dark.

import { BaseAcpAdapter } from "../acp-base.mjs";

export class OpenCodeAdapter extends BaseAcpAdapter {
	static defaultAgentConfig = {
		label: "opencode (ACP)",
		transport: "acp",
		command: "opencode",
		args: [],
		acp: { command: "opencode", args: ["acp"] },
	};
}
