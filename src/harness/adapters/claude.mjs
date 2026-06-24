// Claude adapter — folds native settings into the session `_meta`. Permissions
// (including the bypassPermissions startup mode + auto-accept) are handled
// generically by BaseAcpAdapter via the unified engine; this adapter only owns
// the claude-specific `_meta` translation. Fork, resume, image, and modes all
// come from the wire, so nothing is declared statically.

import { BaseAcpAdapter } from "../acp-base.mjs";
import { deepMerge, isPlainObject } from "../util.mjs";

export class ClaudeAdapter extends BaseAcpAdapter {
	// settings.settings -> agent._sessionMeta.claudeCode.options.settings (sent as
	// `_meta` on session/new + session/load).
	translateNativeSettings(agent, settings) {
		const options = agent._sessionMeta?.claudeCode?.options ?? {};
		const currentSettings = isPlainObject(options.settings) ? options.settings : {};
		agent._sessionMeta = deepMerge(agent._sessionMeta ?? {}, {
			claudeCode: { options: { settings: deepMerge(currentSettings, settings) } },
		});
	}
}
