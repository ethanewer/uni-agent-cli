import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	REQUIRED_LOCAL_ADAPTERS,
	inspectLocalAdapter,
	inspectLocalAdapters,
	verifyPostinstall,
} from "../scripts/postinstall.mjs";

const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(packageJson.bin.cc, "src/cc.mjs");
assert.equal(packageJson.engines.node, ">=22", "the package must satisfy claude-agent-acp's Node runtime floor");
assert.equal(packageJson.dependencies["@agentclientprotocol/claude-agent-acp"], "0.58.1");
assert.equal(packageJson.dependencies["@agentclientprotocol/codex-acp"], "1.1.2");
assert.deepEqual(
	REQUIRED_LOCAL_ADAPTERS.map(({ packageName, version }) => [packageName, version]),
	[
		["@agentclientprotocol/claude-agent-acp", "0.58.1"],
		["@agentclientprotocol/codex-acp", "1.1.2"],
	],
);

const launcher = fs.readFileSync(new URL(`../${packageJson.bin.cc}`, import.meta.url), "utf8");
assert.match(launcher.split(/\r?\n/, 1)[0], /^#!\/usr\/bin\/env node$/u);
assert.match(launcher, /nodeMajorVersion < 22/u);
assert.match(launcher, /requires Node\.js 22 or newer/u);

// The checked-out installation itself has both exact, usable package-local
// adapters. PATH and globally installed package ownership are irrelevant.
const installed = inspectLocalAdapters();
assert.equal(installed.length, 2);
assert.ok(installed.every((result) => result.ok), JSON.stringify(installed));

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-postinstall-local-"));
try {
	const adapter = REQUIRED_LOCAL_ADAPTERS[1];
	const packageRoot = path.join(root, ...adapter.packageName.split("/"));
	const entrypoint = path.join(packageRoot, "dist", "index.js");
	fs.mkdirSync(path.dirname(entrypoint), { recursive: true });
	fs.writeFileSync(entrypoint, "#!/usr/bin/env node\n");
	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.equal(inspectLocalAdapter(adapter, root).ok, true);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: "0.0.0",
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /expected 1\.1\.2, found 0\.0\.0/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: "@zed-industries/codex-acp",
		version: adapter.version,
		bin: { [adapter.bin]: "dist/index.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /unexpected package identity/u);

	fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
		name: adapter.packageName,
		version: adapter.version,
		bin: { [adapter.bin]: "../../outside.js" },
	}));
	assert.match(inspectLocalAdapter(adapter, root).reason, /escapes its package/u);

	fs.rmSync(packageRoot, { recursive: true, force: true });
	const missing = verifyPostinstall({ nodeModules: root, adapters: [adapter], report: false });
	assert.equal(missing[0].ok, false);
	assert.match(missing[0].reason, /missing/u);
	assert.deepEqual(
		verifyPostinstall({ nodeModules: root, adapters: [adapter], env: { CC_SKIP_ADAPTER_INSTALL: "1" }, report: false }),
		[],
	);
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}

const source = fs.readFileSync(new URL("../scripts/postinstall.mjs", import.meta.url), "utf8");
assert.doesNotMatch(source, /npm\s+(?:install|uninstall)|spawnSync|execSync|@zed-industries/u);

console.log("postinstall: package-local verification only; no global migration");
