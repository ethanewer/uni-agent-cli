import assert from "node:assert/strict";

import { formatCodexDebugConfig } from "../src/harness/codex-config-report.mjs";

const report = formatCodexDebugConfig({
	layers: [
		{
			name: { type: "system", file: "/etc/codex/config.toml" },
			config: { api_key: "must-never-print", mcp_servers: { private: { env: { TOKEN: "secret" } } } },
			disabledReason: null,
		},
		{
			name: { type: "user", file: "/home/test/.codex/config.toml", profile: "work" },
			config: { model: "gpt-secret-preview" },
			disabledReason: "superseded\u001b[31m",
		},
		{ name: { type: "sessionFlags" }, config: { api_key: "also-secret" }, disabledReason: null },
	],
}, {
	requirements: {
		allowedApprovalPolicies: ["untrusted", "on-request"],
		allowedApprovalsReviewers: ["auto_review"],
		allowedPermissionProfiles: { locked: true },
		featureRequirements: { memories: true },
		models: { newThread: { model: "gpt-5.6-sol", serviceTier: "fast" } },
		hooks: {
			managedDir: "/managed/hooks",
			handlers: { SessionStart: [{ command: "TOKEN=must-not-print" }] },
		},
		network: {
			enabled: true,
			domains: { entries: { "api.openai.com": "allow" } },
			unixSockets: { entries: { "/var/run/docker.sock": "deny" } },
			proxyPassword: "must-not-print",
		},
		mcpServers: { private: { bearerToken: "must-not-print" } },
	},
});

assert.match(report, /system \(\/etc\/codex\/config\.toml\) \(enabled\)/);
assert.match(report, /user \(\/home\/test\/\.codex\/config\.toml, profile work\) \(disabled\)/);
assert.match(report, /session flags \(enabled\)/);
assert.match(report, /allowedApprovalPolicies: untrusted, on-request/);
assert.match(report, /featureRequirements: memories=true/);
assert.match(report, /models: newThread=model=gpt-5\.6-sol, serviceTier=fast/);
assert.match(report, /allowedApprovalsReviewers: auto_review/);
assert.match(report, /hooks: managedDir=\/managed\/hooks, handlers=1/);
assert.match(report, /network: enabled=true, domains=\{api\.openai\.com=allow\}, unixSockets=\{\/var\/run\/docker\.sock=deny\}/);
assert.doesNotMatch(report, /must-never-print|also-secret|bearerToken|must-not-print|gpt-secret-preview/);
assert.doesNotMatch(report, /\u001b/);

assert.match(formatCodexDebugConfig({ layers: null }, { requirements: null }), /<none reported>[\s\S]*<none>/);
assert.throws(() => formatCodexDebugConfig(null, null), /invalid response/);

console.log("codex debug config: redacted layer and requirement reporting");
