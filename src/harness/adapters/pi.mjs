// pi adapter (Mario Zechner's pi) — pi has no native ACP, so it is bridged by the
// community `pi-acp` adapter (spawns `pi --mode rpc`, same pattern as codex-acp).
// Adding it is this file plus one registry line; no Python bridge needed.
//
// pi-acp advertises models, modes (thinking levels), list+load resume, and image
// on the wire — all derived automatically. It does NOT advertise session/fork, so
// `/btw` reports "unavailable" via the generic capability check (the one notable
// regression vs codex). Making fork work would mean a pi-specific copy-fork
// subclass, exactly like CodexAdapter — i.e. a future opt-in, not interface churn.

import { BaseAcpAdapter } from "../acp-base.mjs";

export class PiAdapter extends BaseAcpAdapter {
	static defaultAgentConfig = {
		label: "Pi",
		transport: "acp",
		command: "pi",
		args: [],
		acp: { command: "npx", args: ["-y", "pi-acp"] },
	};
}
