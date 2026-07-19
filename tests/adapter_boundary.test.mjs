import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pi = fs.readFileSync(path.join(root, "src", "pi-harness.mjs"), "utf8");

assert.match(pi, /import \{ adapterClassFor, createAdapter \} from "\.\/harness\/registry\.mjs";/u);
assert.match(pi, /createRuntimeAdapter\(key, agentConfig/u);
assert.doesNotMatch(pi, /^import .*\.\/workflows\//mu, "disabled startup must not statically import workflow modules");
for (const module of ["manager", "registry", "tui", "broker", "sandbox-parent"]) {
	assert.match(pi, new RegExp(`import\\(\\"\\./workflows/${module}\\.mjs\\"\\)`), `${module} must load only through the opt-in initializer`);
}
assert.match(pi, /adapterClassFor\(key\)\.workflowMcpLaunch === true/u, "workflow MCP injection must honor the adapter launch capability");
assert.match(pi, /const workflowActive = callbacks\.workflowChild === true \|\| \(this\.workflowsDisabled === false && !this\.workflowSubsystemStopping\)/u);
assert.match(pi, /const workflowBrokerShutdown = this\.workflowManager\s*\?/u, "disabled shutdown must not create a workflow promise chain");
assert.equal(
	[...pi.matchAll(/new AcpClient\s*\(/gu)].length,
	1,
	"only the injected ACP connection factory may construct the raw transport",
);
assert.match(
	pi,
	/export function createAcpConnection\([^)]*\) \{\s*return new AcpClient\(/u,
	"the sole raw transport construction remains below the adapter boundary",
);
assert.equal(
	[...pi.matchAll(/this\.createRuntimeAdapter\(/gu)].length,
	3,
	"main, /btw, and workflow workers must all resolve through the centralized adapter registry",
);
assert.doesNotMatch(
	pi,
	/(?:client|Client)\??\.capabilities\??\.sessionCapabilities/u,
	"the TUI must consume normalized adapter capabilities rather than ACP wire fields",
);

const harnessRoot = path.join(root, "src", "harness");
for (const relative of [
	"acp-base.mjs",
	...fs.readdirSync(path.join(harnessRoot, "adapters"))
		.filter((name) => name.endsWith(".mjs"))
		.map((name) => path.join("adapters", name)),
]) {
	const source = fs.readFileSync(path.join(harnessRoot, relative), "utf8");
	assert.doesNotMatch(
		source,
		/(?:from|import\s*\()\s*["'][^"']*pi-harness\.mjs/u,
		`${relative} must not import the TUI`,
	);
}

const loadConfigBody = /export function loadConfig\(\) \{([\s\S]*?)\n\}/u.exec(pi)?.[1] ?? "";
assert.ok(loadConfigBody, "loadConfig body is present");
assert.doesNotMatch(loadConfigBody, /applyHarnessSettings/u);
assert.match(loadConfigBody, /Harness definitions remain raw/u);

console.log("adapter boundary tests passed");
