// Claude adapter — folds native settings into the session `_meta` and turns a
// bypassPermissions default mode into a startup mode + auto-accept. Fork, resume,
// image, and modes all come from the wire, so nothing is declared statically.

import { BaseAcpAdapter } from "../acp-base.mjs";
import { deepMerge, isBypassPermissionMode, isPlainObject } from "../util.mjs";

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

	inferNativePermission(agent, settings) {
		const mode = settings.settings?.permissions?.defaultMode;
		if (isBypassPermissionMode(mode)) {
			agent._startupMode = "bypassPermissions";
			agent._autoPermissionRequests = true;
		}
	}
}
